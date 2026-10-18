// Local Market: the Intelligence Center tab about what's happening AROUND a store.
//
//   GET  /api/market/area       the store's area + category (any plan; used for the header)
//   PUT  /api/market/area       set it by ZIP (or city + state) and/or category
//   GET  /api/market/snapshot   public data about the area (Census ACS) + an AI "local angle"   [marketSnapshot]
//   GET  /api/market/forecast   7-day expected traffic: weather + paydays + holidays + own sales [demandForecast]
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
const { requireFeature } = require("../utils/planAccess");
const { buildForecast } = require("../utils/demandForecast");
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
    await pool.query(`CREATE TABLE IF NOT EXISTS market_cache (
      key        TEXT PRIMARY KEY,
      data       JSONB NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL
    )`);
  })().catch((err) => console.error("Market tables could not be created:", err.message));
  router.use("/api/market", (req, res, next) => ready.then(() => next()));

  async function cached(key, ttlMs, load) {
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
      const angle = await cached(`angle:${a.zip}:${a.category}`, 30 * DAYS, async () => ({ text: await localAngle(a, stats) }));
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

  router.get("/api/market/forecast", authenticateToken, requireFeature(pool, "demandForecast"), async (req, res) => {
    try {
      const a = await areaFor(req.user.userId);
      if (!a) return res.json({ success: true, needsSetup: true });
      const ahead = await weatherAhead(a);
      const tz = ahead.timezone || a.timezone || "UTC";
      if (ahead.timezone && ahead.timezone !== a.timezone) {
        await pool.query(`UPDATE market_profiles SET timezone = $2 WHERE user_id = $1`, [req.user.userId, ahead.timezone]);
      }
      const { history, hours, source } = await salesHistory(req.user.userId, tz);
      let historyWeather = {};
      if (history.length) {
        // The weather archive lags a few days behind today
        const end = new Date(Date.now() - 3 * DAYS).toISOString().slice(0, 10);
        const start = history[0].date;
        if (start < end) historyWeather = await weatherPast(a, start, end).catch(() => ({}));
      }
      const forecast = buildForecast({ history, historyWeather, days: ahead.days, hours });
      res.json({
        success: true,
        area: publicArea(a),
        timezone: tz,
        salesSource: source,
        ...forecast,
        sources: ["Weather: Open-Meteo", source ? `Your ${source === "square" ? "Square" : "IMS"} sales, last ${history.length} days` : null].filter(Boolean),
      });
    } catch (err) {
      console.error("Market forecast error:", err.message);
      res.status(500).json({ success: false, message: "Couldn't build the forecast right now." });
    }
  });

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
