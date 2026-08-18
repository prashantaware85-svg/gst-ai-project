import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import express from "express";
import jwt from "jsonwebtoken";
import net from "node:net";
import { copyFileSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { jwtSecret } from "../src/utils/config";

// Tally import tests. A throwaway express app plays the role of TallyPrime with
// a body that switches on the request type (company info vs Day Book vouchers).
// The database is a throwaway copy of the migrated dev database, so the import
// writes land on real tables (TallyImport / TallyImportRun) without touching
// the developer's data.
const TEST_DB = "C:/Users/User/AppData/Local/Temp/opencode/tally-import-test.db";
const DEV_DB = "C:/Users/User/gst-ai-agent/server/prisma/dev.db";
const SALES_XML = readFileSync(path.join(__dirname, "fixtures", "daybook-sales.xml"), "utf8");
const PURCHASE_EMPTY_XML = readFileSync(path.join(__dirname, "fixtures", "daybook-purchase-empty.xml"), "utf8");

const COMPANY_XML = `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE>
  <HEADER><VERSION>1</VERSION><STATUS>1</STATUS></HEADER>
  <BODY>
    <DESC/>
    <DATA>
      <COLLECTION>
        <COMPANY NAME="AGRICROP ORGANICS" RESERVEDNAME="">
          <NAME TYPE="String">AGRICROP ORGANICS</NAME>
          <ISGSTON TYPE="Logical">Yes</ISGSTON>
        </COMPANY>
      </COLLECTION>
    </DATA>
  </BODY>
</ENVELOPE>`;

let base = "";
let server: Server | undefined;
let mockTally: Server | undefined;
let tallyPort = 0;
let mockBody = SALES_XML;
let prisma: any;

before(async () => {
  rmSync(TEST_DB, { force: true });
  copyFileSync(DEV_DB, TEST_DB);
  process.env.DATABASE_URL = `file:${TEST_DB}`;

  const { tallyRouter } = await import("../src/routes/tally.routes");
  const prismaMod = await import("../src/utils/prisma");
  prisma = prismaMod.prisma;

  // The dev DB may already contain vouchers imported during a live E2E run, so
  // the throwaway copy must start from a clean Tally state or the fixture
  // import would dedupe against them and report 0 imported.
  await prisma.tallyImport.deleteMany({});
  await prisma.tallyImportRun.deleteMany({});

  // authenticate() resolves the user against the DB; stub it so no real user
  // rows are needed. ADMIN can import; VIEWER cannot.
  (prismaMod.prisma as any).user.findUnique = async ({ where }: { where: any }) => {
    if (where?.id === 1) return { id: 1, name: "Admin", email: "admin@test.local", password: "", role: "ADMIN" };
    if (where?.id === 2) return { id: 2, name: "Viewer", email: "viewer@test.local", password: "", role: "VIEWER" };
    return null;
  };

  const app = express();
  app.use(express.json());
  app.use("/api", tallyRouter);
  server = app.listen(0);
  await new Promise<void>((r) => server!.once("listening", r));
  base = `http://127.0.0.1:${(server!.address() as any).port}`;

  // Scriptable mock TallyPrime: company requests (ListOfCompanies) always get
  // the company envelope; voucher/Day Book requests get the scripted fixture.
  const tallyApp = express();
  tallyApp.use((req: express.Request, res: express.Response) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const reply = body.includes("ListOfCompanies") ? COMPANY_XML : mockBody;
      res.type("text/xml").send(reply);
    });
  });
  await new Promise<void>((r) => {
    mockTally = tallyApp.listen(0, "127.0.0.1", () => r());
  });
  tallyPort = (mockTally!.address() as any).port;
  process.env.TALLY_URL = `http://127.0.0.1:${tallyPort}`;
});

after(async () => {
  server?.close();
  mockTally?.closeAllConnections?.();
  mockTally?.close();
  delete process.env.TALLY_URL;
  await prisma?.$disconnect();
});

// A localhost URL whose port is guaranteed closed -> connection refused.
function closedPortUrl(): Promise<string> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as any).port;
      srv.close(() => resolve(`http://127.0.0.1:${port}`));
    });
    srv.on("error", reject);
  });
}

function token(id = 1) {
  return jwt.sign({ id, role: id === 1 ? "ADMIN" : "VIEWER" }, jwtSecret(), { expiresIn: "12h" });
}

const RANGE = "fromDate=2026-04-01&toDate=2027-03-31";

test("import sales saves the real Day Book vouchers and returns totals", async () => {
  mockBody = SALES_XML;
  const res = await fetch(`${base}/api/tally/import?type=sales&${RANGE}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token()}` },
  });
  assert.equal(res.status, 200);
  const d = await res.json();
  assert.equal(d.ok, true);
  assert.equal(d.voucherType, "Sales");
  assert.equal(d.imported, 2);
  assert.equal(d.skipped, 0);
  assert.equal(d.failed, 0);
  assert.equal(d.totals.count, 2);
  assert.equal(d.totals.taxableValue, 25856.9); // 5904.70 + 19952.20
  assert.equal(d.totals.cgst, 646.44);
  assert.equal(d.totals.sgst, 646.44);
  assert.equal(d.totals.igst, 0);
  assert.equal(d.totals.roundOff, 0.22);
  assert.equal(d.totals.totalAmount, 27150);
});

test("imported records are stored in the database with exact fields", async () => {
  const row = await prisma.tallyImport.findFirst({
    where: { voucherNumber: "ACO/26-27/227" },
  });
  assert.ok(row);
  assert.equal(row.voucherType, "Sales");
  assert.equal(row.companyName, "AGRICROP ORGANICS");
  assert.equal(row.partyName, "Akshay krishi kendra");
  assert.equal(row.partyGSTIN, null);
  assert.equal(row.invoiceNumber, "ACO/26-27/227");
  assert.equal(Number(row.taxableValue), 5904.7);
  assert.equal(Number(row.cgst), 147.62);
  assert.equal(Number(row.sgst), 147.62);
  assert.equal(Number(row.roundOff), 0.06);
  assert.equal(Number(row.totalAmount), 6200);
  const items = JSON.parse(row.items);
  assert.equal(items.length, 2);
  assert.equal(items[0].itemName, "COMFORT 30 250 ML");
  assert.equal(items[0].quantity, 10);
  assert.equal(items[0].hsn, "310290");
});

test("re-importing the same range skips duplicates (no double records)", async () => {
  mockBody = SALES_XML;
  const res = await fetch(`${base}/api/tally/import?type=sales&${RANGE}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token()}` },
  });
  assert.equal(res.status, 200);
  const d = await res.json();
  assert.equal(d.ok, true);
  assert.equal(d.imported, 0);
  assert.equal(d.skipped, 2);
  assert.equal(d.totals.count, 0);

  const count = await prisma.tallyImport.count({ where: { voucherType: "Sales" } });
  assert.equal(count, 2);
});

test("import purchases with an empty Tally response is not an error", async () => {
  mockBody = PURCHASE_EMPTY_XML;
  const res = await fetch(`${base}/api/tally/import?type=purchases&${RANGE}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token()}` },
  });
  assert.equal(res.status, 200);
  const d = await res.json();
  assert.equal(d.ok, true);
  assert.equal(d.voucherType, "Purchase");
  assert.equal(d.imported, 0);
  assert.equal(d.skipped, 0);
  assert.equal(d.totals.count, 0);
});

test("import summary reflects stored counts per voucher type", async () => {
  const res = await fetch(`${base}/api/tally/import/summary`, {
    headers: { Authorization: `Bearer ${token()}` },
  });
  assert.equal(res.status, 200);
  const d = await res.json();
  assert.equal(d.ok, true);
  assert.equal(d.total, 2);
  assert.equal(d.byVoucherType.Sales, 2);
  assert.equal(d.byVoucherType.Purchase, 0);
  assert.equal(d.last.Sales.count, 2); // stored Sales rows
  assert.equal(d.last.Sales.skipped, 2); // latest Sales run was the duplicate re-import
});

test("imports list returns the stored vouchers as plain numbers", async () => {
  const res = await fetch(`${base}/api/tally/imports?type=Sales`, {
    headers: { Authorization: `Bearer ${token()}` },
  });
  assert.equal(res.status, 200);
  const d = await res.json();
  assert.equal(d.ok, true);
  assert.equal(d.count, 2);
  const row = d.rows.find((r: any) => r.voucherNumber === "ACO/26-27/228");
  assert.ok(row);
  assert.equal(typeof row.taxableValue, "number");
  assert.equal(row.taxableValue, 19952.2);
  assert.equal(typeof row.items[0].amount, "number");
});

test("import validates the date range with a 400", async () => {
  const res = await fetch(`${base}/api/tally/import?type=sales&fromDate=2027-03-31&toDate=2026-04-01`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token()}` },
  });
  assert.equal(res.status, 400);
  const d = await res.json();
  assert.match(d.message, /before/);
});

test("import returns connected:false when TallyPrime is unreachable", async () => {
  process.env.TALLY_URL = await closedPortUrl();
  mockBody = SALES_XML;
  const res = await fetch(`${base}/api/tally/import?type=sales&${RANGE}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token()}` },
  });
  assert.equal(res.status, 200);
  const d = await res.json();
  assert.equal(d.ok, false);
  assert.equal(d.connected, false);
  process.env.TALLY_URL = `http://127.0.0.1:${tallyPort}`;
});

test("import returns 401 without a token", async () => {
  const res = await fetch(`${base}/api/tally/import?type=sales&${RANGE}`, { method: "POST" });
  assert.equal(res.status, 401);
});

test("import returns 403 for a VIEWER (import is ADMIN/ACCOUNTANT only)", async () => {
  const res = await fetch(`${base}/api/tally/import?type=sales&${RANGE}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token(2)}` },
  });
  assert.equal(res.status, 403);
});

test("import with a malformed Tally response fails cleanly", async () => {
  mockBody = "not xml at all {";
  const res = await fetch(`${base}/api/tally/import?type=sales&${RANGE}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token()}` },
  });
  assert.equal(res.status, 200);
  const d = await res.json();
  assert.equal(d.ok, false);
  assert.equal(d.message, "Received an invalid response from TallyPrime");
});
