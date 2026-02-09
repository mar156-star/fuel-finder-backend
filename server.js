// server.js
import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ===== Config =====
const MOCK_MODE = String(process.env.MOCK_MODE || "").toLowerCase() === "true";

// Put the *real* Fuel Finder API base + token url here when you get them.
// Right now your values are pointing to a hostname that does not exist.
const API_BASE = process.env.API_BASE || "https://api.fuelfinder.service.gov.uk";
const TOKEN_URL = process.env.TOKEN_URL || `${API_BASE}/oauth2/token`;
const STATIONS_PATH = process.env.STATIONS_PATH || "/v1/stations";

// OAuth client credentials (keep these ONLY in env vars)
const CLIENT_ID = process.env.CLIENT_ID || "";
const CLIENT_SECRET = process.env.CLIENT_SECRET || "";
const SCOPE = process.env.SCOPE || "fuelfinder.read";

// Cache (stations don’t change often)
const STATIONS_CACHE_MS = Number(process.env.STATIONS_CACHE_MS || 60 * 60 * 1000); // 1 hour
let stationsCache = { at: 0, data: null };

// ===== Mock data =====
// (Enough for your app UI. Replace/expand later if you want.)
const MOCK_STATIONS = [
  {
    id: "MOCK-GB-0001",
    name: "Mock Petrol Station 1",
    brand: "MockBrand",
    location: { lat: 51.5074, lon: -0.1278 },
    address: "London (mock)",
    fuels: ["unleaded", "diesel"],
    updated_at: new Date().toISOString(),
  },
  {
    id: "MOCK-GB-0002",
    name: "Mock Petrol Station 2",
    brand: "MockBrand",
    location: { lat: 53.4808, lon: -2.2426 },
    address: "Manchester (mock)",
    fuels: ["unleaded", "diesel", "super_unleaded"],
    updated_at: new Date().toISOString(),
  },
];

// ===== Helpers =====
function safeJson(res) {
  return res.text().then((t) => {
    try {
      return JSON.parse(t);
    } catch {
      return { raw: t };
    }
  });
}

async function getAccessToken() {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error("Missing CLIENT_ID or CLIENT_SECRET");
  }

  const body = new URLSearchParams();
  body.set("grant_type", "client_credentials");
  body.set("client_id", CLIENT_ID);
  body.set("client_secret", CLIENT_SECRET);
  if (SCOPE) body.set("scope", SCOPE);

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    const data = await safeJson(res);
    throw new Error(`Token request failed (${res.status}): ${JSON.stringify(data)}`);
  }

  const data = await res.json();
  if (!data.access_token) throw new Error("Token response missing access_token");
  return data.access_token;
}

async function fetchStationsLive() {
  const token = await getAccessToken();

  const url = `${API_BASE}${STATIONS_PATH}`;
  const res = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    const data = await safeJson(res);
    throw new Error(`Stations request failed (${res.status}): ${JSON.stringify(data)}`);
  }

  return await res.json();
}

// ===== Routes =====
app.get("/", (req, res) => {
  res.json({ ok: true, service: "fuel-finder-backend" });
});

app.get("/index/status", (req, res) => {
  res.json({ ok: true, service: "fuel-finder-backend" });
});

app.get("/stations", async (req, res) => {
  try {
    // Mock mode = always succeed for app development
    if (MOCK_MODE) {
      return res.json({
        ok: true,
        mode: "mock",
        count: MOCK_STATIONS.length,
        stations: MOCK_STATIONS,
      });
    }

    // Cache
    const now = Date.now();
    if (stationsCache.data && now - stationsCache.at < STATIONS_CACHE_MS) {
      return res.json({
        ok: true,
        mode: "cache",
        cached_at: new Date(stationsCache.at).toISOString(),
        stations: stationsCache.data,
      });
    }

    const data = await fetchStationsLive();
    stationsCache = { at: now, data };

    return res.json({
      ok: true,
      mode: "live",
      stations: data,
    });
  } catch (err) {
    const msg = String(err?.message || err);

    // Common: DNS / wrong hostname
    const isEnotfound =
      msg.includes("ENOTFOUND") ||
      msg.includes("getaddrinfo") ||
      msg.toLowerCase().includes("non-existent domain");

    return res.status(502).json({
      ok: false,
      error: msg,
      hint: isEnotfound
        ? "If you see ENOTFOUND, the hostname is wrong or not public. Get the correct Fuel Finder API host + token URL from the Fuel Finder developer portal, or temporarily set MOCK_MODE=true."
        : "Check Render env vars (CLIENT_ID/CLIENT_SECRET/API_BASE/TOKEN_URL) and the API response.",
      debug: {
        MOCK_MODE,
        API_BASE,
        TOKEN_URL,
        STATIONS_PATH,
      },
    });
  }
});

// ===== Start =====
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  if (!CLIENT_ID || !CLIENT_SECRET) console.log("❌ Missing CLIENT_ID or CLIENT_SECRET");
  if (MOCK_MODE) console.log("🧪 MOCK_MODE enabled");
});
