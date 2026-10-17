// integrations/square/util.js
// Helpers for the Square SDK (v40+) and Square's raw webhook payloads.
//
//  - List calls (customers, catalog, bookings...) return a Page, not a plain
//    response: the items are in page.data and further pages are fetched by
//    iterating it. Reading response.customers / response.cursor silently gets
//    nothing (or only the first page).
//  - Money amounts come back as BigInt, which JSON.stringify can't handle.
//  - Webhook bodies are Square's raw JSON (snake_case), while the SDK and our
//    upsert code use camelCase.

// Every item from a Page (all pages). Stops at `max` items as a safety net.
async function collectPages(pagePromise, max = 200000) {
  const page = await pagePromise;
  const items = [];
  for await (const item of page) {
    items.push(item);
    if (items.length >= max) break;
  }
  return items;
}

const jsonSafe = (obj) => JSON.stringify(obj, (k, v) => (typeof v === 'bigint' ? v.toString() : v));

// Square money amount (BigInt, number, string or missing) -> number of cents
const cents = (amount) => (amount == null ? 0 : Number(amount));

// snake_case keys -> camelCase, deeply (values are left alone)
function camelize(value) {
  if (Array.isArray(value)) return value.map(camelize);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k.replace(/_([a-z0-9])/g, (m, c) => c.toUpperCase())] = camelize(v);
  }
  return out;
}

module.exports = { collectPages, jsonSafe, cents, camelize };
