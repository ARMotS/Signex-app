/**
 * Cross-ADMIN isolation, end-to-end through the real route handlers.
 *
 * Needs a throwaway Postgres:
 *   DATABASE_URL_DIRECT=postgresql://...throwaway npx prisma db push
 *   TEST_DATABASE_URL=postgresql://...throwaway npm run test:isolation
 *
 * The two lines use DIFFERENT variables, and it matters. The vitest run reads
 * TEST_DATABASE_URL and redirects Prisma onto it (tests/setup.ts), so it can
 * never touch a real database. The Prisma CLI does not: prisma.config.ts loads
 * .env and takes DATABASE_URL_DIRECT, so `TEST_DATABASE_URL=... prisma db push`
 * would silently push to whatever .env points at — and `db push` writes no
 * migration history, so the next `migrate deploy` would then fail on columns
 * that already exist. Override DATABASE_URL_DIRECT explicitly for the schema
 * step.
 *
 * Without TEST_DATABASE_URL the suite skips (and says so) rather than passing
 * vacuously — a silently-skipped isolation test is worse than no test.
 *
 * The fixtures give scope A and scope B a driver with the SAME name, a contact
 * with the SAME company name, a stop with the SAME invoice number, and a
 * collection with the SAME collection number. So no assertion here can pass
 * merely because the values happened to differ.
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
  formReq,
  pdfFile,
  tripSheetCsv,
  tripSheetCsvWithCollection,
  params,
  CREDENTIALS,
  type Fixtures,
} from "./helpers/fixtures";

vi.mock("@/lib/session", () => sessionMockFactory());

/**
 * The SMTP relay is stubbed. Beyond keeping the suite off the network, the
 * recorded recipients are themselves an isolation assertion: whose address a
 * confirmation would have gone to is the leak that matters most here.
 */
const sentEmails: { to: string; invoiceNumber: string }[] = [];
vi.mock("@/lib/email", () => ({
  sendDeliveryConfirmation: vi.fn(
    async (p: { customerEmail: string; invoiceNumber: string }) => {
      sentEmails.push({ to: p.customerEmail, invoiceNumber: p.invoiceNumber });
      return { success: true, emailId: `test-${sentEmails.length}` };
    }
  ),
}));
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
    sentEmails.length = 0;
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

      // Restore for any later test — the SAME row seedFixtures built, folder
      // paths included. Leaving those two null made scope A silently differ
      // from scope B for the rest of the file, which is exactly the kind of
      // order-dependence that makes a later failure look like a product bug.
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
          folderPath: "/TripSheets-A",
          invoiceFolderItemId: "invoice-folder-A",
          invoiceFolderPath: "/Invoices-A",
          collectionsFolderItemId: "collections-folder-A",
          collectionsFolderPath: "/Collections-A",
          tenantId: f.a.tenantId,
        },
      });

      // Every column seedFixtures sets has to be restored here, or scope A
      // silently differs from scope B for the rest of the file. Asserted rather
      // than trusted to review: the last two were added when collections landed
      // and missing them made a later collections test fail as though the
      // product had lost track of the folder.
      const restored = await db().cloudAccount.findFirst({
        where: { tenantId: f.a.tenantId },
      });
      const seeded = await db().cloudAccount.findFirst({
        where: { tenantId: f.b.tenantId },
      });
      for (const key of Object.keys(seeded ?? {})) {
        if (
          ["id", "tenantId", "accountEmail", "accountName", "accessToken",
           "refreshToken", "tokenExpiry", "createdAt", "updatedAt"].includes(key)
        ) {
          continue;
        }
        const a = (restored as Record<string, unknown>)?.[key];
        const b = (seeded as Record<string, unknown>)?.[key];
        // Scope-suffixed values differ by design; what matters is that neither
        // is null when the other is set.
        expect(
          a === null ? "null" : "set",
          `CloudAccount.${key} was not restored for scope A`
        ).toBe(b === null ? "null" : "set");
      }
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

  // ── Collections ──────────────────────────────────────────────────────
  //
  // Collections carry a credit against a customer's account, so a leak here is
  // a leak of another company's returns and of what their customers sent back.
  // The report endpoint is also read across a whole scope on every open, like
  // the dashboard, which makes a scoping bug a standing side channel rather
  // than a one-off.
  describe("collections", () => {
    it("ADMIN 1 sees none of ADMIN 2's collections, despite the identical number", async () => {
      const { GET } = await import("@/app/api/collections/route");
      useSession(adminSession(f.a));

      const body = await (await GET(req("/api/collections"))).json();

      const ids = body.collections.map((c: any) => c.id);
      expect(ids).toContain(f.a.collection.id);
      expect(ids).not.toContain(f.b.collection.id);
      expect(body.collections).toHaveLength(1);
      expect(body.counts.total).toBe(1);
    });

    it("ADMIN 1 fetching ADMIN 2's collection by direct id gets 404", async () => {
      const { GET } = await import("@/app/api/collections/[id]/route");
      useSession(adminSession(f.a));

      const res = await GET(
        req(`/api/collections/${f.b.collection.id}`),
        params({ id: f.b.collection.id })
      );

      // 404, never 403 — a 403 would confirm the row exists somewhere.
      expect(res.status).toBe(404);
    });

    it("ADMIN 1 recording an outcome on ADMIN 2's collection gets 404 and changes nothing", async () => {
      const { PUT } = await import("@/app/api/collections/[id]/route");
      useSession(adminSession(f.a));

      const res = await PUT(
        req(`/api/collections/${f.b.collection.id}`, {
          method: "PUT",
          body: {
            status: "COLLECTED",
            collectedQty: 2,
            signedByName: "Someone Else",
            signatureImage: "data:image/png;base64,iVBORw0KGgo=",
          },
        }),
        params({ id: f.b.collection.id })
      );

      expect(res.status).toBe(404);

      const still = await db().collection.findUnique({
        where: { id: f.b.collection.id },
      });
      expect(still?.status).toBe("PENDING");
      expect(still?.signedByName).toBeNull();
    });

    it("ADMIN 1 editing ADMIN 2's collection gets 404 and changes nothing", async () => {
      const { PATCH } = await import("@/app/api/collections/[id]/route");
      useSession(adminSession(f.a));

      const res = await PATCH(
        req(`/api/collections/${f.b.collection.id}`, {
          method: "PATCH",
          body: { type: "NON_CREDIT_UPLIFT", upliftSubtype: "DOCUMENTS" },
        }),
        params({ id: f.b.collection.id })
      );

      expect(res.status).toBe(404);
      const still = await db().collection.findUnique({
        where: { id: f.b.collection.id },
      });
      expect(still?.type).toBe("CREDIT_RETURN");
    });

    it("a DRIVER cannot reach a collection on another scope's trip", async () => {
      const { GET } = await import("@/app/api/collections/[id]/route");
      useSession(driverSession(f.b));

      const res = await GET(
        req(`/api/collections/${f.a.collection.id}`),
        params({ id: f.a.collection.id })
      );

      expect(res.status).toBe(404);
    });

    it("the database itself rejects a collection pointing at another scope's stop", async () => {
      // The composite foreign key makes this unrepresentable, not merely
      // discouraged — the same guarantee Stop has against a foreign contact.
      await expect(
        db().collection.create({
          data: {
            collectionNo: "COL-CROSS",
            type: "CREDIT_RETURN",
            tripSheetId: f.a.tripSheet.id,
            stopId: f.b.stop.id,
            tenantId: f.a.tenantId,
          },
        })
      ).rejects.toThrow();
    });

    it("the scoped client refuses to stamp a foreign scope onto a collection", async () => {
      const { scopedPrisma } = await import("@/lib/db-scoped");

      await expect(
        scopedPrisma(f.a.tenantId).collection.updateMany({
          where: { id: f.b.collection.id },
          data: { status: "COLLECTED" },
        })
      ).resolves.toMatchObject({ count: 0 });

      const still = await db().collection.findUnique({
        where: { id: f.b.collection.id },
      });
      expect(still?.status).toBe("PENDING");
    });

    it("a deployed collection lands in the uploader's scope and nowhere else", async () => {
      const { POST } = await import("@/app/api/trip-sheet/route");
      useSession(adminSession(f.a));

      const form = new FormData();
      form.set(
        "file",
        tripSheetCsvWithCollection(f.a.driver.name, "INV-9100", "COL-9100")
      );
      form.set("action", "deploy");
      // The invoice folder listing is stubbed empty, so the missing-invoice
      // gate would block this — skipping the invoice is the dispatcher's own
      // documented way past it.
      form.set("skipInvoices", JSON.stringify([]));

      const res = await POST(formReq("/api/trip-sheet", form));
      // Either it deployed, or it was correctly blocked for the missing PDF.
      // Both outcomes must leave scope B untouched, which is what is asserted.
      expect([200, 409]).toContain(res.status);

      const inB = await db().collection.findMany({
        where: { tenantId: f.b.tenantId, collectionNo: "COL-9100" },
      });
      expect(inB).toHaveLength(0);

      const inA = await db().collection.findMany({
        where: { tenantId: f.a.tenantId, collectionNo: "COL-9100" },
      });
      for (const c of inA) expect(c.tenantId).toBe(f.a.tenantId);

      // Clean up so later counts stay predictable.
      await db().collection.deleteMany({ where: { collectionNo: "COL-9100" } });
      await db().tripSheet.deleteMany({
        where: { tenantId: f.a.tenantId, sourceFilename: "run.csv" },
      });
    });

    it("the change-feed cursor counts only the caller's own collections", async () => {
      const { buildSyncCursor } = await import("@/lib/sync-cursor");

      const a = await buildSyncCursor(f.a.tenantId);
      const b = await buildSyncCursor(f.b.tenantId);

      expect(a.collections).toBe(1);
      expect(b.collections).toBe(1);
      // /api/sync is polled continuously, so a cursor that moved when ANOTHER
      // scope wrote would be a permanent, low-bandwidth side channel.
      expect(a.cursor).not.toBe(b.cursor);
    });

    it("a driver's cursor covers only their own trip's collections", async () => {
      const { buildSyncCursor } = await import("@/lib/sync-cursor");

      const own = await buildSyncCursor(f.a.tenantId, { driverId: f.a.driver.id });
      expect(own.collections).toBe(1);

      // Scope A's driver id, asked for inside scope B: the scoped client sees
      // no such driver's work at all.
      const foreign = await buildSyncCursor(f.b.tenantId, { driverId: f.a.driver.id });
      expect(foreign.collections).toBe(0);
    });

    it("collection documents resolve against the caller's own collections folder", async () => {
      const { listCollectionDocuments } = await import("@/lib/collections");

      await listCollectionDocuments(f.a.tenantId);

      const urls = graphCalls.map((c) => c.url).join(" ");
      expect(urls).toContain("collections-folder-A");
      expect(urls).not.toContain("collections-folder-B");
      expect(graphCalls.every((c) => c.token === "access-token-A")).toBe(true);
    });

    it("serving a document by filename cannot reach another scope's folder", async () => {
      const { GET } = await import("@/app/api/collections/document/[name]/route");
      useSession(adminSession(f.a));

      // B's filename, requested by A. The filename is caller-supplied and the
      // route takes it verbatim, so what stops it crossing a boundary is not the
      // name — it is that the name is only ever resolved against the CALLER's
      // own folder, with the caller's own token.
      const name = "COL-500-B.pdf";
      await GET(req(`/api/collections/document/${name}`), params({ name }));

      const urls = graphCalls.map((c) => c.url).join(" ");

      // That is the whole claim, and it is asserted on the address rather than
      // on the response status: the suite's fetch stub answers 200 to every URL,
      // so a status assertion here would be testing the stub. Against real Graph
      // the lookup below 404s and the route returns 404.
      expect(urls).toContain("collections-folder-A");
      expect(urls).not.toContain("collections-folder-B");
      expect(graphCalls.every((c) => c.token === "access-token-A")).toBe(true);
    });

    it("a signed document is read from the caller's own Signed folder", async () => {
      const { GET } = await import("@/app/api/collections/document/[name]/route");
      useSession(adminSession(f.b));

      const name = "COL-500-A_COLLECTED.pdf";
      await GET(
        req(`/api/collections/document/${name}?signed=true`),
        params({ name })
      );

      const urls = graphCalls.map((c) => c.url).join(" ");
      expect(urls).toContain("collections-folder-B");
      expect(urls).not.toContain("collections-folder-A");
      expect(graphCalls.every((c) => c.token === "access-token-B")).toBe(true);
    });

    it("a DRIVER cannot read the scope-wide collections report", async () => {
      const { GET } = await import("@/app/api/collections/route");
      useSession(driverSession(f.a));

      const res = await GET(req("/api/collections"));
      expect(res.status).toBe(403);
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

  // ── One sign-in for every role ───────────────────────────────────────
  //
  // There is no tenant selector on the login form: the username alone picks the
  // account, and the account's own row supplies the role and the scope. So a
  // username must be unique across every role and every scope — enforced by the
  // LoginName primary key — and nothing the client sends may influence scope.
  describe("username + password sign-in", () => {
    it("resolves each role to its own account, role and scope", async () => {
      const { login } = await import("@/lib/accounts");

      const sup = await login(CREDENTIALS.superAdmin.username, CREDENTIALS.superAdmin.password);
      const adminA = await login(CREDENTIALS.admin("A").username, CREDENTIALS.admin("A").password);
      const driverB = await login(CREDENTIALS.driver("B").username, CREDENTIALS.driver("B").password);

      expect(sup.success && sup.account).toMatchObject({
        id: f.superAdmin.id,
        role: "super_admin",
        tenantId: f.superAdmin.tenantId,
      });
      expect(adminA.success && adminA.account).toMatchObject({
        id: f.a.admin.id,
        role: "admin",
        tenantId: f.a.tenantId,
      });
      // Both scopes employ a "Jane Delivery"; the username alone tells them apart.
      expect(driverB.success && driverB.account).toMatchObject({
        id: f.b.driver.id,
        role: "driver",
        tenantId: f.b.tenantId,
      });
    });

    it("treats usernames case-insensitively and ignores surrounding spaces", async () => {
      const { login } = await import("@/lib/accounts");

      const result = await login("  JANE.A ", CREDENTIALS.driver("A").password);
      expect(result.success && result.account.id).toBe(f.a.driver.id);
    });

    it("gives one generic error for a wrong password and an unknown username", async () => {
      const { login, LOGIN_FAILED } = await import("@/lib/accounts");

      const wrongPassword = await login(CREDENTIALS.admin("A").username, "not-the-password1");
      const unknownUser = await login("nobody.here", CREDENTIALS.admin("A").password);
      // Another scope's password against this scope's username.
      const crossed = await login(CREDENTIALS.driver("A").username, CREDENTIALS.driver("B").password);

      for (const r of [wrongPassword, unknownUser, crossed]) {
        expect(r.success).toBe(false);
        expect(!r.success && r.error).toBe(LOGIN_FAILED);
      }
      expect(LOGIN_FAILED).toBe("Incorrect username or password");
    });

    it("a driver created before usernames existed cannot sign in until given credentials", async () => {
      const { login, listDrivers, updateDriver } = await import("@/lib/accounts");

      // As the migration leaves them: a PIN hash, no password, no username.
      const legacy = await db().driver.create({
        data: { name: "Legacy Larry", pinHash: "salt:hash", tenantId: f.a.tenantId },
      });

      const listed = (await listDrivers(f.a.tenantId)).find((d) => d.id === legacy.id);
      expect(listed).toMatchObject({ username: null, canSignIn: false });

      // A password alone would leave a half-set account, so it is refused.
      const half = await updateDriver(f.a.tenantId, legacy.id, { password: "larry-pass-1" });
      expect(half.success).toBe(false);

      const set = await updateDriver(f.a.tenantId, legacy.id, {
        username: "larry.legacy",
        password: "larry-pass-1",
      });
      expect(set.success).toBe(true);

      const result = await login("larry.legacy", "larry-pass-1");
      expect(result.success && result.account).toMatchObject({
        id: legacy.id,
        role: "driver",
        tenantId: f.a.tenantId,
      });

      await db().driver.delete({ where: { id: legacy.id } });
    });

    it("the database refuses a username already used by any role in any scope", async () => {
      // Scope B's driver trying to take scope A's ADMIN username, bypassing the
      // application entirely. The primary key alone must stop it.
      await expect(
        db().loginName.create({
          data: { username: CREDENTIALS.admin("A").username, driverId: f.b.driver.id },
        })
      ).rejects.toMatchObject({ code: "P2002" });
    });

    it("the database refuses a username that is not lowercase and well-formed", async () => {
      const legacy = await db().driver.create({
        data: { name: "Case Carla", tenantId: f.b.tenantId },
      });

      // "Office.A" would otherwise sit beside "office.a" as a second account.
      await expect(
        db().loginName.create({ data: { username: "Office.A", driverId: legacy.id } })
      ).rejects.toThrow();
      await expect(
        db().loginName.create({ data: { username: "has space", driverId: legacy.id } })
      ).rejects.toThrow();

      await db().driver.delete({ where: { id: legacy.id } });
    });

    it("an ADMIN cannot create a driver with a username taken in another scope, in any case", async () => {
      const { POST } = await import("@/app/api/drivers/route");
      useSession(adminSession(f.b));

      for (const taken of [CREDENTIALS.admin("A").username, "JANE.A", " Jane.A "]) {
        const res = await POST(
          req("/api/drivers", {
            method: "POST",
            body: { name: `New ${taken}`, username: taken, password: "fresh-pass-1" },
          })
        );
        expect(res.status).toBe(409);
        expect((await res.json()).error).toBe("Username already taken");
      }

      // ...and the refusal reveals nothing about whose name it is.
      const created = await db().driver.findMany({
        where: { tenantId: f.b.tenantId, name: { startsWith: "New " } },
      });
      expect(created).toHaveLength(0);
    });

    it("a driver an ADMIN creates lands in the ADMIN's scope, whatever the body says", async () => {
      const { POST } = await import("@/app/api/drivers/route");
      useSession(adminSession(f.a));

      const res = await POST(
        req("/api/drivers", {
          method: "POST",
          body: {
            name: "Scoped Sam",
            username: "scoped.sam",
            password: "scoped-pass-1",
            tenantId: f.b.tenantId,
          },
        })
      );
      expect(res.status).toBe(200);

      const row = await db().driver.findFirst({ where: { name: "Scoped Sam" } });
      expect(row?.tenantId).toBe(f.a.tenantId);

      await db().driver.delete({ where: { id: row!.id } });
    });

    it("rejects weak passwords and malformed usernames on create", async () => {
      const { POST } = await import("@/app/api/drivers/route");
      useSession(adminSession(f.a));

      for (const body of [
        { name: "Weak One", username: "weak.one", password: "short1" },
        { name: "Weak Two", username: "weak.two", password: "lettersonly" },
        { name: "Weak Three", username: "weak.three", password: "12345678" },
        { name: "Bad Name", username: "no", password: "fine-pass-1" },
        { name: "Bad Name", username: "has-dash", password: "fine-pass-1" },
      ]) {
        const res = await POST(req("/api/drivers", { method: "POST", body }));
        expect(res.status).toBe(400);
      }
    });

    it("an ADMIN cannot reset another scope's driver's password", async () => {
      const { PUT } = await import("@/app/api/drivers/route");
      useSession(adminSession(f.a));

      const before = await db().driver.findUnique({ where: { id: f.b.driver.id } });

      const res = await PUT(
        req("/api/drivers", {
          method: "PUT",
          body: { id: f.b.driver.id, password: "hijack-pass-1", username: "hijacked" },
        })
      );
      expect(res.status).toBe(404);

      const after = await db().driver.findUnique({
        where: { id: f.b.driver.id },
        include: { login: true },
      });
      expect(after?.passwordHash).toBe(before?.passwordHash);
      expect(after?.login?.username).toBe(CREDENTIALS.driver("B").username);
    });

    it("resetting a driver's password signs them out and replaces the old one", async () => {
      const { PUT } = await import("@/app/api/drivers/route");
      const { login } = await import("@/lib/accounts");
      useSession(adminSession(f.a));

      await db().driver.update({
        where: { id: f.a.driver.id },
        data: { sessionToken: "live-token" },
      });

      const res = await PUT(
        req("/api/drivers", {
          method: "PUT",
          body: { id: f.a.driver.id, password: "rotated-pass-1" },
        })
      );
      expect(res.status).toBe(200);

      const row = await db().driver.findUnique({ where: { id: f.a.driver.id } });
      expect(row?.sessionToken).toBeNull();
      expect((await login(CREDENTIALS.driver("A").username, CREDENTIALS.driver("A").password)).success).toBe(false);
      expect((await login(CREDENTIALS.driver("A").username, "rotated-pass-1")).success).toBe(true);

      // Restore for the rest of the suite.
      await PUT(
        req("/api/drivers", {
          method: "PUT",
          body: { id: f.a.driver.id, password: CREDENTIALS.driver("A").password },
        })
      );
    });

    it("the availability check is for account creators only, and reveals only existence", async () => {
      const { GET } = await import("@/app/api/auth/username-available/route");

      useSession(driverSession(f.a));
      expect((await GET(req("/api/auth/username-available?username=office.b"))).status).toBe(403);

      useSession(adminSession(f.a));
      const taken = await (await GET(req("/api/auth/username-available?username=Office.B"))).json();
      expect(taken).toEqual({ username: "office.b", available: false, error: "Username already taken" });

      const free = await (await GET(req("/api/auth/username-available?username=nobody.here"))).json();
      expect(free).toEqual({ username: "nobody.here", available: true });
    });

    it("the Drivers page lists only this scope's drivers, with their usernames", async () => {
      const { GET } = await import("@/app/api/drivers/route");
      useSession(adminSession(f.a));

      const body = await (await GET(req("/api/drivers"))).json();

      expect(body.drivers.map((d: any) => d.id)).toEqual([f.a.driver.id]);
      expect(body.drivers[0]).toMatchObject({
        username: CREDENTIALS.driver("A").username,
        canSignIn: true,
      });
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain(CREDENTIALS.driver("B").username);
      expect(serialized).not.toContain("passwordHash");
      // The retired per-company sign-in link is gone.
      expect(body.signInLink).toBeUndefined();
    });

    it("the login route answers with the role's landing page", async () => {
      const { POST } = await import("@/app/api/auth/login/route");

      const cases: [{ username: string; password: string }, string, string][] = [
        [CREDENTIALS.superAdmin, "super_admin", "/users"],
        [CREDENTIALS.admin("A"), "admin", "/dashboard"],
        [CREDENTIALS.driver("A"), "driver", "/run"],
      ];
      for (const [creds, role, redirectTo] of cases) {
        const res = await POST(req("/api/auth/login", { method: "POST", body: creds }));
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ role, redirectTo });
      }
    });

    it("locks a username out after repeated failures, whether or not it exists", async () => {
      const { POST } = await import("@/app/api/auth/login/route");
      const { clearAttempts } = await import("@/lib/rate-limit");

      for (const username of ["office.b", "no.such.user"]) {
        const statuses: number[] = [];
        for (let i = 0; i < 6; i++) {
          const res = await POST(
            req("/api/auth/login", { method: "POST", body: { username, password: "wrong-pass-1" } })
          );
          statuses.push(res.status);
        }
        expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
        expect(statuses[5]).toBe(429);
        await clearAttempts(username, "auth:user");
      }
      await clearAttempts("127.0.0.1", "auth");
    });
  });

  // ── A driver sees only their own run ─────────────────────────────────
  //
  // The scoped client keeps a driver inside their company, but a company has
  // many drivers. Routes that take a filename or a stop id directly must also
  // check the thing is on THIS driver's trip sheet.
  describe("a DRIVER is confined to their own run within the scope", () => {
    let colleague: { driverId: string; tripSheetId: string; stopId: string };

    beforeAll(async () => {
      const driver = await db().driver.create({
        data: { name: "Colleague Cole", tenantId: f.a.tenantId },
      });
      const tripSheet = await db().tripSheet.create({
        data: {
          sourceFilename: "colleague.csv",
          uploadedBy: f.a.admin.id,
          driverId: driver.id,
          tenantId: f.a.tenantId,
        },
      });
      const stop = await db().stop.create({
        data: {
          stopNumber: 1,
          invoiceNumber: "INV-7007",
          invoiceFile: "INV-7007.pdf",
          customerName: "Colleague Customer",
          address: "Elsewhere",
          tripSheetId: tripSheet.id,
          tenantId: f.a.tenantId,
        },
      });
      await db().collection.create({
        data: {
          collectionNo: "COL-7007",
          type: "CREDIT_RETURN",
          sourceFilePath: "COL-7007.pdf",
          tripSheetId: tripSheet.id,
          stopId: stop.id,
          tenantId: f.a.tenantId,
        },
      });
      colleague = { driverId: driver.id, tripSheetId: tripSheet.id, stopId: stop.id };
    });

    afterAll(async () => {
      await db().tripSheet.delete({ where: { id: colleague.tripSheetId } });
      await db().driver.delete({ where: { id: colleague.driverId } });
    });

    it("cannot open a colleague's invoice by typing its filename", async () => {
      const { GET } = await import("@/app/api/invoices/[id]/route");
      useSession(driverSession(f.a));

      for (const url of ["/api/invoices/INV-7007.pdf", "/api/invoices/INV-7007.pdf?signed=true"]) {
        const res = await GET(req(url), params({ id: "INV-7007.pdf" }));
        expect(res.status).toBe(404);
      }
      // Refused before any storage was touched.
      expect(graphCalls).toHaveLength(0);
    });

    it("cannot sign a colleague's invoice, with or without one of their own stop ids", async () => {
      const { PUT } = await import("@/app/api/invoices/[id]/route");
      useSession(driverSession(f.a));

      for (const body of [
        { signatureImage: "data:image/png;base64,AAAA" },
        { signatureImage: "data:image/png;base64,AAAA", stopId: f.a.stop.id },
        { signatureImage: "data:image/png;base64,AAAA", stopId: colleague.stopId },
      ]) {
        const res = await PUT(
          req("/api/invoices/INV-7007.pdf", { method: "PUT", body }),
          params({ id: "INV-7007.pdf" })
        );
        expect(res.status).toBe(404);
      }
      const stop = await db().stop.findUnique({ where: { id: colleague.stopId } });
      expect(stop?.status).not.toBe("SIGNED");
    });

    it("cannot trigger a confirmation email for a colleague's delivery", async () => {
      const { POST } = await import("@/app/api/invoices/[id]/notify/route");
      useSession(driverSession(f.a));

      const res = await POST(
        req(`/api/invoices/${colleague.stopId}/notify`, { method: "POST", body: {} }),
        params({ id: colleague.stopId })
      );
      expect(res.status).toBe(404);
      expect(sentEmails).toHaveLength(0);
    });

    it("cannot open a colleague's collection document", async () => {
      const { GET } = await import("@/app/api/collections/document/[name]/route");
      useSession(driverSession(f.a));

      const res = await GET(
        req("/api/collections/document/COL-7007.pdf"),
        params({ name: "COL-7007.pdf" })
      );
      expect(res.status).toBe(404);
      expect(graphCalls).toHaveLength(0);
    });

    it("the office can still open the same invoice", async () => {
      const { GET } = await import("@/app/api/invoices/[id]/route");
      useSession(adminSession(f.a));

      await GET(req("/api/invoices/INV-7007.pdf"), params({ id: "INV-7007.pdf" }));
      // It went to storage (the stubbed Graph) rather than being refused.
      expect(graphCalls.length).toBeGreaterThan(0);
    });
  });

  // ── Admin deactivation ───────────────────────────────────────────────
  describe("admin deactivation", () => {
    it("a deactivated ADMIN cannot log in", async () => {
      const { login } = await import("@/lib/accounts");

      await db().admin.update({
        where: { id: f.b.admin.id },
        data: { active: false },
      });

      const result = await login(CREDENTIALS.admin("B").username, CREDENTIALS.admin("B").password);
      expect(result.success).toBe(false);
      expect(!result.success && result.error).toMatch(/deactivated/i);

      await db().admin.update({
        where: { id: f.b.admin.id },
        data: { active: true },
      });
    });

    it("their drivers can still sign in — deactivating an office account does not strand drivers", async () => {
      const { login } = await import("@/lib/accounts");

      await db().admin.update({
        where: { id: f.b.admin.id },
        data: { active: false },
      });

      const result = await login(CREDENTIALS.driver("B").username, CREDENTIALS.driver("B").password);
      expect(result.success && result.account.tenantId).toBe(f.b.tenantId);

      await db().admin.update({
        where: { id: f.b.admin.id },
        data: { active: true },
      });
    });

    it("a wrong password on a deactivated account still says only incorrect credentials", async () => {
      const { login, LOGIN_FAILED } = await import("@/lib/accounts");

      await db().admin.update({
        where: { id: f.b.admin.id },
        data: { active: false },
      });

      // Checked after the password, so the deactivation message cannot be used
      // to discover which usernames exist.
      const result = await login(CREDENTIALS.admin("B").username, "wrong-password1");
      expect(!result.success && result.error).toBe(LOGIN_FAILED);

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
            username: "office.c",
            password: "office-c-pass1",
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
            username: "sneaky.one",
            password: "sneaky-pass-1",
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
            username: "interloper",
            password: "interloper-pass1",
          },
        }) as any
      );
      expect(res.status).toBe(403);
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

  // ── Dashboard ────────────────────────────────────────────────────────
  //
  // The dashboard is polled all day and aggregates across the whole scope, so a
  // leak here would be a standing one rather than something you have to go
  // looking for.
  describe("dashboard", () => {
    it("counts and lists only the caller's own scope", async () => {
      const { GET } = await import("@/app/api/dashboard/route");

      useSession(adminSession(f.a));
      const a = await (await GET(req("/api/dashboard"))).json();

      // Each scope has exactly one seeded sheet with one stop, so anything that
      // saw both scopes would report two.
      expect(a.stats.totalStops).toBe(1);
      expect(a.stats.activeSheets).toBe(1);
      expect(a.tripSheets.map((t: any) => t.id)).toEqual([f.a.tripSheet.id]);
      expect(a.tripSheets.map((t: any) => t.id)).not.toContain(f.b.tripSheet.id);

      const stopIds = a.tripSheets.flatMap((t: any) => t.stops.map((s: any) => s.id));
      expect(stopIds).not.toContain(f.b.stop.id);

      // Same-name drivers in both scopes: the count, not the name, is the tell.
      expect(a.drivers).toHaveLength(1);
      expect(a.drivers[0].driverId).toBe(f.a.driver.id);
    });

    it("the email queue never surfaces another scope's customer", async () => {
      const { GET } = await import("@/app/api/dashboard/route");

      // A signed stop in B whose confirmation failed — exactly what the queue
      // is built to show its own dispatcher.
      await db().stop.update({
        where: { id: f.b.stop.id },
        data: {
          status: "SIGNED",
          signedAt: new Date(),
          contactId: f.b.contact.id,
          emailStatus: "FAILED",
          emailError: "relay refused",
        },
      });

      useSession(adminSession(f.a));
      const a = await (await GET(req("/api/dashboard"))).json();

      expect(a.emails.queue.map((q: any) => q.stopId)).not.toContain(f.b.stop.id);
      expect(a.emails.failed).toBe(0);
      // ...and the recipient address itself never appears anywhere in A's payload.
      expect(JSON.stringify(a)).not.toContain("acme-b@example.test");

      // B's own dispatcher does see it — proving the assertion above is scoping,
      // not the queue being empty for everyone.
      useSession(adminSession(f.b));
      const b = await (await GET(req("/api/dashboard"))).json();
      expect(b.emails.queue.map((q: any) => q.stopId)).toContain(f.b.stop.id);
      expect(b.emails.failed).toBe(1);

      await db().stop.update({
        where: { id: f.b.stop.id },
        data: {
          status: "PENDING",
          signedAt: null,
          contactId: null,
          emailStatus: "NOT_SENT",
          emailError: null,
        },
      });
    });

    it("is closed to DRIVER sessions", async () => {
      const { GET } = await import("@/app/api/dashboard/route");
      useSession(driverSession(f.a));

      const res = await GET(req("/api/dashboard"));
      expect(res.status).toBe(403);
    });

    it("requires a session", async () => {
      const { GET } = await import("@/app/api/dashboard/route");
      useSession(null);

      const res = await GET(req("/api/dashboard"));
      expect(res.status).toBe(401);
    });
  });

  // ── Completed trip sheet archive ─────────────────────────────────────
  describe("the completed trip sheet archive", () => {
    it("a completed sheet is snapshotted into the caller's scope and no other", async () => {
      const { saveTripSheet, completeTripSheet } = await import("@/lib/trip-data");

      const trip = await saveTripSheet(f.a.tenantId, {
        driverId: f.a.driver.id,
        driverName: f.a.driver.name,
        regNo: "REG-A",
        uploadedBy: f.a.admin.id,
        sourceFilename: "archive-me.csv",
        stops: [
          {
            stopNumber: 1,
            invoiceNumber: "INV-7001",
            customerName: "Archive Co",
            address: "1 Archive Rd",
            nop: 2,
            status: "PENDING",
          },
        ],
      });

      await db().stop.updateMany({
        where: { tripSheetId: trip.id },
        data: { status: "SIGNED", signedAt: new Date(), emailStatus: "SENT" },
      });

      const outcome = await completeTripSheet(f.a.tenantId, trip.id, "Admin A");
      expect(outcome.success).toBe(true);

      // The live sheet is gone; the archive row carries the record.
      expect(await db().tripSheet.findUnique({ where: { id: trip.id } })).toBeNull();

      const archived = await db().completedTripSheet.findFirst({
        where: { tripSheetId: trip.id },
      });
      expect(archived).not.toBeNull();
      expect(archived!.tenantId).toBe(f.a.tenantId);
      expect(archived!.tenantId).not.toBe(f.b.tenantId);
      expect(archived!.totalStops).toBe(1);
      expect(archived!.signedStops).toBe(1);
      expect(archived!.completedBy).toBe("Admin A");
      expect((archived!.stops as any)[0].invoiceNumber).toBe("INV-7001");

      // ADMIN 2's Completed tab must not show it.
      const { GET } = await import("@/app/api/trip-sheet/completed/route");
      useSession(adminSession(f.b));
      const bodyB = await (await GET(req("/api/trip-sheet/completed?range=all"))).json();
      expect(bodyB.completed.map((c: any) => c.id)).not.toContain(archived!.id);

      // ADMIN 1's does.
      useSession(adminSession(f.a));
      const bodyA = await (await GET(req("/api/trip-sheet/completed?range=all"))).json();
      expect(bodyA.completed.map((c: any) => c.id)).toContain(archived!.id);

      await db().completedTripSheet.delete({ where: { id: archived!.id } });
    });

    it("is closed to DRIVER sessions", async () => {
      const { GET } = await import("@/app/api/trip-sheet/completed/route");
      useSession(driverSession(f.a));

      const res = await GET(req("/api/trip-sheet/completed"));
      expect(res.status).toBe(403);
    });

    it("the per-day/per-driver report counts only the caller's own scope", async () => {
      const { GET } = await import("@/app/api/dashboard/completions/route");

      // Identical archive rows in both scopes, completed right now, with
      // deliberately different delivery counts so a leak shows up as a number.
      const archive = async (fx: typeof f.a, deliveries: number) =>
        db().completedTripSheet.create({
          data: {
            tripSheetId: `archived-${fx.tenantId}`,
            driverId: fx.driver.id,
            driverName: fx.driver.name,
            regNo: "REG-X",
            sourceFilename: "report.csv",
            uploadedAt: new Date(),
            uploadedBy: fx.admin.id,
            totalStops: deliveries,
            signedStops: deliveries,
            stops: [],
            tenantId: fx.tenantId,
          },
        });

      const rowA = await archive(f.a, 3);
      const rowB = await archive(f.b, 40);

      useSession(adminSession(f.a));
      const body = await (
        await GET(req("/api/dashboard/completions?range=month&tzOffset=0"))
      ).json();

      expect(body.totals.sheets).toBe(1);
      expect(body.totals.deliveries).toBe(3);
      expect(body.byDriver).toHaveLength(1);
      expect(body.byDriver[0].driverId).toBe(f.a.driver.id);
      // B's 40 must not appear in any bucket, including the day columns.
      expect(body.byDay.reduce((s: number, d: { deliveries: number }) => s + d.deliveries, 0)).toBe(3);
      expect(body.sheets.map((s: { id: string }) => s.id)).not.toContain(rowB.id);
      // The driver dropdown is this scope's roster only.
      expect(body.drivers.map((d: { id: string }) => d.id)).toEqual([f.a.driver.id]);

      await db().completedTripSheet.deleteMany({
        where: { id: { in: [rowA.id, rowB.id] } },
      });
    });

    it("the report is closed to DRIVER sessions", async () => {
      const { GET } = await import("@/app/api/dashboard/completions/route");
      useSession(driverSession(f.a));

      const res = await GET(req("/api/dashboard/completions"));
      expect(res.status).toBe(403);
    });
  });

  // ── Delivery confirmation email ──────────────────────────────────────
  describe("delivery confirmation email", () => {
    /**
     * Every test here drives a seeded stop through a different email state, and
     * earlier suites now genuinely attempt a send when they sign one. Resetting
     * up front rather than cleaning up afterwards means a failing assertion
     * reports its own problem instead of cascading into the next test.
     */
    beforeEach(async () => {
      for (const stop of [f.a.stop, f.b.stop]) {
        await db().stop.update({
          where: { id: stop.id },
          data: {
            status: "PENDING",
            signedAt: null,
            contactId: null,
            emailStatus: "NOT_SENT",
            emailSentAt: null,
            emailLastAttemptAt: null,
            emailError: null,
            emailAttempts: 0,
          },
        });
      }
    });

    it("cannot be sent to another scope's customer", async () => {
      const { POST } = await import("@/app/api/invoices/[id]/notify/route");

      await db().stop.update({
        where: { id: f.b.stop.id },
        data: { status: "SIGNED", signedAt: new Date(), contactId: f.b.contact.id },
      });

      useSession(adminSession(f.a));
      const res = await POST(
        req(`/api/invoices/${f.b.stop.id}/notify`, {
          method: "POST",
          body: { driverName: "Jane Delivery" },
        }),
        params({ id: f.b.stop.id })
      );

      // 404, never 403 — a 403 would confirm the stop exists somewhere else.
      expect(res.status).toBe(404);

      // No mail was addressed to B's customer, and nothing was recorded against
      // B's stop.
      expect(sentEmails).toHaveLength(0);
      const after = await db().stop.findUnique({ where: { id: f.b.stop.id } });
      expect(after?.emailAttempts).toBe(0);
      expect(after?.emailStatus).toBe("NOT_SENT");
    });

    it("a stop with no contact email is parked for the dispatcher, not retried forever", async () => {
      const { sendStopDeliveryConfirmation } = await import("@/lib/delivery-notify");

      await db().stop.update({
        where: { id: f.a.stop.id },
        data: { status: "SIGNED", signedAt: new Date(), contactId: null },
      });

      const result = await sendStopDeliveryConfirmation(f.a.tenantId, f.a.stop.id);
      expect(result.outcome).toBe("no_email");
      expect(result.sent).toBe(false);

      const row = await db().stop.findUnique({ where: { id: f.a.stop.id } });
      expect(row?.emailStatus).toBe("NO_EMAIL");
      // No claim was taken, so nothing counted as an attempt.
      expect(row?.emailAttempts).toBe(0);
    });

    it("an unsigned stop is never emailed", async () => {
      const { sendStopDeliveryConfirmation } = await import("@/lib/delivery-notify");

      const result = await sendStopDeliveryConfirmation(f.a.tenantId, f.a.stop.id);
      expect(result.outcome).toBe("not_signed");

      const row = await db().stop.findUnique({ where: { id: f.a.stop.id } });
      expect(row?.emailAttempts).toBe(0);
    });

    it("a claim already in flight is not sent a second time", async () => {
      const { sendStopDeliveryConfirmation } = await import("@/lib/delivery-notify");

      // Exactly the state the automatic send leaves behind while it works: a
      // fresh SENDING claim. A dispatcher pressing Send at this moment must not
      // put a second copy in the customer's inbox.
      await db().stop.update({
        where: { id: f.a.stop.id },
        data: {
          status: "SIGNED",
          signedAt: new Date(),
          contactId: f.a.contact.id,
          emailStatus: "SENDING",
          emailLastAttemptAt: new Date(),
          emailAttempts: 1,
        },
      });

      const result = await sendStopDeliveryConfirmation(f.a.tenantId, f.a.stop.id, {
        force: true,
      });
      expect(result.outcome).toBe("in_flight");
      expect(sentEmails).toHaveLength(0);

      const row = await db().stop.findUnique({ where: { id: f.a.stop.id } });
      expect(row?.emailAttempts).toBe(1);
    });

    it("a stale claim is recoverable — a crashed attempt does not strand a stop", async () => {
      const { sendStopDeliveryConfirmation } = await import("@/lib/delivery-notify");

      await db().stop.update({
        where: { id: f.a.stop.id },
        data: {
          status: "SIGNED",
          signedAt: new Date(),
          contactId: f.a.contact.id,
          emailStatus: "SENDING",
          // Older than the lease: whatever held this is not coming back.
          emailLastAttemptAt: new Date(Date.now() - 10 * 60 * 1000),
          emailAttempts: 1,
        },
      });

      const result = await sendStopDeliveryConfirmation(f.a.tenantId, f.a.stop.id);
      expect(result.outcome).toBe("sent");

      // Addressed to this scope's contact, not the identically-named one in B.
      expect(sentEmails).toHaveLength(1);
      expect(sentEmails[0].to).toBe("acme-a@example.test");

      const row = await db().stop.findUnique({ where: { id: f.a.stop.id } });
      expect(row?.emailAttempts).toBe(2);
      expect(row?.emailStatus).toBe("SENT");
      expect(row?.emailSentAt).not.toBeNull();
    });
  });

  // ── Contacts added after a delivery was already signed ────────────────
  /**
   * Stop.contactId used to be written only when a trip sheet was deployed, so a
   * customer who was not yet in Contacts left the delivery unreachable: marked
   * "no address on file", and un-rescuable, because the send path resolves the
   * recipient through Stop.contact and therefore just re-marked it. Adding the
   * contact now repairs the link.
   */
  describe("rescuing a delivery whose contact arrived late", () => {
    /** A signed delivery for a company that does not exist in Contacts yet. */
    async function orphanSignedStop(
      fx: Fixtures["a"],
      customerName: string,
      signedAt: Date
    ) {
      return db().stop.create({
        data: {
          stopNumber: 90,
          invoiceNumber: `INV-ORPHAN-${fx.tenantId.slice(0, 6)}`,
          customerName,
          address: "Somewhere",
          tripSheetId: fx.tripSheet.id,
          tenantId: fx.tenantId,
          status: "SIGNED",
          signedAt,
          contactId: null,
          emailStatus: "NO_EMAIL",
        },
        select: { id: true },
      });
    }

    beforeEach(() => {
      sentEmails.length = 0;
    });

    it("links the stop and re-arms it once the customer is added", async () => {
      const { POST } = await import("@/app/api/contacts/route");
      const stop = await orphanSignedStop(f.a, "Late Arrival Ltd", new Date());

      useSession(adminSession(f.a));
      const res = await POST(
        req("/api/contacts", {
          method: "POST",
          body: { companyName: "Late Arrival Ltd", email: "late@example.test" },
        })
      );
      expect(res.status).toBe(201);

      const body = await res.json();
      expect(body.relinked.nowSendable).toBe(1);
      expect(body.relinked.sendableStopIds).toContain(stop.id);

      const row = await db().stop.findUnique({ where: { id: stop.id } });
      expect(row?.contactId).toBe(body.id);
      // NO_EMAIL was a statement about the world, and the world changed.
      expect(row?.emailStatus).toBe("NOT_SENT");
      expect(row?.emailRelinkedAt).not.toBeNull();

      await db().stop.delete({ where: { id: stop.id } });
    });

    it("the rescued delivery can then actually be sent — the old dead end", async () => {
      const { POST: createContact } = await import("@/app/api/contacts/route");
      const { POST: notify } = await import("@/app/api/invoices/[id]/notify/route");
      const stop = await orphanSignedStop(f.a, "Second Chance Co", new Date());

      useSession(adminSession(f.a));
      await createContact(
        req("/api/contacts", {
          method: "POST",
          body: { companyName: "Second Chance Co", email: "second@example.test" },
        })
      );

      // Before the fix this returned {skipped: true, reason: 'No email on file'}
      // however many times it was pressed.
      const res = await notify(
        req(`/api/invoices/${stop.id}/notify`, { method: "POST", body: {} }),
        params({ id: stop.id })
      );
      const body = await res.json();

      expect(body.success).toBe(true);
      expect(sentEmails).toHaveLength(1);
      expect(sentEmails[0].to).toBe("second@example.test");

      await db().stop.delete({ where: { id: stop.id } });
    });

    it("never reaches across scopes to link another ADMIN's stop", async () => {
      const { POST } = await import("@/app/api/contacts/route");
      // Both scopes have a signed delivery for an identically named company —
      // the normal case, since these are real trading names.
      const stopA = await orphanSignedStop(f.a, "Shared Name Ltd", new Date());
      const stopB = await orphanSignedStop(f.b, "Shared Name Ltd", new Date());

      useSession(adminSession(f.a));
      const body = await (
        await POST(
          req("/api/contacts", {
            method: "POST",
            body: { companyName: "Shared Name Ltd", email: "shared-a@example.test" },
          })
        )
      ).json();

      expect(body.relinked.sendableStopIds).toEqual([stopA.id]);

      // B's identically-named delivery is untouched: still unlinked, still
      // NO_EMAIL, and pointed at nothing in A's scope.
      const rowB = await db().stop.findUnique({ where: { id: stopB.id } });
      expect(rowB?.contactId).toBeNull();
      expect(rowB?.emailStatus).toBe("NO_EMAIL");
      expect(rowB?.emailRelinkedAt).toBeNull();

      await db().stop.deleteMany({ where: { id: { in: [stopA.id, stopB.id] } } });
    });

    it("surfaces a rescued delivery in the queue however old it is", async () => {
      const { GET } = await import("@/app/api/dashboard/route");
      const { POST } = await import("@/app/api/contacts/route");

      // Signed well beyond the untried-queue age bound. Without the exemption
      // the repair would be invisible and the customer never confirmed.
      const longAgo = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000);
      const stop = await orphanSignedStop(f.a, "Ancient Delivery Co", longAgo);

      useSession(adminSession(f.a));
      await POST(
        req("/api/contacts", {
          method: "POST",
          body: { companyName: "Ancient Delivery Co", email: "ancient@example.test" },
        })
      );

      const body = await (await GET(req("/api/dashboard?tzOffset=0"))).json();
      const queued = body.emails.queue.find(
        (q: { stopId: string }) => q.stopId === stop.id
      );

      expect(queued).toBeDefined();
      expect(queued.sendable).toBe(true);
      expect(queued.relinked).toBe(true);
      expect(queued.recipient).toBe("ancient@example.test");

      await db().stop.delete({ where: { id: stop.id } });
    });

    it("leaves a stop alone when the new contact has no address either", async () => {
      const { POST } = await import("@/app/api/contacts/route");
      const stop = await orphanSignedStop(f.a, "No Address Ltd", new Date());

      useSession(adminSession(f.a));
      const body = await (
        await POST(
          req("/api/contacts", {
            method: "POST",
            // Added, but nobody filled in an email — the delivery is still stuck.
            body: { companyName: "No Address Ltd", phone: "+27 11 555 0000" },
          })
        )
      ).json();

      expect(body.relinked.nowSendable).toBe(0);

      const row = await db().stop.findUnique({ where: { id: stop.id } });
      // Linked, so editing the contact later is enough to finish the job...
      expect(row?.contactId).toBe(body.id);
      // ...but still correctly reported as having nowhere to send.
      expect(row?.emailStatus).toBe("NO_EMAIL");
      expect(row?.emailRelinkedAt).toBeNull();

      await db().stop.delete({ where: { id: stop.id } });
    });
  });

  // ── Missing invoices on deploy ───────────────────────────────────────
  //
  // A stop is never deployed without its invoice PDF: the signature is embedded
  // ON the invoice, so a stop without one leaves no physical record of the
  // delivery. These tests hold that as a rule rather than a prompt — it cannot
  // be switched off by a request, and it is decided inside the caller's own
  // scope, against the caller's own invoice folder.
  //
  // The stubbed Graph returns an empty folder to everyone, so every invoice
  // named on a sheet is missing here. That is the case under test.
  describe("missing invoices", () => {
    const deployForm = (
      driverName: string,
      extra: Record<string, string> = {}
    ) => {
      const form = new FormData();
      form.append("file", tripSheetCsv(driverName, "INV-2001"));
      form.append("action", "deploy");
      for (const [key, value] of Object.entries(extra)) form.append(key, value);
      return form;
    };

    it("refuses the deploy and writes nothing", async () => {
      const { POST } = await import("@/app/api/trip-sheet/route");
      useSession(adminSession(f.a));

      const before = await db().tripSheet.count({
        where: { tenantId: f.a.tenantId },
      });

      const res = await POST(
        formReq("/api/trip-sheet", deployForm(f.a.driver.name))
      );
      const body = await res.json();

      expect(res.status).toBe(409);
      expect(body.code).toBe("MISSING_INVOICES");
      expect(
        body.missingInvoices.map((m: { invoiceNumber: string }) => m.invoiceNumber)
      ).toEqual(["INV-2001"]);

      expect(
        await db().tripSheet.count({ where: { tenantId: f.a.tenantId } })
      ).toBe(before);
    });

    it("cannot be overridden from the request", async () => {
      // There is deliberately no escape hatch. If this test ever fails,
      // someone has reintroduced one — see CLAUDE.md, "Missing Invoices".
      const { POST } = await import("@/app/api/trip-sheet/route");
      useSession(adminSession(f.a));

      const overrideAttempts: Record<string, string>[] = [
        { allowMissing: "true" },
        { allowMissing: "1" },
        { force: "true" },
      ];

      for (const extra of overrideAttempts) {
        const res = await POST(
          formReq("/api/trip-sheet", deployForm(f.a.driver.name, extra))
        );
        expect(res.status).toBe(409);
      }
    });

    it("lets the deploy through once the stop is skipped", async () => {
      // Skipping drops the stop from the run entirely, so nothing goes out
      // unrecorded — which is why it is an acceptable way past the gate.
      const { POST } = await import("@/app/api/trip-sheet/route");
      useSession(adminSession(f.a));

      const res = await POST(
        formReq(
          "/api/trip-sheet",
          deployForm(f.a.driver.name, {
            skipInvoices: JSON.stringify(["INV-2001"]),
          })
        )
      );
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.deployed).toBe(true);
      expect(body.totalStops).toBe(0);
    });

    it("decides the gate in the caller's own scope", async () => {
      // Both scopes have a driver of this name and a stop with this invoice
      // number, so the refusal can only name the right driver by scoping.
      const { POST } = await import("@/app/api/trip-sheet/route");
      useSession(adminSession(f.b));

      const res = await POST(
        formReq("/api/trip-sheet", deployForm(f.b.driver.name))
      );
      const body = await res.json();

      expect(res.status).toBe(409);
      expect(body.missingInvoices).toHaveLength(1);
      expect(body.missingInvoices[0].driverName).toBe(f.b.driver.name);

      // B being refused wrote nothing into A.
      expect(
        await db().tripSheet.count({ where: { tenantId: f.a.tenantId } })
      ).toBe(1);
    });
  });

  // ── Invoice upload ───────────────────────────────────────────────────
  //
  // Uploading is how a dispatcher resolves a missing invoice, so it writes into
  // the invoice folder the parser reads from. Which folder that is must come
  // from the session and nothing else.
  describe("invoice upload", () => {
    it("tells each ADMIN only their own destination", async () => {
      const { GET } = await import("@/app/api/invoices/upload/route");

      useSession(adminSession(f.a));
      const a = await (await GET(req("/api/invoices/upload"))).json();

      useSession(adminSession(f.b));
      const b = await (await GET(req("/api/invoices/upload"))).json();

      expect(a.destination).toContain("Invoices-A");
      expect(a.destination).not.toContain("Invoices-B");
      expect(b.destination).toContain("Invoices-B");
      expect(b.destination).not.toContain("Invoices-A");
    });

    it("is closed to drivers", async () => {
      const { POST } = await import("@/app/api/invoices/upload/route");
      useSession(driverSession(f.a));

      const form = new FormData();
      form.append("file", pdfFile("INV-3001.pdf"));

      expect((await POST(formReq("/api/invoices/upload", form))).status).toBe(403);
    });

    it("writes with the caller's own token, into the caller's own folder", async () => {
      const { POST } = await import("@/app/api/invoices/upload/route");
      useSession(adminSession(f.a));

      const form = new FormData();
      form.append("file", pdfFile("INV-3001.pdf"));
      // The stub answers 200 to everything, so the existence probe would read
      // as a clash. Overwrite takes the test past it, to the write itself.
      form.append("overwrite", "true");

      expect((await POST(formReq("/api/invoices/upload", form))).status).toBe(200);

      const writes = graphCalls.filter((c) => c.url.includes("/content"));
      expect(writes.length).toBeGreaterThan(0);
      for (const call of writes) {
        expect(call.token).toBe("access-token-A");
        expect(call.url).toContain("invoice-folder-A");
        expect(call.url).not.toContain("invoice-folder-B");
      }
    });

    it("names the saved file after the invoice number, not the upload", async () => {
      // Matching is by filename, so a scan stored under its camera name would
      // leave the stop exactly as unmatched as it was.
      const { POST } = await import("@/app/api/invoices/upload/route");
      useSession(adminSession(f.a));

      const form = new FormData();
      form.append("file", pdfFile("scan_0042.pdf"));
      form.append("invoiceNumber", "INV-2001");
      form.append("overwrite", "true");

      const body = await (
        await POST(formReq("/api/invoices/upload", form))
      ).json();

      expect(body.filename).toBe("INV-2001.pdf");
    });

    it("refuses a non-PDF however it is named, without reaching Graph", async () => {
      const { POST } = await import("@/app/api/invoices/upload/route");
      useSession(adminSession(f.a));

      const form = new FormData();
      form.append(
        "file",
        new File([Buffer.from("PK a zip in disguise")], "INV-4.pdf", {
          type: "application/pdf",
        })
      );

      expect((await POST(formReq("/api/invoices/upload", form))).status).toBe(400);
      expect(graphCalls.filter((c) => c.url.includes("/content"))).toHaveLength(0);
    });
  });
});
