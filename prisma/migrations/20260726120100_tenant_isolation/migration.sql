-- Strict per-ADMIN data isolation.
--
-- Adds a scope (tenantId) to the models that had none, makes previously-global
-- uniqueness per-scope, and adds composite foreign keys so a row in one scope
-- cannot reference a row in another.
--
-- IMPORTANT -- ordering. Prisma's generated diff adds the new tenantId columns as
-- `NOT NULL DEFAULT ''` and then adds a foreign key to Tenant(id). On a
-- populated database that fails: every pre-existing row would hold '' and no
-- tenant has an empty id. So this migration inserts a BACKFILL step (section 4)
-- between adding the columns and adding the constraints.
--
-- This migration only makes the schema valid with existing data intact -- every
-- row lands in the root scope. Splitting each ADMIN into its OWN scope is done
-- afterwards by `npm run db:backfill-isolation -- --apply`, which needs cuid
-- generation and writes audit entries.

-- --- 1. Drop constraints that are about to be replaced --------------------

ALTER TABLE "TripSheet" DROP CONSTRAINT "TripSheet_driverId_fkey";
ALTER TABLE "TripSheet" DROP CONSTRAINT "TripSheet_adminId_fkey";
ALTER TABLE "Stop" DROP CONSTRAINT "Stop_tripSheetId_fkey";
ALTER TABLE "Stop" DROP CONSTRAINT "Stop_contactId_fkey";

-- Driver names become unique per scope, not globally. A global constraint let
-- one ADMIN's duplicate-name error disclose another ADMIN's driver names.
DROP INDEX "Driver_name_key";

-- One OneDrive connection PER SCOPE, not one per installation.
DROP INDEX "CloudAccount_provider_key";

-- Import state becomes per-scope, so one ADMIN importing a filename does not
-- mark it consumed for every other ADMIN.
DROP INDEX "ImportedFile_filename_key";

-- --- 2. Tenant gains an owner ---------------------------------------------

ALTER TABLE "Tenant" ADD COLUMN "ownerAdminId" TEXT;

-- --- 3. Add the missing scope columns -------------------------------------
--
-- The DEFAULT '' is a type-level convenience only (it lets application code omit
-- tenantId from create payloads while the scoped Prisma client injects the real
-- value). The foreign keys added in section 6 make an actual '' unstorable.

ALTER TABLE "Admin"        ADD COLUMN "tenantId" TEXT NOT NULL DEFAULT '';
ALTER TABLE "CloudAccount" ADD COLUMN "tenantId" TEXT NOT NULL DEFAULT '';
ALTER TABLE "ImportedFile" ADD COLUMN "tenantId" TEXT NOT NULL DEFAULT '';

-- Nullable by design: pre-session events (failed logins) have no scope yet.
ALTER TABLE "AuditLog"     ADD COLUMN "tenantId" TEXT;

-- AppConfig becomes per-scope key/value: the invoice folder, trip sheet folder
-- and signature position are one ADMIN's settings, not the installation's.
ALTER TABLE "AppConfig" DROP CONSTRAINT "AppConfig_pkey",
  ADD COLUMN "tenantId" TEXT NOT NULL DEFAULT '',
  ADD CONSTRAINT "AppConfig_pkey" PRIMARY KEY ("tenantId", "key");

-- Existing scope columns pick up the same convenience default.
ALTER TABLE "User"      ALTER COLUMN "tenantId" SET DEFAULT '';
ALTER TABLE "Driver"    ALTER COLUMN "tenantId" SET DEFAULT '';
ALTER TABLE "TripSheet" ALTER COLUMN "tenantId" SET DEFAULT '';
ALTER TABLE "Stop"      ALTER COLUMN "tenantId" SET DEFAULT '';
ALTER TABLE "Contact"   ALTER COLUMN "tenantId" SET DEFAULT '';

-- --- 4. BACKFILL -- must run before the constraints in sections 5 and 6 ----

DO $$
DECLARE
  root_id TEXT;
BEGIN
  -- Reuse the existing root scope, or create one if this is a fresh database.
  SELECT "id" INTO root_id FROM "Tenant" WHERE "slug" = 'default' LIMIT 1;

  IF root_id IS NULL THEN
    SELECT "id" INTO root_id FROM "Tenant" ORDER BY "createdAt" ASC LIMIT 1;
  END IF;

  IF root_id IS NULL THEN
    -- Empty database (e.g. a fresh CI/test instance): nothing to backfill, and
    -- creating a tenant here would fabricate data. Skip.
    RETURN;
  END IF;

  -- An Admin's scope follows the User row that shares its email, where one
  -- exists -- that is where the tenant was previously derived from at login.
  UPDATE "Admin" a
     SET "tenantId" = COALESCE(
           (SELECT u."tenantId" FROM "User" u
             WHERE lower(u."email") = lower(a."email")
               AND u."tenantId" <> '' LIMIT 1),
           root_id)
   WHERE a."tenantId" = '';

  UPDATE "AppConfig"    SET "tenantId" = root_id WHERE "tenantId" = '';
  UPDATE "CloudAccount" SET "tenantId" = root_id WHERE "tenantId" = '';
  UPDATE "ImportedFile" SET "tenantId" = root_id WHERE "tenantId" = '';
  UPDATE "AuditLog"     SET "tenantId" = root_id WHERE "tenantId" IS NULL;

  -- Defensive: no pre-existing row should have a blank scope, but a blank here
  -- would fail the foreign keys below with a much less obvious error.
  UPDATE "User"      SET "tenantId" = root_id WHERE "tenantId" = '';
  UPDATE "Driver"    SET "tenantId" = root_id WHERE "tenantId" = '';
  UPDATE "TripSheet" SET "tenantId" = root_id WHERE "tenantId" = '';
  UPDATE "Stop"      SET "tenantId" = root_id WHERE "tenantId" = '';
  UPDATE "Contact"   SET "tenantId" = root_id WHERE "tenantId" = '';

  -- Composite foreign keys below require parent and child to agree on scope.
  -- Realign any row that disagrees, taking the parent as authoritative.
  UPDATE "TripSheet" t SET "tenantId" = d."tenantId"
    FROM "Driver" d WHERE t."driverId" = d."id" AND t."tenantId" <> d."tenantId";

  UPDATE "Stop" s SET "tenantId" = t."tenantId"
    FROM "TripSheet" t WHERE s."tripSheetId" = t."id" AND s."tenantId" <> t."tenantId";

  -- A stop pointing at a contact in another scope cannot be represented once the
  -- composite FK exists. Detach rather than delete -- the signature and delivery
  -- record are kept, only the (invalid) contact link is dropped.
  UPDATE "Stop" s SET "contactId" = NULL
    FROM "Contact" c
   WHERE s."contactId" = c."id" AND s."tenantId" <> c."tenantId";

  -- Same for a trip sheet attributed to an admin in another scope.
  UPDATE "TripSheet" t SET "adminId" = NULL
    FROM "Admin" a
   WHERE t."adminId" = a."id" AND t."tenantId" <> a."tenantId";
END $$;

-- --- 5. Indexes and per-scope uniqueness ----------------------------------

CREATE UNIQUE INDEX "Tenant_ownerAdminId_key" ON "Tenant"("ownerAdminId");

CREATE INDEX "Admin_tenantId_idx" ON "Admin"("tenantId");
CREATE UNIQUE INDEX "Admin_tenantId_id_key" ON "Admin"("tenantId", "id");

CREATE UNIQUE INDEX "Driver_tenantId_name_key" ON "Driver"("tenantId", "name");
CREATE UNIQUE INDEX "Driver_tenantId_id_key" ON "Driver"("tenantId", "id");

CREATE UNIQUE INDEX "TripSheet_tenantId_id_key" ON "TripSheet"("tenantId", "id");

CREATE INDEX "AppConfig_tenantId_idx" ON "AppConfig"("tenantId");

CREATE INDEX "CloudAccount_tenantId_idx" ON "CloudAccount"("tenantId");
CREATE UNIQUE INDEX "CloudAccount_tenantId_provider_key" ON "CloudAccount"("tenantId", "provider");

CREATE INDEX "ImportedFile_tenantId_idx" ON "ImportedFile"("tenantId");
CREATE UNIQUE INDEX "ImportedFile_tenantId_filename_key" ON "ImportedFile"("tenantId", "filename");

CREATE INDEX "AuditLog_tenantId_createdAt_idx" ON "AuditLog"("tenantId", "createdAt");

CREATE UNIQUE INDEX "Contact_tenantId_id_key" ON "Contact"("tenantId", "id");

-- --- 6. Foreign keys ------------------------------------------------------
--
-- The simple tenantId -> Tenant(id) keys are what make "no row without a valid
-- scope" a database guarantee rather than an application convention.

ALTER TABLE "Admin"        ADD CONSTRAINT "Admin_tenantId_fkey"        FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AppConfig"    ADD CONSTRAINT "AppConfig_tenantId_fkey"    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CloudAccount" ADD CONSTRAINT "CloudAccount_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ImportedFile" ADD CONSTRAINT "ImportedFile_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AuditLog"     ADD CONSTRAINT "AuditLog_tenantId_fkey"     FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The composite keys are the strong part: they make a cross-scope reference
-- unrepresentable, so an application bug cannot create one.

ALTER TABLE "TripSheet" ADD CONSTRAINT "TripSheet_tenantId_driverId_fkey" FOREIGN KEY ("tenantId", "driverId") REFERENCES "Driver"("tenantId", "id")    ON DELETE CASCADE  ON UPDATE NO ACTION;
ALTER TABLE "TripSheet" ADD CONSTRAINT "TripSheet_tenantId_adminId_fkey"  FOREIGN KEY ("tenantId", "adminId")  REFERENCES "Admin"("tenantId", "id")     ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "Stop"      ADD CONSTRAINT "Stop_tenantId_tripSheetId_fkey"   FOREIGN KEY ("tenantId", "tripSheetId") REFERENCES "TripSheet"("tenantId", "id") ON DELETE CASCADE  ON UPDATE NO ACTION;
ALTER TABLE "Stop"      ADD CONSTRAINT "Stop_tenantId_contactId_fkey"     FOREIGN KEY ("tenantId", "contactId")   REFERENCES "Contact"("tenantId", "id")   ON DELETE RESTRICT ON UPDATE NO ACTION;
