/**
 * Kokuban for Windows (app-windows/), delivered board to board as kokuban delivers its own code
 * (update.ts), with no store and no download site:
 *
 *   the feed     each board keeps the app's Velopack releases in DATA_DIR/app-releases and serves
 *                them to this PC's app at /app/releases/<file> (local programs only); the app's own
 *                updater checks there and applies a newer version while nothing of it is on screen
 *   publishing   app-windows/build.ps1 -Pack writes a new version into this PC's feed
 *   giving       /peer op "app" says what there is (version, files, sizes, SHA-256); op "app_chunk"
 *                hands over 8 MB of one file at a time, so a dropped connection resumes where it was
 *   getting      `kokuban update`, or Install on an update card. A PC with the app gets the newest
 *                package into its feed, for the app's updater; a PC without it gets Setup.exe only and
 *                runs it (silent, for this user). Nothing is kept or run before its hash checks out.
 */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DATA_DIR } from './config.js';

export const APP_FEED = path.join(DATA_DIR, 'app-releases');
const INDEX = 'releases.win.json';
/**
 * The app's Velopack package id, which is also the folder it installs to: %LOCALAPPDATA%\<id>. Never
 * "Kokuban": Windows paths ignore case, so that is the board's own data folder (DATA_DIR), which
 * Setup would move aside and an uninstall would delete (found installing 0.1.0, 2026-10-16).
 */
export const APP_ID = 'KokubanApp';
export const SETUP = `${APP_ID}-win-Setup.exe`;
export const CHUNK = 8 * 1024 * 1024;
const LOCAL = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
/** Where Velopack installs a package of this id for this user. */
export const installDir = (id: string): string => path.join(LOCAL, id);
/** Where the app runs when it is installed. */
export const APP_EXE = path.join(installDir(APP_ID), 'current', 'Kokuban.exe');

/** Whether installing a package of this id would land in, or over, the board's data. */
export function collides(id: string, data = DATA_DIR): boolean {
  const dir = path.resolve(installDir(id)).toLowerCase() + path.sep;
  const keep = path.resolve(data).toLowerCase() + path.sep;
  return !/^[\w.-]{1,64}$/.test(id) || dir === keep || keep.startsWith(dir) || dir.startsWith(keep);
}

export interface AppAsset { PackageId: string; Version: string; Type: string; FileName: string; SHA1?: string; SHA256?: string; Size: number }
export interface AppFile { name: string; size: number; sha256: string }

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const safe = (name: string): boolean => /^[\w.+-]{1,120}$/.test(name) && !name.startsWith('.');
const sha256 = (file: string): string => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** Compare dotted versions ("0.2.10" > "0.2.9"); a pre-release tag counts as older than none. */
export function newer(a: string, b: string): boolean {
  const parse = (v: string): number[] => v.split(/[-+]/)[0]!.split('.').map((n) => Number(n) || 0);
  const x = parse(a), y = parse(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}

function readIndex(feed: string): AppAsset[] {
  try {
    const assets = (JSON.parse(fs.readFileSync(path.join(feed, INDEX), 'utf8')) as { Assets?: AppAsset[] }).Assets;
    return Array.isArray(assets) ? assets.filter((a) => a && typeof a.Version === 'string' && typeof a.FileName === 'string') : [];
  } catch {
    return [];
  }
}

/** The newest full package in a feed, if its file is there. */
export function newestApp(feed = APP_FEED): AppAsset | null {
  const full = readIndex(feed).filter((a) => a.Type === 'Full' && safe(a.FileName) && fs.existsSync(path.join(feed, a.FileName)));
  return full.sort((a, b) => (newer(a.Version, b.Version) ? -1 : newer(b.Version, a.Version) ? 1 : 0))[0] ?? null;
}

/** The version installed here, from what Velopack keeps beside the app (sq.version); '' when none. */
export function installedVersion(exe = APP_EXE): string {
  try {
    return /<version>([^<]+)<\/version>/.exec(fs.readFileSync(path.join(path.dirname(exe), 'sq.version'), 'utf8'))?.[1]?.trim() ?? '';
  } catch {
    return '';
  }
}

/** The newer of what this PC runs and what its feed holds. */
function haveHere(feed: string, exe: string): string {
  const fed = newestApp(feed)?.Version ?? '';
  const run = fs.existsSync(exe) ? installedVersion(exe) : '';
  return newer(run, fed) ? run : fed;
}

/**
 * What `hello` tells other PCs: the newest app version this PC has (run or held), whether it runs
 * here, and the version it can give (its feed's; '' when it has only installed the app).
 */
export function appHello(feed = APP_FEED, exe = APP_EXE): { version: string; installed: boolean; gives: string } | null {
  const version = haveHere(feed, exe);
  const gives = newestApp(feed)?.Version ?? '';
  return version || fs.existsSync(exe) ? { version, installed: fs.existsSync(exe), gives } : null;
}

/** /app/releases/<file>: one file of the feed, for this PC's app. Null when there is no such file. */
export function feedFile(name: string, feed = APP_FEED): Buffer | null {
  if (!safe(name)) return null;
  const file = path.join(feed, name);
  return fs.existsSync(file) ? fs.readFileSync(file) : null;
}

/**
 * /peer op "app": what this PC can give. The newest package for a PC that has the app (only when it
 * lacks it), or Setup.exe alone for one that does not; each with its size and SHA-256.
 */
export function appAsked(input: Record<string, unknown>, feed = APP_FEED): { status: number; body: object } {
  const asset = newestApp(feed);
  if (!asset) return { status: 404, body: { ok: false, error: 'the Windows app is not published on this PC' } };
  const have = str(input.have);
  if (input.setup !== true && have && !newer(asset.Version, have)) return { status: 200, body: { ok: true, version: asset.Version, same: true } };
  let files: AppFile[];
  if (input.setup === true) {
    const setup = path.join(feed, SETUP);
    if (!fs.existsSync(setup)) return { status: 404, body: { ok: false, error: 'no Setup.exe in this PC\'s feed' } };
    files = [{ name: SETUP, size: fs.statSync(setup).size, sha256: sha256(setup) }];
  } else {
    if (!/^[0-9a-f]{64}$/i.test(str(asset.SHA256))) return { status: 500, body: { ok: false, error: 'the package has no SHA-256 in the feed' } };
    files = [{ name: asset.FileName, size: asset.Size, sha256: asset.SHA256!.toLowerCase() }];
  }
  return { status: 200, body: { ok: true, version: asset.Version, asset, files } };
}

/** /peer op "app_chunk": up to 8 MB of one of the files op "app" named, from an offset. */
export function appChunk(input: Record<string, unknown>, feed = APP_FEED): { status: number; body: object } {
  const name = str(input.file);
  const asset = newestApp(feed);
  if (!asset || (name !== asset.FileName && name !== SETUP) || !safe(name)) return { status: 404, body: { ok: false, error: 'no such file' } };
  const file = path.join(feed, name);
  if (!fs.existsSync(file)) return { status: 404, body: { ok: false, error: 'no such file' } };
  const offset = Math.max(0, Math.floor(Number(input.offset) || 0));
  const size = fs.statSync(file).size;
  const length = Math.min(CHUNK, Math.max(0, size - offset));
  const data = Buffer.alloc(length);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, data, 0, length, offset);
  } finally {
    fs.closeSync(fd);
  }
  return { status: 200, body: { ok: true, offset, size, data: data.toString('base64') } };
}

/**
 * Fetch one file in chunks into the feed. A partial file from an earlier try is carried on from
 * where it stopped. Only a file of the right size and SHA-256 takes its name; anything else is removed.
 */
export async function fetchFile(meta: AppFile, chunk: (offset: number) => Promise<Buffer>, feed = APP_FEED): Promise<string> {
  if (!safe(meta.name) || !/^[0-9a-f]{64}$/i.test(meta.sha256) || !Number.isInteger(meta.size) || meta.size <= 0) throw new Error('the file came without a usable description');
  fs.mkdirSync(feed, { recursive: true });
  const part = path.join(feed, `${meta.name}.part`);
  let have = fs.existsSync(part) ? fs.statSync(part).size : 0;
  if (have > meta.size) {
    fs.rmSync(part, { force: true });
    have = 0;
  }
  while (have < meta.size) {
    const data = await chunk(have);
    if (!data.length) throw new Error(`${meta.name} stopped at ${have} of ${meta.size} bytes`);
    fs.appendFileSync(part, data);
    have += data.length;
  }
  if (have !== meta.size || sha256(part) !== meta.sha256.toLowerCase()) {
    fs.rmSync(part, { force: true });
    throw new Error(`${meta.name} arrived damaged (its size or SHA-256 does not match); removed`);
  }
  const done = path.join(feed, meta.name);
  fs.renameSync(part, done);
  return done;
}

/** List a package fetched into the feed in the feed's index, so this PC's app sees it. */
export function listApp(asset: AppAsset, feed = APP_FEED): void {
  if (!safe(str(asset.FileName)) || !/^\d+\.\d+\.\d+/.test(str(asset.Version)) || asset.Type !== 'Full') throw new Error('the package came without a usable description');
  const assets = readIndex(feed).filter((a) => a.FileName !== asset.FileName);
  assets.push({ PackageId: asset.PackageId, Version: asset.Version, Type: asset.Type, FileName: asset.FileName, SHA1: asset.SHA1, SHA256: asset.SHA256, Size: asset.Size });
  fs.writeFileSync(path.join(feed, INDEX), JSON.stringify({ Assets: assets }, null, 2));
}

/**
 * Install the app on this PC from a checked Setup.exe: silent, for this user, no elevation. Refused
 * when its package would install into the board's data folder.
 */
export function installApp(setup: string, packageId: string): Promise<string> {
  if (collides(packageId)) return Promise.resolve(`refused: package "${packageId}" would install into the board's own data folder`);
  if (!fs.existsSync(setup)) return Promise.resolve('no Setup.exe came with it');
  return new Promise((resolve) => {
    // A window program: no console opens, hidden or not.
    execFile(setup, ['--silent'], { windowsHide: true, timeout: 300_000 }, (err) =>
      resolve(err ? `Setup.exe failed (${err.message.slice(0, 160)})` : 'installed; it starts at sign-in and is in the Start menu'));
  });
}
