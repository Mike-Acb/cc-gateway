/**
 * Create the cc_gateway database on the PostgreSQL server.
 *
 * Connection is configured via env vars:
 *   PGHOST (default: 1.2.3.4)
 *   PGPORT (default: 5432)
 *   PGUSER (default: cc_gateway)
 *   PGPASSWORD (default: change-me-password)
 */
import pg from "pg";

const client = new pg.Client({
  host: process.env.PGHOST ?? "1.2.3.4",
  port: Number(process.env.PGPORT ?? 5432),
  user: process.env.PGUSER ?? "cc_gateway",
  password: process.env.PGPASSWORD ?? "change-me-password",
  database: "postgres",
  connectionTimeoutMillis: 10_000,
});

async function main() {
  await client.connect();
  console.log("Connected to postgres.");

  const res = await client.query(
    "SELECT 1 FROM pg_database WHERE datname = 'cc_gateway'"
  );

  if (res.rowCount && res.rowCount > 0) {
    console.log("Database cc_gateway already exists, skipping.");
  } else {
    await client.query("CREATE DATABASE cc_gateway");
    console.log("Database cc_gateway created.");
  }

  await client.end();
}

main().catch((err) => {
  console.error("Failed to create database:", err.message);
  process.exit(1);
});
