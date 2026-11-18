/**
 * CourierDispatch.tsx
 * React Email component for a courier delivery: the customer is told their
 * invoices were collected by a courier — which company, which driver, which
 * waybills — the way DeliveryConfirmation tells them one of our own drivers
 * delivered. It asks for nothing: there is no Confirm received any more
 * (2026-11-18), so there is no button and no link.
 *
 * Nothing priced: the email names invoices, never amounts. The signed copies
 * (with the courier driver's signature) are attached.
 */

import {
  Body,
  Container,
  Head,
  Hr,
  Html,
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
  /** The courier's driver who signed for the parcels, as typed at the handover. */
  courierDriverName?: string;
  courierSheetNo: string;
  waybills: string[];
  parcels: number | null;
  invoiceNos: string[];
  collectedAt: string; // pre-formatted, Johannesburg time
  /** How many signed copies are attached. */
  attached: number;
  /** Invoices whose signed copy could not be attached. */
  notAttached?: string[];
}

export function CourierDispatch(p: CourierDispatchProps) {
  const greeting = p.contactPerson ? `Hi ${p.contactPerson},` : `Dear ${p.customerName},`;
  const rows: [string, string][] = [
    [p.invoiceNos.length === 1 ? "Invoice" : "Invoices", p.invoiceNos.join(", ")],
    ["Courier company", p.courierCompany],
    ...(p.courierDriverName ? [["Courier driver", p.courierDriverName] as [string, string]] : []),
    [p.waybills.length === 1 ? "Waybill" : "Waybills", p.waybills.join(", ") || "—"],
    ...(p.parcels != null ? [["Parcels", String(p.parcels)] as [string, string]] : []),
    ["Date & time collected", p.collectedAt],
    ["Courier trip sheet", p.courierSheetNo],
  ];

  return (
    <Html lang="en" dir="ltr">
      <Head>
        <title>Your order is on its way</title>
        <style>{`
          @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&display=swap');
          * { font-family: 'IBM Plex Sans', 'Helvetica Neue', Arial, sans-serif; }
        `}</style>
      </Head>

      <Preview>
        {`Your order left ${p.companyName} with ${p.courierCompany}${p.waybills.length ? ` — waybill ${p.waybills.join(", ")}` : ""}.`}
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
            <Text style={styles.bannerIcon}>✓</Text>
            <Text style={styles.bannerText}>Collected by courier</Text>
          </Container>
        </Section>

        <Container style={styles.container}>
          <Section style={styles.card}>
            <Text style={styles.greeting}>{greeting}</Text>
            <Text style={styles.intro}>
              {`This is an automated confirmation that your order has been collected from ${p.companyName} by ${p.courierCompany} and is on its way to you. Please find the details below.`}
            </Text>

            <Hr style={styles.divider} />

            {rows.map(([label, value]) => (
              <Row key={label} style={styles.detailRow}>
                <Text style={styles.detailLabel}>{label}</Text>
                <Text style={styles.detailValue}>{value}</Text>
              </Row>
            ))}

            {(p.attached > 0 || p.notAttached?.length) ? (
              <>
                <Hr style={styles.divider} />
                <Text style={{ ...styles.intro, margin: 0 }}>
                  {p.attached > 0
                    ? `The signed ${p.attached === 1 ? "copy of your invoice is" : `copies of your ${p.attached} invoices are`} attached, showing the courier's signature.`
                    : ""}
                  {p.notAttached?.length
                    ? ` ${p.notAttached.length === 1 ? "Invoice" : "Invoices"} ${p.notAttached.join(", ")} could not be attached — ask us for a copy if you need one.`
                    : ""}
                </Text>
              </>
            ) : null}
          </Section>

          <Section>
            <Text style={styles.footer}>
              Automated confirmation from {p.companyName}. Do not reply to this email.
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}

export default CourierDispatch;
