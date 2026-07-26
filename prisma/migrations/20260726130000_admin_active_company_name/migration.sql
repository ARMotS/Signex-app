-- Admin deactivation, and a public-facing company name per scope.
--
-- Admin.active: a deactivated ADMIN cannot log in. Their drivers are deliberately
-- unaffected and keep signing in, so suspending an office account does not strand
-- drivers part-way through a run.
--
-- Tenant.companyName: the label shown in the driver-login company picker. This is
-- the ONLY field of a scope exposed before authentication, and only for scopes
-- whose owning ADMIN is active. Backfilled from Tenant.name below so existing
-- scopes do not render as a blank option in that dropdown.

ALTER TABLE "Admin" ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT true;

CREATE INDEX "Admin_active_idx" ON "Admin"("active");

ALTER TABLE "Tenant" ADD COLUMN "companyName" TEXT;

UPDATE "Tenant" SET "companyName" = "name" WHERE "companyName" IS NULL;
