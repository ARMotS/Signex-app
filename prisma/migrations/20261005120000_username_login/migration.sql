-- One sign-in form for every role: username + password.
--
-- Additive only. Driver.pinHash loses NOT NULL rather than being dropped, so
-- the previous deploy keeps working while this one rolls out; drop it later.
--
-- Existing ADMIN / SUPER_ADMIN accounts are given a username derived from the
-- local part of their email (see the backfill below), so nobody is locked out
-- of the console by this deploy. Existing DRIVERS are deliberately NOT given
-- credentials: they cannot sign in until an ADMIN sets a username and password
-- for them on the Drivers page, which lists them as "No login".

-- AlterTable
ALTER TABLE "Driver" ADD COLUMN     "passwordHash" TEXT,
ALTER COLUMN "pinHash" DROP NOT NULL;

-- CreateTable
CREATE TABLE "LoginName" (
    "username" TEXT NOT NULL,
    "adminId" TEXT,
    "driverId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LoginName_pkey" PRIMARY KEY ("username"),
    -- Stored lowercase and trimmed, 3-30 of letters/digits/dot/underscore. The
    -- application normalises before writing; this makes "JDoe" and "jdoe"
    -- physically unable to coexist even if a caller forgets.
    CONSTRAINT "LoginName_username_format" CHECK ("username" ~ '^[a-z0-9._]{3,30}$'),
    -- Every username belongs to exactly one account.
    CONSTRAINT "LoginName_one_account" CHECK (num_nonnulls("adminId", "driverId") = 1)
);

-- CreateIndex
CREATE UNIQUE INDEX "LoginName_adminId_key" ON "LoginName"("adminId");

-- CreateIndex
CREATE UNIQUE INDEX "LoginName_driverId_key" ON "LoginName"("driverId");

-- AddForeignKey
ALTER TABLE "LoginName" ADD CONSTRAINT "LoginName_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "Admin"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoginName" ADD CONSTRAINT "LoginName_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: one username per existing Admin row, from its email's local part.
--   "Ops.Lead@example.com" -> "ops.lead"
--   characters outside [a-z0-9._] are dropped, capped at 30
--   a clash gets a numeric suffix (oldest account keeps the bare name)
--   fewer than 3 characters left is padded with a number ("jo" -> "jo1")
-- Ordered by createdAt so the result is deterministic. A loop rather than a
-- window function, because a suffixed name can itself collide with another
-- account's bare name ("sam" + "2" vs. an existing "sam2").
DO $$
DECLARE
  a RECORD;
  base TEXT;
  candidate TEXT;
  n INT;
BEGIN
  FOR a IN SELECT "id", "email" FROM "Admin" ORDER BY "createdAt", "id" LOOP
    base := left(regexp_replace(lower(split_part(a."email", '@', 1)), '[^a-z0-9._]', '', 'g'), 30);
    IF base = '' THEN
      base := 'user';
    END IF;

    n := 0;
    candidate := base;
    WHILE length(candidate) < 3
       OR EXISTS (SELECT 1 FROM "LoginName" WHERE "username" = candidate) LOOP
      n := n + 1;
      candidate := left(base, 30 - length(n::TEXT)) || n::TEXT;
    END LOOP;

    INSERT INTO "LoginName" ("username", "adminId", "updatedAt")
    VALUES (candidate, a."id", CURRENT_TIMESTAMP);
  END LOOP;
END $$;
