// Keeps the builder's home and checkout paths out of release binaries (issue #105).
import {homedir} from 'node:os';

const placeholder='/build';
function checked(path,label){
  if(!path||!path.startsWith('/'))throw Error(`${label} must be an absolute path`);
  if(path.includes('='))throw Error(`${label} must not contain "=" (it cannot be remapped)`);
  return path.replace(/\/+$/,'');
}
/**
 * rustc applies the LAST matching --remap-path-prefix, so the most specific prefix comes last.
 * Covers the checkout (workspace sources, build-script output), the Cargo home (registry sources) and rustup.
 */
export function rustRemapFlags({root,home=homedir(),cargoHome=`${home}/.cargo`,rustupHome=`${home}/.rustup`,targetDir}){
  const maps=[[checked(home,'home'),'/home'],[checked(rustupHome,'rustup home'),'/rustup'],[checked(cargoHome,'cargo home'),'/cargo']];
  if(targetDir)maps.push([checked(targetDir,'target dir'),`${placeholder}/target`]);
  maps.push([checked(root,'checkout'),placeholder]);
  return maps.map(([from,to])=>`--remap-path-prefix=${from}=${to}`);
}
/** Env for the Cargo build: release only. Candidate (debug) builds are exempt and keep readable paths. */
export function rustRemapEnv(mode,env,paths){
  if(mode!=='release')return {};
  const existing=env.CARGO_ENCODED_RUSTFLAGS?env.CARGO_ENCODED_RUSTFLAGS.split('\x1f'):(env.RUSTFLAGS??'').split(/\s+/).filter(Boolean);
  const flags=rustRemapFlags({cargoHome:env.CARGO_HOME||undefined,rustupHome:env.RUSTUP_HOME||undefined,targetDir:env.CARGO_TARGET_DIR||undefined,...paths});
  return {CARGO_ENCODED_RUSTFLAGS:[...existing,...flags].join('\x1f'),RUSTFLAGS:undefined};
}
/**
 * SwiftPM arguments for the helper: no debug info (so the linker records no object-file paths) and a file prefix
 * map for source paths. The helper is built with `-c release` in every mode, so this applies to candidates too.
 */
export function swiftRemapArgs(root){
  return ['-debug-info-format','none','-Xswiftc','-file-prefix-map','-Xswiftc',`${checked(root,'checkout')}=${placeholder}`];
}
