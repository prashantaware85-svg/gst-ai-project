import { test } from "node:test";
import assert from "node:assert/strict";
import { rowsToCsv } from "../src/routes/reports.routes";

test("CSV export renders human-readable header from column keys", () => {
  const csv = rowsToCsv(
    ["vendorName", "bookInvoiceNo", "gstDiff", "status", "dateDiff"],
    [{ vendorName: "Acme Pvt Ltd", bookInvoiceNo: "ACME-001", gstDiff: -1000, status: "MISMATCHED", dateDiff: "" }],
  );
  const [header, row] = csv.split("\r\n");
  assert.equal(header, "Vendor,Books Invoice No,GST Diff,Status,Date Difference");
  assert.equal(row, "Acme Pvt Ltd,ACME-001,-1000,MISMATCHED,");
});

test("CSV export quotes fields containing comma, quote or newline", () => {
  const csv = rowsToCsv(
    ["vendorName", "aiWhat"],
    [{ vendorName: ' "Quoted", Inc.', aiWhat: "Line one\nLine two" }],
  );
  // inner quotes are doubled and the whole field wrapped in quotes
  assert.equal(csv, 'Vendor,AI - What is wrong\r\n" ""Quoted"", Inc.","Line one\nLine two"');
});