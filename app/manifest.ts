import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Signex — Paperless Delivery Signatures",
    short_name: "Signex",
    description:
      "Capture, sign, and store delivery invoices digitally. Built for logistics teams.",
    // The one sign-in; a signed-in user is sent straight on to their own screen.
    start_url: "/login",
    display: "standalone",
    background_color: "#0F0F0F",
    theme_color: "#0F0F0F",
    orientation: "any",
    categories: ["business", "productivity", "utilities"],
    icons: [
      {
        src: "/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
    shortcuts: [
      {
        name: "Admin Dashboard",
        short_name: "Dashboard",
        url: "/dashboard",
        description: "Open the admin dashboard",
      },
      {
        name: "My Run",
        short_name: "Run",
        url: "/run",
        description: "Open today's deliveries (drivers)",
      },
    ],
  };
}
