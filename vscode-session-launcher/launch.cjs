'use strict';
const http = require('node:http'), fs = require('node:fs'), path = require('node:path');
function claim(grant, route = 'claim') {
  if (!/^[a-f0-9]{64}$/.test(grant)) return Promise.reject(Error('起動要求が不正です。'));
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams({ grant }).toString();
    const req = http.request({ hostname: '127.0.0.1', port: 47600, path: '/app/session-launch/' + route, method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } }, res => {
      let size = 0; const chunks = [];
      res.on('data', chunk => { size += chunk.length; if (size > 32768) { res.destroy(Error('起動要求が大きすぎます。')); return; } chunks.push(chunk); });
      res.on('error', reject);
      res.on('end', () => { try { const data = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (res.statusCode !== 200) throw Error(data.error || '起動要求の期限が切れました。'); resolve(data); } catch (error) { reject(error); } });
    });
    req.setTimeout(5000, () => req.destroy(Error('黒板に接続できません。'))); req.on('error', reject); req.end(body);
  });
}
function validate(plan) {
  if (!plan || !['codex','claude','kimi'].includes(plan.host) || plan.target !== 'vscode' ||
    typeof plan.cwd !== 'string' || !path.isAbsolute(plan.cwd) || !fs.statSync(plan.cwd).isDirectory() ||
    typeof plan.encodedCommand !== 'string' || !/^[A-Za-z0-9+/]{4,16000}={0,2}$/.test(plan.encodedCommand)) throw Error('黒板の起動要求が不正です。');
  return plan;
}
function terminalOptions(plan) {
  const modern = path.join(process.env.ProgramFiles || 'C:/Program Files','PowerShell','7','pwsh.exe');
  const shell = fs.existsSync(modern) ? modern : path.join(process.env.SystemRoot || 'C:/Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  return { name: plan.host === 'codex' ? 'Codex' : plan.host === 'claude' ? 'Claude' : 'Kimi', cwd: plan.cwd,
    location: 2, shellPath: shell, shellArgs: ['-NoExit','-EncodedCommand',plan.encodedCommand],
    env: { CODEX_THREAD_ID: null, CODEX_SESSION_ID: null, CLAUDE_SESSION_ID: null, CLAUDECODE: null, KIMI_SESSION_ID: null } };
}
module.exports = { claim, failed: grant => claim(grant, 'failed'), validate, terminalOptions };
