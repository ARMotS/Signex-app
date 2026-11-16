/**
 * One log line per storage request, so OneDrive and S3 can be compared from the
 * Vercel logs: `[storage] onedrive GET items/:id:/:path 200 312ms`.
 *
 * Only the SHAPE of the request is logged — ids and file names are replaced —
 * so a line carries no customer's invoice number and no drive's item id. No
 * imports, so it can be unit tested and used by any provider.
 */

export type StorageProviderName = "onedrive" | "s3";

export interface StorageTiming {
  provider: StorageProviderName;
  /** e.g. "GET items/:id/children", "PutObject". */
  op: string;
  /** HTTP status, or "error" when the request threw before answering. */
  status: number | "error";
  ms: number;
  /** Retries taken (Graph throttling, SDK retries). Omitted when none. */
  attempts?: number;
}

export function formatStorageTiming(t: StorageTiming): string {
  const retries = t.attempts && t.attempts > 1 ? ` (${t.attempts} attempts)` : "";
  return `[storage] ${t.provider} ${t.op} ${t.status} ${Math.round(t.ms)}ms${retries}`;
}

export function logStorageTiming(t: StorageTiming): void {
  // Unit tests drive these paths with stubbed fetches; their lines are noise.
  if (process.env.NODE_ENV === "test") return;
  console.info(formatStorageTiming(t));
}

/**
 * The shape of a Graph URL with every identifier taken out.
 *
 *   /v1.0/me/drive/items/01ABC:/IV-365.pdf:/content?@x=fail → items/:id:/:path:/content
 *   /v1.0/me/drive/root/children?$top=200&$skiptoken=…     → root/children
 *
 * Graph item ids are opaque strings; anything after `:/` up to the next `:`
 * is a caller's path. Query strings are dropped (they hold paging tokens).
 */
export function graphOpShape(method: string, url: string): string {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    path = url.split("?")[0];
  }
  path = decodeURIComponentSafe(path)
    .replace(/^\/v1\.0/, "")
    .replace(/^\/me\/drive\//, "");

  const shaped = path
    // The caller's path after an item or the root: "items/{id}:/{path}" up to
    // the next ":" — once, so the action after it (":/content") is kept.
    .replace(/^((?:items\/[^/:]+)|root):\/[^:]*/, "$1:/:path")
    // items/{id}
    .replace(/items\/[^/:]+/g, "items/:id");

  return `${method.toUpperCase()} ${shaped}`;
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
