import * as fs from 'node:fs';
import * as path from 'node:path';
import { DATA_DIR } from './config.js';
import { SETTINGS } from './cards.js';

export const AUTO_DIR = path.join(DATA_DIR, 'auto-update');
export function autoConfig(): { enabled: boolean; role: 'hub' | 'client'; from: string } | null {
  try {
    const c = JSON.parse(fs.readFileSync(SETTINGS.file, 'utf8')).autoUpdate;
    if (!c || c.enabled !== true || !['hub', 'client'].includes(c.role) || typeof c.from !== 'string') return null;
    if (!/^[a-z0-9][a-z0-9.-]{0,252}$/i.test(c.from)) return null;
    return { enabled: true, role: c.role, from: c.from };
  } catch { return null; }
}

/** Only the opt-in hub serves its separately validated checkout. Never its live keeper tree. */
export function publishedKokuban(): string | null {
  if (autoConfig()?.role !== 'hub') return null;
  try {
    const p = JSON.parse(fs.readFileSync(path.join(AUTO_DIR, 'published.json'), 'utf8'));
    if (!/^[a-f0-9]{40}$/.test(p.head) || typeof p.directory !== 'string') return null;
    const root = path.resolve(AUTO_DIR, 'releases') + path.sep;
    const directory = path.resolve(p.directory);
    if (!directory.startsWith(root) || !fs.existsSync(path.join(directory, '.git'))) return null;
    return directory;
  } catch { return null; }
}

export function writeAutoState(name: string, value: unknown): void {
  fs.mkdirSync(AUTO_DIR, { recursive: true });
  const target = path.join(AUTO_DIR, name + '.json');
  fs.writeFileSync(target + '.tmp', JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(target + '.tmp', target);
}
