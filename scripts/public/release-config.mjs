import {readFileSync} from 'node:fs';
function required(env,name) { const value=env[name]?.trim(); if(!value)throw Error(`Missing ${name}`); return value; }
function https(value,label,origin=false) {
  let url; try { url=new URL(value); } catch {throw Error(`Invalid ${label}`);}
  if(url.protocol!=='https:' || url.username || url.password || url.search || url.hash || (origin&&url.pathname!=='/'))throw Error(`${label} must be an HTTPS ${origin?'origin':'URL'} without credentials or query`);
  return value;
}
const tauriConf=new URL('../../apps/desktop/src-tauri/tauri.conf.json',import.meta.url);
/** The packaged app loads its bundled frontend, so the Vite dev server sources (localhost:1430) leave its CSP;
 * `tauri dev` keeps using the tauri.conf.json CSP unchanged. */
export function packagedCsp(devCsp) {
  const csp=devCsp.split(';').map(d=>d.trim().split(/\s+/).filter(s=>!/^(https?|wss?):\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/.test(s)).join(' ')).filter(Boolean).join('; ');
  if(/localhost:|127\.0\.0\.1/.test(csp))throw Error('Packaged CSP still allows a local dev server');
  return csp;
}
/** Produces only public config. Private keys remain in the owner-controlled process environment. */
export function releaseConfig(mode,env,devCsp=JSON.parse(readFileSync(tauriConf,'utf8')).app.security.csp) {
  const app={security:{csp:packagedCsp(devCsp)}};
  if(!['candidate','release'].includes(mode))throw Error('Use candidate or release');
  const common={VITE_LIVE_INTERVIEW_EDITION:'public',CARGO_PROFILE_DEV_DEBUG:'0',CARGO_INCREMENTAL:'0'};
  if(mode==='candidate')return {env:{...common,PUBLIC_SERVICE_ORIGIN:'',PUBLIC_MICROSOFT_CLIENT_ID:'',PUBLIC_GOOGLE_CLIENT_ID:'',PUBLIC_UPDATE_ENDPOINT:'',PUBLIC_UPDATE_PUBKEY:'',PUBLIC_CRASH_ENDPOINT:'',TAURI_SIGNING_PRIVATE_KEY:undefined,TAURI_SIGNING_PRIVATE_KEY_PASSWORD:undefined,APPLE_API_ISSUER:undefined,APPLE_API_KEY:undefined,APPLE_API_KEY_PATH:undefined,APPLE_ID:undefined,APPLE_PASSWORD:undefined,APPLE_TEAM_ID:undefined,APPLE_CERTIFICATE:undefined,APPLE_CERTIFICATE_PASSWORD:undefined},tauri:{app,plugins:{updater:{endpoints:[],pubkey:''}},bundle:{createUpdaterArtifacts:false,macOS:{signingIdentity:'-'}}}};
  const service=https(required(env,'PUBLIC_SERVICE_ORIGIN'),'service origin',true);
  const microsoft=required(env,'PUBLIC_MICROSOFT_CLIENT_ID'),google=required(env,'PUBLIC_GOOGLE_CLIENT_ID');
  const endpoint=https(required(env,'PUBLIC_UPDATE_ENDPOINT'),'update endpoint');
  const pubkey=required(env,'PUBLIC_UPDATE_PUBKEY');
  // Optional: without it the app keeps crash reports on the Mac and offers only Discard.
  const crash=env.PUBLIC_CRASH_ENDPOINT?.trim()?https(env.PUBLIC_CRASH_ENDPOINT.trim(),'crash report endpoint'):'';
  const identity=required(env,'APPLE_SIGNING_IDENTITY');
  if(!identity.startsWith('Developer ID Application:'))throw Error('A Developer ID Application signing identity is required');
  required(env,'TAURI_SIGNING_PRIVATE_KEY');
  return {env:{...common,PUBLIC_SERVICE_ORIGIN:service,PUBLIC_MICROSOFT_CLIENT_ID:microsoft,PUBLIC_GOOGLE_CLIENT_ID:google,PUBLIC_UPDATE_ENDPOINT:endpoint,PUBLIC_UPDATE_PUBKEY:pubkey,PUBLIC_CRASH_ENDPOINT:crash},tauri:{app,plugins:{updater:{endpoints:[endpoint],pubkey}},bundle:{createUpdaterArtifacts:true,macOS:{signingIdentity:identity}}}};
}
