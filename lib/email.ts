/**
 * email.ts
 * Sends transactional emails via Brevo SMTP (Nodemailer).
 * All functions return success/failure — they never throw.
 */

import nodemailer from "nodemailer";
import { render } from "@react-email/render";
import { DeliveryConfirmation } from "@/emails/DeliveryConfirmation";
import { format } from "date-fns";

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "smtp-relay.brevo.com",
  port: Number(process.env.SMTP_PORT) || 587,
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
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

export async function sendDeliveryConfirmation(
  params: DeliveryConfirmationParams
): Promise<{ success: boolean; emailId?: string }> {
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
    return { success: false };
  }
}
