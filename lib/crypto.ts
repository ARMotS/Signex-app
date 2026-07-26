/**
 * Symmetric encryption for secrets at rest — currently OneDrive OAuth tokens.
 *
 * AES-256-GCM. Ciphertext is stored as `v1:<iv>:<authTag>:<payload>` (all hex),
 * so a future key rotation can introduce `v2:` and still read `v1:` rows.
 *
 * The key comes from TOKEN_ENCRYPTION_KEY (64 hex chars = 32 bytes). Generate:
 *   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 */

import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12; // GCM standard
const VERSION = "v1";

function loadKey(): Buffer {
  const raw = process.env.TOKEN_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "TOKEN_ENCRYPTION_KEY environment variable is required. " +
        'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }
  const key = Buffer.from(raw, "hex");
  if (key.length !== 32) {
    throw new Error(
      `TOKEN_ENCRYPTION_KEY must be 32 bytes (64 hex characters), got ${key.length} bytes`
    );
  }
  return key;
}

/**
 * Resolved on first use, not at import.
 *
 * Validating at import time made the key a BUILD dependency: Next's page-data
 * collection imports every route module, so a missing or malformed key failed
 * `next build` outright rather than failing the request that actually needed it.
 * That also meant a preview deployment without the variable set could not build.
 *
 * Lazy resolution keeps the fail-fast behaviour where it belongs — the first
 * encrypt or decrypt throws a clear error — while letting the app build and serve
 * every route that does not touch stored tokens.
 */
let cachedKey: Buffer | null = null;

function key(): Buffer {
  if (!cachedKey) cachedKey = loadKey();
  return cachedKey;
}

/**
 * Encrypt a secret for storage. Returns `v1:<iv>:<authTag>:<ciphertext>`.
 */
export function encryptToken(plaintext: string): string {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key(), iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return [
    VERSION,
    iv.toString("hex"),
    authTag.toString("hex"),
    encrypted.toString("hex"),
  ].join(":");
}

/**
 * Decrypt a stored secret. Throws if the payload was tampered with (GCM auth
 * tag mismatch) or if the format is unrecognised.
 */
export function decryptToken(stored: string): string {
  const parts = stored.split(":");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error("Malformed encrypted token — cannot decrypt");
  }

  const [, ivHex, authTagHex, payloadHex] = parts;
  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    key(),
    Buffer.from(ivHex, "hex")
  );
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));

  return Buffer.concat([
    decipher.update(Buffer.from(payloadHex, "hex")),
    decipher.final(),
  ]).toString("utf8");
}

/**
 * True if a stored value is already in encrypted form. Used by the backfill to
 * make encrypting pre-existing plaintext rows idempotent.
 */
export function isEncrypted(value: string): boolean {
  return /^v1:[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/.test(value);
}

// ─── OAuth state (CSRF + scope binding) ───────────────────────────────────

const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function stateSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is required to sign OAuth state");
  return secret;
}

/**
 * Build a signed `state` parameter that binds an OAuth round-trip to one scope.
 *
 * The bare random `state` this replaced was returned to the client and never
 * checked on the way back, which left the callback open to having someone
 * else's authorization code planted on it.
 */
export function signOAuthState(tenantId: string): string {
  const payload = Buffer.from(
    JSON.stringify({
      tenantId,
      nonce: crypto.randomBytes(16).toString("hex"),
      exp: Date.now() + STATE_TTL_MS,
    })
  ).toString("base64url");

  const sig = crypto
    .createHmac("sha256", stateSecret())
    .update(payload)
    .digest("hex");

  return `${payload}.${sig}`;
}

/**
 * Verify a returned `state` and recover the scope it was issued for.
 * Returns null when the signature, format or expiry doesn't check out.
 */
export function verifyOAuthState(state: string | null): { tenantId: string } | null {
  if (!state) return null;

  const [payload, sig] = state.split(".");
  if (!payload || !sig) return null;

  const expected = crypto
    .createHmac("sha256", stateSecret())
    .update(payload)
    .digest("hex");

  const a = Buffer.from(sig, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (typeof data.tenantId !== "string" || !data.tenantId) return null;
    if (typeof data.exp !== "number" || data.exp < Date.now()) return null;
    return { tenantId: data.tenantId };
  } catch {
    return null;
  }
}
