// What each plan includes. The server enforces these through utils/planAccess.js;
// the pricing page (pricing/index.html) must say the same thing.
// Infinity = unlimited. Plan keys: free (shown as "Lite"), essential, pro, business.
//
// New accounts get a 14-day Pro trial with no card (utils/planAccess.js
// effectivePlan). When it ends without a paid plan they drop to "Lite": a
// near-zero-cost, read-only mode (Overview, 7 days, no AI) that keeps the
// door open for win-back. Lite is not sold or shown on the pricing page.
//
// aiMessagesPerMonth on paid plans is a fair-use cap (the pricing page says
// "unlimited"): almost nobody reaches it, but it stops one account from
// erasing a plan's margin.
const PLANS = {
  free: {
    name: "Lite",
    priceMonthly: 0,
    integrations: 1,
    dataHistoryDays: 7,
    aiMessagesPerMonth: 0,
    csvUploadsPerMonth: 1,
    fullDashboard: false,
    googleReviews: false,
    customerSegmentation: false,
    unifiedView: false, // one customer view across Shopify + Square
    marketSnapshot: false, // Local Market: area facts (Census) + local angle
    demandForecast: false, // Local Market: 7-day expected traffic
    weeklyBriefing: false, // Local Market: "This week in <city>" AI briefing
    competitorRadar: false, // Local Market: nearby competitors + review themes (Google Places)
    trendingNearby: false, // Local Market: fastest-growing and new places nearby
    revenueForecast: false,
    winBackCampaigns: false,
    aiMarketingCopy: false,
    whiteLabel: false,
    competitorBenchmarking: false,
    maxLocations: 1,
    teamSeats: 0, // people on the team, owner and pending invites included
  },
  essential: {
    name: "Essential",
    priceMonthly: 29,
    integrations: 1,
    dataHistoryDays: 90,
    aiMessagesPerMonth: 500,
    csvUploadsPerMonth: 5,
    fullDashboard: true,
    googleReviews: 50,
    customerSegmentation: true,
    unifiedView: false, // one customer view across Shopify + Square
    marketSnapshot: true, // Local Market: area facts (Census) + local angle
    demandForecast: false, // Local Market: 7-day expected traffic
    weeklyBriefing: true, // Local Market: "This week in <city>" AI briefing
    competitorRadar: false, // Local Market: nearby competitors + review themes (Google Places)
    trendingNearby: false, // Local Market: fastest-growing and new places nearby
    revenueForecast: false,
    winBackCampaigns: false,
    aiMarketingCopy: false,
    whiteLabel: false,
    competitorBenchmarking: false,
    maxLocations: 1,
    teamSeats: 0, // people on the team, owner and pending invites included
  },
  pro: {
    name: "Pro",
    priceMonthly: 69,
    integrations: 2,
    dataHistoryDays: 730,
    aiMessagesPerMonth: 1500,
    csvUploadsPerMonth: 10,
    fullDashboard: true,
    googleReviews: Infinity,
    customerSegmentation: true,
    unifiedView: true, // one customer view across Shopify + Square
    marketSnapshot: true, // Local Market: area facts (Census) + local angle
    demandForecast: true, // Local Market: 7-day expected traffic
    weeklyBriefing: true, // Local Market: "This week in <city>" AI briefing
    competitorRadar: true, // Local Market: nearby competitors + review themes (Google Places)
    trendingNearby: true, // Local Market: fastest-growing and new places nearby
    revenueForecast: true,
    winBackCampaigns: true,
    aiMarketingCopy: true,
    whiteLabel: false,
    competitorBenchmarking: false,
    maxLocations: 2,
    teamSeats: 10, // people on the team, owner and pending invites included
  },
  business: {
    name: "Business",
    priceMonthly: 149,
    integrations: 5,
    dataHistoryDays: Infinity,
    aiMessagesPerMonth: 5000,
    csvUploadsPerMonth: 25,
    fullDashboard: true,
    googleReviews: Infinity,
    customerSegmentation: true,
    unifiedView: true, // one customer view across Shopify + Square
    marketSnapshot: true, // Local Market: area facts (Census) + local angle
    demandForecast: true, // Local Market: 7-day expected traffic
    weeklyBriefing: true, // Local Market: "This week in <city>" AI briefing
    competitorRadar: true, // Local Market: nearby competitors + review themes (Google Places)
    trendingNearby: true, // Local Market: fastest-growing and new places nearby
    revenueForecast: true,
    winBackCampaigns: true,
    aiMarketingCopy: true,
    whiteLabel: true,
    competitorBenchmarking: true,
    maxLocations: 5,
    teamSeats: 50, // people on the team, owner and pending invites included
  },
};

module.exports = PLANS;