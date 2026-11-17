import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Script } from 'node:vm';
import { PhoneConfig, token } from '../src/phone/settings.js';
import { PhonePairing } from '../src/phone/pairing.js';
import { pairingClient } from '../src/phone/pairing-client.js';
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kokuban-qr-')); const config = new PhoneConfig(path.join(root, 'settings.json')); let now = 1000000, changes = 0;
  config.edit(p => { p.enabled = true; p.owner = 'owner'; p.origin = 'https://pc.test'; p.secret = token(); p.adminSecret = token(); });
  const pairing = new PhonePairing(config, () => { changes++; }, () => now);
  const phone = { login: 'owner', node: 'iphone.test' };
  return { config, pairing, phone, advance: (ms: number) => { now += ms; }, changes: () => changes, close: () => { config.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}
const nonceOf = (v: { url?: string }) => new URLSearchParams(new URL(v.url!).hash.slice(1)).get('pair')!;
test('QR scan and install use different proofs, bind one phone and store only hashes', async () => {
  const f = fixture(); try {
    const created = await f.pairing.create(randomUUID()); const nonce = nonceOf(created);
    assert.ok(created.qr?.startsWith('data:image/png;base64,')); assert.equal(created.setup.stage, 'offered');
    const claimed = f.pairing.claim(nonce, 'Test iPhone', f.phone); assert.notEqual(claimed.handoff, nonce); assert.equal(claimed.setup.stage, 'claimed');
    assert.throws(() => f.pairing.claim(nonce, 'Other phone', { login: 'owner', node: 'other.test' }), /another device/);
    const retry = f.pairing.claim(nonce, 'Test iPhone', f.phone); assert.equal(retry.handoff, claimed.handoff);
    const manifest = f.pairing.manifest(claimed.handoff, f.phone); assert.equal(manifest.id, '/phone/'); assert.ok(manifest.start_url.includes('#handoff='));
    assert.equal(f.config.read().devices.length, 0); // Scan or manifest GET is not an installed app.
    const opened = f.pairing.redeem(claimed.handoff, f.phone); assert.equal(opened.setup.stage, 'appOpened');
    assert.equal(f.pairing.redeem(claimed.handoff, f.phone).token, opened.token); assert.equal(f.config.read().devices.length, 1);
    f.pairing.complete(opened.setup.deviceId!, true); assert.equal(f.pairing.list()[0].stage, 'done');
    const json = fs.readFileSync(f.config.file, 'utf8'); for (const secret of [nonce, claimed.handoff, opened.token]) assert.equal(json.includes(secret), false);
    assert.ok(f.changes() >= 4);
  } finally { f.close(); }
});
test('cancellation, refresh, expiration and revocation make QR/handoff replay useless', async () => {
  const f = fixture(); try {
    const id = randomUUID(), first = await f.pairing.create(id), second = await f.pairing.create(id);
    assert.throws(() => f.pairing.claim(nonceOf(first), 'Old QR', f.phone), /cancelled/);
    const claimed = f.pairing.claim(nonceOf(second), 'Current', f.phone); f.pairing.cancel(id);
    assert.throws(() => f.pairing.redeem(claimed.handoff, f.phone), /cancelled/);
    const fresh = await f.pairing.create(randomUUID()); const claim = f.pairing.claim(nonceOf(fresh), 'Fresh', f.phone);
    const opened = f.pairing.redeem(claim.handoff, f.phone); f.advance(300001);
    assert.throws(() => f.pairing.redeem(claim.handoff, f.phone), /expired/); // Even a spent installed start URL cannot re-auth forever.
    assert.equal(f.config.read().devices.length, 1);
    f.config.edit(p => { p.devices.find(d => d.id === opened.setup.deviceId)!.revoked = 1; });
    assert.throws(() => f.pairing.state(claim.handoff, f.phone), /removed/);
    new Script(pairingClient);
  } finally { f.close(); }
});
