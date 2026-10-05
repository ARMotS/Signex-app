import type { Metadata, Viewport } from "next";
import { Poppins } from "next/font/google";
import "./globals.css";

// The one typeface for the whole app. Self-hosted by next/font, so drivers'
// phones never fetch it from Google at the door.
const poppins = Poppins({
  variable: "--font-poppins",
  weight: ["400", "500", "600", "700"],
  subsets: ["latin"],
  display: "swap",
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
      className={`${poppins.variable} h-full`}
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
