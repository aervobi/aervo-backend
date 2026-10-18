# Aervo plans: what's enforced and what's still to build

Plan limits live in `config/plans.js` and are enforced by the server through
`utils/planAccess.js`. Pages only *explain* limits (`assets/js/plan.js` on the
site); the server is the real gate and fails closed. The public pricing
(`pricing/index.html`, homepage pricing) must match this file.

Plan keys: `free` (shown as **Starter**), `essential`, `pro`, `business`.

_Last reviewed: 2026-10-17 (Local Market phase 1 added)_

## Enforced today

| Feature | Starter | Essential | Pro | Business | Where it's enforced |
|---|---|---|---|---|---|
| Sales sources (Shopify / Square) | 1 | 1 | 2 | 2 | Shopify + Square connect (`checkSourceLimit`) |
| Shopify stores | 1 | 1 | 2 | 5 | Shopify connect (`maxLocations`) |
| Data history | 7 days | 90 days | 2 years | Unlimited | Square orders, top items, appointments (past), customer spend; IMS sales + summary; Shopify orders + overview |
| Ask Aervo messages | 3 / month | Unlimited | Unlimited | Unlimited | `/api/ai/chat`, `/api/intelligence/chat` (`aiQuota`, table `ai_usage`) |
| Dashboard tabs | Overview only | All | All | All | Square + Shopify dashboards (page-level lock) |
| Customer segments | No | Yes | Yes | Yes | Square `/customers/enriched` drops segments |
| Google Reviews | No | Yes | Yes | Yes | `/api/google-reviews` (`requirePlan`) |
| Unified customer view (API) | No | No | Yes | Yes | `/api/unified/*` |
| Team seats | 0 | 0 | 10 | 50 | Team invites (`routes/team.js`) |
| Local market snapshot (Census + AI local angle) | No | Yes | Yes | Yes | `/api/market/snapshot` (`marketSnapshot`) |
| 7-day demand forecast | No | No | Yes | Yes | `/api/market/forecast` (`demandForecast`) |
| 14-day Pro trial (card billing) | | | Once per account | | Stripe checkout (`pro_trial_used_at`) |

Notes:
- Upcoming appointments always show; the history limit applies to the past.
- QuickBooks is accounting, not a sales source, so it isn't counted or gated yet.
- IMS (manual inventory) tabs aren't locked on Starter, because they're where data is
  entered; only history is limited.
- Founder accounts switch plans for free (`/api/founder/plan`) and are gated like anyone
  else on the plan they pick.

## Promised but not built yet

Marked "coming soon" on the pricing pages until they ship.

| Feature | Plan | What's needed |
|---|---|---|
| AI Revenue Forecasting | Pro | Forecast from order history (Square/Shopify/IMS) + a chart; gate with `revenueForecast` |
| Win-back campaign generator | Pro | At-risk list exists (Square segments, Shopify "60+ days"); needs AI email/SMS drafts and sending; gate with `winBackCampaigns` |
| AI Marketing Copy | Pro | Prompted generator for posts/emails; gate with `aiMarketingCopy` |
| Staff performance scores | Pro | Square team members are now synced; needs sales per staff + scoring |
| Unified customer view (page) | Pro | API exists (`/api/unified/overview`, now Pro+); no page uses it yet |
| White-label reports | Business | Reports exist and logo upload exists; reports need the company logo/name and no Aervo branding; gate with `whiteLabel` |
| Local Market: weekly AI briefing | Essential+ | AI with web search, cached per area + category; needs a search-enabled model call |
| Local Market: competitor radar + trending near you | Pro | Google Places API (billing must be on); review themes by AI |
| Local Market: opportunities | Pro | Built from snapshot + competitors + the store's own sales |
| Local events in the forecast | Pro | Events API key (Ticketmaster Discovery free, or PredictHQ paid) |
| Competitor benchmarking | Business | Intelligence page has static industry benchmarks only; needs real local comparisons; gate with `competitorBenchmarking` |
| Advanced analytics | Business | Not defined yet |
| Custom integrations | Business | Not defined yet |
| Square locations limit | All | Square syncs every location; limiting to the plan's `maxLocations` would need a location picker |
| Priority support / dedicated onboarding | Business | Process, not code (support inbox, onboarding call) |

## Known gaps in enforcement

- **AI answers can mention older data.** The chat's business context covers the last
  30–90 days for every plan (`utils/aiContext.js`), so Starter's AI can mention data
  older than 7 days.
- **Square dashboard tabs are locked in the page, not on the server.** A Starter user
  calling the API directly can still read their own orders and appointments within 7 days.
- **Shopify installs from the Shopify App Store bypass the source limit.** They don't go
  through `/auth/shopify/connect`, so the limit isn't checked there.
- **Google Reviews' "50 reviews" cap on Essential has no effect.** Google's API returns
  at most 5 reviews anyway.
- **Unused features in `config/plans.js`.** `revenueForecast`, `winBackCampaigns`,
  `aiMarketingCopy`, `whiteLabel` and `competitorBenchmarking` exist there but nothing
  uses them yet; gate each with `requireFeature(pool, "<name>")` when it ships.
