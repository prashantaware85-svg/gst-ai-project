import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import express from "express";
import jwt from "jsonwebtoken";
import net from "node:net";
import { readFileSync } from "node:fs";
import path from "node:path";
import { jwtSecret } from "../src/utils/config";

// TallyPrime connector tests. A throwaway express app plays the role of
// TallyPrime (its response body is scripted per test); an already-closed local
// port plays an unreachable TallyPrime. The DB lookup inside authenticate is
// stubbed so no real database is touched.
let base = "";
let server: Server | undefined;
let mockTally: Server | undefined;
let tallyPort = 0;
let mockBody = "<RESPONSE><STATUS>200</STATUS></RESPONSE>";
let lastTallyBody = "";

const COMPANY_XML = `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE>
  <HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>ListOfCompanies</ID></HEADER>
  <BODY>
    <DESC/>
    <DATA>
      <COLLECTION>
        <COMPANY NAME="ABC Pvt Ltd" RESERVEDNAME="">
          <NAME TYPE="String">ABC Pvt Ltd</NAME>
          <GSTIN TYPE="String">27AABCU9603R1ZM</GSTIN>
        </COMPANY>
        <COMPANY NAME="DEF Trading Co" RESERVEDNAME="">
          <NAME TYPE="String">DEF Trading Co</NAME>
          <GSTIN TYPE="String">27AAQCA1234F1ZP</GSTIN>
        </COMPANY>
      </COLLECTION>
    </DATA>
  </BODY>
</ENVELOPE>`;

// Real TallyPrime export with a company that has NO GST number configured.
const COMPANY_XML_NO_GSTIN = `<?xml version="1.0"?>
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

before(async () => {
  process.env.DATABASE_URL = "file:C:/Users/User/AppData/Local/Temp/opencode/tally-test.db";
  const { tallyRouter } = await import("../src/routes/tally.routes");
  const prismaMod = await import("../src/utils/prisma");

  (prismaMod.prisma as any).user.findUnique = async ({ where }: { where: any }) => {
    if (where?.id === 1) return { id: 1, name: "Admin", email: "admin@test.local", password: "", role: "ADMIN" };
    return null;
  };

  const app = express();
  app.use(express.json());
  app.use("/api", tallyRouter);
  server = app.listen(0);
  await new Promise<void>((r) => server!.once("listening", r));
  base = `http://127.0.0.1:${(server!.address() as any).port}`;

  // Scriptable mock TallyPrime. Also records the last request body so tests can
  // assert on the envelope Tally receives.
  const tallyApp = express();
  tallyApp.use((req: express.Request, res: express.Response) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      lastTallyBody = body;
      res.type("text/xml").send(mockBody);
    });
  });
  await new Promise<void>((r) => {
    mockTally = tallyApp.listen(0, "127.0.0.1", () => r());
  });
  tallyPort = (mockTally!.address() as any).port;
});

after(() => {
  server?.close();
  // Force-close any keep-alive sockets so the test process can exit.
  mockTally?.closeAllConnections?.();
  mockTally?.close();
  delete process.env.TALLY_URL;
});

function pointAtMockTally() {
  process.env.TALLY_URL = `http://127.0.0.1:${tallyPort}`;
}

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

function token() {
  return jwt.sign({ id: 1, role: "ADMIN" }, jwtSecret(), { expiresIn: "12h" });
}

// --- /tally/status ---

test("status returns connected:true when TallyPrime responds", async () => {
  pointAtMockTally();
  mockBody = "<RESPONSE><STATUS>200</STATUS></RESPONSE>";
  const res = await fetch(`${base}/api/tally/status`, { headers: { Authorization: `Bearer ${token()}` } });
  assert.equal(res.status, 200);
  const d = await res.json();
  assert.equal(d.connected, true);
  assert.equal(d.message, "TallyPrime is running");
});

test("status returns connected:false when TallyPrime is unreachable", async () => {
  process.env.TALLY_URL = await closedPortUrl();
  const res = await fetch(`${base}/api/tally/status`, { headers: { Authorization: `Bearer ${token()}` } });
  assert.equal(res.status, 200);
  const d = await res.json();
  assert.equal(d.connected, false);
  assert.equal(d.message, "Unable to connect to TallyPrime");
});

test("status returns 401 without a token", async () => {
  const res = await fetch(`${base}/api/tally/status`);
  assert.equal(res.status, 401);
});

// --- /tally/company ---

test("company returns connected:true with companyName + gstin when found", async () => {
  pointAtMockTally();
  mockBody = COMPANY_XML;
  const res = await fetch(`${base}/api/tally/company`, { headers: { Authorization: `Bearer ${token()}` } });
  assert.equal(res.status, 200);
  const d = await res.json();
  assert.equal(d.connected, true);
  assert.equal(d.companyName, "ABC Pvt Ltd");
  assert.equal(d.gstin, "27AABCU9603R1ZM");
  assert.equal(d.message, "Company information retrieved");
});

test("company returns connected:true with gstin:null when Tally provides no GST number", async () => {
  pointAtMockTally();
  mockBody = COMPANY_XML_NO_GSTIN;
  const res = await fetch(`${base}/api/tally/company`, { headers: { Authorization: `Bearer ${token()}` } });
  assert.equal(res.status, 200);
  const d = await res.json();
  assert.equal(d.connected, true);
  assert.equal(d.companyName, "AGRICROP ORGANICS");
  assert.equal(d.gstin, null);
  assert.equal(d.message, "Company information retrieved");
});

test("company returns connected:false when TallyPrime is unreachable", async () => {
  process.env.TALLY_URL = await closedPortUrl();
  const res = await fetch(`${base}/api/tally/company`, { headers: { Authorization: `Bearer ${token()}` } });
  assert.equal(res.status, 200);
  const d = await res.json();
  assert.equal(d.connected, false);
  assert.equal(d.message, "Unable to connect to TallyPrime");
});

test("company returns 401 without a token", async () => {
  const res = await fetch(`${base}/api/tally/company`);
  assert.equal(res.status, 401);
});

test("company handles a malformed Tally response clearly", async () => {
  pointAtMockTally();
  mockBody = "this is not xml at all {";
  const res = await fetch(`${base}/api/tally/company`, { headers: { Authorization: `Bearer ${token()}` } });
  assert.equal(res.status, 200);
  const d = await res.json();
  assert.equal(d.connected, false);
  assert.equal(d.message, "Received an invalid response from TallyPrime");
});

test("company reports clearly when Tally responds but no company is loaded", async () => {
  pointAtMockTally();
  mockBody = `<?xml version="1.0"?><ENVELOPE><BODY><DATA><COLLECTION NAME="ListOfCompanies"></COLLECTION></DATA></BODY></ENVELOPE>`;
  const res = await fetch(`${base}/api/tally/company`, { headers: { Authorization: `Bearer ${token()}` } });
  assert.equal(res.status, 200);
  const d = await res.json();
  assert.equal(d.connected, false);
  assert.equal(d.message, "No company is currently loaded in TallyPrime");
});

// --- /tally/sales + /tally/purchases ---

// Real TallyPrime captures (AGRICROP ORGANICS, FY 2026-27). daybook-sales.xml
// is the live Day Book export: 2 Sales vouchers (ACO/26-27/227, ACO/26-27/228)
// with exact CGST/SGST/Round Off ledgers and item-level stock entries. The
// company has no Purchase vouchers, and daybook-purchase-empty.xml is its real
// (STATUS=1, zero vouchers) response.
const SALES_XML = readFileSync(path.join(__dirname, "fixtures", "daybook-sales.xml"), "utf8");
const PURCHASE_EMPTY_XML = readFileSync(path.join(__dirname, "fixtures", "daybook-purchase-empty.xml"), "utf8");

// The Indian financial year containing the current date.
function expectedFinancialYear(): { from: string; to: string } {
  const now = new Date();
  const y = now.getFullYear();
  const month = now.getMonth() + 1;
  return month >= 4 ? { from: `${y}-04-01`, to: `${y + 1}-03-31` } : { from: `${y - 1}-04-01`, to: `${y}-03-31` };
}

test("sales sends a Day Book export filtered to the Sales voucher type", async () => {
  pointAtMockTally();
  mockBody = SALES_XML;
  await fetch(`${base}/api/tally/sales?fromDate=2026-04-01&toDate=2026-08-31`, {
    headers: { Authorization: `Bearer ${token()}` },
  });
  assert.match(lastTallyBody, /<ID>DayBook<\/ID>/);
  assert.match(lastTallyBody, /<SVEXPORTFORMAT>\$\$SysName:XML<\/SVEXPORTFORMAT>/);
  assert.match(lastTallyBody, /<SVFROMDATE TYPE="Date">01-Apr-2026<\/SVFROMDATE>/);
  assert.match(lastTallyBody, /<SVTODATE TYPE="Date">31-Aug-2026<\/SVTODATE>/);
  assert.match(lastTallyBody, /VchTypeFilter/);
  assert.match(lastTallyBody, /\$VoucherTypeName = "Sales"/);
});

test("purchases sends the Purchase voucher-type filter", async () => {
  pointAtMockTally();
  mockBody = PURCHASE_EMPTY_XML;
  await fetch(`${base}/api/tally/purchases`, { headers: { Authorization: `Bearer ${token()}` } });
  assert.match(lastTallyBody, /\$VoucherTypeName = "Purchase"/);
});

test("sales returns the real Day Book vouchers normalised", async () => {
  pointAtMockTally();
  mockBody = SALES_XML;
  const res = await fetch(`${base}/api/tally/sales`, { headers: { Authorization: `Bearer ${token()}` } });
  assert.equal(res.status, 200);
  const d = await res.json();
  assert.equal(d.connected, true);
  assert.equal(d.count, 2);
  assert.equal(d.fromDate, expectedFinancialYear().from);
  assert.equal(d.toDate, expectedFinancialYear().to);

  const [v1, v2] = d.vouchers;

  assert.equal(v1.voucherNumber, "ACO/26-27/227");
  assert.equal(v1.voucherDate, "2026-08-18"); // <DATE>20260818</DATE> -> ISO
  assert.equal(v1.voucherType, "Sales");
  assert.equal(v1.partyName, "Akshay krishi kendra");
  assert.equal(v1.partyGSTIN, null); // empty <PARTYGSTIN/> -> null (never CMPGSTIN)
  assert.equal(v1.invoiceNumber, "ACO/26-27/227"); // BILLALLOCATIONS.LIST > NAME
  assert.equal(v1.taxableValue, 5904.7); // 2476.10 + 3428.60
  assert.equal(v1.cgst, 147.62);
  assert.equal(v1.sgst, 147.62);
  assert.equal(v1.igst, 0);
  assert.equal(v1.roundOff, 0.06);
  assert.equal(v1.totalAmount, 6200); // |party ledger|
  assert.equal(v1.items.length, 2);

  const item = v1.items[0];
  assert.equal(item.itemName, "COMFORT 30 250 ML");
  assert.equal(item.quantity, 10);
  assert.equal(item.unit, "NOS");
  assert.equal(item.rate, 247.61);
  assert.equal(item.rateUnit, "NOS");
  assert.equal(item.amount, 2476.1);
  assert.equal(item.hsn, "310290");

  const item2 = v1.items[1];
  assert.equal(item2.itemName, "MAHABALWAN 20 ML (2ML*10 AMPULE)");
  assert.equal(item2.quantity, 10);
  assert.equal(item2.unit, "PAC");
  assert.equal(item2.rate, 342.86);
  assert.equal(item2.rateUnit, "PAC");
  assert.equal(item2.amount, 3428.6);
  assert.equal(item2.hsn, "31010099");

  assert.equal(v2.voucherNumber, "ACO/26-27/228");
  assert.equal(v2.voucherDate, "2026-08-18");
  assert.equal(v2.voucherType, "Sales");
  assert.equal(v2.partyName, "RAJMATA SHETKARI KENDRA");
  assert.equal(v2.partyGSTIN, "27DWPPG5606A1ZO");
  assert.equal(v2.invoiceNumber, "ACO/26-27/228");
  assert.equal(v2.taxableValue, 19952.2); // 10285.80 + 4952.20 + 4714.20
  assert.equal(v2.cgst, 498.82);
  assert.equal(v2.sgst, 498.82);
  assert.equal(v2.igst, 0);
  assert.equal(v2.roundOff, 0.16);
  assert.equal(v2.totalAmount, 20950);
  assert.equal(v2.items.length, 3);

  // Raw stays close to Tally (attributes preserved) while vouchers are
  // normalised (YYYYMMDD -> ISO).
  assert.equal(d.raw[0].PARTYLEDGERNAME, "Akshay krishi kendra");
  assert.equal(d.raw[0]["@_VCHTYPE"], "Sales");
});

test("sales honours explicit fromDate/toDate", async () => {
  pointAtMockTally();
  mockBody = SALES_XML;
  const res = await fetch(
    `${base}/api/tally/sales?fromDate=2026-04-01&toDate=2026-08-31`,
    { headers: { Authorization: `Bearer ${token()}` } },
  );
  assert.equal(res.status, 200);
  const d = await res.json();
  assert.equal(d.connected, true);
  assert.equal(d.fromDate, "2026-04-01");
  assert.equal(d.toDate, "2026-08-31");
});

test("sales returns connected:false when TallyPrime is unreachable", async () => {
  process.env.TALLY_URL = await closedPortUrl();
  const res = await fetch(`${base}/api/tally/sales`, { headers: { Authorization: `Bearer ${token()}` } });
  assert.equal(res.status, 200);
  const d = await res.json();
  assert.equal(d.connected, false);
  assert.equal(d.message, "Unable to connect to TallyPrime");
});

test("sales returns 401 without a token", async () => {
  const res = await fetch(`${base}/api/tally/sales`);
  assert.equal(res.status, 401);
});

test("sales validates date format with a 400", async () => {
  pointAtMockTally();
  mockBody = SALES_XML;
  const res = await fetch(`${base}/api/tally/sales?fromDate=01/08/2026`, { headers: { Authorization: `Bearer ${token()}` } });
  assert.equal(res.status, 400);
  const d = await res.json();
  assert.match(d.message, /fromDate/);
});

test("sales rejects fromDate after toDate with a 400", async () => {
  pointAtMockTally();
  mockBody = SALES_XML;
  const res = await fetch(
    `${base}/api/tally/sales?fromDate=2026-08-31&toDate=2026-04-01`,
    { headers: { Authorization: `Bearer ${token()}` } },
  );
  assert.equal(res.status, 400);
  const d = await res.json();
  assert.match(d.message, /before/);
});

test("sales handles an empty voucher list as connected with count 0", async () => {
  pointAtMockTally();
  mockBody = `<?xml version="1.0"?><ENVELOPE><BODY><DATA></DATA></BODY></ENVELOPE>`;
  const res = await fetch(`${base}/api/tally/sales`, { headers: { Authorization: `Bearer ${token()}` } });
  assert.equal(res.status, 200);
  const d = await res.json();
  assert.equal(d.connected, true);
  assert.equal(d.count, 0);
  assert.deepEqual(d.vouchers, []);
});

test("sales handles a malformed Tally response clearly", async () => {
  pointAtMockTally();
  mockBody = "not xml at all {";
  const res = await fetch(`${base}/api/tally/sales`, { headers: { Authorization: `Bearer ${token()}` } });
  assert.equal(res.status, 200);
  const d = await res.json();
  assert.equal(d.connected, false);
  assert.equal(d.message, "Received an invalid response from TallyPrime");
});

test("purchases returns connected with count 0 when no Purchase vouchers exist", async () => {
  pointAtMockTally();
  mockBody = PURCHASE_EMPTY_XML;
  const res = await fetch(`${base}/api/tally/purchases`, { headers: { Authorization: `Bearer ${token()}` } });
  assert.equal(res.status, 200);
  const d = await res.json();
  assert.equal(d.connected, true);
  assert.equal(d.count, 0);
  assert.deepEqual(d.vouchers, []);
});

test("purchases returns connected:false when TallyPrime is unreachable", async () => {
  process.env.TALLY_URL = await closedPortUrl();
  const res = await fetch(`${base}/api/tally/purchases`, { headers: { Authorization: `Bearer ${token()}` } });
  assert.equal(res.status, 200);
  const d = await res.json();
  assert.equal(d.connected, false);
  assert.equal(d.message, "Unable to connect to TallyPrime");
});

test("purchases returns 401 without a token", async () => {
  const res = await fetch(`${base}/api/tally/purchases`);
  assert.equal(res.status, 401);
});

test("purchases validates date format with a 400", async () => {
  pointAtMockTally();
  mockBody = PURCHASE_EMPTY_XML;
  const res = await fetch(`${base}/api/tally/purchases?toDate=invalid`, { headers: { Authorization: `Bearer ${token()}` } });
  assert.equal(res.status, 400);
  const d = await res.json();
  assert.match(d.message, /toDate/);
});
