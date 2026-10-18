# Aervo plans: what's enforced and what's still to build

Plan limits live in `config/plans.js` and are enforced by the server through
`utils/planAccess.js`. Pages only *explain* limits (`assets/js/plan.js` on the
site); the server is the real gate and fails closed. The public pricing
(`pricing/index.html`, homepage pricing) must match this file.

Plan keys: `free` (shown as **Lite**, not sold), `essential` $29, `pro` $69, `business` $149 a month
(yearly = 2 months free). Repriced 2026-10-17 from $19/$49/$99. Subscribers on the old prices keep
them: the legacy Stripe price IDs and Shopify amounts are still recognised.

**Trial:** every new account is on Pro for 14 days, no card (`trialFor` in `utils/planAccess.js`;
nothing stored, it's derived from `created_at`). No trial for team staff, accounts that ever had a
subscription, or after a checkout trial. Choosing Pro during the trial carries the days left into
Stripe/Shopify. After the trial without a plan: **Lite** (Overview, 7 days, no AI, no emails, no briefing).

_Last reviewed: 2026-10-17 (repricing, trial + Lite, fair-use caps, AI spend tracking)_

## Enforced today

| Feature | Lite | Essential | Pro | Business | Where it's enforced |
|---|---|---|---|---|---|
| Sales sources (Shopify / Square) | 1 | 1 | 2 | 2 | Shopify + Square connect (`checkSourceLimit`) |
| Shopify stores | 1 | 1 | 2 | 5 | Shopify connect (`maxLocations`) |
| Data history | 7 days | 90 days | 2 years | Unlimited | Square orders, top items, appointments (past), customer spend; IMS sales + summary; Shopify orders + overview |
| Ask Aervo messages | none (Lite) | 500 / month fair use | 1,500 fair use | 5,000 fair use | `/api/ai/chat`, `/api/intelligence/chat` (`aiQuota`, table `ai_usage`); pricing page says "unlimited, fair use" |
| AI insights (Intelligence) | built-in only | cached 6h | cached 6h | cached 6h | `/api/intelligence/insights` |
| Daily summary email | No | Yes | Yes | Yes | `runDailySummaries` skips Lite |
| CSV uploads / month | 1 | 5 | 10 | 25 | `routes/csvUpload.js` (`csvUploadsPerMonth`) |
| Dashboard tabs | Overview only | All | All | All | Square + Shopify dashboards (page-level lock) |
| Customer segments | No | Yes | Yes | Yes | Square `/customers/enriched` drops segments |
| Google Reviews | No | Yes | Yes | Yes | `/api/google-reviews` (`requirePlan`) |
| Unified customer view (API) | No | No | Yes | Yes | `/api/unified/*` |
| Team seats | 0 | 0 | 10 | 50 | Team invites (`routes/team.js`) |
| Local market snapshot (Census + AI local angle) | No | Yes | Yes | Yes | `/api/market/snapshot` (`marketSnapshot`) |
| 7-day demand forecast | No | No | Yes | Yes | `/api/market/forecast` (`demandForecast`) |
| Weekly AI market briefing (web search, cited) | No | Yes | Yes | Yes | `/api/market/briefing` (`weeklyBriefing`); Pro also gets a "your week" item from its forecast |
| Competitor radar (Google Places + AI review themes) | No | No | Yes | Yes | `/api/market/competitors` (`competitorRadar`) |
| Trending near you (weekly review-count snapshots) | No | No | Yes | Yes | `/api/market/trending` (`trendingNearby`) |
| 14-day Pro trial (card billing) | | | Once per account | | Stripe checkout (`pro_trial_used_at`) |

Notes:
- Upcoming appointments always show; the history limit applies to the past.
- QuickBooks is accounting, not a sales source, so it isn't counted or gated yet.
- IMS (manual inventory) tabs aren't locked on Lite, because they're where data is
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
| Local Market: opportunities | Pro | Built from snapshot + competitors + the store's own sales |
| Local events in the forecast | Pro | Events API key (Ticketmaster Discovery free, or PredictHQ paid) |
| Competitor benchmarking | Business | Intelligence page has static industry benchmarks only; needs real local comparisons; gate with `competitorBenchmarking` |
| Advanced analytics | Business | Not defined yet |
| Custom integrations | Business | Not defined yet |
| Square locations limit | All | Square syncs every location; limiting to the plan's `maxLocations` would need a location picker |
| Priority support / dedicated onboarding | Business | Process, not code (support inbox, onboarding call) |

## Known gaps in enforcement

- **AI answers can mention older data.** The chat's business context covers the last
  30–90 days for every plan (`utils/aiContext.js`), so a plan's AI can mention data
  older than 7 days.
- **Square dashboard tabs are locked in the page, not on the server.** A Lite user
  calling the API directly can still read their own orders and appointments within 7 days.
- **Shopify installs from the Shopify App Store bypass the source limit.** They don't go
  through `/auth/shopify/connect`, so the limit isn't checked there.
- **Google Reviews' "50 reviews" cap on Essential has no effect.** Google's API returns
  at most 5 reviews anyway.
- **Unused features in `config/plans.js`.** `revenueForecast`, `winBackCampaigns`,
  `aiMarketingCopy`, `whiteLabel` and `competitorBenchmarking` exist there but nothing
  uses them yet; gate each with `requireFeature(pool, "<name>")` when it ships.

## AI spend tracking

`utils/aiSpend.js` hooks the Anthropic SDK and records every Claude call's estimated cost per
account per day in `ai_spend` (shared work such as city briefings is user 0). The Founder view shows
this month's total, shared spend, cost by feature, top accounts and each customer's AI cost. Update
`RATES` there if Anthropic's prices change. Weekly briefings are shared by **city + business type**.
