import type { NextConfig } from "next";
import withSerwistInit from "@serwist/next";

const withSerwist = withSerwistInit({
  swSrc: "app/sw.ts",
  swDest: "public/sw.js",
  disable: process.env.NODE_ENV === "development",
});

const nextConfig: NextConfig = {
  // Empty turbopack config silences the warning in dev mode.
  // Serwist's webpack plugin is only used in production builds (--webpack flag).
  turbopack: {},
  // pdf.js-extract finds pdf.js's worker relative to its own file
  // (new URL("./pdfjs/pdf.worker.mjs", import.meta.url)) and its cmaps via
  // __dirname. Bundled into a server chunk those point at files that are not
  // there, so reading a PDF's text failed in production only. Loaded from
  // node_modules, they resolve — and Vercel's tracing ships them.
  serverExternalPackages: ["nodemailer", "pdf.js-extract"],
};

export default withSerwist(nextConfig);
