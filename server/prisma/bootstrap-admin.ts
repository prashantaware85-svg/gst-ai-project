// Production-only bootstrap CLI: creates a single ADMIN user from environment
// variables so a fresh PostgreSQL database has at least one privileged account.
// Unlike prisma/seed.ts this does NOT touch invoices/reconciliation data.
//
// Usage (from server/):
//   ADMIN_EMAIL=prashantaware85@gmail.com ADMIN_PASSWORD='<strong>' npm run bootstrap:admin
//
// Idempotent: re-running with the same ADMIN_EMAIL updates the password and
// ensures role ADMIN, never creating a duplicate user. Only the email is
// printed; the password is never logged.
import { bootstrapAdmin } from "../src/utils/adminBootstrap";
import { prisma } from "../src/utils/prisma";

async function main() {
  const { email } = await bootstrapAdmin();
  console.log(`Admin user ${email} ready`);
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());