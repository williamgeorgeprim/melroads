// ============================================================
// MelRoads shared library — Supabase (auth, scores, lobbies) and
// the game Engine, in one file. Load after config.js on every
// page. game.js (game.html only) is kept separate since it runs
// immediately against DOM elements that only exist on that page.
// ============================================================

(function () {
  const cfg = window.SUPABASE_CONFIG;
  const client = supabase.createClient(cfg.URL, cfg.ANON_KEY);

  // Matches Engine.todayStr() in engine.js — "today" for daily mode
  // is always Melbourne time, never the browser's local time / UTC.
  function melbourneTodayStr() {
    return new Date().toLocaleDateString("en-CA", { timeZone: "Australia/Melbourne" });
  }

  // ---------- auth ----------

  async function getUser() {
    const { data: { user } } = await client.auth.getUser();
    return user || null;
  }

  async function getProfile(userId) {
    const { data, error } = await client.from("profiles").select("*").eq("id", userId).maybeSingle();
    if (error) console.error("getProfile error", error);
    return data;
  }

  // Username -> fake internal email, so Supabase's email-based auth
  // works without ever sending real mail.
  function usernameToEmail(username) {
    const clean = username.trim().toLowerCase().replace(/[^a-z0-9._-]/g, "");
    return `${clean}@melroads.local`;
  }

  async function signUpWithUsername(username, password) {
    const { data, error } = await client.auth.signUp({
      email: usernameToEmail(username),
      password,
      options: { data: { username } },
    });
    if (!error && data.user) await ensureProfile(data.user, username);
    return { data, error };
  }

  async function signInWithUsername(username, password) {
    return client.auth.signInWithPassword({ email: usernameToEmail(username), password });
  }

  async function signOut() {
    await client.auth.signOut();
  }

  async function ensureProfile(user, displayName) {
    if (!user) return null;
    const existing = await getProfile(user.id);
    if (existing) return existing;
    const name = displayName || user.email.split("@")[0];
    const { data, error } = await client.from("profiles").insert({ id: user.id, display_name: name }).select().single();
    if (error) console.error("ensureProfile error", error);
    return data;
  }

  function onAuthChange(cb) {
    client.auth.onAuthStateChange((_event, session) => cb(session ? session.user : null));
  }

  // ---------- scores ----------

  // mode: 'daily' | 'endless'
  async function submitScore({ userId, mode, roadId, roadName, score }) {
    const { error } = await client.from("scores").insert({ user_id: userId, mode, road_id: roadId, road_name: roadName, score });
    if (error) console.error("submitScore error", error);
    return !error;
  }

  async function hasPlayedDailyToday(userId) {
    const { data, error } = await client
      .from("scores")
      .select("id, score")
      .eq("user_id", userId)
      .eq("mode", "daily")
      .eq("played_on", melbourneTodayStr())
      .maybeSingle();
    if (error) console.error("hasPlayedDailyToday error", error);
    return data || null;
  }

  async function endlessAverageForRoad(roadId) {
    const { data, error } = await client.from("scores").select("score").eq("mode", "endless").eq("road_id", roadId).gte("score", 0);
    if (error) { console.error("endlessAverageForRoad error", error); return null; }
    if (!data.length) return null;
    return { average: Math.round(data.reduce((s, r) => s + r.score, 0) / data.length), samples: data.length };
  }

  async function leaderboard({ mode, scope = "all-time", limit = 20 }) {
    let q = client.from("scores").select("score, road_name, created_at, profiles(display_name)").eq("mode", mode).order("score", { ascending: false }).limit(limit);
    if (scope === "daily") q = q.eq("played_on", melbourneTodayStr());
    const { data, error } = await q;
    if (error) console.error("leaderboard error", error);
    return data || [];
  }

  // ---------- lobbies (multiplayer, 2-10 players — replaces the old 1v1 mode) ----------

  const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
  function randomCode(len) {
    let out = "";
    for (let i = 0; i < len; i++) out += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    return out;
  }
  function randomToken() {
    const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let out = "";
    for (let i = 0; i < 20; i++) out += chars[Math.floor(Math.random() * chars.length)];
    return out;
  }

  async function createLobby({ hostId, maxPlayers = 4, totalRounds = 5, isPublic = false }) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const { data, error } = await client
        .from("lobbies")
        .insert({ code: randomCode(6), share_token: randomToken(), host_id: hostId, max_players: maxPlayers, total_rounds: totalRounds, is_public: isPublic })
        .select()
        .single();
      if (!error) {
        await client.from("lobby_players").insert({ lobby_id: data.id, user_id: hostId, is_host: true });
        return data;
      }
      if (error.code !== "23505") { console.error(error); return null; } // not a code collision — give up
    }
    return null;
  }

  async function getLobby(lobbyId) {
    const { data } = await client.from("lobbies").select("*").eq("id", lobbyId).single();
    return data || null;
  }
  async function getLobbyByCode(code) {
    const { data } = await client.from("lobbies").select("*").eq("code", code.toUpperCase()).single();
    return data || null;
  }
  async function getLobbyByShareToken(token) {
    const { data } = await client.from("lobbies").select("*").eq("share_token", token).single();
    return data || null;
  }

  async function getPlayers(lobbyId) {
    const { data } = await client.from("lobby_players").select("*, profiles(display_name)").eq("lobby_id", lobbyId).order("joined_at", { ascending: true });
    return data || [];
  }

  async function joinLobby({ lobbyId, userId }) {
    const { data: existing } = await client.from("lobby_players").select("*").eq("lobby_id", lobbyId).eq("user_id", userId).maybeSingle();
    if (existing) {
      if (existing.status === "kicked") return { error: "kicked" };
      if (existing.status === "left") {
        const { error } = await client.from("lobby_players").update({ status: "joined" }).eq("id", existing.id);
        if (error) return { error: error.message };
      }
      return { ok: true, rejoined: true };
    }
    const { error } = await client.from("lobby_players").insert({ lobby_id: lobbyId, user_id: userId });
    if (error) return { error: error.message && error.message.toLowerCase().includes("full") ? "full" : error.message };
    return { ok: true, rejoined: false };
  }

  async function leaveLobby({ lobbyId, userId }) {
    await client.from("lobby_players").update({ status: "left" }).eq("lobby_id", lobbyId).eq("user_id", userId);
  }

  // Works pre-game or mid-round — the round-advance RPC only counts
  // players with status = 'joined', so a kick lets the round complete
  // without waiting on the kicked player.
  async function kickPlayer({ lobbyId, userId }) {
    const { error } = await client.from("lobby_players").update({ status: "kicked" }).eq("lobby_id", lobbyId).eq("user_id", userId);
    return !error;
  }

  async function updateSettings({ lobbyId, maxPlayers, totalRounds, isPublic }) {
    const patch = {};
    if (maxPlayers !== undefined) patch.max_players = maxPlayers;
    if (totalRounds !== undefined) patch.total_rounds = totalRounds;
    if (isPublic !== undefined) patch.is_public = isPublic;
    const { error } = await client.from("lobbies").update(patch).eq("id", lobbyId);
    return !error;
  }

  async function setRoundRoad({ lobbyId, roundIndex, roadId, roadName }) {
    const lobby = await getLobby(lobbyId);
    if (!lobby) return false;
    const roadIds = [...lobby.road_ids];
    const roadNames = [...lobby.road_names];
    roadIds[roundIndex] = roadId;
    roadNames[roundIndex] = roadName;
    const { error } = await client.from("lobbies").update({ road_ids: roadIds, road_names: roadNames }).eq("id", lobbyId);
    return !error;
  }

  async function startLobby(lobbyId) {
    const { error } = await client.from("lobbies").update({ status: "active", current_round: 1 }).eq("id", lobbyId);
    return !error;
  }

  // Records a round score; once every 'joined' player has submitted,
  // the DB function advances current_round (or marks the lobby
  // 'complete' after the last round) and returns the updated row.
  async function submitRoundScore({ lobbyId, roundNumber, score }) {
    const { data, error } = await client.rpc("submit_round_score", { p_lobby_id: lobbyId, p_round: roundNumber, p_score: score });
    if (error) { console.error(error); return null; }
    return data;
  }

  // Whole-lobby total per player, from rounds completed so far.
  async function getLiveLeaderboard(lobbyId) {
    const [{ data: players }, { data: scores }, lobby] = await Promise.all([
      client.from("lobby_players").select("user_id, profiles(display_name)").eq("lobby_id", lobbyId).eq("status", "joined"),
      client.from("lobby_round_scores").select("user_id, round_number, score").eq("lobby_id", lobbyId),
      getLobby(lobbyId),
    ]);
    const currentRound = lobby ? lobby.current_round : 0;
    return (players || [])
      .map((p) => {
        const mine = (scores || []).filter((s) => s.user_id === p.user_id);
        return {
          userId: p.user_id,
          name: p.profiles ? p.profiles.display_name : "?",
          total: mine.reduce((sum, s) => sum + s.score, 0),
          roundsPlayed: mine.length,
          doneThisRound: mine.some((s) => s.round_number === currentRound),
        };
      })
      .sort((a, b) => b.total - a.total);
  }

  // One realtime channel per lobby: row changes, player changes, round
  // scores landing, plus a cheap non-DB broadcast for live in-round scores.
  function openLobbyChannel(lobbyId, { onLobbyChange, onPlayersChange, onScoreChange, onLiveScoreBroadcast } = {}) {
    return client
      .channel(`lobby:${lobbyId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "lobbies", filter: `id=eq.${lobbyId}` }, (p) => onLobbyChange && onLobbyChange(p.new))
      .on("postgres_changes", { event: "*", schema: "public", table: "lobby_players", filter: `lobby_id=eq.${lobbyId}` }, (p) => onPlayersChange && onPlayersChange(p))
      .on("postgres_changes", { event: "*", schema: "public", table: "lobby_round_scores", filter: `lobby_id=eq.${lobbyId}` }, (p) => onScoreChange && onScoreChange(p))
      .on("broadcast", { event: "live-score" }, (msg) => onLiveScoreBroadcast && onLiveScoreBroadcast(msg.payload))
      .subscribe();
  }

  function broadcastLiveScore(channel, { userId, score }) {
    channel.send({ type: "broadcast", event: "live-score", payload: { userId, score } });
  }

  // Remembers which lobby the player is in so a refresh / reopened tab
  // drops them straight back in.
  function rememberLobby(lobbyId) { try { localStorage.setItem("melroads_lobby_id", lobbyId); } catch (e) {} }
  function forgetLobby() { try { localStorage.removeItem("melroads_lobby_id"); } catch (e) {} }
  function getRememberedLobbyId() { try { return localStorage.getItem("melroads_lobby_id"); } catch (e) { return null; } }

  window.SB = {
    client,
    getUser, getProfile, signUpWithUsername, signInWithUsername, signOut, ensureProfile, onAuthChange,
    submitScore, hasPlayedDailyToday, endlessAverageForRoad, leaderboard,
  };

  window.LOBBY = {
    createLobby, getLobby, getLobbyByCode, getLobbyByShareToken, getPlayers,
    joinLobby, leaveLobby, kickPlayer, updateSettings, setRoundRoad, startLobby,
    submitRoundScore, getLiveLeaderboard, openLobbyChannel, broadcastLiveScore,
    rememberLobby, forgetLobby, getRememberedLobbyId,
  };
})();

  const suburbCache = new Map();

  function haversine(a, b) {
    const R = 6371000;
    const lat1 = (a[1] * Math.PI) / 180, lat2 = (b[1] * Math.PI) / 180;
    const dlat = ((b[1] - a[1]) * Math.PI) / 180, dlon = ((b[0] - a[0]) * Math.PI) / 180;
    const h = Math.sin(dlat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dlon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  function pathLength(coords) {
    let d = 0;
    for (let i = 0; i < coords.length - 1; i++) d += haversine(coords[i], coords[i + 1]);
    return d;
  }

  function roundPt(p, nd = 4) {
    const f = Math.pow(10, nd);
    return Math.round(p[0] * f) / f + "," + Math.round(p[1] * f) / f;
  }

  // Deterministic string hash -> [0,1). Used to seed the daily road
  // the same way for every player on a given date.
  function seededRandom(str) {
    let h = 1779033703 ^ str.length;
    for (let i = 0; i < str.length; i++) {
      h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }

  async function loadRoads(dataFile) {
    const res = await fetch(dataFile);
    if (!res.ok) throw new Error(`Failed to fetch ${dataFile}: ${res.status}`);
    const geojson = await res.json();
    const feats = geojson.features.filter(
      (f) => f.properties && f.properties.name && f.geometry && f.geometry.type === "LineString"
    );

    const byName = new Map();
    for (const f of feats) {
      const name = f.properties.name;
      if (!byName.has(name)) byName.set(name, []);
      byName.get(name).push(f);
    }

    // Melbourne's latitude range is narrow enough that one fixed scale
    // factor (rather than recomputing per-pair) is accurate to well under
    // a metre anywhere in the dataset — plenty good enough for merging.
    const REF_LAT = -37.8;
    const M_PER_DEG_LAT = 111320;
    const M_PER_DEG_LON = 111320 * Math.cos((REF_LAT * Math.PI) / 180);
    function toMetres(lon, lat) { return [lon * M_PER_DEG_LON, lat * M_PER_DEG_LAT]; }

    // Merges same-named components whose actual geometry comes within
    // mergeDistM of each other ANYWHERE along their length — not just
    // whose overall bounding boxes are close. A whole-bbox gap check
    // (the previous approach) is a poor proxy for long, bent roads: a
    // freeway can fragment at one interchange while its two bounding
    // boxes are large and technically "close" everywhere else, so the
    // real gap at that one spot gets missed. Checking actual points
    // via a spatial hash catches that reliably and stays fast even for
    // roads with thousands of vertices.
    function mergeCloseComponents(components, mergeDistM) {
      const cn = components.length;
      const cparent = Array.from({ length: cn }, (_, i) => i);
      function cfind(x) { while (cparent[x] !== x) { cparent[x] = cparent[cparent[x]]; x = cparent[x]; } return x; }
      function cunion(a, b) { const ra = cfind(a), rb = cfind(b); if (ra !== rb) cparent[ra] = rb; }

      const cellSize = mergeDistM;
      const grid = new Map();
      const cellKey = (x, y) => Math.floor(x / cellSize) + "," + Math.floor(y / cellSize);

      for (let ci = 0; ci < cn; ci++) {
        for (const path of components[ci].paths) {
          for (const [lon, lat] of path) {
            const [x, y] = toMetres(lon, lat);
            const key = cellKey(x, y);
            let bucket = grid.get(key);
            if (!bucket) grid.set(key, (bucket = []));
            bucket.push({ ci, x, y });
          }
        }
      }

      for (let ci = 0; ci < cn; ci++) {
        for (const path of components[ci].paths) {
          pointLoop:
          for (const [lon, lat] of path) {
            const [x, y] = toMetres(lon, lat);
            const cxk = Math.floor(x / cellSize), cyk = Math.floor(y / cellSize);
            for (let dx = -1; dx <= 1; dx++) {
              for (let dy = -1; dy <= 1; dy++) {
                const bucket = grid.get((cxk + dx) + "," + (cyk + dy));
                if (!bucket) continue;
                for (const p of bucket) {
                  if (p.ci === ci || cfind(p.ci) === cfind(ci)) continue;
                  if (Math.hypot(p.x - x, p.y - y) <= mergeDistM) {
                    cunion(ci, p.ci);
                    continue pointLoop;
                  }
                }
              }
            }
          }
        }
      }

      const merged = new Map();
      for (let i = 0; i < cn; i++) {
        const r = cfind(i);
        if (!merged.has(r)) merged.set(r, []);
        merged.get(r).push(components[i]);
      }
      return Array.from(merged.values());
    }

    const roads = [];
    let nextId = 0;
    const MERGE_DIST_M = (window.GAME_CONFIG && window.GAME_CONFIG.DIVIDED_ROAD_MERGE_DISTANCE_M) || 80;

    for (const [name, segs] of byName) {
      const n = segs.length;
      const parent = Array.from({ length: n }, (_, i) => i);
      function find(x) {
        while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
        return x;
      }
      function union(a, b) { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; }

      const endpointMap = new Map();
      for (let i = 0; i < n; i++) {
        const coords = segs[i].geometry.coordinates;
        if (!coords || coords.length < 2) continue;
        const a = roundPt(coords[0]), b = roundPt(coords[coords.length - 1]);
        if (!endpointMap.has(a)) endpointMap.set(a, []);
        if (!endpointMap.has(b)) endpointMap.set(b, []);
        endpointMap.get(a).push(i);
        endpointMap.get(b).push(i);
      }
      for (const idxs of endpointMap.values()) for (let j = 1; j < idxs.length; j++) union(idxs[0], idxs[j]);

      const clusterIdxs = new Map();
      for (let i = 0; i < n; i++) {
        const r = find(i);
        if (!clusterIdxs.has(r)) clusterIdxs.set(r, []);
        clusterIdxs.get(r).push(i);
      }

      // Build one component per connected cluster (this is where divided
      // carriageways still show up as separate components, since they
      // don't share endpoints with their opposite side).
      const components = [];
      for (const idxs of clusterIdxs.values()) {
        const paths = [];
        let totalLen = 0, sumLon = 0, sumLat = 0, count = 0;
        let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
        for (const i of idxs) {
          const coords = segs[i].geometry.coordinates;
          paths.push(coords);
          totalLen += pathLength(coords);
          for (const [lon, lat] of coords) {
            sumLon += lon; sumLat += lat; count++;
            if (lon < minLon) minLon = lon;
            if (lon > maxLon) maxLon = lon;
            if (lat < minLat) minLat = lat;
            if (lat > maxLat) maxLat = lat;
          }
        }
        components.push({ paths, len: totalLen, sumLon, sumLat, count, b: [minLon, minLat, maxLon, maxLat] });
      }

      // Second pass: merge same-named components whose real geometry
      // touches (or nearly touches) somewhere along their length —
      // median-divided roads and freeway interchanges — without pulling
      // in same-named components that are genuinely far apart (a
      // different street with the same name in another suburb).
      const mergedGroups = mergeCloseComponents(components, MERGE_DIST_M);

      for (const group of mergedGroups) {
        let paths = [], totalLen = 0, sumLon = 0, sumLat = 0, count = 0;
        let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
        for (const c of group) {
          paths = paths.concat(c.paths);
          totalLen += c.len;
          sumLon += c.sumLon; sumLat += c.sumLat; count += c.count;
          if (c.b[0] < minLon) minLon = c.b[0];
          if (c.b[1] < minLat) minLat = c.b[1];
          if (c.b[2] > maxLon) maxLon = c.b[2];
          if (c.b[3] > maxLat) maxLat = c.b[3];
        }
        roads.push({
          id: nextId++, name, paths,
          c: [sumLon / count, sumLat / count],
          len: Math.round(totalLen),
          b: [minLon, minLat, maxLon, maxLat],
        });
      }
    }

    return { roads };
  }

  function compareAxis(t, ref, axis) {
    if (axis === "lat") {
      if (t.b[3] < ref.b[1]) return "South";
      if (t.b[1] > ref.b[3]) return "North";
      return "Intersecting";
    } else {
      if (t.b[2] < ref.b[0]) return "West";
      if (t.b[0] > ref.b[2]) return "East";
      return "Intersecting";
    }
  }

  async function suburbFor(road) {
    const key = road.id;
    if (suburbCache.has(key)) return suburbCache.get(key);
    const [lon, lat] = road.c;
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=15&addressdetails=1`
      );
      const data = await res.json();
      const addr = data.address || {};
      const sub = addr.suburb || addr.city_district || addr.town || addr.village || addr.municipality || null;
      suburbCache.set(key, sub);
      return sub;
    } catch (e) {
      suburbCache.set(key, null);
      return null;
    }
  }

  // ---------- target selection strategies ----------

  function eligiblePool(roads) {
    const cfg = window.GAME_CONFIG;
    const candidates = roads.filter((r) => r.len >= cfg.MIN_TARGET_LENGTH_M);
    return candidates.length ? candidates : roads;
  }

  function pickRandomTarget(roads) {
    const pool = eligiblePool(roads);
    return pool[Math.floor(Math.random() * pool.length)];
  }

  // Same road for every player on the same calendar date (Australia/Melbourne).
  function pickDailyTarget(roads, dateStr) {
    const pool = eligiblePool(roads).slice().sort((a, b) => a.id - b.id); // stable order
    const r = seededRandom(dateStr);
    return pool[Math.floor(r * pool.length)];
  }

  function findById(roads, id) {
    return roads.find((r) => r.id === id) || null;
  }

  function todayStr() {
    // en-CA gives YYYY-MM-DD directly
    return new Date().toLocaleDateString("en-CA", { timeZone: "Australia/Melbourne" });
  }

  return {
    loadRoads, compareAxis, suburbFor,
    pickRandomTarget, pickDailyTarget, findById, todayStr,
  };
})();
