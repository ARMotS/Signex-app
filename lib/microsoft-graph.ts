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

const MICROSOFT_AUTH_URL = "https://login.microsoftonline.com/common/oauth2/v2.0";
const GRAPH_API_URL = "https://graph.microsoft.com/v1.0";

const SCOPES = ["Files.Read", "Files.ReadWrite", "Files.Read.All", "Files.ReadWrite.All", "User.Read", "offline_access"];

const PROVIDER = "onedrive";

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
export async function getValidAccessToken(tenantId: string): Promise<string | null> {
  const account = await getAccount(tenantId);
  if (!account) return null;

  // If token expires in less than 5 minutes, refresh it
  const fiveMinutes = 5 * 60 * 1000;
  if (account.tokenExpiry.getTime() - Date.now() < fiveMinutes) {
    try {
      const currentRefresh = decryptToken(account.refreshToken);
      const tokens = await refreshAccessToken(currentRefresh);
      const newExpiry = new Date(Date.now() + tokens.expires_in * 1000);

      // Scoped update — writes back to this scope's row only.
      await scopedPrisma(tenantId).cloudAccount.updateMany({
        where: { provider: PROVIDER },
        data: {
          accessToken: encryptToken(tokens.access_token),
          refreshToken: encryptToken(tokens.refresh_token || currentRefresh),
          tokenExpiry: newExpiry,
        },
      });

      return tokens.access_token;
    } catch (err) {
      console.error(`Failed to refresh OneDrive token for scope ${tenantId}:`, err);
      return null;
    }
  }

  return decryptToken(account.accessToken);
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
  };
}

// ─── Graph API helpers ────────────────────────────────────────────────────

/** Graph GET with an explicit token — used during the OAuth exchange only. */
async function graphGetWithToken(endpoint: string, accessToken: string): Promise<any> {
  const url = endpoint.startsWith("http") ? endpoint : `${GRAPH_API_URL}${endpoint}`;
  const res = await fetch(url, {
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

async function graphGetBuffer(tenantId: string, endpoint: string): Promise<Buffer> {
  const token = await requireToken(tenantId);

  const url = endpoint.startsWith("http") ? endpoint : `${GRAPH_API_URL}${endpoint}`;
  const res = await fetch(url, {
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

  const allowedParents = [account.folderItemId, account.invoiceFolderItemId].filter(
    (id): id is string => !!id
  );
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

  const res = await fetch(url, {
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
  const res = await fetch(url, {
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

  const res = await fetch(url, {
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
    fetch(url, {
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
  const res = await fetch(url, {
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
