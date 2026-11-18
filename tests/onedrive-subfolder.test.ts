/**
 * Finding a subfolder costs ONE Graph request, never a listing of its parent.
 *
 * `ensureSubfolder(invoiceFolder, "signed")` runs on every signature saved. It
 * used to list the whole invoice folder (thousands of PDFs, 200 per request)
 * to learn the id of `signed/`, which is what drivers waited on after "Save".
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/db-scoped", () => ({
  scopedPrisma: () => ({
    cloudAccount: {
      findFirst: async () => ({
        provider: "onedrive",
        accessToken: "token",
        refreshToken: "refresh",
        tokenExpiry: new Date(Date.now() + 60 * 60 * 1000),
        invoiceFolderItemId: "INVOICES",
      }),
    },
  }),
  UNSAFE_unscopedPrisma: {},
}));
vi.mock("@/lib/crypto", () => ({
  encryptToken: (s: string) => s,
  decryptToken: (s: string) => s,
}));

let graph: typeof import("@/lib/microsoft-graph");
beforeAll(async () => {
  graph = await import("@/lib/microsoft-graph");
});

type Call = { method: string; url: string; body?: string };
let calls: Call[];

/** Answer Graph by route: `routes` maps "METHOD pathFragment" to a response. */
function stubGraph(routes: Array<[string, () => Response]>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ method, url, body: typeof init?.body === "string" ? init.body : undefined });
      const hit = routes.find(([key]) => {
        const [m, fragment] = key.split(" ");
        return m === method && url.includes(fragment);
      });
      return hit ? hit[1]() : new Response("unexpected", { status: 500 });
    })
  );
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  calls = [];
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ensureSubfolder", () => {
  it("finds an existing folder with one path-addressed request", async () => {
    stubGraph([["GET items/INVOICES:/signed", () => json({ id: "SIGNED", name: "signed", folder: { childCount: 3 } })]]);

    await expect(graph.ensureSubfolder("t1", "INVOICES", "signed")).resolves.toBe("SIGNED");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/me/drive/items/INVOICES:/signed");
    expect(calls.some((c) => c.url.includes("/children"))).toBe(false);
  });

  it("creates the folder when the lookup answers 404", async () => {
    stubGraph([
      ["GET items/INVOICES:/signed", () => json({ error: { code: "itemNotFound" } }, 404)],
      ["POST items/INVOICES/children", () => json({ id: "NEW", name: "signed", folder: {} }, 201)],
    ]);

    await expect(graph.ensureSubfolder("t1", "INVOICES", "signed")).resolves.toBe("NEW");
    expect(calls.map((c) => c.method)).toEqual(["GET", "POST"]);
    expect(JSON.parse(calls[1].body!)).toMatchObject({ name: "signed", folder: {} });
  });

  it("adopts a folder someone else created between the look and the create", async () => {
    let looks = 0;
    stubGraph([
      [
        "GET items/INVOICES:/signed",
        () => (++looks === 1 ? json({}, 404) : json({ id: "RACED", name: "signed", folder: {} })),
      ],
      ["POST items/INVOICES/children", () => json({ error: { code: "nameAlreadyExists" } }, 409)],
    ]);

    await expect(graph.ensureSubfolder("t1", "INVOICES", "signed")).resolves.toBe("RACED");
    expect(looks).toBe(2);
  });

  it("treats a FILE of that name as no folder, as the listing did", async () => {
    stubGraph([
      ["GET items/INVOICES:/signed", () => json({ id: "F", name: "signed", file: { mimeType: "x" } })],
      ["POST items/INVOICES/children", () => json({ error: {} }, 409)],
    ]);

    await expect(graph.ensureSubfolder("t1", "INVOICES", "signed")).rejects.toThrow(/409/);
  });

  it("throws on a real error rather than reading it as 'not there'", async () => {
    stubGraph([["GET items/INVOICES:/signed", () => json({ error: {} }, 403)]]);

    await expect(graph.ensureSubfolder("t1", "INVOICES", "signed")).rejects.toThrow(/403/);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });
});

describe("saving a signed invoice", () => {
  it("costs one lookup and one upload — no listing of the invoice folder", async () => {
    stubGraph([
      ["GET items/INVOICES:/signed", () => json({ id: "SIGNED", name: "signed", folder: {} })],
      ["PUT items/SIGNED:/IV-365.pdf:/content", () => json({ id: "ITEM" }, 201)],
    ]);

    // The item comes back with the folder it went into, even when Graph's reply
    // leaves that out — the invoice folder index files it under signed/.
    await expect(
      graph.uploadSignedInvoiceToOneDrive("t1", "IV-365.pdf", Buffer.from("%PDF-1.4"))
    ).resolves.toMatchObject({ id: "ITEM", parentReference: { id: "SIGNED" } });
    expect(calls.map((c) => c.method)).toEqual(["GET", "PUT"]);
  });
});

describe("findChildFolderId", () => {
  it("refuses a name that would walk out of the parent", async () => {
    stubGraph([]);
    await expect(graph.findChildFolderId("t1", "INVOICES", "../x")).rejects.toThrow(/path traversal/i);
    expect(calls).toHaveLength(0);
  });
});
