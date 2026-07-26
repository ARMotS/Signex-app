/**
 * Audit logging — tracks all operations for compliance and debugging.
 * High-throughput, fire-and-forget pattern (errors logged but not thrown).
 *
 * Entries are scoped. `tenantId` is required for anything that happens inside a
 * session; it is nullable only so pre-session events (a failed login, an admin
 * account being created before its scope exists) can still be recorded.
 */

import { UNSAFE_unscopedPrisma, scopedPrisma } from "./db-scoped";
import type { AuditAction } from "@prisma/client";

export type { AuditAction } from "@prisma/client";

interface AuditEntry {
  action: AuditAction;
  entity: string;
  entityId?: string;
  userName?: string;
  details?: string;
  /**
   * The scope this event belongs to. Omit ONLY for pre-session events that have
   * no scope yet (login attempts, bootstrap admin creation).
   */
  tenantId?: string | null;
}

/**
 * Log an audit event. Fire-and-forget — never throws.
 */
export async function logAudit(entry: AuditEntry): Promise<void> {
  try {
    // SCOPE-EXEMPT: AuditLog.tenantId is nullable so pre-session events (failed
    // logins) can be recorded. The value is taken from the caller's resolved
    // scope, never from a request, and is written explicitly here.
    await UNSAFE_unscopedPrisma.auditLog.create({
      data: {
        action: entry.action,
        entity: entry.entity,
        entityId: entry.entityId,
        userName: entry.userName,
        details: entry.details,
        tenantId: entry.tenantId ?? null,
      },
    });
  } catch (err) {
    // Never throw from audit logging — it's supplementary
    console.error("[Audit] Failed to log:", err);
  }
}

/**
 * Query audit logs for one scope, with filtering and pagination.
 */
export async function queryAuditLogs(
  tenantId: string,
  filters?: {
    action?: AuditAction;
    entity?: string;
    entityId?: string;
    from?: Date;
    to?: Date;
    limit?: number;
    offset?: number;
  }
): Promise<{
  logs: {
    id: string;
    action: AuditAction;
    entity: string;
    entityId: string | null;
    userName: string | null;
    details: string | null;
    createdAt: Date;
  }[];
  total: number;
}> {
  const db = scopedPrisma(tenantId);

  const where = {
    ...(filters?.action && { action: filters.action }),
    ...(filters?.entity && { entity: filters.entity }),
    ...(filters?.entityId && { entityId: filters.entityId }),
    ...((filters?.from || filters?.to) && {
      createdAt: {
        ...(filters?.from && { gte: filters.from }),
        ...(filters?.to && { lte: filters.to }),
      },
    }),
  };

  const [logs, total] = await Promise.all([
    db.auditLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: filters?.limit ?? 50,
      skip: filters?.offset ?? 0,
    }),
    db.auditLog.count({ where }),
  ]);

  return { logs, total };
}
