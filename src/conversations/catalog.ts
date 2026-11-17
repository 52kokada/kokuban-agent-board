import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { digest, type Project } from './contracts.js';

/** Host-owned roots, never supplied by a remote request. No recursive disk scan. */
export function projectCatalog(roots = (process.env.KOKUBAN_PROJECT_ROOTS ?? path.join(os.homedir(), 'githubprojects')).split(path.delimiter)): Project[] {
  const projects = new Map<string, Project>();
  for (const root of roots) {
    try {
      const base = fs.realpathSync(root);
      if (base.startsWith('\\\\')) continue;
      for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        try {
          const dir = fs.realpathSync(path.join(base, entry.name));
          const relative = path.relative(base, dir);
          if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue;
          const id = digest(dir.toLowerCase()).slice(0, 24);
          projects.set(id, { id, name: entry.name, path: dir });
        } catch { /* Removed or inaccessible directory. */ }
      }
    } catch { /* An unavailable configured root does not expose other directories. */ }
  }
  return [...projects.values()].sort((a, b) => a.name.localeCompare(b.name));
}
