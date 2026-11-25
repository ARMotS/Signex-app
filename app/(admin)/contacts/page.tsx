"use client";

import { useEffect, useState } from "react";
import { ContactImporter } from "@/components/admin/contacts/ContactImporter";
import { ContactsTable } from "@/components/admin/contacts/ContactsTable";
import CourierCompaniesPanel from "@/components/admin/contacts/CourierCompaniesPanel";

type Section = "customers" | "couriers";

const SECTIONS: { id: Section; label: string }[] = [
  { id: "customers", label: "Customers" },
  { id: "couriers", label: "Courier companies" },
];

/**
 * Customer contacts and the branch's courier companies, as two tabs. Separate
 * lists on purpose: customer emails find their recipient by company name, and
 * must never find a courier. The tab is kept in the URL (?tab=couriers) so a
 * refresh or a shared link reopens it.
 */
export default function ContactsPage() {
  const [refreshKey, setRefreshKey] = useState(0);
  const [section, setSection] = useState<Section>("customers");

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("tab") === "couriers") setSection("couriers");
  }, []);

  const choose = (next: Section) => {
    setSection(next);
    const url = new URL(window.location.href);
    if (next === "customers") url.searchParams.delete("tab");
    else url.searchParams.set("tab", next);
    window.history.replaceState(window.history.state, "", url.toString());
  };

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div>
        <h1 className="font-mono text-xl font-semibold text-zinc-900">Contacts</h1>
        <p className="text-sm text-zinc-500 mt-1">
          {section === "couriers"
            ? "The courier companies this branch hands parcels to."
            : "Customer and supplier contact details. Matched automatically to deliveries on trip sheet upload."}
        </p>
      </div>

      <div role="tablist" className="flex items-center border-b border-ink-border">
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            type="button"
            role="tab"
            aria-selected={section === s.id}
            onClick={() => choose(s.id)}
            className={`px-3 sm:px-5 py-3 font-mono text-[13px] sm:text-sm font-medium uppercase tracking-wide whitespace-nowrap border-b-2 -mb-px transition-colors ${
              section === s.id
                ? "border-ink-green text-ink-black"
                : "border-transparent text-ink-muted hover:text-ink-black"
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>

      {section === "couriers" ? (
        <CourierCompaniesPanel />
      ) : (
        <>
          <ContactImporter onImported={() => setRefreshKey((k) => k + 1)} />
          <ContactsTable key={refreshKey} />
        </>
      )}
    </div>
  );
}
