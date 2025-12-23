require("@shopify/shopify-api/adapters/node");
const { shopifyApi, ApiVersion } = require("@shopify/shopify-api");

const apiKey = process.env.SHOPIFY_API_KEY;
const apiSecret = process.env.SHOPIFY_API_SECRET;

function makeDisabledShim() {
  const thrower = () => {
    throw new Error(
      "Shopify client not initialized. Set SHOPIFY_API_KEY and SHOPIFY_API_SECRET in environment."
    );
  };

  const ShimClient = class {
    constructor() {
      thrower();
    }
  };

  return {
    initialized: false,
    clients: {
      Rest: ShimClient,
      Graphql: ShimClient,
    },
    auth: {
      begin: () => thrower(),
      callback: () => thrower(),
    },
    webhooks: {
      register: () => thrower(),
    },
  };
}

if (!apiKey || !apiSecret) {
  // Warn but don't crash — makes development easier when Shopify creds are absent
  console.warn(
    "SHOPIFY_API_KEY or SHOPIFY_API_SECRET missing — Shopify integration disabled until configured."
  );
  module.exports = { shopify: makeDisabledShim() };
} else {
  // Initialize shopify instance using v6 initializer
  const hostName = (process.env.HOST || process.env.APP_URL || "").replace(/^https?:\/\//, "").replace(/:\d+$/, "");

  const shopify = shopifyApi({
    apiKey: apiKey,
    apiSecretKey: apiSecret,
    scopes: (process.env.SHOPIFY_SCOPES || "read_products").split(","),
    hostName: hostName,
    isEmbeddedApp: false,
    apiVersion: process.env.SHOPIFY_API_VERSION || ApiVersion.Unstable,
  });

  module.exports = { shopify };
}
