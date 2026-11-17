import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

export class VoiceError extends Error {
  constructor(code, message) { super(message); this.name = 'VoiceError'; this.code = code; }
}

/** One board-owned worker. Close it during board shutdown; never detach it. */
export class VoiceWorker extends EventEmitter {
  #child = null;
  #ready = null;
  #readyData = null;
  #pending = new Map();
  #slots = 0;
  #closed = false;
  #restart = null;
  #crashes = 0;
  #options;

  constructor(options) {
    super();
    if (!options || !isAbsolute(options.command ?? '') || !isAbsolute(options.modelDir ?? '') || !isAbsolute(options.audioRoot ?? '')) {
      throw new VoiceError('CONFIG', 'Absolute command, modelDir and audioRoot are required.');
    }
    this.#options = {
      command: 'python', script: fileURLToPath(new URL('./worker.py', import.meta.url)),
      startupTimeoutMs: 60_000, requestTimeoutMs: 120_000,
      maxPending: 8, restartDelayMs: 250, maxRestartDelayMs: 30_000,
      threads: 8, maxSeconds: 300, maxBytes: 25 * 1024 * 1024,
      vocabulary: [],
      ...options,
    };
    for (const key of ['startupTimeoutMs', 'requestTimeoutMs', 'maxPending', 'restartDelayMs', 'maxRestartDelayMs', 'threads', 'maxSeconds', 'maxBytes']) {
      if (!Number.isFinite(this.#options[key]) || this.#options[key] <= 0) {
        throw new VoiceError('CONFIG', `${key} must be positive.`);
      }
    }
    if (!isAbsolute(this.#options.script) || !Number.isInteger(this.#options.maxPending)
      || this.#options.maxPending > 32 || !Number.isInteger(this.#options.threads)
      || this.#options.threads > 16 || this.#options.maxSeconds > 600
      || !Number.isInteger(this.#options.maxBytes) || this.#options.maxBytes > 100 * 1024 * 1024) {
      throw new VoiceError('CONFIG', 'Invalid worker path or resource limits.');
    }
  }

  get pid() { return this.#child?.pid ?? null; }
  get readyInfo() { return this.#readyData; }

  start() {
    if (this.#closed) return Promise.reject(new VoiceError('CLOSED', 'Voice worker is closed.'));
    if (this.#restart) return this.#restart.promise;
    if (this.#child) return this.#ready;
    return this.#launch();
  }

  #launch() {
    const o = this.#options;
    let readyResolve, readyReject;
    this.#ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    // Automatic crash restarts have no caller awaiting their startup promise.
    this.#ready.catch(() => {});
    const child = spawn(o.command, [o.script, '--model-dir', o.modelDir, '--audio-root', o.audioRoot,
      '--threads', String(o.threads), '--max-seconds', String(o.maxSeconds), '--max-bytes', String(o.maxBytes)], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      // No shell and no detached:true: a venv's console child must stay hidden.
      env: { ...process.env, HF_HUB_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1',
        PYTHONUTF8: '1', PYTHONUNBUFFERED: '1',
        OMP_NUM_THREADS: String(o.threads), OMP_WAIT_POLICY: 'PASSIVE', KMP_BLOCKTIME: '0',
        OPENBLAS_NUM_THREADS: '1', MKL_NUM_THREADS: String(o.threads), CT2_USE_MKL: '0', ...o.env },
    });
    this.#child = child;
    this.#readyData = null;
    this.emit('state', { state: 'starting', pid: child.pid });
    let buffer = '', ready = false, failed = false;
    const timeout = setTimeout(() => fail(new VoiceError('STARTUP_TIMEOUT', 'Voice model startup timed out.')), o.startupTimeoutMs);
    const fail = (error) => {
      if (failed) return;
      failed = true;
      clearTimeout(timeout);
      readyReject(error);
      if (this.#child === child) { this.#child = null; this.#readyData = null; }
      for (const [id, pending] of this.#pending) {
        clearTimeout(pending.timer); this.#pending.delete(id); pending.reject(error);
      }
      // Closing the inherited pipes is also the Python EOF signal if kill fails.
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
      if (child.exitCode === null) child.kill();
      this.emit('state', { state: this.#closed ? 'closed' : 'crashed', code: error.code });
      if (!this.#closed) this.#scheduleRestart();
    };
    child.once('error', () => fail(new VoiceError('SPAWN_FAILED', 'Could not start the local voice worker.')));
    child.once('exit', (code, signal) => fail(new VoiceError('WORKER_EXIT', `Voice worker exited (${code ?? signal}).`)));
    child.stdin.on('error', () => fail(new VoiceError('PIPE_FAILED', 'Voice worker input pipe failed.')));
    child.stderr.on('data', (chunk) => {
      // Diagnostic listeners opt in; never put stderr into chat transcripts.
      this.emit('diagnostic', chunk.toString('utf8').slice(0, 4096));
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, 'utf8') > 1_048_576) {
        fail(new VoiceError('PROTOCOL', 'Voice worker output exceeded the limit.')); return;
      }
      let newline;
      while (!failed && (newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        let msg;
        try { msg = JSON.parse(line); } catch { fail(new VoiceError('PROTOCOL', 'Invalid voice worker JSON.')); return; }
        if (!msg || typeof msg !== 'object') { fail(new VoiceError('PROTOCOL', 'Invalid voice worker message.')); return; }
        if (!ready && msg.type === 'ready' && msg.protocol === 1) {
          ready = true; clearTimeout(timeout); this.#readyData = msg;
          readyResolve(msg); this.emit('state', { state: 'ready', pid: child.pid }); continue;
        }
        const pending = this.#pending.get(msg.id);
        if (!ready || !pending || !['result', 'error'].includes(msg.type)) {
          fail(new VoiceError('PROTOCOL', 'Unexpected voice worker message.')); return;
        }
        if (msg.type === 'result' && !validResult(pending.op, msg.data)) {
          fail(new VoiceError('PROTOCOL', 'Invalid voice worker result.')); return;
        }
        clearTimeout(pending.timer); this.#pending.delete(msg.id);
        if (msg.type === 'error') {
          pending.reject(new VoiceError(typeof msg.code === 'string' ? msg.code : 'TRANSCRIPTION_FAILED',
            typeof msg.message === 'string' ? msg.message : 'Local transcription failed.'));
        } else {
          this.#crashes = 0;
          pending.resolve(msg.data);
        }
      }
    });
    // Timeouts kill the generation, preventing a stuck native decoder from
    // blocking every future request. In-flight jobs fail and are never replayed.
    child.voiceFail = fail;
    return this.#ready;
  }

  #scheduleRestart() {
    const delay = Math.min(this.#options.maxRestartDelayMs, this.#options.restartDelayMs * 2 ** Math.min(this.#crashes++, 16));
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    promise.catch(() => {});
    const timer = setTimeout(() => {
      this.#restart = null;
      if (this.#closed) { reject(new VoiceError('CLOSED', 'Voice worker is closed.')); return; }
      this.#launch().then(resolve, reject);
    }, delay);
    this.#restart = { timer, promise, reject };
    this.emit('state', { state: 'restarting', delayMs: delay });
  }

  async #request(op, data = {}) {
    if (this.#closed) throw new VoiceError('CLOSED', 'Voice worker is closed.');
    if (this.#slots >= this.#options.maxPending) throw new VoiceError('QUEUE_FULL', 'Too many voice notes are queued.');
    this.#slots++;
    try {
      await this.start();
      const child = this.#child;
      if (!child || this.#closed) throw new VoiceError('WORKER_EXIT', 'Voice worker became unavailable.');
      const id = randomUUID();
      const line = JSON.stringify({ id, op, ...data }) + '\n';
      if (Buffer.byteLength(line) > 65_536) throw new VoiceError('INVALID_REQUEST', 'Voice request exceeds the protocol limit.');
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => child.voiceFail(new VoiceError('REQUEST_TIMEOUT', 'Local voice transcription timed out.')), this.#options.requestTimeoutMs);
        this.#pending.set(id, { op, resolve, reject, timer });
        child.stdin.write(line, 'utf8', (error) => {
          if (error) child.voiceFail(new VoiceError('PIPE_FAILED', 'Voice worker input pipe failed.'));
        });
      });
    } finally { this.#slots--; }
  }

  transcribe(path, { language, vocabulary = this.#options.vocabulary } = {}) {
    if (typeof path !== 'string' || !isAbsolute(path)) return Promise.reject(new VoiceError('INVALID_PATH', 'An absolute attachment path is required.'));
    return this.#request('transcribe', { path, vocabulary, ...(language === undefined ? {} : { language }) });
  }

  stats() { return this.#request('stats'); }

  async close() {
    this.#closed = true;
    if (this.#restart) {
      clearTimeout(this.#restart.timer);
      this.#restart.reject(new VoiceError('CLOSED', 'Voice worker is closed.'));
      this.#restart = null;
    }
    const child = this.#child;
    if (!child) return;
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.voiceFail(new VoiceError('CLOSED', 'Voice worker is closed.'));
    await exited;
  }
}

function validResult(op, data) {
  if (!data || typeof data !== 'object') return false;
  if (op === 'stats') return Number.isInteger(data.completed) && data.completed >= 0;
  return typeof data.text === 'string' && typeof data.language === 'string'
    && Number.isFinite(data.languageProbability) && data.languageProbability >= 0 && data.languageProbability <= 1
    && Number.isFinite(data.durationSeconds) && data.durationSeconds > 0
    && data.timing && ['decodeSeconds', 'transcribeSeconds', 'totalSeconds', 'cpuSeconds']
      .every((key) => Number.isFinite(data.timing[key]) && data.timing[key] >= 0);
}

/** Input is an already-saved attachment. This function never deletes or moves it.
 * Keep the attachment on failure too; callers may display an error/retry card.
 */
export async function transcribeVoiceNote(worker, audioAttachment, options) {
  if (!audioAttachment || typeof audioAttachment.path !== 'string') throw new VoiceError('INVALID_ATTACHMENT', 'A saved audio attachment is required.');
  const transcript = await worker.transcribe(audioAttachment.path, options);
  return { text: transcript.text, transcript, attachments: [audioAttachment] };
}
