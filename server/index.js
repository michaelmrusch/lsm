import express from 'express';
import cookieParser from 'cookie-parser';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from './db.js';
import { authRouter, requireAuth } from './auth.js';
import { spacesRouter, sweepExpired, listUserSpaces, getSpaceState } from './spaces.js';
import { adminRouter } from './admin.js';
import { vapidPublicKey, saveSubscription, removeSubscription } from './push.js';

const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use(cookieParser());

app.use('/api/auth', authRouter);
app.use('/api/spaces', spacesRouter);
app.use('/api/admin', adminRouter);

app.get('/api/me/spaces', requireAuth, (req, res) => res.json({ spaces: listUserSpaces(req.user.id) }));

app.get('/api/push/key', (req, res) => res.json({ key: vapidPublicKey }));
app.post('/api/push/subscribe', requireAuth, (req, res) => {
  const sub = req.body?.subscription;
  if (!sub?.endpoint || !sub?.keys) return res.status(400).json({ error: 'Invalid subscription.' });
  saveSubscription(req.user.id, sub);
  res.json({ ok: true });
});
app.post('/api/push/unsubscribe', requireAuth, (req, res) => {
  const endpoint = req.body?.endpoint;
  if (typeof endpoint !== 'string') return res.status(400).json({ error: 'Invalid endpoint.' });
  removeSubscription(req.user.id, endpoint);
  res.json({ ok: true });
});
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

// Serve the built frontend; fall back to index.html for client-side routes.
// The fallback injects Open Graph tags so shared links (WhatsApp etc.) show
// a live preview of the space.
const webDist = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'dist');

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function renderIndex(template, req) {
  const base = `${req.protocol}://${req.get('host')}`;
  let title = 'Learning Space Manager';
  let description = 'Reserve study tables together — see live who is coming and when.';
  const match = /^\/s\/([A-Za-z0-9]+)$/.exec(req.path);
  if (match) {
    const state = getSpaceState(match[1]);
    if (state) {
      title = `${state.space.name} · Learning Space Manager`;
      if (state.space.status === 'open') {
        const people = state.tables.flatMap((t) => t.claims).length;
        const seats = state.tables.filter((t) => !t.released).reduce((sum, t) => sum + t.capacity, 0);
        description = `${state.space.openedByName} set up the space — ${Math.max(0, seats - people)} of ${seats} seats free. Tap to grab one!`;
      } else {
        description = 'Nothing set up today yet — the first one there opens it up.';
      }
    }
  }
  const meta = [
    '<meta property="og:type" content="website" />',
    '<meta property="og:site_name" content="Learning Space Manager" />',
    `<meta property="og:title" content="${escapeHtml(title)}" />`,
    `<meta property="og:description" content="${escapeHtml(description)}" />`,
    `<meta property="og:url" content="${escapeHtml(base + req.path)}" />`,
    `<meta property="og:image" content="${escapeHtml(base)}/icons/icon-512.png" />`,
    '<meta property="og:image:type" content="image/png" />',
    '<meta property="og:image:width" content="512" />',
    '<meta property="og:image:height" content="512" />',
    '<meta name="twitter:card" content="summary" />',
    `<meta name="description" content="${escapeHtml(description)}" />`,
  ].join('\n    ');
  return template.replace('<!--APP_META-->', meta);
}

if (fs.existsSync(webDist)) {
  const template = fs.readFileSync(path.join(webDist, 'index.html'), 'utf8');
  app.use(express.static(webDist, { index: false }));
  app.use((req, res) => res.type('html').send(renderIndex(template, req)));
}

setInterval(sweepExpired, 15 * 60 * 1000).unref();
sweepExpired();
setInterval(() => {
  db.prepare('DELETE FROM auth_tokens WHERE expires_at < unixepoch()').run();
}, 24 * 3600 * 1000).unref();

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => console.log(`Learning Space Manager listening on http://localhost:${port}`));
