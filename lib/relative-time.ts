/**
 * "Just now", "4 min ago", "3 h ago", "Yesterday 14:05", "12 Oct 2026" — a
 * moment read on the viewer's clock. No imports: used by browser pages.
 */
export function relativeTime(iso: string | null, empty = "Never", now = Date.now()): string {
  if (!iso) return empty;
  const at = new Date(iso);
  const mins = Math.floor((now - at.getTime()) / 60_000);
  if (mins < 2) return "Just now";
  if (mins < 60) return `${mins} min ago`;
  if (mins < 24 * 60) return `${Math.floor(mins / 60)} h ago`;
  const time = at.toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit" });
  if (mins < 48 * 60) return `Yesterday ${time}`;
  return at.toLocaleDateString("en-ZA", { day: "numeric", month: "short", year: "numeric" });
}
