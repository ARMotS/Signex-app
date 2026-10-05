/**
 * Simplified Signex screens for the home page's showcase. Drawn at a fixed
 * design size (the stage is 460×345) and scaled by the caller, so the stage and
 * its thumbnails are the same drawing at two sizes.
 *
 * They echo the real screens — the driver's run sheet, signing at the door, the
 * office dashboard — without being screenshots, so they stay crisp and never go
 * stale against demo data. Everything here is decorative.
 */

const SIGNATURE_PATH =
  "M14 58 C 18 30, 26 14, 30 30 C 33 44, 27 62, 24 66 C 34 40, 42 24, 46 40 C 48 50, 46 60, 52 56 C 58 52, 60 38, 66 40 C 72 42, 66 58, 74 56 C 82 54, 84 40, 90 42 C 96 44, 92 58, 100 56 C 108 54, 112 44, 118 46 C 126 48, 122 60, 132 56 C 144 52, 150 42, 166 40";

function Phone({ children }: { children: React.ReactNode }) {
  return (
    <div className="w-[196px] h-[318px] rounded-[30px] bg-[#0F0F0F] p-[7px] shadow-[0_24px_48px_-16px_rgba(0,0,0,0.6)] ring-1 ring-white/10">
      <div className="relative w-full h-full rounded-[24px] overflow-hidden bg-ink-surface">
        <div className="absolute top-1.5 left-1/2 -translate-x-1/2 w-14 h-3.5 rounded-full bg-[#0F0F0F] z-10" />
        {children}
      </div>
    </div>
  );
}

function AppBar({ right }: { right: string }) {
  return (
    <div className="flex items-center justify-between px-3 pt-7 pb-2 bg-white border-b border-ink-border">
      <div className="flex items-center gap-1.5">
        <div className="w-4 h-4 rounded bg-ink-black flex items-center justify-center">
          <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="#00C07F" strokeWidth="3" strokeLinecap="round">
            <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
          </svg>
        </div>
        <span className="text-[9px] font-semibold text-ink-black">Signex</span>
      </div>
      <span className="text-[7px] font-medium text-ink-green bg-ink-green-dim rounded px-1.5 py-0.5">{right}</span>
    </div>
  );
}

const RUN = [
  { name: "Corner Café", inv: "INV-10482", done: true },
  { name: "Hill Street Deli", inv: "INV-10483", done: true },
  { name: "Riverside Grocer", inv: "INV-10487", done: true },
  { name: "Mill Lane Bakery", inv: "INV-10491", done: false },
  { name: "Harbour Kitchen", inv: "INV-10494", done: false },
];

export function RunScreen() {
  return (
    <Phone>
      <AppBar right="Driver" />
      <div className="p-2.5 space-y-2">
        <div className="bg-white rounded-lg border border-ink-border p-2.5">
          <div className="flex justify-between items-baseline">
            <span className="text-[10px] font-semibold text-ink-black">Today&apos;s run</span>
            <span className="text-[10px] font-semibold text-ink-green tabular-nums">3/5</span>
          </div>
          <div className="mt-1.5 h-1 rounded-full bg-ink-surface overflow-hidden">
            <div className="h-full w-3/5 bg-ink-green rounded-full" />
          </div>
        </div>
        {RUN.map((s, i) => (
          <div key={s.inv} className="bg-white rounded-lg border border-ink-border px-2.5 py-2 flex items-center gap-2">
            <span className="w-4 h-4 rounded bg-ink-surface text-[8px] text-ink-muted flex items-center justify-center tabular-nums">
              {i + 1}
            </span>
            <div className="flex-1 min-w-0">
              <p className="text-[9px] font-medium text-ink-black truncate">{s.name}</p>
              <p className="text-[7.5px] text-ink-muted tabular-nums">{s.inv}</p>
            </div>
            <span
              className={`text-[7px] font-semibold rounded px-1.5 py-0.5 ${
                s.done ? "bg-ink-green-dim text-ink-green" : "bg-ink-amber-dim text-ink-amber"
              }`}
            >
              {s.done ? "Signed" : "Next"}
            </span>
          </div>
        ))}
      </div>
    </Phone>
  );
}

export function SignScreen({ animate = false }: { animate?: boolean }) {
  return (
    <Phone>
      <AppBar right="Driver" />
      <div className="px-2.5 pt-2">
        <p className="text-[10px] font-semibold text-ink-black">Mill Lane Bakery</p>
        <p className="text-[7.5px] text-ink-muted tabular-nums">INV-10491</p>
        <div className="mt-2 bg-white rounded-md border border-ink-border p-2 space-y-1">
          {["Sourdough loaf × 24", "Rye bread × 12", "Crates, returnable × 3"].map((l) => (
            <div key={l} className="flex justify-between text-[7.5px] text-ink-black border-b border-ink-border last:border-0 pb-1 last:pb-0">
              <span>{l.split(" × ")[0]}</span>
              <span className="text-ink-muted tabular-nums">× {l.split(" × ")[1]}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="absolute inset-x-0 bottom-0 bg-white border-t border-ink-border px-2.5 pt-2 pb-3">
        <p className="text-[7px] font-medium text-ink-muted mb-1">Customer signature</p>
        <div className="relative h-[62px] rounded-md border border-dashed border-ink-muted-light bg-ink-surface">
          <svg className="absolute inset-0 w-full h-full" viewBox="4 4 176 80" fill="none" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
            <path
              className={animate ? "sx-sig sx-sig-1" : undefined}
              pathLength={1}
              d={SIGNATURE_PATH}
              stroke="#1F3A6E"
              strokeWidth={2.6}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
        <div className="mt-2 rounded-md bg-ink-green text-white text-[9px] font-semibold text-center py-1.5">
          Confirm &amp; save
        </div>
      </div>
    </Phone>
  );
}

const FEED = [
  ["07:42", "Corner Café", "Thabo M."],
  ["07:58", "Hill Street Deli", "Thabo M."],
  ["08:05", "Station Road Spar", "Anika P."],
  ["08:11", "Riverside Grocer", "Thabo M."],
];

export function DashboardScreen() {
  return (
    <div className="w-[392px] h-[262px] rounded-xl bg-white overflow-hidden shadow-[0_24px_48px_-16px_rgba(0,0,0,0.6)] ring-1 ring-white/10 flex flex-col">
      {/* Browser chrome */}
      <div className="h-6 bg-[#EDEBE6] flex items-center gap-1 px-2.5 shrink-0">
        <span className="w-1.5 h-1.5 rounded-full bg-[#E8404066]" />
        <span className="w-1.5 h-1.5 rounded-full bg-[#F5A62366]" />
        <span className="w-1.5 h-1.5 rounded-full bg-[#00C07F66]" />
        <span className="ml-3 h-3.5 w-36 rounded bg-white/80 text-[6.5px] text-ink-muted flex items-center px-1.5">
          signex-app.vercel.app/dashboard
        </span>
      </div>
      <div className="flex flex-1 min-h-0">
        <div className="w-[62px] bg-[#0F0F0F] p-2 space-y-1.5 shrink-0">
          <div className="flex items-center gap-1 mb-2.5">
            <div className="w-3 h-3 rounded-sm bg-white/10" />
            <span className="text-[7px] font-semibold text-white">Signex</span>
          </div>
          {["Dashboard", "Drivers", "Trip Sheet", "Invoices"].map((n, i) => (
            <div key={n} className={`text-[6.5px] rounded px-1 py-0.5 ${i === 0 ? "bg-white/10 text-white" : "text-white/50"}`}>
              {n}
            </div>
          ))}
        </div>
        <div className="flex-1 bg-ink-surface p-2.5 min-w-0">
          <p className="text-[10px] font-semibold text-ink-black">Dashboard</p>
          <div className="mt-2 grid grid-cols-3 gap-1.5">
            {[
              ["Stops today", "48", "text-ink-black"],
              ["Signed", "41", "text-ink-green"],
              ["Still out", "7", "text-ink-amber"],
            ].map(([label, value, tone]) => (
              <div key={label} className="bg-white rounded-md border border-ink-border p-1.5">
                <p className="text-[6.5px] text-ink-muted">{label}</p>
                <p className={`text-[13px] font-semibold tabular-nums ${tone}`}>{value}</p>
              </div>
            ))}
          </div>
          <div className="mt-2 bg-white rounded-md border border-ink-border">
            <div className="flex items-center justify-between px-2 py-1 border-b border-ink-border">
              <span className="text-[7px] font-semibold text-ink-black">Signed just now</span>
              <span className="flex items-center gap-1 text-[6px] text-ink-green">
                <span className="w-1 h-1 rounded-full bg-ink-green" /> Live
              </span>
            </div>
            {FEED.map(([t, c, d]) => (
              <div key={c} className="flex items-center gap-2 px-2 py-[3px] border-b border-ink-border last:border-0 text-[6.5px]">
                <span className="text-ink-muted tabular-nums w-5">{t}</span>
                <span className="flex-1 text-ink-black truncate">{c}</span>
                <span className="text-ink-muted">{d}</span>
                <span className="text-ink-green font-semibold">Signed</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
