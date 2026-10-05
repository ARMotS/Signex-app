/**
 * The hero's one moving part: an invoice being signed at the door.
 *
 * Pure CSS on one 9-second loop (keyframes `sx-*` in globals.css): the
 * "Sign here" hint fades, the signature writes itself in pen, then the signed
 * line and the Delivered badge appear, hold, and reset. With reduced motion the
 * finished, signed invoice is shown still.
 *
 * Decorative — the sign-in form is the page's job — so it is hidden from
 * assistive technology.
 */
export default function SigningDemo({ className = "" }: { className?: string }) {
  return (
    <div className={`sx-demo relative ${className}`} aria-hidden="true">
      <div className="relative bg-white rounded-md px-6 pt-5 pb-6 sm:px-7 sm:pt-6 shadow-[0_1px_2px_rgba(15,15,15,0.06),0_18px_40px_-12px_rgba(15,15,15,0.22)]">
        {/* Invoice head */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-[15px] font-semibold text-ink-black leading-tight">Corner Café</p>
            <p className="text-xs text-ink-muted mt-0.5">14 Mill Street</p>
          </div>
          <div className="text-right">
            <p className="text-xs text-ink-muted">Invoice</p>
            <p className="text-sm font-medium text-ink-black tabular-nums">INV-10482</p>
          </div>
        </div>

        {/* Lines */}
        <div className="mt-5 border-t border-ink-border">
          {[
            ["Sourdough loaf", "24"],
            ["Rye bread", "12"],
            ["Bread crates, returnable", "3"],
          ].map(([item, qty]) => (
            <div
              key={item}
              className="flex justify-between py-2 border-b border-ink-border text-[13px] text-ink-black"
            >
              <span>{item}</span>
              <span className="tabular-nums text-ink-muted">× {qty}</span>
            </div>
          ))}
        </div>

        {/* Signature box */}
        <div className="relative mt-4 h-[116px]">
          <span className="sx-hint absolute left-0 bottom-3 text-xs text-ink-muted-light">
            Sign here
          </span>
          <svg
            className="absolute inset-x-0 bottom-2 w-full h-[108px]"
            viewBox="6 6 184 78"
            fill="none"
            preserveAspectRatio="xMinYMax meet"
          >
            <path
              className="sx-sig sx-sig-1"
              pathLength={1}
              d="M14 58 C 18 30, 26 14, 30 30 C 33 44, 27 62, 24 66 C 34 40, 42 24, 46 40 C 48 50, 46 60, 52 56 C 58 52, 60 38, 66 40 C 72 42, 66 58, 74 56 C 82 54, 84 40, 90 42 C 96 44, 92 58, 100 56 C 108 54, 112 44, 118 46 C 126 48, 122 60, 132 56 C 144 52, 150 42, 166 40"
              stroke="#1F3A6E"
              strokeWidth={2.4}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              className="sx-sig sx-sig-2"
              pathLength={1}
              d="M28 72 C 70 66, 120 68, 180 60"
              stroke="#1F3A6E"
              strokeWidth={1.8}
              strokeLinecap="round"
            />
          </svg>
          <div className="absolute inset-x-0 bottom-2 border-b border-dashed border-ink-muted-light" />
        </div>

        {/* What signing produces */}
        <div className="mt-3 flex items-center justify-between gap-3 min-h-[28px]">
          <p className="sx-meta text-xs text-ink-muted">Signed by M. Naidoo, 07:42</p>
          <span className="sx-badge inline-flex items-center gap-1.5 rounded-full bg-ink-green px-3 py-1 text-xs font-semibold text-white">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 6 9 17l-5-5" />
            </svg>
            Delivered
          </span>
        </div>
      </div>
    </div>
  );
}
