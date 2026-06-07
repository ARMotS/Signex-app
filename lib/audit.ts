/**
 * Audit logging — tracks all operations for compliance and debugging.
 * High-throughput, fire-and-forget pattern (errors logged but not thrown).
 */

import { prisma } from "./db";
import type { AuditAction } from "@prisma/client";

export type { AuditAction } from "@prisma/client";

interface AuditEntry {
  action: AuditAction;
  entity: string;
  entityId?: string;
  userName?: string;
  details?: string;
}

/**
 * Log an audit event. Fire-and-forget — never throws.
 */
export async function logAudit(entry: AuditEntry): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        action: entry.action,
        entity: entry.entity,
        entityId: entry.entityId,
        userName: entry.userName,
        details: entry.details,
      },
    });
  } catch (err) {
    // Never throw from audit logging — it's supplementary
    console.error("[Audit] Failed to log:", err);
  }
}

/**
 * Query audit logs with filtering and pagination.
 */
export async function queryAuditLogs(filters?: {
  action?: AuditAction;
  entity?: string;
  entityId?: string;
  from?: Date;
  to?: Date;
  limit?: number;
  offset?: number;
}): Promise<{
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
    prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: filters?.limit ?? 50,
      skip: filters?.offset ?? 0,
    }),
    prisma.auditLog.count({ where }),
  ]);

  return { logs, total };
}
