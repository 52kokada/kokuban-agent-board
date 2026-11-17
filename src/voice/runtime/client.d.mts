import { EventEmitter } from 'node:events';

export interface Resources {
  rssBytes?: number;
  peakRssBytes?: number;
  privateBytes?: number;
  cpuSeconds?: number;
}
export interface Transcript {
  text: string;
  language: string;
  languageProbability: number;
  durationSeconds: number;
  timing: { decodeSeconds: number; transcribeSeconds: number; totalSeconds: number; cpuSeconds: number };
  resources: Resources;
}
export interface VoiceOptions {
  /** Absolute path to the venv's python.exe. Spawned hidden, never detached. */
  command: string;
  modelDir: string;
  audioRoot: string;
  script?: string;
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
  maxPending?: number;
  restartDelayMs?: number;
  maxRestartDelayMs?: number;
  threads?: number;
  maxSeconds?: number;
  maxBytes?: number;
  env?: NodeJS.ProcessEnv;
  /** Personal spellings/names. Hints only: no automatic replacement or voice training. */
  vocabulary?: string[];
}
export class VoiceError extends Error { code: string; constructor(code: string, message: string); }
export class VoiceWorker extends EventEmitter {
  constructor(options: VoiceOptions);
  readonly pid: number | null;
  readonly readyInfo: { protocol: 1; model: string; device: string; computeType: string; threads: number; loadSeconds: number; resources: Resources } | null;
  start(): Promise<NonNullable<VoiceWorker['readyInfo']>>;
  transcribe(path: string, options?: { language?: string; vocabulary?: string[] }): Promise<Transcript>;
  stats(): Promise<{ completed: number; resources: Resources }>;
  close(): Promise<void>;
}
export function transcribeVoiceNote<T extends { path: string }>(worker: VoiceWorker, audioAttachment: T, options?: { language?: string; vocabulary?: string[] }): Promise<{
  text: string; transcript: Transcript; attachments: [T];
}>;
