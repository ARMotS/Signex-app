import type { Metadata } from "next";
import { readDelivery } from "@/lib/courier-confirm";
import ConfirmReceived from "./ConfirmReceived";

/**
 * The customer's link from the courier email (lib/courier-confirm.ts).
 * Public — no login — and read-only: only the button confirms, because mail
 * scanners open links. Never cached, never indexed, and the token is kept
 * out of any Referer header.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Confirm your delivery",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

type Props = { params: Promise<{ token: string }> };

function Shell({ company, children }: { company: string; children: React.ReactNode }) {
  return (
    <main className="min-h-dvh bg-ink-surface flex flex-col items-center px-4 py-8 sm:py-14">
      <div className="w-full max-w-md">
        <p className="font-mono text-xs tracking-[0.2em] text-ink-muted uppercase text-center mb-5">{company}</p>
        <div className="bg-white border border-ink-border rounded-lg shadow-sm overflow-hidden">{children}</div>
        <p className="text-[11px] text-ink-muted text-center mt-6">Delivery confirmation by Signex</p>
      </div>
    </main>
  );
}

export default async function DeliveryPage({ params }: Props) {
  const { token } = await params;
  const found = await readDelivery(token);

  if (found.state === "not_found") {
    return (
      <Shell company="Delivery confirmation">
        <div className="px-6 py-8 text-center space-y-2">
          <h1 className="text-lg font-medium text-ink-black">This link is not valid</h1>
          <p className="text-sm text-ink-muted">Check that the whole link from the email was opened, or contact the sender.</p>
        </div>
      </Shell>
    );
  }

  if (found.state === "expired") {
    return (
      <Shell company={found.companyName}>
        <div className="px-6 py-8 text-center space-y-2">
          <h1 className="text-lg font-medium text-ink-black">This link has expired</h1>
          <p className="text-sm text-ink-muted">
            If your parcels have arrived, please let {found.companyName} know directly.
          </p>
        </div>
      </Shell>
    );
  }

  const v = found.view;
  const rows: [string, string][] = [
    ["Customer", v.customerName],
    [v.invoiceNos.length === 1 ? "Invoice" : "Invoices", v.invoiceNos.join(", ")],
    ["Courier", v.courierCompany || "—"],
    [v.waybills.length === 1 ? "Waybill" : "Waybills", v.waybills.join(", ") || "—"],
    ...(v.parcels != null ? [["Parcels", String(v.parcels)] as [string, string]] : []),
    ["Collected", v.collectedAt],
  ];

  return (
    <Shell company={v.companyName}>
      <div className="px-6 pt-6 pb-4">
        <h1 className="text-lg font-medium text-ink-black">
          {found.state === "confirmed" ? "Delivery confirmed" : "Has your delivery arrived?"}
        </h1>
        <p className="text-sm text-ink-muted mt-1">Courier trip sheet {v.courierSheetNo}</p>
      </div>
      <dl className="px-6 pb-5 divide-y divide-ink-border border-y border-ink-border">
        {rows.map(([label, value]) => (
          <div key={label} className="flex gap-4 py-2.5 text-sm">
            <dt className="w-24 shrink-0 text-ink-muted">{label}</dt>
            <dd className="text-ink-black break-words min-w-0">{value}</dd>
          </div>
        ))}
      </dl>
      <div className="px-6 py-5">
        <ConfirmReceived token={token} confirmedAt={v.confirmedAt} expiresOn={v.expiresOn} />
      </div>
    </Shell>
  );
}
