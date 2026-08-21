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
// Real GST portal GSTR-1 JSON export for period 07/2026 (b2b/b2cs/hsn/doc_issue).
const REAL_JSON = readFileSync(path.join(__dirname, "fixtures", "gstr1-real-2026.json"));

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

test("GSTR1 real portal JSON: extracts all 20 B2B invoices from b2b[].inv", () => {
  const { entries, aggregated } = parseGstFileDetailed(REAL_JSON, "returns_20082026_R1_27ACGFA8244G1ZC_offline_others_0.json", "GSTR1");
  assert.equal(aggregated, 0);
  assert.equal(entries.length, 20); // matches sum of b2b[].inv across the 14 suppliers
  const invs = entries.map((e) => e.row.invoiceNumber).sort();
  assert.equal(invs[0], "ACO/26-27/10");
  assert.ok(invs.includes("ACO/26-27/45"));
  assert.ok(invs.includes("ACO/26-27/110"));
  // Own (filing) company GSTIN comes from the JSON's top-level gstin.
  assert.ok(entries.every((e) => e.row.gstin === "27ACGFA8244G1ZC"));
  // B2CS / HSN / doc_issue sums add no invoice rows.
  assert.ok(entries.every((e) => e.row.invoiceNumber.startsWith("ACO/")));
});

test("GSTR1 real portal JSON: invoice amounts, date, GSTIN and portal total are read", () => {
  const { entries } = parseGstFileDetailed(REAL_JSON, "gstr1-real-2026.json", "GSTR1");
  const inv45 = rowOf(entries, "ACO/26-27/45")!;
  assert.equal(inv45.row.counterpartyGstin, "27AAIFO8845M1ZG");
  assert.equal(isoOf(inv45.row.invoiceDate!), "2026-07-21");
  assert.equal(inv45.row.taxableValue, 28793.5);          // 19048 (5%) + 9745.5 (18%)
  assert.equal(inv45.row.cgst, 1353.3);                  // 476.2 + 877.1
  assert.equal(inv45.row.sgst, 1353.3);
  assert.equal(inv45.row.igst, 0);
  assert.equal(inv45.row.invoiceValue, 31500);           // portal `val` wins over the 0.1-derived sum
  const inv13 = rowOf(entries, "ACO/26-27/13")!;
  assert.equal(inv13.row.taxableValue, 118667.4);
  assert.equal(inv13.row.invoiceValue, 124601);
  const inv100 = rowOf(entries, "ACO/26-27/100")!;
  assert.equal(inv100.row.counterpartyGstin, "27BUWPK0351H1ZD");
  assert.equal(isoOf(inv100.row.invoiceDate!), "2026-07-28");
});

test("GSTR1 real portal JSON: validation marks all 20 as valid, none invalid", () => {
  const { entries } = parseGstFileDetailed(REAL_JSON, "gstr1-real-2026.json", "GSTR1");
  const batch = validateBatch(entries, "GSTR1", "2026-07");
  assert.equal(batch.totalRows, 20);
  assert.equal(batch.validRows.length, 20);
  assert.equal(batch.invalidRows.length, 0);
  assert.equal(batch.duplicates, 0);
});