import Image from "next/image";
import Link from "next/link";
import HeroShowcase from "@/components/home/HeroShowcase";
import HeaderSignIn from "@/components/home/HeaderSignIn";
import depotAerial from "@/public/home/depot-aerial.jpg";
import doorstepHandover from "@/public/home/doorstep-handover.jpg";

/**
 * Home: what Signex does, with one way in — the Log in button in the header
 * (or "Open Signex" for someone already signed in). Signing in itself happens
 * at /login, the same screen for every role.
 *
 * Photos are self-hosted (public/home) so the page never depends on a third
 * party being up; both are free under the Unsplash License and credited in the
 * footer.
 */

function Mark({ size = 36 }: { size?: number }) {
  return (
    <div
      className="rounded-lg bg-ink-green flex items-center justify-center shrink-0"
      style={{ width: size, height: size }}
    >
      <svg width={size / 2} height={size / 2} viewBox="0 0 24 24" fill="none" stroke="#0F0F0F" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
      </svg>
    </div>
  );
}

const NAV = [
  { href: "#how-it-works", label: "How it works" },
  { href: "#drivers", label: "Drivers" },
  { href: "#office", label: "Office" },
];

const STATS = [
  { value: "One login", label: "for drivers and the office" },
  { value: "Signed PDF", label: "saved back to your folder" },
  { value: "Live", label: "the office sees each signature land" },
];

const STEPS = [
  {
    title: "Load the day's trip sheet",
    body: "Upload the CSV or Excel sheet, or pick it from OneDrive. Every stop is matched to its driver and to its invoice PDF.",
  },
  {
    title: "Sign at the door",
    body: "The driver opens the invoice on their phone and the customer signs on the screen. Returns and uplifts are signed for at the same stop.",
  },
  {
    title: "Filed and sent",
    body: "The signed PDF goes back to your folder and the customer gets a copy by email. The dashboard updates as it happens.",
  },
];

const FOR_DRIVERS = [
  "Every stop on one run sheet, in order",
  "The invoice opens full-screen; the customer signs with a finger",
  "Collections recorded at the same visit",
  "Installs from the browser — nothing to download from an app store",
];

const FOR_OFFICE = [
  "Trip sheets from a file or straight from OneDrive",
  "Signatures arrive on the dashboard as drivers collect them",
  "Any confirmation that didn't send waits in one queue",
  "Each company's drivers, customers and paperwork kept apart",
];

function Tick() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#00C07F" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 mt-0.5" aria-hidden="true">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

export default function Home() {
  return (
    <div className="bg-[#0F0F0F] text-white">
      {/* ─── Hero ─────────────────────────────────────────────────────── */}
      <section className="relative min-h-dvh flex flex-col overflow-hidden">
        <Image
          src={depotAerial}
          alt=""
          fill
          priority
          placeholder="blur"
          sizes="100vw"
          className="object-cover"
        />
        {/* Heaviest behind the text, lighter where the showcase floats. */}
        <div className="absolute inset-0 bg-gradient-to-r from-[#0F0F0F]/95 via-[#0F0F0F]/70 to-[#0F0F0F]/15" />
        <div className="absolute inset-0 bg-gradient-to-t from-[#0F0F0F] via-transparent to-[#0F0F0F]/60" />

        <header className="relative z-10">
          <div className="mx-auto max-w-7xl px-4 sm:px-8 h-20 flex items-center justify-between gap-6">
            <Link href="/" className="flex items-center gap-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink-green rounded-lg">
              <Mark />
              <span className="leading-none">
                <span className="block text-xl font-semibold tracking-tight">Signex</span>
                <span className="block text-[11px] text-white/55 mt-1">Proof of delivery</span>
              </span>
            </Link>
            <div className="flex items-center gap-8">
              <nav className="hidden md:flex items-center gap-7" aria-label="Sections">
                {NAV.map((n) => (
                  <a key={n.href} href={n.href} className="text-sm font-medium text-white/80 hover:text-white transition-colors">
                    {n.label}
                  </a>
                ))}
              </nav>
              <HeaderSignIn />
            </div>
          </div>
        </header>

        <div className="relative z-10 flex-1 flex items-center">
          <div className="mx-auto max-w-7xl w-full px-4 sm:px-8 py-12 lg:py-16 grid gap-14 lg:grid-cols-[minmax(0,1fr)_460px] lg:items-center">
            <div className="max-w-xl">
              <div className="flex flex-wrap gap-2">
                <span className="inline-flex items-center gap-1.5 rounded-md border border-ink-green/40 bg-ink-green/10 px-2.5 py-1 text-xs font-medium text-ink-green">
                  <span className="w-1.5 h-1.5 rounded-full bg-ink-green" /> Paperless delivery signatures
                </span>
                <span className="inline-flex items-center rounded-md border border-white/15 bg-white/5 px-2.5 py-1 text-xs font-medium text-white/70">
                  Runs in any phone browser
                </span>
              </div>

              <h1 className="mt-6 text-[2.6rem] leading-[1.05] sm:text-6xl lg:text-[4.25rem] font-semibold tracking-[-0.035em] text-balance">
                Proof of delivery, signed at the door.
              </h1>
              <p className="mt-6 text-base sm:text-lg leading-relaxed text-white/70 max-w-lg">
                Drivers capture the customer&apos;s signature on the invoice itself. The signed
                copy files itself, the customer gets theirs by email, and the office watches it
                happen.
              </p>

              <dl className="mt-10 grid grid-cols-3 gap-4 sm:gap-8 max-w-lg">
                {STATS.map((s) => (
                  <div key={s.value}>
                    <dt className="text-lg sm:text-2xl font-semibold tracking-tight">{s.value}</dt>
                    <dd className="mt-1 text-xs sm:text-[13px] leading-snug text-white/55">{s.label}</dd>
                  </div>
                ))}
              </dl>

              <div className="mt-10 flex flex-wrap gap-3">
                <Link
                  href="/login"
                  className="inline-flex items-center rounded-lg bg-ink-green px-6 py-3.5 text-sm font-semibold text-[#0F0F0F] hover:bg-[#1fd896] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-[#0F0F0F]"
                >
                  Log in
                </Link>
                <a
                  href="#how-it-works"
                  className="inline-flex items-center rounded-lg border border-white/25 px-6 py-3.5 text-sm font-semibold text-white hover:bg-white/10 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink-green"
                >
                  See how it works
                </a>
              </div>
            </div>

            <div className="flex justify-center lg:justify-end">
              <HeroShowcase />
            </div>
          </div>
        </div>
      </section>

      {/* ─── How it works ─────────────────────────────────────────────── */}
      <section id="how-it-works" className="bg-ink-surface text-ink-black scroll-mt-4">
        <div className="mx-auto max-w-7xl px-4 sm:px-8 py-20 sm:py-28">
          <h2 className="text-3xl sm:text-4xl font-semibold tracking-[-0.025em] max-w-xl">
            From trip sheet to signed invoice, without the paper.
          </h2>
          <ol className="mt-14 grid gap-10 md:grid-cols-3 md:gap-8">
            {STEPS.map((s, i) => (
              <li key={s.title} className="border-t-2 border-ink-black pt-6">
                <span className="text-sm font-semibold text-ink-green tabular-nums">Step {i + 1}</span>
                <h3 className="mt-2 text-xl font-semibold tracking-tight">{s.title}</h3>
                <p className="mt-3 text-[15px] leading-relaxed text-ink-muted max-w-sm">{s.body}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* ─── Drivers & office ─────────────────────────────────────────── */}
      <section className="bg-white text-ink-black">
        <div className="mx-auto max-w-7xl px-4 sm:px-8 py-20 sm:py-28 grid gap-12 lg:grid-cols-2 lg:gap-20 items-center">
          <div className="relative aspect-[4/5] max-h-[620px] w-full rounded-2xl overflow-hidden">
            <Image
              src={doorstepHandover}
              alt="A driver hands a parcel to a customer at the door"
              fill
              placeholder="blur"
              sizes="(min-width: 1024px) 50vw, 100vw"
              className="object-cover"
            />
          </div>
          <div>
            <h2 className="text-3xl sm:text-4xl font-semibold tracking-[-0.025em]">
              Built for both ends of the delivery.
            </h2>
            <div id="drivers" className="mt-10 scroll-mt-8">
              <h3 className="text-lg font-semibold">For drivers</h3>
              <ul className="mt-4 space-y-3">
                {FOR_DRIVERS.map((t) => (
                  <li key={t} className="flex gap-3 text-[15px] leading-relaxed text-ink-muted">
                    <Tick />
                    <span>{t}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div id="office" className="mt-10 scroll-mt-8">
              <h3 className="text-lg font-semibold">For the office</h3>
              <ul className="mt-4 space-y-3">
                {FOR_OFFICE.map((t) => (
                  <li key={t} className="flex gap-3 text-[15px] leading-relaxed text-ink-muted">
                    <Tick />
                    <span>{t}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* ─── Closing ──────────────────────────────────────────────────── */}
      <section className="mx-auto max-w-7xl px-4 sm:px-8 py-20 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-6">
        <div>
          <h2 className="text-2xl sm:text-3xl font-semibold tracking-tight">Ready for today&apos;s run?</h2>
          <p className="mt-2 text-white/60">Log in with the username and password your office gave you.</p>
        </div>
        <HeaderSignIn className="self-start sm:self-auto px-6 py-3.5" />
      </section>

      <footer className="border-t border-white/10">
        <div className="mx-auto max-w-7xl px-4 sm:px-8 py-8 flex flex-col sm:flex-row gap-4 sm:items-center sm:justify-between text-sm text-white/50">
          <div className="flex items-center gap-2.5">
            <Mark size={24} />
            <span>Signex © {new Date().getFullYear()}</span>
          </div>
          <p className="text-xs">
            Photos by{" "}
            <a href="https://unsplash.com/photos/kGoPcmpPT7c" className="underline hover:text-white" rel="noreferrer" target="_blank">
              Marcin Jozwiak
            </a>{" "}
            and{" "}
            <a href="https://unsplash.com/photos/BFdSCxmqvYc" className="underline hover:text-white" rel="noreferrer" target="_blank">
              RoseBox
            </a>{" "}
            on Unsplash
          </p>
        </div>
      </footer>
    </div>
  );
}
