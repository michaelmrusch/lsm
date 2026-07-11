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
- **Collaborative table setup** — everyone in the session can add/remove tables, set seat counts, drag tables around the room and rotate them 90°. Tables build rightward as if the left side were a wall: pairs stacked into columns, an odd count standing rotated at the right end. Adding a table never moves anyone already seated — the rotated one flips in place into a pair with the newcomer, or a fresh rotated one appears at the right edge. The room always shows the smallest square window that keeps at least three empty grid squares between the outermost tables and every edge — the classic 8-squares view for a small block. Adding/removing tables glides to the new frame; dragging one only ever *grows* the canvas without shifting anyone's view (the new space sits off-screen until you pan). Big boards thin the grid out in clean halving steps, the walls are labelled (Fenster left, Gang right), and pinch/scroll overrides the framing with ⤢ snapping back
- **Guest seats** — reserve a seat for a friend without the app, shown as "friend of ‹member›"
- **Push notifications** — installable PWA; the whole group is notified when someone sets up the space in the morning, participants when people join/arrive/leave (on iPhone: add to Home Screen first, then enable — iOS requirement)
- **Smart summary** — "1 here · 2 coming (next ~16:30) · 5 free seats"
- **Admin panel** — the account named in `ADMIN_USERNAME` sees all spaces and users at `/admin`, can delete either (e.g. offensive names), and generates the one-time invite codes new members need to register
- **Persistent groups** — 6-character codes / shareable links that stay valid; your home screen shows each group's live status
- **Auto-reset** — sessions end themselves after 28 hours (a long study day into the next); the group stays
- **Tomorrow pledges** — the last one out is prompted to end the session; everyone who took part gets a push asking "coming back tomorrow?" — one tap signals intent (no time needed), so the first person there next morning knows what table size to grab, and fellow pledgers get a small motivational nudge
- **Votes** — WhatsApp-style polls per session: anyone starts one with a question and as many options as needed (a yes/no is just a two-option poll), everyone can add further options, results fill live progress bars, and ballots can be changed or retracted anytime. A one-tap **"Where to eat lunch?"** button starts a vote preloaded with the ETH Zentrum spots (Clausiusbar, Archimedes, Polysnack, Obere/Untere Mensa, Orient Catering) — ℹ️ shows today's live menus straight from ETH's gastronomy API (plus Orient Catering's Dürüm card), a mensa that is known closed today shows 🌙 instead, each person may suggest at most one extra place per day, and non-voters get one reminder push at 11:00. Dish names carrying a photo show a 📷 you can tap to peek at how it looks — hidden by default so the menu stays scannable. A slim chip shows just the current leader; details live in an overlay
- **Focus timer** — anyone starts a shared 45 / 60 / 90 min (or custom) round; everyone else in the session gets a push invite and the first 10% of the round to join. A circular ring drains around the countdown, everyone who joined is shown by name to pull the rest in, and when the round rings all participants get a "break time" push. One round at a time per space; the break card lingers ~10 min or until dismissed
- **Room chat** — a small chat button pinned bottom-right (like a support widget, hidden until tapped) opens a minimal message panel scoped to the people with a seat **today**: no need to spam the big WhatsApp group. Everyone in the space can read; writing needs a seat. Unread messages show as a count on the button; the 🔔/🔕 toggle in the panel mutes both the push notifications and the badge. The log is wiped with the session

## Local development

```bash
npm install
npm --prefix web install
npm run dev        # server on :3000, Vite dev server on :5173
```

Open http://localhost:5173. The SQLite database is created at `data/lsm.sqlite`.

## Deployment (Docker Compose)

`docker-compose.yml` pulls the prebuilt `mrghxst/lsm:latest` image — CI
rebuilds and pushes it on every push to `main` or `my-build`, so no local
build step is needed on the server:

```bash
git clone <this repo> lsm && cd lsm
docker compose up -d
```

The app listens on port 3000 and the SQLite database is persisted in `./data/`
on the host.

Public access and HTTPS are handled by a **Cloudflare Tunnel** (Zero Trust):
point your `cloudflared` ingress at `http://localhost:3000` and Cloudflare
terminates TLS at your hostname — no reverse proxy or certificate setup on the
server. If `cloudflared` runs on the same host, bind the app to
`127.0.0.1:3000:3000` in `docker-compose.yml` so the tunnel is the only way in.

To unlock the admin panel, uncomment `ADMIN_USERNAME` in `docker-compose.yml` and
set it to your account name, then `docker compose up -d`.

### Updating

```bash
docker compose up -d
```

`pull_policy: always` means this always fetches the latest pushed image first — no `git pull` needed on the server unless `docker-compose.yml` itself changed.

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
POST   /api/spaces/:code/votes                 {title, options[]} start a poll · {kind:'lunch'} start the lunch vote
DELETE /api/spaces/:code/votes/:id             remove a vote (creator/manager)
POST   /api/spaces/:code/votes/:id/options     {label} add an option (lunch vote: max 1 extra per person)
POST   /api/spaces/:code/votes/:id/ballots     {optionId} cast/change ballot (null = retract)
POST   /api/spaces/:code/timers                {minutes} start a focus round (invites the session)
POST   /api/spaces/:code/timers/:id/join       join — open for the first 10% of the round
DELETE /api/spaces/:code/timers/:id/join       step out (last one out stops the round)
DELETE /api/spaces/:code/timers/:id            stop a round (starter/manager) or dismiss a finished one
POST   /api/spaces/:code/chat                  {text} message the room (needs a seat today)
POST   /api/spaces/:code/chat/mute             {muted} toggle chat pushes + unread badge for yourself
GET    /api/menus                              today's menus of the lunch spots, incl. per-dish photo URLs (cached)
GET    /api/push/key                           VAPID public key
POST   /api/push/subscribe                     {subscription} enable notifications
POST   /api/push/unsubscribe                   {endpoint}
```
