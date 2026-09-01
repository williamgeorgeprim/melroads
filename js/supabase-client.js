// ============================================================
// Thin wrapper around Supabase — client init, auth, and the
// score/match queries every mode needs. Load this after the
// supabase-js CDN script and after config.js.
// ============================================================
(function () {
  const cfg = window.SUPABASE_CONFIG;
  const client = window.supabase.createClient(cfg.URL, cfg.ANON_KEY);

  async function getUser() {
    const { data: { user } } = await client.auth.getUser();
    return user || null;
  }

  async function getProfile(userId) {
    const { data, error } = await client
      .from("profiles")
      .select("*")
      .eq("id", userId)
      .maybeSingle();
    if (error) console.error("getProfile error", error);
    return data;
  }

  // Username -> fake internal email, so Supabase's email-based auth
  // works without ever sending real mail. Usernames are lowercased
  // and stripped of anything that isn't safe in an email local-part.
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
    const { data, error } = await client.auth.signInWithPassword({
      email: usernameToEmail(username),
      password,
    });
    return { data, error };
  }

  async function signOut() {
    await client.auth.signOut();
  }

  // Call once after login to make sure a profiles row exists.
  async function ensureProfile(user, displayName) {
    if (!user) return null;
    const existing = await getProfile(user.id);
    if (existing) return existing;
    const name = displayName || user.email.split("@")[0];
    const { data, error } = await client
      .from("profiles")
      .insert({ id: user.id, display_name: name })
      .select()
      .single();
    if (error) console.error("ensureProfile error", error);
    return data;
  }

  function onAuthChange(cb) {
    client.auth.onAuthStateChange((_event, session) => cb(session ? session.user : null));
  }

  // ---------- scores ----------

  // mode: 'daily' | 'endless' | '1v1'
  async function submitScore({ userId, mode, roadId, roadName, score }) {
    const { error } = await client.from("scores").insert({
      user_id: userId,
      mode,
      road_id: roadId,
      road_name: roadName,
      score,
    });
    if (error) console.error("submitScore error", error);
    return !error;
  }

  async function hasPlayedDailyToday(userId) {
    const today = new Date().toISOString().slice(0, 10);
    const { data, error } = await client
      .from("scores")
      .select("id, score")
      .eq("user_id", userId)
      .eq("mode", "daily")
      .eq("played_on", today)
      .maybeSingle();
    if (error) console.error("hasPlayedDailyToday error", error);
    return data || null;
  }

  async function endlessAverageForRoad(roadId) {
    const { data, error } = await client
      .from("scores")
      .select("score")
      .eq("mode", "endless")
      .eq("road_id", roadId)
      .gte("score", 0);
    if (error) {
      console.error("endlessAverageForRoad error", error);
      return null;
    }
    if (!data.length) return null;
    const avg = data.reduce((s, r) => s + r.score, 0) / data.length;
    return { average: Math.round(avg), samples: data.length };
  }

  async function leaderboard({ mode, scope = "all-time", limit = 20 }) {
    let q = client
      .from("scores")
      .select("score, road_name, created_at, profiles(display_name)")
      .eq("mode", mode)
      .order("score", { ascending: false })
      .limit(limit);
    if (scope === "daily") {
      const today = new Date().toISOString().slice(0, 10);
      q = q.eq("played_on", today);
    }
    const { data, error } = await q;
    if (error) console.error("leaderboard error", error);
    return data || [];
  }

  // ---------- 1v1 matches ----------

  async function createMatch({ playerId, roadId, roadName }) {
    const { data, error } = await client
      .from("matches")
      .insert({ player_a: playerId, road_id: roadId, road_name: roadName, status: "waiting" })
      .select()
      .single();
    if (error) console.error("createMatch error", error);
    return data;
  }

  async function joinMatch({ matchId, playerId }) {
    const { data, error } = await client
      .from("matches")
      .update({ player_b: playerId, status: "active" })
      .eq("id", matchId)
      .is("player_b", null)
      .select()
      .single();
    if (error) console.error("joinMatch error", error);
    return data;
  }

  async function getMatch(matchId) {
    const { data, error } = await client.from("matches").select("*").eq("id", matchId).maybeSingle();
    if (error) console.error("getMatch error", error);
    return data;
  }

  async function submitMatchScore({ matchId, playerId, isPlayerA, score }) {
    const patch = isPlayerA ? { score_a: score } : { score_b: score };
    const { data, error } = await client.from("matches").update(patch).eq("id", matchId).select().single();
    if (error) console.error("submitMatchScore error", error);
    // if both sides are in, mark complete
    if (data && data.score_a != null && data.score_b != null && data.status !== "complete") {
      await client.from("matches").update({ status: "complete" }).eq("id", matchId);
    }
    return data;
  }

  function subscribeToMatch(matchId, onChange) {
    return client
      .channel(`match-${matchId}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "matches", filter: `id=eq.${matchId}` },
        (payload) => onChange(payload.new)
      )
      .subscribe();
  }

  window.SB = {
    client,
    getUser,
    getProfile,
    signUpWithUsername,
    signInWithUsername,
    signOut,
    ensureProfile,
    onAuthChange,
    submitScore,
    hasPlayedDailyToday,
    endlessAverageForRoad,
    leaderboard,
    createMatch,
    joinMatch,
    getMatch,
    submitMatchScore,
    subscribeToMatch,
  };
})();
