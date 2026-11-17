import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import fsDefault from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mock, test } from 'node:test';
import { Board } from '../src/board.js';
import { SETTINGS } from '../src/cards.js';
import { KnowStore, validate, encode, decode, noSecrets, knowTool, syncKnowhow, commitKnowhow, thisPc, type Entry } from '../src/know.js';
import { handlePeer } from '../src/peer.js';
import { handleRpc } from '../src/mcp.js';
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(),'kokuban-know-'));
const sample = (n=1): Entry => ({id:`20261016-test-${n.toString(16).padStart(4,'0')}`,kind:'observation',title:'Browser test',subject:'browser',symptom:'hang',cause:'hook',fix:'bare flags',evidence:'local test',created:'2026-10-16T00:00:00.000Z',author:{person:'Alex',pc:'a',agent:'Rio'}});
const NOW = Date.parse('2026-10-17T00:00:00Z');
test('validation, YAML roundtrip, secret refusal and immutable entries', () => {
  const store = new KnowStore(temp()), e = sample();
  assert.deepEqual(decode(encode({...e,body:'hello\nworld',title:'A: "quoted" title'})),{...e,body:'hello\nworld',title:'A: "quoted" title'});
  for (const key of ['title','subject','evidence','symptom','cause','fix']) assert.throws(() => validate({...e,[key]:''}));
  assert.throws(() => validate({...e,kind:'rule',owner:''}));
  for (const text of ['password=abc','password: abc','sk-abc','ghp_abc','xoxb-abc','AKIA123456', 'a'.repeat(40),'Q/'.repeat(40)]) assert.throws(() => noSecrets(text));
  noSecrets('Use vault item browser sign-in'); store.write(e); assert.throws(() => store.write(e),/EEXIST/);
});
test('status, expiry windows, search ranking and labels, retract ownership', () => {
  const store = new KnowStore(temp()); for (let i=1;i<=12;i++) store.write(sample(i));
  const mark = (id: string, op:'confirm'|'contradict'|'retract',day:number,person='Alex') => store.append({id,op,author:{person,pc:'b',agent:'Other'},created:new Date(NOW+day*86400000).toISOString(),evidence:'tested',why:'replaced'});
  mark(sample(1).id,'contradict',0); mark(sample(2).id,'confirm',0);
  assert.equal(store.label(sample(1),NOW),'contradicted');
  assert.match(store.search('browser',undefined,false,NOW)[0]!,/0002.*confirmed 1×/);
  assert.equal(store.search('browser',undefined,false,NOW).length,8);
  mark(sample(1).id,'confirm',1); assert.match(store.label(sample(1),NOW+86400000),/^confirmed/);
  assert.equal(store.label(sample(3),NOW+90*86400000),'stale');
  assert.equal(store.label({...sample(3),version:'1'},NOW+30*86400000),'stale');
  assert.equal(store.search('browser',undefined,false,NOW+200*86400000).length,0);
  assert.equal(store.search('browser',undefined,true,NOW+200*86400000).length,8);
  assert.throws(() => mark(sample(2).id,'retract',1,'Sam'),/author/);
  mark(sample(2).id,'retract',1); assert.equal(store.label(sample(2),NOW),'retracted');
  assert(!store.search('browser',undefined,false,NOW).some(s => s.startsWith(sample(2).id)));
});
test('peer share gate and bidirectional union keep all entries and deduplicate marks', async () => {
  const a = new KnowStore(path.join(temp(),'knowledge','knowhow')), b = new KnowStore(path.join(temp(),'knowledge','knowhow'));
  a.write(sample(1)); b.write(sample(2));
  b.append({id:sample(2).id,op:'confirm',author:sample().author,created:sample().created,evidence:'worked'});
  const board = new Board(), headers = {'tailscale-user-login':'test','x-forwarded-for':'100.64.0.2'};
  const deps = {lookup:async () => ({login:'test',node:'b'}),where:() => path.resolve(b.root,'../..')};
  assert.equal((await handlePeer(board,headers,{op:'knowhow'}, {...deps,trust:()=> 'talk'})).status,403);
  const response = await handlePeer(board,headers,{op:'knowhow',...a.inventory()},{...deps,trust:()=> 'share'});
  assert.equal(response.status,200); a.union(response.body as never);
  for(let i=0;i<3;i++) { b.union(a.missing(b.inventory().ids,b.inventory().hashes)); a.union(b.missing(a.inventory().ids,a.inventory().hashes)); }
  assert.equal(a.entries().length,2); assert.equal(b.entries().length,2); assert.equal(a.lines().length,1); assert.equal(b.lines().length,1);
  const raw = fs.readFileSync(path.join(a.entriesDir,sample(1).id+'.md'),'utf8');
  a.union({entries:[{id:sample(1).id,content:encode({...sample(1),title:'replacement'})}],events:[]});
  assert.equal(fs.readFileSync(path.join(a.entriesDir,sample(1).id+'.md'),'utf8'),raw);
  assert.throws(() => a.union({entries:[{id:'../escape',content:encode(sample())}],events:[]}));
});
test('tool stamps identity, records only requested feed events and exposes both hosts', async () => {
  const old = SETTINGS.file; SETTINGS.file = path.join(temp(),'settings.json'); fs.writeFileSync(SETTINGS.file,JSON.stringify({person:'Alex'}));
  try {
    const board = new Board(), me = board.touch('test','','codex').session, store = new KnowStore(temp());
    const id = knowTool(board,me,{...sample(),op:'add',author:{person:'fake'}},store);
    assert.equal(store.get(id).author.person,'Alex'); assert.equal(store.get(id).author.agent,me.name);
    knowTool(board,me,{op:'confirm',id,evidence:'works'},store); assert.equal(board.feed.length,1);
    knowTool(board,me,{op:'contradict',id,evidence:'fails'},store); assert.equal(board.feed.length,2);
    knowTool(board,me,{op:'retract',id,why:'obsolete'},store); assert.equal(board.feed.length,3);
    for(const host of ['claude','codex'] as const) assert.match(JSON.stringify(await handleRpc(board,host,{id:1,method:'tools/list'})),/"name":"know"/);
  } finally { SETTINGS.file = old; }
});
test('sync loop pulls missing files and events, never deletes', async () => {
  const a = new KnowStore(temp()), b = new KnowStore(temp()); a.write(sample(1)); b.write(sample(2));
  const pull = async (target:KnowStore,source:KnowStore) => syncKnowhow(new Board(),{store:target,pcs:()=>['peer'],enabled:()=>false,fetch:async (_url,opts) => {
    const inv = JSON.parse(String(opts?.body)); return new Response(JSON.stringify(source.missing(inv.ids,inv.hashes)),{status:200});
  }});
  await pull(a,b); await pull(b,a); await pull(a,b); assert.equal(a.entries().length,2); assert.equal(b.entries().length,2);
});
const git = (dir:string,...args:string[]) => execFileSync('git',['-C',dir,...args],{windowsHide:true,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
function repos() {
  const root=temp(), origin=path.join(root,'origin.git'), a=path.join(root,'a'), b=path.join(root,'b');
  git(root,'init','--bare','-b','main',origin); git(root,'clone',origin,a);
  for(const dir of [a]) { git(dir,'config','user.name','test'); git(dir,'config','user.email','test@example.invalid'); }
  fs.writeFileSync(path.join(a,'README'),'base'); git(a,'add','.'); git(a,'commit','-m','base'); git(a,'push','origin','main');
  git(root,'clone',origin,b); git(b,'config','user.name','test'); git(b,'config','user.email','test@example.invalid');
  return {origin,a,b};
}
test('commit and push include only pool, retain unrelated staged work', async () => {
  const {origin,a}=repos(); new KnowStore(path.join(a,'knowledge','knowhow')).write(sample());
  fs.writeFileSync(path.join(a,'README'),'other agent staged work'); git(a,'add','README');
  assert.equal(await commitKnowhow(a),'know-how pushed');
  assert.equal(git(a,'diff','--cached','--name-only'),'README');
  assert.equal(git(origin,'show','main:README'),'base');
  assert.equal(await commitKnowhow(a),'know-how unchanged');
});
test('refused push merges only pool changes and does not overwrite unrelated files', async () => {
  const {a,b}=repos(); new KnowStore(path.join(a,'knowledge','knowhow')).write(sample(1));
  new KnowStore(path.join(b,'knowledge','knowhow')).write(sample(2)); await commitKnowhow(b);
  assert.equal(await commitKnowhow(a),'know-how merged and pushed');
  assert.equal(new KnowStore(path.join(a,'knowledge','knowhow')).entries().length,2);
  const c=repos(); fs.writeFileSync(path.join(c.b,'README'),'remote');git(c.b,'add','.');git(c.b,'commit','-m','outside');git(c.b,'push','origin','main');
  new KnowStore(path.join(c.a,'knowledge','knowhow')).write(sample());
  assert.match(await commitKnowhow(c.a),/another path/); assert.equal(fs.readFileSync(path.join(c.a,'README'),'utf8'),'base');
  const d=repos();fs.writeFileSync(path.join(d.a,'README'),'unpublished');git(d.a,'add','.');git(d.a,'commit','-m','outside');
  new KnowStore(path.join(d.a,'knowledge','knowhow')).write(sample()); assert.match(await commitKnowhow(d.a),/unpublished changes/);
});
test('pool-only refused push unions simultaneous event appends through gitattributes', async () => {
  const {a,b}=repos();
  fs.writeFileSync(path.join(a,'.gitattributes'),'knowledge/knowhow/events.jsonl text eol=lf merge=union\n');
  const sa=new KnowStore(path.join(a,'knowledge','knowhow')), sb=new KnowStore(path.join(b,'knowledge','knowhow'));
  sa.write(sample()); fs.writeFileSync(sa.eventsFile,'');git(a,'add','.');git(a,'commit','-m','pool baseline');git(a,'push','origin','main');git(b,'pull','--ff-only');
  sa.append({id:sample().id,op:'confirm',author:sample().author,created:sample().created,evidence:'tested on a'});
  sb.append({id:sample().id,op:'confirm',author:{...sample().author,pc:'b'},created:sample().created,evidence:'tested on b'});
  assert.equal(await commitKnowhow(b),'know-how pushed');assert.equal(await commitKnowhow(a),'know-how merged and pushed');
  assert.equal(sa.lines().length,2);git(b,'pull','--ff-only');assert.equal(sb.lines().length,2);
});
test('repeated offline syncs stay in usage; only reachability and commit changes reach feed', async () => {
  const board = new Board(), store = new KnowStore(temp()), usage: unknown[] = [];
  board.usage = e => usage.push(e);
  let online = false, commit = 'know-how unchanged';
  const deps = {store,pcs:()=>['laptop'],enabled:()=>true,commit:async()=>commit,fetch:async()=> {
    if (!online) throw new Error('offline');
    return new Response(JSON.stringify({entries:[],events:[]}));
  }};
  await syncKnowhow(board,deps);await syncKnowhow(board,deps);assert.equal(board.feed.length,0);assert.equal(usage.length,2);
  online=true;await syncKnowhow(board,deps);await syncKnowhow(board,deps);assert.equal(board.feed.length,1);
  online=false;await syncKnowhow(board,deps);await syncKnowhow(board,deps);assert.equal(board.feed.length,2);
  commit='know-how push refused';await syncKnowhow(board,deps);await syncKnowhow(board,deps);assert.equal(board.feed.length,3);
  commit='know-how pushed';await syncKnowhow(board,deps);assert.equal(board.feed.length,4);
});
test('union skips missing-entry marks, applies later marks, and retries the skipped mark', () => {
  const store=new KnowStore(temp());store.write(sample(1));
  const mark=(id:string)=>JSON.stringify({id,op:'confirm',author:sample().author,created:sample().created,evidence:'worked'});
  const missing=mark(sample(2).id), present=mark(sample(1).id);
  store.union({entries:[],events:[missing,present]});assert.deepEqual(store.lines(),[present]);
  store.union({entries:[{id:sample(2).id,content:encode(sample(2))}],events:[missing,present]});assert.equal(store.lines().length,2);
});
test('tailnet short name identifies authors, with hostname fallback', () => {
  assert.equal(thisPc(()=>JSON.stringify({Self:{DNSName:'pc-a.tail123.ts.net.'}})),'pc-a');
  assert.equal(thisPc(()=>{throw Error('no Tailscale');}),os.hostname().toLowerCase());
  const before=SETTINGS.file;SETTINGS.file=path.join(temp(),'settings.json');fs.writeFileSync(SETTINGS.file,JSON.stringify({person:'Alex'}));
  try {const b=new Board(),s=b.touch('author-test','','codex').session,store=new KnowStore(temp());
    const id=knowTool(b,s,{...sample(),op:'add'},store,()=>thisPc(()=>JSON.stringify({Self:{DNSName:'pc-a.tail123.ts.net'}})));
    assert.equal(store.get(id).author.pc,'pc-a');
  } finally {SETTINGS.file=before;}
});
test('commit evidence permits full Git ids without allowing unrelated hex or tokens', () => {
  noSecrets('commit '+ 'a'.repeat(40));noSecrets('commit abcdef1');
  assert.throws(()=>noSecrets('key '+ 'a'.repeat(40)));assert.throws(()=>noSecrets('commit '+ 'a'.repeat(41)));
  assert.throws(()=>noSecrets('commit '+ 'a'.repeat(40)+' token=secret'));
  validate({...sample(),evidence:'commit '+ 'a'.repeat(40)});
});
test('entries opens a file only when it is new or changed, and still sees additions, edits and removals', () => {
  const store = new KnowStore(temp()), file = (n: number) => path.join(store.entriesDir, sample(n).id + '.md');
  store.write(sample(1)); store.write(sample(2));
  fs.writeFileSync(path.join(store.entriesDir, '20261016-test-0009.md'), 'not an entry');
  const opened: string[] = [];
  const real = fsDefault.readFileSync as (...a: unknown[]) => unknown;
  const read = mock.method(fsDefault, 'readFileSync', (...args: unknown[]) => {
    opened.push(path.basename(String(args[0])));
    return real(...args);
  });
  syncBuiltinESMExports();
  try {
    assert.deepEqual(store.entries().map((e) => e.id), [sample(1).id, sample(2).id]);
    assert.equal(opened.length, 3);
    // An unchanged pool opens nothing, also through a second store on the same folder (storeFor makes one per call).
    const first = store.entries();
    assert.deepEqual(new KnowStore(store.root).entries(), first);
    assert.equal(opened.length, 3);
    // A caller's change to what it was given does not reach the next caller.
    first[0]!.title = 'changed by a caller'; first[0]!.author.agent = 'Other';
    assert.deepEqual(store.entries()[0], { ...sample(1), body: '' });
    opened.length = 0;
    store.write(sample(3));
    fs.writeFileSync(file(2), encode({ ...sample(2), title: 'Edited outside the board' }));
    fs.rmSync(file(1));
    assert.deepEqual(store.entries().map((e) => e.title), ['Edited outside the board', 'Browser test']);
    assert.deepEqual(opened.sort(), [sample(2).id + '.md', sample(3).id + '.md']);
    // The invalid file becomes an entry once its content is one.
    fs.writeFileSync(path.join(store.entriesDir, '20261016-test-0009.md'), encode(sample(9)));
    assert.equal(store.entries().length, 3);
  } finally { read.mock.restore(); syncBuiltinESMExports(); }
});
