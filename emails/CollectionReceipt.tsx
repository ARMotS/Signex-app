/**
 * CollectionReceipt.tsx
 * React Email component for the signed collection receipt — the customer's
 * copy of what the driver took away. The signed PDF is attached.
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

interface CollectionReceiptProps {
  customerName: string;
  contactPerson?: string;
  collectionNo: string;
  /** "Credit return" / "Uplift — Company parcel" */
  typeLabel: string;
  /** "Collected in full" / "Partly collected" */
  outcomeLabel: string;
  quantityLine?: string;
  signedByName?: string;
  driverName: string;
  collectedAt: string; // pre-formatted string
  companyName: string;
}

export function CollectionReceipt({
  customerName,
  contactPerson,
  collectionNo,
  typeLabel,
  outcomeLabel,
  quantityLine,
  signedByName,
  driverName,
  collectedAt,
  companyName,
}: CollectionReceiptProps) {
  const greeting = contactPerson ? `Hi ${contactPerson},` : `Dear ${customerName},`;

  const rows: [string, string][] = [
    ["Collection", collectionNo],
    ["Type", typeLabel],
    ["Outcome", outcomeLabel],
    ...(quantityLine ? [["Quantity", quantityLine] as [string, string]] : []),
    ...(signedByName ? [["Handed over by", signedByName] as [string, string]] : []),
    ["Driver", driverName],
    ["Date & time", collectedAt],
  ];

  return (
    <Html lang="en" dir="ltr">
      <Head>
        <title>{`Collection receipt — ${collectionNo}`}</title>
        <style>{`
          @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&display=swap');
          * { font-family: 'IBM Plex Sans', 'Helvetica Neue', Arial, sans-serif; }
        `}</style>
      </Head>

      <Preview>
        Your signed receipt for collection {collectionNo} is attached.
      </Preview>

      <Body style={styles.body}>
        <Section style={styles.header}>
          <Container style={styles.headerInner}>
            <Text style={styles.brandMark}>✦</Text>
            <Text style={styles.brandName}>{companyName.toUpperCase()}</Text>
          </Container>
        </Section>

        <Section style={styles.banner}>
          <Container style={styles.bannerInner}>
            <Text style={styles.bannerIcon}>✓</Text>
            <Text style={styles.bannerText}>Collection Signed</Text>
          </Container>
        </Section>

        <Container style={styles.container}>
          <Section style={styles.card}>
            <Text style={styles.greeting}>{greeting}</Text>
            <Text style={styles.intro}>
              This is an automated receipt for goods collected from you today. The
              signed collection sheet is attached for your records.
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
              Automated receipt from {companyName}. Do not reply to this email.
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}

export default CollectionReceipt;
