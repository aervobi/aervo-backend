// utils/demandForecast.js
// The 7-day "expected traffic" forecast on the Intelligence Center's Local
// Market tab. Pure functions (no I/O), so the model can be tested on its own.
//
// How it works, in plain terms:
//  1. Normal day: the store's average daily sales over the last 8 weeks, and
//     each weekday's own average (Saturdays may be +40%, Mondays -20%...).
//  2. What moves this store: compare past days that had rain, heat or a
//     payday (the 1st and 15th) with that weekday's usual sales. An effect is
//     only used when there are enough examples (MIN_SAMPLES); otherwise rain
//     falls back to a modest "typical" dip that is labelled as such, and heat
//     and paydays are left out rather than guessed.
//  3. Each upcoming day = its weekday's usual sales x the effects that apply,
//     shown as % above or below an average day, with the reasons behind it.
const MIN_SAMPLES = 3;
const RAIN_MM = 2.5; // a day counts as rainy at this much precipitation
const RAIN_PROB = 50; // ...or when the forecast gives at least this chance
const HEAT_F = 95;
const TYPICAL_RAIN = 0.9; // used only when this store has no rainy-day history
const PAYDAYS = [1, 15];

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const FULL_DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// WMO weather codes (Open-Meteo) -> icon + words
function describeWeather(code) {
  if (code == null) return { icon: "·", label: "No forecast" };
  if (code === 0) return { icon: "☀️", label: "Clear" };
  if (code <= 2) return { icon: "🌤️", label: "Mostly sunny" };
  if (code === 3) return { icon: "☁️", label: "Cloudy" };
  if (code === 45 || code === 48) return { icon: "🌫️", label: "Fog" };
  if (code >= 51 && code <= 57) return { icon: "🌦️", label: "Drizzle" };
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return { icon: "🌧️", label: "Rain" };
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return { icon: "🌨️", label: "Snow" };
  if (code >= 95) return { icon: "⛈️", label: "Storms" };
  return { icon: "⛅", label: "Mixed" };
}

const weekdayOf = (date) => new Date(date + "T12:00:00Z").getUTCDay();
const dayOfMonth = (date) => Number(date.slice(8, 10));
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

// US federal holidays that move store traffic, for the given year (YYYY-MM-DD)
function usHolidays(year) {
  const nth = (month, weekday, n) => {
    const d = new Date(Date.UTC(year, month, 1));
    let count = 0;
    while (true) {
      if (d.getUTCDay() === weekday && ++count === n) return d.toISOString().slice(0, 10);
      d.setUTCDate(d.getUTCDate() + 1);
    }
  };
  const last = (month, weekday) => {
    const d = new Date(Date.UTC(year, month + 1, 0));
    while (d.getUTCDay() !== weekday) d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  };
  const fixed = (m, d) => `${year}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  return {
    [fixed(1, 1)]: "New Year's Day",
    [nth(0, 1, 3)]: "Martin Luther King Jr. Day",
    [nth(1, 1, 3)]: "Presidents' Day",
    [last(4, 1)]: "Memorial Day",
    [fixed(6, 19)]: "Juneteenth",
    [fixed(7, 4)]: "Independence Day",
    [nth(8, 1, 1)]: "Labor Day",
    [nth(10, 4, 4)]: "Thanksgiving",
    [fixed(12, 24)]: "Christmas Eve",
    [fixed(12, 25)]: "Christmas Day",
    [fixed(12, 31)]: "New Year's Eve",
  };
}

// The 3-hour window with the most sales, e.g. "3–6 PM" (hours = [{hour, sales}])
function busiestWindow(hours) {
  if (!hours || !hours.length) return null;
  const by = new Array(24).fill(0);
  hours.forEach((h) => (by[h.hour] += h.sales));
  let best = -1;
  let start = 0;
  for (let h = 0; h <= 21; h++) {
    const s = by[h] + by[h + 1] + by[h + 2];
    if (s > best) {
      best = s;
      start = h;
    }
  }
  if (best <= 0) return null;
  const fmt = (h) => {
    const x = h % 12 === 0 ? 12 : h % 12;
    return { n: x, ap: h < 12 || h === 24 ? "AM" : "PM" };
  };
  const a = fmt(start);
  const b = fmt(start + 3);
  return a.ap === b.ap ? `${a.n}–${b.n} ${b.ap}` : `${a.n} ${a.ap}–${b.n} ${b.ap}`;
}

// Average ratio (sales / that weekday's usual) on matching days vs ordinary
// days. `plain` excludes days touched by any other effect, so a rainy payday
// doesn't blur either effect.
function learnEffect(rows, match, plain) {
  const hit = rows.filter((r) => match(r)).map((r) => r.ratio);
  const miss = rows.filter((r) => !match(r) && plain(r)).map((r) => r.ratio);
  if (hit.length < MIN_SAMPLES || miss.length < MIN_SAMPLES) return null;
  const m = mean(miss);
  if (!m) return null;
  const effect = mean(hit) / m;
  return { effect: Math.min(Math.max(effect, 0.4), 2), samples: hit.length };
}

/**
 * @param {object} p
 * @param {{date:string, sales:number}[]} p.history   daily sales, oldest first, zeros included
 * @param {Object<string,{precip:number|null,tmax:number|null}>} p.historyWeather  by date
 * @param {{date:string, code:number, tmax:number, precipProb:number, precip:number}[]} p.days  upcoming days
 * @param {{hour:number, sales:number}[]} [p.hours]  sales by hour of day (for the busiest window)
 */
function buildForecast({ history = [], historyWeather = {}, days = [], hours = [] }) {
  const recent = history.slice(-56); // last 8 weeks
  const overall = mean(recent.map((d) => d.sales)) || 0;
  const hasSales = overall > 0 && recent.length >= 14;

  // An "ordinary" day: no rain, not a payday. Each weekday's usual sales come
  // from its ordinary days when there are enough, so special days don't skew it.
  const isRainy = (date) => historyWeather[date] && historyWeather[date].precip != null && historyWeather[date].precip >= RAIN_MM;
  const isPayday = (date) => PAYDAYS.includes(dayOfMonth(date));
  const base = WEEKDAYS.map((_, w) => {
    const all = recent.filter((d) => weekdayOf(d.date) === w);
    const plainDays = all.filter((d) => !isRainy(d.date) && !isPayday(d.date)).map((d) => d.sales);
    if (plainDays.length >= 2) return mean(plainDays);
    return all.length >= 2 ? mean(all.map((d) => d.sales)) : overall;
  });

  const rows = hasSales
    ? history
        .filter((d) => base[weekdayOf(d.date)] > 0)
        .map((d) => ({
          date: d.date,
          ratio: d.sales / base[weekdayOf(d.date)],
          precip: historyWeather[d.date] ? historyWeather[d.date].precip : null,
          tmax: historyWeather[d.date] ? historyWeather[d.date].tmax : null,
        }))
    : [];
  const withWeather = rows.filter((r) => r.precip != null);
  const rainyRow = (r) => r.precip != null && r.precip >= RAIN_MM;
  const paydayRow = (r) => PAYDAYS.includes(dayOfMonth(r.date));
  const hotRow = (r) => r.tmax != null && r.tmax >= HEAT_F;
  const rain = learnEffect(withWeather, (r) => rainyRow(r) && !paydayRow(r), (r) => !paydayRow(r));
  const heat = learnEffect(rows.filter((r) => r.tmax != null), (r) => hotRow(r) && !rainyRow(r) && !paydayRow(r), (r) => !rainyRow(r) && !paydayRow(r));
  const payday = learnEffect(rows, (r) => paydayRow(r) && !rainyRow(r), (r) => !rainyRow(r));
  const window = busiestWindow(hours);

  const holidayMap = {};
  days.forEach((d) => Object.assign(holidayMap, usHolidays(Number(d.date.slice(0, 4)))));

  const out = days.map((d) => {
    const w = weekdayOf(d.date);
    const weather = describeWeather(d.code);
    const reasons = [];
    let factor = 1;

    const rainy = (d.precipProb != null && d.precipProb >= RAIN_PROB) || (d.precip != null && d.precip >= RAIN_MM);
    if (rainy) {
      const eff = rain ? rain.effect : TYPICAL_RAIN;
      factor *= eff;
      reasons.push({
        kind: "rain",
        text: `Rain likely (${d.precipProb != null ? d.precipProb + "% chance" : "forecast"})`,
        effect: Math.round((eff - 1) * 100),
        basis: rain ? `your last ${rain.samples} rainy days` : "typical for local shops",
      });
    }
    if (heat && d.tmax != null && d.tmax >= HEAT_F) {
      factor *= heat.effect;
      reasons.push({ kind: "heat", text: `Hot day (${Math.round(d.tmax)}°F)`, effect: Math.round((heat.effect - 1) * 100), basis: `your last ${heat.samples} days over ${HEAT_F}°F` });
    }
    if (payday && PAYDAYS.includes(dayOfMonth(d.date))) {
      factor *= payday.effect;
      reasons.push({ kind: "payday", text: "Payday (1st / 15th)", effect: Math.round((payday.effect - 1) * 100), basis: `your last ${payday.samples} paydays` });
    }
    const holiday = holidayMap[d.date] || null;
    if (holiday) reasons.push({ kind: "holiday", text: holiday, effect: null, basis: "hours and traffic may differ" });

    const closed = hasSales && base[w] === 0;
    const pct = hasSales && !closed ? Math.round(((base[w] * factor) / overall - 1) * 100) : null;
    if (hasSales && !closed && Math.abs(base[w] / overall - 1) >= 0.05) {
      reasons.unshift({
        kind: "weekday",
        text: `${FULL_DAYS[w]}s are usually ${base[w] > overall ? "busier" : "slower"}`,
        effect: Math.round((base[w] / overall - 1) * 100),
        basis: "your last 8 weeks",
      });
    }

    let title;
    if (closed) title = "Usually closed";
    else if (pct == null) title = weather.label;
    else if (holiday) title = `${holiday}: ${pct >= 0 ? "+" : ""}${pct}%`;
    else if (rainy && pct < 0) title = `Rain expected: ${pct}%`;
    else if (pct >= 15) title = `Busy ${FULL_DAYS[w]}: +${pct}%`;
    else if (pct <= -15) title = `Slow day: ${pct}%`;
    else title = `About normal: ${pct >= 0 ? "+" : ""}${pct}%`;

    let action = null;
    if (closed) action = null;
    else if (pct != null && pct >= 15) action = window ? `Add staff ${window}` : "Add a shift";
    else if (rainy && (pct == null || pct <= -8)) action = "Promote order-ahead or delivery";
    else if (pct != null && pct <= -15) action = "Run a slow-day special";

    return {
      date: d.date,
      weekday: WEEKDAYS[w],
      weather: { ...weather, code: d.code, tmax: d.tmax != null ? Math.round(d.tmax) : null, precipProb: d.precipProb },
      pct,
      title,
      reasons,
      action,
      closed,
    };
  });

  return {
    days: out,
    basis: {
      salesDays: history.length,
      averageDay: hasSales ? Math.round(overall) : null,
      confidence: !hasSales ? "none" : history.length >= 42 ? "good" : "early",
      learned: { rain: !!rain, heat: !!heat, payday: !!payday },
      busiestWindow: window,
    },
  };
}

module.exports = { buildForecast, describeWeather, usHolidays, busiestWindow, learnEffect, MIN_SAMPLES };
