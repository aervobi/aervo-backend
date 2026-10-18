// Local Market: the Intelligence Center tab about what's happening AROUND a store.
//
//   GET  /api/market/area       the store's area + category (any plan; used for the header)
//   PUT  /api/market/area       set it by ZIP (or city + state) and/or category
//   GET  /api/market/snapshot   public data about the area (Census ACS) + an AI "local angle"   [marketSnapshot]
//   GET  /api/market/forecast   7-day expected traffic: weather + paydays + holidays + own sales [demandForecast]
//   GET  /api/market/briefing   "This week in <city>": AI briefing with web search + sources   [weeklyBriefing]
//                               (+ a "your week" item from the store's own forecast on Pro)
//   GET  /api/market/competitors  nearby competitors + what their customers say (Google Places) [competitorRadar]
//   GET  /api/market/trending     fastest-growing and new places nearby (weekly review-count snapshots) [trendingNearby]
//
// Area: the owner's choice, else their Square location's ZIP, else the free-text
// location from their profile. ZIPs are looked up on zippopotam.us and city names
// on Open-Meteo's geocoder (both free, no key). Weather comes from Open-Meteo
// (free, no key). Census data needs CENSUS_API_KEY (free at
// https://api.census.gov/data/key_signup.html).
//
// Everything external is cached in market_cache, by area (not by account), so
// every store in the same ZIP shares one lookup and outside services are
// called rarely.
const express = require("express");
const Anthropic = require("@anthropic-ai/sdk");
const { requireFeature, effectivePlan } = require("../utils/planAccess");
const { buildForecast } = require("../utils/demandForecast");
const { generateBriefing } = require("../utils/marketBriefing");
const { withAiContext } = require("../utils/aiSpend");
const { nearby, competitorTypes, reviewThemes, PlacesError, TRENDING_TYPES } = require("../utils/localCompetition");
const { CHAT_MODEL, replyText } = require("../utils/aiModels");

const CATEGORIES = {
  retail: "Retail store",
  restaurant: "Restaurant / food",
  service: "Service business",
  ecommerce: "Online store",
  salon: "Salon / beauty",
  fitness: "Fitness / wellness",
  coffee: "Coffee shop",
  other: "Local business",
};
const ZIP_RE = /^\d{5}$/;
const HOURS = 3600 * 1000;
const DAYS = 24 * HOURS;

// ── small helpers ────────────────────────────────────────────────────────────
async function getJson(url, { timeout = 12000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: "manual", headers: { "User-Agent": "Aervo/1.0 (+https://aervoapp.com)" } });
    if (res.status !== 200) {
      const err = new Error(`HTTP ${res.status} from ${new URL(url).host}`);
      err.status = res.status;
      throw err;
    }
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

module.exports = function marketRoutes(pool, authenticateToken, deps = {}) {
  const router = express.Router();
  const fetchJson = deps.fetchJson || getJson; // tests pass a fake
  const placesFetch = deps.placesFetch || ((...a) => fetch(...a)); // Google Places (POST), tests pass a fake
  let anthropic = deps.anthropic;
  if (anthropic === undefined) {
    anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;
  }

  const ready = (async () => {
    await pool.query(`CREATE TABLE IF NOT EXISTS market_profiles (
      user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      zip        TEXT,
      city       TEXT,
      state      TEXT,
      lat        DOUBLE PRECISION,
      lon        DOUBLE PRECISION,
      timezone   TEXT,
      category   TEXT,
      source     TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    // One weekly briefing per city + category, shared by every matching store
    await pool.query(`CREATE TABLE IF NOT EXISTS market_briefings (
      key        TEXT PRIMARY KEY,          -- state:city:category:weekStart
      zip        TEXT NOT NULL,
      category   TEXT NOT NULL,
      week_start DATE NOT NULL,
      status     TEXT NOT NULL,             -- preparing | ready | failed
      data       JSONB,
      error      TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    // Weekly review counts per Google place (shared by every store): "Trending near you"
    await pool.query(`CREATE TABLE IF NOT EXISTS place_snapshots (
      place_id     TEXT NOT NULL,
      day          DATE NOT NULL,
      name         TEXT,
      rating       NUMERIC(2, 1),
      rating_count INTEGER,
      PRIMARY KEY (place_id, day)
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS place_scan_areas (
      area_key   TEXT PRIMARY KEY,           -- rounded lat,lon of a Trending scan
      first_scan DATE NOT NULL DEFAULT CURRENT_DATE
    )`);
    // Briefings were keyed by ZIP at first; now by city
    await pool.query(`ALTER TABLE market_briefings ADD COLUMN IF NOT EXISTS city TEXT`);
    await pool.query(`ALTER TABLE market_briefings ADD COLUMN IF NOT EXISTS state TEXT`);
    await pool.query(`ALTER TABLE market_briefings ALTER COLUMN zip DROP NOT NULL`);
    await pool.query(`CREATE TABLE IF NOT EXISTS market_cache (
      key        TEXT PRIMARY KEY,
      data       JSONB NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL
    )`);
  })().catch((err) => console.error("Market tables could not be created:", err.message));
  router.use("/api/market", (req, res, next) => ready.then(() => next()));

  // Requests that need the same uncached thing at the same moment share one lookup
  const inflight = new Map();
  function cached(key, ttlMs, load) {
    if (inflight.has(key)) return inflight.get(key);
    const p = cachedOnce(key, ttlMs, load).finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }
  async function cachedOnce(key, ttlMs, load) {
    const hit = await pool.query(`SELECT data FROM market_cache WHERE key = $1 AND expires_at > NOW()`, [key]);
    if (hit.rows[0]) return hit.rows[0].data;
    const data = await load();
    await pool.query(
      `INSERT INTO market_cache (key, data, expires_at) VALUES ($1, $2, NOW() + ($3 || ' milliseconds')::interval)
       ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data, expires_at = EXCLUDED.expires_at`,
      [key, JSON.stringify(data), String(ttlMs)]
    );
    return data;
  }

  // ── area ────────────────────────────────────────────────────────────────────
  async function lookupZip(zip) {
    return cached(`zip:${zip}`, 90 * DAYS, async () => {
      const d = await fetchJson(`https://api.zippopotam.us/us/${zip}`);
      const p = d.places && d.places[0];
      if (!p) throw new Error("ZIP not found");
      return { zip, city: p["place name"], state: p["state abbreviation"], lat: Number(p.latitude), lon: Number(p.longitude) };
    });
  }

  async function lookupCity(city, state) {
    const key = `city:${city.toLowerCase()}:${(state || "").toLowerCase()}`;
    return cached(key, 90 * DAYS, async () => {
      const d = await fetchJson(
        `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=10&country=US&language=en`
      );
      const results = d.results || [];
      const st = (state || "").toLowerCase();
      const pick =
        results.find((r) => st && [r.admin1 || "", r.admin1_code || ""].some((a) => a.toLowerCase() === st)) ||
        results.find((r) => st && STATE_NAMES[st.toUpperCase()] && (r.admin1 || "").toLowerCase() === STATE_NAMES[st.toUpperCase()].toLowerCase()) ||
        results[0];
      if (!pick) throw new Error("City not found");
      const zip = (pick.postcodes || [])[0] || null;
      const abbr = Object.keys(STATE_NAMES).find((k) => STATE_NAMES[k] === pick.admin1) || state || null;
      return { zip, city: pick.name, state: abbr, lat: pick.latitude, lon: pick.longitude, timezone: pick.timezone || null };
    });
  }

  // "El Paso, TX", "El Paso, Texas", "79912", "El Paso TX 79912"...
  async function lookupFreeText(text) {
    const s = String(text || "").trim();
    if (!s) return null;
    const zip = (s.match(/\b(\d{5})\b/) || [])[1];
    if (zip) return lookupZip(zip);
    const parts = s.split(",").map((x) => x.trim()).filter(Boolean);
    return lookupCity(parts[0], parts[1] || "");
  }

  function categoryFrom(user) {
    const t = String((user && user.business_type) || "").toLowerCase();
    return CATEGORIES[t] ? t : "other";
  }

  async function saveProfile(userId, area, category, source) {
    await pool.query(
      `INSERT INTO market_profiles (user_id, zip, city, state, lat, lon, timezone, category, source, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
       ON CONFLICT (user_id) DO UPDATE SET zip=$2, city=$3, state=$4, lat=$5, lon=$6,
         timezone=COALESCE($7, market_profiles.timezone), category=$8, source=$9, updated_at=NOW()`,
      [userId, area.zip, area.city, area.state, area.lat, area.lon, area.timezone || null, category, source]
    );
  }

  // The caller's area, working it out (and remembering it) the first time
  async function areaFor(userId) {
    const saved = await pool.query(`SELECT * FROM market_profiles WHERE user_id = $1`, [userId]);
    if (saved.rows[0] && saved.rows[0].lat != null) return saved.rows[0];

    const u = (await pool.query(`SELECT business_type, location FROM users WHERE id = $1`, [userId])).rows[0] || {};
    const category = (saved.rows[0] && saved.rows[0].category) || categoryFrom(u);
    let area = null;
    let source = null;
    try {
      const sq = await pool.query(
        `SELECT postal_code, city, state FROM square_locations WHERE aervo_merchant_id = $1 AND postal_code IS NOT NULL ORDER BY name LIMIT 1`,
        [String(userId)]
      );
      if (sq.rows[0] && ZIP_RE.test(String(sq.rows[0].postal_code).slice(0, 5))) {
        area = await lookupZip(String(sq.rows[0].postal_code).slice(0, 5));
        source = "square";
      }
    } catch (err) {
      if (err.code !== "42P01") console.warn("Market: Square location lookup failed:", err.message);
    }
    if (!area && u.location) {
      area = await lookupFreeText(u.location).catch(() => null);
      source = "profile";
    }
    if (!area) return null;
    await saveProfile(userId, area, category, source);
    return (await pool.query(`SELECT * FROM market_profiles WHERE user_id = $1`, [userId])).rows[0];
  }

  const publicArea = (a) =>
    a && {
      zip: a.zip,
      city: a.city,
      state: a.state,
      category: a.category,
      categoryLabel: CATEGORIES[a.category] || CATEGORIES.other,
      source: a.source,
    };

  router.get("/api/market/area", authenticateToken, async (req, res) => {
    try {
      const a = await areaFor(req.user.userId);
      res.json({ success: true, area: publicArea(a), needsSetup: !a, categories: CATEGORIES });
    } catch (err) {
      console.error("Market area error:", err.message);
      res.status(500).json({ success: false, message: "Couldn't work out your area." });
    }
  });

  router.put("/api/market/area", authenticateToken, async (req, res) => {
    try {
      const userId = req.user.userId;
      const { zip, city, state, category } = req.body || {};
      const current = (await pool.query(`SELECT * FROM market_profiles WHERE user_id = $1`, [userId])).rows[0];
      const cat = category !== undefined ? String(category) : (current && current.category) || "other";
      if (!CATEGORIES[cat]) return res.status(400).json({ success: false, message: "Unknown business category." });

      let area = current && current.lat != null ? current : null;
      if (zip !== undefined && zip !== null && zip !== "") {
        if (!ZIP_RE.test(String(zip).trim())) return res.status(400).json({ success: false, message: "Enter a 5-digit US ZIP code." });
        area = await lookupZip(String(zip).trim()).catch(() => null);
        if (!area) return res.status(400).json({ success: false, message: "We couldn't find that ZIP code." });
      } else if (city) {
        area = await lookupCity(String(city).slice(0, 80), String(state || "").slice(0, 40)).catch(() => null);
        if (!area) return res.status(400).json({ success: false, message: "We couldn't find that city." });
      }
      if (!area) return res.status(400).json({ success: false, message: "Enter your store's ZIP code." });
      await saveProfile(userId, area, cat, "manual");
      res.json({ success: true, area: publicArea({ ...area, category: cat, source: "manual" }) });
    } catch (err) {
      console.error("Market area update error:", err.message);
      res.status(500).json({ success: false, message: "Couldn't save your area." });
    }
  });

  // ── snapshot (Census ACS 5-year, by ZIP area) ───────────────────────────────
  const ACS_VARS = {
    population: "B01003_001E",
    medianAge: "B01002_001E",
    medianIncome: "B19013_001E",
    hispanic: "B03003_003E",
    hispanicBase: "B03003_001E",
    bachelors: "B15003_022E",
    masters: "B15003_023E",
    professional: "B15003_024E",
    doctorate: "B15003_025E",
    eduBase: "B15003_001E",
    renters: "B25003_003E",
    tenureBase: "B25003_001E",
  };

  function shapeAcs(header, row) {
    const v = {};
    header.forEach((h, i) => (v[h] = row[i]));
    const n = (k) => {
      const x = Number(v[ACS_VARS[k]]);
      return Number.isFinite(x) && x >= 0 ? x : null; // Census uses big negatives for "no data"
    };
    const pct = (a, b) => (n(a) != null && n(b) ? Math.round((n(a) / n(b)) * 1000) / 10 : null);
    const degree = ["bachelors", "masters", "professional", "doctorate"].reduce((s, k) => s + (n(k) || 0), 0);
    return {
      population: n("population"),
      medianAge: n("medianAge"),
      medianIncome: n("medianIncome"),
      hispanicPct: pct("hispanic", "hispanicBase"),
      degreePct: n("eduBase") ? Math.round((degree / n("eduBase")) * 1000) / 10 : null,
      rentersPct: pct("renters", "tenureBase"),
    };
  }

  async function acsFor(zip) {
    const key = process.env.CENSUS_API_KEY;
    if (!key) {
      const err = new Error("CENSUS_API_KEY is not set");
      err.needsKey = true;
      throw err;
    }
    const vars = Object.values(ACS_VARS).join(",");
    const years = [...new Set([process.env.CENSUS_ACS_YEAR, "2024", "2023"].filter(Boolean))];
    let lastErr;
    for (const year of years) {
      try {
        const base = `https://api.census.gov/data/${year}/acs/acs5?get=NAME,${vars}&key=${encodeURIComponent(key)}`;
        const [area, us] = await Promise.all([
          fetchJson(`${base}&for=zip%20code%20tabulation%20area:${zip}`),
          fetchJson(`${base}&for=us:1`),
        ]);
        if (!Array.isArray(area) || area.length < 2) throw new Error("No Census data for this ZIP");
        return { year: Number(year), area: shapeAcs(area[0], area[1]), us: shapeAcs(us[0], us[1]) };
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr;
  }

  async function localAngle(area, stats) {
    if (!anthropic) return null;
    const prompt = `Store: a ${CATEGORIES[area.category] || "local business"} in ${area.city}, ${area.state} (ZIP ${area.zip}).
Census figures for the ZIP area (US in brackets): population ${stats.area.population}; median age ${stats.area.medianAge} (${stats.us.medianAge}); median household income $${stats.area.medianIncome} ($${stats.us.medianIncome}); Hispanic/Latino ${stats.area.hispanicPct}% (${stats.us.hispanicPct}%); bachelor's degree or higher ${stats.area.degreePct}% (${stats.us.degreePct}%); renters ${stats.area.rentersPct}% (${stats.us.rentersPct}%).
Write the "local angle": 2 or 3 short sentences an owner can act on, about what makes this area's customers different and one practical idea. You may use well-known, stable facts about the city (for example a big military base, university, border crossing or tourism) but never invent statistics, dates or business names. Plain text, no lists, no headings.`;
    try {
      const msg = await anthropic.messages.create({
        model: CHAT_MODEL,
        max_tokens: 220,
        messages: [{ role: "user", content: prompt }],
      });
      return replyText(msg) || null;
    } catch (err) {
      console.warn("Market local angle failed:", err.message);
      return null;
    }
  }

  router.get("/api/market/snapshot", authenticateToken, requireFeature(pool, "marketSnapshot"), async (req, res) => {
    try {
      const a = await areaFor(req.user.userId);
      if (!a) return res.json({ success: true, needsSetup: true });
      if (!a.zip) return res.json({ success: true, area: publicArea(a), unavailable: "Add your store's ZIP code to see local data." });
      let stats;
      try {
        stats = await cached(`acs:${a.zip}`, 30 * DAYS, () => acsFor(a.zip));
      } catch (err) {
        if (err.needsKey) {
          console.error("Market snapshot: CENSUS_API_KEY is not set");
          return res.json({ success: true, area: publicArea(a), unavailable: "Local data is being set up. Check back soon." });
        }
        console.warn("Market snapshot: Census lookup failed:", err.message);
        return res.json({ success: true, area: publicArea(a), unavailable: "Census data isn't available for this ZIP right now." });
      }
      const angle = await cached(`angle:${a.zip}:${a.category}`, 30 * DAYS, () =>
        withAiContext({ userId: 0, feature: "market/local-angle" }, async () => ({ text: await localAngle(a, stats) }))
      );
      res.json({
        success: true,
        area: publicArea(a),
        snapshot: { ...stats, localAngle: angle.text, source: `U.S. Census Bureau, American Community Survey ${stats.year} 5-year estimates (ZIP ${a.zip} area)` },
      });
    } catch (err) {
      console.error("Market snapshot error:", err.message);
      res.status(500).json({ success: false, message: "Couldn't load local data." });
    }
  });

  // ── forecast ────────────────────────────────────────────────────────────────
  const round2 = (x) => Math.round(x * 100) / 100;

  async function weatherAhead(a) {
    return cached(`wx:${round2(a.lat)},${round2(a.lon)}`, 3 * HOURS, async () => {
      const d = await fetchJson(
        `https://api.open-meteo.com/v1/forecast?latitude=${a.lat}&longitude=${a.lon}` +
          `&daily=weather_code,temperature_2m_max,precipitation_probability_max,precipitation_sum` +
          `&temperature_unit=fahrenheit&timezone=auto&forecast_days=7`
      );
      const x = d.daily || {};
      return {
        timezone: d.timezone || null,
        days: (x.time || []).map((date, i) => ({
          date,
          code: x.weather_code ? x.weather_code[i] : null,
          tmax: x.temperature_2m_max ? x.temperature_2m_max[i] : null,
          precipProb: x.precipitation_probability_max ? x.precipitation_probability_max[i] : null,
          precip: x.precipitation_sum ? x.precipitation_sum[i] : null,
        })),
      };
    });
  }

  async function weatherPast(a, start, end) {
    return cached(`wxpast:${round2(a.lat)},${round2(a.lon)}:${start}:${end}`, DAYS, async () => {
      const d = await fetchJson(
        `https://archive-api.open-meteo.com/v1/archive?latitude=${a.lat}&longitude=${a.lon}&start_date=${start}&end_date=${end}` +
          `&daily=precipitation_sum,temperature_2m_max&temperature_unit=fahrenheit&timezone=auto`
      );
      const x = d.daily || {};
      const out = {};
      (x.time || []).forEach((date, i) => {
        out[date] = {
          precip: x.precipitation_sum ? x.precipitation_sum[i] : null,
          tmax: x.temperature_2m_max ? x.temperature_2m_max[i] : null,
        };
      });
      return out;
    });
  }

  // Daily sales (zeros filled in) and sales by hour, from Square or IMS
  async function salesHistory(userId, tz) {
    const zone = tz || "UTC";
    let daily = [];
    let hours = [];
    let source = null;
    try {
      const sq = await pool.query(
        `SELECT to_char((created_at AT TIME ZONE $2)::date, 'YYYY-MM-DD') AS day, SUM(total_amount)::float AS sales
           FROM square_orders
          WHERE aervo_merchant_id = $1 AND state = 'COMPLETED' AND created_at >= NOW() - interval '120 days'
          GROUP BY 1 ORDER BY 1`,
        [String(userId), zone]
      );
      if (sq.rows.length) {
        daily = sq.rows;
        source = "square";
        hours = (
          await pool.query(
            `SELECT EXTRACT(HOUR FROM created_at AT TIME ZONE $2)::int AS hour, SUM(total_amount)::float AS sales
               FROM square_orders
              WHERE aervo_merchant_id = $1 AND state = 'COMPLETED' AND created_at >= NOW() - interval '56 days'
              GROUP BY 1`,
            [String(userId), zone]
          )
        ).rows;
      }
    } catch (err) {
      if (err.code !== "42P01") throw err;
    }
    if (!daily.length) {
      try {
        const ims = await pool.query(
          `SELECT to_char(sale_date::date, 'YYYY-MM-DD') AS day, SUM(total_amount)::float AS sales
             FROM aervo_sales
            WHERE merchant_id = $1 AND sale_date >= NOW() - interval '120 days'
            GROUP BY 1 ORDER BY 1`,
          [userId]
        );
        if (ims.rows.length) {
          daily = ims.rows;
          source = "ims";
        }
      } catch (err) {
        if (err.code !== "42P01" && err.code !== "42703") throw err;
      }
    }
    if (!daily.length) return { history: [], hours: [], source: null };

    // Fill the days with no sales (closed days matter for the weekday pattern),
    // from the first sale up to yesterday in the store's time zone
    const byDay = Object.fromEntries(daily.map((r) => [r.day, Number(r.sales) || 0]));
    const today = new Date().toLocaleDateString("en-CA", { timeZone: zone });
    const history = [];
    for (let d = new Date(daily[0].day + "T12:00:00Z"); ; d.setUTCDate(d.getUTCDate() + 1)) {
      const key = d.toISOString().slice(0, 10);
      if (key >= today) break;
      history.push({ date: key, sales: byDay[key] || 0 });
    }
    return { history, hours: hours.map((h) => ({ hour: Number(h.hour), sales: Number(h.sales) || 0 })), source };
  }

  // The 7-day forecast for one store (also used for the briefing's "your week" item)
  async function forecastFor(userId, a) {
    const ahead = await weatherAhead(a);
    const tz = ahead.timezone || a.timezone || "UTC";
    if (ahead.timezone && ahead.timezone !== a.timezone) {
      await pool.query(`UPDATE market_profiles SET timezone = $2 WHERE user_id = $1`, [userId, ahead.timezone]);
    }
    const { history, hours, source } = await salesHistory(userId, tz);
    let historyWeather = {};
    if (history.length) {
      // The weather archive lags a few days behind today
      const end = new Date(Date.now() - 3 * DAYS).toISOString().slice(0, 10);
      const start = history[0].date;
      if (start < end) historyWeather = await weatherPast(a, start, end).catch(() => ({}));
    }
    const forecast = buildForecast({ history, historyWeather, days: ahead.days, hours });
    return {
      timezone: tz,
      salesSource: source,
      ...forecast,
      sources: ["Weather: Open-Meteo", source ? `Your ${source === "square" ? "Square" : "IMS"} sales, last ${history.length} days` : null].filter(Boolean),
    };
  }

  router.get("/api/market/forecast", authenticateToken, requireFeature(pool, "demandForecast"), async (req, res) => {
    try {
      const a = await areaFor(req.user.userId);
      if (!a) return res.json({ success: true, needsSetup: true });
      res.json({ success: true, area: publicArea(a), ...(await forecastFor(req.user.userId, a)) });
    } catch (err) {
      console.error("Market forecast error:", err.message);
      res.status(500).json({ success: false, message: "Couldn't build the forecast right now." });
    }
  });

  // ── weekly briefing ─────────────────────────────────────────────────────────
  const PREPARING_TIMEOUT_MS = 15 * 60 * 1000; // a stuck "preparing" can be retried after this
  const FAILED_RETRY_MS = 6 * HOURS; // don't hammer the AI if a briefing keeps failing

  // Monday-Sunday of the current week in the store's time zone
  function weekOf(tz) {
    const today = new Date().toLocaleDateString("en-CA", { timeZone: tz || "UTC" });
    const d = new Date(today + "T12:00:00Z");
    const back = (d.getUTCDay() + 6) % 7; // days since Monday
    const start = new Date(d.getTime() - back * DAYS);
    const end = new Date(start.getTime() + 6 * DAYS);
    return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
  }

  // Shared by city, not ZIP: every coffee shop in El Paso gets the same
  // briefing, which keeps one AI research run per city + category per week
  const cityKey = (a) => `${String(a.state || "").toUpperCase()}:${String(a.city || "").trim().toLowerCase()}`;
  const briefingKey = (a, week) => `${cityKey(a)}:${a.category}:${week.start}`;

  async function runGeneration(key, a, week) {
    // Shared by every store in the city: logged as shared, not as the visitor's spend
    return withAiContext({ userId: 0, feature: "market/briefing" }, () => runGenerationNow(key, a, week));
  }
  async function runGenerationNow(key, a, week) {
    try {
      const data = await generateBriefing({
        anthropic,
        area: { city: a.city, state: a.state, timezone: a.timezone },
        categoryLabel: CATEGORIES[a.category] || CATEGORIES.other,
        weekStart: week.start,
        weekEnd: week.end,
      });
      await pool.query(
        `UPDATE market_briefings SET status = 'ready', data = $2, error = NULL, updated_at = NOW() WHERE key = $1`,
        [key, JSON.stringify({ ...data, generatedAt: new Date().toISOString() })]
      );
      console.log("Market briefing ready", { key, items: data.items.length, searched: data.searched, usage: data.usage });
    } catch (err) {
      console.error("Market briefing failed", { key, error: err.message });
      await pool
        .query(`UPDATE market_briefings SET status = 'failed', error = $2, updated_at = NOW() WHERE key = $1`, [key, String(err.message).slice(0, 300)])
        .catch(() => {});
    }
  }

  // Returns the briefing row, starting a generation (in the background) when
  // there's none yet for this week, a stuck one, or an old failure. The claim
  // is one atomic statement, so two requests can't start the same briefing.
  async function ensureBriefing(a, { wait = false } = {}) {
    const week = weekOf(a.timezone);
    const key = briefingKey(a, week);
    const claimed = await pool.query(
      `INSERT INTO market_briefings (key, zip, category, week_start, status, city, state)
       VALUES ($1, $2, $3, $4, 'preparing', $7, $8)
       ON CONFLICT (key) DO UPDATE SET status = 'preparing', error = NULL, updated_at = NOW()
         WHERE (market_briefings.status = 'preparing' AND market_briefings.updated_at < NOW() - ($5 || ' milliseconds')::interval)
            OR (market_briefings.status = 'failed' AND market_briefings.updated_at < NOW() - ($6 || ' milliseconds')::interval)
       RETURNING key`,
      [key, a.zip || null, a.category, week.start, String(PREPARING_TIMEOUT_MS), String(FAILED_RETRY_MS), a.city, a.state]
    );
    if (claimed.rows.length) {
      const job = runGeneration(key, a, week);
      if (wait) await job;
    }
    const row = (await pool.query(`SELECT status, data, updated_at FROM market_briefings WHERE key = $1`, [key])).rows[0];
    return { week, row };
  }

  // The store's own week, from its forecast: the busiest and slowest days ahead
  function yourWeekItem(fc) {
    const days = (fc.days || []).filter((d) => d.pct != null && !d.closed);
    if (!days.length || fc.basis.confidence === "none") return null;
    const best = days.reduce((x, y) => (y.pct > x.pct ? y : x));
    const worst = days.reduce((x, y) => (y.pct < x.pct ? y : x));
    const fmtDay = (d) => new Date(d.date + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
    let body = `${fmtDay(best)} looks like your busiest day (${best.pct >= 0 ? "+" : ""}${best.pct}% vs an average day)`;
    // Only what actually lifts the day (a rain dip isn't "helping")
    const why = best.reasons.filter((r) => r.kind !== "weekday" && r.effect != null && r.effect > 0).map((r) => r.text.toLowerCase());
    if (why.length) body += `, helped by ${why.join(" and ")}`;
    body += ".";
    if (worst !== best && worst.pct <= -8) body += ` ${fmtDay(worst)} looks slowest (${worst.pct}%).`;
    return {
      kind: "yours",
      title: `Your week: ${fmtDay(best)} is the day to be ready for`,
      body,
      action: best.action || "",
      date: best.date,
      sources: [{ url: null, title: fc.sources.join(" · ") }],
    };
  }

  router.get("/api/market/briefing", authenticateToken, requireFeature(pool, "weeklyBriefing"), async (req, res) => {
    try {
      const a = await areaFor(req.user.userId);
      if (!a) return res.json({ success: true, needsSetup: true });
      if (!a.city || !a.state) return res.json({ success: true, area: publicArea(a), unavailable: "Add your store's ZIP code to get a weekly briefing." });
      if (!anthropic) return res.json({ success: true, area: publicArea(a), unavailable: "Weekly briefings are being set up. Check back soon." });

      const { week, row } = await ensureBriefing(a);
      let yours = null;
      if (req.planLimits && req.planLimits.demandForecast) {
        yours = await forecastFor(req.user.userId, a).then(yourWeekItem).catch(() => null);
      }
      res.json({
        success: true,
        area: publicArea(a),
        week,
        status: row ? row.status : "preparing",
        briefing: row && row.status === "ready" ? row.data : null,
        yourWeek: yours,
      });
    } catch (err) {
      console.error("Market briefing error:", err.message);
      res.status(500).json({ success: false, message: "Couldn't load this week's briefing." });
    }
  });

  // ── competitors + trending (Google Places) ──────────────────────────────────
  const WEEK = 7 * DAYS;
  const RADAR_MILES = 2;
  const TREND_MILES = 3;
  const placesUnavailable = (a) => ({
    success: true,
    area: publicArea(a),
    unavailable: "Nearby business data is being set up. Check back soon.",
  });

  // The store's exact spot when its Google listing is linked (Google Reviews),
  // else the middle of its ZIP code
  async function storeCenter(userId, a) {
    let link = null;
    try {
      link = (await pool.query(`SELECT place_id FROM google_review_connections WHERE user_id = $1`, [userId])).rows[0];
    } catch (err) {
      if (err.code !== "42P01") throw err;
    }
    if (link && process.env.GOOGLE_MAPS_API_KEY) {
      try {
        const own = await cached(`ownplace:${link.place_id}`, WEEK, async () => {
          const r = await placesFetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(link.place_id)}`, {
            headers: { "X-Goog-Api-Key": process.env.GOOGLE_MAPS_API_KEY, "X-Goog-FieldMask": "id,location,rating,userRatingCount" },
            signal: AbortSignal.timeout(10000),
          });
          if (!r.ok) throw new Error(`Place details ${r.status}`);
          const d = await r.json();
          return { placeId: d.id, lat: d.location.latitude, lon: d.location.longitude, rating: d.rating ?? null, reviews: d.userRatingCount ?? 0 };
        });
        return { lat: own.lat, lon: own.lon, exact: true, own };
      } catch (err) {
        console.warn("Market: own place lookup failed:", err.message);
      }
    }
    return { lat: a.lat, lon: a.lon, exact: false, own: null };
  }
  const r3 = (x) => Math.round(x * 1000) / 1000;

  router.get("/api/market/competitors", authenticateToken, requireFeature(pool, "competitorRadar"), async (req, res) => {
    try {
      const a = await areaFor(req.user.userId);
      if (!a) return res.json({ success: true, needsSetup: true });
      const types = competitorTypes(a.category);
      if (!types) {
        return res.json({
          success: true,
          area: publicArea(a),
          unavailable: "Choose your business type (coffee shop, restaurant, salon, fitness or retail) above to see competitors.",
        });
      }
      if (!process.env.GOOGLE_MAPS_API_KEY) return res.json(placesUnavailable(a));
      const center = await storeCenter(req.user.userId, a);
      const ownId = center.own && center.own.placeId;

      const data = await cached(`radar:${r3(center.lat)},${r3(center.lon)}:${a.category}`, WEEK, async () => {
        const found = await nearby({
          key: process.env.GOOGLE_MAPS_API_KEY,
          fetchImpl: placesFetch,
          center,
          radiusMeters: Math.round(RADAR_MILES * 1609.34),
          types,
          rank: "DISTANCE",
          withReviews: true,
        });
        const competitors = found.filter((c) => c.placeId !== ownId).slice(0, 8);
        // What customers say: one AI read per area per week, shared by stores here
        const themes = await withAiContext({ userId: 0, feature: "market/competitors" }, () =>
          reviewThemes({ anthropic, categoryLabel: CATEGORIES[a.category], city: a.city, competitors, own: center.own })
        ).catch((err) => {
          console.warn("Market: competitor themes failed:", err.message);
          return null;
        });
        return {
          scannedAt: new Date().toISOString(),
          edge: themes ? themes.edge : null,
          competitors: competitors.map(({ reviewText, ...c }) => ({
            ...c,
            praised: (themes && themes.byPlace[c.placeId] && themes.byPlace[c.placeId].praised) || [],
            complaints: (themes && themes.byPlace[c.placeId] && themes.byPlace[c.placeId].complaints) || [],
          })),
        };
      });
      res.json({
        success: true,
        area: publicArea(a),
        radiusMiles: RADAR_MILES,
        exactLocation: center.exact,
        own: center.own ? { rating: center.own.rating, reviews: center.own.reviews } : null,
        ...data,
        source: "Google Maps",
      });
    } catch (err) {
      if (err instanceof PlacesError) {
        console.error("Market competitors: Google Places failed:", err.message, err.reason || "");
        const a = await areaFor(req.user.userId).catch(() => null);
        return res.json(placesUnavailable(a));
      }
      console.error("Market competitors error:", err.message);
      res.status(500).json({ success: false, message: "Couldn't load nearby competitors." });
    }
  });

  router.get("/api/market/trending", authenticateToken, requireFeature(pool, "trendingNearby"), async (req, res) => {
    try {
      const a = await areaFor(req.user.userId);
      if (!a) return res.json({ success: true, needsSetup: true });
      if (!process.env.GOOGLE_MAPS_API_KEY) return res.json(placesUnavailable(a));
      const center = await storeCenter(req.user.userId, a);
      const areaKey = `${Math.round(center.lat * 100) / 100},${Math.round(center.lon * 100) / 100}`;

      // Scan at most once a week per area; each scan records every place's review count
      const scan = await cached(`trend:${areaKey}`, WEEK, async () => {
        const found = await nearby({
          key: process.env.GOOGLE_MAPS_API_KEY,
          fetchImpl: placesFetch,
          center,
          radiusMeters: Math.round(TREND_MILES * 1609.34),
          types: TRENDING_TYPES,
          rank: "POPULARITY",
        });
        for (const p of found) {
          await pool.query(
            `INSERT INTO place_snapshots (place_id, day, name, rating, rating_count) VALUES ($1, CURRENT_DATE, $2, $3, $4)
             ON CONFLICT (place_id, day) DO UPDATE SET rating = EXCLUDED.rating, rating_count = EXCLUDED.rating_count`,
            [p.placeId, p.name, p.rating, p.reviews]
          );
        }
        return { scannedAt: new Date().toISOString(), places: found.map(({ reviewText, hours, ...p }) => p) };
      });
      await pool.query(`INSERT INTO place_scan_areas (area_key) VALUES ($1) ON CONFLICT (area_key) DO NOTHING`, [areaKey]);
      const firstScan = (await pool.query(`SELECT first_scan FROM place_scan_areas WHERE area_key = $1`, [areaKey])).rows[0].first_scan;
      const trackingDays = Math.floor((Date.now() - new Date(firstScan).getTime()) / DAYS);

      // Growth = review count now vs the oldest snapshot from 1-8 weeks ago
      const ids = scan.places.map((p) => p.placeId);
      const hist = ids.length
        ? (
            await pool.query(
              `SELECT place_id,
                      (array_agg(rating_count ORDER BY day ASC))[1] AS then_count,
                      MIN(day) AS first_day
                 FROM place_snapshots
                WHERE place_id = ANY($1::text[]) AND day >= CURRENT_DATE - 60 AND day <= CURRENT_DATE - 6
                GROUP BY place_id`,
              [ids]
            )
          ).rows
        : [];
      const firstSeen = ids.length
        ? (await pool.query(`SELECT place_id, MIN(day) AS d FROM place_snapshots WHERE place_id = ANY($1::text[]) GROUP BY place_id`, [ids])).rows
        : [];
      const thenBy = new Map(hist.map((h) => [h.place_id, h]));
      const seenBy = new Map(firstSeen.map((f) => [f.place_id, new Date(f.d)]));
      const mine = new Set(competitorTypes(a.category) || []);

      const items = scan.places.map((p) => {
        const then = thenBy.get(p.placeId);
        const growth = then && then.then_count != null ? p.reviews - Number(then.then_count) : null;
        const seen = seenBy.get(p.placeId);
        // First spotted a week or more after we started watching this area, and
        // still with few reviews (a long-open place can also just enter the top 20)
        const isNew = !!(seen && trackingDays >= 7 && seen.getTime() - new Date(firstScan).getTime() >= 6 * DAYS && p.reviews < 100);
        return { ...p, growth, isNew, sameCategory: mine.has(p.typeKey) };
      });
      const enoughHistory = trackingDays >= 7 && items.some((i) => i.growth != null);
      let list;
      if (enoughHistory) {
        list = items
          .filter((i) => i.isNew || (i.growth != null && i.growth > 0))
          .sort((x, y) => (y.isNew - x.isNew) || (y.growth || 0) - (x.growth || 0))
          .slice(0, 6);
      } else {
        // First week: most popular nearby, while growth history builds up
        list = items
          .filter((i) => i.rating != null)
          .sort((x, y) => y.reviews * (y.rating || 0) - x.reviews * (x.rating || 0))
          .slice(0, 6);
      }
      res.json({
        success: true,
        area: publicArea(a),
        radiusMiles: TREND_MILES,
        mode: enoughHistory ? "trending" : "popular",
        trackingSince: new Date(firstScan).toISOString().slice(0, 10),
        scannedAt: scan.scannedAt,
        places: list.map(({ typeKey, ...p }) => p),
        source: "Google Maps",
      });
    } catch (err) {
      if (err instanceof PlacesError) {
        console.error("Market trending: Google Places failed:", err.message, err.reason || "");
        const a = await areaFor(req.user.userId).catch(() => null);
        return res.json(placesUnavailable(a));
      }
      console.error("Market trending error:", err.message);
      res.status(500).json({ success: false, message: "Couldn't load what's trending nearby." });
    }
  });

  // Monday job: prepare this week's briefing for every area that has a store on
  // a plan with briefings, one at a time (so a busy Monday never floods the AI)
  router.runWeeklyBriefings = async function runWeeklyBriefings({ pauseMs = 2000 } = {}) {
    await ready;
    // Stores whose plan in effect (trials count) includes the briefing, one per city + category
    const rows = (
      await pool.query(
        `SELECT mp.city, mp.state, mp.zip, mp.lat, mp.lon, mp.timezone, mp.category, to_jsonb(u) AS urow
           FROM market_profiles mp JOIN users u ON u.id = mp.user_id
          WHERE mp.city IS NOT NULL AND mp.state IS NOT NULL`
      )
    ).rows;
    const seen = new Set();
    const areas = [];
    for (const r of rows) {
      if (!effectivePlan(r.urow).limits.weeklyBriefing) continue;
      const k = `${cityKey(r)}:${r.category}`;
      if (seen.has(k)) continue;
      seen.add(k);
      areas.push(r);
    }
    const stats = { areas: areas.length, ready: 0, failed: 0 };
    if (!anthropic) return stats;
    for (const a of areas) {
      const { row } = await ensureBriefing(a, { wait: true });
      if (row && row.status === "ready") stats.ready++;
      else stats.failed++;
      if (pauseMs) await new Promise((r) => setTimeout(r, pauseMs));
    }
    console.log("Weekly market briefings done", stats);
    return stats;
  };

  return router;
};

const STATE_NAMES = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut",
  DE: "Delaware", DC: "District of Columbia", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois",
  IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
  MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana",
  NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York",
  NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania",
  RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah",
  VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
};
module.exports.CATEGORIES = CATEGORIES;
