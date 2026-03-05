const PLANS = require('../config/plans');

function requirePlan(feature) {
  return async (req, res, next) => {
    try {
      const userId = req.user.userId;
      const pool = req.app.locals.pool;
      
      const result = await pool.query(
        'SELECT plan FROM users WHERE id = $1',
        [userId]
      );
      
      const plan = result.rows[0]?.plan || 'free';
      const limits = PLANS[plan];
      
      if (!limits[feature]) {
        return res.status(403).json({
          success: false,
          code: 'PLAN_LIMIT',
          message: `This feature requires a higher plan.`,
          requiredPlan: getRequiredPlan(feature),
          currentPlan: plan,
        });
      }
      
      req.planLimits = limits;
      req.userPlan = plan;
      next();
    } catch (err) {
      console.error('Plan gate error:', err);
      next();
    }
  };
}

function getRequiredPlan(feature) {
  const PLANS = require('../config/plans');
  for (const [plan, limits] of Object.entries(PLANS)) {
    if (limits[feature]) return plan;
  }
  return 'pro';
}

module.exports = { requirePlan };