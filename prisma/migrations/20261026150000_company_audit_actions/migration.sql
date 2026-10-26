-- Audit action types for the SUPER_ADMIN's company console: companies created
-- and changed, branches attached and detached, branch admins allocated to and
-- removed from a COMPANY_ADMIN. Enum values only (PostgreSQL 12+ allows
-- several in one migration; none is used here).

-- AlterEnum


ALTER TYPE "AuditAction" ADD VALUE 'COMPANY_CREATE';
ALTER TYPE "AuditAction" ADD VALUE 'COMPANY_UPDATE';
ALTER TYPE "AuditAction" ADD VALUE 'BRANCH_ATTACH';
ALTER TYPE "AuditAction" ADD VALUE 'BRANCH_DETACH';
ALTER TYPE "AuditAction" ADD VALUE 'ALLOCATE';
ALTER TYPE "AuditAction" ADD VALUE 'DEALLOCATE';

