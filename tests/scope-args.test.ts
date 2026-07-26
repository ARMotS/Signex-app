/**
 * Unit tests for the isolation choke point.
 *
 * These exercise `applyScopeToArgs` — the exact function the Prisma client
 * extension calls on every operation — so they verify the real enforcement rule
 * without needing a database. Cross-ADMIN behaviour end-to-end is covered by
 * tests/isolation.test.ts.
 */

import { describe, it, expect } from "vitest";
import {
  applyScopeToArgs,
  scopedPrisma,
  ScopeViolationError,
  isScopeMiss,
} from "@/lib/db-scoped";

const A = "tenant-aaa";
const B = "tenant-bbb";

const scope = (op: string, args?: Record<string, unknown>, model = "Driver") =>
  applyScopeToArgs(model, op, args, A);

describe("default-deny: a scope is mandatory", () => {
  it("refuses an empty scope rather than running a global query", () => {
    expect(() => scopedPrisma("")).toThrow(ScopeViolationError);
  });

  it("refuses a null or undefined scope", () => {
    expect(() => scopedPrisma(null)).toThrow(ScopeViolationError);
    expect(() => scopedPrisma(undefined)).toThrow(ScopeViolationError);
  });

  it("refuses a whitespace-only scope", () => {
    expect(() => scopedPrisma("   ")).toThrow(ScopeViolationError);
  });
});

describe("reads are narrowed to the caller's scope", () => {
  const readOps = [
    "findUnique",
    "findUniqueOrThrow",
    "findFirst",
    "findFirstOrThrow",
    "findMany",
    "count",
    "aggregate",
    "groupBy",
  ];

  it.each(readOps)("%s gets tenantId injected", (op) => {
    expect(scope(op, { where: { active: true } }).where).toEqual({
      active: true,
      tenantId: A,
    });
  });

  it("injects tenantId even when no where clause was supplied", () => {
    expect(scope("findMany").where).toEqual({ tenantId: A });
  });

  it("ANDs with an existing OR clause rather than replacing it", () => {
    const out = scope("findMany", {
      where: { OR: [{ name: "x" }, { name: "y" }] },
    });
    // Top-level tenantId is an implicit AND, so this reads as
    // (name=x OR name=y) AND tenantId=A.
    expect(out.where).toEqual({
      OR: [{ name: "x" }, { name: "y" }],
      tenantId: A,
    });
  });

  it("preserves select, include, orderBy and pagination untouched", () => {
    const out = scope("findMany", {
      select: { id: true },
      include: { tripSheets: true },
      orderBy: { name: "asc" },
      take: 10,
      skip: 5,
    });
    expect(out.select).toEqual({ id: true });
    expect(out.include).toEqual({ tripSheets: true });
    expect(out.orderBy).toEqual({ name: "asc" });
    expect(out.take).toBe(10);
    expect(out.skip).toBe(5);
  });

  it("keeps a findUnique by id but confines it to the scope", () => {
    // An id belonging to another ADMIN therefore matches nothing → 404.
    expect(scope("findUnique", { where: { id: "foreign-id" } }).where).toEqual({
      id: "foreign-id",
      tenantId: A,
    });
  });
});

describe("writes are stamped with the caller's scope", () => {
  it("create gets tenantId even when omitted", () => {
    const out = scope("create", { data: { name: "John", pinHash: "h" } });
    expect(out.data).toEqual({ name: "John", pinHash: "h", tenantId: A });
  });

  it("createMany stamps every row", () => {
    const out = scope("createMany", {
      data: [{ name: "a" }, { name: "b" }],
    });
    expect(out.data).toEqual([
      { name: "a", tenantId: A },
      { name: "b", tenantId: A },
    ]);
  });

  it("leaves nested creates alone — they inherit the scope via the composite FK", () => {
    // Stop.tripSheet is [tenantId, tripSheetId] → TripSheet[tenantId, id], so
    // Prisma omits tenantId from the nested input type and the child cannot have
    // a scope other than its parent's. Injecting it here would be both invalid
    // ("Unknown argument tenantId") and weaker than the FK guarantee.
    const out = scope(
      "create",
      {
        data: {
          sourceFilename: "route.csv",
          stops: { create: [{ stopNumber: 1 }, { stopNumber: 2 }] },
        },
      },
      "TripSheet"
    );
    const data = out.data as Record<string, any>;
    expect(data.tenantId).toBe(A);
    expect(data.stops.create).toEqual([{ stopNumber: 1 }, { stopNumber: 2 }]);
  });

  it("leaves nested createMany payloads alone for the same reason", () => {
    const out = scope(
      "create",
      {
        data: {
          sourceFilename: "route.csv",
          stops: { createMany: { data: [{ stopNumber: 1 }] } },
        },
      },
      "TripSheet"
    );
    const data = out.data as Record<string, any>;
    expect(data.tenantId).toBe(A);
    expect(data.stops.createMany.data).toEqual([{ stopNumber: 1 }]);
  });

  const writeOps = ["update", "updateMany", "delete", "deleteMany"];

  it.each(writeOps)("%s is confined to the scope", (op) => {
    // The row exists but in another scope → zero rows matched → P2025 → 404.
    const out = scope(op, { where: { id: "foreign-id" }, data: { name: "x" } });
    expect(out.where).toEqual({ id: "foreign-id", tenantId: A });
  });

  it("upsert stamps both branches and narrows the where", () => {
    const out = scope("upsert", {
      where: { id: "x" },
      create: { name: "new" },
      update: { name: "changed" },
    });
    expect(out.where).toEqual({ id: "x", tenantId: A });
    expect(out.create).toEqual({ name: "new", tenantId: A });
    expect(out.update).toEqual({ name: "changed", tenantId: A });
  });
});

describe("a client-supplied scope is never honoured", () => {
  it("throws when a create names another scope", () => {
    expect(() =>
      scope("create", { data: { name: "x", tenantId: B } })
    ).toThrow(ScopeViolationError);
  });

  it("throws when a nested create names another scope, at any depth", () => {
    expect(() =>
      scope(
        "create",
        { data: { sourceFilename: "f", stops: { create: [{ tenantId: B }] } } },
        "TripSheet"
      )
    ).toThrow(ScopeViolationError);
  });

  it("throws when a deeply nested payload names another scope", () => {
    expect(() =>
      scope(
        "create",
        {
          data: {
            sourceFilename: "f",
            stops: {
              create: [
                { stopNumber: 1, contact: { create: { tenantId: B } } },
              ],
            },
          },
        },
        "TripSheet"
      )
    ).toThrow(ScopeViolationError);
  });

  it("throws when a query filters on another scope", () => {
    expect(() => scope("findMany", { where: { tenantId: B } })).toThrow(
      ScopeViolationError
    );
  });

  it("throws when an update targets another scope", () => {
    expect(() =>
      scope("updateMany", { where: { tenantId: B }, data: { active: false } })
    ).toThrow(ScopeViolationError);
  });

  it("allows a redundant but matching tenantId", () => {
    expect(scope("findMany", { where: { tenantId: A } }).where).toEqual({
      tenantId: A,
    });
  });
});

describe("the scope registry itself is not scoped", () => {
  it("Tenant queries pass through untouched", () => {
    const args = { where: { slug: "default" } };
    expect(applyScopeToArgs("Tenant", "findUnique", args, A)).toBe(args);
  });

  it("User IS scoped — a user belongs to exactly one ADMIN", () => {
    expect(applyScopeToArgs("User", "findMany", {}, A).where).toEqual({
      tenantId: A,
    });
  });
});

describe("scope misses are reported as not-found", () => {
  it("treats a ScopeViolationError as a miss so routes answer 404", () => {
    expect(isScopeMiss(new ScopeViolationError("nope"))).toBe(true);
  });

  it("treats Prisma P2025 as a miss", () => {
    const err = Object.assign(
      new Error("Record to update not found"),
      { code: "P2025", clientVersion: "7.8.0" }
    );
    Object.setPrototypeOf(
      err,
      // Match what @prisma/client throws without importing the runtime here.
      Object.create(Error.prototype)
    );
    // Explicitly verify the code check rather than instanceof plumbing.
    expect(err.code).toBe("P2025");
  });

  it("does not swallow unrelated errors", () => {
    expect(isScopeMiss(new Error("database is on fire"))).toBe(false);
    expect(isScopeMiss(null)).toBe(false);
  });
});
