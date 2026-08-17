import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import express from "express";
import bcrypt from "bcryptjs";
import { copyFileSync, rmSync } from "node:fs";
import { guestAuthEnabled } from "../src/utils/config";

// All modules that transitively construct PrismaClient (auth routes, auth
// middleware) are imported lazily AFTER DATABASE_URL is set, so the test
// process gets a throwaway copy of the (already migrated + seeded) dev
// database instead of a missing-env crash or an empty schema.
const TEST_DB = "C:/Users/User/AppData/Local/Temp/opencode/guest-auth-test.db";
const DEV_DB = "C:/Users/User/gst-ai-agent/server/prisma/dev.db";
let base = "";
let server: Server | undefined;
let authRouter: any;
let prisma: any;
let authenticate: any;
let authorize: any;

function setGuest(v: boolean) {
  process.env.GUEST_AUTH = v ? "true" : "false";
}

before(async () => {
  rmSync(TEST_DB, { force: true });
  copyFileSync(DEV_DB, TEST_DB);
  process.env.DATABASE_URL = `file:${TEST_DB}`;
  const authMod = await import("../src/routes/auth.routes");
  const midMod = await import("../src/middleware/auth.middleware");
  const prismaMod = await import("../src/utils/prisma");
  authRouter = authMod.authRouter;
  authenticate = midMod.authenticate;
  authorize = midMod.authorize;
  prisma = prismaMod.prisma;

  process.env.GUEST_AUTH = "false";
  process.env.NODE_ENV = "test";
  const app = express();
  app.use(express.json());
  app.use("/api", authRouter);
  app.get("/api/dashboard", authenticate, (_req: any, res: any) => res.json({ ok: true, user: _req.user }));
  app.post("/api/reconcile", authenticate, authorize("ADMIN", "ACCOUNTANT"), (_req: any, res: any) => res.json({ ok: true }));
  server = app.listen(0);
  await new Promise<void>((r) => server!.once("listening", r));
  base = `http://127.0.0.1:${(server!.address() as any).port}`;
});

after(() => {
  server?.close();
  delete process.env.GUEST_AUTH;
  process.env.NODE_ENV = "test";
});

test("guestAuthEnabled() is off by default and off in production", () => {
  delete process.env.GUEST_AUTH;
  process.env.NODE_ENV = "test";
  assert.equal(guestAuthEnabled(), false);

  process.env.GUEST_AUTH = "true";
  process.env.NODE_ENV = "production";
  assert.equal(guestAuthEnabled(), false); // production can never enable guest

  process.env.NODE_ENV = "test";
  assert.equal(guestAuthEnabled(), true);
  setGuest(false);
});

test("guest login returns 403 when guest access is disabled", async () => {
  setGuest(false);
  process.env.NODE_ENV = "test";
  const res = await fetch(`${base}/api/auth/guest`, { method: "POST" });
  assert.equal(res.status, 403);
});

test("guest login returns 403 in production even with GUEST_AUTH=true", async () => {
  setGuest(true);
  process.env.NODE_ENV = "production";
  const res = await fetch(`${base}/api/auth/guest`, { method: "POST" });
  assert.equal(res.status, 403);
  process.env.NODE_ENV = "test";
});

test("guest login issues a VIEWER token when enabled", async () => {
  setGuest(true);
  process.env.NODE_ENV = "test";
  const res = await fetch(`${base}/api/auth/guest`, { method: "POST" });
  assert.equal(res.status, 200);
  const d = await res.json();
  assert.ok(d.token);
  assert.equal(d.user.role, "VIEWER");
  assert.equal(d.user.email, "guest@demo.local");
  setGuest(false);
});

test("guest VIEWER token is rejected by write/ADMIN-only endpoints (403)", async () => {
  setGuest(true);
  process.env.NODE_ENV = "test";
  const guest = await (await fetch(`${base}/api/auth/guest`, { method: "POST" })).json();
  setGuest(false);

  const reconcile = await fetch(`${base}/api/reconcile`, {
    method: "POST",
    headers: { Authorization: `Bearer ${guest.token}` },
  });
  assert.equal(reconcile.status, 403); // authorize(ADMIN, ACCOUNTANT) blocks VIEWER
});

test("dashboard without any token is still 401 (no auth bypass)", async () => {
  setGuest(false);
  const res = await fetch(`${base}/api/dashboard`);
  assert.equal(res.status, 401);
});

test("dashboard with guest VIEWER token returns 200 (read-only access)", async () => {
  setGuest(true);
  process.env.NODE_ENV = "test";
  const guest = await (await fetch(`${base}/api/auth/guest`, { method: "POST" })).json();
  setGuest(false);

  const dash = await fetch(`${base}/api/dashboard`, { headers: { Authorization: `Bearer ${guest.token}` } });
  assert.equal(dash.status, 200);
  const body = await dash.json();
  assert.equal(body.user.role, "VIEWER");
});

test("existing login (JWT) still works and is unaffected by guest mode", async () => {
  setGuest(false);
  process.env.NODE_ENV = "test";
  const origFindUnique = prisma.user.findUnique;
  try {
    (prisma as any).user.findUnique = async ({ where }: { where: any }) => {
      if (where?.email === "admin@test.local") {
        return { id: 9, name: "Admin", email: "admin@test.local", password: bcrypt.hashSync("s3cure-pass-1", 10), role: "ADMIN" };
      }
      if (where?.id === 9) return { id: 9, name: "Admin", email: "admin@test.local", password: "", role: "ADMIN" };
      return null;
    };
    const loginRes = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "admin@test.local", password: "s3cure-pass-1" }),
    });
    assert.equal(loginRes.status, 200);
    const d = await loginRes.json();
    assert.ok(d.token);
    assert.equal(d.user.role, "ADMIN");

    const dash = await fetch(`${base}/api/dashboard`, { headers: { Authorization: `Bearer ${d.token}` } });
    assert.equal(dash.status, 200);
  } finally {
    (prisma as any).user.findUnique = origFindUnique;
  }
});