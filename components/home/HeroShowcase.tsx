"use client";

import { useEffect, useRef, useState } from "react";
import { RunScreen, SignScreen, DashboardScreen } from "./AppScreens";

/**
 * The hero's showcase: one stage and three thumbnails — the driver's run, a
 * signature at the door, the office's dashboard.
 *
 * Advances every 6s, pauses while hovered or focused, and does not advance at
 * all for reduced-motion users. Thumbnails are real buttons.
 */

const STAGE_W = 460;
const STAGE_H = 345;
const THUMB_W = 104;

const SLIDES = [
  { key: "run", title: "Today's run", tag: "Driver app", render: () => <RunScreen /> },
  { key: "sign", title: "Signed at the door", tag: "Driver app", render: (live: boolean) => <SignScreen animate={live} /> },
  { key: "dash", title: "Office dashboard", tag: "Office", render: () => <DashboardScreen /> },
] as const;

/** The stage artwork at design size, centred on a frosted panel. */
function Stage({ index, live }: { index: number; live: boolean }) {
  return (
    <div className="sx-demo relative" style={{ width: STAGE_W, height: STAGE_H }}>
      {SLIDES.map((s, i) => (
        <div
          key={s.key}
          // Out first, then in: two different devices crossfading on top of
          // each other read as one garbled screen.
          className={`absolute inset-0 flex items-center justify-center pb-10 transition-opacity ${
            i === index ? "opacity-100 duration-300 delay-200" : "opacity-0 duration-200"
          }`}
        >
          {/* Phones are scaled to clear the caption chips along the bottom. */}
          <div className={s.key === "dash" ? undefined : "scale-[0.88]"}>{s.render(live && i === index)}</div>
        </div>
      ))}
    </div>
  );
}

export default function HeroShowcase() {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [scale, setScale] = useState(1);
  const frameRef = useRef<HTMLDivElement>(null);

  // Fit the fixed-size artwork to whatever width the column gives it.
  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setScale(entry.contentRect.width / STAGE_W));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(mq.matches);
    mq.addEventListener("change", update);
    const t = setTimeout(update, 0);
    return () => {
      clearTimeout(t);
      mq.removeEventListener("change", update);
    };
  }, []);

  useEffect(() => {
    if (paused || reducedMotion) return;
    const t = setTimeout(() => setIndex((i) => (i + 1) % SLIDES.length), 6000);
    return () => clearTimeout(t);
  }, [index, paused, reducedMotion]);

  const current = SLIDES[index];

  return (
    <div
      className="w-full max-w-[460px]"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      {/* Stage */}
      <div
        ref={frameRef}
        className="relative w-full rounded-2xl overflow-hidden border border-white/15 bg-gradient-to-br from-white/[0.14] to-white/[0.04] backdrop-blur-md shadow-[0_30px_60px_-20px_rgba(0,0,0,0.7)]"
        style={{ aspectRatio: `${STAGE_W} / ${STAGE_H}` }}
        aria-roledescription="carousel"
        aria-label="Signex screens"
      >
        <div className="absolute top-0 left-0 origin-top-left" style={{ transform: `scale(${scale})` }} aria-hidden="true">
          <Stage index={index} live={!reducedMotion} />
        </div>
        <div className="absolute inset-x-3 bottom-3 flex items-center justify-between pointer-events-none">
          <span className="rounded-md bg-black/60 backdrop-blur px-2.5 py-1 text-xs font-medium text-white" aria-live="polite">
            {current.title}
          </span>
          <span className="rounded-md bg-black/40 backdrop-blur px-2 py-1 text-[11px] text-white/80">{current.tag}</span>
        </div>
      </div>

      {/* Thumbnails */}
      <div className="mt-3 flex justify-end gap-2.5">
        {SLIDES.map((s, i) => (
          <button
            key={s.key}
            type="button"
            onClick={() => setIndex(i)}
            aria-label={`Show ${s.title}`}
            aria-current={i === index}
            className={`relative rounded-lg overflow-hidden border bg-white/[0.08] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink-green ${
              i === index ? "border-ink-green ring-1 ring-ink-green" : "border-white/15 opacity-70 hover:opacity-100"
            }`}
            style={{ width: THUMB_W, height: (THUMB_W * STAGE_H) / STAGE_W }}
          >
            <div className="absolute top-0 left-0 origin-top-left pointer-events-none" style={{ transform: `scale(${THUMB_W / STAGE_W})` }} aria-hidden="true">
              <Stage index={i} live={false} />
            </div>
          </button>
        ))}
      </div>
      <div className="mt-2.5 flex justify-end gap-1.5" aria-hidden="true">
        {SLIDES.map((s, i) => (
          <span key={s.key} className={`h-0.5 rounded-full transition-all ${i === index ? "w-6 bg-ink-green" : "w-3 bg-white/30"}`} />
        ))}
      </div>
    </div>
  );
}
