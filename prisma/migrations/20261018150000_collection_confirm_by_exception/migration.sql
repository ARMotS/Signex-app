-- What the driver brought back, line by line (confirm-by-exception).
--
-- Additive only: nullable columns and two with defaults. The previous deploy
-- neither reads nor writes any of them.

-- AlterTable
ALTER TABLE "Collection" ADD COLUMN     "failReason" TEXT,
ADD COLUMN     "hasVariance" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "CollectionLine" ADD COLUMN     "diffNote" TEXT,
ADD COLUMN     "diffReason" TEXT,
ADD COLUMN     "isExtra" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "qtyCollected" INTEGER;


-- A count of goods is never negative; an extra line lists nothing.
ALTER TABLE "CollectionLine" ADD CONSTRAINT "CollectionLine_collected_nonnegative" CHECK ("qtyCollected" IS NULL OR "qtyCollected" >= 0);
ALTER TABLE "CollectionLine" ADD CONSTRAINT "CollectionLine_extra_lists_nothing" CHECK (NOT "isExtra" OR "qtyListed" = 0);
