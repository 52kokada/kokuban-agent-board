import * as os from 'node:os';
import * as path from 'node:path';

export const PORT = Number(process.env.KOKUBAN_PORT) || 47600;
export const BASE_URL = `http://127.0.0.1:${PORT}`;

export const DATA_DIR = path.join(
  process.env.LOCALAPPDATA ?? path.join(os.homedir(), '.local', 'state'),
  'kokuban',
);
export const BOARD_FILE = path.join(DATA_DIR, 'board.json');
