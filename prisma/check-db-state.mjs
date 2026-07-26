// READ-ONLY. Reports whether a database needs the migration baseline step.
// Usage:  CHECK_URL="postgres://..." node check-db-state.mjs
import pg from "pg";

const url = process.env.CHECK_URL;
if (!url) {
  console.error('Set CHECK_URL to a direct postgres:// URL (not prisma+postgres://).');
  process.exit(2);
}

const c = new pg.Client({
  connectionString: url,
  ssl: /localhost|127\.0\.0\.1/.test(url) ? undefined : { rejectUnauthorized: false },
});

try {
  await c.connect();
} catch (e) {
  console.error(`Could not connect: ${e.message}`);
  process.exit(2);
}

const one = async (sql) => (await c.query(sql)).rows[0];

const { n: appTables } = await one(`
  SELECT count(*)::int n FROM information_schema.tables
   WHERE table_schema='public'
     AND table_name IN ('Tenant','Admin','User','Driver','TripSheet','Stop','Contact')`);

const { n: hasMigrationsTable } = await one(`
  SELECT count(*)::int n FROM information_schema.tables
   WHERE table_schema='public' AND table_name='_prisma_migrations'`);

const { n: alreadyIsolated } = await one(`
  SELECT count(*)::int n FROM information_schema.columns
   WHERE table_schema='public' AND table_name='Admin' AND column_name='tenantId'`);

let appliedMigrations = [];
if (hasMigrationsTable) {
  appliedMigrations = (
    await c.query(
      `SELECT migration_name, finished_at FROM "_prisma_migrations" ORDER BY started_at`
    )
  ).rows;
}

let counts = null;
if (appTables > 0) {
  try {
    counts = await one(`
      SELECT (SELECT count(*) FROM "Admin")::int     admins,
             (SELECT count(*) FROM "Driver")::int    drivers,
             (SELECT count(*) FROM "TripSheet")::int trip_sheets,
             (SELECT count(*) FROM "Stop")::int      stops,
             (SELECT count(*) FROM "Contact")::int   contacts`);
  } catch {
    /* partial schema */
  }
}

console.log("\n--- database state ---");
console.log(`  app tables present      : ${appTables}/7`);
console.log(`  _prisma_migrations table: ${hasMigrationsTable ? "yes" : "no"}`);
console.log(`  Admin.tenantId exists   : ${alreadyIsolated ? "yes" : "no"}`);
if (counts) {
  console.log(
    `  row counts              : ${counts.admins} admins, ${counts.drivers} drivers, ` +
      `${counts.trip_sheets} trip sheets, ${counts.stops} stops, ${counts.contacts} contacts`
  );
}
if (appliedMigrations.length) {
  console.log("  applied migrations      :");
  for (const m of appliedMigrations) {
    console.log(`      ${m.finished_at ? "ok     " : "PENDING"} ${m.migration_name}`);
  }
}

console.log("\n--- what to do ---");
if (alreadyIsolated) {
  console.log("  Already migrated. Skip the baseline; just run the backfill:");
  console.log("     npm run db:backfill-isolation            (dry run)");
  console.log("     npm run db:backfill-isolation -- --apply");
} else if (appTables === 0) {
  console.log("  Empty database. No baseline needed — `prisma migrate deploy`");
  console.log("  will create everything from scratch. Nothing to back-fill either.");
} else if (!hasMigrationsTable) {
  console.log("  BASELINE REQUIRED. The old schema exists with no migration history,");
  console.log("  so `migrate deploy` would try to CREATE TABLE over live tables.");
  console.log("  Mark the initial migration as already-applied first:");
  console.log("     npx prisma migrate resolve --applied 0_init");
  console.log("  Then deploy, then run the backfill.");
} else {
  const names = appliedMigrations.map((m) => m.migration_name);
  console.log(
    names.includes("0_init")
      ? "  Baseline already recorded. Deploy, then run the backfill."
      : "  Migration history exists but 0_init is not in it — check before deploying."
  );
}
console.log("");

await c.end();
