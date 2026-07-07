import { Router } from 'express';
import crypto from 'node:crypto';
import { db, gridPositions } from './db.js';
import { requireAuth } from './auth.js';
import { subscribe, broadcast } from './events.js';
import { colorFor } from './colors.js';
import { notifyUsers } from './push.js';

export const spacesRouter = Router();
spacesRouter.use(requireAuth);

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
      createdAt: space.created_at,
    },
    tables: tables.map((t) => ({
      id: t.id,
      label: t.label,
      released: !!t.released,
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
        })),
    })),
  };
}

export function listUserSpaces(userId) {
  const rows = db.prepare(`
    SELECT s.*, o.username AS owner_name, op.username AS opened_by_name,
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
  broadcast(space.id, state);
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

function notify(space, recipientIds, actorId, body) {
  notifyUsers(recipientIds.filter((id) => id !== actorId), {
    title: space.name,
    body,
    url: `/s/${space.code}`,
    tag: `lsm-${space.code}`,
  });
}

function createTables(spaceId, tableCount, capacity) {
  const insertTable = db.prepare('INSERT INTO tables (space_id, label, capacity, x, y) VALUES (?, ?, ?, ?, ?)');
  const positions = gridPositions(tableCount);
  for (let i = 0; i < tableCount; i++) {
    insertTable.run(spaceId, `T${i + 1}`, capacity, positions[i].x, positions[i].y);
  }
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

// Open today's session: the first person to arrive sets up the tables.
// This is the notification the whole group gets in the morning.
spacesRouter.post('/:code/sessions', (req, res) => {
  const space = requireSpace(req, res);
  if (!space) return;
  if (space.status === 'open') return res.status(409).json({ error: 'The space is already set up.' });
  const params = validateSessionParams(req, res);
  if (!params) return;

  db.transaction(() => {
    db.prepare('DELETE FROM tables WHERE space_id = ?').run(space.id);
    db.prepare("UPDATE spaces SET status = 'open', opened_by = ?, opened_at = unixepoch() WHERE id = ?")
      .run(req.user.id, space.id);
    createTables(space.id, params.tableCount, params.defaultCapacity);
  })();
  notify(space, memberIds(space.id), req.user.id,
    `${req.user.username} set up the space — ${params.tableCount} ${params.tableCount === 1 ? 'table' : 'tables'}, ${params.tableCount * params.defaultCapacity} seats. Who's coming?`);
  sendUpdate(space, res);
});

// End today's session: wipe tables and claims, keep the group and its code.
spacesRouter.patch('/:code', (req, res) => {
  const space = requireOpenSpace(req, res);
  if (!space) return;
  if (!canManageSpace(space, req.user)) {
    return res.status(403).json({ error: 'Only the person who set up the space (or the group owner) can do that.' });
  }
  if (req.body?.status !== 'idle') return res.status(400).json({ error: 'Only ending the session is supported.' });
  const participants = participantIds(space);
  db.transaction(() => {
    db.prepare('DELETE FROM tables WHERE space_id = ?').run(space.id);
    db.prepare("UPDATE spaces SET status = 'idle', opened_by = NULL, opened_at = NULL WHERE id = ?").run(space.id);
  })();
  notify(space, participants, req.user.id, `${req.user.username} ended today's session.`);
  sendUpdate(space, res);
});

// Join a table yourself (or move there from another table).
spacesRouter.post('/:code/tables/:tableId/claims', (req, res) => {
  const space = requireOpenSpace(req, res);
  if (!space) return;
  const eta = normalizeEta(req.body?.eta);
  if (!eta) return res.status(400).json({ error: 'Invalid arrival time.' });
  const table = db.prepare('SELECT * FROM tables WHERE id = ? AND space_id = ?').get(req.params.tableId, space.id);
  if (!table) return res.status(404).json({ error: 'Table not found.' });
  if (table.released) return res.status(409).json({ error: 'This table has been given back.' });

  const join = db.transaction(() => {
    db.prepare(`
      DELETE FROM claims WHERE user_id = ? AND guest_name IS NULL
        AND table_id IN (SELECT id FROM tables WHERE space_id = ?)
    `).run(req.user.id, space.id);
    const seat = pickSeat(table.id, table.capacity, req.body?.seat);
    if (seat === null) {
      const err = new Error('This table is already full.');
      err.status = 409;
      throw err;
    }
    const status = eta === 'now' ? 'arrived' : 'coming';
    db.prepare('INSERT INTO claims (table_id, user_id, seat, eta, status) VALUES (?, ?, ?, ?, ?)')
      .run(table.id, req.user.id, seat, eta, status);
  });
  try {
    join();
  } catch (e) {
    return res.status(e.status ?? 500).json({ error: e.message });
  }
  addMember(space.id, req.user.id);
  notify(space, participantIds(space), req.user.id,
    eta === 'now' ? `${req.user.username} is here (${table.label}) 🎉` : `${req.user.username} is coming at ${eta} (${table.label})`);
  sendUpdate(space, res);
});

// Reserve a seat for a friend without the app.
spacesRouter.post('/:code/tables/:tableId/guests', (req, res) => {
  const space = requireOpenSpace(req, res);
  if (!space) return;
  const guestName = String(req.body?.name ?? '').trim();
  if (!guestName || guestName.length > 20) return res.status(400).json({ error: 'Give your friend a name (max 20 characters).' });
  const eta = normalizeEta(req.body?.eta);
  if (!eta) return res.status(400).json({ error: 'Invalid arrival time.' });
  const table = db.prepare('SELECT * FROM tables WHERE id = ? AND space_id = ?').get(req.params.tableId, space.id);
  if (!table) return res.status(404).json({ error: 'Table not found.' });
  if (table.released) return res.status(409).json({ error: 'This table has been given back.' });

  const seat = pickSeat(table.id, table.capacity, req.body?.seat);
  if (seat === null) return res.status(409).json({ error: 'This table is already full.' });
  const status = eta === 'now' ? 'arrived' : 'coming';
  db.prepare('INSERT INTO claims (table_id, user_id, guest_name, seat, eta, status) VALUES (?, ?, ?, ?, ?, ?)')
    .run(table.id, req.user.id, guestName, seat, eta, status);
  notify(space, participantIds(space), req.user.id,
    `${req.user.username} reserved a seat for ${guestName} (${table.label})`);
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
  let message = null;
  if (req.body?.eta !== undefined) {
    eta = normalizeEta(req.body.eta);
    if (!eta) return res.status(400).json({ error: 'Invalid arrival time.' });
    status = 'coming';
    if (who) message = `${who} now plans to arrive ${eta === 'now' ? 'right away' : `at ${eta}`} (${claim.table_label})`;
  }
  if (req.body?.status !== undefined) {
    if (!['coming', 'arrived'].includes(req.body.status)) return res.status(400).json({ error: 'Invalid status.' });
    status = req.body.status;
    if (status === 'arrived') {
      eta = 'now';
      if (who) message = `${who} has arrived (${claim.table_label}) 🎉`;
    }
  }
  db.prepare('UPDATE claims SET eta = ?, status = ? WHERE id = ?').run(eta, status, claim.id);
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

// Anyone in the session can add a table.
spacesRouter.post('/:code/tables', (req, res) => {
  const space = requireOpenSpace(req, res);
  if (!space) return;
  const tables = db.prepare('SELECT label FROM tables WHERE space_id = ?').all(space.id);
  if (tables.length >= 20) return res.status(409).json({ error: 'Maximum of 20 tables reached.' });
  const maxNum = tables.reduce((m, t) => Math.max(m, Number(/^T(\d+)$/.exec(t.label)?.[1] ?? 0)), 0);
  db.prepare('INSERT INTO tables (space_id, label, capacity, x, y) VALUES (?, ?, 1, 0.5, 0.5)')
    .run(space.id, `T${maxNum + 1}`);
  sendUpdate(space, res);
});

// Anyone in the session can remove an empty table.
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

  const { released, capacity, x, y, rot } = req.body ?? {};
  const updates = {};

  if (released !== undefined) {
    if (typeof released !== 'boolean') return res.status(400).json({ error: 'released must be true or false.' });
    if (released) {
      const { n } = db.prepare('SELECT COUNT(*) AS n FROM claims WHERE table_id = ?').get(table.id);
      if (n > 0) return res.status(409).json({ error: 'People are on this table — it cannot be given back.' });
    }
    updates.released = released ? 1 : 0;
  }
  if (capacity !== undefined) {
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 8) {
      return res.status(400).json({ error: 'Seats must be between 1 and 8.' });
    }
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM claims WHERE table_id = ?').get(table.id);
    if (capacity < n) return res.status(409).json({ error: `${n} people are on this table — remove seats after they move.` });
    updates.capacity = capacity;
  }
  if (x !== undefined || y !== undefined) {
    const nx = Number(x ?? table.x);
    const ny = Number(y ?? table.y);
    if (!Number.isFinite(nx) || !Number.isFinite(ny)) return res.status(400).json({ error: 'Invalid position.' });
    updates.x = Math.min(0.94, Math.max(0.06, nx));
    updates.y = Math.min(0.94, Math.max(0.06, ny));
  }
  if (rot !== undefined) {
    if (rot !== 0 && rot !== 90) return res.status(400).json({ error: 'Rotation must be 0 or 90.' });
    updates.rot = rot;
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
  broadcast(space.id, { deleted: true });
  db.prepare('DELETE FROM spaces WHERE id = ?').run(space.id);
}

// Sessions are for one study day: auto-end after 16 hours, back to idle.
export function sweepExpired() {
  const stale = db.prepare("SELECT id, code FROM spaces WHERE status = 'open' AND opened_at < unixepoch() - 16 * 3600").all();
  if (stale.length === 0) return;
  const end = db.transaction((s) => {
    db.prepare('DELETE FROM tables WHERE space_id = ?').run(s.id);
    db.prepare("UPDATE spaces SET status = 'idle', opened_by = NULL, opened_at = NULL WHERE id = ?").run(s.id);
  });
  for (const s of stale) {
    end(s);
    broadcast(s.id, getSpaceState(s.code));
  }
}
