"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/** The one thing the customer does: press Confirm received. */
export default function ConfirmReceived({
  token,
  confirmedAt: initial,
  expiresOn,
}: {
  token: string;
  confirmedAt: string | null;
  expiresOn: string;
}) {
  const [confirmedAt, setConfirmedAt] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  if (confirmedAt) {
    return (
      <div className="text-center space-y-1">
        <p className="text-ink-green font-medium">✓ Confirmed received</p>
        <p className="text-sm text-ink-muted">on {confirmedAt}. Thank you — there is nothing more to do.</p>
      </div>
    );
  }

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/public/delivery/${encodeURIComponent(token)}/confirm`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.confirmedAt) {
        setConfirmedAt(data.confirmedAt);
        // The heading above is the server's: re-render it as confirmed.
        router.refresh();
      }
      else if (res.status === 410) setError("This link has expired. Please let the sender know directly.");
      else setError(data.error || "That did not go through — please try again.");
    } catch {
      setError("No connection — please try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <button
        type="button"
        onClick={confirm}
        disabled={busy}
        className="w-full py-3.5 rounded-lg bg-ink-green text-white font-medium text-base hover:bg-ink-green-hover disabled:opacity-60 transition-colors"
      >
        {busy ? "Confirming…" : "Confirm received"}
      </button>
      {error && <p className="text-sm text-ink-red text-center">{error}</p>}
      <p className="text-xs text-ink-muted text-center">
        Press only once the parcels have arrived. This link works until {expiresOn}.
      </p>
    </div>
  );
}
