-- The office's approve / reject decision on a credit return that came back.
-- A trip cannot be completed while any CR collection that was collected or
-- partly collected is undecided.
--
-- Additive only: a new enum and four nullable columns.

-- CreateEnum
CREATE TYPE "CreditReview" AS ENUM ('APPROVED', 'REJECTED');

-- AlterTable
ALTER TABLE "Collection" ADD COLUMN     "creditReview" "CreditReview",
ADD COLUMN     "creditReviewReason" TEXT,
ADD COLUMN     "creditReviewedAt" TIMESTAMP(3),
ADD COLUMN     "creditReviewedBy" TEXT;

