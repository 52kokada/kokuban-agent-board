import type { RuntimeFactory } from '../contracts.js';
import type { ManagedPolicy } from './policy.js';
import { CodexRuntime } from './codex.js';
import { ClaudeRuntime } from './claude.js';
export const providerRuntime = (session: Parameters<RuntimeFactory>[0], sink: Parameters<RuntimeFactory>[1], policy?: ManagedPolicy) => session.provider === 'codex' ? new CodexRuntime(session, sink, policy) : new ClaudeRuntime(session, sink, policy);
