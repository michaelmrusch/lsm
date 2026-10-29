import express from 'express';
import cookieParser from 'cookie-parser';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from './db.js';
import { authRouter, requireAuth } from './auth.js';
import { spacesRouter, sweepExpired, listUserSpaces, getSpaceState } from './spaces.js';
import { adminRouter } from './admin.js';
import { vapidPublicKey, saveSubscription, removeSubscription, isValidSubscription } from './push.js';
import { sendLunchReminders } from './votes.js';
import { sweepTimers } from './timers.js';
import { menusHandler } from './menus.js';
import { subscribeDashboard } from './events.js';

export const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

// The built frontend, if present (production; in dev Vite serves it).
const webDist = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'dist');
const indexPath = path.join(webDist, 'index.html');
const template = fs.existsSync(indexPath) ? fs.readFileSync(indexPath, 'utf8') : null;

// ---------- transport + browser hardening ----------

// index.html carries one small inline script (theme before first paint).
// Hashing it from the built file at startup keeps the CSP exact without
// ever allowing arbitrary inline script. Browsers hash the text after HTML
// parsing, which turns CRLF into LF — normalize the same way, or a Windows
// checkout's line endings would get the script blocked.
const inlineScriptHashes = template
  ? [...template.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => {
      const text = m[1].replace(/\r\n?/g, '\n');
      return `'sha256-${crypto.createHash('sha256').update(text).digest('base64')}'`;
    })
  : [];
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  ["script-src 'self'", ...inlineScriptHashes].join(' '),
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:", // menu photos come from ETH's servers
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

app.use((req, res, next) => {
  // Arrived at the reverse proxy over plain HTTP (it forwards the original
  // scheme): send the browser to HTTPS so PINs and session cookies never
  // cross a café or university Wi-Fi in clear text. Direct LAN access
  // without a proxy header is left alone.
  if (req.get('x-forwarded-proto') && !req.secure) {
    if (req.method === 'GET' || req.method === 'HEAD') {
      return res.redirect(301, `https://${req.get('host')}${req.originalUrl}`);
    }
    return res.status(403).json({ error: 'Please use https://.' });
  }
  res.set({
    'Content-Security-Policy': CONTENT_SECURITY_POLICY,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  });
  // Tell browsers to only ever use HTTPS here from now on (180 days).
  if (req.secure) res.set('Strict-Transport-Security', 'max-age=15552000');
  next();
});

app.use(express.json());
app.use(cookieParser());

app.use('/api/auth', authRouter);
app.use('/api/spaces', spacesRouter);
app.use('/api/admin', adminRouter);

app.get('/api/me/spaces', requireAuth, (req, res) => res.json({ spaces: listUserSpaces(req.user.id) }));
app.get('/api/me/events', requireAuth, (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write(`data: ${JSON.stringify({ ready: true })}\n\n`);
  const unsubscribe = subscribeDashboard(res);
  req.on('close', unsubscribe);
});
app.get('/api/menus', requireAuth, menusHandler);

app.get('/api/push/key', (req, res) => res.json({ key: vapidPublicKey }));
app.post('/api/push/subscribe', requireAuth, (req, res) => {
  const sub = req.body?.subscription;
  if (!isValidSubscription(sub)) return res.status(400).json({ error: 'Invalid subscription.' });
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

if (template) {
  app.use(express.static(webDist, { index: false }));
  app.use((req, res) => res.type('html').send(renderIndex(template, req)));
}

setInterval(sweepExpired, 15 * 60 * 1000).unref();
sweepExpired();
// Checked every 5 minutes so the 11:00 (Zurich) lunch-vote reminder lands
// early in the hour; reminder_sent keeps it to one push per vote.
setInterval(sendLunchReminders, 5 * 60 * 1000).unref();
// Every 30s so the "break time" push lands right when a focus round ends.
setInterval(sweepTimers, 30 * 1000).unref();
setInterval(() => {
  db.prepare('DELETE FROM auth_tokens WHERE expires_at < unixepoch()').run();
}, 24 * 3600 * 1000).unref();

export function startServer(port = Number(process.env.PORT) || 3000) {
  return app.listen(port, () => console.log(`Learning Space Manager listening on http://localhost:${port}`));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) startServer();
