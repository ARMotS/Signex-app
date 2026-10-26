/**
 * Audit logging — tracks all operations for compliance and debugging.
 * High-throughput, fire-and-forget pattern (errors logged but not thrown).
 *
 * Entries are scoped. `tenantId` is required for anything that happens inside a
 * session; it is nullable only so pre-session events (a failed login, an admin
 * account being created before its scope exists) can still be recorded.
 *
 * Every entry records who did it and from where — the session, IP, user agent
 * and signex-device cookie of the request it was logged in — without the
 * caller passing any of it. The table is append-only (a trigger refuses
 * UPDATE and DELETE); there is deliberately no way to edit an entry.
 */

import type { AuditAction, Prisma, UserRole } from "@prisma/client";
import { UNSAFE_unscopedPrisma, scopedPrisma } from "./db-scoped";
import { currentRequestInfo } from "./request-info";

export type { AuditAction } from "@prisma/client";

/** Who did it. Null is the system, or someone not signed in. */
export type AuditActor = { id: string; role: UserRole } | null;

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
  /** Structured detail. Never a password, a token, or anything priced. */
  metadata?: Record<string, unknown>;
  /**
   * Defaults to the signed-in session making this request. Pass it when there
   * is no session yet (a sign-in names the account signing in) or the session
   * is not the actor; pass null for "nobody signed in".
   */
  actor?: AuditActor;
  /** Defaults to the request's signex-device cookie (a sign-in sets it). */
  deviceId?: string | null;
}

const ACTOR_ROLE: Record<string, UserRole> = {
  admin: "ADMIN",
  driver: "DRIVER",
  super_admin: "SUPER_ADMIN",
  company_admin: "COMPANY_ADMIN",
};

/**
 * The request this entry is logged in: IP, user agent, device cookie and the
 * session. Empty outside a request (cron, scripts) — never an error.
 *
 * lib/session is imported lazily: it requires SESSION_SECRET at import, and a
 * script that logs must still write its entry without one.
 */
async function requestContext(): Promise<{
  ip: string | null;
  userAgent: string | null;
  deviceId: string | null;
  actor: AuditActor;
  actorName: string | null;
}> {
  const info = await currentRequestInfo();
  try {
    const { peekSession, peekDeviceId } = await import("./session");
    const [session, deviceId] = await Promise.all([peekSession(), peekDeviceId()]);
    const role = session ? ACTOR_ROLE[session.role] : undefined;
    return {
      ...info,
      deviceId,
      actor: session && role ? { id: session.id, role } : null,
      actorName: session?.name ?? null,
    };
  } catch {
    return { ...info, deviceId: null, actor: null, actorName: null };
  }
}

/**
 * Log an audit event. Fire-and-forget — never throws.
 */
export async function logAudit(entry: AuditEntry): Promise<void> {
  try {
    const ctx = await requestContext();
    const actor = entry.actor !== undefined ? entry.actor : ctx.actor;
    const fromSession = entry.actor === undefined && actor !== null;

    // SCOPE-EXEMPT: AuditLog.tenantId is nullable so pre-session events (failed
    // logins) can be recorded. The value is taken from the caller's resolved
    // scope, never from a request, and is written explicitly here.
    await UNSAFE_unscopedPrisma.auditLog.create({
      data: {
        action: entry.action,
        entity: entry.entity,
        entityId: entry.entityId,
        userName: entry.userName ?? (fromSession ? ctx.actorName : null),
        details: entry.details,
        tenantId: entry.tenantId ?? null,
        actorId: actor?.id ?? null,
        actorRole: actor?.role ?? null,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        deviceId: entry.deviceId !== undefined ? entry.deviceId : ctx.deviceId,
        ...(entry.metadata && { metadata: entry.metadata as Prisma.InputJsonValue }),
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
      // The display fields only: these lists reach the browser, and who signed
      // in from which IP or device is for the usage pages, not a record's history.
      select: {
        id: true,
        action: true,
        entity: true,
        entityId: true,
        userName: true,
        details: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
      take: filters?.limit ?? 50,
      skip: filters?.offset ?? 0,
    }),
    db.auditLog.count({ where }),
  ]);

  return { logs, total };
}
