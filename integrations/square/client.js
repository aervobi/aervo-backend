const { Client, Environment } = require('square');

function buildSquareClient(accessToken) {
  const environment =
    process.env.SQUARE_ENVIRONMENT === 'production'
      ? Environment.Production
      : Environment.Sandbox;

  return new Client({
    accessToken,
    environment,
    additionalHeaders: { 'X-Aervo-Client': 'aervo/1.0' },
  });
}

function buildAppClient() {
  return buildSquareClient(process.env.SQUARE_APP_SECRET);
}

module.exports = { buildSquareClient, buildAppClient };