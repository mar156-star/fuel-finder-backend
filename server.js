import express from "express";
import fetch from "node-fetch";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

/**
 * =========================
 * ENVIRONMENT VARIABLES
 * =========================
 * These MUST exist on Render:
 *
 * CLIENT_ID
 * CLIENT_SECRET
 */
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("❌ Missing CLIENT_ID or CLIENT_SECRET");
}

/**
 * =========================
 * TOKEN CACHE
 * =========================
 */
let accessToken = null;
let tokenExpiry = 0;

/**
 * =========================
 * GET ACCESS TOKEN
 * =========================
 */
async function getAccessToken() {
  const now = Date.now();

  if (accessToken && now < tokenExpiry) {
    return accessToken;
  }

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
  });

  const resp = await fetch(
    "https://api.data.gov.uk/oauth2/token",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    }
  );

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Token error ${resp.status}: ${text}`);
  }

  const json = await resp.json();
  accessToken = json.access_token;
  tokenExpiry = now + (json.expires_in - 60) * 1000;

  return accessToken;
}

/**
 * =========================
 * HEALTH CHECK
 * =========================
 */
app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "fuel-finder-backend",
  });
});

/**
 * =========================
 * FUEL STATIONS ENDPOINT
 * =========================
 */
app.get("/stations", async (req, res) => {
  try {
    const token = await getAccessToken();

    const apiResp = await fetch(
      "https://api.data.gov.uk/api/v1/pfs",
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
      }
    );

    if (!apiResp.ok) {
      const text = await apiResp.text();
      return res.status(apiResp.status).json({
        ok: false,
        error: `Fuel API error ${apiResp.status}`,
        details: text,
      });
    }

    const data = await apiResp.json();
    res.json({
      ok: true,
      data,
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message,
    });
  }
});

/**
 * =========================
 * PORT (ONLY ONCE)
 * =========================
 */
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
