# Setup — Supabase & running locally

## 1. Create the Supabase project
1. Go to https://supabase.com → New project (free tier is fine).
2. Once it's up: **Project Settings → API** → copy the **Project URL** and the **anon public** key.
3. Paste them into `config.js` under `SUPABASE_CONFIG`.

## 2. Create the tables
1. In Supabase: **SQL Editor → New query**.
2. Paste the contents of `supabase-schema.sql`, click **Run**.

## 3. Turn on email magic-link auth
1. **Authentication → Providers → Email** — should be on by default.
2. **Authentication → URL Configuration** — set **Site URL** to wherever you'll host this
   (for local testing, `http://localhost:8000`; update this later to your Cloudflare URL).

## 4. Turn on Realtime for the matches table (needed for 1v1)
1. **Database → Replication → supabase_realtime** → toggle on for the `matches` table.

## 5. Add your roads data
Drop your `roads.geojson` export into this folder (same as before — nothing changed here).

## 6. Run it locally
```
python3 -m http.server
```
Open `http://localhost:8000/` — you should see the new landing page with the three modes.

## What's new vs. the old single-file version
- `index.html` — landing page: sign-in, mode select, leaderboard.
- `game.html` + `js/game.js` — the actual game screen, now mode-aware via `?mode=`.
- `js/engine.js` — all the road-loading/scoring logic, pulled out of the old inline
  `<script>` so daily/endless/1v1 can share it.
- `js/supabase-client.js` — every Supabase call (auth, scores, matches) in one place.
- `supabase-schema.sql` — the three tables + Row Level Security policies.

Nothing about `config.js`'s scoring/map settings changed — same knobs as before.

## Known simplifications (fine for a v1, worth revisiting later)
- 1v1 scoring reveal uses a short poll after you finish (`subscribeToMatch`), not a live
  in-progress view of your opponent's questions — good enough for "who got the better score."
- Anonymous (signed-out) Endless play works but doesn't save a score or count toward averages.
- Daily "played today" check is per-day in Melbourne time, enforced by both a DB unique index
  and a client-side check.
