import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { Board } from '../src/board.js';
import { handlePeer } from '../src/peer.js';
import { syncVault, vaultAsked, vaultDecided, type VaultAccess, type VaultEntry, type VaultBatch } from '../src/vault.js';

const PREFIX = 'computeruse-vault-test-unit/';
const NAME = PREFIX + 'example.invalid/account';
const CANARY = 'SyntheticVaultCanary-do-not-log';
const BLOB = Buffer.from(CANARY,'utf16le').toString('base64');
const entry = (written: number, name = NAME): VaultEntry => ({ name, account: 'account', written, blob: BLOB });
function fake(): VaultAccess & { rows: Map<string,VaultEntry> } {
  const rows = new Map<string,VaultEntry>();
  return {
    prefix: PREFIX, rows,
    index: async () => ({entries:[...rows.values()].map(({name,account,written}) => ({name,account,written})),skipped:[]}),
    fetch: async names => names.flatMap(name => rows.has(name) ? [{...rows.get(name)!}] : []),
    import: async (entries, remove) => {
      const applied={write:[] as string[],remove:[] as string[]};
      for(const e of entries) if(e.written>(rows.get(e.name)?.written ?? 0)) {rows.set(e.name,{...e});applied.write.push(e.name);}
      for(const t of remove) if(t.written>(rows.get(t.name)?.written ?? 0)) {rows.delete(t.name);applied.remove.push(t.name);}
      return {updated:applied.write.length,removed:applied.remove.length,applied,failed:[],skipped:[],retryable:false};
    },
  };
}
const headers = { 'tailscale-user-login': 'test', 'x-forwarded-for': '100.64.0.2' };
const lookup = async () => ({ login: 'test', node: 'other' });
async function pull(board: Board, access: VaultAccess, other: Board, source: VaultAccess) {
  await syncVault(board,{access,pcs:()=>['other'],fetch:async(_url,opts) => {
    const out = await handlePeer(other,headers,JSON.parse(String(opts?.body)),{lookup,trust:()=> 'work',vault:source});
    return new Response(JSON.stringify(out.body),{status:out.status});
  }});
}
test('vault index is names only; both ops require work trust', async () => {
  const b=new Board(), access=fake();access.rows.set(NAME,entry(100));
  for(const level of ['talk','share'] as const) for(const op of ['vault_index','vault_fetch']) {
    assert.equal((await handlePeer(b,headers,{op,names:[NAME]},{lookup,trust:()=>level,vault:access})).status,403);
  }
  const index=await handlePeer(b,headers,{op:'vault_index'},{lookup,trust:()=> 'work',vault:access});
  assert.equal(index.status,200);assert(!JSON.stringify(index).includes(BLOB));assert(!JSON.stringify(index).includes(CANARY));
  const fetched=await handlePeer(b,headers,{op:'vault_fetch',names:[NAME]},{lookup,trust:()=> 'work',vault:access});
  assert(JSON.stringify(fetched.body).includes(BLOB));
  const foreign=await handlePeer(b,headers,{op:'vault_fetch',names:['computeruse/real/account']},{lookup,trust:()=> 'work',vault:access});
  assert.equal(foreign.status,503);assert(!JSON.stringify(foreign).includes(BLOB));
});
test('newest wins in both directions; removal travels; newer rotation revives the name', async () => {
  let now=1000;
  const a=new Board(null,()=>now),b=new Board(null,()=>now),va=fake(),vb=fake();
  va.rows.set(NAME,entry(100));await pull(b,vb,a,va);assert.equal(vb.rows.get(NAME)?.written,100);
  vb.rows.set(NAME,entry(200));await pull(a,va,b,vb);assert.equal(va.rows.get(NAME)?.written,200);
  va.rows.delete(NAME);await pull(b,vb,a,va);assert(!vb.rows.has(NAME));assert.equal(b.vault.tombstones[0]?.written,1000);
  await pull(a,va,b,vb);assert(!va.rows.has(NAME));
  now=2000;vb.rows.set(NAME,entry(2000));await pull(a,va,b,vb);assert.equal(va.rows.get(NAME)?.written,2000);
  assert.equal(a.vault.tombstones.length,0);
});
test('removal log survives a stopped board and tombstones expire after ninety days', async () => {
  let now=1000;const b=new Board(null,()=>now), access=fake();
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kokuban-vault-'));
  access.removalsFile=path.join(dir,'vault-tombstones.jsonl');
  fs.writeFileSync(access.removalsFile,JSON.stringify({name:NAME,written:900})+'\n');
  access.rows.set(NAME,entry(100));await vaultAsked(b,{op:'vault_index'},access);
  assert(!access.rows.has(NAME));assert.deepEqual(b.vault.tombstones,[{name:NAME,written:900}]);
  assert(!fs.existsSync(access.removalsFile+'.pending'));
  now+=91*86400000;await vaultAsked(b,{op:'vault_index'},access);assert.equal(b.vault.tombstones.length,0);
});
test('values and exception text never reach usage/feed/board snapshots or other files', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kokuban-vault-leak-')), file=path.join(dir,'board.json');
  const a=new Board(file),b=new Board(),va=fake(),vb=fake();vb.rows.set(NAME,entry(100));
  const usage=path.join(dir,'usage.jsonl');a.usage=e=>fs.appendFileSync(usage,JSON.stringify(e)+'\n');
  await pull(a,va,b,vb);assert(va.rows.has(NAME));
  assert.equal(a.feed[0]?.text,'vault: 1 entries updated from other');
  await syncVault(a,{access:va,pcs:()=>['bad'],fetch:async()=>{throw Error(CANARY+BLOB);}});
  a.flush();
  for(const f of fs.readdirSync(dir)) {
    const text=fs.readFileSync(path.join(dir,f),'utf8');assert(!text.includes(CANARY));assert(!text.includes(BLOB));assert(!text.includes('"blob"'));
  }
  assert.equal(new Board(file).vault.known[0]?.name,NAME);
});
test('enumeration failure does not manufacture removals, and peer failures are sanitized', async () => {
  const b=new Board(),access=fake();access.rows.set(NAME,entry(100));await vaultAsked(b,{op:'vault_index'},access);
  access.index=async()=>{throw Error(CANARY);};
  const out=await handlePeer(b,headers,{op:'vault_index'},{lookup,trust:()=> 'work',vault:access});
  assert.equal(out.status,503);assert(!JSON.stringify(out).includes(CANARY));assert.equal(b.vault.tombstones.length,0);assert.equal(b.vault.known.length,1);
});
test('a local rotation during fetch wins over the older fetched entry', async () => {
  const b=new Board(),access=fake();access.rows.set(NAME,entry(100));
  await syncVault(b,{access,pcs:()=>['other'],fetch:async(_url,opts)=>{
    const req=JSON.parse(String(opts?.body));
    if(req.op==='vault_index') return new Response(JSON.stringify({entries:[{...entry(200),blob:undefined}],tombstones:[]}));
    access.rows.set(NAME,entry(300));return new Response(JSON.stringify({entries:[entry(200)]}));
  }});
  assert.equal(access.rows.get(NAME)?.written,300);
});
test('malformed local metadata is skipped and counted without manufacturing a tombstone', async()=> {
  const board=new Board(),access=fake(),usage:Record<string,unknown>[]=[];
  board.usage=e=>usage.push(e);access.rows.set(NAME,entry(100));await vaultAsked(board,{op:'vault_index'},access);
  access.index=async()=>({entries:[],skipped:[NAME]});
  const result=await vaultAsked(board,{op:'vault_index'},access);
  assert.equal(board.vault.tombstones.length,0);assert.equal(board.vault.known[0]?.name,NAME);
  assert(usage.some(e=>e.tool==='vault:metadata'&&e.skipped===1));assert(!JSON.stringify(result).includes(BLOB));
});
test('partial batches refresh applied names and retry the rest next round', async()=> {
  const a=new Board(),b=new Board(),va=fake(),vb=fake();
  vb.rows.set(NAME,entry(100));vb.rows.set(NAME+'-two',entry(100,NAME+'-two'));
  const real=va.import;let calls=0;
  va.import=async(entries,remove)=> {
    if(calls++===0) {const done=await real(entries.slice(0,1),remove);return {...done,failed:[entries[1]!.name],retryable:true};}
    return real(entries,remove);
  };
  await pull(a,va,b,vb);assert.equal(a.vault.known.length,1);
  await pull(a,va,b,vb);assert.equal(a.vault.known.length,2);assert.equal(va.rows.size,2);
});
test('bulk removals aggregate across peers, hold once, and apply only after the card choice', async()=> {
  let now=1000;const board=new Board(null,()=>now),access=fake();
  const names=Array.from({length:4},(_,i)=>NAME+i);for(const name of names)access.rows.set(name,entry(100,name));
  const deps={access,pcs:()=>['one','two'],url:(pc:string)=>pc,fetch:async(url:unknown)=>new Response(JSON.stringify({entries:[],tombstones:names.slice(url==='one'?0:2,url==='one'?2:4).map(name=>({name,written:900}))}))};
  await syncVault(board,deps);assert.equal(access.rows.size,4);assert.equal(board.cards.length,1);assert(board.vault.review);
  await syncVault(board,deps);assert.equal(board.cards.length,1);assert.equal(access.rows.size,4);
  // The card and its names-only pending set survive a board snapshot/restart.
  const file=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'vault-brake-')),'board.json');
  const saved=new Board(file,()=>now);saved.vault=structuredClone(board.vault);saved.cards=structuredClone(board.cards);saved.flush();
  const resumed=new Board(file,()=>now);
  await vaultDecided(resumed,resumed.cards[0]!,'Apply the removals',access);assert.equal(access.rows.size,0);
});
test('Keep preserves entries without repeated cards; a newer local rotation is safe on Apply', async()=> {
  const b=new Board(null,()=>1000),v=fake(),names=Array.from({length:4},(_,i)=>NAME+i);
  for(const name of names)v.rows.set(name,entry(100,name));
  const deps={access:v,pcs:()=>['other'],fetch:async()=>new Response(JSON.stringify({entries:[],tombstones:names.map(name=>({name,written:900}))}))};
  await syncVault(b,deps);await vaultDecided(b,b.cards[0]!,'Keep the entries',v);await syncVault(b,deps);
  assert.equal(v.rows.size,4);assert.equal(b.cards.length,1);assert.equal(b.vault.tombstones.length,0);
  const a=new Board(null,()=>1000);await syncVault(a,deps);v.rows.set(names[0]!,entry(950,names[0]));
  await vaultDecided(a,a.cards[0]!,'Apply the removals',v);assert.equal(v.rows.size,1);assert.equal(v.rows.get(names[0]!)?.written,950);
});
test('the feed attributes a winning removal to its source, rather than a losing write', async()=> {
  const board=new Board(null,()=>1000),access=fake();access.rows.set(NAME,entry(100));
  await syncVault(board,{access,pcs:()=>['remover','writer'],url:pc=>pc,fetch:async(url,opts)=> {
    const req=JSON.parse(String(opts?.body));
    if(req.op==='vault_fetch') return new Response(JSON.stringify({entries:[entry(200)]}));
    return new Response(JSON.stringify(url==='remover'?{entries:[],tombstones:[{name:NAME,written:300}]}:{entries:[entry(200)],tombstones:[]}));
  }});
  assert.equal(access.rows.size,0);assert.equal(board.feed[0]?.text,'vault: 1 entries updated from remover');
});
