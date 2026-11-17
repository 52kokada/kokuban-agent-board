import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VoiceWorker, transcribeVoiceNote } from '../../src/voice/runtime/client.mjs';

async function setup(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'kokuban-voice-'));
  const worker = new VoiceWorker({ command: process.execPath,
    script: fileURLToPath(new URL('./fake-worker.mjs', import.meta.url)),
    modelDir: root, audioRoot: root, restartDelayMs: 20,
    startupTimeoutMs: 1000, requestTimeoutMs: 1000, ...options });
  t.after(async () => { await worker.close(); await rm(root, { recursive: true, force: true }); });
  return { worker, root };
}

function nextReady(worker) {
  return new Promise((resolve) => {
    const listener = (state) => { if (state.state === 'ready') { worker.off('state', listener); resolve(state); } };
    worker.on('state', listener);
  });
}

test('single resident worker handles concurrent jobs and retains audio attachment identity', async (t) => {
  const { worker, root } = await setup(t);
  const audio = Object.freeze({ id: 'audio-1', path: join(root, 'en.wav'), mime: 'audio/mp4', name: 'Voice note.m4a' });
  const a = worker.start(), b = worker.start();
  assert.equal(a, b);
  await a;
  const pid = worker.pid;
  const [note, japanese] = await Promise.all([transcribeVoiceNote(worker, audio), worker.transcribe(join(root, 'ja.wav'))]);
  assert.equal(note.text, 'Hello'); assert.equal(japanese.text, 'こんにちは');
  assert.equal(note.attachments[0], audio); assert.equal(worker.pid, pid);
  assert.equal(note.transcript.durationSeconds, 30);
});

test('queue is bounded during startup and busy inference', async (t) => {
  const { worker, root } = await setup(t, { maxPending: 2, env: { FAKE_DELAY: '100' } });
  const first = worker.transcribe(join(root, 'a.wav')), second = worker.transcribe(join(root, 'b.wav'));
  await assert.rejects(worker.transcribe(join(root, 'c.wav')), { code: 'QUEUE_FULL' });
  await Promise.all([first, second]);
});

test('crash rejects the job without replay, supervisor restarts and a new job succeeds', async (t) => {
  const { worker, root } = await setup(t, { env: { FAKE_MODE: 'crash-once' } });
  await worker.start();
  const pid = worker.pid;
  const ready = nextReady(worker);
  await assert.rejects(worker.transcribe(join(root, 'a.wav')), { code: 'WORKER_EXIT' });
  await ready;
  assert.notEqual(worker.pid, pid);
  assert.equal((await worker.transcribe(join(root, 'b.wav'))).text, 'Hello');
});

test('stuck request fails its generation and supervisor recovers', async (t) => {
  const { worker, root } = await setup(t, { requestTimeoutMs: 60 });
  await worker.start();
  const ready = nextReady(worker);
  await assert.rejects(worker.transcribe(join(root, 'hang.wav')), { code: 'REQUEST_TIMEOUT' });
  await ready;
  assert.equal((await worker.transcribe(join(root, 'good.wav'))).text, 'Hello');
});

test('invalid protocol result fails safely and restarts', async (t) => {
  const { worker, root } = await setup(t);
  await worker.start(); const ready = nextReady(worker);
  await assert.rejects(worker.transcribe(join(root, 'invalid.wav')), { code: 'PROTOCOL' });
  await ready;
  assert.equal((await worker.stats()).completed, 1);
});

test('startup timeout is bounded and close cancels automatic restarts', async (t) => {
  const { worker } = await setup(t, { startupTimeoutMs: 60, env: { FAKE_MODE: 'no-ready' } });
  await assert.rejects(worker.start(), { code: 'STARTUP_TIMEOUT' });
  await worker.close();
  await assert.rejects(worker.start(), { code: 'CLOSED' });
  assert.equal(worker.pid, null);
});

test('missing Python fails startup, without an unhandled rejection', async (t) => {
  const { worker } = await setup(t, { command: join(tmpdir(), 'kokuban-missing-python-123.exe') });
  await assert.rejects(worker.start(), { code: 'SPAWN_FAILED' });
  await worker.close();
});

test('shutdown rejects active work and does not leave a child', async (t) => {
  const { worker, root } = await setup(t);
  await worker.start();
  const pending = worker.transcribe(join(root, 'hang.wav'));
  const rejected = assert.rejects(pending, (e) => ['CLOSED', 'WORKER_EXIT'].includes(e.code));
  await worker.close(); await rejected;
  await worker.close();
  assert.equal(worker.pid, null);
});

test('relative paths and unsaved attachments are rejected before worker launch', async (t) => {
  const { worker } = await setup(t);
  await assert.rejects(worker.transcribe('../unrelated.wav'), { code: 'INVALID_PATH' });
  await assert.rejects(transcribeVoiceNote(worker, {}), { code: 'INVALID_ATTACHMENT' });
  assert.equal(worker.pid, null);
});

test('file-level error preserves the resident worker and original attachment', async (t) => {
  const { worker, root } = await setup(t);
  await worker.start(); const pid = worker.pid;
  const audio = Object.freeze({ path: join(root, 'error.wav'), id: 'kept-original' });
  await assert.rejects(transcribeVoiceNote(worker, audio), { code: 'DECODE_FAILED' });
  assert.equal(audio.id, 'kept-original'); assert.equal(worker.pid, pid);
  assert.equal((await worker.transcribe(join(root, 'good.wav'))).text, 'Hello');
});

test('configuration rejects ambiguous Python/model/root locations', () => {
  assert.throws(() => new VoiceWorker({ command: 'python', modelDir: tmpdir(), audioRoot: tmpdir() }), { code: 'CONFIG' });
  assert.throws(() => new VoiceWorker({ command: process.execPath, modelDir: '.', audioRoot: tmpdir() }), { code: 'CONFIG' });
});

test('repeated crashes back off instead of looping at full speed', async (t) => {
  const { worker } = await setup(t, { env: { FAKE_MODE: 'exit-ready' }, maxRestartDelayMs: 80 });
  const delays = [];
  const backedOff = new Promise((resolve) => worker.on('state', (state) => {
    if (state.state === 'restarting') { delays.push(state.delayMs); if (delays.length === 3) resolve(); }
  }));
  await worker.start(); await backedOff; await worker.close();
  assert.deepEqual(delays, [20, 40, 80]);
});
