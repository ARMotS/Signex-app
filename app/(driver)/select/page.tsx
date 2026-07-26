/**
 * Bare /select — reached by a driver who doesn't have their company's link.
 *
 * Deliberately lists nothing. There is no public directory of operators: knowing
 * a company exists, and which drivers work for it, requires already holding that
 * ADMIN's sign-in link. Each ADMIN copies theirs from the Drivers page.
 */
export default function DriverSelectLandingPage() {
  return (
    <div className="flex-1 flex flex-col items-center justify-center text-center px-6 py-10">
      <div className="text-4xl mb-4">🔗</div>
      <h1 className="font-mono text-lg font-medium text-ink-black mb-2">
        You need your company&apos;s sign-in link
      </h1>
      <p className="text-sm text-ink-muted max-w-sm mb-6">
        Drivers sign in through a link that&apos;s specific to their company. Ask
        your dispatcher to send you yours, then open it on this device — it will
        look like:
      </p>
      <code className="font-mono text-xs text-ink-black bg-ink-surface border border-ink-border rounded px-3 py-2">
        /select/your-company
      </code>
      <p className="text-xs text-ink-muted mt-6 max-w-sm">
        Bookmark it once you have it and you can go straight there each day.
      </p>
    </div>
  );
}
