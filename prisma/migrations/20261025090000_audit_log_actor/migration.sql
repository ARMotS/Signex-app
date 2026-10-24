-- The audit log records who did it (actor, role), from where (IP, user agent,
-- device) and structured detail, gains the action types the usage dashboard
-- needs, and becomes append-only at the database level.
--
-- Additive apart from one dropped foreign key (AuditLog.tenantId -> Tenant):
-- the history of a workspace must outlive the workspace, and the key forced
-- deleting a tenant to rewrite its audit rows, which append-only forbids.

-- AlterEnum (PostgreSQL 12+ allows several in one migration; none is used here)
ALTER TYPE "AuditAction" ADD VALUE 'LOGIN_FAILED';
ALTER TYPE "AuditAction" ADD VALUE 'PASSWORD_CHANGE';
ALTER TYPE "AuditAction" ADD VALUE 'USERNAME_CHANGE';
ALTER TYPE "AuditAction" ADD VALUE 'ROLE_CHANGE';
ALTER TYPE "AuditAction" ADD VALUE 'ACCOUNT_CREATE';
ALTER TYPE "AuditAction" ADD VALUE 'ACCOUNT_UPDATE';
ALTER TYPE "AuditAction" ADD VALUE 'ACCOUNT_DEACTIVATE';
ALTER TYPE "AuditAction" ADD VALUE 'ACCOUNT_REACTIVATE';
ALTER TYPE "AuditAction" ADD VALUE 'ACCOUNT_DELETE';
ALTER TYPE "AuditAction" ADD VALUE 'EXPORT';
ALTER TYPE "AuditAction" ADD VALUE 'FILE_DELETE';

-- DropForeignKey
ALTER TABLE "AuditLog" DROP CONSTRAINT "AuditLog_tenantId_fkey";

-- AlterTable
ALTER TABLE "AuditLog" ADD COLUMN     "actorId" TEXT,
ADD COLUMN     "actorRole" "UserRole",
ADD COLUMN     "deviceId" TEXT,
ADD COLUMN     "ip" TEXT,
ADD COLUMN     "metadata" JSONB,
ADD COLUMN     "userAgent" TEXT;

-- CreateIndex
CREATE INDEX "AuditLog_actorId_createdAt_idx" ON "AuditLog"("actorId", "createdAt");

-- Append-only. Row-level, so TRUNCATE (the test suite's reset) is not
-- covered; anything else that tries to rewrite or erase history fails loudly.
CREATE FUNCTION "audit_log_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'AuditLog is append-only: % is not allowed', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "AuditLog_append_only"
  BEFORE UPDATE OR DELETE ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION "audit_log_append_only"();
