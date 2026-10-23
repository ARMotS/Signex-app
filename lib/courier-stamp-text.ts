/**
 * courier-stamp-text.ts
 * The words of the courier handover stamp, and where on the page it goes.
 *
 * No imports: the Collect & Sign screen previews the stamp with this very
 * code, so what the dispatcher reads before submitting is what is printed on
 * every invoice. The drawing is lib/courier-stamp.ts.
 */

/** Times on the stamp are South African, whatever the server's clock says. */
export const STAMP_TIME_ZONE = "Africa/Johannesburg";

/** "22/10/2026, 14:05" in Johannesburg time. */
export function formatStampTime(at: Date): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: STAMP_TIME_ZONE,
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value])
  );
  return `${parts.day}/${parts.month}/${parts.year}, ${parts.hour}:${parts.minute}`;
}

export interface StampInput {
  dispatcherName: string;
  dispatchCompany: string;
  courierDriverName: string;
  courierCompany: string;
  at: Date;
  courierSheetNo: string;
  waybillNo: string;
}

export interface StampLines {
  dispatched: string;
  collected: string;
  footer: string;
}

/** The three lines of the stamp, as the brief words them. */
export function courierStampLines(s: StampInput): StampLines {
  const when = formatStampTime(s.at);
  const name = (v: string) => v.trim() || "—";
  return {
    dispatched: `Dispatched by ${name(s.dispatcherName)} from ${name(s.dispatchCompany)} on ${when}`,
    collected: `Collected by ${name(s.courierDriverName)} from ${name(s.courierCompany)} on ${when}`,
    footer: `Courier trip sheet ${s.courierSheetNo} · Waybill ${s.waybillNo || "—"}`,
  };
}

// ─── Where it goes ────────────────────────────────────────────────────────

/**
 * The stamp's box on the invoice's last page, in percent of the page,
 * measured from the bottom-left corner (as the signature position is).
 */
export interface StampArea {
  xPercent: number;
  yPercent: number;
  widthPercent: number;
  heightPercent: number;
}

/** A band across the bottom margin. */
export const DEFAULT_STAMP_AREA: StampArea = { xPercent: 6, yPercent: 2, widthPercent: 88, heightPercent: 17 };

/**
 * A stamp area from settings, or null when it is not one: on the page, and
 * big enough for two lines, a signature and the footer (on an A4 page, 40%
 * wide by 12% high is about 240 × 100 points).
 */
export function readStampArea(raw: unknown): StampArea | null {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const num = (k: string) => (typeof v[k] === "number" ? (v[k] as number) : Number(v[k]));
  const area = {
    xPercent: num("xPercent"),
    yPercent: num("yPercent"),
    widthPercent: num("widthPercent"),
    heightPercent: num("heightPercent"),
  };
  const finite = Object.values(area).every((n) => Number.isFinite(n));
  if (!finite) return null;
  if (area.xPercent < 0 || area.yPercent < 0) return null;
  if (area.widthPercent < 40 || area.heightPercent < 12) return null;
  if (area.xPercent + area.widthPercent > 100 || area.yPercent + area.heightPercent > 100) return null;
  return area;
}
