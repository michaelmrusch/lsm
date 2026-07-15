import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'lsm-space-api-test-'));
process.env.DATA_DIR = dataDir;

const { db } = await import('../server/db.js');
const { app } = await import('../server/index.js');
const { notificationRecipients } = await import('../server/push.js');

const ownerId = Number(db.prepare('INSERT INTO users (username, pin_hash) VALUES (?, ?)').run('Owner', 'hash').lastInsertRowid);
const nextOwnerId = Number(db.prepare('INSERT INTO users (username, pin_hash) VALUES (?, ?)').run('Next owner', 'hash').lastInsertRowid);
const token = 'test-token';
db.prepare('INSERT INTO auth_tokens (token, user_id, expires_at) VALUES (?, ?, unixepoch() + 3600)').run(token, ownerId);
const layout = JSON.stringify([
  { label: 'Window', capacity: 3, x: 0.4375, y: 0.484375, rot: 0 },
  { label: 'Door', capacity: 2, x: 0.53125, y: 0.5, rot: 90 },
]);
const spaceId = Number(db.prepare(`
  INSERT INTO spaces (code, name, owner_id, status, last_layout) VALUES ('ABC234', 'Original', ?, 'idle', ?)
`).run(ownerId, layout).lastInsertRowid);
db.prepare('INSERT INTO space_members (space_id, user_id) VALUES (?, ?)').run(spaceId, ownerId);
db.prepare('INSERT INTO space_members (space_id, user_id) VALUES (?, ?)').run(spaceId, nextOwnerId);

const server = await new Promise((resolve) => {
  const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
});
const address = server.address();
const base = `http://127.0.0.1:${address.port}`;

async function request(path, options = {}) {
  const response = await fetch(base + path, {
    ...options,
    headers: {
      Cookie: `lsm_session=${token}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });
  const body = await response.json();
  return { response, body };
}

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('membership preferences, layout reuse, ownership transfer, and leaving work together', async () => {
  const membership = await request('/api/spaces/ABC234/membership');
  assert.equal(membership.response.status, 200);
  assert.equal(membership.body.archived, false);
  assert.equal(membership.body.notifications.activity, true);

  const dashboardController = new AbortController();
  const dashboardResponse = await fetch(base + '/api/me/events', {
    headers: { Cookie: `lsm_session=${token}` },
    signal: dashboardController.signal,
  });
  assert.equal(dashboardResponse.status, 200);
  const dashboardReader = dashboardResponse.body.getReader();
  const decoder = new TextDecoder();
  const initialEvent = decoder.decode((await dashboardReader.read()).value);
  assert.match(initialEvent, /"ready":true/);
  const nextDashboardEvent = dashboardReader.read();

  const changed = await request('/api/spaces/ABC234/membership', {
    method: 'PATCH',
    body: JSON.stringify({ archived: true, notifications: { activity: false, chat: false } }),
  });
  assert.equal(changed.response.status, 200);
  assert.equal(changed.body.archived, true);
  assert.equal(changed.body.notifications.activity, false);
  assert.equal(changed.body.notifications.chat, false);
  const refreshEvent = decoder.decode((await nextDashboardEvent).value);
  assert.match(refreshEvent, new RegExp(`"spaceId":${spaceId}`));
  dashboardController.abort();
  assert.deepEqual(notificationRecipients(spaceId, [ownerId, nextOwnerId], 'activity'), [nextOwnerId]);
  // Chat push is off now (chat:false), so the owner drops out of chat recipients.
  assert.deepEqual(notificationRecipients(spaceId, [ownerId, nextOwnerId], 'chat'), [nextOwnerId]);
  // The unread badge is a separate chat-window switch — a settings change must
  // NOT create a chat_mutes row.
  assert.ok(!db.prepare('SELECT 1 FROM chat_mutes WHERE space_id = ? AND user_id = ?').get(spaceId, ownerId));

  const opened = await request('/api/spaces/ABC234/sessions', {
    method: 'POST',
    body: JSON.stringify({ reuseLastLayout: true }),
  });
  assert.equal(opened.response.status, 200);
  assert.deepEqual(opened.body.tables.map((table) => ({
    label: table.label,
    capacity: table.capacity,
    x: table.x,
    y: table.y,
    rot: table.rot,
  })), JSON.parse(layout));

  const transferred = await request('/api/spaces/ABC234/settings', {
    method: 'PATCH',
    body: JSON.stringify({ name: 'Renamed', ownerId: nextOwnerId }),
  });
  assert.equal(transferred.response.status, 200);
  assert.equal(transferred.body.space.name, 'Renamed');
  assert.equal(transferred.body.space.ownerId, nextOwnerId);

  const ended = await request('/api/spaces/ABC234', {
    method: 'PATCH',
    body: JSON.stringify({ status: 'idle' }),
  });
  assert.equal(ended.response.status, 200);
  assert.deepEqual(ended.body.space.lastSetup, { tableCount: 2, totalSeats: 5 });

  const left = await request('/api/spaces/ABC234/membership', { method: 'DELETE' });
  assert.equal(left.response.status, 200);
  assert.equal(db.prepare('SELECT 1 FROM space_members WHERE space_id = ? AND user_id = ?').get(spaceId, ownerId), undefined);
});

test('joining a space with a color already in use gets a distinct one', async () => {
  const red = '#ef5563';
  const first = Number(db.prepare("INSERT INTO users (username, pin_hash, color) VALUES ('ColorOne', 'h', ?)").run(red).lastInsertRowid);
  const second = Number(db.prepare("INSERT INTO users (username, pin_hash, color) VALUES ('ColorTwo', 'h', ?)").run(red).lastInsertRowid);
  const third = Number(db.prepare("INSERT INTO users (username, pin_hash, color) VALUES ('ColorThree', 'h', ?)").run('#4f8cff').lastInsertRowid);
  const tok = (id) => { const t = `clr-${id}`; db.prepare('INSERT INTO auth_tokens (token, user_id, expires_at) VALUES (?, ?, unixepoch() + 3600)').run(t, id); return `lsm_session=${t}`; };
  const [c1, c2, c3] = [tok(first), tok(second), tok(third)];
  const sid = Number(db.prepare("INSERT INTO spaces (code, name, owner_id, status) VALUES ('CLR234', 'Colors', ?, 'idle')").run(first).lastInsertRowid);
  db.prepare('INSERT INTO space_members (space_id, user_id) VALUES (?, ?)').run(sid, first); // owner already in, keeps red

  // Third (unique blue) joins BEFORE second, so only red is taken when it
  // arrives and it must keep its blue. Joining second first would let its
  // random reassignment land on blue, and then third would legitimately be
  // moved off it too — a 1-in-9 flake rather than a real failure.
  await fetch(`${base}/api/spaces/CLR234`, { headers: { Cookie: c3 } });
  await fetch(`${base}/api/spaces/CLR234`, { headers: { Cookie: c2 } });
  const state = await (await fetch(`${base}/api/spaces/CLR234`, { headers: { Cookie: c1 } })).json();
  const colors = Object.fromEntries(state.members.map((m) => [m.username, m.color]));

  assert.equal(colors.ColorOne, red);            // first stays put
  assert.equal(colors.ColorThree, '#4f8cff');    // unique color kept
  assert.notEqual(colors.ColorTwo, red);         // collider moved off red
  assert.match(colors.ColorTwo, /^#[0-9a-f]{6}$/i);
  assert.notEqual(colors.ColorTwo, colors.ColorThree);
});
