import Link from "next/link";

export default function Home() {
  return (
    <div className="min-h-dvh flex flex-col bg-ink-surface">
      {/* ─── Navigation ─────────────────────────────────────────────── */}
      <nav className="flex items-center justify-between px-6 py-4 md:px-10 border-b border-ink-border bg-ink-card">
        <Link href="/" className="flex items-center gap-2 hover:opacity-80 transition-opacity">
          <div className="w-8 h-8 bg-ink-black rounded flex items-center justify-center">
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#00C07F"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
            </svg>
          </div>
          <span className="font-mono text-lg font-medium tracking-tight text-ink-black">
            SIGNEX
          </span>
        </Link>
        <div className="flex items-center gap-3">
          <Link
            href="/login"
            className="px-4 py-2 text-sm font-mono text-ink-muted hover:text-ink-black transition-colors"
          >
            Admin Dashboard
          </Link>
          <Link
            href="/select"
            className="px-5 py-2.5 text-sm font-mono font-medium bg-ink-green text-white rounded hover:bg-ink-green-hover active:scale-[0.98] transition-all touch-target"
          >
            Driver App →
          </Link>
        </div>
      </nav>

      {/* ─── Hero ────────────────────────────────────────────────────── */}
      <main className="flex-1 flex flex-col items-center justify-center px-6 py-20 md:py-32">
        <div className="max-w-2xl mx-auto text-center animate-fade-in">
          {/* Version badge */}
          <div className="inline-flex items-center gap-2 px-3 py-1 mb-8 border border-ink-border rounded bg-ink-card">
            <span className="w-1.5 h-1.5 rounded-full bg-ink-green animate-pulse" />
            <span className="text-xs font-mono text-ink-muted tracking-wide uppercase">
              v0.1 — Active Development
            </span>
          </div>

          <h1 className="font-mono text-4xl md:text-5xl lg:text-6xl font-medium leading-tight tracking-tight text-ink-black">
            Paperless delivery
            <br />
            <span className="text-ink-green">signatures.</span>
          </h1>

          <p className="mt-6 text-lg md:text-xl text-ink-muted leading-relaxed max-w-lg mx-auto">
            Present invoices. Capture signatures. Save signed PDFs to your
            local folder — all from a single tablet in the field.
          </p>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-4 mt-10">
            <Link
              href="/select"
              className="w-full sm:w-auto px-8 py-3.5 font-mono text-sm font-medium bg-ink-black text-white rounded hover:bg-ink-black/90 active:scale-[0.98] transition-all touch-target"
            >
              Open Driver App
            </Link>
            <Link
              href="/login"
              className="w-full sm:w-auto px-8 py-3.5 font-mono text-sm font-medium border border-ink-border text-ink-black rounded hover:bg-ink-card hover:border-ink-muted-light active:scale-[0.98] transition-all touch-target"
            >
              Admin Dashboard
            </Link>
          </div>
        </div>

        {/* ─── Feature Cards ──────────────────────────────────────────── */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 max-w-3xl mx-auto mt-20 w-full stagger-children">
          <div className="bg-ink-card border border-ink-border rounded p-6 hover:border-ink-muted-light transition-colors">
            <div className="w-10 h-10 rounded bg-ink-green-dim flex items-center justify-center mb-4">
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="#00C07F"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
                <path d="M14 2v6h6" />
                <path d="M16 13H8" />
                <path d="M16 17H8" />
                <path d="M10 9H8" />
              </svg>
            </div>
            <h3 className="font-mono text-sm font-medium text-ink-black mb-1">
              PDF Invoices
            </h3>
            <p className="text-sm text-ink-muted leading-relaxed">
              Pull invoices from a local or shared network folder. Display them
              full-screen on any device.
            </p>
          </div>

          <div className="bg-ink-card border border-ink-border rounded p-6 hover:border-ink-muted-light transition-colors">
            <div className="w-10 h-10 rounded bg-ink-amber-dim flex items-center justify-center mb-4">
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="#F5A623"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
              </svg>
            </div>
            <h3 className="font-mono text-sm font-medium text-ink-black mb-1">
              Capture Signatures
            </h3>
            <p className="text-sm text-ink-muted leading-relaxed">
              Customers sign on-screen. The signature is embedded directly
              into the PDF document.
            </p>
          </div>

          <div className="bg-ink-card border border-ink-border rounded p-6 hover:border-ink-muted-light transition-colors">
            <div className="w-10 h-10 rounded bg-ink-red-dim flex items-center justify-center mb-4">
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="#E84040"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              </svg>
            </div>
            <h3 className="font-mono text-sm font-medium text-ink-black mb-1">
              Auto-Save Locally
            </h3>
            <p className="text-sm text-ink-muted leading-relaxed">
              Signed PDFs are automatically saved back to your local or shared
              network folder.
            </p>
          </div>
        </div>
      </main>

      {/* ─── Footer ──────────────────────────────────────────────────── */}
      <footer className="border-t border-ink-border px-6 py-4">
        <div className="max-w-3xl mx-auto flex items-center justify-between">
          <span className="text-xs font-mono text-ink-muted">
            SIGNEX © {new Date().getFullYear()}
          </span>
          <div className="flex items-center gap-4">
            <Link
              href="/login"
              className="text-xs font-mono text-ink-muted hover:text-ink-black transition-colors"
            >
              Admin
            </Link>
            <Link
              href="/select"
              className="text-xs font-mono text-ink-muted hover:text-ink-black transition-colors"
            >
              Driver
            </Link>
            <span className="badge-signed">
              <span className="w-1.5 h-1.5 rounded-full bg-ink-green" />
              System Online
            </span>
          </div>
        </div>
      </footer>
    </div>
  );
}
