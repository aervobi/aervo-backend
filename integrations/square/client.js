const { SquareClient, SquareEnvironment } = require('square');

function buildSquareClient(accessToken) {
  const environment =
    process.env.SQUARE_ENVIRONMENT === 'production'
      ? SquareEnvironment.Production
      : SquareEnvironment.Sandbox;

  const client = new SquareClient({
    token: accessToken,
    environment,
  });

  // Map old API names to new SDK structure
  client.locationsApi = client.locations;
  client.ordersApi = client.orders;
  client.customersApi = client.customers;
  client.catalogApi = client.catalog;
  client.bookingsApi = client.bookings;
  client.inventoryApi = client.inventory;
  client.paymentsApi = client.payments;

  return client;
}

function buildAppClient() {
  return buildSquareClient(process.env.SQUARE_APP_SECRET);
}

module.exports = { buildSquareClient, buildAppClient };
