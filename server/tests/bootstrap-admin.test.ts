import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import express from "express";
import bcrypt from "bcryptjs";
import { copyFileSync, rmSync } from "node:fs";

// The shared bootstrap (src/utils/adminBootstrap) and the auth routes both bind
// to the app's PrismaClient, so they are lazy-imported AFTER DATABASE_URL /
// ADMIN_* are set, against a throwaway copy of the migrated dev database.
const TEST_DB = "C:/Users/User/AppData/Local/Temp/opencode/bootstrap-admin-test.db";
const DEV_DB = "C:/Users/User/gst-ai-agent/server/prisma/dev.db";
const ADMIN_EMAIL = "prashantaware85@gmail.com";
const ADMIN_PASSWORD = "SecureAdminPass2026";

let server: Server | undefined;
let base = "";
let prisma: any;
let bootstrapAdmin: () => Promise<{ email: string; role: string }>;

before(async () => {
  rmSync(TEST_DB, { force: true });
  copyFileSync(DEV_DB, TEST_DB);
  process.env.DATABASE_URL = `file:${TEST_DB}`;
  process.env.ADMIN_EMAIL = ADMIN_EMAIL;
  process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;
  process.env.ADMIN_NAME = "Prashant";

  const bootstrapMod = await import("../src/utils/adminBootstrap");
  bootstrapAdmin = bootstrapMod.bootstrapAdmin;
  const prismaMod = await import("../src/utils/prisma");
  prisma = prismaMod.prisma;
  const { authRouter } = await import("../src/routes/auth.routes");

  const app = express();
  app.use(express.json());
  app.use("/api", authRouter);
  server = app.listen(0);
  await new Promise<void>((r) => server!.once("listening", r));
  base = `http://127.0.0.1:${(server!.address() as any).port}`;
});

after(() => {
  server?.close();
  delete process.env.DATABASE_URL;
  delete process.env.ADMIN_EMAIL;
  delete process.env.ADMIN_PASSWORD;
  delete process.env.ADMIN_NAME;
});

test("bootstrap creates an ADMIN user whose password is bcrypt-hashed", async () => {
  const result = await bootstrapAdmin();
  assert.deepEqual(result, { email: ADMIN_EMAIL, role: "ADMIN" });

  const row = await prisma.user.findUnique({ where: { email: ADMIN_EMAIL } });
  assert.ok(row, "user row must exist");
  assert.equal(row.role, "ADMIN");
  assert.equal(row.name, "Prashant");
  assert.notEqual(row.password, ADMIN_PASSWORD, "plaintext must never be stored");
  assert.ok(row.password.startsWith("$2"), "stored password must be a bcrypt hash");
  assert.equal(await bcrypt.compare(ADMIN_PASSWORD, row.password), true);
  assert.equal(await bcrypt.compare("wrong-password", row.password), false);
});

test("login with the bootstrap credentials returns a JWT with role ADMIN", async () => {
  const res = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  assert.equal(res.status, 200);
  const d = await res.json();
  assert.ok(d.token, "JWT issued");
  assert.equal(d.user.email, ADMIN_EMAIL);
  assert.equal(d.user.role, "ADMIN");

  const me = await fetch(`${base}/api/auth/me`, { headers: { Authorization: `Bearer ${d.token}` } });
  assert.equal(me.status, 200);
  const m = await me.json();
  assert.equal(m.user.role, "ADMIN");
});

test("login with a wrong password is rejected", async () => {
  const res = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: "totally-wrong" }),
  });
  assert.equal(res.status, 401);
});

test("re-running bootstrap never creates duplicate users and keeps role ADMIN", async () => {
  await bootstrapAdmin();
  await bootstrapAdmin();
  const count = await prisma.user.count({ where: { email: ADMIN_EMAIL } });
  assert.equal(count, 1);
  const row = await prisma.user.findUnique({ where: { email: ADMIN_EMAIL } });
  assert.equal(row.role, "ADMIN");
  assert.equal(await bcrypt.compare(ADMIN_PASSWORD, row.password), true);
});

test("bootstrap fails cleanly when env vars are missing or too short", async () => {
  const saved = process.env.ADMIN_PASSWORD;
  delete process.env.ADMIN_PASSWORD;
  await assert.rejects(() => bootstrapAdmin(), /ADMIN_EMAIL and ADMIN_PASSWORD environment variables are required/);
  process.env.ADMIN_PASSWORD = "short";
  await assert.rejects(() => bootstrapAdmin(), /ADMIN_PASSWORD must be at least 8 characters long/);
  process.env.ADMIN_PASSWORD = saved;
});