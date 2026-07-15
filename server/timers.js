import { Router } from 'express';
import { db } from './db.js';
import { broadcast } from './events.js';
import { getSpaceState } from './spaces.js';
import { notifySpaceUsers } from './push.js';
import { colorFor } from './colors.js';

// Shared focus timers: whoever starts a round invites the whole session,
// and joining stays open for the first tenth of the duration — late joiners
// would get a shorter round anyway, and a hard window nudges everyone to
// sit down together.
const JOIN_FRACTION = 0.1;
const MIN_MINUTES = 5;
const MAX_MINUTES = 240;
// How long the finished "break time" card lingers before the sweep clears it.
const LINGER_S = 10 * 60;

const nowS = () => Math.floor(Date.now() / 1000);
const joinDeadline = (t) => t.started_at + Math.ceil(t.duration_s * JOIN_FRACTION);
const isFinished = (t) => t.started_at + t.duration_s <= nowS();

// The timer part of a space's live state (at most one). The client renders
// the countdown itself from endsAt; the server only pushes at the edges.
export function timerForState(spaceId) {
  const t = db.prepare(`
    SELECT t.*, u.username AS started_by_name FROM timers t
    LEFT JOIN users u ON u.id = t.started_by
    WHERE t.space_id = ? ORDER BY t.id DESC LIMIT 1
  `).get(spaceId);
  if (!t) return null;
  return {
    id: t.id,
    durationS: t.duration_s,
    startedAt: t.started_at,
    endsAt: t.started_at + t.duration_s,
    joinUntil: joinDeadline(t),
    startedBy: t.started_by,
    startedByName: t.started_by_name,
    participants: db.prepare(`
      SELECT p.user_id, u.username, COALESCE(NULLIF(sm.color, ''), u.color) AS color FROM timer_participants p
      JOIN users u ON u.id = p.user_id
      JOIN timers tm ON tm.id = p.timer_id
      LEFT JOIN space_members sm ON sm.space_id = tm.space_id AND sm.user_id = p.user_id
      WHERE p.timer_id = ? ORDER BY p.joined_at, p.user_id
    `).all(t.id).map((p) => ({
      userId: p.user_id,
      username: p.username,
      color: colorFor({ id: p.user_id, color: p.color }),
    })),
  };
}

export function clearTimers(spaceId) {
  db.prepare('DELETE FROM timers WHERE space_id = ?').run(spaceId);
}

// Called from a coarse interval: the moment a round runs out everyone who
// joined gets the break push (break_sent keeps it to one), and finished
// rounds are cleared once the break card has lingered long enough.
export function sweepTimers() {
  const due = db.prepare(`
    SELECT t.*, s.code, s.name FROM timers t JOIN spaces s ON s.id = t.space_id
    WHERE t.break_sent = 0 AND t.started_at + t.duration_s <= unixepoch()
  `).all();
  for (const t of due) {
    db.prepare('UPDATE timers SET break_sent = 1 WHERE id = ?').run(t.id);
    const ids = db.prepare('SELECT user_id FROM timer_participants WHERE timer_id = ?').all(t.id).map((r) => r.user_id);
    notifySpaceUsers(t.space_id, ids, 'timers', {
      title: t.name,
      body: `Break time! ${Math.round(t.duration_s / 60)} minutes of focus done 🎉`,
      url: `/s/${t.code}`,
      tag: `lsm-timer-${t.code}`,
    });
    broadcast(t.space_id, getSpaceState(t.code));
  }
  const stale = db.prepare(`
    SELECT t.id, t.space_id, s.code FROM timers t JOIN spaces s ON s.id = t.space_id
    WHERE t.started_at + t.duration_s + ? <= unixepoch()
  `).all(LINGER_S);
  for (const t of stale) {
    db.prepare('DELETE FROM timers WHERE id = ?').run(t.id);
    broadcast(t.space_id, getSpaceState(t.code));
  }
}

// ---------------------------------------------------------------------------
// Routes, mounted at /api/spaces/:code/timers (auth comes from the parent
// router). Every mutation answers with the full space state and broadcasts
// it, exactly like the table and vote endpoints.

export const timersRouter = Router({ mergeParams: true });

function requireOpenSpace(req, res) {
  const space = db.prepare('SELECT * FROM spaces WHERE code = ?').get(String(req.params.code).toUpperCase());
  if (!space) {
    res.status(404).json({ error: 'Space not found.' });
    return null;
  }
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

function getTimer(req, res, space) {
  const timer = db.prepare('SELECT * FROM timers WHERE id = ? AND space_id = ?').get(req.params.timerId, space.id);
  if (!timer) res.status(404).json({ error: 'Timer not found.' });
  return timer ?? null;
}

// Anyone in the session can start a round; one at a time per space. The
// starter is in automatically, everyone else in the session gets a push
// invite with the join deadline.
timersRouter.post('/', (req, res) => {
  const space = requireOpenSpace(req, res);
  if (!space) return;
  const minutes = Number(req.body?.minutes);
  if (!Number.isInteger(minutes) || minutes < MIN_MINUTES || minutes > MAX_MINUTES) {
    return res.status(400).json({ error: `Timer length must be ${MIN_MINUTES}–${MAX_MINUTES} minutes.` });
  }
  const current = db.prepare('SELECT * FROM timers WHERE space_id = ? ORDER BY id DESC LIMIT 1').get(space.id);
  if (current && !isFinished(current)) {
    return res.status(409).json({ error: 'A timer is already running — one round at a time.' });
  }
  db.transaction(() => {
    clearTimers(space.id); // a finished round makes way for the next
    const info = db.prepare('INSERT INTO timers (space_id, started_by, duration_s) VALUES (?, ?, ?)')
      .run(space.id, req.user.id, minutes * 60);
    db.prepare('INSERT INTO timer_participants (timer_id, user_id) VALUES (?, ?)')
      .run(info.lastInsertRowid, req.user.id);
  })();
  const joinMin = Math.max(1, Math.round(minutes * JOIN_FRACTION));
  const invited = db.prepare('SELECT user_id FROM session_participants WHERE space_id = ?').all(space.id)
    .map((r) => r.user_id)
    .filter((id) => id !== req.user.id);
  notifySpaceUsers(space.id, invited, 'timers', {
    title: space.name,
    body: `${req.user.username} started a ${minutes} min focus round — you have ${joinMin} min to join! ⏱️`,
    url: `/s/${space.code}`,
    tag: `lsm-timer-${space.code}`,
  });
  sendUpdate(space, res);
});

// Joining is open for the first 10% of the round only.
timersRouter.post('/:timerId/join', (req, res) => {
  const space = requireOpenSpace(req, res);
  if (!space) return;
  const timer = getTimer(req, res, space);
  if (!timer) return;
  if (isFinished(timer)) return res.status(409).json({ error: 'This round is already over.' });
  if (nowS() > joinDeadline(timer)) {
    return res.status(409).json({ error: 'The join window has closed — catch the next round!' });
  }
  db.prepare('INSERT OR IGNORE INTO timer_participants (timer_id, user_id) VALUES (?, ?)')
    .run(timer.id, req.user.id);
  sendUpdate(space, res);
});

// Changed your mind: you can step out while the round runs. If the last
// person leaves, the round stops.
timersRouter.delete('/:timerId/join', (req, res) => {
  const space = requireOpenSpace(req, res);
  if (!space) return;
  const timer = getTimer(req, res, space);
  if (!timer) return;
  db.transaction(() => {
    db.prepare('DELETE FROM timer_participants WHERE timer_id = ? AND user_id = ?').run(timer.id, req.user.id);
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM timer_participants WHERE timer_id = ?').get(timer.id);
    if (n === 0) db.prepare('DELETE FROM timers WHERE id = ?').run(timer.id);
  })();
  sendUpdate(space, res);
});

// Stop a running round (starter or session manager); once it has finished,
// anyone may dismiss the break card.
timersRouter.delete('/:timerId', (req, res) => {
  const space = requireOpenSpace(req, res);
  if (!space) return;
  const timer = getTimer(req, res, space);
  if (!timer) return;
  const manager = space.owner_id === req.user.id || space.opened_by === req.user.id || !!req.user.is_admin;
  if (!isFinished(timer) && timer.started_by !== req.user.id && !manager) {
    return res.status(403).json({ error: 'Only the person who started the timer can stop it.' });
  }
  db.prepare('DELETE FROM timers WHERE id = ?').run(timer.id);
  sendUpdate(space, res);
});
