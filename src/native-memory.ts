/** Opt-in reads of existing native memory; never edits settings or generated state. */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { Session } from './board.js';
import type { TranscriptSource } from './retrieval.js';

export function nativeMemoryDirectories(me: Session) {
  let root = path.resolve(me.cwd || '.');
  while (!fs.existsSync(path.join(root, '.git')) && path.dirname(root) !== root) root = path.dirname(root);
  if (path.dirname(root) === root) root = path.resolve(me.cwd || '.');
  // A linked worktree shares the primary repository's auto-memory directory.
  try {
    const git = path.join(root, '.git');
    if (fs.statSync(git).isFile()) {
      const value = fs.readFileSync(git, 'utf8').trim().replace(/^gitdir:\s*/, '');
      const dir = path.resolve(root, value);
      const common = path.resolve(dir, fs.readFileSync(path.join(dir, 'commondir'), 'utf8').trim());
      if (path.basename(common) === '.git') root = path.dirname(common);
    }
  } catch { /* Unknown layout: report only the default location we can establish. */ }
  const home = os.homedir();
  return [
    { host: 'claude' as const, directory: path.join(process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'projects', root.replace(/[^a-zA-Z0-9]/g, '-'), 'memory'), scope: 'repository default; custom locations are not inferred' },
    { host: 'codex' as const, directory: path.join(process.env.CODEX_HOME || path.join(home, '.codex'), 'memories'), scope: 'machine; cross_repo=true required to search' },
  ].map(v => ({ ...v, available: fs.existsSync(v.directory) }));
}

export function nativeMemorySources(me: Session, crossRepo: boolean): TranscriptSource[] {
  const out: TranscriptSource[] = [];
  for (const entry of nativeMemoryDirectories(me)) {
    if (!entry.available || (entry.host === 'codex' && !crossRepo)) continue;
    const walk = (directory: string) => {
      if (out.length >= 2000) return;
      let files: fs.Dirent[];
      try { files = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
      for (const item of files) {
        if (out.length >= 2000) break;
        const file = path.join(directory, item.name);
        if (item.isSymbolicLink()) continue;
        if (item.isDirectory()) walk(file);
        else if (item.isFile() && item.name.endsWith('.md')) out.push({
          id: `memory:${entry.host}:${createHash('sha256').update(file).digest('hex')}`,
          name: `${entry.host} memory: ${path.relative(entry.directory, file)}`, host: entry.host, kind: 'memory', file,
          cwd: me.cwd, where: entry.host === 'claude' ? me.where : '', project: entry.host === 'claude' ? me.project : undefined,
        });
      }
    };
    walk(entry.directory);
  }
  return out;
}
