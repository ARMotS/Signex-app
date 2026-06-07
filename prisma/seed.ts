import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL_DIRECT || process.env.DATABASE_URL,
});
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  const tenant = await prisma.tenant.upsert({
    where: { slug: "default" },
    update: {},
    create: { name: "Default", slug: "default" },
  });

  const email = process.env.SUPER_ADMIN_EMAIL;
  if (!email) {
    throw new Error("SUPER_ADMIN_EMAIL environment variable is required for seeding");
  }

  await prisma.user.upsert({
    where: { email },
    update: {},
    create: {
      email,
      name: "Super Admin",
      role: "SUPER_ADMIN",
      tenantId: tenant.id,
    },
  });

  console.log(`Seeded tenant "${tenant.name}" (${tenant.id})`);
  console.log(`Seeded super admin: ${email}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
