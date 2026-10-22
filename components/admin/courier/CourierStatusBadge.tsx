import { StatusBadge, type Tone } from "@/components/ui/Chips";

/** A courier trip sheet's status, as every courier screen shows it. */

export type CourierStatus = "NEEDS_ATTENTION" | "AWAITING_COLLECTION" | "COLLECTED" | "DELIVERED";

export const COURIER_STATUS: Record<CourierStatus, { label: string; tone: Tone }> = {
  NEEDS_ATTENTION: { label: "Needs attention", tone: "amber" },
  AWAITING_COLLECTION: { label: "Awaiting collection", tone: "blue" },
  COLLECTED: { label: "Collected", tone: "violet" },
  DELIVERED: { label: "Delivered", tone: "green" },
};

export const COURIER_STATUS_ORDER: CourierStatus[] = [
  "NEEDS_ATTENTION",
  "AWAITING_COLLECTION",
  "COLLECTED",
  "DELIVERED",
];

export default function CourierStatusBadge({ status }: { status: CourierStatus }) {
  const s = COURIER_STATUS[status];
  return (
    <StatusBadge tone={s.tone} dot>
      {s.label}
    </StatusBadge>
  );
}

/** "Mon 22 Oct 2026" from YYYY-MM-DD, without a timezone shift. */
export function formatSheetDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-ZA", {
    timeZone: "UTC",
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}
