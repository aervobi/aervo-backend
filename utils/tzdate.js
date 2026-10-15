// Calendar-day helpers for a given IANA time zone (e.g. "America/Denver"), so a
// "daily" email covers the person's own yesterday, not the server's (UTC).
// Uses only Intl, so DST changes and half-hour zones are handled by the platform.

function isValidTimeZone(tz) {
  if (typeof tz !== "string" || !tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// { year, month, day, hour, minute } as they read on a wall clock in `tz` at instant `d`
function localParts(d, tz) {
  const parts = {};
  for (const p of new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d)) {
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  }
  return parts;
}

const pad = (n) => String(n).padStart(2, "0");

// "YYYY-MM-DD" for the local calendar day at instant `d`
function localDate(d, tz) {
  const p = localParts(d, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

function localHour(d, tz) {
  return localParts(d, tz).hour;
}

// Offset of `tz` from UTC at instant `d`, in ms (positive east of Greenwich)
function offsetMs(d, tz) {
  const p = localParts(d, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, 0);
  return asUtc - Math.floor(d.getTime() / 60000) * 60000; // minutes matter: India is +5:30
}

// Add whole days to a "YYYY-MM-DD" string
function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

// The instants [start, end) that bound local calendar day `dateStr` in `tz`.
// A day can be 23 or 25 hours long on DST changes; computing both ends
// separately handles that.
function dayRange(dateStr, tz) {
  const midnight = (ds) => {
    const [y, m, d] = ds.split("-").map(Number);
    const guess = Date.UTC(y, m - 1, d);
    // two passes: the offset at the answer can differ from the offset at the guess
    let t = guess - offsetMs(new Date(guess), tz);
    t = guess - offsetMs(new Date(t), tz);
    return new Date(t);
  };
  return { start: midnight(dateStr), end: midnight(addDays(dateStr, 1)) };
}

module.exports = { isValidTimeZone, localParts, localDate, localHour, addDays, dayRange };
