// ============================================================
// Guess the Road — shared engine.
// Pure logic, no DOM. Same code powers Daily / Endless / 1v1;
// only target selection differs between modes (see bottom).
// ============================================================
window.Engine = (function () {
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

    const roads = [];
    let nextId = 0;
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

      const clusters = new Map();
      for (let i = 0; i < n; i++) {
        const r = find(i);
        if (!clusters.has(r)) clusters.set(r, []);
        clusters.get(r).push(i);
      }

      for (const idxs of clusters.values()) {
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
        roads.push({
          id: nextId++, name, paths,
          c: [sumLon / count, sumLat / count],
          len: Math.round(totalLen),
          b: [minLon, minLat, maxLon, maxLat],
        });
      }
    }

    // M3 boundary line
    const cfg = window.GAME_CONFIG;
    const m3Names = new Set(cfg.M3_ROAD_NAMES || []);
    let m3Pts = [];
    for (const f of feats) if (m3Names.has(f.properties.name)) m3Pts = m3Pts.concat(f.geometry.coordinates);
    let M3 = null;
    if (m3Pts.length >= 2) {
      let west = m3Pts[0], east = m3Pts[0];
      for (const p of m3Pts) { if (p[0] < west[0]) west = p; if (p[0] > east[0]) east = p; }
      M3 = { A: west, B: east };
    }

    return { roads, M3 };
  }

  function m3Side(M3, lon, lat) {
    if (!M3) return null;
    const [Ax, Ay] = M3.A, [Bx, By] = M3.B;
    return (Bx - Ax) * (lat - Ay) - (By - Ay) * (lon - Ax);
  }

  function roadInsideM3(M3, road) {
    return m3Side(M3, road.c[0], road.c[1]) < 0;
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
    loadRoads, roadInsideM3, compareAxis, suburbFor,
    pickRandomTarget, pickDailyTarget, findById, todayStr,
  };
})();
