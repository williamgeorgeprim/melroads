// js/lobby-client.js
//
// Multiplayer lobby layer for MelRoads. Loaded after config.js and
// supabase-client.js (needs the same SUPABASE_URL / SUPABASE_ANON_KEY
// globals config.js already defines). Exposes window.LOBBY.
//
// This creates its own lightweight Supabase client so it doesn't need
// to know the internals of js/supabase-client.js — auth sessions are
// shared automatically (supabase-js keeps the session in localStorage),
// so window.SB.getUser() and LOBBY calls see the same signed-in user.

(function () {
  const client = supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);

  const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
  function randomCode(len) {
    let out = "";
    for (let i = 0; i < len; i++) out += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    return out;
  }
  function randomToken() {
    // 20 chars, URL-safe — used in the shareable link (?share=TOKEN)
    const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let out = "";
    for (let i = 0; i < 20; i++) out += chars[Math.floor(Math.random() * chars.length)];
    return out;
  }

  // ---------- create ----------
  async function createLobby({ hostId, maxPlayers = 4, totalRounds = 5, isPublic = false }) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = randomCode(6);
      const share_token = randomToken();
      const { data, error } = await client
        .from("lobbies")
        .insert({
          code,
          share_token,
          host_id: hostId,
          max_players: maxPlayers,
          total_rounds: totalRounds,
          is_public: isPublic,
        })
        .select()
        .single();

      if (!error) {
        await client.from("lobby_players").insert({ lobby_id: data.id, user_id: hostId, is_host: true });
        return data;
      }
      // unique_violation on code/share_token — try again with a new code
      if (error.code !== "23505") { console.error(error); return null; }
    }
    return null;
  }

  // ---------- lookups ----------
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

  // ---------- players ----------
  async function getPlayers(lobbyId) {
    const { data } = await client
      .from("lobby_players")
      .select("*, profiles(display_name)")
      .eq("lobby_id", lobbyId)
      .order("joined_at", { ascending: true });
    return data || [];
  }

  async function joinLobby({ lobbyId, userId }) {
    // Rejoining after a kick isn't allowed; rejoining after a disconnect
    // (row still says 'joined', or says 'left') is fine.
    const { data: existing } = await client
      .from("lobby_players")
      .select("*")
      .eq("lobby_id", lobbyId)
      .eq("user_id", userId)
      .maybeSingle();

    if (existing) {
      if (existing.status === "kicked") return { error: "kicked" };
      if (existing.status === "left") {
        const { error } = await client.from("lobby_players").update({ status: "joined" }).eq("id", existing.id);
        if (error) return { error: error.message };
      }
      return { ok: true, rejoined: true };
    }

    const { error } = await client.from("lobby_players").insert({ lobby_id: lobbyId, user_id: userId });
    if (error) {
      if (error.message && error.message.toLowerCase().includes("full")) return { error: "full" };
      return { error: error.message };
    }
    return { ok: true, rejoined: false };
  }

  async function leaveLobby({ lobbyId, userId }) {
    await client.from("lobby_players").update({ status: "left" }).eq("lobby_id", lobbyId).eq("user_id", userId);
  }

  async function kickPlayer({ lobbyId, userId }) {
    const { error } = await client
      .from("lobby_players")
      .update({ status: "kicked" })
      .eq("lobby_id", lobbyId)
      .eq("user_id", userId);
    return !error;
  }

  // ---------- host settings ----------
  async function updateSettings({ lobbyId, maxPlayers, totalRounds, isPublic }) {
    const patch = {};
    if (maxPlayers !== undefined) patch.max_players = maxPlayers;
    if (totalRounds !== undefined) patch.total_rounds = totalRounds;
    if (isPublic !== undefined) patch.is_public = isPublic;
    const { error } = await client.from("lobbies").update(patch).eq("id", lobbyId);
    return !error;
  }

  // road_ids/road_names get filled in as each round's road is picked
  // (typically the host's game.html assigns round 1's road right before
  // starting, same pattern the old 1v1 code used with road_id = -1).
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

  // ---------- rounds / scoring ----------
  // Call this the moment a player finishes/guesses/runs out of budget for
  // the current round. It records the score and, once every player still
  // in the lobby has submitted for that round, the lobby's current_round
  // advances automatically (or status becomes 'complete' after the last round).
  async function submitRoundScore({ lobbyId, roundNumber, score }) {
    const { data, error } = await client.rpc("submit_round_score", {
      p_lobby_id: lobbyId,
      p_round: roundNumber,
      p_score: score,
    });
    if (error) { console.error(error); return null; }
    return data; // updated lobby row
  }

  // Live, whole-lobby leaderboard: total score per player summed across
  // rounds played so far, plus whether they've finished the *current* round.
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
        const total = mine.reduce((sum, s) => sum + s.score, 0);
        const doneThisRound = mine.some((s) => s.round_number === currentRound);
        return {
          userId: p.user_id,
          name: p.profiles ? p.profiles.display_name : "?",
          total,
          roundsPlayed: mine.length,
          doneThisRound,
        };
      })
      .sort((a, b) => b.total - a.total);
  }

  // ---------- realtime ----------
  // Fires on any change to the lobby row, its player list, or round scores —
  // hand it one callback and re-fetch whatever you need inside it.
  function openLobbyChannel(lobbyId, { onLobbyChange, onPlayersChange, onScoreChange } = {}) {
    const channel = client
      .channel(`lobby:${lobbyId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "lobbies", filter: `id=eq.${lobbyId}` }, (payload) => {
        onLobbyChange && onLobbyChange(payload.new);
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "lobby_players", filter: `lobby_id=eq.${lobbyId}` }, (payload) => {
        onPlayersChange && onPlayersChange(payload);
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "lobby_round_scores", filter: `lobby_id=eq.${lobbyId}` }, (payload) => {
        onScoreChange && onScoreChange(payload);
      })
      .subscribe();
    return channel; // caller can client.removeChannel(channel) on unload if desired
  }

  // ---------- rejoin-after-refresh helper ----------
  // Call rememberLobby() once a player is in a lobby, and tryResumeLobby()
  // on page load (before showing the join/create screen) to bounce them
  // straight back in if they refreshed or the tab crashed.
  function rememberLobby(lobbyId) {
    try { localStorage.setItem("melroads_lobby_id", lobbyId); } catch (e) {}
  }
  function forgetLobby() {
    try { localStorage.removeItem("melroads_lobby_id"); } catch (e) {}
  }
  function getRememberedLobbyId() {
    try { return localStorage.getItem("melroads_lobby_id"); } catch (e) { return null; }
  }

  window.LOBBY = {
    createLobby,
    getLobby,
    getLobbyByCode,
    getLobbyByShareToken,
    getPlayers,
    joinLobby,
    leaveLobby,
    kickPlayer,
    updateSettings,
    setRoundRoad,
    startLobby,
    submitRoundScore,
    getLiveLeaderboard,
    openLobbyChannel,
    rememberLobby,
    forgetLobby,
    getRememberedLobbyId,
  };
})();
