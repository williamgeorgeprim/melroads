# Fix: daily-mode date check uses UTC instead of Melbourne time

In `js/supabase-client.js`, add this helper near the top (alongside `usernameToEmail`):

```js
// Matches Engine.todayStr() in engine.js — the daily-mode date must be
// computed in Melbourne time, not UTC, or the "already played today"
// check is wrong for roughly a third of the day.
function melbourneTodayStr() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Australia/Melbourne" });
}
```

Then replace both occurrences of:

```js
const today = new Date().toISOString().slice(0, 10);
```

(one in `hasPlayedDailyToday`, one in `leaderboard`) with:

```js
const today = melbourneTodayStr();
```

That's the whole fix — the DB column (`played_on`) is already correct, only the client's comparison date was wrong.
