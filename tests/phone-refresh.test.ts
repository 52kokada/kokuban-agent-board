import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { Script, createContext } from 'node:vm';
import { client, shell } from '../src/phone/shell.js';
const functions = (...names: string[]) => names.map(name => { const s = client.split('\n').find(s=>s.startsWith('function '+name+'(')||s.startsWith('async function '+name+'(')); assert.ok(s); return s; }).join('\n');
test('refresh recovery keeps text, attachments, unfinished binary uploads and exact revisions', async () => {
  const storage=new Map<string,string>(), drafts=new Map(),cardDrafts=new Map();let binary:any;
  const context:any=createContext({Blob,File,drafts,cardDrafts,recoveredRefresh:null,
    sessionStorage:{getItem:(k:string)=>storage.get(k),setItem:(k:string,v:string)=>storage.set(k,v),removeItem:(k:string)=>storage.delete(k)},
    recoveryBlob:async(op:string,value:any)=>op==='put'?(binary=structuredClone(value)):binary,
  });
  new Script(functions('saveRefresh','restoreRefresh')).runInContext(context);
  const file=new File(['unsent audio'],'Note.m4a',{type:'audio/mp4'});
  context.snapshot={version:1,view:'conversation',sessionId:'s',drafts:[['s',{text:'Keep this correction',revision:8,files:[{id:'kept-audio',name:'Original.m4a'}],pendingUploads:[{file,name:file.name,mime:file.type,voiceNote:true,sessionId:'s'}],voiceJobs:[]}]],cardDrafts:[['card:pc:1','Unsent reply']]};
  await new Script('saveRefresh(snapshot)').runInContext(context);await new Script('restoreRefresh()').runInContext(context);
  const restored=drafts.get('s');assert.equal(restored.text,'Keep this correction');assert.equal(restored.revision,8);assert.equal(restored.files[0].id,'kept-audio');
  assert.equal(restored.pendingUploads[0].file.name,'Note.m4a');assert.equal(await restored.pendingUploads[0].file.text(),'unsent audio');
  assert.equal(cardDrafts.get('card:pc:1'),'Unsent reply');assert.equal(context.recoveredRefresh.sessionId,'s');assert.equal(storage.has('kokuban-refresh'),false);
});
test('text and uploaded attachments can recover without IndexedDB; pending command ID is untouched', async () => {
  const storage=new Map([['kokuban-pending','same-command-id']]);const context:any=createContext({Blob,File,drafts:new Map(),cardDrafts:new Map(),recoveredRefresh:null,
    sessionStorage:{getItem:(k:string)=>storage.get(k),setItem:(k:string,v:string)=>storage.set(k,v),removeItem:(k:string)=>storage.delete(k)},recoveryBlob:async()=>{throw Error('must not need IndexedDB');},
    snapshot:{version:1,view:'chief',drafts:[['s',{text:'Draft',files:[{id:'photo'}],revision:1,pendingUploads:[]}]],cardDrafts:[]},
  });new Script(functions('saveRefresh','restoreRefresh')).runInContext(context);await new Script('saveRefresh(snapshot);').runInContext(context);await new Script('restoreRefresh()').runInContext(context);
  assert.equal(context.drafts.get('s').files[0].id,'photo');assert.equal(storage.get('kokuban-pending'),'same-command-id');
});
test('refresh reconnects by reloading only after a stable saved checkpoint, and never reloads on storage failure', async () => {
  let reloads=0,saves=0,error='';const control:any={disabled:false,setAttribute(){},removeAttribute(){}};
  const context:any=createContext({refreshBusy:false,recording:null,$:()=>control,toast(){},problem:(e:Error)=>{error=e.message;},updateComposer(){},
    refreshSnapshot:()=>({text:'Keep me'}),refreshStamp:JSON.stringify,saveRefresh:async()=>{saves++;},location:{reload:()=>{reloads++;}},setTimeout,clearTimeout,
  });new Script(functions('refreshApp')).runInContext(context);await new Script('refreshApp()').runInContext(context);assert.equal(reloads,1);assert.equal(saves,1);
  assert.equal(context.refreshBusy,true); context.refreshBusy=false; // A real reload starts a new JS context.
  context.saveRefresh=async()=>{throw Error('storage full');};await new Script('refreshApp()').runInContext(context);assert.equal(reloads,1);assert.match(error,/draft is still here/);assert.equal(control.disabled,false);
});
test('the refresh control is a header target, outside the composer',()=>{
  assert.ok(shell.indexOf('id="refreshApp"')<shell.indexOf('</header>'));assert.ok(shell.includes('flex:0 0 44px'));assert.ok(client.includes("$('refreshApp').onclick=refreshApp"));
});
