// Production admin bootstrap. Creates (or re-validates) a single privileged
// user from ADMIN_EMAIL / ADMIN_PASSWORD so a fresh production database has at
// least one ADMIN who can log in and use GST Import / Reconciliation.
//
// Deliberately small and side-effect free so it can be regression-tested and
// reused by the bootstrap:admin CLI. No output: the CLI owns all logging.
// Never logs the password.
import bcrypt from "bcryptjs";
import { prisma } from "./prisma";

export async function bootstrapAdmin(): Promise<{ email: string; role: string }> {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  const name = process.env.ADMIN_NAME || "Admin";
  if (!email || !password) {
    throw new Error("ADMIN_EMAIL and ADMIN_PASSWORD environment variables are required");
  }
  if (password.length < 8) {
    throw new Error("ADMIN_PASSWORD must be at least 8 characters long");
  }
  // Same hashing the login route verifies against (bcrypt cost 10).
  const hash = await bcrypt.hash(password, 10);
  const user = await prisma.user.upsert({
    where: { email },
    update: { name, password: hash, role: "ADMIN" },
    create: { name, email, password: hash, role: "ADMIN" },
  });
  return { email: user.email, role: user.role };
}