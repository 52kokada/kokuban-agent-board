import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const root = args[args.indexOf('--audio-root') + 1];
const mode = process.env.FAKE_MODE;
let output = Promise.resolve();
if (mode === 'no-ready') setInterval(() => {}, 1000);
else {
  process.stdout.write(JSON.stringify({ type: 'ready', protocol: 1, pid: process.pid }) + '\n');
  if (mode === 'exit-ready') setTimeout(() => process.exit(42), 10);
  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    const job = JSON.parse(line);
    if (job.path?.endsWith('error.wav')) {
      process.stdout.write(JSON.stringify({ type: 'error', id: job.id, code: 'DECODE_FAILED', message: 'Invalid audio.' }) + '\n'); return;
    }
    if (mode === 'crash-once' && !fs.existsSync(path.join(root, 'crashed'))) {
      fs.writeFileSync(path.join(root, 'crashed'), 'yes'); process.exit(42);
    }
    if (job.path?.endsWith('hang.wav')) return;
    const data = job.op === 'stats' ? { completed: 1, resources: {} } : {
      text: job.path?.endsWith('ja.wav') ? 'こんにちは' : 'Hello', language: 'en',
      languageProbability: 0.99, durationSeconds: 30,
      timing: { decodeSeconds: 0.01, transcribeSeconds: 1, totalSeconds: 1.01, cpuSeconds: 2 },
    };
    if (job.path?.endsWith('invalid.wav')) data.durationSeconds = 'wrong';
    setTimeout(() => {
      const value = JSON.stringify({ type: 'result', id: job.id, data }) + '\n';
      // Exercise a JSON line split across stream chunks, including UTF-8.
      const bytes = Buffer.from(value), middle = Math.floor(bytes.length / 2);
      output = output.then(() => new Promise((resolve) => {
        process.stdout.write(bytes.subarray(0, middle));
        setImmediate(() => { process.stdout.write(bytes.subarray(middle)); resolve(); });
      }));
    }, Number(process.env.FAKE_DELAY ?? 5));
  });
}
