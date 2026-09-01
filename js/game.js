// ============================================================
// Game page controller. Reads ?mode=daily|endless|1v1(&match=<id>)
// from the URL and wires the shared Engine to the UI + Supabase.
// ============================================================
(async function () {
  const CONFIG = window.GAME_CONFIG;
  const params = new URLSearchParams(location.search);
  const MODE = params.get("mode") || "endless"; // 'daily' | 'endless' | '1v1'
  const MATCH_ID = params.get("match");

  let ROADS = [], roadsById = new Map();
  let score = CONFIG.STARTING_POINTS;
  let target = null, refRoad = null, gameOver = false;
  let user = null, isPlayerA = true;
  let matchChannel = null, oppLiveScore = CONFIG.STARTING_POINTS;

  const $ = (id) => document.getElementById(id);
  $("cost-ns").textContent = `−${CONFIG.COST_NORTH_SOUTH_QUESTION}`;
  $("cost-ew").textContent = `−${CONFIG.COST_EAST_WEST_QUESTION}`;
  $("cost-guess").textContent = `−${CONFIG.COST_WRONG_GUESS} if wrong`;
  $("score").textContent = score;

  const modeLabels = { daily: "Daily Road", endless: "Endless", "1v1": "1v1 Match" };
  $("mode-label").textContent = modeLabels[MODE] || "Guess the Road";

  function fmtScore() {
    $("score").textContent = score;
    $("score").classList.toggle("negative", score < 0);
    if (MODE === "1v1" && !gameOver) {
      $("you-score").textContent = score;
      if (matchChannel) window.SB.broadcastScore(matchChannel, { isPlayerA, score });
    }
  }
  function logEntry(q, a, cls) {
    const log = $("log");
    const div = document.createElement("div");
    div.className = "log-entry";
    div.innerHTML = `<div class="q">${q}</div><div class="a ${cls || ""}">${a}</div>`;
    log.appendChild(div);
  }
  function spend(n) { score -= n; fmtScore(); }

  // ---------- auth gate for modes that need it ----------
  async function requireAuthOrWarn() {
    user = await window.SB.getUser();
    if (!user && (MODE === "daily" || MODE === "1v1")) {
      $("loading-banner").textContent = "Sign in from the home screen to play this mode.";
      $("loading-banner").style.display = "block";
      return false;
    }
    return true;
  }

  // ---------- map ----------
  const map = new maplibregl.Map({
    container: "map",
    style: CONFIG.MAP_STYLE,
    center: CONFIG.MAP_CENTER,
    zoom: CONFIG.MAP_ZOOM,
    attributionControl: true,
  });
  map.addControl(new maplibregl.NavigationControl(), "top-left");

  function roadsToGeoJSON() {
    return {
      type: "FeatureCollection",
      features: ROADS.map((r) => ({
        type: "Feature",
        properties: { id: r.id, name: r.name },
        geometry: { type: "MultiLineString", coordinates: r.paths },
      })),
    };
  }

  let popup = null;
  function selectRefRoad(road) {
    refRoad = road;
    $("ref-section").style.display = "block";
    $("ref-name").textContent = road.name;
    map.setFilter("roads-selected", ["==", ["get", "id"], road.id]);
  }

  async function pickTargetForMode() {
    if (MODE === "daily") return window.Engine.pickDailyTarget(ROADS, window.Engine.todayStr());
    if (MODE === "1v1") {
      let match = await window.SB.getMatch(MATCH_ID);
      if (!match) throw new Error("Match not found");
      isPlayerA = user && match.player_a === user.id;

      // Creator assigns the road on first load (road_id -1 = not yet set).
      if (isPlayerA && match.road_id === -1) {
        const picked = window.Engine.pickRandomTarget(ROADS);
        const { data, error } = await window.SB.client
          .from("matches")
          .update({ road_id: picked.id, road_name: picked.name })
          .eq("id", MATCH_ID)
          .select()
          .single();
        if (!error) match = data;
        await setUpVersusStrip(match);
        return picked;
      }

      if (!match.player_b && user && match.player_a !== user.id) {
        match = await window.SB.joinMatch({ matchId: MATCH_ID, playerId: user.id });
      }

      // Opponent may arrive before the creator has picked a road — wait briefly.
      let tries = 0;
      while (match.road_id === -1 && tries < 20) {
        await new Promise((r) => setTimeout(r, 500));
        match = await window.SB.getMatch(MATCH_ID);
        tries++;
      }
      await setUpVersusStrip(match);
      return window.Engine.findById(ROADS, match.road_id);
    }
    return window.Engine.pickRandomTarget(ROADS); // endless
  }

  // Shows the live "You vs Opponent" strip and opens the realtime
  // channel used for both live score broadcasts and the final reveal.
  async function setUpVersusStrip(match) {
    const oppId = isPlayerA ? match.player_b : match.player_a;
    if (oppId) {
      const oppProfile = await window.SB.getProfile(oppId);
      $("opp-name").textContent = oppProfile ? oppProfile.display_name : "Opponent";
    }
    $("versus-strip").style.display = "flex";
    $("you-score").textContent = score;
    $("opp-score").textContent = oppLiveScore;

    matchChannel = window.SB.openMatchChannel(MATCH_ID, {
      onScoreBroadcast: (payload) => {
        // Only care about the opponent's own broadcasts.
        if (payload.isPlayerA !== isPlayerA) {
          oppLiveScore = payload.score;
          $("opp-score").textContent = oppLiveScore;
        }
      },
      onRowChange: (row) => {
        if (row.status === "complete" && gameOver) revealMatchResult(row);
      },
    });
    // Announce our starting score so the opponent's strip is accurate immediately.
    window.SB.broadcastScore(matchChannel, { isPlayerA, score });
  }

  async function initGame() {
    const ok = await requireAuthOrWarn();
    if (!ok) return;

    if (MODE === "daily" && user) {
      const already = await window.SB.hasPlayedDailyToday(user.id);
      if (already) {
        $("loading-banner").style.display = "none";
        $("status-banner").className = "win";
        $("status-banner").textContent = `You already played today's road. Score: ${already.score}`;
        $("status-banner").style.display = "block";
        return;
      }
    }

    target = await pickTargetForMode();
    console.log("DEBUG target (remove for real play):", target.name, target.id);
    $("reset-btn").disabled = MODE !== "endless"; // daily/1v1 are one-shot
    $("search-input").disabled = false;
  }

  map.on("load", async () => {
    try {
      const loaded = await window.Engine.loadRoads(CONFIG.DATA_FILE);
      ROADS = loaded.roads;
      roadsById = new Map(ROADS.map((r) => [r.id, r]));
    } catch (e) {
      $("loading-banner").textContent = `Couldn't load ${CONFIG.DATA_FILE}. ${e.message}`;
      console.error(e);
      return;
    }
    $("loading-banner").style.display = "none";

    map.addSource("roads", { type: "geojson", data: roadsToGeoJSON() });
    map.addLayer({ id: "roads-line", type: "line", source: "roads",
      paint: { "line-color": "#8a93a8", "line-width": ["interpolate", ["linear"], ["zoom"], 10, 1, 16, 3], "line-opacity": 0.65 } });
    map.addLayer({ id: "roads-line-hit", type: "line", source: "roads",
      paint: { "line-color": "#000", "line-width": 14, "line-opacity": 0 } });
    map.addLayer({ id: "roads-selected", type: "line", source: "roads",
      filter: ["==", ["get", "id"], -1],
      paint: { "line-color": "#4f8cff", "line-width": 4, "line-opacity": 0.95 } });

    map.on("mouseenter", "roads-line-hit", () => (map.getCanvas().style.cursor = "pointer"));
    map.on("mouseleave", "roads-line-hit", () => (map.getCanvas().style.cursor = ""));
    map.on("click", "roads-line-hit", async (e) => {
      if (gameOver) return;
      const feat = e.features[0];
      const road = roadsById.get(feat.properties.id);
      selectRefRoad(road);
      const sub = await window.Engine.suburbFor(road);
      if (popup) popup.remove();
      popup = new maplibregl.Popup({ closeButton: true })
        .setLngLat(e.lngLat)
        .setHTML(`<div class="popup-name">${road.name}</div><div class="popup-sub">${sub || "Melbourne area"}</div>`)
        .addTo(map);
    });

    await initGame();
  });

  // ---------- search ----------
  const searchInput = $("search-input"), searchResults = $("search-results");
  function doSearch(q) {
    searchResults.innerHTML = "";
    if (!q || q.length < 2) return;
    const ql = q.toLowerCase();
    const matches = ROADS.filter((r) => r.name.toLowerCase().includes(ql)).slice(0, 25);
    matches.forEach((r) => {
      const div = document.createElement("div");
      div.className = "result-item";
      div.innerHTML = `<div class="rname">${r.name}</div><div class="rsub">…</div>`;
      div.addEventListener("click", () => {
        selectRefRoad(r);
        map.flyTo({ center: r.c, zoom: 14 });
        searchResults.innerHTML = "";
        searchInput.value = "";
      });
      searchResults.appendChild(div);
      window.Engine.suburbFor(r).then((sub) => {
        const subEl = div.querySelector(".rsub");
        if (subEl) subEl.textContent = sub || "Melbourne area";
      });
    });
    if (matches.length === 0) searchResults.innerHTML = '<div class="hint">No roads found.</div>';
  }
  let searchDebounce;
  searchInput.addEventListener("input", (e) => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => doSearch(e.target.value), 150);
  });

  // ---------- questions ----------
  $("ask-ns").addEventListener("click", () => {
    if (!refRoad || gameOver) return;
    spend(CONFIG.COST_NORTH_SOUTH_QUESTION);
    logEntry(`Is the target N/S of ${refRoad.name}?`, window.Engine.compareAxis(target, refRoad, "lat"), "neg");
  });
  $("ask-ew").addEventListener("click", () => {
    if (!refRoad || gameOver) return;
    spend(CONFIG.COST_EAST_WEST_QUESTION);
    logEntry(`Is the target E/W of ${refRoad.name}?`, window.Engine.compareAxis(target, refRoad, "lon"), "neg");
  });
  $("guess-ref").addEventListener("click", async () => {
    if (!refRoad || gameOver) return;
    if (refRoad.id === target.id) {
      await winGame();
    } else {
      spend(CONFIG.COST_WRONG_GUESS);
      logEntry(`Guess: ${refRoad.name}`, "Incorrect", "neg");
    }
  });

  async function winGame() {
    gameOver = true;
    const banner = $("status-banner");
    banner.className = "win";
    banner.textContent = `🎉 Correct! It was ${target.name}. Final score: ${score}`;
    banner.style.display = "block";
    map.setPaintProperty("roads-selected", "line-color", "#6ee7b7");
    map.setFilter("roads-selected", ["==", ["get", "id"], target.id]);

    if (!user) return; // anonymous endless play just isn't saved

    if (MODE === "endless") {
      await window.SB.submitScore({ userId: user.id, mode: "endless", roadId: target.id, roadName: target.name, score });
      const avg = await window.SB.endlessAverageForRoad(target.id);
      if (avg) banner.textContent += ` — average score for this road: ${avg.average} (${avg.samples} plays)`;
    } else if (MODE === "daily") {
      await window.SB.submitScore({ userId: user.id, mode: "daily", roadId: target.id, roadName: target.name, score });
    } else if (MODE === "1v1") {
      const updated = await window.SB.submitMatchScore({ matchId: MATCH_ID, playerId: user.id, isPlayerA, score });
      if (updated && updated.score_a != null && updated.score_b != null) {
        revealMatchResult(updated); // opponent had already finished
      } else {
        banner.textContent += " — waiting on your opponent to finish...";
      }
    }
  }

  function revealMatchResult(row) {
    const oppScore = isPlayerA ? row.score_b : row.score_a;
    const banner = $("status-banner");
    const result = score > oppScore ? "You won! 🏆" : score < oppScore ? "You lost." : "It's a tie.";
    banner.textContent = `${result} Your score: ${score} — Opponent: ${oppScore}`;
    $("opp-score").textContent = oppScore;
  }

  $("reset-btn").addEventListener("click", async () => {
    if (MODE !== "endless") return; // daily/1v1 are one-shot per instance
    score = CONFIG.STARTING_POINTS;
    gameOver = false; refRoad = null;
    fmtScore();
    $("log").innerHTML = "";
    $("ref-section").style.display = "none";
    $("status-banner").style.display = "none";
    $("status-banner").className = "";
    map.setFilter("roads-selected", ["==", ["get", "id"], -1]);
    map.setPaintProperty("roads-selected", "line-color", "#4f8cff");
    target = window.Engine.pickRandomTarget(ROADS);
    console.log("DEBUG target (remove for real play):", target.name, target.id);
  });
})();
