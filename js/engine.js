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
