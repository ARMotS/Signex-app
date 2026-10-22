"use client";

/**
 * On an upload preview: which import template read the sheet, a way to read
 * it with another, and the values the template asks to be typed in (a driver
 * printed nowhere on the sheet, say). Changing either reads the sheet again.
 */

import { useState } from "react";
import type { TemplateRef, TemplateSummary } from "./types";

const BUILT_IN_ID = "builtin";

export default function ReadWithBar({
  template,
  templates,
  prompts,
  busy,
  onReread,
}: {
  template: TemplateRef | undefined;
  templates: TemplateSummary[];
  prompts: Record<string, string>;
  busy: boolean;
  onReread: (templateId: string, prompts: Record<string, string>) => void;
}) {
  // Reset by the parent's `key` when the sheet is read again.
  const [values, setValues] = useState(prompts);

  const asked = template?.prompts ?? [];
  // Nothing to say until the scope has a template: the page looks as it
  // always has for an office that never set one up.
  if (!template || (templates.length === 0 && template.id === BUILT_IN_ID && asked.length === 0)) return null;
  const changed = asked.some((p) => (values[p.key] ?? "") !== (prompts[p.key] ?? ""));

  return (
    <div className="mb-4 px-3 py-2.5 bg-ink-surface/50 border border-ink-border rounded space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-mono text-ink-muted uppercase tracking-wide">Read with</span>
        {templates.length > 0 ? (
          <select
            value={template.id}
            disabled={busy}
            onChange={(e) => onReread(e.target.value, {})}
            aria-label="Import template"
            className="px-2 py-1 text-xs font-mono bg-white border border-ink-border rounded focus:outline-none focus:border-ink-green"
          >
            <option value={BUILT_IN_ID}>Built-in trip sheet layout</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        ) : (
          <span className="font-mono text-ink-black">{template.name}</span>
        )}
        <a href="/settings" className="text-ink-muted hover:text-ink-black underline-offset-2 hover:underline ml-auto">
          Import templates
        </a>
      </div>

      {asked.length > 0 && (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (changed) onReread(template.id, values);
          }}
        >
          {asked.map((p) => (
            <label key={p.key} className="block">
              <span className="block text-[11px] font-mono text-ink-muted uppercase tracking-wide mb-1">{p.label}</span>
              <input
                type="text"
                value={values[p.key] ?? ""}
                onChange={(e) => setValues((v) => ({ ...v, [p.key]: e.target.value }))}
                placeholder="Not on this sheet — type it"
                className="w-48 px-2 py-1 text-sm font-mono bg-white border border-ink-border rounded focus:outline-none focus:border-ink-green"
              />
            </label>
          ))}
          <button type="submit" className="act act-green" disabled={busy || !changed}>
            Apply
          </button>
        </form>
      )}
    </div>
  );
}
