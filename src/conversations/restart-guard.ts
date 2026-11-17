import type{ChatSession}from'./contracts.js';

/** Read-only preflight. A deadline never authorizes interrupting a busy session. */
export async function waitForManagedIdle(options:{read:()=>Promise<ChatSession[]>;sleep?:(ms:number)=>Promise<void>;now?:()=>number;timeoutMs?:number;onWait?:(busy:ChatSession[])=>void}):Promise<void>{
  const now=options.now??Date.now,sleep=options.sleep??(ms=>new Promise(resolve=>setTimeout(resolve,ms))),deadline=now()+(options.timeoutMs??600000);
  for(;;){
    const sessions=await options.read();
    const busy=sessions.filter(s=>['launching','working','approval','stopping','closing'].includes(s.phase)||(s.phase==='idle'&&s.messages.some(m=>m.state==='queued'||m.state==='running')));
    if(!busy.length)return;
    options.onWait?.(busy);
    if(now()>=deadline)throw Error('Restart held: managed conversations remain busy after the idle-wait deadline');
    await sleep(Math.min(5000,deadline-now()));
  }
}
