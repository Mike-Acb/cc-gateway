/**
 * Run SQL migrations against the cc_gateway database.
 *
 * Usage: npx tsx scripts/run-migration.ts [migration_file]
 *   Defaults to migrations/001_core.sql
 *
 * Connection is configured via env vars:
 *   PGHOST (default: 1.2.3.4)
 *   PGPORT (default: 5432)
 *   PGUSER (default: cc_gateway)
 *   PGPASSWORD (default: change-me-password)
 *   PGDATABASE (default: cc_gateway)
 */
import pg from "pg";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const client = new pg.Client({
  host: process.env.PGHOST ?? "1.2.3.4",
  port: Number(process.env.PGPORT ?? 5432),
  user: process.env.PGUSER ?? "cc_gateway",
  password: process.env.PGPASSWORD ?? "change-me-password",
  database: process.env.PGDATABASE ?? "cc_gateway",
  connectionTimeoutMillis: 10_000,
});

async function main() {
  const migrationFile =
    process.argv[2] ??
    path.resolve(__dirname, "../migrations/001_core.sql");

  const sqlPath = path.resolve(migrationFile);
  if (!fs.existsSync(sqlPath)) {
    console.error(`Migration file not found: ${sqlPath}`);
    process.exit(1);
  }

  await client.connect();
  console.log(`Connected to ${client.database}.`);

  const sql = fs.readFileSync(sqlPath, "utf-8");

  console.log(`Running migration ${path.basename(sqlPath)} ...`);
  await client.query(sql);
  console.log(`Migration ${path.basename(sqlPath)} completed successfully.`);

  // Verify: list all tables
  const res = await client.query(`
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public'
    ORDER BY tablename
  `);

  console.log(`\nTables in ${client.database} (${res.rows.length}):`);
  for (const row of res.rows) {
    console.log(`  - ${row.tablename}`);
  }

  await client.end();
}

main().catch((err) => {
  console.error("Migration failed:", err.message);
  process.exit(1);
});
