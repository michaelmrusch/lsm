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
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subscription TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_tables_space ON tables(space_id);
CREATE INDEX IF NOT EXISTS idx_claims_table ON claims(table_id);
CREATE INDEX IF NOT EXISTS idx_tokens_expiry ON auth_tokens(expires_at);
CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_members_user ON space_members(user_id);
`);

// Default arrangement for n tables: a centered grid, coordinates are
// fractions (0..1) of the room, measured at the table's center.
export function gridPositions(n) {
  const cols = n <= 4 ? 2 : n <= 12 ? 3 : 4;
  const rows = Math.ceil(n / cols);
  return Array.from({ length: n }, (_, i) => ({
    x: ((i % cols) + 0.5) / cols,
    y: (Math.floor(i / cols) + 0.5) / rows,
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
