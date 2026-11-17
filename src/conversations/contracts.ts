import { createHash } from 'node:crypto';
import type { RuntimeAttachment } from './attachments.js';

export const CHAT_PROTOCOL = 1;
export type Provider = 'codex' | 'claude';
export type Phase = 'launching' | 'idle' | 'working' | 'approval' | 'stopping' | 'stopped' | 'closing' | 'closed' | 'error' | 'recovery';
export interface Actor { pc: string; person: string }
export interface ChatMessage { id: string; text: string; actor: Actor; state: 'queued' | 'running' | 'complete' | 'interrupted' | 'uncertain'; turnId?: string; attachments?: string[] }
export interface Approval { id: string; epoch: number; requestId: string; kind: string; description: string; options?: unknown; state: 'pending' | 'allowed' | 'denied' | 'expired'; actor?: Actor }
export interface ChatSession {
  role?: 'chief'; chiefParent?: string;
  id: string; name: string; provider: Provider; project: string; cwd: string; host: string;
  phase: Phase; epoch: number; revision: number; controlRevision: number; created: number; updated: number;
  providerId?: string; turnId?: string; problem?: string; messages: ChatMessage[]; approvals: Approval[];
  tokenUsage?: { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number; observedAt: number; source: string };
}
export interface ChatEvent { seq?: number; id: string; sessionId: string; ts: number; kind: string; text?: string; actor?: Actor; data?: unknown }
export interface Command { id: string; op: 'message' | 'stop' | 'resume' | 'shutdown' | 'restart' | 'approve'; sessionId: string; epoch: number; controlRevision?: number; turnId?: string; text?: string; approvalId?: string; allow?: boolean; attachments?: string[]; resume?: boolean }
export interface Launch { id: string; projectId: string; provider: Provider; name?: string; text?: string }
export interface Project { id: string; name: string; path: string }
export interface RuntimeSink {
  event(kind: string, text?: string, data?: unknown): void;
  turn(id: string): void;
  complete(status: 'complete' | 'interrupted' | 'failed', detail?: string): void;
  approval(requestId: string, kind: string, description: string, options?: unknown): Promise<boolean>;
  exit(detail: string): void;
}
export interface Runtime {
  start(): Promise<string>;
  send(text: string, attachments?: RuntimeAttachment[]): Promise<string | undefined>;
  interrupt(turnId?: string): Promise<void>;
  close(): Promise<void>;
}
export type RuntimeFactory = (session: ChatSession, sink: RuntimeSink) => Runtime;
export class ChatError extends Error {
  constructor(message: string, readonly status = 400, readonly definitive = false) { super(message); }
}
export function text(value: unknown, label: string, max = 32768): string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > max || value.includes('\0')) throw new ChatError(`${label} must contain 1–${max} bytes`);
  return value.trim();
}
export function uuid(value: unknown): string {
  const id = text(value, 'Command ID', 64);
  if (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(id)) throw new ChatError('A UUID command ID is required');
  return id.toLowerCase();
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
  return value;
}
export const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export const publicSession = (s: ChatSession): ChatSession => ({ ...s, cwd: '', messages: s.messages.filter(m => m.state === 'queued' || m.state === 'running' || m.state === 'uncertain'), approvals: s.approvals.filter(a => a.state === 'pending').map(a => ({ ...a, requestId: '' })) });
