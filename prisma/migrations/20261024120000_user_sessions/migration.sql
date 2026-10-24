-- One row per signed-in device (lib/session.ts). Every authenticated request
-- now checks its session against this table, so a revoked device is signed
-- out on its next request instead of when its 24h cookie expires.
--
-- Additive only. Admin.sessionTokens / Admin.sessionToken / Driver.sessionToken
-- stay and are still written, so the previous deploy keeps validating through
-- the rollout; they are dropped in a later migration.

-- CreateTable
CREATE TABLE "UserSession" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "adminId" TEXT,
    "driverId" TEXT,
    "deviceId" TEXT,
    "userAgent" TEXT,
    "browser" TEXT,
    "os" TEXT,
    "deviceType" TEXT,
    "ipAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokedReason" TEXT,

    CONSTRAINT "UserSession_pkey" PRIMARY KEY ("id"),
    -- A session belongs to exactly one account.
    CONSTRAINT "UserSession_one_account" CHECK (num_nonnulls("adminId", "driverId") = 1)
);

-- CreateIndex
CREATE UNIQUE INDEX "UserSession_tokenHash_key" ON "UserSession"("tokenHash");

-- CreateIndex
CREATE INDEX "UserSession_adminId_revokedAt_idx" ON "UserSession"("adminId", "revokedAt");

-- CreateIndex
CREATE INDEX "UserSession_driverId_revokedAt_idx" ON "UserSession"("driverId", "revokedAt");

-- CreateIndex
CREATE INDEX "UserSession_deviceId_idx" ON "UserSession"("deviceId");

-- CreateIndex
CREATE INDEX "UserSession_lastSeenAt_idx" ON "UserSession"("lastSeenAt");

-- AddForeignKey
ALTER TABLE "UserSession" ADD CONSTRAINT "UserSession_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "Admin"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserSession" ADD CONSTRAINT "UserSession_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Carry every session that is signed in today across, so the deploy signs
-- nobody out — least of all a driver mid-route. Device details are unknown
-- for these; the cookie's own expiry still ends them on time, and expiresAt
-- here only bounds how long they count toward the device limit.
INSERT INTO "UserSession" ("id", "tokenHash", "adminId", "expiresAt")
SELECT gen_random_uuid()::text,
       encode(sha256(convert_to(t.token, 'UTF8')), 'hex'),
       t."adminId",
       CURRENT_TIMESTAMP + INTERVAL '24 hours'
FROM (
    SELECT a."id" AS "adminId", s.token
    FROM "Admin" a, unnest(a."sessionTokens") AS s(token)
    UNION
    SELECT a."id", a."sessionToken"
    FROM "Admin" a
    WHERE a."sessionToken" IS NOT NULL
) t
ON CONFLICT ("tokenHash") DO NOTHING;

INSERT INTO "UserSession" ("id", "tokenHash", "driverId", "expiresAt")
SELECT gen_random_uuid()::text,
       encode(sha256(convert_to(d."sessionToken", 'UTF8')), 'hex'),
       d."id",
       CURRENT_TIMESTAMP + INTERVAL '24 hours'
FROM "Driver" d
WHERE d."sessionToken" IS NOT NULL
ON CONFLICT ("tokenHash") DO NOTHING;
