import type { Metadata, Viewport } from "next";
import { Geist } from "next/font/google";
import { DM_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const dmMono = DM_Mono({
  variable: "--font-dm-mono",
  weight: ["300", "400", "500"],
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Signex — Paperless Delivery Signatures",
  description:
    "Capture, sign, and store delivery invoices digitally. Built for logistics teams that move fast.",
  keywords: ["delivery", "signatures", "logistics", "invoices", "paperless"],
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Signex",
  },
  formatDetection: {
    telephone: false,
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: "#0F0F0F",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${dmMono.variable} h-full`}
      suppressHydrationWarning
    >
      <head>
        <link rel="apple-touch-icon" href="/icon-512.png" />
      </head>
      <body className="min-h-dvh flex flex-col font-sans antialiased" suppressHydrationWarning>
        {children}
      </body>
    </html>
  );
}
