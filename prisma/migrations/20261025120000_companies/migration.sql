-- Companies and COMPANY_ADMIN oversight: a Company owns branches (tenants);
-- a COMPANY_ADMIN account oversees exactly the branch ADMINs a SUPER_ADMIN
-- allocated to it. Composite foreign keys make an allocation across
-- companies, or of anything but a branch, unrepresentable.
--
-- Additive only: a new enum value, new nullable columns, a kind column
-- defaulting to BRANCH (what every existing scope is), and two new tables.
-- No company exists after this migration; prisma/backfill-companies.ts
-- creates one and attaches branches.

-- CreateEnum
CREATE TYPE "TenantKind" AS ENUM ('ROOT', 'BRANCH', 'COMPANY');

-- AlterEnum
ALTER TYPE "UserRole" ADD VALUE 'COMPANY_ADMIN';

-- AlterTable
ALTER TABLE "Admin" ADD COLUMN     "companyId" TEXT;

-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "companyId" TEXT,
ADD COLUMN     "kind" "TenantKind" NOT NULL DEFAULT 'BRANCH';

-- CreateTable
CREATE TABLE "Company" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Company_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompanyAdminAllocation" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "companyAdminId" TEXT NOT NULL,
    "adminId" TEXT NOT NULL,
    "branchTenantId" TEXT NOT NULL,
    "branchKind" "TenantKind" NOT NULL DEFAULT 'BRANCH',
    "allocatedBy" TEXT,
    "allocatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CompanyAdminAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CompanyAdminAllocation_companyAdminId_branchTenantId_idx" ON "CompanyAdminAllocation"("companyAdminId", "branchTenantId");

-- CreateIndex
CREATE INDEX "CompanyAdminAllocation_adminId_idx" ON "CompanyAdminAllocation"("adminId");

-- CreateIndex
CREATE UNIQUE INDEX "CompanyAdminAllocation_companyAdminId_adminId_key" ON "CompanyAdminAllocation"("companyAdminId", "adminId");

-- CreateIndex
CREATE UNIQUE INDEX "Admin_id_companyId_key" ON "Admin"("id", "companyId");

-- CreateIndex
CREATE INDEX "Tenant_companyId_idx" ON "Tenant"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "Tenant_id_companyId_kind_key" ON "Tenant"("id", "companyId", "kind");

-- AddForeignKey
ALTER TABLE "Tenant" ADD CONSTRAINT "Tenant_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Admin" ADD CONSTRAINT "Admin_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanyAdminAllocation" ADD CONSTRAINT "CompanyAdminAllocation_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanyAdminAllocation" ADD CONSTRAINT "CompanyAdminAllocation_companyAdminId_companyId_fkey" FOREIGN KEY ("companyAdminId", "companyId") REFERENCES "Admin"("id", "companyId") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CompanyAdminAllocation" ADD CONSTRAINT "CompanyAdminAllocation_branchTenantId_adminId_fkey" FOREIGN KEY ("branchTenantId", "adminId") REFERENCES "Admin"("tenantId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CompanyAdminAllocation" ADD CONSTRAINT "CompanyAdminAllocation_branchTenantId_companyId_branchKind_fkey" FOREIGN KEY ("branchTenantId", "companyId", "branchKind") REFERENCES "Tenant"("id", "companyId", "kind") ON DELETE CASCADE ON UPDATE RESTRICT;


-- A COMPANY scope always belongs to a company; the ROOT scope never does.
ALTER TABLE "Tenant" ADD CONSTRAINT "Tenant_kind_company"
  CHECK (("kind" <> 'COMPANY' OR "companyId" IS NOT NULL)
     AND ("kind" <> 'ROOT' OR "companyId" IS NULL));

-- Only a BRANCH can be allocated (the composite FK carries the kind).
ALTER TABLE "CompanyAdminAllocation" ADD CONSTRAINT "CompanyAdminAllocation_branch_only"
  CHECK ("branchKind" = 'BRANCH');

-- The SUPER_ADMIN's own scope is the root. Every other existing scope is one
-- ADMIN's workspace, which the BRANCH default already says.
UPDATE "Tenant" t SET "kind" = 'ROOT'
WHERE EXISTS (
  SELECT 1 FROM "Admin" a
  JOIN "User" u ON lower(u."email") = lower(a."email")
  WHERE a."tenantId" = t."id" AND u."role" = 'SUPER_ADMIN'
);
