try { require("dotenv/config"); } catch {}
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    // Migrations need a real session for advisory locks and DDL, neither of
    // which survives Neon's transaction-mode pooler — so they use the DIRECT
    // endpoint. The application runtime does the opposite and connects through
    // the pooled endpoint; see the note in lib/db.ts.
    url: process.env["DATABASE_URL_DIRECT"] || process.env["DATABASE_URL"],
  },
});
