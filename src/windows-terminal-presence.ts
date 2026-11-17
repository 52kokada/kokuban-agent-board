/** Read-only terminal evidence. Never changes board lifetime, input, focus or window bounds. */
import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import type {Board,Session} from './board.js';
import {codexRpc} from './codex-rpc.js';
import {claudePid} from './terminal-badges.js';

export interface Proof {present:boolean;at:number;method:string;status?:string}
export interface Evidence {terminalScan:{at:number;method:string;error?:string}; proofs:Map<string,Proof>}
interface Scan {capturedAt:string;interactive:boolean;windows:Array<{scanError?:string|null}>;runtime?:Array<{pid:number;host:string;started:number}>}
interface Matches {agents:Array<{id:string}>;unconfirmed:unknown[]}
const method='windows-uia-terminal+unique-session+runtime';
const cache=new WeakMap<Board,{value?:Evidence;pending?:Promise<Evidence>}>();

/** Enumerates every loaded UUID; a partial or cyclic pagination is not an empty inventory. */
export async function loadedIds(rpc=codexRpc):Promise<Set<string>|null>{
  const ids=new Set<string>(), cursors=new Set<string>();
  let cursor:string|undefined;
  for(let page=0;page<100;page++){
    const out=await rpc<{data?:unknown[];nextCursor?:string|null}>('thread/loaded/list',{limit:100,...(cursor?{cursor}:{})});
    if(!out || !Array.isArray(out.data) || out.data.some(x=>typeof x!=='string'))return null;
    for(const id of out.data as string[])ids.add(id);
    if(!out.nextCursor)return ids;
    if(cursors.has(out.nextCursor))return null;
    cursor=out.nextCursor;cursors.add(cursor);
  }
  return null;
}

export function reconcile(sessions:Session[],scan:Scan,matches:Matches,loaded:Set<string>|null,live:(s:Session)=>boolean|null=()=>null):Evidence{
  const at=Date.parse(scan.capturedAt);
  const error=!scan.interactive?'Collector is outside the interactive session'
    :!Number.isFinite(at)?'Invalid scan timestamp'
    :scan.windows.some(w=>w.scanError)?'Some terminal controls could not be read'
    :matches.unconfirmed.length?'Some terminal identities could not be confirmed':undefined;
  const result:Evidence={terminalScan:{at:Number.isFinite(at)?at:Date.now(),method,...(error?{error}:{})},proofs:new Map()};
  if(error)return result;
  const seen=new Set(matches.agents.map(a=>a.id));
  for(const s of sessions){
    if(s.managed){result.proofs.set(s.id,{present:false,at,method});continue;}
    if(!seen.has(s.id)){result.proofs.set(s.id,{present:false,at,method});continue;}
    if(s.host==='codex' && loaded===null){result.terminalScan.error='Codex runtime could not be read';continue;}
    const present=s.host==='codex'?loaded!.has(s.id):live(s);
    if(present===null){result.terminalScan.error='A terminal runtime could not be confirmed';continue;}
    result.proofs.set(s.id,{present,at,method});
  }
  return result;
}

export async function windowsTerminalEvidence(board:Board):Promise<Evidence>{
  let slot=cache.get(board);if(!slot){slot={};cache.set(board,slot);}
  if(slot.pending)return slot.pending;
  if(slot.value && Date.now()-slot.value.terminalScan.at<5000)return slot.value;
  const target=slot;
  target.pending=(async()=>{
    try{
      if(process.platform!=='win32')throw new Error('Terminal collector not available on this platform');
      const root=new URL('../../tools/TerminalPresence/',import.meta.url);
      const scan=await new Promise<Scan>((resolve,reject)=>execFile('powershell.exe',['-NoProfile','-NonInteractive','-File',fileURLToPath(new URL('scan.ps1',root))],
        {windowsHide:true,timeout:8000,maxBuffer:4*1024*1024,encoding:'utf8'},(err,out)=>{if(err)return reject(err);try{resolve(JSON.parse(out));}catch(e){reject(e);}}));
      // This shared matcher also backs the local native roster; no second interpretation of labels.
      const matcher=await import(new URL('match.mjs',root).href) as {matchRoster:(windows:unknown[],sessions:Session[])=>Matches};
      // Board TTL describes recent communication, not whether a terminal remains open.
      const sessions=board.sessions;
      const preliminary=matcher.matchRoster(scan.windows,sessions);
      const needsCodex=preliminary.agents.some(a=>sessions.some(s=>s.id===a.id&&s.host==='codex'&&!s.managed));
      const loaded=needsCodex?await loadedIds():new Set<string>();
      const candidates=sessions.filter(s=>!s.managed&&(s.host!=='codex'||loaded===null||loaded.has(s.id)));
      const matches=matcher.matchRoster(scan.windows,candidates);
      const result=reconcile(sessions,scan,matches,loaded,s=>{
        const pid=s.host==='claude'?claudePid(s.id):s.kimiConsole;
        if(!pid)return null;
        return (scan.runtime??[]).some(p=>p.pid===pid&&p.host===s.host&&p.started<=s.seen) ? true : null;
      });
      for(const s of sessions){
        const proof=result.proofs.get(s.id);
        if(proof?.present && s.host!=='codex' && Date.now()-s.seen<30_000)
          proof.status=s.waitingOnHuman ? (s.waitingOnHuman.kind==='approval'?'waitingOnApproval':'waitingOnUserInput') : s.state==='working'?'active':s.state==='idle'?'idle':undefined;
      }
      await Promise.all(sessions.filter(s=>s.host==='codex'&&result.proofs.get(s.id)?.present).map(async s=>{
        const data=await codexRpc<{thread?:{status?:{type?:string;activeFlags?:string[]}}}>('thread/read',{threadId:s.id,includeTurns:false});
        const status=data?.thread?.status;
        const proof=result.proofs.get(s.id)!;
        const waiting=status?.activeFlags?.find(f=>f==='waitingOnUserInput'||f==='waitingOnApproval');
        if(waiting||status?.type==='active'||status?.type==='idle')proof.status=waiting??status!.type;
      }));
      return result;
    }catch{return {terminalScan:{at:Date.now(),method,error:'Terminal scan unavailable'},proofs:new Map<string,Proof>()};}
  })();
  try{return target.value=await target.pending;}finally{target.pending=undefined;}
}

/** Decorate only this board's outgoing state; normal history/mail session visibility is unchanged. */
export async function terminalState(board:Board,state:object|null):Promise<object|null>{
  if(!state)return null;
  const evidence=await windowsTerminalEvidence(board);
  const source=state as {sessions?:Array<{name:string}>;pc?:string;person?:string};
  const lines=[...(source.sessions??[])];
  for(const s of board.sessions){
    if(evidence.proofs.get(s.id)?.present && !lines.some(line=>line.name===s.name))
      lines.push({name:s.name,host:s.host,project:s.project??'',where:s.where,status:board.status(s),work:s.work??'',doing:board.summary(s),next:s.next??'',holds:[],pc:source.pc??'',person:source.person??''} as {name:string});
  }
  return {...state,terminalScan:evidence.terminalScan,sessions:lines.map(line=>{
    const candidates=board.sessions.filter(s=>s.name===line.name&&evidence.proofs.get(s.id)?.present);
    const terminal=candidates.length===1?evidence.proofs.get(candidates[0]!.id):undefined;
    return {...line,...(terminal?{terminal}:{})};
  })};
}
