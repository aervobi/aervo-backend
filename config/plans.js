// What each plan includes. The server enforces these through utils/planAccess.js;
// the pricing page (pricing/index.html) must say the same thing.
// Infinity = unlimited. Plan keys: free (shown as "Starter"), essential, pro, business.
const PLANS = {
  free: {
    name: "Starter",
    integrations: 1,
    dataHistoryDays: 7,
    aiMessagesPerMonth: 3,
    fullDashboard: false,
    googleReviews: false,
    customerSegmentation: false,
    unifiedView: false, // one customer view across Shopify + Square
    marketSnapshot: false, // Local Market: area facts (Census) + local angle
    demandForecast: false, // Local Market: 7-day expected traffic
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
    integrations: 1,
    dataHistoryDays: 90,
    aiMessagesPerMonth: Infinity,
    fullDashboard: true,
    googleReviews: 50,
    customerSegmentation: true,
    unifiedView: false, // one customer view across Shopify + Square
    marketSnapshot: true, // Local Market: area facts (Census) + local angle
    demandForecast: false, // Local Market: 7-day expected traffic
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
    integrations: 2,
    dataHistoryDays: 730,
    aiMessagesPerMonth: Infinity,
    fullDashboard: true,
    googleReviews: Infinity,
    customerSegmentation: true,
    unifiedView: true, // one customer view across Shopify + Square
    marketSnapshot: true, // Local Market: area facts (Census) + local angle
    demandForecast: true, // Local Market: 7-day expected traffic
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
    integrations: 5,
    dataHistoryDays: Infinity,
    aiMessagesPerMonth: Infinity,
    fullDashboard: true,
    googleReviews: Infinity,
    customerSegmentation: true,
    unifiedView: true, // one customer view across Shopify + Square
    marketSnapshot: true, // Local Market: area facts (Census) + local angle
    demandForecast: true, // Local Market: 7-day expected traffic
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