# Multiplayer lobby — setup & integration

## What's new

- **`lobby.html`** — completely rewritten. Now a real multiplayer lobby instead of a 1v1-only waiting room:
  - **Up to 10 players** (minimum 2) — slider in settings.
  - **Rounds slider**, 1–100.
  - **Public / private toggle** — public lobbies can be joined by anyone who has the 6-digit code; private lobbies need the share link (or the host handing out the code directly).
  - **Shareable link** alongside the 6-digit code, with a copy button.
  - **Explicit "Start game" button** — the lobby does *not* auto-start when full. The host can keep changing settings (player cap, rounds, public/private) right up until they hit Start, and everyone else sees those changes live.
  - **Host can kick** any non-host player (button next to their name).
  - **Rejoin after refresh/disconnect** — the player's lobby is remembered in `localStorage`; reloading `lobby.html` (or `index.html`, then coming back) drops them straight back into the room, unless they were kicked.
  - **Live player list** — realtime, everyone sees joins/leaves/kicks immediately.
- **`index.html`** — the old "1v1 Match" card is now a "Multiplayer" tile + card that sends people to `lobby.html`, where both creating and joining happen.
- **`js/lobby-client.js`** (new file) — all the lobby logic (create/join/kick/settings/start/round-scores/live leaderboard/realtime/rejoin). Loaded after `js/supabase-client.js`.
- **`supabase-lobbies-migration.sql`** (new file) — new tables (`lobbies`, `lobby_players`, `lobby_round_scores`), RLS policies, and a `submit_round_score` Postgres function that atomically records a score and advances the round once everyone's finished ("wait for everyone" round-end).

The old `matches` table / 1v1 flow is left untouched in the database, so nothing breaks if you want to keep it around — the new lobby system just doesn't use it.

## Setup steps

1. **Run the migration**: Supabase dashboard → SQL Editor → paste `supabase-lobbies-migration.sql` → Run.
2. **Turn on Realtime** for the three new tables: Database → Replication → `supabase_realtime` → toggle on `lobbies`, `lobby_players`, `lobby_round_scores`.
3. Drop `lobby-client.js` into your `js/` folder, and the new `index.html` / `lobby.html` into the repo root (replacing the old versions).
4. Load-order matters: `config.js` → `js/supabase-client.js` → `js/lobby-client.js`, in that order, same as `lobby.html` already does.

## The one piece I couldn't finish for you

GitHub blocked me from reading anything inside `js/` that wasn't already linked from a page I'd fetched, so I never got to see `js/game.js` or `js/engine.js` — only `game.html`'s markup. That means I built the entire lobby (creation, settings, players, kicking, rejoin, start) end-to-end and tested the logic on paper, but the last step — making the actual **game screen** round-aware and showing the **live leaderboard** during play — needs a small patch to `game.js` that I can't write blind.

Here's exactly what that patch needs to do, using the functions already sitting in `js/lobby-client.js`:

```js
// On game.html load, when mode=lobby:
const lobbyId = new URLSearchParams(location.search).get("lobby");
const lobby = await window.LOBBY.getLobby(lobbyId);
const round = lobby.current_round;

// Round 1's road hasn't been picked yet the first time anyone loads —
// same pattern the old 1v1 code used with road_id = -1. Whoever is host
// picks it (or your existing "pick a random road" function runs once)
// and calls:
await window.LOBBY.setRoundRoad({ lobbyId, roundIndex: round - 1, roadId, roadName });

// Everyone else just reads lobby.road_ids[round - 1] instead of picking one.

// When a player finishes/guesses/runs out of budget for the round:
const updatedLobby = await window.LOBBY.submitRoundScore({ lobbyId, roundNumber: round, score });
// updatedLobby.current_round will already be round+1 if everyone's done
// ("wait for everyone"), or updatedLobby.status === "complete" if that
// was the last round.

// Live leaderboard, refresh whenever a score comes in via realtime:
const rows = await window.LOBBY.getLiveLeaderboard(lobbyId);
// rows: [{ userId, name, total, roundsPlayed, doneThisRound }, ...] sorted by total desc

window.LOBBY.openLobbyChannel(lobbyId, {
  onScoreChange: async () => { /* re-render the leaderboard from getLiveLeaderboard(lobbyId) */ },
  onLobbyChange: async (row) => {
    if (row.status === "complete") { /* show final results */ }
    else if (row.current_round !== round) { /* advance to the next round's road */ }
  },
});
```

If you paste me `js/game.js` and `js/engine.js` (or push them somewhere I can fetch, e.g. the `raw.githubusercontent.com` link straight in your next message), I'll wire this in properly — panel for the live scoreboard, round transitions, and the "waiting for others to finish this round" state — matching your existing visual style.
