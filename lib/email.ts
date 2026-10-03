/**
 * email.ts
 * Sends transactional emails via Brevo SMTP (Nodemailer).
 * All functions return success/failure — they never throw.
 */

import nodemailer from "nodemailer";
import { render } from "@react-email/render";
import { DeliveryConfirmation } from "@/emails/DeliveryConfirmation";
import { CollectionReceipt } from "@/emails/CollectionReceipt";
import { format } from "date-fns";

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "smtp-relay.brevo.com",
  port: Number(process.env.SMTP_PORT) || 587,
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
  // Bounded, because a collection receipt is sent while a driver waits on
  // Confirm. Nodemailer's defaults allow 2 minutes to connect and 10 to idle,
  // which a dead network would spend in full. These fail fast instead, and the
  // failure lands in the office's queue for a resend.
  connectionTimeout: 10_000,
  greetingTimeout: 10_000,
  socketTimeout: 20_000,
});

export interface DeliveryConfirmationParams {
  customerEmail: string;
  customerName: string;
  contactPerson?: string;
  invoiceNumber: string;
  driverName: string;
  deliveryAddress: string;
  signedAt: Date;
  signedPDFUrl: string;
  companyName: string;
  pdfAttachment?: {
    filename: string;
    content: Buffer;
  };
}

/**
 * @returns `error` carries the transport's own words on failure. It is shown to
 *   the dispatcher in the dashboard queue, because "the mail server rejected the
 *   message" is not something anyone can act on — "535 authentication failed"
 *   names a wrong password, "550 no such user" names a bad address, and a
 *   connection timeout names a blocked port. Swallowing that distinction made a
 *   misconfigured relay indistinguishable from a bad customer address.
 */
export async function sendDeliveryConfirmation(
  params: DeliveryConfirmationParams
): Promise<{ success: boolean; emailId?: string; error?: string }> {
  try {
    const signedAtFormatted = format(params.signedAt, "dd MMM yyyy, HH:mm");

    const html = await render(
      DeliveryConfirmation({
        ...params,
        signedAt: signedAtFormatted,
      })
    );

    const fromName = process.env.EMAIL_FROM_NAME || "Signex Deliveries";
    const fromEmail = process.env.EMAIL_FROM || "signexapp@gmail.com";

    const info = await transporter.sendMail({
      from: `${fromName} <${fromEmail}>`,
      to: params.customerEmail,
      subject: `Delivery confirmed — ${params.invoiceNumber}`,
      html,
      ...(params.pdfAttachment && {
        attachments: [
          {
            filename: params.pdfAttachment.filename,
            content: params.pdfAttachment.content,
            contentType: "application/pdf",
          },
        ],
      }),
    });

    return { success: true, emailId: info.messageId };
  } catch (err) {
    console.error("[email] Error sending delivery confirmation:", err);
    return { success: false, error: describeMailError(err) };
  }
}

export interface CollectionReceiptParams {
  customerEmail: string;
  customerName: string;
  contactPerson?: string;
  collectionNo: string;
  typeLabel: string;
  outcomeLabel: string;
  quantityLine?: string;
  signedByName?: string;
  driverName: string;
  collectedAt: Date;
  companyName: string;
  pdfAttachment?: {
    filename: string;
    content: Buffer;
  };
}

/**
 * The customer's copy of a signed collection. Same transport, sender and error
 * reporting as the delivery confirmation — see sendDeliveryConfirmation.
 */
export async function sendCollectionReceipt(
  params: CollectionReceiptParams
): Promise<{ success: boolean; emailId?: string; error?: string }> {
  try {
    const html = await render(
      CollectionReceipt({
        ...params,
        collectedAt: format(params.collectedAt, "dd MMM yyyy, HH:mm"),
      })
    );

    const fromName = process.env.EMAIL_FROM_NAME || "Signex Deliveries";
    const fromEmail = process.env.EMAIL_FROM || "signexapp@gmail.com";

    const info = await transporter.sendMail({
      from: `${fromName} <${fromEmail}>`,
      to: params.customerEmail,
      subject: `Collection receipt — ${params.collectionNo}`,
      html,
      ...(params.pdfAttachment && {
        attachments: [
          {
            filename: params.pdfAttachment.filename,
            content: params.pdfAttachment.content,
            contentType: "application/pdf",
          },
        ],
      }),
    });

    return { success: true, emailId: info.messageId };
  } catch (err) {
    console.error("[email] Error sending collection receipt:", err);
    return { success: false, error: describeMailError(err) };
  }
}

/**
 * Turn a Nodemailer/SMTP failure into one line a dispatcher can act on.
 *
 * Nodemailer hangs the useful part off the error object rather than the
 * message: `responseCode` + `response` for a server rejection, `code` for a
 * transport-level problem (EAUTH, ECONNECTION, ETIMEDOUT, EENVELOPE).
 */
function describeMailError(err: unknown): string {
  if (!err || typeof err !== "object") return "Unknown mail error";

  const e = err as {
    code?: string;
    responseCode?: number;
    response?: string;
    message?: string;
  };

  // The SMTP server said something. Its own words beat any paraphrase.
  if (e.response) {
    const code = e.responseCode ? `${e.responseCode} ` : "";
    return `${code}${String(e.response).trim()}`.slice(0, 300);
  }

  switch (e.code) {
    case "EAUTH":
      return "SMTP rejected the credentials (check SMTP_USER / SMTP_PASS)";
    case "ECONNECTION":
    case "ESOCKET":
      return `Could not reach the mail server (check SMTP_HOST / SMTP_PORT)${
        e.message ? `: ${e.message}` : ""
      }`.slice(0, 300);
    case "ETIMEDOUT":
      return "The mail server did not respond in time";
    case "EENVELOPE":
      return `The address was rejected${e.message ? `: ${e.message}` : ""}`.slice(0, 300);
  }

  return (e.message || "Unknown mail error").slice(0, 300);
}
