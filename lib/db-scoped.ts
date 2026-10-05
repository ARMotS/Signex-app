/**
 * The isolation choke point.
 *
 * `scopedPrisma(tenantId)` returns a Prisma client that automatically injects
 * `tenantId` into the `where` clause of every read and the `data` payload of
 * every write — including nested writes. Route handlers never filter by tenant
 * themselves; forgetting to do so is no longer possible, because the unfiltered
 * client is not what they hold.
 *
 * Default-deny: a scope is REQUIRED. `scopedPrisma("")` throws rather than
 * quietly running a global query.
 *
 * Prisma 7 removed `$use` middleware, so this is built on a Client Extension
 * (`$extends({ query: { $allModels: { $allOperations } } })`).
 *
 * ── Known boundaries ──────────────────────────────────────────────────────
 * • `$queryRaw` / `$executeRaw` bypass extensions entirely. Do not use them for
 *   scoped data. (Nothing in this codebase currently does.)
 * • Nested *reads* through relations are not rewritten — they don't need to be.
 *   Composite foreign keys ([tenantId, id] targets in schema.prisma) make a
 *   cross-scope relation row physically unrepresentable, so traversing a
 *   relation can never leave the scope.
 */

import { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "./db";

/**
 * The raw, unfiltered client.
 *
 * Named to be uncomfortable to type. Every use must sit under a
 * `// SCOPE-EXEMPT: <reason>` comment. The complete legitimate set is:
 *   - login by username           (pre-session; LoginName is globally unique)
 *   - username availability       (existence only; usernames span every scope)
 *   - email collision checks      (Admin/User email is globally unique)
 *   - session token validation    (pre-authorization)
 *   - logout / session teardown
 *   - Tenant + User registry ops  (SUPER_ADMIN-gated; these models ARE the scope registry)
 *   - migration + seed scripts
 */
export const UNSAFE_unscopedPrisma: PrismaClient = prisma;

/**
 * Models that are the scope registry itself rather than data inside a scope.
 * They carry no tenantId to inject (Tenant), or are managed exclusively by
 * SUPER_ADMIN-gated routes that filter explicitly (User).
 */
const UNSCOPED_MODELS = new Set<string>(["Tenant"]);

/** Operations whose `args.where` must be narrowed to the scope. */
const WHERE_OPS = new Set<string>([
  "findUnique",
  "findUniqueOrThrow",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "count",
  "aggregate",
  "groupBy",
  "update",
  "updateMany",
  "updateManyAndReturn",
  "delete",
  "deleteMany",
  "upsert",
]);

/** Operations whose `args.data` must be stamped with the scope. */
const DATA_OPS = new Set<string>([
  "create",
  "createMany",
  "createManyAndReturn",
  "update",
  "updateMany",
  "updateManyAndReturn",
  "upsert",
]);

/**
 * Thrown when a caller tries to read or write outside its own scope.
 * Surfaces as a 404 (never 403) — see lib/api-handler.ts.
 */
export class ScopeViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScopeViolationError";
  }
}

function assertNoForeignScope(
  value: unknown,
  tenantId: string,
  where: string
): void {
  if (value === undefined || value === null) return;
  if (value !== tenantId) {
    throw new ScopeViolationError(
      `Refusing to ${where} with tenantId "${String(value)}" from a session scoped to "${tenantId}"`
    );
  }
}

/**
 * Walk an entire write payload and throw if ANY level names a different scope.
 * Injection alone isn't enough — a caller must never be able to smuggle a scope
 * in through a nested payload either.
 */
function assertNoForeignScopeDeep(value: unknown, tenantId: string): void {
  if (Array.isArray(value)) {
    for (const item of value) assertNoForeignScopeDeep(item, tenantId);
    return;
  }
  if (value === null || typeof value !== "object") return;

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "tenantId") {
      assertNoForeignScope(child, tenantId, "write");
      continue;
    }
    assertNoForeignScopeDeep(child, tenantId);
  }
}

/**
 * Stamp `tenantId` onto the TOP LEVEL of a write payload.
 *
 * Nested rows are deliberately NOT stamped. Every parent→child relation in this
 * schema uses a composite foreign key whose first column is tenantId
 * (e.g. Stop.tripSheet is [tenantId, tripSheetId] → TripSheet[tenantId, id]), so
 * Prisma omits tenantId from nested-create inputs entirely and the child
 * *structurally inherits* the parent's scope. That is a stronger guarantee than
 * copying the value down would be: a nested row cannot be given a different
 * scope, rather than merely not being given one.
 *
 * For any relation whose FK does not carry tenantId, the nested row would fall
 * back to the `@default("")` — which the foreign key to Tenant then rejects. So
 * that path fails closed rather than creating an unscoped row.
 */
function stampData(data: unknown, tenantId: string): unknown {
  assertNoForeignScopeDeep(data, tenantId);

  if (Array.isArray(data)) {
    return data.map((item) =>
      item !== null && typeof item === "object"
        ? { ...(item as object), tenantId }
        : item
    );
  }
  if (data === null || typeof data !== "object") {
    return data;
  }

  return { ...(data as object), tenantId };
}

/**
 * The whole isolation rule, as a pure function.
 *
 * Exported so it can be tested exhaustively without a database — see
 * tests/scope-args.test.ts. The client extension below is a thin wrapper around
 * this, so the tests exercise the real enforcement path rather than a copy.
 *
 * @throws ScopeViolationError if the caller passed a tenantId for another scope.
 */
export function applyScopeToArgs(
  model: string | undefined,
  operation: string,
  args: Record<string, unknown> | undefined,
  tenantId: string
): Record<string, unknown> {
  const input = args ?? {};

  if (model && UNSCOPED_MODELS.has(model)) {
    return input;
  }

  const next: Record<string, unknown> = { ...input };

  if (WHERE_OPS.has(operation)) {
    const where = (next.where ?? {}) as Record<string, unknown>;
    assertNoForeignScope(where.tenantId, tenantId, "query");
    next.where = { ...where, tenantId };
  }

  if (DATA_OPS.has(operation)) {
    if (operation === "upsert") {
      if (next.create !== undefined) {
        next.create = stampData(next.create, tenantId);
      }
      if (next.update !== undefined) {
        next.update = stampData(next.update, tenantId);
      }
    } else if (next.data !== undefined) {
      next.data = stampData(next.data, tenantId);
    }
  }

  return next;
}

function buildScopedClient(tenantId: string) {
  return prisma.$extends({
    name: `tenant-scope:${tenantId}`,
    query: {
      $allModels: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        async $allOperations({ model, operation, args, query }: any) {
          return query(applyScopeToArgs(model, operation, args, tenantId));
        },
      },
    },
  });
}

export type ScopedPrismaClient = ReturnType<typeof buildScopedClient>;

/**
 * Extended clients are immutable and cheap to reuse, so cache one per scope
 * rather than rebuilding on every request.
 */
const clientCache = new Map<string, ScopedPrismaClient>();

/**
 * Get a Prisma client hard-locked to one tenant.
 *
 * @param tenantId Resolved server-side from the signed session cookie. NEVER
 *                 pass a value that originated in a request body, query string,
 *                 header or path parameter.
 */
export function scopedPrisma(tenantId: string | null | undefined): ScopedPrismaClient {
  if (!tenantId || typeof tenantId !== "string" || tenantId.trim() === "") {
    throw new ScopeViolationError(
      "scopedPrisma() requires a tenant scope — refusing to run an unscoped query"
    );
  }

  const cached = clientCache.get(tenantId);
  if (cached) return cached;

  const client = buildScopedClient(tenantId);
  clientCache.set(tenantId, client);
  return client;
}

/**
 * True when a thrown error means "the row exists but not in your scope" (or
 * doesn't exist at all — deliberately indistinguishable). Both must surface as
 * 404 so the caller cannot probe for the existence of other scopes' rows.
 */
export function isScopeMiss(err: unknown): boolean {
  if (err instanceof ScopeViolationError) return true;
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    // P2025 = "An operation failed because it depends on one or more records
    // that were required but not found" — what a scoped update/delete by a
    // foreign id produces.
    return err.code === "P2025";
  }
  return false;
}
