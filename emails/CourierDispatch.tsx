/**
 * CourierDispatch.tsx
 * React Email component for a courier delivery: the customer is told their
 * invoices left with a courier, and asked to press Confirm received once the
 * parcels arrive. The same component words the one reminder.
 *
 * Nothing priced: the email names invoices, never amounts. The signed copies
 * are attached to the first email only.
 */

import {
  Body,
  Button,
  Container,
  Head,
  Hr,
  Html,
  Link,
  Preview,
  Row,
  Section,
  Text,
} from "@react-email/components";
import * as React from "react";
import { emailStyles as styles } from "./DeliveryConfirmation";

export interface CourierDispatchProps {
  customerName: string;
  contactPerson?: string;
  /** The branch it left from — the stamp's dispatch company. */
  companyName: string;
  courierCompany: string;
  courierSheetNo: string;
  waybills: string[];
  parcels: number | null;
  invoiceNos: string[];
  collectedAt: string; // pre-formatted, Johannesburg time
  confirmUrl: string;
  /** "dd MMM yyyy" — when the link stops working. */
  expiresOn: string;
  reminder?: boolean;
  /** How many signed copies are attached (0 on a reminder). */
  attached: number;
  /** Invoices whose signed copy could not be attached. */
  notAttached?: string[];
}

export function CourierDispatch(p: CourierDispatchProps) {
  const greeting = p.contactPerson ? `Hi ${p.contactPerson},` : `Dear ${p.customerName},`;
  const rows: [string, string][] = [
    [p.invoiceNos.length === 1 ? "Invoice" : "Invoices", p.invoiceNos.join(", ")],
    ["Courier", p.courierCompany],
    [p.waybills.length === 1 ? "Waybill" : "Waybills", p.waybills.join(", ") || "—"],
    ...(p.parcels != null ? [["Parcels", String(p.parcels)] as [string, string]] : []),
    ["Collected", p.collectedAt],
    ["Courier trip sheet", p.courierSheetNo],
  ];

  return (
    <Html lang="en" dir="ltr">
      <Head>
        <title>{p.reminder ? "Please confirm your delivery arrived" : "Your order is on its way"}</title>
        <style>{`
          @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&display=swap');
          * { font-family: 'IBM Plex Sans', 'Helvetica Neue', Arial, sans-serif; }
        `}</style>
      </Head>

      <Preview>
        {p.reminder
          ? `Did your parcels from ${p.companyName} arrive? Please confirm.`
          : `Your order left ${p.companyName} with ${p.courierCompany}. Confirm when it arrives.`}
      </Preview>

      <Body style={styles.body}>
        <Section style={styles.header}>
          <Container style={styles.headerInner}>
            <Text style={styles.brandMark}>✦</Text>
            <Text style={styles.brandName}>{p.companyName.toUpperCase()}</Text>
          </Container>
        </Section>

        <Section style={styles.banner}>
          <Container style={styles.bannerInner}>
            <Text style={styles.bannerIcon}>➜</Text>
            <Text style={styles.bannerText}>{p.reminder ? "Did it arrive?" : "Sent by courier"}</Text>
          </Container>
        </Section>

        <Container style={styles.container}>
          <Section style={styles.card}>
            <Text style={styles.greeting}>{greeting}</Text>
            <Text style={styles.intro}>
              {p.reminder
                ? `We have not yet heard that your parcels arrived. Once they have, please press Confirm received below — it takes one click.`
                : `Your order has left ${p.companyName} with ${p.courierCompany}. When the parcels arrive, please press Confirm received below so we know they reached you.`}
            </Text>

            <Hr style={styles.divider} />

            {rows.map(([label, value]) => (
              <Row key={label} style={styles.detailRow}>
                <Text style={styles.detailLabel}>{label}</Text>
                <Text style={styles.detailValue}>{value}</Text>
              </Row>
            ))}

            {!p.reminder && (p.attached > 0 || p.notAttached?.length) ? (
              <>
                <Hr style={styles.divider} />
                <Text style={styles.intro}>
                  {p.attached > 0
                    ? `The signed ${p.attached === 1 ? "copy of your invoice is" : `copies of your ${p.attached} invoices are`} attached, showing the courier's signature.`
                    : ""}
                  {p.notAttached?.length
                    ? ` ${p.notAttached.length === 1 ? "Invoice" : "Invoices"} ${p.notAttached.join(", ")} could not be attached — ask us for a copy if you need one.`
                    : ""}
                </Text>
              </>
            ) : null}

            <Hr style={styles.divider} />

            <Section style={styles.ctaSection}>
              <Button href={p.confirmUrl} style={styles.button}>
                Confirm received
              </Button>
            </Section>
            <Text style={{ ...styles.intro, fontSize: "12px", textAlign: "center" as const, margin: "4px 0 0" }}>
              The link works until {p.expiresOn}.
            </Text>
          </Section>

          <Section>
            <Text style={styles.footer}>
              Automated message from {p.companyName}. Do not reply to this email.
            </Text>
            <Text style={styles.footerLink}>
              <Link href={p.confirmUrl} style={styles.footerLinkAnchor}>
                Having trouble with the button? Click here.
              </Link>
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}

export default CourierDispatch;
