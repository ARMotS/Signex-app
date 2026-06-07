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
  serverExternalPackages: ["nodemailer"],
};

export default withSerwist(nextConfig);
