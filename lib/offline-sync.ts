/**
 * Offline sync system — queues operations in IndexedDB when offline,
 * replays them when connectivity is restored.
 *
 * Used by the driver-side app for signing invoices while offline.
 * This runs entirely in the browser (client-side only).
 */

const DB_NAME = "signex-offline";
const DB_VERSION = 1;
const STORE_NAME = "sync-queue";

export interface SyncOperation {
  id: string;
  type: "sign" | "status_update";
  url: string;
  method: "PUT" | "POST";
  body: Record<string, unknown>;
  createdAt: number;
  retryCount: number;
}

// ─── IndexedDB Helpers ────────────────────────────────────────────────────

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "id" });
        store.createIndex("createdAt", "createdAt", { unique: false });
        store.createIndex("type", "type", { unique: false });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// ─── Queue Operations ─────────────────────────────────────────────────────

/**
 * Add an operation to the offline sync queue.
 */
export async function queueOperation(
  op: Omit<SyncOperation, "id" | "createdAt" | "retryCount">
): Promise<string> {
  const db = await openDB();
  const id = crypto.randomUUID();

  const operation: SyncOperation = {
    ...op,
    id,
    createdAt: Date.now(),
    retryCount: 0,
  };

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).add(operation);
    tx.oncomplete = () => {
      db.close();
      resolve(id);
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

/**
 * Get all pending operations in the queue.
 */
export async function getPendingOperations(): Promise<SyncOperation[]> {
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const request = tx.objectStore(STORE_NAME).index("createdAt").getAll();

    request.onsuccess = () => {
      db.close();
      resolve(request.result);
    };
    request.onerror = () => {
      db.close();
      reject(request.error);
    };
  });
}

/**
 * Remove a successfully synced operation from the queue.
 */
export async function removeOperation(id: string): Promise<void> {
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

/**
 * Increment retry count for a failed operation.
 */
export async function incrementRetry(id: string): Promise<void> {
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const getReq = store.get(id);

    getReq.onsuccess = () => {
      const op = getReq.result;
      if (op) {
        op.retryCount++;
        store.put(op);
      }
    };

    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

/**
 * Get the count of pending operations.
 */
export async function getPendingCount(): Promise<number> {
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const request = tx.objectStore(STORE_NAME).count();

    request.onsuccess = () => {
      db.close();
      resolve(request.result);
    };
    request.onerror = () => {
      db.close();
      reject(request.error);
    };
  });
}

// ─── Sync Engine ──────────────────────────────────────────────────────────

const MAX_RETRIES = 5;

/**
 * Attempt to replay all queued operations.
 * Called when the app comes back online.
 * Returns the number of successfully synced operations.
 */
export async function syncPendingOperations(): Promise<{
  synced: number;
  failed: number;
  remaining: number;
}> {
  const operations = await getPendingOperations();
  let synced = 0;
  let failed = 0;

  for (const op of operations) {
    if (op.retryCount >= MAX_RETRIES) {
      // Too many retries — leave in queue for manual review
      failed++;
      continue;
    }

    try {
      const response = await fetch(op.url, {
        method: op.method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(op.body),
      });

      if (response.ok) {
        await removeOperation(op.id);
        synced++;
      } else {
        await incrementRetry(op.id);
        failed++;
      }
    } catch {
      // Still offline or network error
      await incrementRetry(op.id);
      failed++;
    }
  }

  const remaining = await getPendingCount();
  return { synced, failed, remaining };
}

// ─── Online/Offline Listeners ─────────────────────────────────────────────

let syncInProgress = false;

/**
 * Initialize the offline sync system.
 * Sets up online/offline event listeners.
 * Call this once in the app's root layout or a provider.
 */
export function initOfflineSync(): () => void {
  const handleOnline = async () => {
    if (syncInProgress) return;
    syncInProgress = true;

    try {
      const count = await getPendingCount();
      if (count > 0) {
        console.log(`[OfflineSync] Back online — syncing ${count} pending operations...`);
        const result = await syncPendingOperations();
        console.log(`[OfflineSync] Sync complete:`, result);

        // Dispatch custom event for UI to react
        window.dispatchEvent(
          new CustomEvent("signex:sync-complete", { detail: result })
        );
      }
    } catch (err) {
      console.error("[OfflineSync] Sync failed:", err);
    } finally {
      syncInProgress = false;
    }
  };

  const handleOffline = () => {
    console.log("[OfflineSync] Went offline — operations will be queued");
    window.dispatchEvent(new CustomEvent("signex:offline"));
  };

  window.addEventListener("online", handleOnline);
  window.addEventListener("offline", handleOffline);

  // Run initial sync in case we came online while app was loading
  if (navigator.onLine) {
    handleOnline();
  }

  // Cleanup function
  return () => {
    window.removeEventListener("online", handleOnline);
    window.removeEventListener("offline", handleOffline);
  };
}

// ─── Smart Fetch (auto-queue when offline) ────────────────────────────────

/**
 * A fetch wrapper that automatically queues write operations when offline.
 * For read operations (GET), falls back to cache.
 * For write operations (PUT/POST), queues to IndexedDB.
 */
export async function offlineFetch(
  url: string,
  options: {
    method: "GET" | "PUT" | "POST" | "DELETE";
    body?: Record<string, unknown>;
    syncType?: "sign" | "status_update";
  }
): Promise<{ ok: boolean; data?: unknown; queued?: boolean }> {
  const { method, body, syncType } = options;

  // Try the network first
  if (navigator.onLine) {
    try {
      const response = await fetch(url, {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });

      const data = await response.json();
      return { ok: response.ok, data };
    } catch {
      // Network error — fall through to offline handling
    }
  }

  // Offline handling
  if (method === "GET") {
    // GET requests rely on service worker cache
    return { ok: false, data: { error: "Offline — cached data may be stale" } };
  }

  // Queue write operations for later sync
  if (syncType && body && (method === "PUT" || method === "POST")) {
    const id = await queueOperation({
      type: syncType,
      url,
      method,
      body,
    });

    return {
      ok: true,
      queued: true,
      data: { message: "Operation queued for sync", queueId: id },
    };
  }

  return { ok: false, data: { error: "Offline — cannot perform this operation" } };
}
