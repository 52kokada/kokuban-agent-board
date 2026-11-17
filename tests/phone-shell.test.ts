import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { Script, createContext } from 'node:vm';
import { client, shell } from '../src/phone/shell.js';

// Execute the actual client functions at the transport/state boundary without
// replacing the daemon or granting a browser a production pairing.
function functions(...names: string[]): string {
  return names.map(name => {
    const line = client.split('\n').find(s => s.startsWith(`function ${name}(`) || s.startsWith(`async function ${name}(`));
    assert.ok(line, `Client function ${name} exists`); return line;
  }).join('\n');
}

test('shell keeps scripts external and remote text out of HTML sinks', () => {
  new Script(client);
  assert.ok(shell.includes('src="/phone/app.js"'));
  assert.equal(/<script(?![^>]*\bsrc=)/i.test(shell), false);
  assert.equal(client.includes('.innerHTML'), false);
  assert.equal(shell.includes('data:image'), false);
});

test('phone text links preserve text and only open HTTP URLs in a separate tab', () => {
  const node = (text = ''): any => ({ textContent: text, children: [], replaceChildren() { this.children = []; }, append(...items: any[]) { this.children.push(...items); } });
  const context = createContext({ URL, document: { createElement: () => node() } });
  new Script(functions('linkify')).runInContext(context);
  const text = 'Open https://docs.google.com/document/d/example/edit?authuser=user1%40example.edu. Or (https://example.com/a_(b)). javascript:alert(1) data:text/html,test <img onerror=alert(1)>';
  const target = node(text); context.target = target;
  new Script('linkify(target)').runInContext(context);
  const links = target.children.filter((n: any) => typeof n !== 'string');
  assert.equal(links.length, 2);
  assert.equal(links[0].href, 'https://docs.google.com/document/d/example/edit?authuser=user1%40example.edu');
  assert.equal(links[1].href, 'https://example.com/a_(b)');
  for (const a of links) { assert.equal(a.target, '_blank'); assert.equal(a.rel, 'noopener noreferrer'); }
  assert.equal(target.children.map((n: any) => typeof n === 'string' ? n : n.textContent).join(''), text);
});

test('session swipe controls follow actual controller phases', () => {
  const context = createContext({}); new Script(functions('sessionAction')).runInContext(context);
  for (const [phase, expected] of Object.entries({ working: 'stop', stopped: 'resume', idle: null, approval: null, closed: null, error: null, recovery: null })) {
    context.phase = phase;
    assert.equal(new Script('sessionAction({phase})').runInContext(context), expected);
    assert.equal(new Script('sessionAction({phase,external:true})').runInContext(context), null);
  }
});

test('card content exposes safe links, all follow-ups and indexed attachment downloads', () => {
  const node = (tag = ''): any => ({ tag, textContent: '', children: [], replaceChildren() { this.children=[]; }, append(...items: any[]) { this.children.push(...items); } });
  const context=createContext({ URL, document:{createElement:node} });new Script(functions('linkify','el','safeCardLink','imageName','cardContent')).runInContext(context);
  const article=node('article');Object.assign(context,{article,item:{thread:'card:host:17',links:['https://example.test/paper','javascript:alert(1)','/relative'],steps:Array.from({length:5},(_,i)=>({text:'Follow-up '+i+' https://example.test/step-'+i})),files:['Strategy paper.docx']}});
  new Script('cardContent(item,article)').runInContext(context);
  const all:any[]=[];const walk=(n:any)=>{if(typeof n==='object'){all.push(n);n.children.forEach(walk);}};walk(article);
  const anchors=all.filter(n=>n.tag==='a');assert.equal(anchors.length,7);
  for(const a of anchors){assert.equal(a.target,'_blank');assert.equal(a.rel,'noopener noreferrer');}
  assert.ok(all.some(n=>n.tag==='summary'&&n.textContent==='Show earlier'));assert.equal(all.filter(n=>n.tag==='p').length,5);
  const download=anchors.find(n=>n.download);assert.equal(download.textContent,'Strategy paper.docx');assert.equal(download.href,'/phone/card-file?thread=card%3Ahost%3A17&n=0');
});

test('Return sends except during Japanese composition or requested hardware newlines', () => {
  const context:any=createContext({matchMedia:()=>({matches:false})});new Script(functions('sendsOnReturn')).runInContext(context);
  const key=(over:any={})=>{context.event={key:'Enter',target:{value:'Hello'},...over};return new Script('sendsOnReturn(event)').runInContext(context);};
  assert.equal(key(),true);assert.equal(key({isComposing:true}),false);assert.equal(key({keyCode:229}),false);assert.equal(key({shiftKey:true}),false);
  context.matchMedia=()=>({matches:true});assert.equal(key({target:{value:'Two\nlines'}}),false);assert.equal(key({target:{value:'Two\nlines'},ctrlKey:true}),true);
  assert.ok(shell.includes('autocomplete="off" enterkeyhint="send"'));assert.ok(shell.includes('enterkeyhint="done"'));assert.ok(shell.includes('font-size:16px!important'));
  assert.equal(/user-scalable=no|maximum-scale=1/i.test(shell),false);
});

test('conversation entry follows latest messages and restores deliberate history reading', () => {
  const area = { scrollTop: 0, scrollHeight: 2000, clientHeight: 500 };
  const context: any = createContext({ selected: { id: 'alpha' }, scrollPositions: new Map(), chatPinned: true, wantsChat: () => true, $: () => area });
  new Script(functions('rememberScroll', 'restoreScroll')).runInContext(context);
  new Script('restoreScroll()').runInContext(context); assert.equal(area.scrollTop, 2000);
  area.scrollTop = 250; new Script('rememberScroll()').runInContext(context);
  area.scrollTop = 0; new Script('restoreScroll()').runInContext(context);
  assert.equal(area.scrollTop, 250); assert.equal(context.chatPinned, false);
  area.scrollTop = 1500; new Script('rememberScroll()').runInContext(context);
  area.scrollHeight = 2400; new Script('restoreScroll()').runInContext(context);
  assert.equal(area.scrollTop, 2400); assert.equal(context.chatPinned, true);
});

test('a card reply clears the sent text while preserving edits made during delivery', () => {
  const cardDrafts = new Map([['card', 'Sent reply']]), input = { value: 'Sent reply' };
  const context = createContext({ cardDrafts, input });
  new Script(functions('acknowledgeCardReply')).runInContext(context);
  new Script("acknowledgeCardReply('card',input,'Sent reply')").runInContext(context);
  assert.equal(input.value, ''); assert.equal(cardDrafts.has('card'), false);
  input.value = 'New draft';
  new Script("acknowledgeCardReply('card',input,'Previous reply')").runInContext(context);
  assert.equal(input.value, 'New draft'); assert.equal(cardDrafts.get('card'), 'New draft');
});

test('keyboard resizing follows the visual viewport without losing the latest message', () => {
  const styles = new Map(), area = { scrollTop: 400, scrollHeight: 1200 };
  let keyboard = false;
  const context = createContext({ viewportFrame: 0, chatPinned: true, innerHeight: 844,
    window: { visualViewport: { height: 480, offsetTop: 80 } },
    document: { documentElement: { style: { setProperty: (k: string, v: string) => styles.set(k, v) } }, body: { classList: { toggle: (_k: string, v: boolean) => { keyboard = v; } } } },
    cancelAnimationFrame() {}, requestAnimationFrame(fn: () => void) { fn(); return 1; }, $: () => area, wantsChat: () => true,
  });
  // viewportSize is declared after viewportFrame on the same source line.
  const line = client.split('\n').find(s => s.startsWith('let viewportFrame;'))!;
  new Script(line.slice(line.indexOf('function viewportSize'), line.indexOf('window.visualViewport?.addEventListener'))).runInContext(context);
  new Script('viewportSize()').runInContext(context);
  assert.equal(styles.get('--app-height'), '480px'); assert.equal(styles.get('--app-top'), '80px');
  assert.equal(keyboard, true); assert.equal(area.scrollTop, 1200);
});

test('an uncertain command is retried with exactly its original ID and body', async () => {
  const store = new Map<string, string>(), nodes = new Map<string, any>(); const requests: any[] = [];
  let fail = true;
  const context = createContext({
    selected: null, drafts: new Map(), updateComposer() {}, renderDraft() {},
    $: (id: string) => { if (!nodes.has(id)) nodes.set(id, {}); return nodes.get(id); },
    document: { querySelectorAll: () => [] },
    sessionStorage: { getItem: (k: string) => store.get(k), setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) },
    fetch: async (_url: string, options: any) => { requests.push(JSON.parse(options.body)); if (fail) { fail = false; throw Error('connection lost'); } return { ok: true, status: 200, json: async () => ({ ok: true }) }; },
  });
  new Script(functions('api', 'pending', 'mark', 'draft', 'acknowledgeDraft', 'retry', 'write')).runInContext(context);
  await assert.rejects(new Script("write({op:'command',command:{id:'same-id',sessionId:'s',op:'message',text:'Keep me'}})").runInContext(context), /connection lost/);
  assert.ok(store.has('kokuban-pending'));
  await new Script('retry()').runInContext(context);
  assert.deepEqual(requests[0], requests[1]); assert.equal(store.has('kokuban-pending'), false);
});

test('switching conversations never copies one session draft into another', async () => {
  const drafts = new Map<string, string>(); const input = { value: 'Draft for old session' };
  const context: any = createContext({
    selected: { id: 'old' }, recording: null, generation: 0, seen: new Set(), cursor: 0, before: null, hasMore: false, events: [], view: 'conversation',
    cancelPoll() { context.generation++; }, saveDraft() { drafts.set(context.selected.id, input.value); },
    api: async (_path: string, request: any) => request.op === 'get' ? { session: { id: request.sessionId } } : { events: [], before: null, hasMore: false },
    go(next: string, save = true) { if (save) context.saveDraft(); context.view = next; },
    rememberScroll() {}, restoreScroll() {}, renderSelected() {}, renderHistory() {}, renderDraft() { input.value = drafts.get(context.selected.id) || ''; }, startPoll() {},
  });
  new Script(functions('openSession')).runInContext(context);
  await new Script("openSession('new')").runInContext(context);
  assert.equal(drafts.get('old'), 'Draft for old session'); assert.equal(drafts.has('new'), false); assert.equal(input.value, '');
});

test('a retried send clears only the acknowledged draft revision', () => {
  const saved = { sessionId: 's', revision: 2 };
  const d = { text: 'New edit', files: ['kept'], revision: 3 };
  const context = createContext({ selected: null, drafts: new Map([['s', d]]), sessionStorage: { getItem: () => JSON.stringify(saved) } });
  new Script(functions('acknowledgeDraft')).runInContext(context);
  new Script("acknowledgeDraft({command:{op:'message'}})").runInContext(context);
  assert.equal(d.text, 'New edit'); assert.equal(d.files.length, 1);
  saved.revision = 3;
  new Script("acknowledgeDraft({command:{op:'message'}})").runInContext(context);
  assert.equal(d.text, ''); assert.equal(d.files.length, 0); assert.equal(d.revision, 4);
});

test('failed voice uploads retain their recorded file for explicit retry', async () => {
  const d: any = { files: [], pendingUploads: [] }, file = { name: 'Voice note.m4a' };
  const context: any = createContext({ draft: () => d, uploadBusy: false, selected: { id: 's' }, updateComposer() {}, renderDraft() {}, uploadFile: async () => { throw Error('offline'); }, file });
  new Script(functions('attachRecording')).runInContext(context);
  await assert.rejects(new Script("attachRecording(file,'s')").runInContext(context), /offline/);
  assert.equal(d.pendingUploads.length, 1); assert.equal(d.pendingUploads[0].file, file);
  context.job = d.pendingUploads[0]; context.uploadFile = async () => { d.files.push({ id: 'saved-audio' }); };
  await new Script("attachRecording(file,'s',job)").runInContext(context);
  assert.equal(d.pendingUploads.length, 0); assert.equal(d.files.length, 1);
});

test('leaving a conversation while the microphone prompt is open stops the late stream', async () => {
  let grant!: (value: unknown) => void, stopped = 0;
  const context: any = createContext({ recording: null, micPending: false, selected: { id: 's' }, generation: 1,
    wantsChat: () => true, updateComposer() {}, document: { hidden: false }, window: { MediaRecorder: true },
    navigator: { mediaDevices: { getUserMedia: () => new Promise(resolve => { grant = resolve; }) } },
  });
  new Script(functions('record')).runInContext(context);
  const work = new Script('record()').runInContext(context);
  context.generation = 2;
  grant({ getTracks: () => [{ stop: () => { stopped++; } }] });
  await work;
  assert.equal(stopped, 1); assert.equal(context.recording, null); assert.equal(context.micPending, false);
});
