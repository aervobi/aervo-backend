// Run this once to add missing columns to your users table
// Usage: node scripts/migrate-user-settings.js

require("dotenv").config({ path: "../.env" });
const { Pool } = require("pg");

const isHostedDb =
  process.env.DATABASE_URL && !process.env.DATABASE_URL.includes("localhost");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isHostedDb ? { rejectUnauthorized: false } : false,
});

async function migrate() {
  console.log("🔄 Running user settings migration...");

  const migrations = [
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS name TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS business_type TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS location TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarded BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS platform TEXT`,
    // Backfill name from company_name for existing users
    `UPDATE users SET name = company_name WHERE name IS NULL AND company_name IS NOT NULL`,
  ];

  for (const sql of migrations) {
    try {
      await pool.query(sql);
      console.log("✅", sql.slice(0, 60) + "...");
    } catch (err) {
      console.error("❌ Failed:", sql.slice(0, 60), err.message);
    }
  }

  console.log("✅ Migration complete!");
  await pool.end();
}

migrate();