// Route gate: requirePlan("googleReviews") lets the request through only when
// the caller's plan includes that feature (config/plans.js). Fails CLOSED: if
// the plan can't be read, the request is refused rather than unlocked.
const { requireFeature } = require("../utils/planAccess");

function requirePlan(feature) {
  return (req, res, next) => requireFeature(req.app.locals.pool, feature)(req, res, next);
}

module.exports = { requirePlan };
