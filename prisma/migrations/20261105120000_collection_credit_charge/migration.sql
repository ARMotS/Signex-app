-- The boxes beside "Credit Authorized by" on the office's collection sheet
-- (Charged / NO Charge / 20% to Customer), ticked with the credit decision.
--
-- Additive only: a new enum and one nullable column. Null means none ticked,
-- which is what every existing collection is.

-- CreateEnum
CREATE TYPE "CreditCharge" AS ENUM ('CHARGED', 'NO_CHARGE', 'CUSTOMER_20');

-- AlterTable
ALTER TABLE "Collection" ADD COLUMN "creditCharge" "CreditCharge";
