/**
 * DeliveryConfirmation.tsx
 * React Email component for delivery confirmation notifications.
 */

import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Link,
  Preview,
  Row,
  Section,
  Text,
} from "@react-email/components";
import * as React from "react";

interface DeliveryConfirmationProps {
  customerName: string;
  contactPerson?: string;
  invoiceNumber: string;
  driverName: string;
  deliveryAddress: string;
  signedAt: string; // pre-formatted string
  signedPDFUrl: string;
  companyName: string;
}

export function DeliveryConfirmation({
  customerName,
  contactPerson,
  invoiceNumber,
  driverName,
  deliveryAddress,
  signedAt,
  signedPDFUrl,
  companyName,
}: DeliveryConfirmationProps) {
  const greeting = contactPerson ? `Hi ${contactPerson},` : `Dear ${customerName},`;

  return (
    <Html lang="en" dir="ltr">
      <Head>
        <title>{`Delivery confirmed — ${invoiceNumber}`}</title>
        {/* IBM Plex Sans */}
        <style>{`
          @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&display=swap');
          * { font-family: 'IBM Plex Sans', 'Helvetica Neue', Arial, sans-serif; }
        `}</style>
      </Head>

      <Preview>
        Your delivery for invoice {invoiceNumber} has been completed and signed.
      </Preview>

      <Body style={styles.body}>
        {/* ─── Dark header ────────────────────────────────── */}
        <Section style={styles.header}>
          <Container style={styles.headerInner}>
            <Text style={styles.brandMark}>✦</Text>
            <Text style={styles.brandName}>{companyName.toUpperCase()}</Text>
          </Container>
        </Section>

        {/* ─── Green banner ────────────────────────────────── */}
        <Section style={styles.banner}>
          <Container style={styles.bannerInner}>
            <Text style={styles.bannerIcon}>✓</Text>
            <Text style={styles.bannerText}>Delivery Completed</Text>
          </Container>
        </Section>

        {/* ─── Body content ───────────────────────────────── */}
        <Container style={styles.container}>
          <Section style={styles.card}>
            <Text style={styles.greeting}>{greeting}</Text>
            <Text style={styles.intro}>
              This is an automated confirmation that your delivery has been completed
              and signed. Please find the details below.
            </Text>

            <Hr style={styles.divider} />

            {/* Detail rows */}
            <Row style={styles.detailRow}>
              <Text style={styles.detailLabel}>Invoice</Text>
              <Text style={styles.detailValue}>{invoiceNumber}</Text>
            </Row>
            <Row style={styles.detailRow}>
              <Text style={styles.detailLabel}>Delivered to</Text>
              <Text style={styles.detailValue}>{deliveryAddress}</Text>
            </Row>
            <Row style={styles.detailRow}>
              <Text style={styles.detailLabel}>Driver</Text>
              <Text style={styles.detailValue}>{driverName}</Text>
            </Row>
            <Row style={styles.detailRow}>
              <Text style={styles.detailLabel}>Date &amp; time</Text>
              <Text style={styles.detailValue}>{signedAt}</Text>
            </Row>

            <Hr style={styles.divider} />

            {/* CTA */}
            <Section style={styles.ctaSection}>
              <Button href={signedPDFUrl} style={styles.button}>
                View Signed Invoice
              </Button>
            </Section>
          </Section>

          {/* ─── Footer ─────────────────────────────────── */}
          <Section>
            <Text style={styles.footer}>
              Automated confirmation from {companyName}. Do not reply to this email.
            </Text>
            <Text style={styles.footerLink}>
              <Link href={signedPDFUrl} style={styles.footerLinkAnchor}>
                Having trouble with the button? Click here.
              </Link>
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}

export default DeliveryConfirmation;

// ─── Styles ──────────────────────────────────────────────────────────────────

const styles = {
  body: {
    backgroundColor: "#f4f4f5",
    margin: 0,
    padding: 0,
  },
  header: {
    backgroundColor: "#0F0F0F",
    padding: "24px 0",
  },
  headerInner: {
    maxWidth: "560px",
    margin: "0 auto",
    padding: "0 24px",
    display: "flex" as const,
    alignItems: "center",
    gap: "8px",
  },
  brandMark: {
    color: "#00C07F",
    fontSize: "18px",
    margin: 0,
    display: "inline",
  },
  brandName: {
    color: "#ffffff",
    fontSize: "14px",
    fontWeight: 600,
    letterSpacing: "0.1em",
    margin: 0,
    display: "inline",
    marginLeft: "8px",
  },
  banner: {
    backgroundColor: "#00C07F",
    padding: "20px 0",
  },
  bannerInner: {
    maxWidth: "560px",
    margin: "0 auto",
    padding: "0 24px",
    textAlign: "center" as const,
  },
  bannerIcon: {
    color: "#ffffff",
    fontSize: "28px",
    fontWeight: 700,
    margin: 0,
    lineHeight: 1,
  },
  bannerText: {
    color: "#ffffff",
    fontSize: "18px",
    fontWeight: 600,
    margin: "4px 0 0",
  },
  container: {
    maxWidth: "560px",
    margin: "0 auto",
    padding: "24px",
  },
  card: {
    backgroundColor: "#ffffff",
    borderRadius: "12px",
    padding: "32px",
    marginBottom: "16px",
    boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
  },
  greeting: {
    fontSize: "16px",
    fontWeight: 600,
    color: "#0F0F0F",
    margin: "0 0 8px",
  },
  intro: {
    fontSize: "14px",
    color: "#52525b",
    lineHeight: "1.6",
    margin: "0 0 20px",
  },
  divider: {
    borderColor: "#e4e4e7",
    margin: "20px 0",
  },
  detailRow: {
    marginBottom: "12px",
  },
  detailLabel: {
    fontSize: "11px",
    fontWeight: 600,
    color: "#a1a1aa",
    textTransform: "uppercase" as const,
    letterSpacing: "0.06em",
    margin: "0 0 2px",
  },
  detailValue: {
    fontSize: "14px",
    color: "#18181b",
    margin: 0,
    fontWeight: 500,
  },
  ctaSection: {
    textAlign: "center" as const,
    marginTop: "24px",
  },
  button: {
    backgroundColor: "#0F0F0F",
    color: "#ffffff",
    padding: "12px 28px",
    borderRadius: "8px",
    fontSize: "14px",
    fontWeight: 600,
    textDecoration: "none",
    display: "inline-block",
  },
  footer: {
    fontSize: "12px",
    color: "#a1a1aa",
    textAlign: "center" as const,
    margin: "0 0 4px",
  },
  footerLink: {
    textAlign: "center" as const,
    margin: 0,
  },
  footerLinkAnchor: {
    fontSize: "12px",
    color: "#a1a1aa",
  },
};
