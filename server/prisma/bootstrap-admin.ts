// Production-only bootstrap: creates a single ADMIN user from environment
// variables so a fresh PostgreSQL database has at least one privileged account.
// Unlike prisma/seed.ts this does NOT touch invoices/reconciliation data.
//
// Usage (from server/):
//   ADMIN_EMAIL=admin@company.com ADMIN_PASSWORD='<strong>' npm run bootstrap:admin
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  const name = process.env.ADMIN_NAME || "Admin";
  if (!email || !password) {
    console.error("ADMIN_EMAIL and ADMIN_PASSWORD environment variables are required");
    process.exit(1);
  }
  if (password.length < 8) {
    console.error("ADMIN_PASSWORD must be at least 8 characters long");
    process.exit(1);
  }
  const hash = await bcrypt.hash(password, 10);
  await prisma.user.upsert({
    where: { email },
    update: { name, password: hash, role: "ADMIN" },
    create: { name, email, password: hash, role: "ADMIN" },
  });
  console.log(`Admin user ${email} ready`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());