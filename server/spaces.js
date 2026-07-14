import { Router } from 'express';
import crypto from 'node:crypto';
import { db, gridPositions, tablePlacement, findFreeSpot, placementsOverlap, GRID_CELL, CELLS } from './db.js';
import { requireAuth } from './auth.js';
import { subscribe, broadcast } from './events.js';
import { colorFor } from './colors.js';
import { notifySpaceUsers } from './push.js';
import { votesRouter, votesForState, clearVotes } from './votes.js';
import { timersRouter, timerForState, clearTimers } from './timers.js';
import { chatRouter, chatForState, clearChat } from './chat.js';
import { zurichDate } from './dates.js';
import { layoutSummary, parseLayout, snapshotLayout } from './layouts.js';

export const spacesRouter = Router();
spacesRouter.use(requireAuth);
spacesRouter.use('/:code/votes', votesRouter);
spacesRouter.use('/:code/timers', timersRouter);
spacesRouter.use('/:code/chat', chatRouter);

// No 0/O/1/I/L to keep codes easy to read out loud.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function newCode() {
  let code = '';
  for (let i = 0; i < 6; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return code;
}

function getSpaceRow(code) {
  return db.prepare('SELECT * FROM spaces WHERE code = ?').get(String(code).toUpperCase());
}

function addMember(spaceId, userId) {
  db.prepare('INSERT OR IGNORE INTO space_members (space_id, user_id) VALUES (?, ?)').run(spaceId, userId);
}

function addParticipant(spaceId, userId) {
  db.prepare('INSERT OR IGNORE INTO session_participants (space_id, user_id) VALUES (?, ?)').run(spaceId, userId);
}

function tomorrowPledges(spaceId) {
  return db.prepare(`
    SELECT ts.user_id, u.username, u.color FROM tomorrow_signups ts
    JOIN users u ON u.id = ts.user_id
    WHERE ts.space_id = ? AND ts.for_date >= ?
    ORDER BY ts.created_at, ts.user_id
  `).all(spaceId, zurichDate()).map((r) => ({
    userId: r.user_id,
    username: r.username,
    color: colorFor({ id: r.user_id, color: r.color }),
  }));
}

// The session opener, the group owner and admins manage the session
// and other people's seats.
function canManageSpace(space, user) {
  return space.owner_id === user.id || space.opened_by === user.id || !!user.is_admin;
}

function getClaims(spaceId) {
  return db.prepare(`
    SELECT c.*, u.username, u.color AS user_color FROM claims c
    JOIN users u ON u.id = c.user_id
    JOIN tables t ON t.id = c.table_id
    WHERE t.space_id = ?
    ORDER BY c.created_at, c.id
  `).all(spaceId);
}

export function getSpaceState(code) {
  const space = db.prepare(`
    SELECT s.*, o.username AS owner_name, op.username AS opened_by_name
    FROM spaces s
    JOIN users o ON o.id = s.owner_id
    LEFT JOIN users op ON op.id = s.opened_by
    WHERE s.code = ?
  `).get(String(code).toUpperCase());
  if (!space) return null;

  const tables = db.prepare('SELECT * FROM tables WHERE space_id = ? ORDER BY id').all(space.id);
  const claims = getClaims(space.id);

  return {
    space: {
      code: space.code,
      name: space.name,
      ownerId: space.owner_id,
      ownerName: space.owner_name,
      status: space.status,
      openedBy: space.opened_by,
      openedByName: space.opened_by_name,
      openedAt: space.opened_at,
      lastSetup: layoutSummary(space.last_layout),
      createdAt: space.created_at,
    },
    tables: tables.map((t) => ({
      id: t.id,
      label: t.label,
      released: !!t.released,
      stolen: !!t.stolen,
      capacity: t.capacity,
      x: t.x,
      y: t.y,
      rot: t.rot,
      claims: claims
        .filter((c) => c.table_id === t.id)
        .map((c) => ({
          id: c.id,
          userId: c.user_id,
          username: c.username,
          color: colorFor({ id: c.user_id, color: c.user_color }),
          guestName: c.guest_name,
          seat: c.seat,
          eta: c.eta,
          status: c.status,
          arrivedAt: c.arrived_at,
        })),
    })),
    members: db.prepare(`
      SELECT u.id, u.username, u.color FROM space_members m
      JOIN users u ON u.id = m.user_id
      WHERE m.space_id = ?
      ORDER BY u.username COLLATE NOCASE
    `).all(space.id).map((u) => ({
      userId: u.id,
      username: u.username,
      color: colorFor({ id: u.id, color: u.color }),
    })),
    tomorrow: tomorrowPledges(space.id),
    votes: votesForState(space.id),
    timer: timerForState(space.id),
    chat: chatForState(space.id),
  };
}

export function listUserSpaces(userId) {
  const rows = db.prepare(`
    SELECT s.*, m.archived, o.username AS owner_name, op.username AS opened_by_name,
      (SELECT COALESCE(SUM(t.capacity), 0) FROM tables t
        WHERE t.space_id = s.id AND t.released = 0) AS seats,
      (SELECT COUNT(*) FROM claims c JOIN tables t ON t.id = c.table_id
        WHERE t.space_id = s.id AND t.released = 0) AS people
    FROM space_members m
    JOIN spaces s ON s.id = m.space_id
    JOIN users o ON o.id = s.owner_id
    LEFT JOIN users op ON op.id = s.opened_by
    WHERE m.user_id = ?
    ORDER BY (s.status = 'open') DESC, m.joined_at DESC
  `).all(userId);
  return rows.map((s) => ({
    code: s.code,
    name: s.name,
    status: s.status,
    ownerName: s.owner_name,
    openedByName: s.opened_by_name,
    totalSeats: s.seats,
    peopleCount: s.people,
    freeSeats: Math.max(0, s.seats - s.people),
    archived: !!s.archived,
  }));
}

// Which compartment a newcomer gets: the tapped one if it is free,
// otherwise the first free one.
function pickSeat(tableId, capacity, requested) {
  const taken = new Set(db.prepare('SELECT seat FROM claims WHERE table_id = ?').all(tableId).map((r) => r.seat));
  if (Number.isInteger(requested) && requested >= 0 && requested < capacity && !taken.has(requested)) return requested;
  for (let i = 0; i < capacity; i++) if (!taken.has(i)) return i;
  return null;
}

function normalizeEta(value) {
  const eta = String(value ?? '').trim().toLowerCase();
  if (eta === 'now') return 'now';
  const m = /^(\d{1,2}):(\d{2})$/.exec(eta);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

function requireSpace(req, res) {
  const space = getSpaceRow(req.params.code);
  if (!space) {
    res.status(404).json({ error: 'Space not found.' });
    return null;
  }
  return space;
}

function requireOpenSpace(req, res) {
  const space = requireSpace(req, res);
  if (!space) return null;
  if (space.status !== 'open') {
    res.status(409).json({ error: 'No active session right now.' });
    return null;
  }
  return space;
}

function sendUpdate(space, res) {
  const state = getSpaceState(space.code);
  broadcast(space.id, state, true);
  res.json(state);
}

function memberIds(spaceId) {
  return db.prepare('SELECT user_id AS id FROM space_members WHERE space_id = ?').all(spaceId).map((r) => r.id);
}

// Everyone actively involved today: people with a claim, plus opener and owner.
function participantIds(space) {
  const ids = new Set(getClaims(space.id).map((c) => c.user_id));
  ids.add(space.owner_id);
  if (space.opened_by) ids.add(space.opened_by);
  return [...ids];
}

function notify(space, recipientIds, actorId, body, category = 'activity') {
  notifySpaceUsers(space.id, recipientIds.filter((id) => id !== actorId), category, {
    title: space.name,
    body,
    url: `/s/${space.code}`,
    tag: `lsm-${space.code}`,
  });
}

function createTables(spaceId, tableCount, capacity) {
  const insertTable = db.prepare('INSERT INTO tables (space_id, label, capacity, x, y, rot) VALUES (?, ?, ?, ?, ?, ?)');
  const positions = gridPositions(tableCount);
  for (let i = 0; i < tableCount; i++) {
    insertTable.run(spaceId, `T${i + 1}`, capacity, positions[i].x, positions[i].y, positions[i].rot);
  }
}

function createTablesFromLayout(spaceId, layout) {
  const insert = db.prepare('INSERT INTO tables (space_id, label, capacity, x, y, rot) VALUES (?, ?, ?, ?, ?, ?)');
  for (const table of layout) insert.run(spaceId, table.label, table.capacity, table.x, table.y, table.rot);
}

function membershipState(spaceId, userId) {
  const row = db.prepare(`
    SELECT archived, notify_setup, notify_activity, notify_votes, notify_timers, notify_chat
    FROM space_members WHERE space_id = ? AND user_id = ?
  `).get(spaceId, userId);
  if (!row) return null;
  return {
    archived: !!row.archived,
    notifications: {
      setup: !!row.notify_setup,
      activity: !!row.notify_activity,
      votes: !!row.notify_votes,
      timers: !!row.notify_timers,
      chat: !!row.notify_chat,
    },
  };
}

const placementCenter = (p) => ({ x: (p.leftCell + p.wc / 2) * GRID_CELL, y: (p.topCell + p.hc / 2) * GRID_CELL });

// Where the next table goes, without moving anybody who is already placed
// (people are sitting there — the block only ever grows to the right, as if
// the left side were a wall). If exactly one table stands rotated (the odd
// one out), it flips in place into a horizontal and the newcomer completes
// the stacked pair below it; otherwise the newcomer stands rotated at the
// right edge of the block. Returns what to do, or null if the room is full.
function nextTableSpot(tables) {
  if (tables.length === 0) {
    const [p] = gridPositions(1);
    return { flip: null, ...p };
  }
  const placed = tables.map((t) => ({ t, p: tablePlacement(t.x, t.y, t.rot) }));
  const verticals = placed.filter(({ t }) => t.rot === 90);
  if (verticals.length === 1) {
    const v = verticals[0];
    const flipped = { leftCell: v.p.leftCell, topCell: v.p.topCell, wc: 2, hc: 1 };
    const below = { leftCell: v.p.leftCell, topCell: v.p.topCell + 1, wc: 2, hc: 1 };
    const others = placed.filter(({ t }) => t.id !== v.t.id).map(({ p }) => p);
    const fits =
      flipped.leftCell + 2 <= CELLS &&
      below.topCell + 1 <= CELLS &&
      !others.some((o) => placementsOverlap(flipped, o) || placementsOverlap(below, o));
    if (fits) {
      return {
        flip: { id: v.t.id, ...placementCenter(flipped) },
        ...placementCenter(below),
        rot: 0,
      };
    }
    // no room to flip (someone rearranged things) — fall through and append
  }
  // a fresh rotated table at the right edge, aligned with the top of the block
  const all = placed.map(({ p }) => p);
  const cand = {
    leftCell: Math.max(...all.map((p) => p.leftCell + p.wc)),
    topCell: Math.min(CELLS - 2, Math.min(...all.map((p) => p.topCell))),
    wc: 1,
    hc: 2,
  };
  while (cand.leftCell + 1 <= CELLS && all.some((o) => placementsOverlap(cand, o))) cand.leftCell += 1;
  if (cand.leftCell + 1 > CELLS) return null;
  return { flip: null, ...placementCenter(cand), rot: 90 };
}

function validateSessionParams(req, res) {
  const tableCount = Number(req.body?.tableCount);
  const defaultCapacity = req.body?.defaultCapacity === undefined ? 1 : Number(req.body?.defaultCapacity);
  if (!Number.isInteger(tableCount) || tableCount < 1 || tableCount > 20) {
    res.status(400).json({ error: 'Number of tables must be between 1 and 20.' });
    return null;
  }
  if (!Number.isInteger(defaultCapacity) || defaultCapacity < 1 || defaultCapacity > 8) {
    res.status(400).json({ error: 'Seats per table must be between 1 and 8.' });
    return null;
  }
  return { tableCount, defaultCapacity };
}

// Create a study group and open its first session.
spacesRouter.post('/', (req, res) => {
  const name = String(req.body?.name ?? '').trim();
  if (!name || name.length > 60) return res.status(400).json({ error: 'Give the space a name (max 60 characters).' });
  const params = validateSessionParams(req, res);
  if (!params) return;

  const create = db.transaction(() => {
    let code = newCode();
    while (getSpaceRow(code)) code = newCode();
    const info = db
      .prepare("INSERT INTO spaces (code, name, owner_id, status, opened_by, opened_at) VALUES (?, ?, ?, 'open', ?, unixepoch())")
      .run(code, name, req.user.id, req.user.id);
    addMember(info.lastInsertRowid, req.user.id);
    addParticipant(info.lastInsertRowid, req.user.id);
    createTables(info.lastInsertRowid, params.tableCount, params.defaultCapacity);
    return code;
  });
  res.json({ code: create() });
});

// Viewing a space makes you a member of the group (you had the code/link),
// so from then on it shows up on your home screen and can notify you.
spacesRouter.get('/:code', (req, res) => {
  const space = requireSpace(req, res);
  if (!space) return;
  addMember(space.id, req.user.id);
  res.json(getSpaceState(space.code));
});

spacesRouter.get('/:code/events', (req, res) => {
  const space = requireSpace(req, res);
  if (!space) return;
  addMember(space.id, req.user.id);
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write(`data: ${JSON.stringify(getSpaceState(space.code))}\n\n`);
  const unsubscribe = subscribe(space.id, res);
  req.on('close', unsubscribe);
});

spacesRouter.get('/:code/membership', (req, res) => {
  const space = requireSpace(req, res);
  if (!space) return;
  addMember(space.id, req.user.id);
  res.json(membershipState(space.id, req.user.id));
});

spacesRouter.patch('/:code/membership', (req, res) => {
  const space = requireSpace(req, res);
  if (!space) return;
  addMember(space.id, req.user.id);
  const updates = {};
  if (req.body?.archived !== undefined) {
    if (typeof req.body.archived !== 'boolean') return res.status(400).json({ error: 'archived must be true or false.' });
    updates.archived = req.body.archived ? 1 : 0;
  }
  const notifications = req.body?.notifications;
  if (notifications !== undefined) {
    if (!notifications || typeof notifications !== 'object' || Array.isArray(notifications)) {
      return res.status(400).json({ error: 'Invalid notification settings.' });
    }
    for (const category of ['setup', 'activity', 'votes', 'timers', 'chat']) {
      if (notifications[category] === undefined) continue;
      if (typeof notifications[category] !== 'boolean') {
        return res.status(400).json({ error: `${category} must be true or false.` });
      }
      updates[`notify_${category}`] = notifications[category] ? 1 : 0;
    }
  }
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'Nothing to change.' });
  // Notifications here (including notify_chat) only control push. The unread
  // badge is a separate switch, toggled from the chat window, so settings must
  // not touch chat_mutes.
  const sql = Object.keys(updates).map((key) => `${key} = ?`).join(', ');
  db.prepare(`UPDATE space_members SET ${sql} WHERE space_id = ? AND user_id = ?`)
    .run(...Object.values(updates), space.id, req.user.id);
  broadcast(space.id, getSpaceState(space.code), true);
  res.json(membershipState(space.id, req.user.id));
});

spacesRouter.delete('/:code/membership', (req, res) => {
  const space = requireSpace(req, res);
  if (!space) return;
  if (space.owner_id === req.user.id) {
    return res.status(409).json({ error: 'Transfer ownership or delete the space before leaving it.' });
  }
  if (space.status === 'open' && space.opened_by === req.user.id) {
    return res.status(409).json({ error: 'End the session before leaving the space you set up.' });
  }
  const seated = db.prepare(`
    SELECT 1 FROM claims c JOIN tables t ON t.id = c.table_id
    WHERE t.space_id = ? AND c.user_id = ? LIMIT 1
  `).get(space.id, req.user.id);
  if (seated) return res.status(409).json({ error: 'Leave your seat before leaving this space.' });
  db.transaction(() => {
    db.prepare('DELETE FROM tomorrow_signups WHERE space_id = ? AND user_id = ?').run(space.id, req.user.id);
    db.prepare('DELETE FROM session_participants WHERE space_id = ? AND user_id = ?').run(space.id, req.user.id);
    db.prepare('DELETE FROM chat_mutes WHERE space_id = ? AND user_id = ?').run(space.id, req.user.id);
    db.prepare('DELETE FROM space_members WHERE space_id = ? AND user_id = ?').run(space.id, req.user.id);
  })();
  broadcast(space.id, getSpaceState(space.code), true);
  res.json({ ok: true });
});

spacesRouter.patch('/:code/settings', (req, res) => {
  const space = requireSpace(req, res);
  if (!space) return;
  if (space.owner_id !== req.user.id && !req.user.is_admin) {
    return res.status(403).json({ error: 'Only the group owner can change these settings.' });
  }
  const updates = {};
  if (req.body?.name !== undefined) {
    const name = String(req.body.name).trim();
    if (!name || name.length > 60) return res.status(400).json({ error: 'Give the space a name (max 60 characters).' });
    updates.name = name;
  }
  if (req.body?.ownerId !== undefined) {
    const ownerId = Number(req.body.ownerId);
    if (!Number.isInteger(ownerId)) return res.status(400).json({ error: 'Invalid owner.' });
    const member = db.prepare('SELECT 1 FROM space_members WHERE space_id = ? AND user_id = ?').get(space.id, ownerId);
    if (!member) return res.status(400).json({ error: 'The new owner must already be a member of this space.' });
    updates.owner_id = ownerId;
  }
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'Nothing to change.' });
  const sql = Object.keys(updates).map((key) => `${key} = ?`).join(', ');
  db.prepare(`UPDATE spaces SET ${sql} WHERE id = ?`).run(...Object.values(updates), space.id);
  const state = getSpaceState(space.code);
  broadcast(space.id, state, true);
  res.json(state);
});

// Open today's session: the first person to arrive sets up the tables.
// This is the notification the whole group gets in the morning.
spacesRouter.post('/:code/sessions', (req, res) => {
  const space = requireSpace(req, res);
  if (!space) return;
  if (space.status === 'open') return res.status(409).json({ error: 'The space is already set up.' });
  const reuseLastLayout = req.body?.reuseLastLayout === true;
  const layout = reuseLastLayout ? parseLayout(space.last_layout) : [];
  if (reuseLastLayout && layout.length === 0) return res.status(409).json({ error: 'There is no previous setup to reuse yet.' });
  const params = reuseLastLayout ? null : validateSessionParams(req, res);
  if (!reuseLastLayout && !params) return;

  db.transaction(() => {
    db.prepare('DELETE FROM tables WHERE space_id = ?').run(space.id);
    // Yesterday's pledges are answered by this session starting; a fresh
    // participant list starts collecting for tonight's reminder.
    db.prepare('DELETE FROM tomorrow_signups WHERE space_id = ?').run(space.id);
    db.prepare('DELETE FROM session_participants WHERE space_id = ?').run(space.id);
    db.prepare("UPDATE spaces SET status = 'open', opened_by = ?, opened_at = unixepoch() WHERE id = ?")
      .run(req.user.id, space.id);
    addParticipant(space.id, req.user.id);
    if (reuseLastLayout) createTablesFromLayout(space.id, layout);
    else createTables(space.id, params.tableCount, params.defaultCapacity);
    clearVotes(space.id);
    clearTimers(space.id);
    clearChat(space.id);
  })();
  const tableCount = reuseLastLayout ? layout.length : params.tableCount;
  const totalSeats = reuseLastLayout ? layout.reduce((sum, table) => sum + table.capacity, 0) : params.tableCount * params.defaultCapacity;
  notify(space, memberIds(space.id), req.user.id,
    `${req.user.username} set up the space — ${tableCount} ${tableCount === 1 ? 'table' : 'tables'}, ${totalSeats} seats. Who's coming?`, 'setup');
  sendUpdate(space, res);
});

// Wind a session down: wipe the furniture, return everyone who took part
// at some point today (not just whoever still holds a seat) so they can be
// invited to pledge for tomorrow.
function endSession(space) {
  const ids = new Set(
    db.prepare('SELECT user_id FROM session_participants WHERE space_id = ?').all(space.id).map((r) => r.user_id),
  );
  for (const id of participantIds(space)) ids.add(id);
  const lastLayout = snapshotLayout(db.prepare('SELECT * FROM tables WHERE space_id = ? ORDER BY id').all(space.id));
  db.transaction(() => {
    db.prepare('DELETE FROM tables WHERE space_id = ?').run(space.id);
    db.prepare('DELETE FROM session_participants WHERE space_id = ?').run(space.id);
    clearVotes(space.id);
    clearTimers(space.id);
    clearChat(space.id);
    db.prepare("UPDATE spaces SET status = 'idle', opened_by = NULL, opened_at = NULL, last_layout = COALESCE(?, last_layout) WHERE id = ?")
      .run(lastLayout, space.id);
  })();
  return [...ids];
}

// End today's session: wipe tables and claims, keep the group and its code.
// Once every seat is empty anyone may end it — the last person to leave
// gets prompted to switch off the lights.
spacesRouter.patch('/:code', (req, res) => {
  const space = requireOpenSpace(req, res);
  if (!space) return;
  const seated = db.prepare(`
    SELECT COUNT(*) AS n FROM claims c JOIN tables t ON t.id = c.table_id WHERE t.space_id = ?
  `).get(space.id).n;
  if (seated > 0 && !canManageSpace(space, req.user)) {
    return res.status(403).json({ error: 'Only the person who set up the space (or the group owner) can do that.' });
  }
  if (req.body?.status !== 'idle') return res.status(400).json({ error: 'Only ending the session is supported.' });
  const participants = endSession(space);
  notify(space, participants, req.user.id,
    `${req.user.username} ended today's session. Coming back tomorrow? Tap to sign up 🙋`, 'setup');
  sendUpdate(space, res);
});

// Pledge to come back tomorrow — pure intent, no arrival time. The first
// person there the next morning sees the head count and knows what table
// size to reserve.
spacesRouter.post('/:code/tomorrow', (req, res) => {
  const space = requireSpace(req, res);
  if (!space) return;
  addMember(space.id, req.user.id);
  const fresh = !db.prepare('SELECT 1 FROM tomorrow_signups WHERE space_id = ? AND user_id = ? AND for_date >= ?')
    .get(space.id, req.user.id, zurichDate());
  db.prepare(`
    INSERT INTO tomorrow_signups (space_id, user_id, for_date) VALUES (?, ?, ?)
    ON CONFLICT(space_id, user_id) DO UPDATE SET for_date = excluded.for_date, created_at = unixepoch()
  `).run(space.id, req.user.id, zurichDate(1));
  if (fresh) {
    // A little motivation for the ones already signed up.
    const fellow = tomorrowPledges(space.id).map((p) => p.userId).filter((id) => id !== req.user.id);
    if (fellow.length > 0) {
      notify(space, fellow, req.user.id,
        `${req.user.username} is in for tomorrow too — that's ${fellow.length + 1} of you now 💪`);
    }
  }
  sendUpdate(space, res);
});

spacesRouter.delete('/:code/tomorrow', (req, res) => {
  const space = requireSpace(req, res);
  if (!space) return;
  db.prepare('DELETE FROM tomorrow_signups WHERE space_id = ? AND user_id = ?').run(space.id, req.user.id);
  sendUpdate(space, res);
});

// A booking in someone else's name (forUserId / hostUserId) is an admin
// move: it puts words in another member's mouth, so nobody else gets to.
function resolveBookingTarget(req, res, idField) {
  const targetId = req.body?.[idField];
  if (targetId === undefined || targetId === null || targetId === req.user.id) return req.user;
  if (!req.user.is_admin) {
    res.status(403).json({ error: 'Only an admin can book seats in someone else\'s name.' });
    return null;
  }
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId);
  if (!target) res.status(404).json({ error: 'That person does not exist.' });
  return target ?? null;
}

// Join a table yourself (or move there from another table). Admins may
// pass forUserId to book the seat as another member instead.
spacesRouter.post('/:code/tables/:tableId/claims', (req, res) => {
  const space = requireOpenSpace(req, res);
  if (!space) return;
  const eta = normalizeEta(req.body?.eta);
  if (!eta) return res.status(400).json({ error: 'Invalid arrival time.' });
  const table = db.prepare('SELECT * FROM tables WHERE id = ? AND space_id = ?').get(req.params.tableId, space.id);
  if (!table) return res.status(404).json({ error: 'Table not found.' });
  if (table.stolen) return res.status(409).json({ error: 'This table was taken by someone outside the group.' });
  if (table.released) return res.status(409).json({ error: 'This table has been given back.' });
  const target = resolveBookingTarget(req, res, 'forUserId');
  if (!target) return;

  const join = db.transaction(() => {
    db.prepare(`
      DELETE FROM claims WHERE user_id = ? AND guest_name IS NULL
        AND table_id IN (SELECT id FROM tables WHERE space_id = ?)
    `).run(target.id, space.id);
    const seat = pickSeat(table.id, table.capacity, req.body?.seat);
    if (seat === null) {
      const err = new Error('This table is already full.');
      err.status = 409;
      throw err;
    }
    const status = eta === 'now' ? 'arrived' : 'coming';
    db.prepare('INSERT INTO claims (table_id, user_id, seat, eta, status, arrived_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(table.id, target.id, seat, eta, status, status === 'arrived' ? Math.floor(Date.now() / 1000) : null);
  });
  try {
    join();
  } catch (e) {
    return res.status(e.status ?? 500).json({ error: e.message });
  }
  addMember(space.id, target.id);
  addParticipant(space.id, target.id);
  const message = target.id === req.user.id
    ? eta === 'now' ? `${req.user.username} is here (${table.label}) 🎉` : `${req.user.username} is coming at ${eta} (${table.label})`
    : eta === 'now'
      ? `${req.user.username} booked ${target.username} in — they're here (${table.label}) 🎉`
      : `${req.user.username} booked a seat for ${target.username} at ${eta} (${table.label})`;
  notify(space, participantIds(space), req.user.id, message);
  sendUpdate(space, res);
});

// Reserve a seat for a friend without the app. Admins may pass hostUserId
// to attribute the guest to another member ("friend of Anna").
spacesRouter.post('/:code/tables/:tableId/guests', (req, res) => {
  const space = requireOpenSpace(req, res);
  if (!space) return;
  const guestName = String(req.body?.name ?? '').trim();
  if (!guestName || guestName.length > 20) return res.status(400).json({ error: 'Give your friend a name (max 20 characters).' });
  const eta = normalizeEta(req.body?.eta);
  if (!eta) return res.status(400).json({ error: 'Invalid arrival time.' });
  const table = db.prepare('SELECT * FROM tables WHERE id = ? AND space_id = ?').get(req.params.tableId, space.id);
  if (!table) return res.status(404).json({ error: 'Table not found.' });
  if (table.stolen) return res.status(409).json({ error: 'This table was taken by someone outside the group.' });
  if (table.released) return res.status(409).json({ error: 'This table has been given back.' });
  const host = resolveBookingTarget(req, res, 'hostUserId');
  if (!host) return;

  const seat = pickSeat(table.id, table.capacity, req.body?.seat);
  if (seat === null) return res.status(409).json({ error: 'This table is already full.' });
  const status = eta === 'now' ? 'arrived' : 'coming';
  db.prepare('INSERT INTO claims (table_id, user_id, guest_name, seat, eta, status, arrived_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(table.id, host.id, guestName, seat, eta, status, status === 'arrived' ? Math.floor(Date.now() / 1000) : null);
  addMember(space.id, host.id);
  addParticipant(space.id, host.id);
  notify(space, participantIds(space), req.user.id,
    host.id === req.user.id
      ? `${req.user.username} reserved a seat for ${guestName} (${table.label})`
      : `${req.user.username} reserved a seat for ${guestName}, friend of ${host.username} (${table.label})`);
  sendUpdate(space, res);
});

// Update a claim (yours, a guest you added, or anything if you run the session).
spacesRouter.patch('/:code/claims/:claimId', (req, res) => {
  const space = requireOpenSpace(req, res);
  if (!space) return;
  const claim = db.prepare(`
    SELECT c.*, t.label AS table_label FROM claims c
    JOIN tables t ON t.id = c.table_id
    WHERE c.id = ? AND t.space_id = ?
  `).get(req.params.claimId, space.id);
  if (!claim) return res.status(404).json({ error: 'Seat not found.' });
  if (claim.user_id !== req.user.id && !canManageSpace(space, req.user)) {
    return res.status(403).json({ error: 'You cannot change this seat.' });
  }

  const who = claim.guest_name ?? (claim.user_id === req.user.id ? req.user.username : null);
  let eta = claim.eta;
  let status = claim.status;
  let arrivedAt = claim.arrived_at;
  let message = null;
  if (req.body?.eta !== undefined) {
    eta = normalizeEta(req.body.eta);
    if (!eta) return res.status(400).json({ error: 'Invalid arrival time.' });
    status = 'coming';
    arrivedAt = null;
    if (who) message = `${who} now plans to arrive ${eta === 'now' ? 'right away' : `at ${eta}`} (${claim.table_label})`;
  }
  if (req.body?.status !== undefined) {
    if (!['coming', 'arrived'].includes(req.body.status)) return res.status(400).json({ error: 'Invalid status.' });
    status = req.body.status;
    if (status === 'arrived') {
      eta = 'now';
      if (claim.status !== 'arrived' || !arrivedAt) arrivedAt = Math.floor(Date.now() / 1000);
      if (who) message = `${who} has arrived (${claim.table_label}) 🎉`;
    } else {
      arrivedAt = null;
    }
  }
  db.prepare('UPDATE claims SET eta = ?, status = ?, arrived_at = ? WHERE id = ?').run(eta, status, arrivedAt, claim.id);
  if (message) notify(space, participantIds(space), req.user.id, message);
  sendUpdate(space, res);
});

// Free a seat.
spacesRouter.delete('/:code/claims/:claimId', (req, res) => {
  const space = requireOpenSpace(req, res);
  if (!space) return;
  const claim = db.prepare(`
    SELECT c.* FROM claims c JOIN tables t ON t.id = c.table_id
    WHERE c.id = ? AND t.space_id = ?
  `).get(req.params.claimId, space.id);
  if (!claim) return res.status(404).json({ error: 'Seat not found.' });
  if (claim.user_id !== req.user.id && !canManageSpace(space, req.user)) {
    return res.status(403).json({ error: 'You cannot change this seat.' });
  }
  db.prepare('DELETE FROM claims WHERE id = ?').run(claim.id);
  const who = claim.guest_name ?? (claim.user_id === req.user.id ? req.user.username : 'Someone');
  const reason = String(req.body?.reason ?? '').trim().slice(0, 100);
  notify(space, participantIds(space), req.user.id, `${who} left the space${reason ? ` — “${reason}”` : '.'}`);
  sendUpdate(space, res);
});

// Anyone in the session can add a table. Existing tables (and the people on
// them) stay exactly where they are: the odd rotated table flips into a pair
// with the newcomer, or a fresh rotated one appears at the right edge.
spacesRouter.post('/:code/tables', (req, res) => {
  const space = requireOpenSpace(req, res);
  if (!space) return;
  const tables = db.prepare('SELECT id, label, x, y, rot FROM tables WHERE space_id = ?').all(space.id);
  if (tables.length >= 20) return res.status(409).json({ error: 'Maximum of 20 tables reached.' });
  const spot = nextTableSpot(tables);
  if (!spot) return res.status(409).json({ error: 'No space left in the room for another table.' });
  const maxNum = tables.reduce((m, t) => Math.max(m, Number(/^T(\d+)$/.exec(t.label)?.[1] ?? 0)), 0);
  db.transaction(() => {
    if (spot.flip) {
      db.prepare('UPDATE tables SET x = ?, y = ?, rot = 0 WHERE id = ?').run(spot.flip.x, spot.flip.y, spot.flip.id);
    }
    db.prepare('INSERT INTO tables (space_id, label, capacity, x, y, rot) VALUES (?, ?, 1, ?, ?, ?)')
      .run(space.id, `T${maxNum + 1}`, spot.x, spot.y, spot.rot);
  })();
  sendUpdate(space, res);
});

// Anyone in the session can remove an empty table. The others stay put —
// no re-arranging under people who are already seated.
spacesRouter.delete('/:code/tables/:tableId', (req, res) => {
  const space = requireOpenSpace(req, res);
  if (!space) return;
  const table = db.prepare('SELECT * FROM tables WHERE id = ? AND space_id = ?').get(req.params.tableId, space.id);
  if (!table) return res.status(404).json({ error: 'Table not found.' });
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM claims WHERE table_id = ?').get(table.id);
  if (n > 0) return res.status(409).json({ error: 'People are on this table — it cannot be removed.' });
  db.prepare('DELETE FROM tables WHERE id = ?').run(table.id);
  sendUpdate(space, res);
});

// Anyone in the session can change a table (give back / take back, seats, position, rotation).
spacesRouter.patch('/:code/tables/:tableId', (req, res) => {
  const space = requireOpenSpace(req, res);
  if (!space) return;
  const table = db.prepare('SELECT * FROM tables WHERE id = ? AND space_id = ?').get(req.params.tableId, space.id);
  if (!table) return res.status(404).json({ error: 'Table not found.' });

  const { released, stolen, capacity, x, y, rot } = req.body ?? {};
  const updates = {};

  if (released !== undefined) {
    if (typeof released !== 'boolean') return res.status(400).json({ error: 'released must be true or false.' });
    if (released) {
      const { n } = db.prepare('SELECT COUNT(*) AS n FROM claims WHERE table_id = ?').get(table.id);
      if (n > 0) return res.status(409).json({ error: 'People are on this table — it cannot be given back.' });
    } else {
      updates.stolen = 0; // reserving the table again clears the "taken" mark
    }
    updates.released = released ? 1 : 0;
  }
  // Flag a table as taken by someone outside the group. Being taken implies
  // it is out of our hands, so it also counts as given back.
  if (stolen !== undefined) {
    if (typeof stolen !== 'boolean') return res.status(400).json({ error: 'stolen must be true or false.' });
    if (stolen) {
      const { n } = db.prepare('SELECT COUNT(*) AS n FROM claims WHERE table_id = ?').get(table.id);
      if (n > 0) return res.status(409).json({ error: 'People are on this table — it cannot be marked taken.' });
      updates.stolen = 1;
      updates.released = 1;
    } else {
      updates.stolen = 0;
    }
  }
  if (capacity !== undefined) {
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 8) {
      return res.status(400).json({ error: 'Seats must be between 1 and 8.' });
    }
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM claims WHERE table_id = ?').get(table.id);
    if (capacity < n) return res.status(409).json({ error: `${n} people are on this table — remove seats after they move.` });
    updates.capacity = capacity;
  }
  if (rot !== undefined) {
    if (rot !== 0 && rot !== 90) return res.status(400).json({ error: 'Rotation must be 0 or 90.' });
    updates.rot = rot;
  }
  if (x !== undefined || y !== undefined || updates.rot !== undefined) {
    const nx = Number(x ?? table.x);
    const ny = Number(y ?? table.y);
    if (!Number.isFinite(nx) || !Number.isFinite(ny)) return res.status(400).json({ error: 'Invalid position.' });
    // Snap to the half-table grid and refuse overlaps: the table lands
    // on the nearest free spot within one cell, or nowhere at all.
    const others = db
      .prepare('SELECT x, y, rot FROM tables WHERE space_id = ? AND id != ?')
      .all(space.id, table.id)
      .map((o) => tablePlacement(o.x, o.y, o.rot));
    const spot = findFreeSpot(nx, ny, updates.rot !== undefined ? updates.rot : table.rot, others);
    if (!spot) {
      return res.status(409).json({
        error: updates.rot !== undefined && x === undefined ? 'No room to rotate this table here.' : 'No room there — tables cannot overlap.',
      });
    }
    updates.x = spot.x;
    updates.y = spot.y;
  }
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'Nothing to change.' });

  const setSql = Object.keys(updates).map((k) => `${k} = ?`).join(', ');
  db.transaction(() => {
    db.prepare(`UPDATE tables SET ${setSql} WHERE id = ?`).run(...Object.values(updates), table.id);
    // Shrinking can strand claims on removed compartments: move them
    // into free ones.
    if (updates.capacity !== undefined) {
      const claims = db.prepare('SELECT id, seat FROM claims WHERE table_id = ?').all(table.id);
      const occupied = new Set(claims.filter((c) => c.seat < updates.capacity).map((c) => c.seat));
      for (const c of claims.filter((cl) => cl.seat >= updates.capacity)) {
        let s = 0;
        while (occupied.has(s)) s++;
        occupied.add(s);
        db.prepare('UPDATE claims SET seat = ? WHERE id = ?').run(s, c.id);
      }
    }
  })();
  sendUpdate(space, res);
});

// Delete the whole group forever (owner or admin) — code, members, everything.
spacesRouter.delete('/:code', (req, res) => {
  const space = requireSpace(req, res);
  if (!space) return;
  if (space.owner_id !== req.user.id && !req.user.is_admin) {
    return res.status(403).json({ error: 'Only the group owner can delete the space.' });
  }
  deleteSpace(space);
  res.json({ ok: true });
});

export function deleteSpace(space) {
  broadcast(space.id, { deleted: true }, true);
  db.prepare('DELETE FROM spaces WHERE id = ?').run(space.id);
}

// Sessions cover a long study day (through the night into the next
// afternoon) before auto-ending back to idle.
const SESSION_TTL_HOURS = 28;

export function sweepExpired() {
  const stale = db.prepare(`
    SELECT id, code, name, owner_id, opened_by FROM spaces
    WHERE status = 'open' AND opened_at < unixepoch() - ? * 3600
  `).all(SESSION_TTL_HOURS);
  for (const s of stale) {
    const participants = endSession(s);
    notify(s, participants, null, "Today's session wrapped up. Coming back tomorrow? Tap to sign up 🙋", 'setup');
    broadcast(s.id, getSpaceState(s.code), true);
  }
}
