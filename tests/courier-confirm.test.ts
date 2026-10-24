/**
 * The customer's side of a courier delivery, without a database: the link's
 * token, when the reminder is due, where links point, what state a sheet is
 * in, and what the email says.
 */

import { describe, it, expect } from "vitest";
import { render } from "@react-email/render";
import crypto from "crypto";
import {
  confirmUrl,
  formatDay,
  hashConfirmToken,
  newConfirmToken,
  reminderDue,
} from "@/lib/courier-confirm";
import { appBaseUrl } from "@/lib/app-url";
import { confirmationState } from "@/lib/courier-sheet";
import { CourierDispatch } from "@/emails/CourierDispatch";

describe("the link's token", () => {
  it("is 32 random bytes, looked up by its SHA-256", () => {
    const { token, hash } = newConfirmToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hash).toBe(crypto.createHash("sha256").update(token).digest("hex"));
    expect(hashConfirmToken(token)).toBe(hash);
    expect(newConfirmToken().token).not.toBe(token);
  });

  it("anything that cannot be one of our tokens is never looked up", () => {
    for (const bad of ["", "short", "a".repeat(42), "a".repeat(44), `${"a".repeat(42)}/`, `${"a".repeat(41)}..`, "' OR 1=1 --"]) {
      expect(hashConfirmToken(bad)).toBeNull();
    }
  });

  it("goes in a /delivery link", () => {
    expect(confirmUrl("abc", "https://signex-app.vercel.app")).toBe("https://signex-app.vercel.app/delivery/abc");
  });
});

describe("reminderDue", () => {
  // Monday 10:00 SAST = 08:00 UTC.
  const sent = new Date("2026-10-19T08:00:00Z");

  it("is due on the second South African calendar day, whatever the hour", () => {
    expect(reminderDue(sent, new Date("2026-10-20T06:00:00Z"))).toBe(false); // Tue 08:00
    expect(reminderDue(sent, new Date("2026-10-21T06:00:00Z"))).toBe(true); // Wed 08:00
    expect(reminderDue(sent, new Date("2026-10-21T04:00:00Z"))).toBe(true); // Wed 06:00, before the send's hour
  });

  it("counts days in Johannesburg, not UTC", () => {
    // Monday 23:30 UTC is already Tuesday 01:30 in Johannesburg.
    const late = new Date("2026-10-19T23:30:00Z");
    expect(reminderDue(late, new Date("2026-10-21T06:00:00Z"))).toBe(false); // Wed — one day after Tue
    expect(reminderDue(late, new Date("2026-10-22T06:00:00Z"))).toBe(true); // Thu
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
  const base = { status: "COLLECTED", filingCompletedAt: new Date(), emailStatus: "SENT", reminderSentAt: null, confirmedAt: null };
  const now = new Date("2026-10-23T10:00:00Z");

  it("reads where a collected sheet stands with its customer", () => {
    expect(confirmationState({ ...base, status: "AWAITING_COLLECTION" })).toBeNull();
    expect(confirmationState({ ...base, filingCompletedAt: null })).toBe("filing");
    expect(confirmationState({ ...base, emailStatus: "NO_EMAIL" })).toBe("email_problem");
    expect(confirmationState({ ...base, emailStatus: "FAILED" })).toBe("email_problem");
    expect(confirmationState({ ...base, emailStatus: "NOT_SENT" })).toBe("sending");
    expect(confirmationState(base)).toBe("awaiting");
    expect(confirmationState({ ...base, status: "DELIVERED", confirmedAt: now })).toBe("confirmed");
  });

  it("asks the office to phone two days after the reminder", () => {
    expect(confirmationState({ ...base, reminderSentAt: "2026-10-22T06:00:00Z" }, now)).toBe("reminded");
    expect(confirmationState({ ...base, reminderSentAt: "2026-10-21T06:00:00Z" }, now)).toBe("no_answer");
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
    confirmUrl: "https://signex-app.vercel.app/delivery/TOKEN",
    expiresOn: formatDay(new Date("2026-11-22T10:00:00Z")),
  };

  it("names the invoices, the courier and the link — and the link's last day", async () => {
    const html = await render(CourierDispatch({ ...props, attached: 2 }));
    for (const s of ["634573, 634574", "The Courier Guy", "W500", "200189", 'href="https://signex-app.vercel.app/delivery/TOKEN"', "Confirm received", "22 Nov 2026", "Hi Jo"]) {
      expect(html).toContain(s);
    }
    expect(html).toContain("copies of your 2 invoices are");
  });

  it("the reminder asks again, with no attachments mentioned", async () => {
    const html = await render(CourierDispatch({ ...props, reminder: true, attached: 0 }));
    expect(html).toContain("We have not yet heard");
    expect(html).not.toContain("attached");
  });

  it("says which copies could not be attached", async () => {
    const html = await render(CourierDispatch({ ...props, attached: 1, notAttached: ["634574"] }));
    expect(html).toContain("Invoice 634574 could not be attached");
  });
});
