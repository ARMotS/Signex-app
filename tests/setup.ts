/**
 * Test environment bootstrap.
 *
 * Provides the secrets lib/session.ts and lib/crypto.ts fail-fast on at import
 * time, so unit tests never need a real .env. Integration tests additionally
 * need TEST_DATABASE_URL (see tests/helpers/db.ts).
 */

process.env.SESSION_SECRET ||= "test-session-secret-".padEnd(128, "0");
process.env.TOKEN_ENCRYPTION_KEY ||= "11".repeat(32); // 32 bytes of hex

// Point Prisma at the throwaway test database when one is configured, so an
// integration run can never touch a real DATABASE_URL by accident.
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.DATABASE_URL_DIRECT = process.env.TEST_DATABASE_URL;
}
