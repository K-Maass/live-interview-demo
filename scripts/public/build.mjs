import {spawnSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync,copyFileSync,existsSync,rmSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve,join} from 'node:path';
import {homedir} from 'node:os';
import {createHash} from 'node:crypto';
import {releaseConfig} from './release-config.mjs';
import {rustRemapEnv,swiftRemapArgs} from './path-remap.mjs';
const root=resolve(fileURLToPath(new URL('../..',import.meta.url)));
const mode=process.argv[2]??'candidate';
const config=releaseConfig(mode,process.env);
const tauri=JSON.parse(readFileSync(join(root,'apps/desktop/src-tauri/tauri.conf.json')));
if(process.platform!=='darwin'||process.arch!=='arm64')throw Error('Build on an Apple silicon Mac');
if(tauri.identifier!=='com.karim.liveinterview.public'||tauri.productName!=='Live Interview')throw Error('Public identity required');
const base={...process.env,...config.env,PATH:`${join(homedir(),'.cargo/bin')}:${process.env.PATH}`};
// Release binaries must not embed the builder's paths; candidate (debug) builds are exempt. See path-remap.mjs.
const env={...base,...rustRemapEnv(mode,base,{root})};
// The updater signing key reaches only the Tauri build that signs the update archive, not swift, codesign or ditto.
const SIGNING_KEYS=['TAURI_SIGNING_PRIVATE_KEY','TAURI_SIGNING_PRIVATE_KEY_PASSWORD'];
const signing=Object.fromEntries(SIGNING_KEYS.filter(key=>env[key]!==undefined).map(key=>[key,env[key]]));
for(const key of SIGNING_KEYS)delete env[key];
function git(...args){const result=spawnSync('git',args,{cwd:root,encoding:'utf8'});if(result.status!==0)throw Error('Cannot identify release source');return result.stdout.trim();}
const sourceCommit=git('rev-parse','HEAD'),sourceDirty=git('status','--porcelain')!=='';
if(mode==='release'&&sourceDirty)throw Error('Commit and verify all release source changes before packaging');
const output=join(root,'artifacts/public-build',mode);mkdirSync(output,{recursive:true});
const app=join(output,'Live Interview.app');
const running=spawnSync('pgrep',['-f',`${app}/Contents/MacOS/live-interview`.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')],{stdio:'ignore'});
if(running.status===0)throw Error('Close the public candidate with Stop & save before rebuilding it');
const override=join(output,'tauri.build.json');writeFileSync(override,JSON.stringify(config.tauri,null,2)+'\n');
function run(command,args,extra={}){ const result=spawnSync(command,args,{cwd:root,env:{...env,...extra},stdio:'inherit'});if(result.status!==0)throw Error(`${command} failed (${result.status??'spawn error'})`); }
run('swift',['build','-c','release','--package-path','native/local-speech',...swiftRemapArgs(root)]);
mkdirSync(join(root,'apps/desktop/src-tauri/bin'),{recursive:true});
const worker=join(root,'apps/desktop/src-tauri/bin/local-speech');
copyFileSync(join(root,'native/local-speech/.build/release/local-speech'),worker);
const identity=config.tauri.bundle.macOS.signingIdentity;
// Notarization rejects binaries without a secure timestamp; ad-hoc candidate builds have none and need no network.
// The helper calls EventKit; tccd also checks the responsible app, so both executables carry the calendar entitlement
// (entitlements.plist and local-speech.entitlements.plist; verify-bundle.mjs checks each binary).
run('codesign',['--force','--options','runtime','--entitlements',join(root,'native/local-speech/local-speech.entitlements.plist'),...(identity==='-'?[]:['--timestamp']),'--sign',identity,worker]);
run('npm',['run','tauri','--workspace','apps/desktop','--','build',...(mode==='candidate'?['--debug']:[]),'--bundles','app','--config',override],signing);
const source=join(root,`apps/desktop/src-tauri/target/${mode==='candidate'?'debug':'release'}/bundle/macos/Live Interview.app`);
if(!existsSync(source))throw Error('Public bundle missing');
run('codesign',['--verify','--deep','--strict',source]);
if(git('rev-parse','HEAD')!==sourceCommit)throw Error('Source commit changed during build; rebuild from a stable checkout');
rmSync(app,{recursive:true,force:true});run('ditto',[source,app]);
const zip=join(output,'Live-Interview-macOS-arm64.zip');
run('ditto',['-c','-k','--sequesterRsrc','--keepParent',app,zip]);
const manifest={edition:'public',mode,version:tauri.version,sourceCommit,sourceDirty,identifier:tauri.identifier,minimumMacOS:tauri.bundle.macOS.minimumSystemVersion,architecture:'arm64',activated:false,notarized:false,updatesConfigured:mode==='release',serviceConfigured:mode==='release',sha256:createHash('sha256').update(readFileSync(zip)).digest('hex')};
writeFileSync(join(output,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
process.stdout.write(`Built ${zip}\nActivation and real-account acceptance remain separate release gates.\n`);
