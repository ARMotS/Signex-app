-- An ADMIN may be signed in on up to three devices at once.
-- Additive only: "sessionToken" stays (and is still written) until a later
-- deploy, so the previous code keeps working through the rollout.
ALTER TABLE "Admin" ADD COLUMN "sessionTokens" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- Carry each live session across, so nobody is signed out by the deploy.
UPDATE "Admin" SET "sessionTokens" = ARRAY["sessionToken"] WHERE "sessionToken" IS NOT NULL;
