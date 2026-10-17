-- The invoice number reduced to the digits every document agrees on
-- (INV-2026-1047 on the PDF, 1047 on the trip sheet and the credit note).
--
-- Additive only: nullable, so the previous deploy's code keeps working against
-- this schema and existing rows need nothing at migrate time. They are filled
-- by `npm run db:backfill-invoice-no` — in TypeScript, not SQL, because the
-- rule lives in lib/invoice-number.ts and a tenant may override it with its
-- own pattern; a second copy of it here would drift.

-- AlterTable
ALTER TABLE "Stop" ADD COLUMN     "invoiceNoNormalized" TEXT;

-- AlterTable
ALTER TABLE "Collection" ADD COLUMN     "invoiceNoNormalized" TEXT;

-- CreateIndex
CREATE INDEX "Stop_tenantId_invoiceNoNormalized_idx" ON "Stop"("tenantId", "invoiceNoNormalized");

-- CreateIndex
CREATE INDEX "Collection_tenantId_invoiceNoNormalized_idx" ON "Collection"("tenantId", "invoiceNoNormalized");
