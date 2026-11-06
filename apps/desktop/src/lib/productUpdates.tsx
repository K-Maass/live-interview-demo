import {useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
type UpdateStatus={configured:boolean;available:boolean;version?:string;body?:string};
export function PublicUpdates(){
  const[status,setStatus]=useState<UpdateStatus|null>(null);
  const[busy,setBusy]=useState(false);
  const[message,setMessage]=useState('Check for signed app updates when you are ready.');
  async function check(){
    setBusy(true);
    try {const result=await invoke<UpdateStatus>('public_check_update');setStatus(result);setMessage(!result.configured?'Updates will be available in the signed public release.':result.available?`Version ${result.version} is available.`:'Your app is up to date.');}
    catch {setMessage('Could not check for updates. Try again later.');}
    finally {setBusy(false);}
  }
  async function install(){
    if(!status?.version)return;setBusy(true);setMessage('Downloading and verifying the update. The app will restart after installation.');
    try {await invoke('public_install_update',{version:status.version});}
    catch(e){setMessage(String(e).includes('recordingActive')?'Stop and save your meeting before installing an update.':'The update could not be installed. Your current app is still available.');setBusy(false);}
  }
  return <section className="copilot-panel"><h2>App updates</h2><p role="status">{message}</p><button className="copilot-button" disabled={busy} onClick={()=>void check()}>{busy?'Working…':'Check for updates'}</button>{status?.available&&<button className="copilot-button" disabled={busy} onClick={()=>void install()}>Install and restart</button>}</section>;
}
