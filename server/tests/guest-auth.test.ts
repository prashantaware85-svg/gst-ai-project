import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import express from "express";
import bcrypt from "bcryptjs";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { guestAuthEnabled } from "../src/utils/config";

// All modules that construct PrismaClient (auth routes, auth middleware) or
// read UPLOAD_DIR/REPORT_DIR at load time are imported lazily AFTER the env is
// set, so the test process gets a throwaway copy of the (already migrated +
// seeded) dev database instead of a missing-env crash or an empty schema.
const TEST_DB = "C:/Users/User/AppData/Local/Temp/opencode/guest-auth-test.db";
const DEV_DB = "C:/Users/User/gst-ai-agent/server/prisma/dev.db";
const TMP_UPLOAD = "C:/Users/User/AppData/Local/Temp/opencode/guest-uploads";
const TMP_REPORT = "C:/Users/User/AppData/Local/Temp/opencode/guest-reports";
let base = "";
let server: Server | undefined;
let prisma: any;
let routers: Record<string, any>;

function setGuest(v: boolean) {
  process.env.GUEST_AUTH = v ? "true" : "false";
}

function setProd(v: boolean) {
  process.env.NODE_ENV = v ? "production" : "test";
}

async function guestToken(): Promise<string> {
  setGuest(true);
  setProd(true); // guest mode must also work in production (controlled)
  const res = await fetch(`${base}/api/auth/guest`, { method: "POST" });
  assert.equal(res.status, 200);
  const d = await res.json();
  return d.token as string;
}

before(async () => {
  rmSync(TEST_DB, { force: true });
  copyFileSync(DEV_DB, TEST_DB);
  process.env.DATABASE_URL = `file:${TEST_DB}`;
  process.env.UPLOAD_DIR = TMP_UPLOAD;
  process.env.REPORT_DIR = TMP_REPORT;
  mkdirSync(TMP_UPLOAD, { recursive: true });
  mkdirSync(TMP_REPORT, { recursive: true });
  setGuest(false);
  setProd(false);

  const authMod = await import("../src/routes/auth.routes");
  const dashMod = await import("../src/routes/dashboard.routes");
  const repMod = await import("../src/routes/reports.routes");
  const searchMod = await import("../src/routes/search.routes");
  const vendorsMod = await import("../src/routes/vendors.routes");
  const notifMod = await import("../src/routes/notifications.routes");
  const uploadMod = await import("../src/routes/upload.routes");
  const reconcileMod = await import("../src/routes/reconcile.routes");
  const prismaMod = await import("../src/utils/prisma");
  prisma = prismaMod.prisma;
  routers = {
    auth: authMod.authRouter,
    dashboard: dashMod.dashboardRouter,
    reports: repMod.reportsRouter,
    search: searchMod.searchRouter,
    vendors: vendorsMod.vendorsRouter,
    notifications: notifMod.notificationsRouter,
    upload: uploadMod.uploadRouter,
    reconcile: reconcileMod.reconcileRouter,
  };

  const app = express();
  app.use(express.json());
  app.use("/api", routers.auth);
  app.use("/api", routers.dashboard);
  app.use("/api", routers.reports);
  app.use("/api", routers.search);
  app.use("/api", routers.vendors);
  app.use("/api", routers.notifications);
  app.use("/api", routers.upload);
  app.use("/api", routers.reconcile);
  server = app.listen(0);
  await new Promise<void>((r) => server!.once("listening", r));
  base = `http://127.0.0.1:${(server!.address() as any).port}`;
});

after(() => {
  server?.close();
  delete process.env.GUEST_AUTH;
  setProd(false);
});

test("guestAuthEnabled() is off by default and on with GUEST_AUTH=true in production too", () => {
  delete process.env.GUEST_AUTH;
  setProd(true);
  assert.equal(guestAuthEnabled(), false);

  setGuest(true);
  assert.equal(guestAuthEnabled(), true); // controlled in production, still VIEWER-only
  setGuest(false);
});

test("guest login returns 403 when guest access is disabled", async () => {
  setGuest(false);
  setProd(true);
  const res = await fetch(`${base}/api/auth/guest`, { method: "POST" });
  assert.equal(res.status, 403);
});

test("guest login works in production when GUEST_AUTH=true and issues a VIEWER token", async () => {
  const token = await guestToken();
  assert.ok(token);
});

test("guest dashboard access returns 200 (read-only)", async () => {
  const token = await guestToken();
  const res = await fetch(`${base}/api/dashboard`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.summary);
});

test("guest reports access returns 200 (read-only)", async () => {
  const token = await guestToken();
  const res = await fetch(`${base}/api/reports?type=match`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(res.status, 200);
});

test("guest search access returns 200 (read-only)", async () => {
  const token = await guestToken();
  const res = await fetch(`${base}/api/search?q=acme`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(res.status, 200);
});

test("guest vendors access returns 200 (read-only)", async () => {
  const token = await guestToken();
  const res = await fetch(`${base}/api/vendors`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(res.status, 200);
});

test("guest notifications access returns 200 (own notifications only)", async () => {
  const token = await guestToken();
  const res = await fetch(`${base}/api/notifications`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(res.status, 200);
});

test("guest upload is blocked with 403", async () => {
  const token = await guestToken();
  const res = await fetch(`${base}/api/upload/purchase`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
  assert.equal(res.status, 403);
});

test("guest reconcile is blocked with 403", async () => {
  const token = await guestToken();
  const res = await fetch(`${base}/api/reconcile`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
  assert.equal(res.status, 403);
});

test("guest cannot create users (admin-only) with 403", async () => {
  const token = await guestToken();
  const res = await fetch(`${base}/api/auth/users`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "X", email: "x@test.local", password: "pass1234", role: "VIEWER" }),
  });
  assert.equal(res.status, 403);
});

test("dashboard without any token is still 401 (no auth bypass)", async () => {
  const res = await fetch(`${base}/api/dashboard`);
  assert.equal(res.status, 401);
});

test("existing login (JWT) still works and is unaffected by guest mode", async () => {
  setGuest(false);
  setProd(true);
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