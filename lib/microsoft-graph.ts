/**
 * Microsoft Graph API client for OneDrive integration.
 * Handles OAuth token management (refresh) and file operations.
 *
 * ── Isolation contract ────────────────────────────────────────────────────
 * Every function in this module takes `tenantId` as its FIRST argument, and the
 * access token it uses is loaded from the CloudAccount row belonging to that
 * scope and nothing else. There is no ambient "the OneDrive account" any more —
 * each ADMIN connects their own drive, and an ADMIN's session can neither load
 * another ADMIN's tokens nor list, read or write their files.
 *
 * `tenantId` MUST always come from the signed session cookie via getScope().
 * No function here accepts an admin id or tenant id supplied by a client.
 *
 * Tokens are encrypted at rest (AES-256-GCM, lib/crypto.ts). Plaintext exists
 * only in memory, for the duration of a request.
 */

import { scopedPrisma } from "./db-scoped";
import { encryptToken, decryptToken } from "./crypto";
import { acquireLock, releaseLock } from "./lock";
// Every Graph call goes through graphFetch so a 429 is retried with Graph's own
// Retry-After rather than surfacing as a failure. See lib/graph-retry.ts.
import { graphFetch } from "./graph-retry";

const MICROSOFT_AUTH_URL = "https://login.microsoftonline.com/common/oauth2/v2.0";
const GRAPH_API_URL = "https://graph.microsoft.com/v1.0";

const SCOPES = ["Files.Read", "Files.ReadWrite", "Files.Read.All", "Files.ReadWrite.All", "User.Read", "offline_access"];

const PROVIDER = "onedrive";

/** Subfolder of the invoice folder holding countersigned copies. */
const SIGNED_SUBFOLDER = "signed";

/**
 * Subfolders of the COLLECTIONS folder.
 *
 * The collections folder is a sibling of the invoice folder, not a subfolder of
 * it: the invoice listing must never pick up a collection document, and the
 * collections listing must never pick up an invoice. Keeping them in separate
 * configured folders is what makes that true by construction — see
 * assertCollectionsFolderIsSibling in lib/collections.ts, which refuses a
 * nested configuration.
 */
const COLLECTIONS_PENDING_SUBFOLDER = "Pending";
const COLLECTIONS_SIGNED_SUBFOLDER = "Signed";

function getClientId(): string {
  const id = process.env.MICROSOFT_CLIENT_ID;
  if (!id) throw new Error("MICROSOFT_CLIENT_ID is not configured");
  return id;
}

function getClientSecret(): string {
  const secret = process.env.MICROSOFT_CLIENT_SECRET;
  if (!secret) throw new Error("MICROSOFT_CLIENT_SECRET is not configured");
  return secret;
}

function getRedirectUri(): string {
  return process.env.MICROSOFT_REDIRECT_URI || `${process.env.NEXT_PUBLIC_APP_URL}/api/auth/microsoft/callback`;
}

export function getAuthorizationUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: getClientId(),
    response_type: "code",
    redirect_uri: getRedirectUri(),
    response_mode: "query",
    scope: SCOPES.join(" "),
    state,
  });
  return `${MICROSOFT_AUTH_URL}/authorize?${params.toString()}`;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
}

export async function exchangeCodeForTokens(code: string): Promise<TokenResponse> {
  const body = new URLSearchParams({
    client_id: getClientId(),
    client_secret: getClientSecret(),
    code,
    redirect_uri: getRedirectUri(),
    grant_type: "authorization_code",
  });

  const res = await fetch(`${MICROSOFT_AUTH_URL}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Token exchange failed: ${err}`);
  }

  return res.json();
}

async function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
  const body = new URLSearchParams({
    client_id: getClientId(),
    client_secret: getClientSecret(),
    refresh_token: refreshToken,
    grant_type: "refresh_token",
    scope: SCOPES.join(" "),
  });

  const res = await fetch(`${MICROSOFT_AUTH_URL}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Token refresh failed: ${err}`);
  }

  return res.json();
}

/**
 * Load this scope's OneDrive account row, or null if this ADMIN hasn't connected
 * a drive. A scoped read — another scope's row is simply not visible.
 */
async function getAccount(tenantId: string) {
  return scopedPrisma(tenantId).cloudAccount.findFirst({
    where: { provider: PROVIDER },
  });
}

/**
 * Get a valid access token for THIS scope's OneDrive account.
 * Refreshes automatically if expired. Returns null if the scope has no
 * connection — never falls back to another scope's token.
 */
type CloudAccountRow = NonNullable<Awaited<ReturnType<typeof getAccount>>>;

/** Refresh when the token has under five minutes left. */
const REFRESH_WINDOW_MS = 5 * 60 * 1000;

/**
 * In-flight refreshes for THIS instance, keyed by scope.
 *
 * Twenty drivers signing in at shift change would otherwise each start their
 * own token exchange. Sharing one promise collapses that to a single call.
 */
const inFlightRefresh = new Map<string, Promise<string | null>>();

export async function getValidAccessToken(tenantId: string): Promise<string | null> {
  const account = await getAccount(tenantId);
  if (!account) return null;

  if (account.tokenExpiry.getTime() - Date.now() >= REFRESH_WINDOW_MS) {
    return decryptToken(account.accessToken);
  }

  // Layer 1 — collapse concurrent callers inside this instance.
  const existing = inFlightRefresh.get(tenantId);
  if (existing) return existing;

  const pending = refreshForScope(tenantId, account).finally(() => {
    inFlightRefresh.delete(tenantId);
  });
  inFlightRefresh.set(tenantId, pending);

  return pending;
}

/**
 * Refresh this scope's token exactly once, across every serverless instance.
 *
 * ── Why this needs three layers ───────────────────────────────────────────
 * Microsoft ROTATES refresh tokens: using one invalidates it and issues a
 * replacement. So concurrent refreshes are not merely wasteful, they are
 * destructive — two instances refreshing from the same stored token produce two
 * different replacements, and whichever writes last wins. The loser's token is
 * already dead, and the branch's OneDrive stays broken until an admin
 * reconnects it by hand.
 *
 *   1. An in-process promise map (above) collapses callers within one instance.
 *   2. A Redis lock stops other instances starting a redundant exchange.
 *   3. A compare-and-swap on the write is what actually guarantees correctness,
 *      because the lock can expire mid-flight and Redis may be absent entirely.
 *
 * Layer 3 alone would be correct but wasteful; layers 1 and 2 exist to avoid
 * hammering Microsoft with exchanges that will be thrown away.
 */
async function refreshForScope(
  tenantId: string,
  account: CloudAccountRow
): Promise<string | null> {
  const lock = await acquireLock(`lock:onedrive-refresh:${tenantId}`);

  if (!lock) {
    // Another instance is already refreshing. Give it a moment and re-read
    // rather than starting a competing exchange.
    const adopted = await adoptRefreshedToken(tenantId, account.refreshToken);
    if (adopted) return adopted;
    // It did not finish in time — fall through and do it ourselves. The
    // compare-and-swap below keeps that safe.
  }

  try {
    return await performRefresh(tenantId, account);
  } finally {
    if (lock) await releaseLock(lock);
  }
}

/**
 * Wait briefly for whoever holds the lock to publish a new token.
 * Returns null if nothing changed in time.
 */
async function adoptRefreshedToken(
  tenantId: string,
  previousRefreshCiphertext: string
): Promise<string | null> {
  for (let attempt = 0; attempt < 5; attempt++) {
    await new Promise((r) => setTimeout(r, 300));

    const latest = await getAccount(tenantId);
    if (!latest) return null;

    // The stored refresh token changing is the signal that a refresh landed.
    if (latest.refreshToken !== previousRefreshCiphertext) {
      return decryptToken(latest.accessToken);
    }
  }
  return null;
}

async function performRefresh(
  tenantId: string,
  account: CloudAccountRow
): Promise<string | null> {
  try {
    const currentRefresh = decryptToken(account.refreshToken);
    const tokens = await refreshAccessToken(currentRefresh);
    const newExpiry = new Date(Date.now() + tokens.expires_in * 1000);

    // Compare-and-swap: only write if the stored refresh token is still the one
    // we exchanged. Ciphertext is compared rather than plaintext, which works
    // because this is the exact value read at the start — AES-GCM is
    // non-deterministic, so re-encrypting would never match.
    const res = await scopedPrisma(tenantId).cloudAccount.updateMany({
      where: { provider: PROVIDER, refreshToken: account.refreshToken },
      data: {
        accessToken: encryptToken(tokens.access_token),
        refreshToken: encryptToken(tokens.refresh_token || currentRefresh),
        tokenExpiry: newExpiry,
      },
    });

    if (res.count === 0) {
      // Someone rotated it first. Their token is the live one; ours is already
      // invalid, so discard it rather than overwriting theirs.
      const latest = await getAccount(tenantId);
      return latest ? decryptToken(latest.accessToken) : null;
    }

    return tokens.access_token;
  } catch (err) {
    console.error(`Failed to refresh OneDrive token for scope ${tenantId}:`, err);
    return null;
  }
}

/**
 * Save OAuth tokens after initial authorization, into ONE scope.
 */
export async function saveCloudAccount(
  tenantId: string,
  tokens: TokenResponse
): Promise<void> {
  const expiry = new Date(Date.now() + tokens.expires_in * 1000);

  // Fetch user profile to store account info
  let accountEmail: string | undefined;
  let accountName: string | undefined;
  try {
    const profile = await graphGetWithToken("/me", tokens.access_token);
    accountEmail = profile.mail || profile.userPrincipalName;
    accountName = profile.displayName;
  } catch {
    // non-critical
  }

  const db = scopedPrisma(tenantId);
  const existing = await getAccount(tenantId);

  if (existing) {
    await db.cloudAccount.updateMany({
      where: { provider: PROVIDER },
      data: {
        accessToken: encryptToken(tokens.access_token),
        refreshToken: encryptToken(tokens.refresh_token),
        tokenExpiry: expiry,
        accountEmail,
        accountName,
      },
    });
  } else {
    await db.cloudAccount.create({
      data: {
        provider: PROVIDER,
        accessToken: encryptToken(tokens.access_token),
        refreshToken: encryptToken(tokens.refresh_token),
        tokenExpiry: expiry,
        accountEmail,
        accountName,
      },
    });
  }
}

/**
 * Remove THIS scope's OneDrive connection. Other scopes are untouched.
 */
export async function disconnectCloudAccount(tenantId: string): Promise<void> {
  await scopedPrisma(tenantId).cloudAccount.deleteMany({
    where: { provider: PROVIDER },
  });
}

/**
 * Get this scope's cloud account status (without exposing tokens).
 */
export async function getCloudAccountStatus(tenantId: string) {
  const account = await getAccount(tenantId);

  if (!account) return null;

  return {
    provider: account.provider,
    accountEmail: account.accountEmail,
    accountName: account.accountName,
    connected: true,
    tokenExpiry: account.tokenExpiry.toISOString(),
    folderPath: account.folderPath,
    folderItemId: account.folderItemId,
    invoiceFolderPath: account.invoiceFolderPath,
    invoiceFolderItemId: account.invoiceFolderItemId,
    collectionsFolderPath: account.collectionsFolderPath,
    collectionsFolderItemId: account.collectionsFolderItemId,
  };
}

// ─── Graph API helpers ────────────────────────────────────────────────────

/** Graph GET with an explicit token — used during the OAuth exchange only. */
async function graphGetWithToken(endpoint: string, accessToken: string): Promise<any> {
  const url = endpoint.startsWith("http") ? endpoint : `${GRAPH_API_URL}${endpoint}`;
  const res = await graphFetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Graph API error (${res.status}): ${err}`);
  }

  return res.json();
}

/** Resolve this scope's token or fail. Never falls through to another scope. */
async function requireToken(tenantId: string): Promise<string> {
  const token = await getValidAccessToken(tenantId);
  if (!token) throw new Error("No valid OneDrive access token for this account");
  return token;
}

async function graphGet(tenantId: string, endpoint: string): Promise<any> {
  return graphGetWithToken(endpoint, await requireToken(tenantId));
}

/**
 * Follow Graph's @odata.nextLink until the whole collection is retrieved.
 *
 * Graph pages children at ~200 items, so a single request silently truncated
 * large folders. Every page is fetched with THIS scope's token.
 */
async function graphGetAllItems(
  tenantId: string,
  endpoint: string
): Promise<OneDriveItem[]> {
  const items: OneDriveItem[] = [];
  let next: string | null = endpoint;

  while (next) {
    const data = await graphGet(tenantId, next);
    if (Array.isArray(data.value)) {
      items.push(...(data.value as OneDriveItem[]));
    }
    // nextLink is an absolute URL; graphGet passes it through unchanged.
    next = (data["@odata.nextLink"] as string | undefined) ?? null;
  }

  return items;
}

/**
 * Like graphGet, but a 404 is an ANSWER rather than an error.
 *
 * Used for "does this file exist" lookups, where a missing file is an ordinary
 * outcome. Every other status still throws — a 403 or a 500 must not be
 * mistaken for "not there", which would silently report an unsigned invoice as
 * never having been signed.
 */
async function graphGetOrNull<T>(
  tenantId: string,
  endpoint: string
): Promise<T | null> {
  const token = await requireToken(tenantId);
  const url = endpoint.startsWith("http") ? endpoint : `${GRAPH_API_URL}${endpoint}`;

  const res = await graphFetch(url, { headers: { Authorization: `Bearer ${token}` } });

  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`Graph API error (${res.status}): ${await res.text()}`);
  }
  return res.json();
}

/**
 * Like graphGetBuffer, but a 404 means "no such file" rather than an error.
 * Lets a single request both locate and download a file.
 */
async function graphGetBufferOrNull(
  tenantId: string,
  endpoint: string
): Promise<Buffer | null> {
  const token = await requireToken(tenantId);
  const url = endpoint.startsWith("http") ? endpoint : `${GRAPH_API_URL}${endpoint}`;

  const res = await graphFetch(url, { headers: { Authorization: `Bearer ${token}` } });

  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`Graph API error (${res.status}): ${await res.text()}`);
  }

  return Buffer.from(await res.arrayBuffer());
}

async function graphGetBuffer(tenantId: string, endpoint: string): Promise<Buffer> {
  const token = await requireToken(tenantId);

  const url = endpoint.startsWith("http") ? endpoint : `${GRAPH_API_URL}${endpoint}`;
  const res = await graphFetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Graph API error (${res.status}): ${err}`);
  }

  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

// ─── OneDrive file operations ─────────────────────────────────────────────

export interface OneDriveItem {
  id: string;
  name: string;
  size: number;
  lastModifiedDateTime: string;
  file?: { mimeType: string };
  folder?: { childCount: number };
  parentReference?: { path: string };
}

export interface OneDriveFolder {
  id: string;
  name: string;
  path: string;
  children: OneDriveItem[];
}

/**
 * List the root folders in this scope's OneDrive.
 */
export async function listRootFolders(tenantId: string): Promise<OneDriveItem[]> {
  return graphGetAllItems(tenantId, "/me/drive/root/children?$top=200");
}

/**
 * List children of a specific folder by item ID.
 *
 * The item ID is resolved against THIS scope's drive using THIS scope's token,
 * so an ID belonging to another admin's drive returns a Graph 404.
 */
export async function listFolderById(
  tenantId: string,
  itemId: string
): Promise<OneDriveItem[]> {
  return graphGetAllItems(tenantId, `/me/drive/items/${itemId}/children?$top=200`);
}

/**
 * List children of a folder by path.
 * Path should be relative to root, e.g. "Documents/TripSheets"
 */
export async function listFolderByPath(
  tenantId: string,
  folderPath: string
): Promise<OneDriveItem[]> {
  const encodedPath = encodeURIComponent(folderPath).replace(/%2F/g, "/");
  return graphGetAllItems(
    tenantId,
    `/me/drive/root:/${encodedPath}:/children?$top=200`
  );
}

/**
 * Get folder metadata by path.
 */
export async function getFolderByPath(
  tenantId: string,
  folderPath: string
): Promise<OneDriveItem> {
  const encodedPath = encodeURIComponent(folderPath).replace(/%2F/g, "/");
  return graphGet(tenantId, `/me/drive/root:/${encodedPath}`);
}

/**
 * Download a file by its item ID. Returns raw Buffer.
 */
export async function downloadFileById(
  tenantId: string,
  itemId: string
): Promise<Buffer> {
  return graphGetBuffer(tenantId, `/me/drive/items/${itemId}/content`);
}

/**
 * Download a file by its path relative to OneDrive root.
 */
export async function downloadFileByPath(
  tenantId: string,
  filePath: string
): Promise<Buffer> {
  const encodedPath = encodeURIComponent(filePath).replace(/%2F/g, "/");
  return graphGetBuffer(tenantId, `/me/drive/root:/${encodedPath}:/content`);
}

/**
 * Set the configured OneDrive folder for trip sheets, for this scope.
 */
export async function setOneDriveFolder(
  tenantId: string,
  folderPath: string,
  folderItemId: string
): Promise<void> {
  await scopedPrisma(tenantId).cloudAccount.updateMany({
    where: { provider: PROVIDER },
    data: { folderPath, folderItemId },
  });
}

/**
 * Set the configured OneDrive folder for invoices, for this scope.
 */
export async function setOneDriveInvoiceFolder(
  tenantId: string,
  folderPath: string,
  folderItemId: string
): Promise<void> {
  await scopedPrisma(tenantId).cloudAccount.updateMany({
    where: { provider: PROVIDER },
    data: { invoiceFolderPath: folderPath, invoiceFolderItemId: folderItemId },
  });
}

/**
 * Set the configured OneDrive folder for collections, for this scope.
 *
 * A sibling of the invoice folder, never inside it. The caller checks that;
 * this only stores what it was given.
 */
export async function setOneDriveCollectionsFolder(
  tenantId: string,
  folderPath: string,
  folderItemId: string
): Promise<void> {
  await scopedPrisma(tenantId).cloudAccount.updateMany({
    where: { provider: PROVIDER },
    data: { collectionsFolderPath: folderPath, collectionsFolderItemId: folderItemId },
  });
}

/**
 * List pending collection documents in this scope's Collections/Pending folder.
 *
 * Deliberately reads only the Pending subfolder: a document that has been
 * signed has moved on to Signed/ and must not come back as outstanding work.
 */
export async function listOneDriveCollectionDocuments(
  tenantId: string
): Promise<OneDriveItem[]> {
  const account = await getAccount(tenantId);

  if (!account?.collectionsFolderItemId) return [];

  const children = await listFolderById(tenantId, account.collectionsFolderItemId);
  const pendingFolder = children.find(
    (item) =>
      item.folder &&
      item.name.toLowerCase() === COLLECTIONS_PENDING_SUBFOLDER.toLowerCase()
  );
  if (!pendingFolder) return [];

  const items = await listFolderById(tenantId, pendingFolder.id);
  return items.filter((item) => {
    if (item.folder) return false;
    return item.name.toLowerCase().endsWith(".pdf");
  });
}

/**
 * List signed collection documents in this scope's Collections/Signed folder.
 *
 * Nothing is ever deleted or moved out of Signed/ — it is the permanent record
 * a completed trip's archive view links back to.
 */
export async function listOneDriveSignedCollections(
  tenantId: string
): Promise<OneDriveItem[]> {
  const account = await getAccount(tenantId);

  if (!account?.collectionsFolderItemId) return [];

  const children = await listFolderById(tenantId, account.collectionsFolderItemId);
  const signedFolder = children.find(
    (item) =>
      item.folder &&
      item.name.toLowerCase() === COLLECTIONS_SIGNED_SUBFOLDER.toLowerCase()
  );
  if (!signedFolder) return [];

  const items = await listFolderById(tenantId, signedFolder.id);
  return items.filter((item) => {
    if (item.folder) return false;
    return item.name.toLowerCase().endsWith(".pdf");
  });
}

/**
 * List trip sheet files in this scope's configured OneDrive folder.
 * Filters for CSV/Excel files only.
 */
export async function listOneDriveTripSheetFiles(
  tenantId: string
): Promise<OneDriveItem[]> {
  const account = await getAccount(tenantId);

  if (!account?.folderItemId) return [];

  const items = await listFolderById(tenantId, account.folderItemId);
  const extensions = [".csv", ".xlsx", ".xls"];

  return items.filter((item) => {
    if (item.folder) return false;
    const ext = item.name.toLowerCase().slice(item.name.lastIndexOf("."));
    return extensions.includes(ext);
  });
}

/**
 * List invoice files in this scope's configured OneDrive invoice folder.
 * Filters for PDF files only.
 */
export async function listOneDriveInvoiceFiles(
  tenantId: string
): Promise<OneDriveItem[]> {
  const account = await getAccount(tenantId);

  if (!account?.invoiceFolderItemId) return [];

  const items = await listFolderById(tenantId, account.invoiceFolderItemId);

  return items.filter((item) => {
    if (item.folder) return false;
    return item.name.toLowerCase().endsWith(".pdf");
  });
}

// ─── Direct file addressing ───────────────────────────────────────────────
//
// Graph can address a file by its path relative to a folder item, so locating
// one file costs ONE request. The listing-based approach it replaces cost a
// full paginated enumeration of the folder — and for a signed invoice, two:
// one to find the `signed` subfolder, another to list it. A single driver
// signing could therefore trigger several complete folder listings, which was
// the dominant source of latency and of Graph throttling.

/**
 * Reject anything that could escape the configured folder.
 *
 * The filename reaches us from a URL path parameter, so it is caller-supplied.
 * Graph path addressing interprets "/" as a separator and ".." as a parent,
 * which would otherwise let a request walk out of the invoice folder and read
 * anywhere in that admin's drive. The local filesystem path has an equivalent
 * guard in lib/invoices.ts; this is the OneDrive half of the same rule.
 */
function assertSafeItemName(name: string): string {
  const trimmed = name.trim();

  // Checked numerically rather than with a regex: a control-character class
  // written literally is easy to corrupt in a source file, and this reads
  // more plainly anyway.
  const hasControlChar = Array.from(trimmed).some((ch) => {
    const code = ch.charCodeAt(0);
    return code < 32 || code === 127;
  });

  if (
    !trimmed ||
    hasControlChar ||
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    trimmed === "." ||
    trimmed === ".."
  ) {
    throw new Error("Invalid filename - path traversal detected");
  }

  return trimmed;
}

/** Encode a path for Graph's `items/{id}:/{path}` addressing. */
function encodeRelativePath(segments: string[]): string {
  return segments.map((s) => encodeURIComponent(s)).join("/");
}

/**
 * Resolve one item inside a folder by name, in a single request.
 * Returns null when the file simply is not there.
 */
async function getItemInFolderByName(
  tenantId: string,
  folderItemId: string,
  segments: string[]
): Promise<OneDriveItem | null> {
  const path = encodeRelativePath(segments);
  return graphGetOrNull<OneDriveItem>(
    tenantId,
    `/me/drive/items/${folderItemId}:/${path}`
  );
}

/**
 * Find an original invoice by filename. One Graph request, no listing.
 */
export async function getInvoiceItemByName(
  tenantId: string,
  filename: string
): Promise<OneDriveItem | null> {
  const safe = assertSafeItemName(filename);
  const account = await getAccount(tenantId);
  if (!account?.invoiceFolderItemId) return null;

  return getItemInFolderByName(tenantId, account.invoiceFolderItemId, [safe]);
}

/**
 * Find a countersigned invoice by filename, inside the `signed` subfolder.
 * One Graph request — this replaces two full folder listings.
 */
export async function getSignedInvoiceItemByName(
  tenantId: string,
  filename: string
): Promise<OneDriveItem | null> {
  const safe = assertSafeItemName(filename);
  const account = await getAccount(tenantId);
  if (!account?.invoiceFolderItemId) return null;

  return getItemInFolderByName(tenantId, account.invoiceFolderItemId, [
    SIGNED_SUBFOLDER,
    safe,
  ]);
}

/**
 * Download an original invoice by filename in a single request.
 * Returns null if it does not exist.
 */
export async function downloadInvoiceByName(
  tenantId: string,
  filename: string
): Promise<Buffer | null> {
  const safe = assertSafeItemName(filename);
  const account = await getAccount(tenantId);
  if (!account?.invoiceFolderItemId) return null;

  return graphGetBufferOrNull(
    tenantId,
    `/me/drive/items/${account.invoiceFolderItemId}:/${encodeRelativePath([safe])}:/content`
  );
}

/**
 * Download a countersigned invoice by filename in a single request.
 */
export async function downloadSignedInvoiceByName(
  tenantId: string,
  filename: string
): Promise<Buffer | null> {
  const safe = assertSafeItemName(filename);
  const account = await getAccount(tenantId);
  if (!account?.invoiceFolderItemId) return null;

  return graphGetBufferOrNull(
    tenantId,
    `/me/drive/items/${account.invoiceFolderItemId}:/${encodeRelativePath([
      SIGNED_SUBFOLDER,
      safe,
    ])}:/content`
  );
}

/**
 * Find a pending collection document by filename. One Graph request, no listing.
 */
export async function getCollectionItemByName(
  tenantId: string,
  filename: string
): Promise<OneDriveItem | null> {
  const safe = assertSafeItemName(filename);
  const account = await getAccount(tenantId);
  if (!account?.collectionsFolderItemId) return null;

  return getItemInFolderByName(tenantId, account.collectionsFolderItemId, [
    COLLECTIONS_PENDING_SUBFOLDER,
    safe,
  ]);
}

/**
 * Find a signed collection document by filename, inside Signed/.
 */
export async function getSignedCollectionItemByName(
  tenantId: string,
  filename: string
): Promise<OneDriveItem | null> {
  const safe = assertSafeItemName(filename);
  const account = await getAccount(tenantId);
  if (!account?.collectionsFolderItemId) return null;

  return getItemInFolderByName(tenantId, account.collectionsFolderItemId, [
    COLLECTIONS_SIGNED_SUBFOLDER,
    safe,
  ]);
}

/**
 * Download a pending collection document by filename, in one request.
 */
export async function downloadCollectionByName(
  tenantId: string,
  filename: string
): Promise<Buffer | null> {
  const safe = assertSafeItemName(filename);
  const account = await getAccount(tenantId);
  if (!account?.collectionsFolderItemId) return null;

  return graphGetBufferOrNull(
    tenantId,
    `/me/drive/items/${account.collectionsFolderItemId}:/${encodeRelativePath([
      COLLECTIONS_PENDING_SUBFOLDER,
      safe,
    ])}:/content`
  );
}

/**
 * Download a signed collection document by filename, in one request.
 */
export async function downloadSignedCollectionByName(
  tenantId: string,
  filename: string
): Promise<Buffer | null> {
  const safe = assertSafeItemName(filename);
  const account = await getAccount(tenantId);
  if (!account?.collectionsFolderItemId) return null;

  return graphGetBufferOrNull(
    tenantId,
    `/me/drive/items/${account.collectionsFolderItemId}:/${encodeRelativePath([
      COLLECTIONS_SIGNED_SUBFOLDER,
      safe,
    ])}:/content`
  );
}

/**
 * Check if this scope's OneDrive collections folder is configured.
 */
export async function getOneDriveCollectionsSource(tenantId: string): Promise<{
  connected: boolean;
  folderPath?: string;
  folderItemId?: string;
} | null> {
  try {
    const status = await getCloudAccountStatus(tenantId);
    if (status?.connected && status.collectionsFolderItemId) {
      return {
        connected: true,
        folderPath: status.collectionsFolderPath ?? undefined,
        folderItemId: status.collectionsFolderItemId,
      };
    }
  } catch {
    // not configured
  }
  return null;
}

/**
 * Upload a signed collection document into Collections/Signed.
 *
 * Returns the created item so the caller can record its id — the archive view
 * resolves a signed collection by id first and falls back to the path.
 */
export async function uploadSignedCollectionToOneDrive(
  tenantId: string,
  filename: string,
  buffer: Buffer
): Promise<OneDriveItem> {
  const account = await getAccount(tenantId);

  if (!account?.collectionsFolderItemId) {
    throw new Error("OneDrive collections folder not configured");
  }

  const signedFolderId = await ensureSubfolder(
    tenantId,
    account.collectionsFolderItemId,
    COLLECTIONS_SIGNED_SUBFOLDER
  );

  return uploadFileToFolder(
    tenantId,
    signedFolderId,
    assertSafeItemName(filename),
    buffer,
    "application/pdf"
  );
}

/**
 * Check if this scope's OneDrive invoice folder is configured.
 */
export async function getOneDriveInvoiceSource(tenantId: string): Promise<{
  connected: boolean;
  folderPath?: string;
  folderItemId?: string;
} | null> {
  try {
    const status = await getCloudAccountStatus(tenantId);
    if (status?.connected && status.invoiceFolderItemId) {
      return {
        connected: true,
        folderPath: status.invoiceFolderPath ?? undefined,
        folderItemId: status.invoiceFolderItemId,
      };
    }
  } catch {
    // not configured
  }
  return null;
}

/**
 * Verify an item ID lives inside one of this scope's configured folders.
 *
 * Defence in depth: with per-scope tokens a foreign item ID already fails at
 * Graph, but this also stops a caller using their own valid token to reach
 * outside the folders they configured in Signex.
 */
export async function assertItemInConfiguredFolder(
  tenantId: string,
  itemId: string
): Promise<void> {
  const account = await getAccount(tenantId);
  if (!account) throw new Error("No OneDrive connection for this account");

  const allowedParents = [
    account.folderItemId,
    account.invoiceFolderItemId,
    account.collectionsFolderItemId,
  ].filter((id): id is string => !!id);
  if (allowedParents.length === 0) {
    throw new Error("No OneDrive folder configured for this account");
  }

  const item = await graphGet(tenantId, `/me/drive/items/${itemId}?$select=id,parentReference,name`);
  const parentId: string | undefined = item?.parentReference?.id;

  if (!parentId || !allowedParents.includes(parentId)) {
    // Same message and shape as a missing item — no existence signal.
    throw new Error(`Graph API error (404): item not found`);
  }
}

/**
 * Upload a file to a specific OneDrive folder by folder item ID.
 * Uses the simple upload endpoint (< 4MB files).
 */
export async function uploadFileToFolder(
  tenantId: string,
  folderItemId: string,
  filename: string,
  buffer: Buffer,
  contentType: string = "application/pdf"
): Promise<OneDriveItem> {
  const token = await requireToken(tenantId);

  const encodedName = encodeURIComponent(filename);
  const url = `${GRAPH_API_URL}/me/drive/items/${folderItemId}:/${encodedName}:/content`;

  const res = await graphFetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": contentType,
    },
    body: new Uint8Array(buffer),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Graph API upload error (${res.status}): ${err}`);
  }

  return res.json();
}

/**
 * Ensure a subfolder exists inside a parent folder. Creates if missing.
 * Returns the subfolder item ID.
 */
export async function ensureSubfolder(
  tenantId: string,
  parentItemId: string,
  folderName: string
): Promise<string> {
  const token = await requireToken(tenantId);

  const children = await listFolderById(tenantId, parentItemId);
  const existing = children.find(
    (item) => item.folder && item.name.toLowerCase() === folderName.toLowerCase()
  );
  if (existing) return existing.id;

  const url = `${GRAPH_API_URL}/me/drive/items/${parentItemId}/children`;
  const res = await graphFetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: folderName,
      folder: {},
      "@microsoft.graph.conflictBehavior": "fail",
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    if (res.status === 409) {
      const retryChildren = await listFolderById(tenantId, parentItemId);
      const retryExisting = retryChildren.find(
        (item) => item.folder && item.name.toLowerCase() === folderName.toLowerCase()
      );
      if (retryExisting) return retryExisting.id;
    }
    throw new Error(`Graph API create folder error (${res.status}): ${err}`);
  }

  const created = await res.json();
  return created.id;
}

/**
 * Upload a signed invoice to this scope's invoice folder "signed" subfolder.
 */
export async function uploadSignedInvoiceToOneDrive(
  tenantId: string,
  filename: string,
  buffer: Buffer
): Promise<void> {
  const account = await getAccount(tenantId);

  if (!account?.invoiceFolderItemId) {
    throw new Error("OneDrive invoice folder not configured");
  }

  const token = await requireToken(tenantId);

  // Ensure "signed" subfolder exists inside the invoice folder (by ID)
  const signedFolderId = await ensureSubfolder(
    tenantId,
    account.invoiceFolderItemId,
    "signed"
  );

  // Upload into the signed subfolder using ID-based colon syntax
  const encodedName = encodeURIComponent(filename);
  const url = `${GRAPH_API_URL}/me/drive/items/${signedFolderId}:/${encodedName}:/content`;

  const res = await graphFetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/pdf",
    },
    body: new Uint8Array(buffer),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Graph API upload error (${res.status}): ${err}`);
  }
}

/**
 * Move a file to a subfolder within the same parent folder.
 * Creates the subfolder if it doesn't exist.
 * Used to move completed trip sheets to processed/.
 */
export async function moveFileToSubfolder(
  tenantId: string,
  fileItemId: string,
  parentFolderItemId: string,
  subfolderName: string,
  filename?: string
): Promise<void> {
  const token = await requireToken(tenantId);

  const subfolderId = await ensureSubfolder(tenantId, parentFolderItemId, subfolderName);

  const url = `${GRAPH_API_URL}/me/drive/items/${fileItemId}`;
  const move = (body: Record<string, unknown>) =>
    graphFetch(url, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

  let res = await move({ parentReference: { id: subfolderId } });

  // On a name conflict in the destination, retry with a timestamped name.
  if (res.status === 409 && filename) {
    const dot = filename.lastIndexOf(".");
    const base = dot > 0 ? filename.slice(0, dot) : filename;
    const ext = dot > 0 ? filename.slice(dot) : "";
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    res = await move({
      parentReference: { id: subfolderId },
      name: `${base}_${stamp}${ext}`,
    });
  }

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Graph API move error (${res.status}): ${err}`);
  }
}

/**
 * Delete a file from OneDrive by its item ID.
 */
export async function deleteFileById(
  tenantId: string,
  itemId: string
): Promise<void> {
  const token = await requireToken(tenantId);

  const url = `${GRAPH_API_URL}/me/drive/items/${itemId}`;
  const res = await graphFetch(url, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok && res.status !== 404) {
    const err = await res.text();
    throw new Error(`Graph API delete error (${res.status}): ${err}`);
  }
}

/**
 * List trip sheet files already moved to this scope's "processed" subfolder.
 * Used by the backup flow, which archives completed trip sheets from there.
 */
export async function listOneDriveProcessedTripSheets(
  tenantId: string
): Promise<OneDriveItem[]> {
  const account = await getAccount(tenantId);

  if (!account?.folderItemId) return [];

  const children = await listFolderById(tenantId, account.folderItemId);
  const processedFolder = children.find(
    (item) => item.folder && item.name.toLowerCase() === "processed"
  );
  if (!processedFolder) return [];

  const items = await listFolderById(tenantId, processedFolder.id);
  const extensions = [".csv", ".xlsx", ".xls"];
  return items.filter((item) => {
    if (item.folder) return false;
    const ext = item.name.toLowerCase().slice(item.name.lastIndexOf("."));
    return extensions.includes(ext);
  });
}

/**
 * List signed invoice files from this scope's OneDrive "signed" subfolder.
 */
export async function listOneDriveSignedInvoices(
  tenantId: string
): Promise<OneDriveItem[]> {
  const account = await getAccount(tenantId);

  if (!account?.invoiceFolderItemId) return [];

  const children = await listFolderById(tenantId, account.invoiceFolderItemId);
  const signedFolder = children.find(
    (item) => item.folder && item.name.toLowerCase() === "signed"
  );
  if (!signedFolder) return [];

  const items = await listFolderById(tenantId, signedFolder.id);
  return items.filter((item) => {
    if (item.folder) return false;
    return item.name.toLowerCase().endsWith(".pdf");
  });
}
