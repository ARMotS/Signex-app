-- The collection sheet a credit note names in its own text ("CRC-23328").
--
-- Additive only: one nullable column. Null means the note names none, which
-- is what every existing note reads as until it is read again.

-- AlterTable
ALTER TABLE "CreditNote" ADD COLUMN "collectionRef" TEXT;
