import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

const dataDir = mkdtempSync(join(tmpdir(), 'lsm-migration-test-'));
const filename = join(dataDir, 'lsm.sqlite');
const legacy = new Database(filename);
legacy.exec(`
  CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    pin_hash TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '',
    is_admin INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE TABLE spaces (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    owner_id INTEGER NOT NULL REFERENCES users(id),
    status TEXT NOT NULL DEFAULT 'idle',
    opened_by INTEGER REFERENCES users(id),
    opened_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE TABLE space_members (
    space_id INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (space_id, user_id)
  );
`);
legacy.close();
process.env.DATA_DIR = dataDir;

const { db } = await import('../server/db.js');

after(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('existing databases receive layout, archive, and notification columns', () => {
  const spaceColumns = new Set(db.prepare('PRAGMA table_info(spaces)').all().map((column) => column.name));
  const memberColumns = new Set(db.prepare('PRAGMA table_info(space_members)').all().map((column) => column.name));
  assert.ok(spaceColumns.has('last_layout'));
  for (const name of ['archived', 'notify_setup', 'notify_activity', 'notify_votes', 'notify_timers', 'notify_chat', 'color']) {
    assert.ok(memberColumns.has(name), `missing ${name}`);
  }
});
