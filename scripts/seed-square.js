require('dotenv').config();
const { SquareClient, SquareEnvironment } = require('square');
const crypto = require('crypto');

const client = new SquareClient({
  token: 'EAAAl5JbiHvzK5X4na-Bc2LJNmLVIKBpGX4AQ5hxKeGFRGRMclggsFreyFPyD3pS',
  environment: SquareEnvironment.Sandbox
});

const locationId = 'L192HMGGSKXN4';

const customers = [
  { givenName: 'Marcus', familyName: 'Johnson', emailAddress: 'marcus.j@test.com' },
  { givenName: 'DeShawn', familyName: 'Williams', emailAddress: 'deshawn.w@test.com' },
  { givenName: 'Carlos', familyName: 'Rivera', emailAddress: 'carlos.r@test.com' },
  { givenName: 'Jaylen', familyName: 'Brown', emailAddress: 'jaylen.b@test.com' },
  { givenName: 'Antoine', familyName: 'Davis', emailAddress: 'antoine.d@test.com' },
  { givenName: 'Miguel', familyName: 'Santos', emailAddress: 'miguel.s@test.com' },
  { givenName: 'Tyrone', familyName: 'Washington', emailAddress: 'tyrone.w@test.com' },
  { givenName: 'Jordan', familyName: 'Thompson', emailAddress: 'jordan.t@test.com' },
  { givenName: 'Isaiah', familyName: 'Martinez', emailAddress: 'isaiah.m@test.com' },
  { givenName: 'Kendrick', familyName: 'Lewis', emailAddress: 'kendrick.l@test.com' },
];

const services = [
  { name: 'Classic Haircut', amount: 3500 },
  { name: 'Fade + Line Up', amount: 4500 },
  { name: 'Beard Trim', amount: 2000 },
  { name: 'Haircut + Beard Combo', amount: 5500 },
  { name: 'Kids Cut', amount: 2500 },
  { name: 'Shape Up', amount: 1500 },
  { name: 'Hot Towel Shave', amount: 4000 },
  { name: 'Full Service', amount: 7500 },
  { name: 'Hair Design', amount: 5000 },
  { name: 'Taper Fade', amount: 4000 },
];

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function seed() {
  console.log("Creating customers...");
  const customerIds = [];
  for (const c of customers) {
    try {
      const res = await client.customers.create({ ...c, idempotencyKey: crypto.randomUUID() });
      customerIds.push(res.customer.id);
      console.log("Created:", c.givenName, c.familyName);
    } catch (err) {
      console.log("Skipped:", c.givenName, "-", err.message);
    }
  }

  console.log("Creating orders...");
  let count = 0;
  for (let daysAgo = 180; daysAgo >= 0; daysAgo--) {
    const date = new Date();
    date.setDate(date.getDate() - daysAgo);
    const day = date.getDay();
    const ordersToday = day === 5 || day === 6 ? randomBetween(4, 7) : day === 0 ? randomBetween(0, 2) : randomBetween(1, 4);
    for (let i = 0; i < ordersToday; i++) {
      const service = services[randomBetween(0, services.length - 1)];
      const customerId = customerIds[randomBetween(0, customerIds.length - 1)];
      const tip = randomBetween(0, 1) ? randomBetween(200, 800) : 0;
      try {
        await client.orders.create({
          order: {
            locationId,
            customerId,
            lineItems: [
              { name: service.name, quantity: "1", basePriceMoney: { amount: BigInt(service.amount), currency: "USD" } },
              ...(tip > 0 ? [{ name: "Tip", quantity: "1", basePriceMoney: { amount: BigInt(tip), currency: "USD" } }] : [])
            ],
            
          },
          idempotencyKey: crypto.randomUUID()
        });
        count++;
      } catch (err) {
        console.log("Order error:", err.message);
      }
    }
    if (daysAgo % 30 === 0) {
      console.log("Progress:", (180 - daysAgo) + "/180 days,", count, "orders created");
    }
  }
  console.log("Done! Total orders:", count);
  process.exit(0);
}

seed().catch(err => { console.error("Fatal error:", err.message); process.exit(1); });
