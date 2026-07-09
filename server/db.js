import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export const dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
fs.mkdirSync(dataDir, { recursive: true });

export const db = new Database(path.join(dataDir, 'lsm.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// A "space" is a persistent study group with a stable share code. Each day
// a member opens a session (creates tables); ending it wipes tables+claims
// but keeps the group, its code and its members.
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pin_hash TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '',
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS auth_tokens (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS spaces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  owner_id INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle', 'open')),
  opened_by INTEGER REFERENCES users(id),
  opened_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS space_members (
  space_id INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (space_id, user_id)
);

CREATE TABLE IF NOT EXISTS tables (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  space_id INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  released INTEGER NOT NULL DEFAULT 0,
  capacity INTEGER NOT NULL DEFAULT 1,
  x REAL NOT NULL DEFAULT 0.5,
  y REAL NOT NULL DEFAULT 0.5,
  rot INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  table_id INTEGER NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  guest_name TEXT,
  seat INTEGER NOT NULL DEFAULT 0,
  eta TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'coming' CHECK (status IN ('coming', 'arrived')),
  arrived_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subscription TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- One-time registration codes handed out by admins. used_at (not used_by)
-- marks redemption, so a code stays spent even if the account it created
-- is deleted later.
CREATE TABLE IF NOT EXISTS invite_codes (
  code TEXT PRIMARY KEY,
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  used_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  used_at INTEGER
);

-- Everyone who held a seat at some point during the current session, kept
-- so the end-of-session "sign up for tomorrow" reminder also reaches people
-- who already left. Cleared when the next session opens.
CREATE TABLE IF NOT EXISTS session_participants (
  space_id INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (space_id, user_id)
);

-- "I'll be back tomorrow" pledges — no arrival time, just intent, so the
-- first person there the next morning knows what table size to reserve.
-- for_date is the Zurich calendar day the pledge is for; rows are consumed
-- when the next session opens and ignored once for_date is in the past.
CREATE TABLE IF NOT EXISTS tomorrow_signups (
  space_id INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  for_date TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (space_id, user_id)
);

-- Session-scoped polls (e.g. where to eat lunch). Wiped together with the
-- tables when a session ends, so every study day starts fresh.
CREATE TABLE IF NOT EXISTS votes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  space_id INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'custom' CHECK (kind IN ('lunch', 'custom')),
  title TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  reminder_sent INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS vote_options (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vote_id INTEGER NOT NULL REFERENCES votes(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  facility_id INTEGER,   -- ETH gastronomy facility, for the live menu view
  added_by INTEGER REFERENCES users(id) ON DELETE SET NULL  -- NULL = built-in option
);

-- One ballot per person per vote; changing your mind replaces it.
CREATE TABLE IF NOT EXISTS vote_ballots (
  vote_id INTEGER NOT NULL REFERENCES votes(id) ON DELETE CASCADE,
  option_id INTEGER NOT NULL REFERENCES vote_options(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (vote_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_votes_space ON votes(space_id);
CREATE INDEX IF NOT EXISTS idx_vote_options_vote ON vote_options(vote_id);
CREATE INDEX IF NOT EXISTS idx_tables_space ON tables(space_id);
CREATE INDEX IF NOT EXISTS idx_claims_table ON claims(table_id);
CREATE INDEX IF NOT EXISTS idx_tokens_expiry ON auth_tokens(expires_at);
CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_members_user ON space_members(user_id);
`);

// The room is an 8x8 board of cells, each half a table long: a table
// covers 2x1 cells (1x2 rotated), so tables always butt up flush
// against each other. Coordinates are fractions (0..1) of the room,
// measured at the table's center.
export const GRID_CELL = 0.125;
const CELLS = 8;

export function snapPosition(x, y, rot) {
  const wc = rot === 0 ? 2 : 1;
  const hc = rot === 0 ? 1 : 2;
  const leftCell = Math.min(CELLS - wc, Math.max(0, Math.round(x / GRID_CELL - wc / 2)));
  const topCell = Math.min(CELLS - hc, Math.max(0, Math.round(y / GRID_CELL - hc / 2)));
  return { x: (leftCell + wc / 2) * GRID_CELL, y: (topCell + hc / 2) * GRID_CELL };
}

// Collision system (mirrored in web/src/components/Room.tsx — keep in
// sync): tables occupy whole cells and may never overlap.
export function tablePlacement(x, y, rot) {
  const wc = rot === 0 ? 2 : 1;
  const hc = rot === 0 ? 1 : 2;
  return {
    leftCell: Math.min(CELLS - wc, Math.max(0, Math.round(x / GRID_CELL - wc / 2))),
    topCell: Math.min(CELLS - hc, Math.max(0, Math.round(y / GRID_CELL - hc / 2))),
    wc,
    hc,
  };
}

function placementsOverlap(a, b) {
  return a.leftCell < b.leftCell + b.wc && b.leftCell < a.leftCell + a.wc &&
    a.topCell < b.topCell + b.hc && b.topCell < a.topCell + a.hc;
}

function placementCenter(p) {
  return { x: (p.leftCell + p.wc / 2) * GRID_CELL, y: (p.topCell + p.hc / 2) * GRID_CELL };
}

// Where a table dropped at (x, y) actually lands: the snapped cell if
// free, else the nearest free spot at most one cell away, else null
// (the drop is refused).
export function findFreeSpot(x, y, rot, others) {
  const desired = tablePlacement(x, y, rot);
  let best = null;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const cand = {
        leftCell: Math.min(CELLS - desired.wc, Math.max(0, desired.leftCell + dx)),
        topCell: Math.min(CELLS - desired.hc, Math.max(0, desired.topCell + dy)),
        wc: desired.wc,
        hc: desired.hc,
      };
      if (others.some((o) => placementsOverlap(cand, o))) continue;
      const c = placementCenter(cand);
      const dist = Math.hypot(c.x - x, c.y - y);
      if (!best || dist < best.dist) best = { ...c, dist };
    }
  }
  return best ? { x: best.x, y: best.y } : null;
}

// The closest free placement to the room's center, for new tables.
export function findAnyFreeSpot(rot, others) {
  const wc = rot === 0 ? 2 : 1;
  const hc = rot === 0 ? 1 : 2;
  let best = null;
  for (let leftCell = 0; leftCell <= CELLS - wc; leftCell++) {
    for (let topCell = 0; topCell <= CELLS - hc; topCell++) {
      const cand = { leftCell, topCell, wc, hc };
      if (others.some((o) => placementsOverlap(cand, o))) continue;
      const c = placementCenter(cand);
      const dist = Math.hypot(c.x - 0.5, c.y - 0.4375);
      if (!best || dist < best.dist) best = { ...c, dist };
    }
  }
  return best ? { x: best.x, y: best.y } : null;
}

// Default arrangement for n tables: grid-aligned columns with a
// one-cell gap between rows while space allows.
export function gridPositions(n) {
  const cols = n <= 8 ? 2 : 3;
  const leftCells = cols === 2 ? [1, 5] : [0, 3, 6];
  const rows = Math.ceil(n / cols);
  const rowStep = rows <= 4 ? 2 : 1;
  const topStart = rows <= 4 ? 1 : 0;
  return Array.from({ length: n }, (_, i) => ({
    x: (leftCells[i % cols] + 1) * GRID_CELL,
    y: (topStart + Math.floor(i / cols) * rowStep + 0.5) * GRID_CELL,
  }));
}

// ---------- migrations for databases created by earlier versions ----------

function hasColumn(table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
}

if (!hasColumn('users', 'color')) {
  db.exec("ALTER TABLE users ADD COLUMN color TEXT NOT NULL DEFAULT ''");
}

if (!hasColumn('users', 'is_admin')) {
  db.exec('ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0');
}

if (!hasColumn('tables', 'capacity')) {
  db.exec('ALTER TABLE tables ADD COLUMN capacity INTEGER NOT NULL DEFAULT 2');
  db.exec(`UPDATE tables SET capacity = COALESCE(
    (SELECT seats_per_table FROM spaces WHERE spaces.id = tables.space_id), 2)`);
}

if (!hasColumn('tables', 'x')) {
  db.exec(`
    ALTER TABLE tables ADD COLUMN x REAL NOT NULL DEFAULT 0.5;
    ALTER TABLE tables ADD COLUMN y REAL NOT NULL DEFAULT 0.5;
    ALTER TABLE tables ADD COLUMN rot INTEGER NOT NULL DEFAULT 0;
  `);
  const spaces = db.prepare('SELECT id FROM spaces').all();
  const setPos = db.prepare('UPDATE tables SET x = ?, y = ? WHERE id = ?');
  for (const s of spaces) {
    const tables = db.prepare('SELECT id FROM tables WHERE space_id = ? ORDER BY id').all(s.id);
    const positions = gridPositions(tables.length);
    tables.forEach((t, i) => setPos.run(positions[i].x, positions[i].y, t.id));
  }
}

// One-shot spaces -> persistent groups with sessions. Requires rebuilding
// the spaces table (old CHECK allowed only open/closed) and the claims
// table (drop UNIQUE(table_id, user_id) so guests can share a host).
if (!hasColumn('spaces', 'opened_by')) {
  db.pragma('foreign_keys = OFF');
  db.transaction(() => {
    db.exec(`
      CREATE TABLE spaces_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        owner_id INTEGER NOT NULL REFERENCES users(id),
        status TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle', 'open')),
        opened_by INTEGER REFERENCES users(id),
        opened_at INTEGER,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      INSERT INTO spaces_new (id, code, name, owner_id, status, opened_by, opened_at, created_at)
        SELECT id, code, name, owner_id,
               CASE WHEN status = 'open' THEN 'open' ELSE 'idle' END,
               CASE WHEN status = 'open' THEN owner_id ELSE NULL END,
               CASE WHEN status = 'open' THEN created_at ELSE NULL END,
               created_at
        FROM spaces;
      DROP TABLE spaces;
      ALTER TABLE spaces_new RENAME TO spaces;

      CREATE TABLE claims_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        table_id INTEGER NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        guest_name TEXT,
        eta TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'coming' CHECK (status IN ('coming', 'arrived')),
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      INSERT INTO claims_new (id, table_id, user_id, guest_name, eta, status, created_at)
        SELECT id, table_id, user_id, NULL, eta, status, created_at FROM claims;
      DROP TABLE claims;
      ALTER TABLE claims_new RENAME TO claims;
      CREATE INDEX IF NOT EXISTS idx_claims_table ON claims(table_id);

      -- ended sessions keep the group but not the furniture
      DELETE FROM tables WHERE space_id IN (SELECT id FROM spaces WHERE status = 'idle');
    `);
  })();
  db.pragma('foreign_keys = ON');
}

// Claims map to a specific compartment of their table.
if (!hasColumn('claims', 'seat')) {
  db.exec('ALTER TABLE claims ADD COLUMN seat INTEGER NOT NULL DEFAULT 0');
  const tables = db.prepare('SELECT DISTINCT table_id FROM claims').all();
  const setSeat = db.prepare('UPDATE claims SET seat = ? WHERE id = ?');
  for (const t of tables) {
    const claims = db.prepare('SELECT id FROM claims WHERE table_id = ? ORDER BY created_at, id').all(t.table_id);
    claims.forEach((c, i) => setSeat.run(i, c.id));
  }
}

// When someone actually sat down, for the time-at-table display.
if (!hasColumn('claims', 'arrived_at')) {
  db.exec('ALTER TABLE claims ADD COLUMN arrived_at INTEGER');
  db.exec("UPDATE claims SET arrived_at = created_at WHERE status = 'arrived'");
}

// Align any pre-snapping table positions to the grid (idempotent; moves
// each table at most half a cell).
{
  const setPos = db.prepare('UPDATE tables SET x = ?, y = ? WHERE id = ?');
  for (const t of db.prepare('SELECT id, x, y, rot FROM tables').all()) {
    const p = snapPosition(t.x, t.y, t.rot);
    if (p.x !== t.x || p.y !== t.y) setPos.run(p.x, p.y, t.id);
  }
}

// Seed memberships (idempotent): owners and everyone with a claim belong.
db.exec(`
  INSERT OR IGNORE INTO space_members (space_id, user_id) SELECT id, owner_id FROM spaces;
  INSERT OR IGNORE INTO space_members (space_id, user_id)
    SELECT t.space_id, c.user_id FROM claims c JOIN tables t ON t.id = c.table_id;
`);

// The account named in ADMIN_USERNAME gets the admin panel (username
// comparison is case-insensitive via the column's NOCASE collation).
const adminName = process.env.ADMIN_USERNAME?.trim();
if (adminName) {
  db.prepare('UPDATE users SET is_admin = 1 WHERE username = ?').run(adminName);
}
