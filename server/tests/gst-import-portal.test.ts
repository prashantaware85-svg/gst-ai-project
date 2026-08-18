import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseGstFile, parseGstFileDetailed, validateBatch } from "../src/services/gstImport.service";
import { isoOf } from "../src/services/gstNormalization.service";

// Portal GSTR-1 offline-utility fixtures. The "GSTR1 Report" sheet carries the
// merged two-row header (Invoice | No./Date/Value) and rows with a recipient
// GSTIN; "b2b,sez,de" is the fallback used when the Report sheet is absent.
const PORTAL = readFileSync(path.join(__dirname, "fixtures", "gstr1-portal-sanitized.xls"));
const B2B_ONLY = readFileSync(path.join(__dirname, "fixtures", "gstr1-portal-b2b-only.xls"));

function rowOf(entries: { row: { invoiceNumber: string } }[], invoiceNumber: string) {
  return entries.find((e) => e.row.invoiceNumber === invoiceNumber);
}

test("GSTR1 portal xls: GSTR1 Report sheet is authoritative, excludes B2CS/empty-GSTIN rows", () => {
  const { entries, aggregated } = parseGstFileDetailed(PORTAL, "gstr1-portal-sanitized.xls", "GSTR1");
  assert.equal(aggregated, 1);
  const invs = entries.map((e) => e.row.invoiceNumber).sort();
  assert.deepEqual(invs, ["26-27/INV-001", "26-27/INV-002", "26-27/INV-003", "26-27/INV-004"]);
  // B2CS row without a recipient GSTIN is excluded; the Totals summary row
  // never leaks through as an invoice.
  assert.ok(!invs.includes("26-27/CASH-001"));
  assert.ok(entries.every((e) => !/total/i.test(e.row.invoiceNumber)));
  // Multi-rate rows collapse into a single invoice on the Report sheet.
  const inv002 = rowOf(entries, "26-27/INV-002");
  assert.equal(inv002.row.counterpartyGstin, "27BXYWE5678G2Z4");
  assert.equal(inv002.row.taxableValue, 1015.81); // 192 (0%) + 823.81 (5%)
  assert.equal(inv002.row.cgst, 20.6);
  assert.equal(inv002.row.sgst, 20.6);
  assert.equal(isoOf(inv002.row.invoiceDate!), "2026-07-02");
});

test("GSTR1 portal xls: Report-based validation passes 3 invoices and flags the malformed row", () => {
  const { entries } = parseGstFileDetailed(PORTAL, "gstr1-portal-sanitized.xls", "GSTR1");
  const batch = validateBatch(entries, "GSTR1", "2026-07");
  assert.equal(batch.totalRows, 4);
  assert.equal(batch.validRows.length, 3);
  assert.equal(batch.invalidRows.length, 1);
  assert.equal(batch.duplicates, 0);
  assert.ok(batch.invalidRows[0].errors.some((e) => e.includes("Taxable value is not numeric")));
});

test("GSTR1 portal xls: b2b,sez,de is the fallback and derives CGST/SGST from Rate", () => {
  const { entries, aggregated } = parseGstFileDetailed(B2B_ONLY, "gstr1-portal-b2b-only.xls", "GSTR1");
  assert.equal(aggregated, 1);
  const inv101 = rowOf(entries, "26-27/INV-101");
  assert.equal(inv101.row.cgst, 114.29); // 4571.43 * 5% / 2 per head
  assert.equal(inv101.row.sgst, 114.29);
  assert.equal(inv101.row.invoiceValue, 4800);
  assert.equal(inv101.row.placeOfSupply, "27-Maharashtra");
  const inv102 = rowOf(entries, "26-27/INV-102");
  assert.equal(inv102.row.taxableValue, 1015.81); // multi-rate merged
  assert.equal(inv102.row.cgst, 20.6);
  const inv103 = rowOf(entries, "26-27/INV-103");
  assert.equal(inv103.row.cgst, 81); // 900 * 18% / 2
  assert.equal(inv103.row.sgst, 81);
});

test("GSTR1 portal xls: exact duplicate invoices report as duplicates after aggregation", () => {
  const { entries } = parseGstFileDetailed(B2B_ONLY, "gstr1-portal-b2b-only.xls", "GSTR1");
  const batch = validateBatch(entries, "GSTR1", "2026-07");
  assert.equal(batch.totalRows, 4);
  assert.equal(batch.validRows.length, 3);
  assert.equal(batch.duplicates, 1);
  assert.ok(batch.errors.some((e) => e.includes("Duplicate invoice")));
});

test("parseGstFile agrees with parseGstFileDetailed on entry count", () => {
  assert.equal(parseGstFile(PORTAL, "gstr1-portal-sanitized.xls", "GSTR1").length, 4);
});