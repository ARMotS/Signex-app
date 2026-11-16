import { describe, it, expect } from "vitest";
import { formatStorageTiming, graphOpShape } from "@/lib/storage/timing";

describe("graphOpShape", () => {
  const G = "https://graph.microsoft.com/v1.0/me/drive";

  it.each([
    [`${G}/items/01ABCDEF/children?$top=200`, "GET items/:id/children"],
    [`${G}/root/children?$top=200&$skiptoken=XYZ`, "GET root/children"],
    [`${G}/items/01ABC:/IV-365.pdf`, "GET items/:id:/:path"],
    [`${G}/items/01ABC:/signed/IV%20365.pdf`, "GET items/:id:/:path"],
    [`${G}/items/01ABC:/IV-365.pdf:/content?@microsoft.graph.conflictBehavior=fail`, "GET items/:id:/:path:/content"],
    [`${G}/items/01ABC/content`, "GET items/:id/content"],
    [`${G}/items/01%21ABC`, "GET items/:id"],
  ])("%s", (url, shape) => {
    expect(graphOpShape("get", url)).toBe(shape);
  });

  it("never leaks a file name or an item id", () => {
    const shape = graphOpShape("PUT", `${G}/items/SECRETID:/Acme Customer 9917.pdf:/content`);
    expect(shape).not.toMatch(/SECRETID|Acme|9917/);
  });
});

describe("formatStorageTiming", () => {
  it("is one short line, noting retries only when there were any", () => {
    expect(formatStorageTiming({ provider: "onedrive", op: "GET items/:id", status: 200, ms: 312.4 })).toBe(
      "[storage] onedrive GET items/:id 200 312ms"
    );
    expect(
      formatStorageTiming({ provider: "s3", op: "PutObject", status: 200, ms: 90, attempts: 3 })
    ).toBe("[storage] s3 PutObject 200 90ms (3 attempts)");
  });
});
