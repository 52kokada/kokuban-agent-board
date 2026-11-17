// Read-only, streaming activity/size report. Characters are not model tokens or a bill.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';

export async function summarizeUsage(file, { days = 7, now = Date.now() } = {}) {
  if (!Number.isFinite(days) || days <= 0) throw Error('days must be positive');
  const report = { days, since: new Date(now - days * 86400000).toISOString(),
    until: new Date(now).toISOString(), records: 0, malformed: 0, measuredOutputs: 0,
    outputChars: 0, byTool: {}, wakes: { successful: 0, failed: 0, messages: 0, byReason: {} },
    delivery: {}, taskOutcomes: {}, contextOps: {},
    mailOffers: { batches: 0, messages: 0, replayed: 0, explicitAcknowledgements: 0, oversized: 0 },
    note: 'Activity counts and characters only. Background transport is not model usage. Historical records may lack size/reason fields; no cost or savings inferred.' };
  const lines = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let r; try { r = JSON.parse(line); } catch { report.malformed++; continue; }
    if (!Number.isFinite(r?.ts) || r.ts < now - days * 86400000 || r.ts > now) continue;
    report.records++;
    const name = typeof r.tool === 'string' ? r.tool : 'unknown';
    const tool = Object.hasOwn(report.byTool, name) ? report.byTool[name]
      : (Object.defineProperty(report.byTool, name, { value: { calls: 0, measuredOutputs: 0, outputChars: 0, maxOutputChars: 0 }, enumerable: true }), report.byTool[name]);
    tool.calls++;
    if (Number.isFinite(r.outputChars) && r.outputChars >= 0) {
      report.measuredOutputs++; report.outputChars += r.outputChars;
      tool.measuredOutputs++; tool.outputChars += r.outputChars;
      tool.maxOutputChars = Math.max(tool.maxOutputChars, r.outputChars);
    }
    if (name === 'wake') {
      if (r.ok === true) {
        report.wakes.successful++;
        report.wakes.messages += Number.isFinite(r.messages) ? r.messages : Array.isArray(r.mail) ? r.mail.length : 0;
        for (const reason of r.reasons ?? []) if (['person', 'task', 'batch', 'direct'].includes(reason))
          report.wakes.byReason[reason] = (report.wakes.byReason[reason] ?? 0) + 1;
      } else if (r.ok === false) report.wakes.failed++;
    }
    if (name === 'send' && r.ok === true) {
      const mode = ['immediate', 'batch', 'next-step'].includes(r.delivery) ? r.delivery : 'legacy/unknown';
      report.delivery[mode] = (report.delivery[mode] ?? 0) + 1;
    }
    if (name === 'context' && ['discover', 'search', 'read', 'resume', 'checkpoint', 'capabilities'].includes(r.op))
      report.contextOps[r.op] = (report.contextOps[r.op] ?? 0) + 1;
    if (name === 'mail:offer' || name === 'inbox:offer') {
      report.mailOffers.batches++;
      for (const key of ['messages', 'replayed']) if (Number.isSafeInteger(r[key]) && r[key] >= 0) report.mailOffers[key] += r[key];
      if (Number.isSafeInteger(r.acknowledged) && r.acknowledged >= 0) report.mailOffers.explicitAcknowledgements += r.acknowledged;
      if (r.oversized === true) report.mailOffers.oversized++;
    }
    if (name === 'mail:receipt' && Number.isSafeInteger(r.acknowledged) && r.acknowledged >= 0)
      report.mailOffers.explicitAcknowledgements += r.acknowledged;
    if (name === 'task:state' && ['done', 'blocked', 'cancelled'].includes(r.state))
      report.taskOutcomes[r.state] = (report.taskOutcomes[r.state] ?? 0) + 1;
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const days = args[0] === undefined ? 7 : Number(args[0]);
  const file = args[1] ?? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), '.local', 'state'), 'kokuban', 'usage.jsonl');
  console.log(JSON.stringify(await summarizeUsage(file, { days }), null, 2));
}
