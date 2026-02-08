import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
app.use(cors());
app.use(express.json());

// -------------------------
// Config (Render-safe)
// -------------------------
const PORT = Number(process.env.PORT || 3000);

// From your docs, the API calls look like:
// https://api.fuelfinder.service.gov.uk/v1/prices?...
// so default API_BASE to that host.
const API_BASE =
  (process.env.API_BASE || "https://api.fuelfinder.service.gov.uk").replace(/\/+$/, "");

// Token endpoint: docs show path "/oauth2/token" (host not shown in the snippet),
// so we default to API_BASE + "/oauth2/token", but you can override TOKEN_URL if needed.
const TOKEN_URL =
  (process.env.TOKEN_URL || `${API_BASE}/oauth2/token`).replace(/\/+$/, "");

// OAuth client credentials
const CLIENT_ID = process.env.CLIENT_ID || "";
const CLIENT_SECRET = process.env.CLIENT_SECRET || "";
const SCOPE = process.env.SCOPE || "fuelfinder.read";

// Stations endpoint path can vary by API naming (stations vs forecourts).
// Default guess: "/v1/stations" (override in Render env if needed).
const STATIONS_PATH = (process.env.STATIONS_PATH || "/v1/stations").startsWith("/")
  ? (process.env.STATIONS_PATH || "/v1/stations")
  : `/${process.env.STATIONS_PATH || "v1/stations"}`;

// Prices endpoint default
const PRICES_PATH = (process.env.PRICES_PATH || "/v1/prices").startsWith("/")
  ? (process.env.PRICES_PATH || "/v1/prices")
  : `/${process.env.PRICES_PATH || "v1/prices"}`;

// -------------------------
// Simple in-memory cache
// -------------------------
const cache = new Map(); // key -> { expiresAt:number, value:any }

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(key, value, ttlMs) {
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

// Cache TTLs (from your guidelines)
const TTL_STATIONS_MS = 60 * 60 * 1000; // 1 hour
const TTL_PRICES_MS = 15 * 60 * 1000;   // 15 min

// -------------------------
// OAuth token helper (cached)
// -------------------------
let tokenCache = { token: null, expiresAt: 0 };

async function getAccessToken() {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error("Missing CLIENT_ID or CLIENT_SECRET");
  }

  // If still valid, reuse
  if (tokenCache.token && Date.now() < tokenCache.expiresAt) {
    return tokenCache.token;
  }

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    scope: SCOPE,
  });

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // leave json null
  }

  if (!res.ok) {
    const msg = json?.error_description || json?.error || text || `HTTP ${res.status}`;
    throw new Error(`Token request failed (${res.status}): ${msg}`);
  }

  const accessToken = json?.access_token;
  const expiresIn = Number(json?.expires_in || 3600);

  if (!accessToken) {
    throw new Error("Token response missing access_token");
  }

  // refresh a bit early (30s)
  tokenCache.token = accessToken;
  tokenCache.expiresAt = Date.now() + Math.max(0, (expiresIn - 30) * 1000);

  return accessToken;
}

// -------------------------
// Routes
// -------------------------

// Root health
app.get("/", (req, res) => {
  res.json({ ok: true, service: "fuel-finder-backend" });
});

// Render health (what you were hitting)
app.get("/index/status", (req, res) => {
  res.json({ ok: true, service: "fuel-finder-backend" });
});

// Stations proxy
app.get("/stations", async (req, res) => {
  try {
    const cacheKey = `stations:${STATIONS_PATH}`;
    const cached = cacheGet(cacheKey);
    if (cached) return res.json(cached);

    const token = await getAccessToken();

    const upstreamUrl = `${API_BASE}${STATIONS_PATH}`;
    const upstream = await fetch(upstreamUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });

    const raw = await upstream.text();
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      data = { raw };
    }

    if (!upstream.ok) {
      return res.status(upstream.status).json({
        ok: false,
        error: `Upstream stations failed (${upstream.status})`,
        details: data,
        upstreamUrl,
      });
    }

    // Cache for 1 hour
    cacheSet(cacheKey, data, TTL_STATIONS_MS);

    res.json(data);
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err?.message || String(err),
      hint:
        "If you see ENOTFOUND, the hostname is wrong. Check API_BASE/TOKEN_URL env vars.",
      debug: {
        API_BASE,
        TOKEN_URL,
        STATIONS_PATH,
      },
    });
  }
});

// Prices proxy example: /prices?fuel_type=unleaded
app.get("/prices", async (req, res) => {
  try {
    const token = await getAccessToken();

    const qs = new URLSearchParams(req.query).toString();
    const upstreamUrl = `${API_BASE}${PRICES_PATH}${qs ? `?${qs}` : ""}`;

    const cacheKey = `prices:${upstreamUrl}`;
    const cached = cacheGet(cacheKey);
    if (cached) return res.json(cached);

    const upstream = await fetch(upstreamUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });

    const raw = await upstream.text();
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      data = { raw };
    }

    if (!upstream.ok) {
      return res.status(upstream.status).json({
        ok: false,
        error: `Upstream prices failed (${upstream.status})`,
        details: data,
        upstreamUrl,
      });
    }

    // Cache for 15 minutes
    cacheSet(cacheKey, data, TTL_PRICES_MS);

    res.json(data);
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err?.message || String(err),
      debug: { API_BASE, TOKEN_URL, PRICES_PATH },
    });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  if (!CLIENT_ID || !CLIENT_SECRET) {
    console.log("❌ Missing CLIENT_ID or CLIENT_SECRET");
  }
  console.log(`API_BASE=${API_BASE}`);
  console.log(`TOKEN_URL=${TOKEN_URL}`);
  console.log(`STATIONS_PATH=${STATIONS_PATH}`);
});
