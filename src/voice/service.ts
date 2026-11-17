import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DATA_DIR } from '../config.js';
import { VoiceWorker, type Transcript, type VoiceOptions } from './runtime/client.mjs';

export interface VoiceResult { id: string; state: 'transcribing' | 'refining' | 'complete' | 'unavailable'; small?: Transcript; refined?: Transcript; error?: string }
interface Job extends VoiceResult { owner: string; created: number }
export interface Worker { transcribe: VoiceWorker['transcribe']; close(): Promise<void> }
export const VOICE_HOME = path.join(DATA_DIR, 'voice');
export function voicePaths(home = VOICE_HOME) { return { python: path.join(home, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'), small: path.join(home, 'model-small'), turbo: path.join(home, 'model-turbo') }; }

/** Board-owned, bounded job queue. No process/model exists before a voice upload. */
export class PhoneVoice {
  private small?: Worker;
  private turbo?: Worker;
  private idle?: NodeJS.Timeout;
  private jobs = new Map<string, Job>();
  private closing = false;
  private tasks = new Set<Promise<void>>();
  private retiring = new Set<Promise<void>>();
  private turboBusy = 0;
  private warmed = new WeakSet<Worker>();
  constructor(private options: { home?: string; audioRoot?: string; factory?: (options: VoiceOptions) => Worker; idleMs?: number } = {}) {}
  private worker(model: 'small' | 'turbo'): Worker {
    const p = voicePaths(this.options.home);
    if (!fs.existsSync(p.python) || !['config.json', 'model.bin', 'tokenizer.json'].every(f => fs.existsSync(path.join(p[model], f)))) throw Error('Voice unavailable');
    const worker = (this.options.factory ?? (o => new VoiceWorker(o)))({ command: p.python, modelDir: p[model], audioRoot: this.options.audioRoot ?? path.join(DATA_DIR, 'conversation-files'), maxPending: 4, requestTimeoutMs: 300000, startupTimeoutMs: 120000, env: { VOICE_MODEL_NAME: model } });
    if (worker instanceof VoiceWorker) worker.on('state', state => { if (state.state === 'ready') this.warmed.add(worker); });
    return worker;
  }
  private async failed(model: 'small' | 'turbo', error: unknown): Promise<void> {
    const worker = this[model], code = (error as { code?: string }).code ?? '';
    // Broken installations must not spawn forever. A previously ready worker
    // retains its bounded supervisor restart after a runtime crash/timeout.
    if (worker && !this.warmed.has(worker) && /^(SPAWN_FAILED|STARTUP_TIMEOUT|WORKER_EXIT|PROTOCOL)/.test(code)) { this[model] = undefined; await worker.close(); }
  }
  start(owner: string, audioPath: string): VoiceResult {
    if (this.closing) throw Error('Voice unavailable');
    for (const [id, j] of this.jobs) if (Date.now() - j.created > 3600000 && ['complete', 'unavailable'].includes(j.state)) this.jobs.delete(id);
    if ([...this.jobs.values()].filter(j => ['transcribing', 'refining'].includes(j.state)).length >= 4) return { id: '', state: 'unavailable', error: 'Voice unavailable · try again shortly' };
    while (this.jobs.size >= 64) { const old = [...this.jobs].find(([,j]) => ['complete','unavailable'].includes(j.state)); if (!old) break; this.jobs.delete(old[0]); }
    const job: Job = { id: randomUUID(), owner, created: Date.now(), state: 'transcribing' }; this.jobs.set(job.id, job);
    const task = this.run(job, audioPath).finally(() => this.tasks.delete(task)); this.tasks.add(task);
    return this.public(job);
  }
  private public(job: Job): VoiceResult { const { owner, created, ...result } = job; return result; }
  get(owner: string, id: string): VoiceResult | undefined { const j = this.jobs.get(id); return j?.owner === owner ? this.public(j) : undefined; }
  private async run(job: Job, audioPath: string): Promise<void> {
    try { this.small ??= this.worker('small'); job.small = await this.small.transcribe(audioPath); }
    catch (e) { await this.failed('small', e); job.state = 'unavailable'; job.error = 'Voice unavailable'; return; }
    if (this.closing) { job.state = 'complete'; return; }
    job.state = 'refining'; this.turboBusy++; clearTimeout(this.idle);
    try { this.turbo ??= this.worker('turbo'); job.refined = await this.turbo.transcribe(audioPath, { language: job.small.language }); }
    catch (e) { await this.failed('turbo', e); /* Keep the useful small transcript and original audio. */ }
    finally {
      job.state = 'complete'; this.turboBusy--;
      if (!this.closing && !this.turboBusy) { this.idle = setTimeout(() => { const worker = this.turbo; this.turbo = undefined; if (worker) { const retiring = worker.close().catch(() => {}).finally(() => this.retiring.delete(retiring)); this.retiring.add(retiring); } }, this.options.idleMs ?? 600000); this.idle.unref(); }
    }
  }
  async close(): Promise<void> { this.closing = true; clearTimeout(this.idle); await Promise.allSettled([this.small?.close(), this.turbo?.close(), ...this.retiring]); await Promise.allSettled([...this.tasks]); this.jobs.clear(); }
}
