import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Signex — Paperless Delivery Signatures",
    short_name: "Signex",
    description:
      "Capture, sign, and store delivery invoices digitally. Built for logistics teams.",
    start_url: "/",
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
        name: "Driver Login",
        short_name: "Driver",
        url: "/select",
        description: "Driver login and run selection",
      },
    ],
  };
}
