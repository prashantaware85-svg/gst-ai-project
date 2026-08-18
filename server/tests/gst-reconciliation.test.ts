import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { classifyReconciliation, toGstForRecon } from "../src/services/gstReconciliation.service";
import type { TallyForRecon, GstForRecon } from "../src/services/gstReconciliation.service";

// Pure engine tests. A throwaway SQLite DB copy gives the reconciliation
// service a real prisma instance (harmless — the pure matcher never touches DB).
const TEST_DB = "C:/Users/User/AppData/Local/Temp/opencode/recon-engine-test.db";
const DEV_DB = "C:/Users/User/gst-ai-agent/server/prisma/dev.db";

import { copyFileSync, rmSync } from "node:fs";

let prisma: any;

before(async () => {
  rmSync(TEST_DB, { force: true });
  copyFileSync(DEV_DB, TEST_DB);
  process.env.DATABASE_URL = `file:${TEST_DB}`;
  const prismaMod = await import("../src/utils/prisma");
  prisma = prismaMod.prisma;
  await prisma.$connect();
});

after(async () => {
  delete process.env.DATABASE_URL;
  await prisma?.$disconnect();
});

function pick(v: Record<string, any>, key: string, dflt: unknown): unknown {
  return key in v ? v[key] : dflt;
}

function tally(partial: Record<string, any> & { id: number }): TallyForRecon {
  return {
    voucherNumber: pick(partial, "voucherNumber", "INV-001") as string,
    voucherDate: pick(partial, "voucherDate", new Date(Date.UTC(2026, 3, 1))) as Date,
    partyName: pick(partial, "partyName", "Customer") as string | null,
    partyGSTIN: pick(partial, "partyGSTIN", "27AAAAA0000A1Z5") as string | null,
    invoiceNumber: pick(partial, "invoiceNumber", partial.voucherNumber) as string | null,
    taxableValue: pick(partial, "taxableValue", 10000) as number,
    cgst: pick(partial, "cgst", 900) as number,
    sgst: pick(partial, "sgst", 900) as number,
    igst: pick(partial, "igst", 0) as number,
    roundOff: pick(partial, "roundOff", 0) as number,
    totalAmount: pick(partial, "totalAmount", 11800) as number,
    ...partial,
  };
}

function gst(partial: Record<string, any> & { id: number }): GstForRecon {
  return toGstForRecon({
    id: partial.id,
    gstin: null,
    counterpartyGstin: pick(partial, "counterpartyGstin", "27AAAAA0000A1Z5"),
    counterpartyName: pick(partial, "counterpartyName", "Customer"),
    invoiceNumber: pick(partial, "invoiceNumber", "INV-001"),
    invoiceDate: pick(partial, "invoiceDate", new Date(Date.UTC(2026, 3, 1))),
    taxableValue: pick(partial, "taxableValue", 10000),
    cgst: pick(partial, "cgst", 900),
    sgst: pick(partial, "sgst", 900),
    igst: pick(partial, "igst", 0),
    invoiceValue: pick(partial, "invoiceValue", 11800),
  });
}

function run(tallyRows: TallyForRecon[], gstRows: GstForRecon[]) {
  return classifyReconciliation(tallyRows, gstRows, "SALES", "2026-04");
}

test("exact match is MATCHED with confidence 100 and zero differences", () => {
  const rows = run([tally({ id: 1 })], [gst({ id: 10 })]);
  const r = rows[0];
  assert.equal(r.status, "MATCHED");
  assert.equal(r.confidence, 100);
  assert.equal(r.matchLevel, "LEVEL1");
  assert.equal(r.taxableDifference, 0);
  assert.equal(r.cgstDifference, 0);
  assert.equal(r.sgstDifference, 0);
  assert.equal(r.invoiceValueDifference, 0);
});

test("invoice number normalization treats INV-001 and INV001 as the same", () => {
  const rows = run([tally({ id: 1, voucherNumber: "INV-001", invoiceNumber: "INV-001" })], [gst({ id: 10, invoiceNumber: "INV001" })]);
  assert.equal(rows[0].status, "MATCHED");
  assert.equal(rows[0].confidence, 100);
});

test("strong match within the date tolerance window is MATCHED at 95", () => {
  const rows = run(
    [tally({ id: 1, voucherDate: new Date(Date.UTC(2026, 3, 2)) })],
    [gst({ id: 10, invoiceDate: new Date(Date.UTC(2026, 3, 1)) })],
  );
  const r = rows[0];
  assert.equal(r.status, "MATCHED");
  assert.equal(r.confidence, 95);
  assert.equal(r.matchLevel, "LEVEL2");
});

test("amount mismatch stores the actual difference and flags AMOUNT_MISMATCH", () => {
  const rows = run(
    [tally({ id: 1, taxableValue: 10000, totalAmount: 11800 })],
    [gst({ id: 10, taxableValue: 10005, invoiceValue: 11805 })],
  );
  const r = rows[0];
  assert.equal(r.status, "AMOUNT_MISMATCH");
  assert.equal(r.confidence, 90);
  assert.equal(r.taxableDifference, -5);
  assert.equal(r.invoiceValueDifference, -5);
});

test("₹1 tolerance keeps near-equal amounts as MATCHED", () => {
  const rows = run(
    [tally({ id: 1, taxableValue: 10000, totalAmount: 11800 })],
    [gst({ id: 10, taxableValue: 10000.99, invoiceValue: 11800.99 })],
  );
  assert.equal(rows[0].status, "MATCHED");
});

test("date mismatch flags DATE_MISMATCH when dates fall outside the window", () => {
  const rows = run(
    [tally({ id: 1, voucherDate: new Date(Date.UTC(2026, 3, 1)) })],
    [gst({ id: 10, invoiceDate: new Date(Date.UTC(2026, 4, 1)) })],
  );
  const r = rows[0];
  assert.equal(r.status, "DATE_MISMATCH");
  assert.equal(r.confidence, 90);
});

test("tally-only rows are MISSING_IN_GST", () => {
  const rows = run([tally({ id: 1, voucherNumber: "ONLY-TALLY" })], []);
  const r = rows[0];
  assert.equal(r.status, "MISSING_IN_GST");
  assert.equal(r.tallyTransactionId, 1);
});

test("gst-only rows are MISSING_IN_TALLY", () => {
  const rows = run([], [gst({ id: 10, invoiceNumber: "ONLY-GST" })]);
  const r = rows[0];
  assert.equal(r.status, "MISSING_IN_TALLY");
  assert.equal(r.gstTransactionId, 10);
});

test("duplicate Tally vouchers: first matches, later one is DUPLICATE_IN_TALLY", () => {
  const rows = run(
    [
      tally({ id: 1, voucherNumber: "DUP-001" }),
      tally({ id: 2, voucherNumber: "DUP-001" }),
    ],
    [gst({ id: 10, invoiceNumber: "DUP-001" })],
  );
  const first = rows.find((r) => r.tallyTransactionId === 1)!;
  const second = rows.find((r) => r.tallyTransactionId === 2)!;
  assert.equal(first.status, "MATCHED");
  assert.equal(second.status, "DUPLICATE_IN_TALLY");
  assert.equal(second.confidence, 75);
});

test("duplicate GST rows: first is matched, later one is DUPLICATE_IN_GST", () => {
  const rows = run(
    [tally({ id: 1, voucherNumber: "DUP-GST" })],
    [
      gst({ id: 10, invoiceNumber: "DUP-GST" }),
      gst({ id: 11, invoiceNumber: "DUP-GST" }),
    ],
  );
  const matched = rows.find((r) => r.status === "MATCHED")!;
  const dup = rows.find((r) => r.gstTransactionId === 11)!;
  assert.equal(matched.gstTransactionId, 10);
  assert.equal(dup.status, "DUPLICATE_IN_GST");
});

test("possible match: same invoice without GSTIN (unregistered party) at 75", () => {
  const rows = run(
    [tally({ id: 1, partyGSTIN: null, voucherNumber: "UNREG-001" })],
    [gst({ id: 10, counterpartyGstin: null, invoiceNumber: "UNREG-001" })],
  );
  const r = rows[0];
  assert.equal(r.status, "POSSIBLE_MATCH");
  assert.equal(r.confidence, 75);
});

test("possible match: fuzzy invoice similarity lands in the 60-79 band", () => {
  const rows = run(
    [tally({ id: 1, voucherNumber: "INV-001", taxableValue: 10000, totalAmount: 11800 })],
    [gst({ id: 10, invoiceNumber: "INV-001A", taxableValue: 10000, invoiceValue: 11800 })],
  );
  const r = rows[0];
  assert.equal(r.status, "POSSIBLE_MATCH");
  assert.ok(r.confidence >= 60 && r.confidence <= 79, `confidence ${r.confidence}`);
});

test("invoice number mismatch: amounts match but invoice numbers differ", () => {
  const rows = run(
    [tally({ id: 1, voucherNumber: "ACME-001", taxableValue: 5000, totalAmount: 5900 })],
    [gst({ id: 10, invoiceNumber: "ACME-999", taxableValue: 5000, invoiceValue: 5900 })],
  );
  const r = rows[0];
  assert.equal(r.status, "INVOICE_NUMBER_MISMATCH");
  assert.equal(r.confidence, 80);
});

test("GSTIN mismatch: same invoice number under a different GSTIN", () => {
  const rows = run(
    [tally({ id: 1, partyGSTIN: "27AAAAA0000A1Z5", voucherNumber: "X-1" })],
    [gst({ id: 10, counterpartyGstin: "29BBBBB1111B1Z5", invoiceNumber: "X-1" })],
  );
  const r = rows[0];
  assert.equal(r.status, "GSTIN_MISMATCH");
  assert.equal(r.confidence, 60);
});

test("invalid data rows are reported as INVALID_DATA, never crashing the run", () => {
  const rows = run(
    [tally({ id: 1, voucherNumber: "" })],
    [gst({ id: 10, invoiceNumber: "", invoiceDate: new Date(Date.UTC(2026, 3, 1)) })],
  );
  const tallyRow = rows.find((r) => r.tallyTransactionId === 1)!;
  const gstRow = rows.find((r) => r.gstTransactionId === 10)!;
  assert.equal(tallyRow.status, "INVALID_DATA");
  assert.equal(gstRow.status, "INVALID_DATA");
});