-- The customer's confirmation of a courier delivery: the email (with the
-- same claim/lease columns as Stop), the confirm link's token (hashed for
-- lookup, encrypted for the reminder), the one reminder, and when the
-- customer confirmed.
--
-- Additive only: nullable columns, and two NOT NULL columns with defaults.

-- AlterTable
ALTER TABLE "CourierTripSheet" ADD COLUMN     "confirmTokenEnc" TEXT,
ADD COLUMN     "confirmTokenExpiresAt" TIMESTAMP(3),
ADD COLUMN     "confirmTokenHash" TEXT,
ADD COLUMN     "confirmedAt" TIMESTAMP(3),
ADD COLUMN     "emailAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "emailError" TEXT,
ADD COLUMN     "emailLastAttemptAt" TIMESTAMP(3),
ADD COLUMN     "emailRecipient" TEXT,
ADD COLUMN     "emailSentAt" TIMESTAMP(3),
ADD COLUMN     "emailStatus" "EmailStatus" NOT NULL DEFAULT 'NOT_SENT',
ADD COLUMN     "reminderSentAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "CourierTripSheet_confirmTokenHash_key" ON "CourierTripSheet"("confirmTokenHash");
