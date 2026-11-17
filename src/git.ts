/**
 * Where a session is working, as "repo@branch", read straight from .git files:
 * no git process is spawned. Worktrees of one repository report the same repo.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

function read(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return null;
  }
}

function gitDirOf(cwd: string): string | null {
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    const dotGit = path.join(dir, '.git');
    try {
      if (fs.statSync(dotGit).isDirectory()) return dotGit;
      const pointer = /^gitdir:\s*(.+)$/m.exec(read(dotGit) ?? '');
      if (pointer) return path.resolve(dir, pointer[1]!);
    } catch {
      /* no .git here; keep walking up */
    }
    if (path.dirname(dir) === dir) return null;
  }
}

/**
 * The project a directory belongs to, the same on every PC: "owner/repo" from the origin remote in
 * .git/config, lowercased. Without one, the repository's folder name; outside git, the folder's.
 */
export function projectOf(cwd: string): string {
  if (!cwd) return '';
  const gitDir = gitDirOf(cwd);
  if (!gitDir) return path.basename(cwd).toLowerCase();
  const commonRel = read(path.join(gitDir, 'commondir'));
  const common = commonRel ? path.resolve(gitDir, commonRel) : gitDir;
  const config = read(path.join(common, 'config')) ?? '';
  const origin = /\[remote "origin"\][^[]*?\burl\s*=\s*(\S+)/.exec(config)?.[1] ?? '';
  const named = /[/:]([^/:]+\/[^/]+?)(?:\.git)?\/?$/.exec(origin)?.[1];
  if (named) return named.toLowerCase();
  return (path.basename(common) === '.git' ? path.basename(path.dirname(common)) : path.basename(common)).toLowerCase();
}

export function describeDir(cwd: string): string {
  if (!cwd) return '';
  const gitDir = gitDirOf(cwd);
  if (!gitDir) return path.basename(cwd);
  const commonRel = read(path.join(gitDir, 'commondir'));
  const common = commonRel ? path.resolve(gitDir, commonRel) : gitDir;
  const repo = path.basename(common) === '.git' ? path.basename(path.dirname(common)) : path.basename(common);
  const head = read(path.join(gitDir, 'HEAD')) ?? '';
  const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
  return `${repo}@${ref ? ref[1] : head ? `detached:${head.slice(0, 7)}` : '?'}`;
}

/** A repository's working-tree root, its folder name and its origin remote (credentials removed). */
export interface RepoIdentity { root: string; name: string; remote: string }

/**
 * The main working tree a directory belongs to, read from .git files only. A linked worktree (including
 * Claude's own under .claude/worktrees) maps to its main repository; a bare repository has none.
 */
export function repoIdentity(cwd: string): RepoIdentity | null {
  if (!cwd) return null;
  // A checkout under <repo>/.claude/worktrees/ belongs to that repo, whatever kind of checkout it is.
  const nested = /^(.*?)[\\/]\.claude[\\/]worktrees(?:[\\/]|$)/.exec(path.resolve(cwd));
  let found = '';
  let gitDir: string | null = null;
  for (let dir = path.resolve(nested ? nested[1]! : cwd); ; dir = path.dirname(dir)) {
    const dotGit = path.join(dir, '.git');
    try {
      if (fs.statSync(dotGit).isDirectory()) { gitDir = dotGit; found = dir; break; }
      const pointer = /^gitdir:\s*(.+)$/m.exec(read(dotGit) ?? '');
      if (pointer) { gitDir = path.resolve(dir, pointer[1]!); found = dir; break; }
    } catch {
      /* no .git here; keep walking up */
    }
    if (path.dirname(dir) === dir) return null;
  }
  const commonRel = read(path.join(gitDir, 'commondir'));
  const common = commonRel ? path.resolve(gitDir, commonRel) : gitDir;
  let root = found;
  if (commonRel) {
    // A linked worktree: the main working tree holds the common .git; a bare repository has no tree.
    if (path.basename(common) !== '.git') return null;
    root = path.dirname(common);
  }
  const config = read(path.join(common, 'config')) ?? '';
  const origin = /\[remote "origin"\][^[]*?\burl\s*=\s*(\S+)/.exec(config)?.[1] ?? '';
  // https://user:token@host/... never leaves this PC with its userinfo.
  const remote = origin.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/i, '$1');
  return { root, name: path.basename(root), remote };
}
