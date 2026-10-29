import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'lsm-security-test-'));
process.env.DATA_DIR = dataDir;

const { db } = await import('../server/db.js');
const { app } = await import('../server/index.js');
const { isPushEndpointAllowed } = await import('../server/push.js');

const userId = Number(db.prepare("INSERT INTO users (username, pin_hash) VALUES ('Sec', 'hash')").run().lastInsertRowid);
db.prepare("INSERT INTO auth_tokens (token, user_id, expires_at) VALUES ('sec-token', ?, unixepoch() + 3600)").run(userId);

const server = await new Promise((resolve) => {
  const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
});
const base = `http://127.0.0.1:${server.address().port}`;

after(() => {
  server.close();
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const post = (path, body, headers = {}) =>
  fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    redirect: 'manual',
  });

test('push endpoints are limited to the real browser push services', () => {
  for (const ok of [
    'https://fcm.googleapis.com/fcm/send/abc',
    'https://updates.push.services.mozilla.com/wpush/v2/abc',
    'https://web.push.apple.com/QGx',
    'https://wns2-par02p.notify.windows.com/w/?token=abc',
  ]) assert.equal(isPushEndpointAllowed(ok), true, ok);

  for (const bad of [
    'http://fcm.googleapis.com/fcm/send/abc', // not https
    'https://192.168.1.1/admin', // home network
    'https://127.0.0.1/', // the server itself
    'https://fcm.googleapis.com:8443/x', // odd port
    'https://fcm.googleapis.com.evil.example/x', // suffix trick
    'https://storage.googleapis.com/bucket', // other Google API
    'https://user:pw@fcm.googleapis.com/x', // credentials in URL
    'not a url',
  ]) assert.equal(isPushEndpointAllowed(bad), false, bad);
});

test('subscribing with an internal endpoint is rejected', async () => {
  const res = await post(
    '/api/push/subscribe',
    { subscription: { endpoint: 'http://192.168.1.1/', keys: { p256dh: 'a', auth: 'b' } } },
    { Cookie: 'lsm_session=sec-token' },
  );
  assert.equal(res.status, 400);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get().n, 0);
});

test('bogus invite codes are refused cheaply and then throttled per IP', async () => {
  // Fresh names each time, so only the per-IP limit can stop this.
  for (let i = 0; i < 10; i++) {
    const res = await post('/api/auth/session', { username: `Newbie${i}`, pin: '1234', inviteCode: 'NOPE99' });
    assert.equal(res.status, 403);
  }
  const blocked = await post('/api/auth/session', { username: 'Newbie10', pin: '1234', inviteCode: 'NOPE99' });
  assert.equal(blocked.status, 429);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM users WHERE username LIKE 'Newbie%'").get().n, 0);
});

test('responses carry the hardening headers and no framework banner', async () => {
  const res = await fetch(`${base}/api/push/key`);
  assert.equal(res.headers.get('x-powered-by'), null);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(res.headers.get('strict-transport-security'), null); // plain-HTTP test: no HSTS
});

test('plain HTTP through the proxy is sent to HTTPS; direct access is not', async () => {
  const viaProxy = await fetch(`${base}/s/ABC234`, { headers: { 'X-Forwarded-Proto': 'http' }, redirect: 'manual' });
  assert.equal(viaProxy.status, 301);
  assert.match(viaProxy.headers.get('location'), /^https:\/\/127\.0\.0\.1:\d+\/s\/ABC234$/);

  const loginViaProxy = await post('/api/auth/session', { username: 'Sec', pin: '1234' }, { 'X-Forwarded-Proto': 'http' });
  assert.equal(loginViaProxy.status, 403);

  const secure = await fetch(`${base}/api/push/key`, { headers: { 'X-Forwarded-Proto': 'https' } });
  assert.equal(secure.status, 200);
  assert.match(secure.headers.get('strict-transport-security'), /max-age=\d+/);

  const direct = await fetch(`${base}/api/push/key`, { redirect: 'manual' });
  assert.equal(direct.status, 200);
});
