/**
 * Microsoft Graph API client for OneDrive integration.
 * Handles OAuth token management (refresh) and file operations.
 */

import { prisma } from "./db";

const MICROSOFT_AUTH_URL = "https://login.microsoftonline.com/common/oauth2/v2.0";
const GRAPH_API_URL = "https://graph.microsoft.com/v1.0";

const SCOPES = ["Files.Read", "Files.ReadWrite", "Files.Read.All", "Files.ReadWrite.All", "User.Read", "offline_access"];

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

export function getAuthorizationUrl(state?: string): string {
  const params = new URLSearchParams({
    client_id: getClientId(),
    response_type: "code",
    redirect_uri: getRedirectUri(),
    response_mode: "query",
    scope: SCOPES.join(" "),
    ...(state && { state }),
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
 * Get a valid access token for the OneDrive cloud account.
 * Refreshes automatically if expired.
 */
export async function getValidAccessToken(): Promise<string | null> {
  const account = await prisma.cloudAccount.findUnique({
    where: { provider: "onedrive" },
  });

  if (!account) return null;

  // If token expires in less than 5 minutes, refresh it
  const fiveMinutes = 5 * 60 * 1000;
  if (account.tokenExpiry.getTime() - Date.now() < fiveMinutes) {
    try {
      const tokens = await refreshAccessToken(account.refreshToken);
      const newExpiry = new Date(Date.now() + tokens.expires_in * 1000);

      await prisma.cloudAccount.update({
        where: { provider: "onedrive" },
        data: {
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token || account.refreshToken,
          tokenExpiry: newExpiry,
        },
      });

      return tokens.access_token;
    } catch (err) {
      console.error("Failed to refresh OneDrive token:", err);
      return null;
    }
  }

  return account.accessToken;
}

/**
 * Save OAuth tokens after initial authorization.
 */
export async function saveCloudAccount(tokens: TokenResponse): Promise<void> {
  const expiry = new Date(Date.now() + tokens.expires_in * 1000);

  // Fetch user profile to store account info
  let accountEmail: string | undefined;
  let accountName: string | undefined;
  try {
    const profile = await graphGet("/me", tokens.access_token);
    accountEmail = profile.mail || profile.userPrincipalName;
    accountName = profile.displayName;
  } catch {
    // non-critical
  }

  await prisma.cloudAccount.upsert({
    where: { provider: "onedrive" },
    update: {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      tokenExpiry: expiry,
      accountEmail,
      accountName,
    },
    create: {
      provider: "onedrive",
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      tokenExpiry: expiry,
      accountEmail,
      accountName,
    },
  });
}

/**
 * Remove the stored OneDrive cloud account.
 */
export async function disconnectCloudAccount(): Promise<void> {
  await prisma.cloudAccount.deleteMany({ where: { provider: "onedrive" } });
}

/**
 * Get the current cloud account status (without exposing tokens).
 */
export async function getCloudAccountStatus() {
  const account = await prisma.cloudAccount.findUnique({
    where: { provider: "onedrive" },
  });

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

async function graphGet(endpoint: string, accessToken?: string): Promise<any> {
  const token = accessToken || (await getValidAccessToken());
  if (!token) throw new Error("No valid OneDrive access token");

  const url = endpoint.startsWith("http") ? endpoint : `${GRAPH_API_URL}${endpoint}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Graph API error (${res.status}): ${err}`);
  }

  return res.json();
}

async function graphGetBuffer(endpoint: string): Promise<Buffer> {
  const token = await getValidAccessToken();
  if (!token) throw new Error("No valid OneDrive access token");

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
 * List the root folders in OneDrive.
 */
export async function listRootFolders(): Promise<OneDriveItem[]> {
  const data = await graphGet("/me/drive/root/children");
  return data.value || [];
}

/**
 * List children of a specific folder by item ID.
 */
export async function listFolderById(itemId: string): Promise<OneDriveItem[]> {
  const data = await graphGet(`/me/drive/items/${itemId}/children`);
  return data.value || [];
}

/**
 * List children of a folder by path.
 * Path should be relative to root, e.g. "Documents/TripSheets"
 */
export async function listFolderByPath(folderPath: string): Promise<OneDriveItem[]> {
  const encodedPath = encodeURIComponent(folderPath).replace(/%2F/g, "/");
  const data = await graphGet(`/me/drive/root:/${encodedPath}:/children`);
  return data.value || [];
}

/**
 * Get folder metadata by path.
 */
export async function getFolderByPath(folderPath: string): Promise<OneDriveItem> {
  const encodedPath = encodeURIComponent(folderPath).replace(/%2F/g, "/");
  return graphGet(`/me/drive/root:/${encodedPath}`);
}

/**
 * Download a file by its item ID. Returns raw Buffer.
 */
export async function downloadFileById(itemId: string): Promise<Buffer> {
  return graphGetBuffer(`/me/drive/items/${itemId}/content`);
}

/**
 * Download a file by its path relative to OneDrive root.
 */
export async function downloadFileByPath(filePath: string): Promise<Buffer> {
  const encodedPath = encodeURIComponent(filePath).replace(/%2F/g, "/");
  return graphGetBuffer(`/me/drive/root:/${encodedPath}:/content`);
}

/**
 * Set the configured OneDrive folder for trip sheets.
 */
export async function setOneDriveFolder(folderPath: string, folderItemId: string): Promise<void> {
  await prisma.cloudAccount.update({
    where: { provider: "onedrive" },
    data: { folderPath, folderItemId },
  });
}

/**
 * Set the configured OneDrive folder for invoices.
 */
export async function setOneDriveInvoiceFolder(folderPath: string, folderItemId: string): Promise<void> {
  await prisma.cloudAccount.update({
    where: { provider: "onedrive" },
    data: { invoiceFolderPath: folderPath, invoiceFolderItemId: folderItemId },
  });
}

/**
 * List trip sheet files in the configured OneDrive folder.
 * Filters for CSV/Excel files only.
 */
export async function listOneDriveTripSheetFiles(): Promise<OneDriveItem[]> {
  const account = await prisma.cloudAccount.findUnique({
    where: { provider: "onedrive" },
  });

  if (!account?.folderItemId) return [];

  const items = await listFolderById(account.folderItemId);
  const extensions = [".csv", ".xlsx", ".xls"];

  return items.filter((item) => {
    if (item.folder) return false;
    const ext = item.name.toLowerCase().slice(item.name.lastIndexOf("."));
    return extensions.includes(ext);
  });
}

/**
 * List invoice files in the configured OneDrive invoice folder.
 * Filters for PDF files only.
 */
export async function listOneDriveInvoiceFiles(): Promise<OneDriveItem[]> {
  const account = await prisma.cloudAccount.findUnique({
    where: { provider: "onedrive" },
  });

  if (!account?.invoiceFolderItemId) return [];

  const items = await listFolderById(account.invoiceFolderItemId);

  return items.filter((item) => {
    if (item.folder) return false;
    return item.name.toLowerCase().endsWith(".pdf");
  });
}

/**
 * Check if the OneDrive invoice folder is configured.
 */
export async function getOneDriveInvoiceSource(): Promise<{
  connected: boolean;
  folderPath?: string;
  folderItemId?: string;
} | null> {
  try {
    const status = await getCloudAccountStatus();
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
 * Upload a file to a specific OneDrive folder by folder item ID.
 * Uses the simple upload endpoint (< 4MB files).
 */
export async function uploadFileToFolder(
  folderItemId: string,
  filename: string,
  buffer: Buffer,
  contentType: string = "application/pdf"
): Promise<OneDriveItem> {
  const token = await getValidAccessToken();
  if (!token) throw new Error("No valid OneDrive access token");

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
  parentItemId: string,
  folderName: string
): Promise<string> {
  const token = await getValidAccessToken();
  if (!token) throw new Error("No valid OneDrive access token");

  const children = await listFolderById(parentItemId);
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
      const retryChildren = await listFolderById(parentItemId);
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
 * Upload a signed invoice to the OneDrive invoice folder's "signed" subfolder.
 */
export async function uploadSignedInvoiceToOneDrive(
  filename: string,
  buffer: Buffer
): Promise<void> {
  const account = await prisma.cloudAccount.findUnique({
    where: { provider: "onedrive" },
  });

  if (!account?.invoiceFolderItemId) {
    throw new Error("OneDrive invoice folder not configured");
  }

  const token = await getValidAccessToken();
  if (!token) throw new Error("No valid OneDrive access token");

  // Ensure "signed" subfolder exists inside the invoice folder (by ID)
  const signedFolderId = await ensureSubfolder(account.invoiceFolderItemId, "signed");

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
  fileItemId: string,
  parentFolderItemId: string,
  subfolderName: string
): Promise<void> {
  const token = await getValidAccessToken();
  if (!token) throw new Error("No valid OneDrive access token");

  const subfolderId = await ensureSubfolder(parentFolderItemId, subfolderName);

  const url = `${GRAPH_API_URL}/me/drive/items/${fileItemId}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      parentReference: { id: subfolderId },
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Graph API move error (${res.status}): ${err}`);
  }
}

/**
 * Delete a file from OneDrive by its item ID.
 */
export async function deleteFileById(itemId: string): Promise<void> {
  const token = await getValidAccessToken();
  if (!token) throw new Error("No valid OneDrive access token");

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
 * List signed invoice files from the OneDrive "signed" subfolder.
 */
export async function listOneDriveSignedInvoices(): Promise<OneDriveItem[]> {
  const account = await prisma.cloudAccount.findUnique({
    where: { provider: "onedrive" },
  });

  if (!account?.invoiceFolderItemId) return [];

  const children = await listFolderById(account.invoiceFolderItemId);
  const signedFolder = children.find(
    (item) => item.folder && item.name.toLowerCase() === "signed"
  );
  if (!signedFolder) return [];

  const items = await listFolderById(signedFolder.id);
  return items.filter((item) => {
    if (item.folder) return false;
    return item.name.toLowerCase().endsWith(".pdf");
  });
}
