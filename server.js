import express from "express";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 3000;

// ====== CONFIG ======
const FF_BASE = "https://www.fuel-finder.service.gov.uk";
const TOKEN_URL = `${FF_BASE}/api/v1/oauth/generate_access_token`;
const STATIONS_URL = `${FF_BASE}/api/v1/pfs`;
const PRICES_URL = `${FF_BASE}/api/v1/pfs/fuel-prices`;

const POSTCODES_IO = "https://api.postcodes.io/postcodes";

// ====== REQUIRED ENV VARS ON RENDER ======
const FF_CLIENT_ID = process.env.FF_CLIENT_ID;
const FF_CLIENT_SECRET = process.env.FF_CLIENT_SECRET;

// ====== SIMPLE CACHES (in-memory) ======
let tokenCache = { token: null, expMs: 0 };
let stationsCache = { data: null, expMs: 0 };
let pricesCache = { data: null, expMs: 0 };

function nowMs() {
  return Date.now();
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function round2(x) {
  return Math.round(x * 100) / 100;
}

async function getToken() {
  const n = nowMs();
  if (tokenCache.token && n < tokenCache.expMs - 30_000) return tokenCache.token;

  if (!FF_CLIENT_ID || !FF_CLIENT_SECRET) {
    throw new Error("Missing FF_CLIENT_ID or FF_CLIENT_SECRET env vars");
  }

  const body = new URLSearchParams({
    client_id: FF_CLIENT_ID,
    client_secret: FF_CLIENT_SECRET,
  });

  const resp = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: body.toString(),
  });

  const text = await resp.text();
  if (!resp.ok) throw new Error(`Token error ${resp.status}: ${text.slice(0, 300)}`);

  const json = JSON.parse(text);
  const accessToken = json?.data?.access_token;
  const expiresIn = Number(json?.data?.expires_in ?? 3600);

  if (!accessToken) throw new Error(`Token missing access_token: ${text.slice(0, 300)}`);

  tokenCache.token = accessToken;
  tokenCache.expMs = nowMs() + Math.max(60, expiresIn) * 1000;
  return accessToken;
}

async function fetchBatches(url, token) {
  const all = [];
  for (let batch = 1; batch <= 200; batch++) {
    const u = new URL(url);
    u.searchParams.set("batch-number", String(batch));

    const r = await fetch(u.toString(), {
      headers: { accept: "application/json", authorization: `Bearer ${token}` },
    });

    if (!r.ok) {
      const t = await r.text();
      throw new Error(`Fuel Finder fetch error ${r.status} for ${u.pathname}: ${t.slice(0, 300)}`);
    }

    const j = await r.json();
    if (!Array.isArray(j) || j.length === 0) break;
    all.push(...j);
  }
  return all;
}

async function getStationsCached(token) {
  const n = nowMs();
  // 24h cache
  if (stationsCache.data && n < stationsCache.expMs) return stationsCache.data;

  const data = await fetchBatches(STATIONS_URL, token);
  stationsCache = { data, expMs: n + 24 * 60 * 60 * 1000 };
  return data;
}

async function getPricesCached(token) {
  const n = nowMs();
  // 5 min cache
  if (pricesCache.data && n < pricesCache.expMs) return pricesCache.data;

  const data = await fetchBatches(PRICES_URL, token);
  pricesCache = { data, expMs: n + 5 * 60 * 1000 };
  return data;
}

async function geocodePostcode(postcode) {
  const pc = encodeURIComponent(postcode.trim());
  const r = await fetch(`${POSTCODES_IO}/${pc}`, { headers: { accept: "application/json" } });
  const j = await r.json();
  if (!r.ok || !j || j.status !== 200 || !j.result) throw new Error("Invalid postcode");
  return { lat: Number(j.result.latitude), lon: Number(j.result.longitude) };
}

app.get("/health", (req, res) => {
  res.json({ ok: true, service: "fuelfinder-backend" });
});

// Main endpoint your Android app calls:
// /cheapest?postcode=FK102ET&fuel=E10&radiusKm=10&limit=10
// or /cheapest?lat=...&lon=...&fuel=E10&radiusKm=10&limit=10
app.get("/cheapest", async (req, res) => {
  try {
    const fuel = String(req.query.fuel ?? "E10").toUpperCase();
    const radiusKm = Number(req.query.radiusKm ?? 10);
    const limit = Number(req.query.limit ?? 10);

    let lat = req.query.lat != null ? Number(req.query.lat) : null;
    let lon = req.query.lon != null ? Number(req.query.lon) : null;

    const postcode = req.query.postcode ? String(req.query.postcode) : "";

    if ((!lat || !lon) && postcode) {
      const geo = await geocodePostcode(postcode);
      lat = geo.lat;
      lon = geo.lon;
    }

    if (!lat || !lon) {
      return res.status(400).json({ ok: false, error: "Provide postcode or lat/lon" });
    }

    const token = await getToken();
    const [stations, prices] = await Promise.all([
      getStationsCached(token),
      getPricesCached(token),
    ]);

    // station map
    const stationById = new Map();
    for (const s of stations) {
      const id = s.node_id;
      const loc = s.location || {};
      const sLat = Number(loc.latitude);
      const sLon = Number(loc.longitude);
      if (!id || !Number.isFinite(sLat) || !Number.isFinite(sLon)) continue;

      stationById.set(id, {
        node_id: id,
        trading_name: s.trading_name || "Unknown",
        brand_name: s.brand_name || null,
        postcode: loc.postcode || "",
        latitude: sLat,
        longitude: sLon,
      });
    }

    const results = [];
    for (const p of prices) {
      const st = stationById.get(p.node_id);
      if (!st) continue;

      const fps = Array.isArray(p.fuel_prices) ? p.fuel_prices : [];
      const match = fps.find((fp) => String(fp.fuel_type).toUpperCase() === fuel);
      if (!match || typeof match.price !== "number") continue;

      const dist = haversineKm(lat, lon, st.latitude, st.longitude);
      if (dist > radiusKm) continue;

      results.push({
        node_id: st.node_id,
        trading_name: st.trading_name,
        brand_name: st.brand_name,
        postcode: st.postcode,
        latitude: st.latitude,
        longitude: st.longitude,
        distance_km: round2(dist),
        price_ppl: match.price,
      });
    }

    results.sort((a, b) => (a.price_ppl - b.price_ppl) || (a.distance_km - b.distance_km));
    res.json({
      ok: true,
      center: { lat, lon },
      fuel,
      radiusKm,
      count: Math.min(results.length, limit),
      results: results.slice(0, Math.max(1, limit)),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
