import { describe, it, expect } from "vitest";
import {
  EMPTY_FILTER,
  activeFilterCount,
  applyFilter,
  dateWindowOf,
  filterToParams,
  filterToRequestParams,
  pageOf,
  parseFilterState,
  resolvePreset,
  toCsv,
  type FilterAccessors,
  type FilterState,
} from "@/lib/record-filter";

interface Row {
  no: string;
  normalized: string;
  date: string | null;
  status: string;
  customer: string | null;
  driver?: string;
  flag?: boolean;
}

const acc: FilterAccessors<Row> = {
  search: (r) => [r.no, r.normalized, r.customer],
  date: (r) => r.date,
  status: (r) => r.status,
  customer: (r) => r.customer,
  driver: (r) => r.driver ?? null,
  flag: (r) => !!r.flag,
  number: (r) => r.no,
};

const rows: Row[] = [
  { no: "INV-2026-1047", normalized: "1047", date: "2026-10-12", status: "DELIVERED", customer: "Randburg SIM Depot", driver: "d1" },
  { no: "IV-130522", normalized: "130522", date: "2026-10-01", status: "AWAITING_CREDIT", customer: "VISA AUTO", driver: "d2", flag: true },
  { no: "IV-900101", normalized: "900101", date: null, status: "DELIVERED", customer: "Alpha Test", driver: "d1" },
];
const state = (over: Partial<FilterState> = {}): FilterState => ({ ...EMPTY_FILTER, ...over });
const nos = (r: Row[]) => r.map((x) => x.no);

describe("the quick search", () => {
  it("finds an invoice by its normalized number, and a customer by part of the name", () => {
    expect(nos(applyFilter(rows, state({ q: "1047" }), acc))).toEqual(["INV-2026-1047"]);
    expect(nos(applyFilter(rows, state({ q: "randb" }), acc))).toEqual(["INV-2026-1047"]);
  });
});

describe("the filters", () => {
  it("narrows by date range, status, customer, driver and the flag", () => {
    expect(nos(applyFilter(rows, state({ from: "2026-10-05", to: "2026-10-31" }), acc))).toEqual(["INV-2026-1047"]);
    expect(nos(applyFilter(rows, state({ status: ["AWAITING_CREDIT"] }), acc))).toEqual(["IV-130522"]);
    expect(nos(applyFilter(rows, state({ customer: "visa auto" }), acc))).toEqual(["IV-130522"]);
    expect(nos(applyFilter(rows, state({ driver: "d1" }), acc)).sort()).toEqual(["INV-2026-1047", "IV-900101"]);
    expect(nos(applyFilter(rows, state({ flag: true }), acc))).toEqual(["IV-130522"]);
  });

  it("resolves presets in the local calendar", () => {
    const now = new Date(2026, 9, 15); // Thursday 15 Oct 2026
    expect(resolvePreset("today", now)).toEqual({ from: "2026-10-15", to: "2026-10-15" });
    expect(resolvePreset("week", now)).toEqual({ from: "2026-10-12", to: "2026-10-15" });
    expect(resolvePreset("month", now)).toEqual({ from: "2026-10-01", to: "2026-10-15" });
    expect(resolvePreset("30d", now)).toEqual({ from: "2026-09-16", to: "2026-10-15" });
    expect(nos(applyFilter(rows, state({ preset: "week" }), acc, now))).toEqual(["INV-2026-1047"]);
  });
});

describe("the viewer's calendar", () => {
  it("reads a timestamp's day on the viewer's clock, and narrows by type", () => {
    const stamped = [{ ...rows[0], date: "2026-10-11T23:30:00.000Z" }];
    // 01:30 on the 12th in Johannesburg (UTC+2 → getTimezoneOffset -120).
    expect(applyFilter(stamped, state({ from: "2026-10-12", to: "2026-10-12" }), acc, new Date(), -120)).toHaveLength(1);
    expect(applyFilter(stamped, state({ from: "2026-10-12", to: "2026-10-12" }), acc, new Date(), 0)).toHaveLength(0);
    const typed: FilterAccessors<Row> = { ...acc, type: (r) => (r.flag ? "UPLIFT" : "CREDIT") };
    expect(nos(applyFilter(rows, state({ type: "UPLIFT" }), typed))).toEqual(["IV-130522"]);
  });

  it("sends a preset as the browser's own dates", () => {
    const p = filterToRequestParams(state({ preset: "today" }), new Date(2026, 9, 15, 9));
    expect(p.get("preset")).toBeNull();
    expect([p.get("from"), p.get("to")]).toEqual(["2026-10-15", "2026-10-15"]);
    expect(p.has("tzOffset")).toBe(true);
  });
});

describe("sorting and paging", () => {
  it("sorts newest first by default, undated rows last", () => {
    expect(nos(applyFilter(rows, state(), acc))).toEqual(["INV-2026-1047", "IV-130522", "IV-900101"]);
    expect(nos(applyFilter(rows, state({ sort: "customer" }), acc))[0]).toBe("IV-900101");
  });

  it("pages with an opaque cursor", () => {
    const many = Array.from({ length: 30 }, (_, i) => i);
    const first = pageOf(many, null);
    expect(first).toMatchObject({ total: 30, next: "25" });
    expect(first.items).toHaveLength(25);
    expect(pageOf(many, first.next)).toMatchObject({ items: [25, 26, 27, 28, 29], next: null });
  });

  it("pages by number: page n of size s starts at (n-1)*s", () => {
    const many = Array.from({ length: 120 }, (_, i) => i);
    expect(pageOf(many, String(2 * 50), 50).items).toEqual(many.slice(100, 120));
    expect(pageOf(many, "500", 25)).toMatchObject({ items: [], total: 120, next: null });
  });
});

describe("the database date window", () => {
  it("is empty with no range", () => {
    expect(dateWindowOf(state())).toEqual({});
  });

  it("is wider than the range on both sides, so no viewer's day is cut", () => {
    const w = dateWindowOf(state({ from: "2026-03-05", to: "2026-03-05" }));
    // The 5th in UTC+14 starts 10:00 on the 4th UTC; in UTC-12 it ends 12:00 on the 6th.
    expect(w.since!.getTime()).toBeLessThanOrEqual(Date.parse("2026-03-04T10:00:00Z"));
    expect(w.until!.getTime()).toBeGreaterThanOrEqual(Date.parse("2026-03-06T12:00:00Z"));
  });

  it("resolves a preset the same way the filter does", () => {
    const now = new Date(2026, 9, 15, 12);
    const w = dateWindowOf(state({ preset: "month" }), now);
    expect(w.since!.toISOString().slice(0, 10)).toBe("2026-09-30");
    expect(w.until).toBeDefined();
  });
});

describe("the URL", () => {
  it("round-trips, keeping only what differs from the defaults", () => {
    const s = state({ q: "1047", preset: "month", status: ["DELIVERED", "EXCEPTION"], flag: true, sort: "customer" });
    const params = filterToParams(s);
    expect(params.toString()).toBe("q=1047&preset=month&status=DELIVERED%2CEXCEPTION&flag=1&sort=customer");
    expect(parseFilterState(params)).toEqual(s);
    expect(filterToParams(EMPTY_FILTER).toString()).toBe("");
    expect(activeFilterCount(s)).toBe(3);
  });

  it("carries the status tab, which is not a filter to count", () => {
    const s = state({ tab: "completed" });
    expect(filterToParams(s).toString()).toBe("tab=completed");
    expect(parseFilterState(filterToParams(s)).tab).toBe("completed");
    expect(activeFilterCount(s)).toBe(0);
    expect(parseFilterState(new URLSearchParams("tab=nonsense")).tab).toBe("");
  });

  it("ignores anything malformed", () => {
    const parsed = parseFilterState(new URLSearchParams("from=yesterday&sort=drop&preset=decade"));
    expect(parsed).toEqual(EMPTY_FILTER);
  });
});

describe("toCsv", () => {
  it("guards formulas and quotes what needs it", () => {
    expect(toCsv(["A", "B"], [["=1+1", 'x,"y"']])).toBe('﻿A,B\r\n\'=1+1,"x,""y"""\r\n');
  });
});
