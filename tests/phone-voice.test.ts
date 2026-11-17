import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Script, createContext } from 'node:vm';
import { PhoneVoice, voicePaths } from '../src/voice/service.js';
import { client } from '../src/phone/shell.js';
import type { Transcript } from '../src/voice/runtime/client.mjs';
const transcript = (text: string): Transcript => ({ text, language: 'en', languageProbability: 1, durationSeconds: 4, timing: { decodeSeconds: 0, transcribeSeconds: 1, totalSeconds: 1, cpuSeconds: 1 }, resources: {} });
const tick = () => new Promise(r => setImmediate(r));
function installed() { const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kokuban-voice-')), p = voicePaths(home); for (const name of ['small','turbo'] as const) { fs.mkdirSync(p[name],{recursive:true}); for(const f of ['model.bin','config.json','tokenizer.json']) fs.writeFileSync(path.join(p[name],f),'fixture'); } fs.mkdirSync(path.dirname(p.python),{recursive:true}); fs.writeFileSync(p.python,'fixture'); return home; }
test('voice is lazy, isolates job ownership, refines in two passes and unloads only idle turbo', async () => {
  const home = installed(), calls: string[] = [], closed: string[] = [], pending: (()=>void)[] = [];
  const voice = new PhoneVoice({ home, idleMs: 15, factory: o => { const model=path.basename(o.modelDir); calls.push(model); return { transcribe: async () => { if(model==='model-turbo')await new Promise<void>(r=>pending.push(r));return transcript(model); }, close: async()=>{closed.push(model);} }; } });
  assert.deepEqual(calls,[]); const first=voice.start('phone-one','audio'); await tick();
  assert.equal(voice.get('phone-two',first.id),undefined); assert.equal(voice.get('phone-one',first.id)?.state,'refining');
  assert.equal(voice.get('phone-one',first.id)?.small?.text,'model-small'); pending.shift()!(); await tick();
  assert.equal(voice.get('phone-one',first.id)?.refined?.text,'model-turbo'); await new Promise(r=>setTimeout(r,30));
  assert.deepEqual(closed,['model-turbo']); const second=voice.start('phone-one','audio'); await tick(); pending.shift()!(); await tick();
  assert.deepEqual(calls,['model-small','model-turbo','model-turbo']); assert.equal(voice.get('phone-one',second.id)?.state,'complete');
  await voice.close(); assert.ok(closed.includes('model-small')); fs.rmSync(home,{recursive:true,force:true});
});
test('missing installation keeps the audio and reports Voice unavailable without spawning', async () => {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'kokuban-no-voice-')); let spawned=false;
  const voice=new PhoneVoice({home,factory:()=>{spawned=true;throw Error('must not start');}}); const job=voice.start('phone','kept-audio'); await tick();
  assert.equal(voice.get('phone',job.id)?.state,'unavailable'); assert.equal(voice.get('phone',job.id)?.error,'Voice unavailable'); assert.equal(spawned,false);
  await voice.close(); fs.rmSync(home,{recursive:true,force:true});
});
test('turbo failure retains small transcript and bounded admission rejects excess work', async () => {
  const home=installed(); const release:(()=>void)[]=[];
  const voice=new PhoneVoice({home,factory:o=>({transcribe:async()=>{if(o.modelDir.endsWith('model-turbo'))throw Error('missing runtime');await new Promise<void>(r=>release.push(r));return transcript('small');},close:async()=>{release.splice(0).forEach(r=>r());}})});
  const jobs=Array.from({length:4},()=>voice.start('owner','audio')); assert.equal(voice.start('owner','audio').state,'unavailable');
  release.splice(0).forEach(r=>r()); await tick(); assert.equal(voice.get('owner',jobs[0].id)?.small?.text,'small'); assert.equal(voice.get('owner',jobs[0].id)?.state,'complete');
  await voice.close(); fs.rmSync(home,{recursive:true,force:true});
});
test('small and turbo composer results obey revision and attachment guards', () => {
  const line=client.split('\n').find(s=>s.startsWith('function applyVoiceResult('))!; const context=createContext({}); new Script(line).runInContext(context);
  const d={files:[{id:'audio'}],text:'Intro',revision:3}, job:any={attachmentId:'audio',base:'Intro',expectedRevision:3};
  Object.assign(context,{d,job,result:{state:'refining',small:transcript('first')}});new Script('applyVoiceResult(d,job,result)').runInContext(context);
  assert.equal(d.text,'Intro\nfirst'); d.text='My correction';d.revision++;
  Object.assign(context,{result:{state:'complete',refined:transcript('refined')}});new Script('applyVoiceResult(d,job,result)').runInContext(context);
  assert.equal(d.text,'My correction');assert.equal(job.manual,true);
  d.files=[];Object.assign(context,{result:{state:'complete',refined:transcript('late')}});new Script('applyVoiceResult(d,job,result)').runInContext(context);assert.equal(d.text,'My correction');
});
