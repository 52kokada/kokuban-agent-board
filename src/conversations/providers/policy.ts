import type { Options } from '@anthropic-ai/claude-agent-sdk';
export interface ManagedPolicy {
  systemAppend: string;
  mcpServers: Options['mcpServers'];
  gate(name: string, input: Record<string, unknown>, id: string): Promise<boolean>;
  codexConfig?: Record<string, unknown>;
  env?: NodeJS.ProcessEnv;
}
