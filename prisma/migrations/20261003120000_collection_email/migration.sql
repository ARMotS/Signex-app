-- Email the signed collection receipt to the customer, as delivery
-- confirmations are. Same columns and states as Stop's email tracking.
--
-- Additive only: every column is nullable or defaulted, so existing rows need
-- no backfill and the previous deploy's code keeps working against this schema.
-- AlterTable
ALTER TABLE "Collection" ADD COLUMN     "emailAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "emailError" TEXT,
ADD COLUMN     "emailLastAttemptAt" TIMESTAMP(3),
ADD COLUMN     "emailSentAt" TIMESTAMP(3),
ADD COLUMN     "emailStatus" "EmailStatus" NOT NULL DEFAULT 'NOT_SENT';
