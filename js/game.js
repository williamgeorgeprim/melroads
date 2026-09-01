// ============================================================
// Game page controller. Reads ?mode=daily|endless|lobby(&lobby=<id>)
// from the URL and wires the shared Engine to the UI + Supabase.
// ============================================================
(async function () {
  const CONFIG = window.GAME_CONFIG;
  const params = new URLSearchParams(location.search);
  const MODE = params.get("mode") || "endless"; // 'daily' | 'endless' | 'lobby'
  const LOBBY_ID = params.get("lobby");

  let ROADS = [], roadsById = new Map();
  let score = CONFIG.STARTING_POINTS;
  let target = null, refRoad = null, gameOver = false;
  let user = null, isHost = false;
  let lobbyChannel = null, round = 0, lobbyTotalRounds = 1;
  let liveScores = new Map();      // userId -> in-progress score for the current round
  let lastLeaderboardRows = [];    // cached result of the last DB leaderboard fetch

  const $ = (id) => document.getElementById(id);
  $("cost-ns").textContent = `−${CONFIG.COST_NORTH_SOUTH_QUESTION}`;
  $("cost-ew").textContent = `−${CONFIG.COST_EAST_WEST_QUESTION}`;
  $("cost-guess").textContent = `−${CONFIG.COST_WRONG_GUESS} if wrong`;
  $("score").textContent = score;

  const modeLabels = { daily: "Daily Road", endless: "Endless", lobby: "Lobby Match" };
  $("mode-label").textContent = modeLabels[MODE] || "Guess the Road";
  const isOneShot = MODE !== "endless"; // daily/lobby: one road per round, no reset button

  function fmtScore() {
    $("score").textContent = score;
    $("score").classList.toggle("negative", score < 0);
    if (MODE === "lobby" && !gameOver && lobbyChannel && user) {
      window.LOBBY.broadcastLiveScore(lobbyChannel, { userId: user.id, score });
    }
  }
  function logEntry(q, a, cls) {
    const div = document.createElement("div");
    div.className = "log-entry";
    div.innerHTML = `<div class="q">${q}</div><div class="a ${cls || ""}">${a}</div>`;
    $("log").appendChild(div);
  }
  function spend(n) { score -= n; fmtScore(); }

  async function requireAuthOrWarn() {
    user = await window.SB.getUser();
    if (!user && MODE !== "endless") {
      $("loading-banner").textContent = "Sign in from the home screen to play this mode.";
      $("loading-banner").style.display = "block";
      return false;
    }
    return true;
  }

  // ---------- map ----------
  const map = new maplibregl.Map({
    container: "map", style: CONFIG.MAP_STYLE, center: CONFIG.MAP_CENTER, zoom: CONFIG.MAP_ZOOM, attributionControl: true,
  });
  map.addControl(new maplibregl.NavigationControl(), "top-left");

  function roadsToGeoJSON() {
    return {
      type: "FeatureCollection",
      features: ROADS.map((r) => ({ type: "Feature", properties: { id: r.id, name: r.name }, geometry: { type: "MultiLineString", coordinates: r.paths } })),
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

    if (MODE === "lobby") {
      let lobby = await window.LOBBY.getLobby(LOBBY_ID);
      if (!lobby) throw new Error("Lobby not found");
      round = lobby.current_round;
      lobbyTotalRounds = lobby.total_rounds;
      isHost = user && lobby.host_id === user.id;
      const roundIndex = round - 1;

      // Host assigns this round's road if nobody has yet.
      if (isHost && lobby.road_ids[roundIndex] == null) {
        const picked = window.Engine.pickRandomTarget(ROADS);
        await window.LOBBY.setRoundRoad({ lobbyId: LOBBY_ID, roundIndex, roadId: picked.id, roadName: picked.name });
        await setUpLobbyPanel(lobby);
        return picked;
      }

      // Non-host (or host re-entering) waits briefly for the road to appear.
      let tries = 0;
      while (lobby.road_ids[roundIndex] == null && tries < 20) {
        await new Promise((r) => setTimeout(r, 500));
        lobby = await window.LOBBY.getLobby(LOBBY_ID);
        tries++;
      }
      await setUpLobbyPanel(lobby);
      return window.Engine.findById(ROADS, lobby.road_ids[roundIndex]);
    }

    return window.Engine.pickRandomTarget(ROADS); // endless
  }

  // ---------- lobby mode: live leaderboard panel + round transitions ----------
  async function setUpLobbyPanel(lobby) {
    $("lobby-panel").style.display = "flex";
    $("lobby-round-label").textContent = `Round ${round} / ${lobbyTotalRounds}`;
    liveScores.clear();
    await refreshLeaderboard();

    if (!lobbyChannel) {
      lobbyChannel = window.LOBBY.openLobbyChannel(LOBBY_ID, {
        onScoreChange: refreshLeaderboard,
        onLiveScoreBroadcast: (payload) => { liveScores.set(payload.userId, payload.score); renderLeaderboard(); },
        onLobbyChange: async (row) => {
          if (row.status === "complete") await showLobbyResults();
          else if (row.current_round > round) await advanceLobbyRound(row.current_round);
        },
        onPlayersChange: async () => {
          const players = await window.LOBBY.getPlayers(LOBBY_ID);
          const me = players.find((p) => p.user_id === user.id);
          if (me && me.status === "kicked") {
            alert("You were removed from this lobby by the host.");
            location.href = "index.html";
            return;
          }
          await refreshLeaderboard();
        },
      });
    }
    window.LOBBY.broadcastLiveScore(lobbyChannel, { userId: user.id, score });
  }

  async function refreshLeaderboard() {
    lastLeaderboardRows = await window.LOBBY.getLiveLeaderboard(LOBBY_ID);
    renderLeaderboard();
  }

  function renderLeaderboard() {
    const list = $("lobby-leaderboard");
    if (!list) return;
    const rows = lastLeaderboardRows
      .map((r) => {
        const inRoundLive = r.doneThisRound ? 0 : (liveScores.has(r.userId) ? liveScores.get(r.userId) : CONFIG.STARTING_POINTS);
        return { ...r, displayScore: r.total + inRoundLive };
      })
      .sort((a, b) => b.displayScore - a.displayScore);

    list.innerHTML = rows
      .map((r) => {
        const isMe = user && r.userId === user.id;
        const kickBtn = isHost && !isMe ? `<button class="lb-kick" data-kick="${r.userId}" title="Remove from lobby">✕</button>` : "";
        return `<div class="lb-row${isMe ? " me" : ""}"><span class="lb-name">${r.name}${r.doneThisRound ? " ✓" : ""}</span><span class="lb-live${r.displayScore < 0 ? " negative" : ""}">${r.displayScore}</span>${kickBtn}</div>`;
      })
      .join("");

    list.querySelectorAll("[data-kick]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!confirm("Remove this player from the lobby?")) return;
        await window.LOBBY.kickPlayer({ lobbyId: LOBBY_ID, userId: btn.dataset.kick });
      });
    });
  }

  function resetRoundUI() {
    fmtScore();
    $("log").innerHTML = "";
    $("ref-section").style.display = "none";
    $("status-banner").style.display = "none";
    $("status-banner").className = "";
    map.setFilter("roads-selected", ["==", ["get", "id"], -1]);
    map.setPaintProperty("roads-selected", "line-color", "#4f8cff");
  }

  async function advanceLobbyRound(newRound) {
    round = newRound;
    score = CONFIG.STARTING_POINTS;
    gameOver = false; refRoad = null;
    resetRoundUI();
    target = await pickTargetForMode(); // re-enters the lobby branch, which also refreshes the panel
    $("search-input").disabled = false;
  }

  async function showLobbyResults() {
    gameOver = true;
    window.LOBBY.forgetLobby();
    const rows = await window.LOBBY.getLiveLeaderboard(LOBBY_ID);
    const banner = $("status-banner");
    banner.className = "win";
    banner.textContent = `🏁 Lobby complete! ${rows.map((r, i) => `${i + 1}. ${r.name} — ${r.total}`).join(" · ")}`;
    banner.style.display = "block";
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
    $("reset-btn").disabled = isOneShot;
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
    map.addLayer({ id: "roads-line", type: "line", source: "roads", paint: { "line-color": "#8a93a8", "line-width": ["interpolate", ["linear"], ["zoom"], 10, 1, 16, 3], "line-opacity": 0.65 } });
    map.addLayer({ id: "roads-line-hit", type: "line", source: "roads", paint: { "line-color": "#000", "line-width": 14, "line-opacity": 0 } });
    map.addLayer({ id: "roads-selected", type: "line", source: "roads", filter: ["==", ["get", "id"], -1], paint: { "line-color": "#4f8cff", "line-width": 4, "line-opacity": 0.95 } });

    map.on("mouseenter", "roads-line-hit", () => (map.getCanvas().style.cursor = "pointer"));
    map.on("mouseleave", "roads-line-hit", () => (map.getCanvas().style.cursor = ""));
    map.on("click", "roads-line-hit", async (e) => {
      if (gameOver) return;
      const road = roadsById.get(e.features[0].properties.id);
      selectRefRoad(road);
      const sub = await window.Engine.suburbFor(road);
      if (popup) popup.remove();
      popup = new maplibregl.Popup({ closeButton: true }).setLngLat(e.lngLat)
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
    } else if (MODE === "lobby") {
      const updated = await window.LOBBY.submitRoundScore({ lobbyId: LOBBY_ID, roundNumber: round, score });
      if (!updated) banner.textContent += " — couldn't submit your score, try refreshing.";
      else if (updated.status === "complete") await showLobbyResults();
      else if (updated.current_round > round) await advanceLobbyRound(updated.current_round);
      else banner.textContent += " — waiting on other players to finish this round...";
    }
  }

  $("leave-lobby-btn").addEventListener("click", async () => {
    if (MODE !== "lobby" || !user) return;
    if (!confirm("Leave this game? You'll drop out of the lobby for everyone else.")) return;
    await window.LOBBY.leaveLobby({ lobbyId: LOBBY_ID, userId: user.id });
    window.LOBBY.forgetLobby();
    location.href = "index.html";
  });

  $("reset-btn").addEventListener("click", () => {
    if (isOneShot) return; // daily/lobby are one-shot per round
    score = CONFIG.STARTING_POINTS;
    gameOver = false; refRoad = null;
    resetRoundUI();
    target = window.Engine.pickRandomTarget(ROADS);
    console.log("DEBUG target (remove for real play):", target.name, target.id);
  });
})();
