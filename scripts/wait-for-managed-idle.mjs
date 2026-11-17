import{waitForManagedIdle}from'../dist/src/conversations/restart-guard.js';
const base='http://127.0.0.1:47600';
const r=await fetch(base+'/app/key',{signal:AbortSignal.timeout(10000)});if(!r.ok)throw Error('Restart idle check could not read board key');const{key}=await r.json();
let reportAt=0;
await waitForManagedIdle({read:async()=>{
 const r=await fetch(base+'/app/conversations',{method:'POST',signal:AbortSignal.timeout(10000),body:new URLSearchParams({t:key,request:JSON.stringify({op:'list'})})});
 if(r.status===503){const e=await r.json().catch(()=>({}));if(/disabled/i.test(String(e.error)))return [];}if(!r.ok)throw Error('Restart idle check could not read managed conversations');const data=await r.json();if(!Array.isArray(data.sessions))throw Error('Invalid managed session list');return data.sessions;
},onWait:busy=>{if(Date.now()>=reportAt){console.error('Restart held for active conversations: '+busy.map(s=>s.name+' ('+s.phase+')').join(', '));reportAt=Date.now()+30000;}}});
