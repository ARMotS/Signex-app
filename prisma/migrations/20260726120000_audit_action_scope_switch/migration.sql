-- Adds the SCOPE_SWITCH audit action used when a SUPER_ADMIN changes the
-- scope they are viewing.
--
-- Kept in its own migration: ALTER TYPE ... ADD VALUE has historically been
-- restricted inside a transaction block, and Prisma wraps each migration in one.
-- Isolating it means the structural migration cannot fail for this reason.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'SCOPE_SWITCH';
