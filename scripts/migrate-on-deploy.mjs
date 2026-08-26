#!/usr/bin/env node
/**
 * Apply pending migrations — but only where applying them is correct.
 *
 * `npm run build` runs on EVERY Vercel deployment, previews included. With
 * `prisma migrate deploy` wired directly into that script, opening a pull
 * request applied its migrations to whatever database the Preview environment
 * happened to point at — which, by Vercel's default of enabling a variable for
 * all environments, was production. A destructive migration therefore reached
 * production from a branch nobody had reviewed, let alone merged, and it
 * arrived BEFORE the code that needed it.
 *
 * Unsetting DATABASE_URL_DIRECT for Preview does not fix this on its own:
 * prisma.config.ts falls back to DATABASE_URL, so the migration still lands,
 * just through the pooled endpoint. The gate has to be here, in code that is
 * versioned and reviewed, rather than in a checkbox someone can re-tick.
 *
 * The rule: migrations belong to production deployments. Everything else
 * builds without touching a schema.
 *
 *   VERCEL_ENV=production   migrate      the real deploy
 *   VERCEL_ENV=preview      SKIP         a pull request must not migrate
 *   VERCEL_ENV=development  SKIP         `vercel dev`
 *   VERCEL_ENV unset        migrate      a local `npm run build`, against
 *                                        whatever the local .env points at
 *
 * This is a floor, not a substitute for pointing Preview at its own database
 * branch. A preview deployment still connects to DATABASE_URL at RUNTIME, so
 * while Preview shares production's connection string, half-finished code is
 * reading and writing live delivery data. Skipping the migration protects the
 * schema; only a separate database branch protects the rows.
 */

import { spawnSync } from "node:child_process";

const vercelEnv = process.env.VERCEL_ENV;
const shouldMigrate = vercelEnv === undefined || vercelEnv === "production";

if (!shouldMigrate) {
  console.log(
    `[migrate] VERCEL_ENV=${vercelEnv} — skipping migrations. Only production ` +
      `deployments migrate; see scripts/migrate-on-deploy.mjs.`
  );
  process.exit(0);
}

console.log(
  `[migrate] VERCEL_ENV=${vercelEnv ?? "<unset, local build>"} — applying ` +
    `pending migrations.`
);

const result = spawnSync(
  "npx",
  ["prisma", "migrate", "deploy"],
  { stdio: "inherit", shell: process.platform === "win32" }
);

// A failed migration must fail the build. Shipping code whose schema was not
// applied is the one outcome worse than not shipping at all.
process.exit(result.status ?? 1);
