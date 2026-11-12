-- The customer's credit-note email (lib/credit-note-email.ts). Additive only:
-- every existing note reads NOT_SENT, and nothing sends one by itself except
-- signing it (or finishing the filing of its signed copy).
ALTER TABLE "CreditNote" ADD COLUMN "emailStatus" "EmailStatus" NOT NULL DEFAULT 'NOT_SENT',
ADD COLUMN "emailRecipient" TEXT,
ADD COLUMN "emailSentAt" TIMESTAMP(3),
ADD COLUMN "emailError" TEXT,
ADD COLUMN "emailAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "emailLastAttemptAt" TIMESTAMP(3);
