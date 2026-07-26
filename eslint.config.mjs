import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Generated service worker bundle — not hand-written source.
    "public/sw.js",
    "public/sw.js.map",
    "public/workbox-*.js",
  ]),

  // ── Tenant isolation: keep the choke point the only way in ──────────────
  //
  // API routes and server actions must go through getScope() → ctx.db, which is
  // hard-locked to the caller's tenant. Importing the raw client would silently
  // reintroduce the class of cross-ADMIN leak this codebase was audited for, so
  // it is a lint error rather than a code-review convention.
  {
    files: ["app/api/**/*.ts", "app/**/actions.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@/lib/db",
              importNames: ["prisma"],
              message:
                "Route handlers must not use the unscoped Prisma client. Use `const { db } = await getScope()` from @/lib/tenant. If a query genuinely must span scopes, import UNSAFE_unscopedPrisma from @/lib/db-scoped and add a `// SCOPE-EXEMPT: <reason>` comment.",
            },
          ],
        },
      ],
    },
  },

  // Test harnesses legitimately deal in loose request/response shapes.
  {
    files: ["tests/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },

  // Standalone CLI scripts. These use `require("dotenv/config")` because ESM
  // hoists `import` statements, so an `import "dotenv/config"` would not be
  // guaranteed to run before the Prisma client reads DATABASE_URL.
  {
    files: ["prisma.config.ts", "prisma/*.ts"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
]);

export default eslintConfig;
