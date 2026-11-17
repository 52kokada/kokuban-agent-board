/** Titles and active tasks from host-owned records, incrementally and only on roster/feed reads. */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Session } from './board.js';
import { findCodexTranscript } from './glance.js';

const LIMIT = 2 * 1024 * 1024;
interface Seen { title: string; task: string; titles: Map<string, string>; tasks: Map<string, any> }
interface Tail { offset: number; size: number; modified: number; ino: number; seen: Seen }
const tails = new Map<string, Tail>();
const active = (t: any): boolean => ['in_progress', 'in-progress', 'active'].includes(t?.status);
const taskText = (t: any): string => t?.activeForm || t?.step || t?.subject || t?.content || '';
const fresh = (): Seen => ({ title: '', task: '', titles: new Map(), tasks: new Map() });

function tool(seen: Seen, name: string, input: any): void {
  try { if (typeof input === 'string') input = JSON.parse(input); } catch { return; }
  if (!input) return;
  if (name === 'TodoWrite' || name === 'update_plan') {
    const list = input.todos ?? input.plan;
    if (Array.isArray(list)) seen.task = taskText(list.find(active));
  } else if (name === 'TaskUpdate' || name === 'TaskCreate') {
    const id = String(input.taskId ?? input.id ?? 'latest');
    seen.tasks.set(id, { ...seen.tasks.get(id), ...input });
    seen.task = taskText([...seen.tasks.values()].find(active));
  }
}

function visit(seen: Seen, v: any): void {
  if (v.type === 'ai-title' && typeof v.aiTitle === 'string') seen.title = v.aiTitle;
  if (typeof v.id === 'string' && typeof v.thread_name === 'string') seen.titles.set(v.id, v.thread_name);
  if (v.isSidechain || v.isMeta) return;
  if (v.type === 'assistant' && Array.isArray(v.message?.content)) {
    for (const b of v.message.content) if (b.type === 'tool_use') tool(seen, b.name, b.input);
  }
  const p = v.type === 'response_item' ? v.payload : null;
  if (p?.type === 'function_call') tool(seen, p.name, p.arguments);
  if (p?.type === 'custom_tool_call') tool(seen, p.name, p.input);
  if (v.type === 'agent.message.appended' && (!v.agentId || v.agentId === 'main')) {
    const m = v.message?.message;
    if (m?.role === 'assistant') for (const call of m.toolCalls ?? []) tool(seen, call.name, call.arguments);
  }
}

/** Incomplete last lines stay unread until the writer finishes them. */
function scan(file: string): Seen {
  try {
    const stat = fs.statSync(file);
    let t = tails.get(file);
    if (t && stat.size === t.size && stat.mtimeMs === t.modified && stat.ino === t.ino) return t.seen;
    if (!t || stat.ino !== t.ino || stat.size < t.offset || (stat.size === t.size && stat.mtimeMs !== t.modified)) {
      t = { offset: Math.max(0, stat.size - LIMIT), size: -1, modified: 0, ino: stat.ino, seen: fresh() };
      tails.set(file, t);
    }
    const first = t.size === -1;
    const fd = fs.openSync(file, 'r');
    let buf: Buffer;
    try {
      buf = Buffer.alloc(stat.size - t.offset);
      const n = fs.readSync(fd, buf, 0, buf.length, t.offset);
      buf = buf.subarray(0, n);
    } finally { fs.closeSync(fd); }
    const end = buf.lastIndexOf(10) + 1;
    const skip = first && t.offset > 0 ? buf.indexOf(10) + 1 : 0;
    for (const raw of buf.subarray(skip, end).toString('utf8').split('\n')) {
      try { visit(t.seen, JSON.parse(raw)); } catch { /* partial/malformed lines are not state */ }
    }
    t.offset += end;
    t.size = stat.size;
    t.modified = stat.mtimeMs;
    return t.seen;
  } catch { return fresh(); }
}

export function currentTitle(id: string, index = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'session_index.jsonl')): string {
  return scan(index).titles.get(id) ?? '';
}

const taskFiles = new Map<string, { modified: number; size: number; value: any }>();
function claudeTask(id: string, root: string): string | undefined {
  try {
    const dir = path.join(root, 'tasks', id);
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    const tasks = files.flatMap(f => {
      try {
        const file = path.join(dir, f), stat = fs.statSync(file);
        let cached = taskFiles.get(file);
        if (!cached || cached.modified !== stat.mtimeMs || cached.size !== stat.size) {
          cached = { modified: stat.mtimeMs, size: stat.size, value: JSON.parse(fs.readFileSync(file, 'utf8')) };
          taskFiles.set(file, cached);
        }
        return [cached.value];
      } catch { return []; }
    });
    if (!tasks.length) return undefined;
    return taskText(tasks.filter(active).sort((a, b) => Number(b.id) - Number(a.id))[0]);
  } catch { return undefined; }
}

export function derivedDoing(s: Session, claudeRoot = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), index?: string): string {
  if (!s.transcript && s.host === 'codex') s.transcript = findCodexTranscript(s.id);
  const seen = s.transcript ? scan(s.transcript) : fresh();
  let title = s.host === 'codex' ? currentTitle(s.id, index) : seen.title;
  if (s.host === 'kimi' && s.transcript) {
    try {
      const file = path.resolve(path.dirname(s.transcript), '../../state.json');
      const stat = fs.statSync(file);
      let cached = taskFiles.get(file);
      if (!cached || cached.modified !== stat.mtimeMs || cached.size !== stat.size) {
        cached = { modified: stat.mtimeMs, size: stat.size, value: JSON.parse(fs.readFileSync(file, 'utf8')) };
        taskFiles.set(file, cached);
      }
      if (typeof cached.value.title === 'string') title = cached.value.title;
    } catch { /* A missing native title never blocks the board. */ }
  }
  if ([s.name, `🟠 ${s.name}`, `⚪ ${s.name}`].includes(title)) title = '';
  else if (title.startsWith(`${s.name} · `)) title = title.slice(s.name.length + 3);
  const task = s.host === 'claude' ? claudeTask(s.id, claudeRoot) ?? seen.task : seen.task;
  return [...new Set([title, task].filter(Boolean))].join(' · ').replace(/\s+/g, ' ').trim().slice(0, 140);
}
