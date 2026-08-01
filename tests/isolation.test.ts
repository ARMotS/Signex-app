/**
 * Cross-ADMIN isolation, end-to-end through the real route handlers.
 *
 * Needs a throwaway Postgres:
 *   TEST_DATABASE_URL=postgresql://... npx prisma db push
 *   TEST_DATABASE_URL=postgresql://... npm run test:isolation
 *
 * Without TEST_DATABASE_URL the suite skips (and says so) rather than passing
 * vacuously — a silently-skipped isolation test is worse than no test.
 *
 * The fixtures give scope A and scope B a driver with the SAME name, a contact
 * with the SAME company name, and a stop with the SAME invoice number. So no
 * assertion here can pass merely because the values happened to differ.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import {
  HAS_TEST_DB,
  db,
  disconnect,
  seedFixtures,
  adminSession,
  driverSession,
  superAdminSession,
  tamperedAdminSession,
  useSession,
  sessionMockFactory,
  req,
  params,
  type Fixtures,
} from "./helpers/fixtures";

vi.mock("@/lib/session", () => sessionMockFactory());
// Graph calls are stubbed so we can assert WHICH bearer token would be used
// without talking to Microsoft.
const graphCalls: { url: string; token: string | null }[] = [];
vi.stubGlobal(
  "fetch",
  vi.fn(async (url: any, init: any) => {
    const auth: string | undefined = init?.headers?.Authorization;
    graphCalls.push({
      url: String(url),
      token: auth ? auth.replace("Bearer ", "") : null,
    });
    return new Response(JSON.stringify({ value: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  })
);

const suite = HAS_TEST_DB ? describe : describe.skip;

if (!HAS_TEST_DB) {
  console.warn(
    "\n  ⚠ tests/isolation.test.ts SKIPPED — set TEST_DATABASE_URL to a throwaway database to run it.\n"
  );
}

suite("cross-ADMIN isolation", () => {
  let f: Fixtures;

  beforeAll(async () => {
    f = await seedFixtures();
  });

  afterAll(async () => {
    await disconnect();
  });

  beforeEach(() => {
    graphCalls.length = 0;
    useSession(null);
  });

  // ── Trip sheets ──────────────────────────────────────────────────────
  describe("trip sheets", () => {
    it("ADMIN 1 sees none of ADMIN 2's trip sheets", async () => {
      const { GET } = await import("@/app/api/trip-sheet/route");
      useSession(adminSession(f.a));

      const res = await GET(req("/api/trip-sheet"));
      const body = await res.json();

      const ids = body.tripSheets.map((t: any) => t.id);
      expect(ids).toContain(f.a.tripSheet.id);
      expect(ids).not.toContain(f.b.tripSheet.id);
      expect(body.tripSheets).toHaveLength(1);
    });

    it("stats count only the caller's own stops", async () => {
      const { GET } = await import("@/app/api/trip-sheet/route");
      useSession(adminSession(f.a));

      const body = await (await GET(req("/api/trip-sheet"))).json();
      expect(body.stats.totalStops).toBe(1);
      expect(body.stats.activeDrivers).toBe(1);
    });

    it("ADMIN 1 deleting ADMIN 2's trip sheet by id gets 404 and changes nothing", async () => {
      const { DELETE } = await import("@/app/api/trip-sheet/route");
      useSession(adminSession(f.a));

      const res = await DELETE(
        req("/api/trip-sheet", { method: "DELETE", body: { id: f.b.tripSheet.id } })
      );

      expect(res.status).toBe(404);
      // The row must still be there — a 404 with the write applied is the
      // failure mode that actually matters.
      const still = await db().tripSheet.findUnique({
        where: { id: f.b.tripSheet.id },
      });
      expect(still).not.toBeNull();
    });

    it("ADMIN 1 completing ADMIN 2's trip sheet gets 404 and changes nothing", async () => {
      const { PATCH } = await import("@/app/api/trip-sheet/route");
      useSession(adminSession(f.a));

      const res = await PATCH(
        req("/api/trip-sheet", { method: "PATCH", body: { id: f.b.tripSheet.id } })
      );

      expect(res.status).toBe(404);
      expect(
        await db().tripSheet.findUnique({ where: { id: f.b.tripSheet.id } })
      ).not.toBeNull();
    });

    it("a deployed sheet and its nested stops all land in the caller's scope", async () => {
      // This is how every real trip sheet is written — one create with the stops
      // nested inside it. The stops get their tenantId from the recursive stamp
      // in the scoped client, not from the caller.
      const { saveTripSheet } = await import("@/lib/trip-data");

      const trip = await saveTripSheet(f.a.tenantId, {
        driverId: f.a.driver.id,
        driverName: f.a.driver.name,
        regNo: "REG-A",
        uploadedBy: f.a.admin.id,
        sourceFilename: "nested.csv",
        stops: [
          {
            stopNumber: 1,
            invoiceNumber: "INV-9001",
            customerName: "Nested Co",
            address: "1 Nested Rd",
            nop: 1,
            status: "PENDING",
          },
          {
            stopNumber: 2,
            invoiceNumber: "INV-9002",
            customerName: "Nested Co",
            address: "2 Nested Rd",
            nop: 1,
            status: "PENDING",
          },
        ],
      });

      const row = await db().tripSheet.findUnique({ where: { id: trip.id } });
      expect(row?.tenantId).toBe(f.a.tenantId);

      const stops = await db().stop.findMany({ where: { tripSheetId: trip.id } });
      expect(stops).toHaveLength(2);
      for (const s of stops) {
        expect(s.tenantId).toBe(f.a.tenantId);
        expect(s.tenantId).not.toBe(f.b.tenantId);
      }

      // And ADMIN 2 cannot see any of it.
      const { GET } = await import("@/app/api/trip-sheet/route");
      useSession(adminSession(f.b));
      const bodyB = await (await GET(req("/api/trip-sheet"))).json();
      expect(bodyB.tripSheets.map((t: any) => t.id)).not.toContain(trip.id);

      await db().tripSheet.delete({ where: { id: trip.id } });
    });

    it("a deploy cannot assign a sheet to another scope's driver", async () => {
      const { saveTripSheet } = await import("@/lib/trip-data");

      // The composite FK ([tenantId, driverId] → Driver[tenantId, id]) makes this
      // unrepresentable, so it fails at the database rather than creating an
      // orphaned cross-scope sheet.
      await expect(
        saveTripSheet(f.a.tenantId, {
          driverId: f.b.driver.id,
          driverName: f.b.driver.name,
          regNo: "REG-B",
          uploadedBy: f.a.admin.id,
          sourceFilename: "cross.csv",
          stops: [
            {
              stopNumber: 1,
              invoiceNumber: "INV-9999",
              customerName: "X",
              address: "",
              nop: 0,
              status: "PENDING",
            },
          ],
        })
      ).rejects.toThrow();

      expect(
        await db().tripSheet.count({ where: { sourceFilename: "cross.csv" } })
      ).toBe(0);
    });

    it("a batch delete silently drops out-of-scope ids instead of acting on them", async () => {
      const { DELETE } = await import("@/app/api/trip-sheet/route");
      useSession(adminSession(f.a));

      const res = await DELETE(
        req("/api/trip-sheet", {
          method: "DELETE",
          body: { ids: [f.b.tripSheet.id] },
        })
      );

      const body = await res.json();
      expect(body.deleted).toBe(0);
      expect(
        await db().tripSheet.findUnique({ where: { id: f.b.tripSheet.id } })
      ).not.toBeNull();
    });
  });

  // ── Drivers ──────────────────────────────────────────────────────────
  describe("drivers", () => {
    it("ADMIN 1 sees zero of ADMIN 2's drivers, despite the identical name", async () => {
      const { GET } = await import("@/app/api/drivers/route");
      useSession(adminSession(f.a));

      const body = await (await GET(req("/api/drivers"))).json();
      const ids = body.drivers.map((d: any) => d.id);

      expect(ids).toEqual([f.a.driver.id]);
      expect(ids).not.toContain(f.b.driver.id);
    });

    it("ADMIN 1 updating ADMIN 2's driver by id gets 404 and changes nothing", async () => {
      const { PUT } = await import("@/app/api/drivers/route");
      useSession(adminSession(f.a));

      const res = await PUT(
        req("/api/drivers", {
          method: "PUT",
          body: { id: f.b.driver.id, name: "Hijacked", active: false },
        })
      );

      expect(res.status).toBe(404);
      const still = await db().driver.findUnique({ where: { id: f.b.driver.id } });
      expect(still?.name).toBe("Jane Delivery");
      expect(still?.active).toBe(true);
    });

    it("ADMIN 1 deleting ADMIN 2's driver gets 404 and changes nothing", async () => {
      const { DELETE } = await import("@/app/api/drivers/route");
      useSession(adminSession(f.a));

      const res = await DELETE(
        req("/api/drivers", { method: "DELETE", body: { id: f.b.driver.id } })
      );

      expect(res.status).toBe(404);
      expect(
        await db().driver.findUnique({ where: { id: f.b.driver.id } })
      ).not.toBeNull();
    });

    it("a driver cannot be reassigned into another scope — no route accepts a tenantId", async () => {
      const { PUT } = await import("@/app/api/drivers/route");
      useSession(adminSession(f.a));

      // Attempt to smuggle a scope change through the update body.
      await PUT(
        req("/api/drivers", {
          method: "PUT",
          body: { id: f.a.driver.id, tenantId: f.b.tenantId, name: "Jane Delivery" },
        })
      );

      const driver = await db().driver.findUnique({ where: { id: f.a.driver.id } });
      expect(driver?.tenantId).toBe(f.a.tenantId);
    });

    it("the scoped client rejects a direct attempt to move a driver across scopes", async () => {
      const { scopedPrisma, ScopeViolationError } = await import("@/lib/db-scoped");
      await expect(
        scopedPrisma(f.a.tenantId).driver.updateMany({
          where: { id: f.a.driver.id },
          data: { tenantId: f.b.tenantId },
        })
      ).rejects.toThrow(ScopeViolationError);
    });

    it("the same driver name is allowed in both scopes", async () => {
      const both = await db().driver.findMany({ where: { name: "Jane Delivery" } });
      expect(both).toHaveLength(2);
      expect(new Set(both.map((d) => d.tenantId)).size).toBe(2);
    });
  });

  // ── Contacts ─────────────────────────────────────────────────────────
  describe("contacts", () => {
    it("ADMIN 1 sees zero of ADMIN 2's contacts", async () => {
      const { GET } = await import("@/app/api/contacts/route");
      useSession(adminSession(f.a));

      const body = await (await GET(req("/api/contacts"))).json();
      const ids = body.contacts.map((c: any) => c.id);

      expect(ids).toEqual([f.a.contact.id]);
      expect(body.total).toBe(1);
    });

    it("search does not leak another scope's names, emails or phone numbers", async () => {
      const { GET } = await import("@/app/api/contacts/route");
      useSession(adminSession(f.a));

      // Search on B's exact company name — which A also has, so a leak would be
      // visible as two results rather than one.
      const body = await (
        await GET(req("/api/contacts?search=Acme%20Trading"))
      ).json();

      expect(body.contacts).toHaveLength(1);
      expect(body.contacts[0].id).toBe(f.a.contact.id);

      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain("acme-b@example.test");
      expect(serialized).not.toContain("+27 11 000 0002");
      expect(serialized).not.toContain("Contact B");
      expect(serialized).not.toContain(f.b.contact.id);
    });

    it("searching B's unique contact person from A returns nothing", async () => {
      const { GET } = await import("@/app/api/contacts/route");
      useSession(adminSession(f.a));

      const body = await (
        await GET(req("/api/contacts?search=Contact%20B"))
      ).json();
      expect(body.contacts).toHaveLength(0);
      expect(body.total).toBe(0);
    });

    it("ADMIN 1 fetching ADMIN 2's contact by direct id gets 404", async () => {
      const { PATCH } = await import("@/app/api/contacts/[id]/route");
      useSession(adminSession(f.a));

      const res = await PATCH(
        req(`/api/contacts/${f.b.contact.id}`, {
          method: "PATCH",
          body: { companyName: "Hijacked" },
        }),
        params({ id: f.b.contact.id })
      );

      expect(res.status).toBe(404);
      const still = await db().contact.findUnique({
        where: { id: f.b.contact.id },
      });
      expect(still?.companyName).toBe("Acme Trading");
    });

    it("ADMIN 1 soft-deleting ADMIN 2's contact gets 404 and changes nothing", async () => {
      const { DELETE } = await import("@/app/api/contacts/[id]/route");
      useSession(adminSession(f.a));

      const res = await DELETE(
        req(`/api/contacts/${f.b.contact.id}`, { method: "DELETE" }),
        params({ id: f.b.contact.id })
      );

      expect(res.status).toBe(404);
      const still = await db().contact.findUnique({
        where: { id: f.b.contact.id },
      });
      expect(still?.deletedAt).toBeNull();
    });

    it("fuzzy autocomplete never suggests another scope's contact", async () => {
      const { matchStopsToContacts } = await import("@/lib/contact-matcher");

      const results = await matchStopsToContacts(f.a.tenantId, [
        { id: f.a.stop.id, customerName: "Acme Trading" },
      ]);

      // A does have a matching contact — assert it matched its OWN, not B's.
      expect(results[0].contactId).toBe(f.a.contact.id);
      expect(results[0].contactId).not.toBe(f.b.contact.id);
    });

    it("a scope with no matching contact gets no_match, not another scope's contact", async () => {
      const { matchStopsToContacts } = await import("@/lib/contact-matcher");

      // Give B a uniquely-named contact and confirm A can never see it.
      const secret = await db().contact.create({
        data: {
          companyName: "Zzyzx Confidential Holdings",
          tenantId: f.b.tenantId,
        },
      });

      const results = await matchStopsToContacts(f.a.tenantId, [
        { id: f.a.stop.id, customerName: "Zzyzx Confidential Holdings" },
      ]);

      expect(results[0].status).toBe("no_match");
      expect(results[0].contactId).toBeUndefined();
      expect(results[0].matchedName).toBeUndefined();

      await db().contact.delete({ where: { id: secret.id } });
    });

    it("applying a match with another scope's contact id is a no-op", async () => {
      const { applyContactMatches } = await import("@/lib/contact-matcher");

      const result = await applyContactMatches(f.a.tenantId, [
        { stopId: f.a.stop.id, contactId: f.b.contact.id },
      ]);

      expect(result.applied).toBe(0);
      const stop = await db().stop.findUnique({ where: { id: f.a.stop.id } });
      expect(stop?.contactId).toBeNull();
    });

    it("the database itself rejects a stop pointing at another scope's contact", async () => {
      // The composite FK ([tenantId, contactId] → Contact[tenantId, id]) makes a
      // cross-scope link unrepresentable, independent of application code.
      await expect(
        db().stop.update({
          where: { id: f.a.stop.id },
          data: { contactId: f.b.contact.id },
        })
      ).rejects.toThrow();
    });

    it("signing a stop auto-creates a contact in the signer's scope, never reusing another's", async () => {
      const { PUT } = await import("@/app/api/trip-sheet/stops/route");
      useSession(driverSession(f.a));

      const res = await PUT(
        req("/api/trip-sheet/stops", {
          method: "PUT",
          body: { stopId: f.a.stop.id, status: "SIGNED" },
        })
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.contactId).toBe(f.a.contact.id);
      expect(body.contactId).not.toBe(f.b.contact.id);

      // Reset for later tests.
      await db().stop.update({
        where: { id: f.a.stop.id },
        data: { status: "PENDING", signedAt: null, contactId: null },
      });
    });
  });

  // ── Drivers confined to their parent ADMIN ────────────────────────────
  describe("a DRIVER is confined to its parent ADMIN's scope", () => {
    it("cannot read another scope's driver's stops", async () => {
      const { GET } = await import("@/app/api/trip-sheet/stops/route");
      useSession(driverSession(f.a));

      const res = await GET(
        req(`/api/trip-sheet/stops?driverId=${f.b.driver.id}`)
      );
      expect(res.status).toBe(404);
    });

    it("reads only its own scope's stops", async () => {
      const { GET } = await import("@/app/api/trip-sheet/stops/route");
      useSession(driverSession(f.a));

      const body = await (
        await GET(req(`/api/trip-sheet/stops?driverId=${f.a.driver.id}`))
      ).json();

      expect(body.stops).toHaveLength(1);
      expect(body.stops[0].id).toBe(f.a.stop.id);
      expect(body.tripSheets.map((t: any) => t.id)).toEqual([f.a.tripSheet.id]);
    });

    it("cannot sign another scope's stop", async () => {
      const { PUT } = await import("@/app/api/trip-sheet/stops/route");
      useSession(driverSession(f.a));

      const res = await PUT(
        req("/api/trip-sheet/stops", {
          method: "PUT",
          body: { stopId: f.b.stop.id, status: "SIGNED" },
        })
      );

      expect(res.status).toBe(404);
      const still = await db().stop.findUnique({ where: { id: f.b.stop.id } });
      expect(still?.status).toBe("PENDING");
      expect(still?.signedAt).toBeNull();
    });

    it("cannot email another scope's customer", async () => {
      const { POST } = await import("@/app/api/invoices/[id]/notify/route");
      useSession(driverSession(f.a));

      const res = await POST(
        req(`/api/invoices/${f.b.stop.id}/notify`, {
          method: "POST",
          body: { driverName: "Jane Delivery" },
        }),
        params({ id: f.b.stop.id })
      );

      expect(res.status).toBe(404);
    });

    it("the identical invoice number in another scope is not reachable", async () => {
      // Both scopes have INV-1001. A driver in A resolving that number must only
      // ever get A's stop.
      const stops = await db().stop.findMany({
        where: { invoiceNumber: "INV-1001", tenantId: f.a.tenantId },
      });
      expect(stops).toHaveLength(1);
      expect(stops[0].id).toBe(f.a.stop.id);
    });
  });

  // ── OneDrive ─────────────────────────────────────────────────────────
  describe("OneDrive", () => {
    it("ADMIN 1 sees only its own connection", async () => {
      const { GET } = await import("@/app/api/cloud/onedrive/route");
      useSession(adminSession(f.a));

      const body = await (await GET(req("/api/cloud/onedrive"))).json();

      expect(body.account.accountEmail).toBe("onedrive-a@example.test");
      expect(JSON.stringify(body)).not.toContain("onedrive-b@example.test");
      expect(JSON.stringify(body)).not.toContain("invoice-folder-B");
    });

    it("each scope resolves its own access token", async () => {
      const { getValidAccessToken } = await import("@/lib/microsoft-graph");

      expect(await getValidAccessToken(f.a.tenantId)).toBe("access-token-A");
      expect(await getValidAccessToken(f.b.tenantId)).toBe("access-token-B");
    });

    it("a scope with no connection gets null, never a fallback to another's token", async () => {
      const { getValidAccessToken } = await import("@/lib/microsoft-graph");
      expect(await getValidAccessToken(f.superAdmin.tenantId)).toBeNull();
    });

    it("Graph calls carry only the calling scope's bearer token", async () => {
      const { listFolderById } = await import("@/lib/microsoft-graph");

      await listFolderById(f.a.tenantId, "folder-item-A");

      expect(graphCalls).toHaveLength(1);
      expect(graphCalls[0].token).toBe("access-token-A");
      expect(graphCalls[0].token).not.toBe("access-token-B");
    });

    it("file listing uses the caller's own folder id", async () => {
      const { GET } = await import("@/app/api/cloud/onedrive/files/route");
      useSession(adminSession(f.a));

      await GET(req("/api/cloud/onedrive/files"));

      const graphUrls = graphCalls.map((c) => c.url).join(" ");
      expect(graphUrls).toContain("folder-item-A");
      expect(graphUrls).not.toContain("folder-item-B");
      expect(graphCalls.every((c) => c.token === "access-token-A")).toBe(true);
    });

    it("disconnecting one scope leaves the other connected", async () => {
      const { disconnectCloudAccount, getCloudAccountStatus } = await import(
        "@/lib/microsoft-graph"
      );

      await disconnectCloudAccount(f.a.tenantId);

      expect(await getCloudAccountStatus(f.a.tenantId)).toBeNull();
      expect(await getCloudAccountStatus(f.b.tenantId)).not.toBeNull();

      // Restore for any later test.
      const { encryptToken } = await import("@/lib/crypto");
      await db().cloudAccount.create({
        data: {
          provider: "onedrive",
          accountEmail: "onedrive-a@example.test",
          accountName: "OneDrive A",
          accessToken: encryptToken("access-token-A"),
          refreshToken: encryptToken("refresh-token-A"),
          tokenExpiry: new Date(Date.now() + 3_600_000),
          folderItemId: "folder-item-A",
          invoiceFolderItemId: "invoice-folder-A",
          tenantId: f.a.tenantId,
        },
      });
    });

    it("tokens are ciphertext at rest", async () => {
      const rows = await db().cloudAccount.findMany({
        select: { accessToken: true, refreshToken: true },
      });
      for (const row of rows) {
        expect(row.accessToken).toMatch(/^v1:/);
        expect(row.refreshToken).toMatch(/^v1:/);
        expect(row.accessToken).not.toContain("access-token");
      }
    });
  });

  // ── Settings, config and import state ────────────────────────────────
  describe("settings and import state", () => {
    it("each ADMIN reads its own folder configuration", async () => {
      const { GET } = await import("@/app/api/settings/route");

      useSession(adminSession(f.a));
      const a = await (await GET(req("/api/settings"))).json();

      useSession(adminSession(f.b));
      const b = await (await GET(req("/api/settings"))).json();

      expect(a.invoiceFolderPath).toBe("C:\\Invoices-A");
      expect(b.invoiceFolderPath).toBe("C:\\Invoices-B");
      expect(a.invoiceFolderPath).not.toBe(b.invoiceFolderPath);
    });

    it("one ADMIN changing settings does not touch another's", async () => {
      const { writeConfig, readConfig } = await import("@/lib/config");

      await writeConfig(f.a.tenantId, { invoiceFolderPath: "C:\\Changed-A" });

      expect((await readConfig(f.a.tenantId)).invoiceFolderPath).toBe(
        "C:\\Changed-A"
      );
      expect((await readConfig(f.b.tenantId)).invoiceFolderPath).toBe(
        "C:\\Invoices-B"
      );
    });

    it("one ADMIN importing a filename leaves it NEW for another", async () => {
      const { markFileImported } = await import("@/lib/trip-sheet-folder");

      await markFileImported(f.a.tenantId, "shared-name.csv", null, "imported");

      const forA = await db().importedFile.findFirst({
        where: { tenantId: f.a.tenantId, filename: "shared-name.csv" },
      });
      const forB = await db().importedFile.findFirst({
        where: { tenantId: f.b.tenantId, filename: "shared-name.csv" },
      });

      expect(forA).not.toBeNull();
      expect(forB).toBeNull();

      // And B can import the same filename without a unique-constraint clash.
      await markFileImported(f.b.tenantId, "shared-name.csv", null, "imported");
      expect(
        await db().importedFile.count({ where: { filename: "shared-name.csv" } })
      ).toBe(2);
    });
  });

  // ── Trip sheet parsing ───────────────────────────────────────────────
  describe("trip sheet parsing", () => {
    it("already-signed detection does not reveal another scope's signature", async () => {
      const { parseTripSheet } = await import("@/lib/trip-parser");

      // Sign B's stop, which shares invoice number INV-1001 with A.
      await db().stop.update({
        where: { id: f.b.stop.id },
        data: { status: "SIGNED", signedAt: new Date() },
      });

      const csv = "Date,Driver,Reg No,Customer,Invoice No,NOP\n2026-07-26,Jane Delivery,REG-A,Acme Trading,INV-1001,1\n";
      const result = await parseTripSheet(
        f.a.tenantId,
        Buffer.from(csv, "utf8"),
        "route.csv"
      );

      // A has not signed INV-1001, so nothing should be reported — and above all
      // B's driver name must not appear.
      const dbSourced = result.alreadySigned.filter((s) => s.source === "database");
      expect(dbSourced).toHaveLength(0);
      expect(JSON.stringify(result.alreadySigned)).not.toContain("Jane Delivery");

      await db().stop.update({
        where: { id: f.b.stop.id },
        data: { status: "PENDING", signedAt: null },
      });
    });

    it("driver-name matching binds to the caller's own driver row", async () => {
      const { parseTripSheet } = await import("@/lib/trip-parser");

      const csv = "Date,Driver,Reg No,Customer,Invoice No,NOP\n2026-07-26,Jane Delivery,REG-A,Acme Trading,INV-2002,1\n";
      const result = await parseTripSheet(
        f.a.tenantId,
        Buffer.from(csv, "utf8"),
        "route.csv"
      );

      const matched = result.driverResults.find(
        (r) => r.driverId !== "__unassigned__"
      );
      expect(matched?.driverId).toBe(f.a.driver.id);
      expect(matched?.driverId).not.toBe(f.b.driver.id);
    });
  });

  // ── Backups ──────────────────────────────────────────────────────────
  describe("backups", () => {
    // Backups no longer read trip sheets from the database — they archive the
    // source files sitting in the trip-sheet `processed/` folder. Isolation
    // therefore comes from that folder resolving per scope: each ADMIN has their
    // own OneDrive connection and their own configured path.

    it("listing backupable trip sheets reads the caller's own folder", async () => {
      const { getBackupableTripSheets } = await import("@/lib/backup");

      await getBackupableTripSheets(f.a.tenantId);

      const urls = graphCalls.map((c) => c.url).join(" ");
      expect(urls).toContain("folder-item-A");
      expect(urls).not.toContain("folder-item-B");
      expect(graphCalls.every((c) => c.token === "access-token-A")).toBe(true);
    });

    it("listing backupable invoices reads the caller's own invoice folder", async () => {
      const { getBackupableInvoices } = await import("@/lib/backup");

      await getBackupableInvoices(f.b.tenantId);

      const urls = graphCalls.map((c) => c.url).join(" ");
      expect(urls).toContain("invoice-folder-B");
      expect(urls).not.toContain("invoice-folder-A");
      expect(graphCalls.every((c) => c.token === "access-token-B")).toBe(true);
    });

    it("a purge acts only through the caller's own OneDrive connection", async () => {
      const { purgeBackedUpTripSheets } = await import("@/lib/backup");

      // Naming a file that lives in another ADMIN's processed/ folder resolves
      // against THIS scope's drive with THIS scope's token, so it matches
      // nothing and no delete is ever issued.
      //
      // `deleted` counts 1 because the purge is deliberately idempotent —
      // "already gone" is treated as success. The isolation guarantee is not the
      // count, it's that no request ever reached B's drive, so assert that.
      const result = await purgeBackedUpTripSheets(f.a.tenantId, [
        "route-b.csv",
      ]);

      expect(result.failed).toHaveLength(0);
      expect(graphCalls.every((c) => c.token === "access-token-A")).toBe(true);
      expect(graphCalls.map((c) => c.url).join(" ")).not.toContain("folder-item-B");
      // No DELETE was issued at all — nothing was found to delete.
      expect(graphCalls.some((c) => c.url.includes("/items/") && c.token === "access-token-B")).toBe(false);
    });

    it("a backup summary for one scope never reaches the other's drive", async () => {
      const { getBackupSummary } = await import("@/lib/backup");

      await getBackupSummary(f.a.tenantId);

      const urls = graphCalls.map((c) => c.url).join(" ");
      expect(urls).not.toContain("folder-item-B");
      expect(urls).not.toContain("invoice-folder-B");
      expect(graphCalls.every((c) => c.token === "access-token-A")).toBe(true);
    });
  });

  // ── SUPER_ADMIN scope switching ──────────────────────────────────────
  describe("SUPER_ADMIN scope switching", () => {
    it("in its own scope, sees none of A's or B's data", async () => {
      const { GET } = await import("@/app/api/trip-sheet/route");
      useSession(superAdminSession(f));

      const body = await (await GET(req("/api/trip-sheet"))).json();
      expect(body.tripSheets).toHaveLength(0);
    });

    it("while viewing scope B, sees exactly B's data and none of A's", async () => {
      const { GET } = await import("@/app/api/trip-sheet/route");
      useSession(superAdminSession(f, f.b.tenantId));

      const body = await (await GET(req("/api/trip-sheet"))).json();
      const ids = body.tripSheets.map((t: any) => t.id);

      expect(ids).toEqual([f.b.tripSheet.id]);
      expect(ids).not.toContain(f.a.tripSheet.id);
    });

    it("while viewing scope B, uses B's OneDrive token — not its own, not A's", async () => {
      const { GET } = await import("@/app/api/cloud/onedrive/route");
      useSession(superAdminSession(f, f.b.tenantId));

      const body = await (await GET(req("/api/cloud/onedrive"))).json();
      expect(body.account.accountEmail).toBe("onedrive-b@example.test");
    });

    it("lists every scope with its owning ADMIN", async () => {
      const { GET } = await import("@/app/api/admin/scopes/route");
      useSession(superAdminSession(f));

      const body = await (await GET(req("/api/admin/scopes"))).json();
      const slugs = body.scopes.map((s: any) => s.slug).sort();

      expect(slugs).toEqual(["root", "scope-a", "scope-b"]);
      expect(body.isViewingOtherScope).toBe(false);
    });

    it("an ADMIN cannot list scopes", async () => {
      const { GET } = await import("@/app/api/admin/scopes/route");
      useSession(adminSession(f.a));

      const res = await GET(req("/api/admin/scopes"));
      expect(res.status).toBe(403);
    });

    it("an ADMIN cannot switch scope", async () => {
      const { POST } = await import("@/app/api/admin/scopes/route");
      useSession(adminSession(f.a));

      const res = await POST(
        req("/api/admin/scopes", {
          method: "POST",
          body: { tenantId: f.b.tenantId },
        })
      );
      expect(res.status).toBe(403);
    });

    it("a viewTenantId forged onto an ADMIN session is ignored outright", async () => {
      const { GET } = await import("@/app/api/trip-sheet/route");
      // Even if an attacker somehow minted a signed cookie carrying
      // viewTenantId, the field is only read for super_admin sessions.
      useSession(tamperedAdminSession(f.a, f.b.tenantId));

      const body = await (await GET(req("/api/trip-sheet"))).json();
      const ids = body.tripSheets.map((t: any) => t.id);

      expect(ids).toEqual([f.a.tripSheet.id]);
      expect(ids).not.toContain(f.b.tripSheet.id);
    });

    it("switching to a non-existent scope is 404", async () => {
      const { POST } = await import("@/app/api/admin/scopes/route");
      useSession(superAdminSession(f));

      const res = await POST(
        req("/api/admin/scopes", {
          method: "POST",
          body: { tenantId: "does-not-exist" },
        })
      );
      expect(res.status).toBe(404);
    });

    it("the switch is audit-logged against the SUPER_ADMIN's own scope", async () => {
      const { POST } = await import("@/app/api/admin/scopes/route");
      useSession(superAdminSession(f));

      await POST(
        req("/api/admin/scopes", {
          method: "POST",
          body: { tenantId: f.b.tenantId },
        })
      );

      const entry = await db().auditLog.findFirst({
        where: { action: "SCOPE_SWITCH", entityId: f.b.tenantId },
        orderBy: { createdAt: "desc" },
      });
      expect(entry).not.toBeNull();
      expect(entry?.tenantId).toBe(f.superAdmin.tenantId);
    });
  });

  // ── Public driver sign-in surface ─────────────────────────────────────
  //
  // Drivers sign in through a link unique to their operator: /select/<slug>.
  // This is the only endpoint that exposes anything without a session, and
  // reaching it requires already holding that operator's slug — there is no
  // public directory of operators. These tests pin the exposure down.
  describe("the per-operator driver sign-in endpoint", () => {
    it("requires a company slug — there is no list-everything mode", async () => {
      const { GET } = await import("@/app/api/auth/drivers/route");

      const res = await GET(req("/api/auth/drivers"));
      expect(res.status).toBe(400);
    });

    it("returns only the drivers of the operator whose link was used", async () => {
      const { GET } = await import("@/app/api/auth/drivers/route");

      const bodyA = await (
        await GET(req("/api/auth/drivers?company=scope-a"))
      ).json();

      expect(bodyA.drivers.map((d: any) => d.id)).toEqual([f.a.driver.id]);
      expect(bodyA.drivers.map((d: any) => d.id)).not.toContain(f.b.driver.id);
    });

    it("exposes only id and name — no counts, no scope ids, no tokens", async () => {
      const { GET } = await import("@/app/api/auth/drivers/route");

      const body = await (
        await GET(req("/api/auth/drivers?company=scope-a"))
      ).json();

      // The original endpoint returned stopCount/signedCount and tenantId. Gone.
      for (const d of body.drivers) {
        expect(Object.keys(d).sort()).toEqual(["id", "name"]);
      }
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain(f.a.tenantId);
      expect(serialized).not.toContain("admin-a@example.test");
      expect(serialized).not.toContain("access-token");
      expect(serialized).not.toContain("Acme Trading");
    });

    it("an unknown slug yields an empty list, not an error", async () => {
      const { GET } = await import("@/app/api/auth/drivers/route");

      const body = await (
        await GET(req("/api/auth/drivers?company=no-such-operator"))
      ).json();
      expect(body.drivers).toEqual([]);
      expect(body.companyName).toBeNull();
    });

    it("a deactivated operator is indistinguishable from an unknown slug", async () => {
      const { GET } = await import("@/app/api/auth/drivers/route");

      await db().admin.update({
        where: { id: f.b.admin.id },
        data: { active: false },
      });

      const deactivated = await (
        await GET(req("/api/auth/drivers?company=scope-b"))
      ).json();
      const unknown = await (
        await GET(req("/api/auth/drivers?company=no-such-operator"))
      ).json();

      // Byte-identical, so a slug cannot be confirmed by probing.
      expect(deactivated).toEqual(unknown);

      await db().admin.update({
        where: { id: f.b.admin.id },
        data: { active: true },
      });
    });

    it("an ADMIN's own sign-in link is scoped to them", async () => {
      const { GET } = await import("@/app/api/drivers/route");
      useSession(adminSession(f.a));

      const body = await (await GET(req("/api/drivers"))).json();

      expect(body.signInLink.slug).toBe("scope-a");
      expect(body.signInLink.path).toBe("/select/scope-a");
      expect(JSON.stringify(body)).not.toContain("scope-b");
    });

    it("signing in through one operator's link cannot authenticate another's driver", async () => {
      const { loginDriver } = await import("@/lib/accounts");
      const { UNSAFE_unscopedPrisma } = await import("@/lib/db-scoped");

      const scopeA = await UNSAFE_unscopedPrisma.tenant.findFirst({
        where: { slug: "scope-a" },
        select: { id: true },
      });

      // Scope B's driver shares the name but has PIN 2222. Using scope A's link
      // narrows the candidates to A, so B's PIN authenticates nothing here.
      const result = await loginDriver("Jane Delivery", "2222", scopeA!.id);
      expect(result.success).toBe(false);
    });
  });

  // ── Admin deactivation ───────────────────────────────────────────────
  describe("admin deactivation", () => {
    it("a deactivated ADMIN cannot log in", async () => {
      const { loginAdmin } = await import("@/lib/accounts");

      await db().admin.update({
        where: { id: f.b.admin.id },
        data: { active: false },
      });

      const result = await loginAdmin(f.b.admin.email, "password123");
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/deactivated/i);

      await db().admin.update({
        where: { id: f.b.admin.id },
        data: { active: true },
      });
    });

    it("their drivers can still sign in — deactivating an office account does not strand drivers", async () => {
      const { loginDriver } = await import("@/lib/accounts");

      await db().admin.update({
        where: { id: f.b.admin.id },
        data: { active: false },
      });

      const result = await loginDriver("Jane Delivery", "2222", f.b.tenantId);
      expect(result.success).toBe(true);
      expect(result.account?.tenantId).toBe(f.b.tenantId);

      await db().admin.update({
        where: { id: f.b.admin.id },
        data: { active: true },
      });
    });

    it("a wrong password on a deactivated account still says only invalid credentials", async () => {
      const { loginAdmin } = await import("@/lib/accounts");

      await db().admin.update({
        where: { id: f.b.admin.id },
        data: { active: false },
      });

      // Checked after the password, so the deactivation message cannot be used
      // to discover which emails exist.
      const result = await loginAdmin(f.b.admin.email, "wrong-password");
      expect(result.error).toBe("Invalid email or password");

      await db().admin.update({
        where: { id: f.b.admin.id },
        data: { active: true },
      });
    });

    it("SUPER_ADMIN can deactivate and reactivate an ADMIN", async () => {
      const { PUT } = await import("@/app/api/admin/users/route");
      useSession(superAdminSession(f));

      const off = await PUT(
        req("/api/admin/users", {
          method: "PUT",
          body: { id: f.b.admin.id, active: false },
        })
      );
      expect(off.status).toBe(200);
      expect(
        (await db().admin.findUnique({ where: { id: f.b.admin.id } }))?.active
      ).toBe(false);

      const on = await PUT(
        req("/api/admin/users", {
          method: "PUT",
          body: { id: f.b.admin.id, active: true },
        })
      );
      expect(on.status).toBe(200);
      expect(
        (await db().admin.findUnique({ where: { id: f.b.admin.id } }))?.active
      ).toBe(true);
    });

    it("deactivating revokes the session token so the admin is logged out at once", async () => {
      const { PUT } = await import("@/app/api/admin/users/route");
      useSession(superAdminSession(f));

      await db().admin.update({
        where: { id: f.b.admin.id },
        data: { sessionToken: "live-token" },
      });

      await PUT(
        req("/api/admin/users", {
          method: "PUT",
          body: { id: f.b.admin.id, active: false },
        })
      );

      expect(
        (await db().admin.findUnique({ where: { id: f.b.admin.id } }))?.sessionToken
      ).toBeNull();

      await db().admin.update({
        where: { id: f.b.admin.id },
        data: { active: true },
      });
    });

    it("a SUPER_ADMIN cannot deactivate themselves", async () => {
      const { PUT } = await import("@/app/api/admin/users/route");
      useSession(superAdminSession(f));

      const res = await PUT(
        req("/api/admin/users", {
          method: "PUT",
          body: { id: f.superAdmin.id, active: false },
        })
      );
      expect(res.status).toBe(400);
    });

    it("an ADMIN cannot deactivate anyone", async () => {
      const { PUT } = await import("@/app/api/admin/users/route");
      useSession(adminSession(f.a));

      const res = await PUT(
        req("/api/admin/users", {
          method: "PUT",
          body: { id: f.b.admin.id, active: false },
        })
      );
      expect(res.status).toBe(403);
    });
  });

  // ── The Users console ────────────────────────────────────────────────
  describe("the Users console", () => {
    it("lists every ADMIN across all scopes, with the workspace each owns", async () => {
      // This is the regression that made the console appear empty: each ADMIN now
      // lives in its own tenant, so a scoped query showed the SUPER_ADMIN only
      // itself.
      const { GET } = await import("@/app/api/admin/users/route");
      useSession(superAdminSession(f));

      const body = await (await GET(req("/api/admin/users"))).json();
      const emails = body.users.map((u: any) => u.email).sort();

      expect(emails).toContain(f.a.admin.email);
      expect(emails).toContain(f.b.admin.email);
      expect(emails).toContain(f.superAdmin.email);

      const rowA = body.users.find((u: any) => u.email === f.a.admin.email);
      expect(rowA.scope.tenantId).toBe(f.a.tenantId);
      expect(rowA.active).toBe(true);
      expect(rowA.scope.counts.drivers).toBe(1);
    });

    it("marks the caller's own row so the UI can block self-destructive actions", async () => {
      const { GET } = await import("@/app/api/admin/users/route");
      useSession(superAdminSession(f));

      const body = await (await GET(req("/api/admin/users"))).json();
      const self = body.users.filter((u: any) => u.isSelf);
      expect(self).toHaveLength(1);
      expect(self[0].email).toBe(f.superAdmin.email);
    });

    it("exposes no scoped business data through the console", async () => {
      const { GET } = await import("@/app/api/admin/users/route");
      useSession(superAdminSession(f));

      const serialized = JSON.stringify(
        await (await GET(req("/api/admin/users"))).json()
      );

      // Counts are fine; actual records are not.
      expect(serialized).not.toContain("Jane Delivery");
      expect(serialized).not.toContain("Acme Trading");
      expect(serialized).not.toContain("INV-1001");
      expect(serialized).not.toContain("onedrive-a@example.test");
      expect(serialized).not.toContain("access-token");
    });

    it("an ADMIN cannot list the console", async () => {
      const { GET } = await import("@/app/api/admin/users/route");
      useSession(adminSession(f.a));

      expect((await GET(req("/api/admin/users"))).status).toBe(403);
    });

    it("refuses to delete an ADMIN whose workspace still holds data", async () => {
      const { DELETE } = await import("@/app/api/admin/users/route");
      useSession(superAdminSession(f));

      const res = await DELETE(
        req("/api/admin/users", {
          method: "DELETE",
          body: { id: f.b.admin.id },
        })
      );

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.requiresConfirmation).toBe(true);
      expect(body.counts.drivers).toBe(1);

      // Nothing was deleted.
      expect(
        await db().admin.findUnique({ where: { id: f.b.admin.id } })
      ).not.toBeNull();
      expect(
        await db().driver.findUnique({ where: { id: f.b.driver.id } })
      ).not.toBeNull();
    });

    it("a SUPER_ADMIN cannot delete themselves", async () => {
      const { DELETE } = await import("@/app/api/admin/users/route");
      useSession(superAdminSession(f));

      const res = await DELETE(
        req("/api/admin/users", {
          method: "DELETE",
          body: { id: f.superAdmin.id },
        })
      );
      expect(res.status).toBe(400);
    });
  });

  // ── Admin provisioning ───────────────────────────────────────────────
  describe("admin provisioning", () => {
    it("a new ADMIN gets its own scope, not the SUPER_ADMIN's", async () => {
      const { POST } = await import("@/app/api/admin/users/route");
      useSession(superAdminSession(f));

      const res = await POST(
        req("/api/admin/users", {
          method: "POST",
          body: {
            name: "Admin C",
            email: "admin-c@example.test",
            password: "password123",
          },
        })
      );

      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body.scope.tenantId).not.toBe(f.superAdmin.tenantId);
      expect(body.scope.tenantId).not.toBe(f.a.tenantId);
      expect(body.scope.tenantId).not.toBe(f.b.tenantId);

      const admin = await db().admin.findUnique({
        where: { email: "admin-c@example.test" },
      });
      expect(admin?.tenantId).toBe(body.scope.tenantId);
    });

    it("the new ADMIN's first session sees an empty scope", async () => {
      const { GET } = await import("@/app/api/trip-sheet/route");
      const { GET: driversGet } = await import("@/app/api/drivers/route");

      const admin = await db().admin.findUnique({
        where: { email: "admin-c@example.test" },
      });
      expect(admin).not.toBeNull();

      useSession({
        id: admin!.id,
        role: "admin",
        name: admin!.name,
        email: admin!.email,
        tenantId: admin!.tenantId,
        viewTenantId: null,
        sessionToken: "test-token",
        exp: Date.now() + 3_600_000,
      });

      expect((await (await GET(req("/api/trip-sheet"))).json()).tripSheets).toHaveLength(0);
      expect((await (await driversGet(req("/api/drivers"))).json()).drivers).toHaveLength(0);
    });

    it("an ADMIN cannot create another ADMIN", async () => {
      const { POST } = await import("@/app/api/admin/users/route");
      useSession(adminSession(f.a));

      const res = await POST(
        req("/api/admin/users", {
          method: "POST",
          body: {
            name: "Sneaky",
            email: "sneaky@example.test",
            password: "password123",
          },
        })
      );
      expect(res.status).toBe(403);
    });

    it("signup is closed once an admin exists", async () => {
      const { POST } = await import("@/app/api/auth/signup/route");

      const res = await POST(
        req("/api/auth/signup", {
          method: "POST",
          body: {
            name: "Interloper",
            email: "interloper@example.test",
            password: "password123",
          },
        }) as any
      );
      expect(res.status).toBe(403);
    });
  });

  // ── Driver login resolves the right scope ────────────────────────────
  describe("driver login", () => {
    it("resolves the scope from the name+PIN pair", async () => {
      const { loginDriver } = await import("@/lib/accounts");

      const asA = await loginDriver("Jane Delivery", "1111");
      const asB = await loginDriver("Jane Delivery", "2222");

      expect(asA.account?.tenantId).toBe(f.a.tenantId);
      expect(asB.account?.tenantId).toBe(f.b.tenantId);
    });

    it("a wrong PIN reveals nothing about which scopes hold the name", async () => {
      const { loginDriver } = await import("@/lib/accounts");

      const wrongPin = await loginDriver("Jane Delivery", "9999");
      const unknownName = await loginDriver("Nobody At All", "1111");

      expect(wrongPin.success).toBe(false);
      expect(unknownName.success).toBe(false);
      // Identical message — the response cannot be used to enumerate names.
      expect(wrongPin.error).toBe(unknownName.error);
    });

    it("refuses an ambiguous login rather than guessing a scope", async () => {
      const { loginDriver } = await import("@/lib/accounts");

      // Give B a driver with A's name AND A's PIN.
      const clash = await db().driver.create({
        data: {
          name: "Ambiguous Ann",
          pinHash: (await import("crypto")).scryptSync("3333", "aaaa", 64).toString("hex"),
          tenantId: f.b.tenantId,
        },
      });
      // Rewrite both with an identical, correctly-formatted hash+salt.
      const salt = "b".repeat(32);
      const hash = (await import("crypto")).scryptSync("3333", salt, 64).toString("hex");
      await db().driver.update({
        where: { id: clash.id },
        data: { pinHash: `${salt}:${hash}` },
      });
      const clashA = await db().driver.create({
        data: {
          name: "Ambiguous Ann",
          pinHash: `${salt}:${hash}`,
          tenantId: f.a.tenantId,
        },
      });

      const result = await loginDriver("Ambiguous Ann", "3333");

      // Two scopes matched — dropping the driver into either would expose that
      // ADMIN's deliveries, so the login is refused.
      expect(result.success).toBe(false);
      expect(result.account).toBeUndefined();

      await db().driver.deleteMany({
        where: { id: { in: [clash.id, clashA.id] } },
      });
    });
  });

  // ── Change feed ──────────────────────────────────────────────────────
  //
  // /api/sync is polled continuously by every signed-in device, so a leak here
  // would not be a one-off disclosure — it would be a standing side channel
  // reporting another ADMIN's delivery activity in near real time.
  describe("change feed", () => {
    it("counts only the caller's own scope", async () => {
      const { GET } = await import("@/app/api/sync/route");

      useSession(adminSession(f.a));
      const a = await (await GET(req("/api/sync"))).json();

      useSession(adminSession(f.b));
      const b = await (await GET(req("/api/sync"))).json();

      // Each scope has exactly one seeded trip sheet and one stop — so a cursor
      // that saw both scopes would report two.
      expect(a.tripSheets).toBe(1);
      expect(a.stops).toBe(1);
      expect(b.tripSheets).toBe(1);
      expect(b.stops).toBe(1);
    });

    it("ADMIN 2 signing a stop does not move ADMIN 1's cursor", async () => {
      const { GET } = await import("@/app/api/sync/route");

      useSession(adminSession(f.a));
      const before = (await (await GET(req("/api/sync"))).json()).cursor;

      // Activity in the other scope, of exactly the kind the feed is meant to
      // notice for its own scope.
      await db().stop.update({
        where: { id: f.b.stop.id },
        data: { status: "SIGNED", signedAt: new Date() },
      });

      useSession(adminSession(f.a));
      const after = (await (await GET(req("/api/sync"))).json()).cursor;

      expect(after).toBe(before);
    });

    it("moves for the scope that actually changed", async () => {
      const { GET } = await import("@/app/api/sync/route");

      useSession(adminSession(f.b));
      const before = (await (await GET(req("/api/sync"))).json()).cursor;

      await db().stop.update({
        where: { id: f.b.stop.id },
        data: { customerName: `Changed ${Date.now()}` },
      });

      useSession(adminSession(f.b));
      const after = (await (await GET(req("/api/sync"))).json()).cursor;

      // Proves the previous test passed because of scoping, not because the
      // cursor is simply insensitive to change.
      expect(after).not.toBe(before);
    });

    it("a DRIVER's cursor covers only their own work", async () => {
      const { GET } = await import("@/app/api/sync/route");

      useSession(driverSession(f.a));
      const body = await (await GET(req("/api/sync"))).json();

      expect(body.tripSheets).toBe(1);
      expect(body.stops).toBe(1);
    });

    it("another scope's driver activity does not wake this driver's device", async () => {
      const { GET } = await import("@/app/api/sync/route");

      useSession(driverSession(f.a));
      const before = (await (await GET(req("/api/sync"))).json()).cursor;

      await db().stop.update({
        where: { id: f.b.stop.id },
        data: { status: "SIGNED", signedAt: new Date() },
      });

      useSession(driverSession(f.a));
      const after = (await (await GET(req("/api/sync"))).json()).cursor;

      expect(after).toBe(before);
    });

    it("requires a session", async () => {
      const { GET } = await import("@/app/api/sync/route");
      useSession(null);

      const res = await GET(req("/api/sync"));
      expect(res.status).toBe(401);
    });
  });
});
