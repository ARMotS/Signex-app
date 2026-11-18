/**
 * The customer's side of a courier delivery, without a database: older
 * emails' link tokens, where links point, what still follows a completed
 * sheet, and what the email says.
 */

import { describe, it, expect } from "vitest";
import { render } from "@react-email/render";
import crypto from "crypto";
import { hashConfirmToken } from "@/lib/courier-confirm";
import { appBaseUrl } from "@/lib/app-url";
import { confirmationState } from "@/lib/courier-sheet";
import { CourierDispatch } from "@/emails/CourierDispatch";

describe("an older email's link token", () => {
  it("is looked up by its SHA-256", () => {
    const token = crypto.randomBytes(32).toString("base64url");
    expect(hashConfirmToken(token)).toBe(crypto.createHash("sha256").update(token).digest("hex"));
  });

  it("anything that cannot be one of our tokens is never looked up", () => {
    for (const bad of ["", "short", "a".repeat(42), "a".repeat(44), `${"a".repeat(42)}/`, `${"a".repeat(41)}..`, "' OR 1=1 --"]) {
      expect(hashConfirmToken(bad)).toBeNull();
    }
  });

});

describe("appBaseUrl", () => {
  it("production: the configured address, unless it is localhost", () => {
    expect(appBaseUrl({ VERCEL_ENV: "production", NEXT_PUBLIC_APP_URL: "https://signex-app.vercel.app/", VERCEL_PROJECT_PRODUCTION_URL: "x.vercel.app" })).toBe(
      "https://signex-app.vercel.app"
    );
    expect(appBaseUrl({ VERCEL_ENV: "production", NEXT_PUBLIC_APP_URL: "http://localhost:3000", VERCEL_PROJECT_PRODUCTION_URL: "signex-app.vercel.app" })).toBe(
      "https://signex-app.vercel.app"
    );
    expect(appBaseUrl({ VERCEL_ENV: "production", VERCEL_PROJECT_PRODUCTION_URL: "signex-app.vercel.app" })).toBe("https://signex-app.vercel.app");
  });

  it("a preview links to itself, so a test email opens the preview", () => {
    expect(appBaseUrl({ VERCEL_ENV: "preview", NEXT_PUBLIC_APP_URL: "https://signex-app.vercel.app", VERCEL_BRANCH_URL: "signex-app-git-x.vercel.app" })).toBe(
      "https://signex-app-git-x.vercel.app"
    );
  });

  it("locally: the configured address, else localhost", () => {
    expect(appBaseUrl({ NEXT_PUBLIC_APP_URL: "http://localhost:3100" })).toBe("http://localhost:3100");
    expect(appBaseUrl({})).toBe("http://localhost:3000");
  });
});

describe("confirmationState", () => {
  const base = { status: "COLLECTED", filingCompletedAt: new Date(), emailStatus: "SENT" };

  it("reads what still follows a completed sheet", () => {
    expect(confirmationState({ ...base, status: "AWAITING_COLLECTION" })).toBeNull();
    expect(confirmationState({ ...base, status: "NEEDS_ATTENTION" })).toBeNull();
    expect(confirmationState({ ...base, filingCompletedAt: null })).toBe("filing");
    expect(confirmationState({ ...base, emailStatus: "NO_EMAIL" })).toBe("email_problem");
    expect(confirmationState({ ...base, emailStatus: "FAILED" })).toBe("email_problem");
    expect(confirmationState({ ...base, emailStatus: "NOT_SENT" })).toBe("sending");
    expect(confirmationState(base)).toBe("emailed");
    // Confirmed by a customer before confirming was retired: the same.
    expect(confirmationState({ ...base, status: "DELIVERED" })).toBe("emailed");
  });
});

describe("the email", () => {
  const props = {
    customerName: "Acme Trading",
    contactPerson: "Jo",
    companyName: "Signex Polokwane",
    courierCompany: "The Courier Guy",
    courierSheetNo: "200189",
    waybills: ["W500"],
    parcels: 3,
    invoiceNos: ["634573", "634574"],
    collectedAt: "23/10/2026, 09:47",
    courierDriverName: "Sipho Ndlovu",
  };

  it("names the invoices, the courier company and its driver", async () => {
    const html = await render(CourierDispatch({ ...props, attached: 2 }));
    for (const s of ["634573, 634574", "The Courier Guy", "Courier driver", "Sipho Ndlovu", "W500", "200189", "23/10/2026, 09:47", "Hi Jo", "Collected by courier"]) {
      expect(html).toContain(s);
    }
    expect(html).toContain("copies of your 2 invoices are");
  });

  it("asks the customer for nothing: no button, no link", async () => {
    const html = await render(CourierDispatch({ ...props, attached: 2 }));
    expect(html).not.toContain("Confirm received");
    expect(html).not.toContain("/delivery/");
    expect(html).not.toMatch(/<as/i);
  });

  it("leaves the driver row out when no name was recorded", async () => {
    const html = await render(CourierDispatch({ ...props, courierDriverName: undefined, attached: 0 }));
    expect(html).not.toContain("Courier driver");
  });

  it("says which copies could not be attached", async () => {
    const html = await render(CourierDispatch({ ...props, attached: 1, notAttached: ["634574"] }));
    expect(html).toContain("Invoice 634574 could not be attached");
  });
});
