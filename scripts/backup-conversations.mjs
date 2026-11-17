import path from 'node:path';
import os from 'node:os';
import { backupConversations } from '../dist/src/conversations/backup.js';
const data = path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), '.local', 'state'), 'kokuban');
const [source = path.join(data, 'conversations.sqlite'), output = path.join(data, 'backups', `conversations-${new Date().toISOString().replaceAll(':', '-')}.sqlite`)] = process.argv.slice(2);
try { console.log(JSON.stringify(await backupConversations(source, output), null, 2)); }
catch (error) { console.error(error.message); process.exitCode = 1; }
