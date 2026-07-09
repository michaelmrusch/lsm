import { Router } from 'express';
import { db } from './db.js';
import { broadcast } from './events.js';
import { getSpaceState } from './spaces.js';
import { notifyUsers } from './push.js';
import { colorFor } from './colors.js';

// The lunch spots around ETH Zentrum. facilityId is the ETH gastronomy
// ("Cookpit") facility used for the live menu view; the API has no separate
// entries for the two Polyterrasse floors, so Untere Mensa maps to Mensa
// Polyterrasse and Obere Mensa to Einstein & Zweistein (its upper floor).
// Orient Catering is not ETH-run, so it has no menu.
export const LUNCH_PLACES = [
  { label: 'Clausiusbar', facilityId: 3 },
  { label: 'Archimedes', facilityId: 8 },
  { label: 'Polysnack', facilityId: 10 },
  { label: 'Obere Mensa', facilityId: 6 },
  { label: 'Untere Mensa', facilityId: 9 },
  { label: 'Orient Catering', facilityId: null },
];

function zurichHour() {
  return Number(
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Zurich', hour: 'numeric', hour12: false }).format(new Date()),
  );
}

// The votes part of a space's live state: every ballot is public, so the
// client can show who is voting for what and derive the leader.
export function votesForState(spaceId) {
  const votes = db.prepare('SELECT * FROM votes WHERE space_id = ? ORDER BY id').all(spaceId);
  if (votes.length === 0) return [];
  const optionsByVote = db.prepare(`
    SELECT o.* FROM vote_options o JOIN votes v ON v.id = o.vote_id WHERE v.space_id = ? ORDER BY o.id
  `).all(spaceId);
  const ballots = db.prepare(`
    SELECT b.option_id, b.user_id, u.username, u.color FROM vote_ballots b
    JOIN votes v ON v.id = b.vote_id
    JOIN users u ON u.id = b.user_id
    WHERE v.space_id = ?
    ORDER BY b.created_at, b.user_id
  `).all(spaceId);
  return votes.map((v) => ({
    id: v.id,
    kind: v.kind,
    title: v.title,
    createdBy: v.created_by,
    options: optionsByVote
      .filter((o) => o.vote_id === v.id)
      .map((o) => ({
        id: o.id,
        label: o.label,
        facilityId: o.facility_id,
        addedBy: o.added_by,
        voters: ballots
          .filter((b) => b.option_id === o.id)
          .map((b) => ({
            userId: b.user_id,
            username: b.username,
            color: colorFor({ id: b.user_id, color: b.color }),
          })),
      })),
  }));
}

// Sessions opened in the morning get a lunch vote automatically; a room
// opened after 12 (Zurich) skips it — lunch is already decided or over.
export function maybeCreateLunchVote(spaceId, userId) {
  if (zurichHour() >= 12) return;
  db.transaction(() => {
    const info = db
      .prepare("INSERT INTO votes (space_id, kind, title, created_by) VALUES (?, 'lunch', 'Lunch today', ?)")
      .run(spaceId, userId);
    const ins = db.prepare('INSERT INTO vote_options (vote_id, label, facility_id) VALUES (?, ?, ?)');
    for (const p of LUNCH_PLACES) ins.run(info.lastInsertRowid, p.label, p.facilityId);
  })();
}

export function clearVotes(spaceId) {
  db.prepare('DELETE FROM votes WHERE space_id = ?').run(spaceId);
}

// At 11:00 (Zurich) remind everyone in the session who hasn't voted yet.
// Called from a coarse interval; reminder_sent makes it fire once per vote.
export function sendLunchReminders() {
  if (zurichHour() !== 11) return;
  const pending = db.prepare(`
    SELECT v.id AS vote_id, s.id AS space_id, s.code, s.name FROM votes v
    JOIN spaces s ON s.id = v.space_id
    WHERE v.kind = 'lunch' AND v.reminder_sent = 0 AND s.status = 'open'
  `).all();
  for (const p of pending) {
    db.prepare('UPDATE votes SET reminder_sent = 1 WHERE id = ?').run(p.vote_id);
    const voted = new Set(
      db.prepare('SELECT user_id FROM vote_ballots WHERE vote_id = ?').all(p.vote_id).map((r) => r.user_id),
    );
    const recipients = db
      .prepare('SELECT user_id FROM session_participants WHERE space_id = ?')
      .all(p.space_id)
      .map((r) => r.user_id)
      .filter((id) => !voted.has(id));
    if (recipients.length === 0) continue;
    const leader = db.prepare(`
      SELECT o.label, COUNT(b.user_id) AS n FROM vote_options o
      LEFT JOIN vote_ballots b ON b.option_id = o.id
      WHERE o.vote_id = ? GROUP BY o.id ORDER BY n DESC, o.id LIMIT 1
    `).get(p.vote_id);
    notifyUsers(recipients, {
      title: p.name,
      body:
        leader && leader.n > 0
          ? `Lunch vote: ${leader.label} leads with ${leader.n} — have your say! 🍽️`
          : 'Where for lunch today? Cast your vote! 🍽️',
      url: `/s/${p.code}`,
      tag: `lsm-lunch-${p.code}`,
    });
  }
}

// ---------------------------------------------------------------------------
// Routes, mounted at /api/spaces/:code/votes (auth comes from the parent
// router). Every mutation answers with the full space state and broadcasts
// it, exactly like the table endpoints.

export const votesRouter = Router({ mergeParams: true });

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

function getVote(req, res, space) {
  const vote = db.prepare('SELECT * FROM votes WHERE id = ? AND space_id = ?').get(req.params.voteId, space.id);
  if (!vote) res.status(404).json({ error: 'Vote not found.' });
  return vote ?? null;
}

// Anyone in the session can start a vote on anything.
votesRouter.post('/', (req, res) => {
  const space = requireOpenSpace(req, res);
  if (!space) return;
  const title = String(req.body?.title ?? '').trim();
  if (!title || title.length > 40) return res.status(400).json({ error: 'Give the vote a topic (max 40 characters).' });
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM votes WHERE space_id = ?').get(space.id);
  if (n >= 5) return res.status(409).json({ error: 'Five votes at once is plenty — close one first.' });
  db.prepare("INSERT INTO votes (space_id, kind, title, created_by) VALUES (?, 'custom', ?, ?)")
    .run(space.id, title, req.user.id);
  sendUpdate(space, res);
});

// Whoever started a vote (or a session manager) can take it down.
votesRouter.delete('/:voteId', (req, res) => {
  const space = requireOpenSpace(req, res);
  if (!space) return;
  const vote = getVote(req, res, space);
  if (!vote) return;
  const manager = space.owner_id === req.user.id || space.opened_by === req.user.id || !!req.user.is_admin;
  if (vote.created_by !== req.user.id && !manager) {
    return res.status(403).json({ error: 'Only the person who started this vote can remove it.' });
  }
  db.prepare('DELETE FROM votes WHERE id = ?').run(vote.id);
  sendUpdate(space, res);
});

// Add an extra option — one custom option per person per vote, so the
// list stays a shortlist and not a wishlist.
votesRouter.post('/:voteId/options', (req, res) => {
  const space = requireOpenSpace(req, res);
  if (!space) return;
  const vote = getVote(req, res, space);
  if (!vote) return;
  const label = String(req.body?.label ?? '').trim();
  if (!label || label.length > 40) return res.status(400).json({ error: 'Give the option a name (max 40 characters).' });
  const options = db.prepare('SELECT * FROM vote_options WHERE vote_id = ?').all(vote.id);
  if (options.some((o) => o.added_by === req.user.id)) {
    return res.status(409).json({ error: 'You already added an option to this vote.' });
  }
  if (options.some((o) => o.label.toLowerCase() === label.toLowerCase())) {
    return res.status(409).json({ error: 'That option is already on the list.' });
  }
  if (options.length >= 12) return res.status(409).json({ error: 'This vote has enough options already.' });
  db.prepare('INSERT INTO vote_options (vote_id, label, added_by) VALUES (?, ?, ?)').run(vote.id, label, req.user.id);
  sendUpdate(space, res);
});

// Cast (or change) your ballot; optionId null takes it back.
votesRouter.post('/:voteId/ballots', (req, res) => {
  const space = requireOpenSpace(req, res);
  if (!space) return;
  const vote = getVote(req, res, space);
  if (!vote) return;
  const optionId = req.body?.optionId ?? null;
  if (optionId === null) {
    db.prepare('DELETE FROM vote_ballots WHERE vote_id = ? AND user_id = ?').run(vote.id, req.user.id);
    return sendUpdate(space, res);
  }
  const option = db.prepare('SELECT * FROM vote_options WHERE id = ? AND vote_id = ?').get(optionId, vote.id);
  if (!option) return res.status(404).json({ error: 'That option does not exist.' });
  db.prepare(`
    INSERT INTO vote_ballots (vote_id, option_id, user_id) VALUES (?, ?, ?)
    ON CONFLICT(vote_id, user_id) DO UPDATE SET option_id = excluded.option_id, created_at = unixepoch()
  `).run(vote.id, option.id, req.user.id);
  sendUpdate(space, res);
});
