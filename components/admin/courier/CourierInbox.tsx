"use client";

/**
 * The courier folder on the Courier tab: which folder Signex watches, when it
 * last looked, "Check folder", and the files it could not import — each with
 * its reason, and the template wizard for a layout it does not know.
 * See lib/courier-inbox.ts.
 */

import { useState } from "react";
import Link from "next/link";
import MappingWizard from "@/components/admin/import-mapping/MappingWizard";

export interface InboxState {
  connected: boolean;
  folderPath: string | null;
  checkedAt: string | null;
  error: string | null;
  failures: { itemId: string; fileName: string; code: string; error: string; updatedAt: string }[];
}

const TEMPLATE_CODES = new Set(["NEEDS_TEMPLATE", "MISSING_COLUMNS"]);

function ago(iso: string | null): string {
  if (!iso) return "not yet";
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} h ago` : new Date(iso).toLocaleDateString("en-ZA", { day: "numeric", month: "short" });
}

export default function CourierInbox({
  inbox,
  onChanged,
}: {
  inbox: InboxState;
  /** The folder was looked at: reload the list and this state. */
  onChanged: () => void;
}) {
  const [checking, setChecking] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [wizard, setWizard] = useState<{ file: File } | null>(null);
  const [opening, setOpening] = useState<string | null>(null);

  const check = async () => {
    setChecking(true);
    setNote(null);
    try {
      const res = await fetch("/api/courier/inbox", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "check" }),
      });
      const data = await res.json();
      const r = data.result as { outcome: string; imported?: number; failed?: number; error?: string };
      if (!res.ok || r?.outcome === "error") {
        setNote({ ok: false, text: r?.error || data.error || "Could not look in the folder" });
      } else if (r.outcome === "not_configured") {
        setNote({ ok: false, text: "No courier trip sheets folder yet — set one in Settings → OneDrive." });
      } else if (r.outcome === "throttled") {
        setNote({ ok: true, text: "Just looked — try again in a few seconds." });
      } else {
        const parts = [
          r.imported ? `${r.imported} imported` : "",
          r.failed ? `${r.failed} could not be imported` : "",
        ].filter(Boolean);
        setNote({ ok: !r.failed, text: parts.length ? parts.join(", ") : "Nothing new in the folder" });
      }
      onChanged();
    } catch {
      setNote({ ok: false, text: "Failed to connect to server" });
    } finally {
      setChecking(false);
    }
  };

  /** The failed file, fetched into the browser so the wizard can read it. */
  const setUpTemplate = async (itemId: string, fileName: string) => {
    setOpening(itemId);
    try {
      const res = await fetch(`/api/courier/inbox/${encodeURIComponent(itemId)}`);
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error);
      const blob = await res.blob();
      setWizard({ file: new File([blob], fileName, { type: blob.type }) });
    } catch (err) {
      setNote({ ok: false, text: err instanceof Error && err.message ? err.message : "Could not open the file" });
    } finally {
      setOpening(null);
    }
  };

  if (!inbox.connected) return null;

  return (
    <div className="mb-6 space-y-3">
      <div className="flex flex-wrap items-center gap-3 px-4 py-3 bg-ink-card border border-ink-border rounded">
        <div className="min-w-0 flex-1">
          <p className="text-sm text-ink-black">
            {inbox.folderPath ? (
              <>
                Watching <span className="font-mono break-all">{inbox.folderPath}</span>
              </>
            ) : (
              <>
                No courier trip sheets folder yet —{" "}
                <Link href="/settings" className="underline">
                  set one in Settings
                </Link>
                , or it is made beside the Trip Sheet folder on the first import.
              </>
            )}
          </p>
          <p className="text-xs text-ink-muted mt-0.5">
            Sheets the Trip application saves there are imported here automatically · checked {ago(inbox.checkedAt)}
          </p>
          {inbox.error && <p className="text-xs text-ink-red mt-1 break-words">Last look failed: {inbox.error}</p>}
        </div>
        <button type="button" className="act" onClick={check} disabled={checking}>
          {checking ? "Checking…" : "Check folder"}
        </button>
      </div>

      {note && (
        <p className={`text-sm font-mono ${note.ok ? "text-ink-green" : "text-ink-red"}`}>
          {note.ok ? "✓" : "✕"} {note.text}
        </p>
      )}

      {inbox.failures.length > 0 && (
        <div className="bg-ink-card border border-ink-amber/40 rounded overflow-hidden">
          <h2 className="px-4 py-3 border-b border-ink-border font-mono text-sm font-medium text-ink-black uppercase tracking-wide">
            Couldn&apos;t import from the folder ({inbox.failures.length})
          </h2>
          <ul className="divide-y divide-ink-border">
            {inbox.failures.map((f) => (
              <li key={f.itemId} className="px-4 py-3 flex flex-wrap items-center gap-3">
                <div className="min-w-[14rem] flex-1">
                  <p className="text-sm font-mono text-ink-black break-all">{f.fileName}</p>
                  <p className="text-xs mt-0.5 break-words" style={{ color: "var(--tone-amber-fg)" }}>
                    {f.error}
                  </p>
                </div>
                {TEMPLATE_CODES.has(f.code) && (
                  <button
                    type="button"
                    className="act act-primary"
                    disabled={opening !== null}
                    onClick={() => setUpTemplate(f.itemId, f.fileName)}
                  >
                    {opening === f.itemId ? "Opening…" : "Set up a template from this file"}
                  </button>
                )}
              </li>
            ))}
          </ul>
          <p className="px-4 py-2 text-xs text-ink-muted border-t border-ink-border">
            Fix the file in the folder (or set up a template) and it is picked up on the next look; a file deleted from
            the folder drops off this list.
          </p>
        </div>
      )}

      {wizard && (
        <MappingWizard
          sheetType="COURIER_TRIP_SHEET"
          file={wizard.file}
          onClose={() => setWizard(null)}
          onSaved={() => {
            setWizard(null);
            // Saved: read the folder again now rather than waiting for the next look.
            void check();
          }}
        />
      )}
    </div>
  );
}
