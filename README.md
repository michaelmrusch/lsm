# 🪑 Learning Space Manager

A tiny mobile-first webapp for coordinating shared study tables at university.

A **space** is a persistent study group with a share code that never changes.
Each morning, the first person to arrive reserves some tables and *sets up* the
space in the app — everyone in the group gets a push notification and sees live
who's coming, when, and how many seats are left. The person on site can **give
back** the tables nobody needs. Ending the day's session clears the tables but
keeps the group, its code and its members for tomorrow.

## Features

- **No-friction accounts** — name + PIN + a personal color; registering needs a one-time invite code from an admin (the first account and `ADMIN_USERNAME` bootstrap without one)
- **Live sync** — every phone updates instantly via Server-Sent Events
- **Top-down room view** — tables are drawn as split rectangles, one segment per seat, filled with each person's color (outlined = coming, solid = arrived)
- **Collaborative table setup** — everyone in the session can add/remove tables, set seat counts, drag tables around the room and rotate them 90°; the room canvas pans and zooms (pinch or scroll) for big layouts
- **Guest seats** — reserve a seat for a friend without the app, shown as "friend of ‹member›"
- **Push notifications** — installable PWA; the whole group is notified when someone sets up the space in the morning, participants when people join/arrive/leave (on iPhone: add to Home Screen first, then enable — iOS requirement)
- **Smart summary** — "1 here · 2 coming (next ~16:30) · 5 free seats"
- **Admin panel** — the account named in `ADMIN_USERNAME` sees all spaces and users at `/admin`, can delete either (e.g. offensive names), and generates the one-time invite codes new members need to register
- **Persistent groups** — 6-character codes / shareable links that stay valid; your home screen shows each group's live status
- **Auto-reset** — sessions end themselves after 28 hours (a long study day into the next); the group stays
- **Tomorrow pledges** — the last one out is prompted to end the session; everyone who took part gets a push asking "coming back tomorrow?" — one tap signals intent (no time needed), so the first person there next morning knows what table size to grab, and fellow pledgers get a small motivational nudge
- **Lunch votes** — sessions opened before 12:00 (Zurich) automatically get a "Lunch today" vote with the ETH Zentrum spots (Clausiusbar, Archimedes, Polysnack, Obere/Untere Mensa, Orient Catering); tapping ℹ️ shows today's live menus straight from ETH's gastronomy API. Anyone can start extra votes on anything, add one custom option per person, and change their ballot; a slim chip shows just the current leader, the details live in an overlay, and non-voters get one reminder push at 11:00

## Local development

```bash
npm install
npm --prefix web install
npm run dev        # server on :3000, Vite dev server on :5173
```

Open http://localhost:5173. The SQLite database is created at `data/lsm.sqlite`.

## Deployment (Docker Compose + nginx)

On the server:

```bash
git clone <this repo> lsm && cd lsm
docker compose up -d --build
```

The app listens on `127.0.0.1:3000` (not exposed publicly). The SQLite database is
persisted in `./data/` on the host.

To unlock the admin panel, uncomment `ADMIN_USERNAME` in `docker-compose.yml` and
set it to your account name, then `docker compose up -d`.

Then wire up nginx: copy `nginx.example.conf` to
`/etc/nginx/sites-available/lsm.conf`, set your domain, enable it, and get a
certificate:

```bash
sudo ln -s /etc/nginx/sites-available/lsm.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d lsm.example.com
```

The `proxy_buffering off` / `proxy_read_timeout 1h` lines in the example config are
required — without them the live updates (SSE) stall behind nginx.

### Updating

```bash
git pull
docker compose up -d --build
```

## How it works

| Piece | Tech |
|---|---|
| Backend | Node.js + Express (ES modules) |
| Database | SQLite (`better-sqlite3`), single file in `data/` |
| Realtime | Server-Sent Events, one channel per space |
| Push | Web Push (VAPID keys auto-generated into `data/vapid.json`) + service worker |
| Auth | Username + PIN (bcrypt), HTTP-only cookie sessions (90 days) |
| Frontend | React 18 + TypeScript + Vite, installable PWA |

### API overview

```
POST   /api/auth/session                       register-or-login {username, pin, color?, inviteCode?}
POST   /api/auth/logout
GET    /api/auth/me
POST   /api/spaces                             {name, tableCount, defaultCapacity} → {code} (create group + first session)
GET    /api/me/spaces                          your groups with live stats
GET    /api/spaces/:code                       full space state (also joins you to the group)
GET    /api/spaces/:code/events                SSE live updates
POST   /api/spaces/:code/sessions              {tableCount, defaultCapacity} set up today's session (notifies members)
PATCH  /api/spaces/:code                       {status: 'idle'} end session (opener/owner, or anyone once all seats are free)
POST   /api/spaces/:code/tomorrow              pledge "I'll be back tomorrow" (no time needed)
DELETE /api/spaces/:code/tomorrow              withdraw the pledge
DELETE /api/spaces/:code                       delete the group forever (owner/admin)
POST   /api/spaces/:code/tables/:id/claims     {eta: 'now' | 'HH:MM'} join/move
POST   /api/spaces/:code/tables/:id/guests     {name, eta} reserve for a friend
PATCH  /api/spaces/:code/claims/:id            {eta} or {status: 'arrived'}
DELETE /api/spaces/:code/claims/:id            free the seat
POST   /api/spaces/:code/tables                add a table
DELETE /api/spaces/:code/tables/:id            remove an empty table
PATCH  /api/spaces/:code/tables/:id            {released?, capacity?, x?, y?, rot?}
GET    /api/admin/overview                     all users + spaces (admin)
DELETE /api/admin/users/:id                    delete a user (admin)
POST   /api/spaces/:code/votes                 {title} start a vote
DELETE /api/spaces/:code/votes/:id             remove a vote (creator/manager)
POST   /api/spaces/:code/votes/:id/options     {label} add an option (1 custom per person)
POST   /api/spaces/:code/votes/:id/ballots     {optionId} cast/change ballot (null = retract)
GET    /api/menus                              today's menus of the ETH lunch spots (cached)
GET    /api/push/key                           VAPID public key
POST   /api/push/subscribe                     {subscription} enable notifications
POST   /api/push/unsubscribe                   {endpoint}
```
