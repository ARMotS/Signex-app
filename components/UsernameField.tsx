"use client";

import { useEffect, useState } from "react";
import { normalizeUsername, validateUsername, USERNAME_HINT } from "@/lib/credentials";

export type UsernameStatus = "empty" | "invalid" | "checking" | "available" | "taken" | "unchanged";

interface UsernameFieldProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
  /** The account's current username when editing — not reported as taken. */
  currentUsername?: string | null;
  /** Lets the form disable its submit button until the name is usable. */
  onStatusChange?: (status: UsernameStatus) => void;
  className?: string;
  placeholder?: string;
  required?: boolean;
}

/**
 * Username input with live availability, as the user types.
 *
 * Format is checked locally with the same rules the server enforces
 * (lib/credentials.ts); availability is asked of the server after a short
 * pause. Both are advisory — the create/update routes check again, and the
 * database's primary key on LoginName is the final word.
 */
export default function UsernameField({
  id,
  value,
  onChange,
  currentUsername,
  onStatusChange,
  className = "",
  placeholder = "Choose a username",
  required,
}: UsernameFieldProps) {
  const normalized = normalizeUsername(value);
  const formatError = normalized ? validateUsername(normalized) : null;
  const unchanged = !!currentUsername && normalized === currentUsername;

  // The server's answer, remembered for the name it was given.
  const [checked, setChecked] = useState<{ name: string; available: boolean; error?: string } | null>(
    null
  );

  const needsServer = !!normalized && !formatError && !unchanged;

  useEffect(() => {
    if (!needsServer) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetch(`/api/auth/username-available?username=${encodeURIComponent(normalized)}`, {
        signal: controller.signal,
      })
        .then((r) => r.json())
        .then((data) =>
          setChecked({ name: normalized, available: !!data.available, error: data.error })
        )
        .catch(() => {});
    }, 350);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [normalized, needsServer]);

  let status: UsernameStatus;
  if (!normalized) status = "empty";
  else if (formatError) status = "invalid";
  else if (unchanged) status = "unchanged";
  else if (checked?.name !== normalized) status = "checking";
  else status = checked.available ? "available" : "taken";

  useEffect(() => {
    onStatusChange?.(status);
  }, [status, onStatusChange]);

  let message: { text: string; tone: "muted" | "good" | "bad" };
  switch (status) {
    case "invalid":
      message = { text: formatError!, tone: "bad" };
      break;
    case "checking":
      message = { text: "Checking…", tone: "muted" };
      break;
    case "available":
      message = { text: `“${normalized}” is available`, tone: "good" };
      break;
    case "taken":
      message = { text: checked?.error || "Username already taken", tone: "bad" };
      break;
    default:
      message = { text: USERNAME_HINT, tone: "muted" };
  }

  const toneClass =
    message.tone === "good" ? "text-ink-green" : message.tone === "bad" ? "text-ink-red" : "text-ink-muted";

  return (
    <div>
      <input
        id={id}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required={required}
        autoComplete="off"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        maxLength={40}
        aria-invalid={status === "invalid" || status === "taken"}
        aria-describedby={`${id}-status`}
        className={className}
        placeholder={placeholder}
      />
      <p id={`${id}-status`} aria-live="polite" className={`text-xs mt-1.5 ${toneClass}`}>
        {message.text}
      </p>
    </div>
  );
}
