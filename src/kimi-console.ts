/**
 * D130 visible Kimi wake. A Kimi session open in a terminal is woken by typing one short line into that
 * window, as its human would, instead of starting a hidden `kimi --session --prompt` process. The hidden
 * process takes the session's lock ("Session still in use" in the person's window), and its work never
 * appears on screen. The typed line starts an ordinary turn in the window; the prompt hook it causes hands
 * over the framed mail (hooks.ts), so delivery stays at least once and the person sees everything.
 *
 * The native helper (tools/ConsoleInput) is compiled from source with the .NET Framework csc, like the
 * D125 title helper; no binary is shipped. The daemon builds it when it is missing or older than its source.
 */
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from './config.js';

export const TYPIST = path.join(DATA_DIR, 'console-input', 'KokubanType.exe');
const SOURCE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'tools', 'ConsoleInput', 'ConsoleInput.cs');

/** The line typed into the window. One line of plain text: the prompt hook recognises it (hooks.ts). */
export const KIMI_WAKE_LINE = '[kokuban] Board mail arrived for you; the prompt hook shows it below.';

export type Typist = (pid: number, line: string) => Promise<boolean>;

/** Type one line and Enter into the Kimi window that holds pid. False when nothing was typed. */
export const typeIntoKimi: Typist = (pid, line) => new Promise((resolve) => {
  if (process.platform !== 'win32' || !fs.existsSync(TYPIST) || !Number.isInteger(pid) || pid <= 0) return resolve(false);
  execFile(TYPIST, ['kimi', String(pid), Buffer.from(line, 'utf8').toString('base64')],
    { windowsHide: true, timeout: 5000 }, (err) => resolve(!err));
});

let building: Promise<boolean> | undefined;

/** Build the helper when it is missing or older than its source. Never throws; false when unavailable. */
export function ensureTypist(): Promise<boolean> {
  if (process.platform !== 'win32') return Promise.resolve(false);
  try {
    if (fs.existsSync(TYPIST) && (!fs.existsSync(SOURCE) || fs.statSync(TYPIST).mtimeMs >= fs.statSync(SOURCE).mtimeMs)) {
      return Promise.resolve(true);
    }
  } catch { return Promise.resolve(false); }
  building ??= new Promise<boolean>((resolve) => {
    const windir = process.env.WINDIR ?? 'C:\\Windows';
    const csc = ['Framework64', 'Framework'].map((f) => path.join(windir, 'Microsoft.NET', f, 'v4.0.30319', 'csc.exe')).find((p) => fs.existsSync(p));
    if (!csc || !fs.existsSync(SOURCE)) return resolve(false);
    try { fs.mkdirSync(path.dirname(TYPIST), { recursive: true }); } catch { return resolve(false); }
    const tmp = `${TYPIST}.new`;
    execFile(csc, ['-nologo', '-target:winexe', '-optimize', `-out:${tmp}`, SOURCE], { windowsHide: true, timeout: 60_000 }, (err) => {
      if (err) return resolve(false);
      try { fs.renameSync(tmp, TYPIST); resolve(true); } catch { resolve(fs.existsSync(TYPIST)); }
    });
  }).finally(() => { building = undefined; });
  return building;
}
