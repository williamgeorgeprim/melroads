# Setup — Supabase & running locally

## 1. Create the Supabase project
1. Go to https://supabase.com → New project (free tier is fine).
2. **Project Settings → API** → copy the **Project URL** and the **anon public** key.
3. Paste them into `config.js` under `SUPABASE_CONFIG`.

## 2. Create the tables
1. **SQL Editor → New query**.
2. Paste the contents of `supabase-schema.sql`, click **Run**.
   (This is the only SQL file — it creates everything: profiles, scores,
   and the multiplayer lobby tables.)

## 3. Turn on Realtime
**Database → Replication → supabase_realtime** → toggle on for:
- `lobbies`
- `lobby_players`
- `lobby_round_scores`

## 4. Turn on email magic-link auth
1. **Authentication → Providers → Email** — on by default.
2. **Authentication → URL Configuration** → set **Site URL** to wherever you host this
   (`http://localhost:8000` for local testing).

## 5. Add your roads data
Drop your `roads.geojson` export into this folder.

## 6. Run it locally
```
python3 -m http.server
```
Open `http://localhost:8000/`.

## File map
- `index.html` — landing page: sign-in, mode select, leaderboard.
- `lobby.html` — create/join a multiplayer lobby (2-10 players).
- `game.html` + `js/game.js` — the game screen, mode-aware via `?mode=daily|endless|lobby`.
- `js/app.js` — everything shared by every page: Supabase (auth, scores,
  lobby system — `window.SB` and `window.LOBBY`, one client connection)
  plus the road-loading/scoring `Engine`. Loaded on `index.html`,
  `lobby.html`, and `game.html`.
- `js/game.js` — the game page's own controller. Kept separate from
  `app.js` since it runs immediately against DOM elements that only
  exist on `game.html`.
- `supabase-schema.sql` — the full schema + Row Level Security policies.

## Modes
- **Endless** — random road, no account needed. Sign in to save scores.
- **Daily** — same road for everyone each calendar day (Melbourne time),
  one attempt.
- **Lobby** — 2-10 players, 1-100 rounds, public or private, live
  leaderboard. A 1v1 game is just a 2-player lobby — there's no separate
  1v1 mode.

## Known simplifications (fine for v1, worth revisiting later)
- Anonymous (signed-out) Endless play works but doesn't save a score.
- Daily "played today" check is per-day in Melbourne time (both the DB
  unique index and the client check use `Australia/Melbourne`, not UTC).

## Updating an existing database
`supabase-schema.sql` is idempotent (`create or replace`, `if not exists`
throughout) — if you already have this database set up, you can just
re-run the whole file in the SQL Editor to pick up new features like:
- `player_totals` and `public_open_lobbies` views
- the `rematch_lobby_id` column on `lobbies`
- the widened `lobby_players` insert policy (lets a host add players to
  a rematch lobby, not just to their own row)
No data is dropped by re-running it.

