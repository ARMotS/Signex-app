/**
 * CreditNoteSigned.tsx
 * React Email component for a signed credit note: the customer is told the
 * credit for their returned goods has been signed off, with the signed copy
 * attached. The body names documents, never amounts — the figures are on the
 * attached note itself.
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

export interface CreditNoteSignedProps {
  customerName: string;
  contactPerson?: string;
  /** The branch that signed it. */
  companyName: string;
  creditNo: string;
  invoiceNo?: string | null;
  /** The collection(s) the credit is for, as printed. */
  collectionNos: string[];
  /** Pre-formatted ("12 Nov 2026"). */
  creditDate?: string | null;
  /** Pre-formatted, Johannesburg time. */
  signedAt: string;
  /** False when the signed copy was too large to attach. */
  attached: boolean;
}

export function CreditNoteSigned(p: CreditNoteSignedProps) {
  const greeting = p.contactPerson ? `Hi ${p.contactPerson},` : `Dear ${p.customerName},`;
  const rows: [string, string][] = [
    ["Credit note", p.creditNo],
    ...(p.invoiceNo ? [["Against invoice", p.invoiceNo] as [string, string]] : []),
    ...(p.collectionNos.length
      ? [[p.collectionNos.length === 1 ? "Collection" : "Collections", p.collectionNos.join(", ")] as [string, string]]
      : []),
    ...(p.creditDate ? [["Credit note date", p.creditDate] as [string, string]] : []),
    ["Signed off", p.signedAt],
  ];

  return (
    <Html lang="en" dir="ltr">
      <Head>
        <title>{`Credit note ${p.creditNo}`}</title>
        <style>{`
          @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&display=swap');
          * { font-family: 'IBM Plex Sans', 'Helvetica Neue', Arial, sans-serif; }
        `}</style>
      </Head>

      <Preview>
        {`Your credit note ${p.creditNo}${p.invoiceNo ? ` for invoice ${p.invoiceNo}` : ""} has been signed off.`}
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
            <Text style={styles.bannerText}>Credit Note Signed</Text>
          </Container>
        </Section>

        <Container style={styles.container}>
          <Section style={styles.card}>
            <Text style={styles.greeting}>{greeting}</Text>
            <Text style={styles.intro}>
              {p.attached
                ? `${p.companyName} has signed off the credit note for your returned goods. The signed credit note is attached for your records.`
                : `${p.companyName} has signed off the credit note for your returned goods. The signed copy was too large to attach — ask us for a copy if you need one.`}
            </Text>

            <Hr style={styles.divider} />

            {rows.map(([label, value]) => (
              <Row key={label} style={styles.detailRow}>
                <Text style={styles.detailLabel}>{label}</Text>
                <Text style={styles.detailValue}>{value}</Text>
              </Row>
            ))}
          </Section>

          <Section>
            <Text style={styles.footer}>
              Automated message from {p.companyName}. Do not reply to this email.
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}

export default CreditNoteSigned;
