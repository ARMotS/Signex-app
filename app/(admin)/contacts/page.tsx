"use client";

import { useState } from "react";
import { ContactImporter } from "@/components/admin/contacts/ContactImporter";
import { ContactsTable } from "@/components/admin/contacts/ContactsTable";

export default function ContactsPage() {
  const [refreshKey, setRefreshKey] = useState(0);

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div>
        <h1 className="font-mono text-xl font-semibold text-zinc-900">Contacts</h1>
        <p className="text-sm text-zinc-500 mt-1">
          Customer and supplier contact details. Matched automatically to deliveries on trip sheet upload.
        </p>
      </div>
      <ContactImporter onImported={() => setRefreshKey((k) => k + 1)} />
      <ContactsTable key={refreshKey} />
    </div>
  );
}
