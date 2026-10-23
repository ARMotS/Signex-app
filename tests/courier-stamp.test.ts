/**
 * The courier handover stamp: its wording, where it goes, and the form that
 * produces it. The PDFs go through pdf.js exactly as a production invoice
 * does, so "is the area clear" is answered by the real text layer.
 */

import { describe, it, expect } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import {
  courierStampLines,
  DEFAULT_STAMP_AREA,
  formatStampTime,
  readStampArea,
} from "@/lib/courier-stamp-text";
import { areaRect, pngFromDataUrl, rectIsClear, stampCourierHandover } from "@/lib/courier-stamp";
import { extractPageItems } from "@/lib/invoice-header";
import { readCollectInput } from "@/lib/courier-collect";

const HEIGHT = 842;
const PNG_1PX =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const LINES = courierStampLines({
  dispatcherName: "Thandi M",
  dispatchCompany: "Signex Polokwane",
  courierDriverName: "Sipho K",
  courierCompany: "The Courier Guy",
  at: new Date("2026-10-22T12:05:00Z"),
  courierSheetNo: "200189",
  waybillNo: "W500",
});

/** An invoice whose last page prints `footer` at a top-left y, if given. */
async function invoice(opts: { pages?: number; footerTop?: number } = {}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < (opts.pages ?? 1); i++) {
    const page = doc.addPage([595, HEIGHT]);
    page.drawText("TAX INVOICE IV-7001", { x: 60, y: HEIGHT - 60, size: 14, font });
  }
  if (opts.footerTop !== undefined) {
    const last = doc.getPages()[doc.getPageCount() - 1];
    last.drawText("Goods remain our property until paid in full", { x: 80, y: HEIGHT - opts.footerTop - 8, size: 8, font });
  }
  return Buffer.from(await doc.save());
}

const textOf = async (pdf: Buffer) => (await extractPageItems(pdf)).map((page) => page.map((i) => i.str).join(" "));

describe("stamp wording", () => {
  it("prints Johannesburg time, whatever the server's clock", () => {
    // 12:05 UTC is 14:05 SAST; 23:30 UTC is already the next day there.
    expect(formatStampTime(new Date("2026-10-22T12:05:00Z"))).toBe("22/10/2026, 14:05");
    expect(formatStampTime(new Date("2026-10-22T23:30:00Z"))).toBe("23/10/2026, 01:30");
  });

  it("words the three lines as the brief does", () => {
    expect(LINES).toEqual({
      dispatched: "Dispatched by Thandi M from Signex Polokwane on 22/10/2026, 14:05",
      collected: "Collected by Sipho K from The Courier Guy on 22/10/2026, 14:05",
      footer: "Courier trip sheet 200189 · Waybill W500",
    });
  });

  it("never prints a blank where a name belongs", () => {
    const lines = courierStampLines({
      dispatcherName: " ",
      dispatchCompany: "",
      courierDriverName: "Sipho",
      courierCompany: "X",
      at: new Date("2026-10-22T12:05:00Z"),
      courierSheetNo: "1",
      waybillNo: "",
    });
    expect(lines.dispatched).toBe("Dispatched by — from — on 22/10/2026, 14:05");
    expect(lines.footer).toBe("Courier trip sheet 1 · Waybill —");
  });
});

describe("readStampArea", () => {
  it("accepts the default, an object or its JSON", () => {
    expect(readStampArea(DEFAULT_STAMP_AREA)).toEqual(DEFAULT_STAMP_AREA);
    expect(readStampArea(JSON.stringify(DEFAULT_STAMP_AREA))).toEqual(DEFAULT_STAMP_AREA);
    expect(readStampArea({ xPercent: "10", yPercent: "5", widthPercent: "50", heightPercent: "20" })).toEqual({
      xPercent: 10,
      yPercent: 5,
      widthPercent: 50,
      heightPercent: 20,
    });
  });

  it("refuses an area off the page, too small, or not an area at all", () => {
    for (const bad of [
      { xPercent: 70, yPercent: 0, widthPercent: 40, heightPercent: 20 }, // runs off the right
      { xPercent: 0, yPercent: 90, widthPercent: 50, heightPercent: 20 }, // runs off the top
      { xPercent: -1, yPercent: 0, widthPercent: 50, heightPercent: 20 },
      { xPercent: 0, yPercent: 0, widthPercent: 39, heightPercent: 20 }, // too narrow
      { xPercent: 0, yPercent: 0, widthPercent: 50, heightPercent: 11 }, // too short
      { xPercent: 0, yPercent: 0, widthPercent: "wide", heightPercent: 20 },
      "not json",
      null,
      42,
    ]) {
      expect(readStampArea(bad)).toBeNull();
    }
  });
});

describe("rectIsClear", () => {
  const rect = areaRect(DEFAULT_STAMP_AREA, 595, HEIGHT);

  it("is clear with nothing in the area, and blank runs do not count", () => {
    expect(rectIsClear([], HEIGHT, rect)).toBe(true);
    expect(rectIsClear([{ x: 100, y: HEIGHT - 50, str: "   ", width: 50, height: 8 }], HEIGHT, rect)).toBe(true);
    expect(rectIsClear([{ x: 60, y: 60, str: "TAX INVOICE", width: 100, height: 14 }], HEIGHT, rect)).toBe(true);
  });

  it("is not clear when printed text falls in it", () => {
    expect(rectIsClear([{ x: 100, y: HEIGHT - 50, str: "Bank details", width: 50, height: 8 }], HEIGHT, rect)).toBe(false);
  });

  it("text beside the area, not in it, leaves it clear", () => {
    expect(rectIsClear([{ x: 1, y: HEIGHT - 50, str: "x", width: 5, height: 8 }], HEIGHT, rect)).toBe(true);
  });
});

describe("stampCourierHandover", () => {
  const signaturePng = pngFromDataUrl(PNG_1PX)!;

  it("stamps the last page when the area is clear", async () => {
    const original = await invoice({ pages: 2 });
    const { pdf, appended } = await stampCourierHandover(original, { lines: LINES, signaturePng, area: DEFAULT_STAMP_AREA });
    expect(appended).toBe(false);
    const pages = await textOf(pdf);
    expect(pages).toHaveLength(2);
    expect(pages[1]).toContain("Collected by Sipho K from The Courier Guy");
    expect(pages[1]).toContain("TAX INVOICE IV-7001");
    expect(pages[0]).not.toContain("Collected by");
  });

  it("adds a page rather than print over the invoice", async () => {
    // Printed in the bottom band — where the default area sits.
    const original = await invoice({ footerTop: HEIGHT - 60 });
    const { pdf, appended } = await stampCourierHandover(original, { lines: LINES, signaturePng, area: DEFAULT_STAMP_AREA });
    expect(appended).toBe(true);
    const pages = await textOf(pdf);
    expect(pages).toHaveLength(2);
    expect(pages[0]).not.toContain("Collected by");
    expect(pages[1]).toContain("COURIER HANDOVER");
    expect(pages[1]).toContain("Dispatched by Thandi M from Signex Polokwane");
  });

  it("text above the area does not push the stamp off the page", async () => {
    const original = await invoice({ footerTop: 400 });
    const { appended } = await stampCourierHandover(original, { lines: LINES, signaturePng, area: DEFAULT_STAMP_AREA });
    expect(appended).toBe(false);
  });

  it("a name Helvetica cannot draw does not fail the stamp", async () => {
    const lines = { ...LINES, collected: "Collected by Sipho 🚚 K from Ŝkoda Couriers" };
    const { pdf } = await stampCourierHandover(await invoice(), { lines, signaturePng, area: DEFAULT_STAMP_AREA });
    expect((await textOf(pdf))[0]).toContain("Sipho K");
  });
});

describe("pngFromDataUrl", () => {
  it("reads a PNG data URL", () => {
    const png = pngFromDataUrl(PNG_1PX);
    expect(png?.[0]).toBe(0x89);
  });

  it("refuses anything that is not a PNG", () => {
    expect(pngFromDataUrl("")).toBeNull();
    expect(pngFromDataUrl("data:image/jpeg;base64,/9j/4AAQ")).toBeNull();
    // Labelled PNG, but the bytes are not one.
    expect(pngFromDataUrl(`data:image/png;base64,${Buffer.from("hello world").toString("base64")}`)).toBeNull();
    expect(pngFromDataUrl("data:image/png;base64,not base64!")).toBeNull();
  });
});

describe("readCollectInput", () => {
  const good = {
    dispatcherName: "  Thandi   M ",
    courierDriverName: "Sipho K",
    courierCompany: "The Courier Guy",
    checked: true,
    signature: PNG_1PX,
  };

  it("accepts a complete form, tidying whitespace", () => {
    const read = readCollectInput(good);
    expect(read).toEqual({ ok: true, input: { ...good, dispatcherName: "Thandi M" } });
  });

  it("lists every reason a form cannot be submitted", () => {
    const read = readCollectInput({ checked: "yes", dispatcherName: "", courierDriverName: " ", signature: "data:," });
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.errors).toEqual([
      "Tick that the parcels were checked.",
      "Enter the dispatcher's name.",
      "Enter the courier driver's name.",
      "Enter the courier company.",
      "The courier driver needs to sign.",
    ]);
  });

  it("refuses a name too long for the stamp, and a body that is not an object", () => {
    const long = readCollectInput({ ...good, courierCompany: "x".repeat(81) });
    expect(long.ok === false && long.errors).toEqual(["Courier company is too long."]);
    expect(readCollectInput(null).ok).toBe(false);
  });
});
