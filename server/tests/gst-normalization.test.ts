import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeInvoiceText,
  normalizeDate,
  toCents,
  amountFromCents,
  sumMoney,
  mapGstRow,
  validateGstRow,
  isoOf,
  gstTransactionKey,
} from "../src/services/gstNormalization.service";

test("normalizeInvoiceText uppercases and collapses whitespace but keeps / and -", () => {
  assert.equal(normalizeInvoiceText("  inv/001  "), "INV/001");
  assert.equal(normalizeInvoiceText("Inv No- 42 "), "INVNO-42");
});

test("toCents parses Indian grouping, currency symbols and plain numbers", () => {
  assert.equal(toCents("1,00,000.50"), 10000050);
  assert.equal(toCents("₹12,345"), 1234500);
  assert.equal(toCents(10000), 1000000);
  assert.equal(toCents("10000.5"), 1000050);
  assert.equal(toCents("abc"), null);
  assert.equal(toCents(""), null);
  assert.equal(toCents("-500"), -50000);
});

test("amountFromCents and sumMoney round to paise", () => {
  assert.equal(amountFromCents(10000050), 100000.5);
  assert.equal(sumMoney(100, 200.55, "10"), 310.55);
});

test("normalizeDate handles Date, DD/MM/YYYY, DD-MM-YYYY, ISO and Excel serials", () => {
  assert.equal(isoOf(normalizeDate("01/04/2026")!), "2026-04-01");
  assert.equal(isoOf(normalizeDate("01-04-2026")!), "2026-04-01");
  assert.equal(isoOf(normalizeDate("2026-04-01")!), "2026-04-01");
  assert.equal(isoOf(normalizeDate(new Date(Date.UTC(2026, 3, 1)))!), "2026-04-01");
  // Excel serial for 2026-04-01 (days since 1899-12-30) must round-trip.
  const anchor = new Date(Date.UTC(2026, 3, 1));
  const serial = Math.round((anchor.getTime() - Date.UTC(1899, 11, 30)) / 86400000);
  assert.equal(isoOf(normalizeDate(serial)!), "2026-04-01");
  // Fractional serials (date + time, e.g. from CSV parsing) keep the date part.
  assert.equal(isoOf(normalizeDate(serial + 0.00011574074)!), "2026-04-01");
  assert.equal(normalizeDate("not a date"), null);
  assert.equal(normalizeDate(""), null);
});

test("mapGstRow resolves alias spellings case-insensitively", () => {
  const raw = {
    "Invoice No.": "ACME-001",
    "gstin/uin": "27ABCDE1234F1Z5",
    "customer name": "Acme Traders",
    "Taxable": "10000",
    "CGST Amount": "900",
    "SGST Amount": "900",
    "Invoice Value": "11800",
    "Place of Supply (POS)": "27-Maharashtra",
    "HSN/SAC": "310290",
    "Document Type": "INV",
  };
  const { row, errors } = mapGstRow(raw, "GSTR1");
  assert.deepEqual(errors, []);
  assert.equal(row.invoiceNumber, "ACME-001");
  assert.equal(row.counterpartyGstin, "27ABCDE1234F1Z5");
  assert.equal(row.counterpartyName, "Acme Traders");
  assert.equal(row.taxableValue, 10000);
  assert.equal(row.cgst, 900);
  assert.equal(row.sgst, 900);
  assert.equal(row.invoiceValue, 11800);
  assert.equal(row.igst, 0);
  assert.equal(row.placeOfSupply, "27-Maharashtra");
  assert.equal(row.hsn, "310290");
  assert.equal(row.documentType, "INVOICE");
});

test("mapGstRow maps supplier-side headers for purchases", () => {
  const { row } = mapGstRow(
    { "Supplier GSTIN": " 27ABCDE1234F1Z5 ", "Invoice Number": "P-1", "Taxable Value": "500", "IGST": "90" },
    "GSTR2B",
  );
  assert.equal(row.counterpartyGstin, "27ABCDE1234F1Z5");
  assert.equal(row.igst, 90);
});

test("validateGstRow rejects missing invoice/date and invalid GSTIN formats", () => {
  const base = {
    gstin: null,
    counterpartyGstin: "27ABCDE1234F1Z5",
    counterpartyName: null,
    invoiceNumber: "INV-1",
    invoiceDate: new Date(Date.UTC(2026, 3, 1)),
    taxableValue: 1000,
    cgst: 90,
    sgst: 90,
    igst: 0,
    invoiceValue: 1180,
    placeOfSupply: null,
    hsn: null,
    documentType: null,
  };
  assert.deepEqual(validateGstRow(base, "GSTR1"), []);
  assert.ok(validateGstRow({ ...base, invoiceNumber: "" }, "GSTR1").some((e) => e.includes("Invoice number")));
  assert.ok(validateGstRow({ ...base, invoiceDate: null }, "GSTR1").some((e) => e.includes("Invoice date")));
  assert.ok(validateGstRow({ ...base, counterpartyGstin: "27-BAD-GSTIN" }, "GSTR1").some((e) => e.includes("GSTIN format")));
});

test("gstTransactionKey is deterministic and normalizes empties", () => {
  const a = {
    gstin: null,
    counterpartyGstin: "27ABCDE1234F1Z5",
    invoiceNumber: "INV-001",
    invoiceDate: new Date(Date.UTC(2026, 3, 1)),
  };
  const b = { ...a, counterpartyGstin: "27abcde1234f1z5" };
  assert.equal(gstTransactionKey(a, "GSTR1", "2026-04"), gstTransactionKey(b, "GSTR1", "2026-04"));
  // Different return type / period / invoice must not collide.
  assert.notEqual(gstTransactionKey(a, "GSTR1", "2026-04"), gstTransactionKey(a, "GSTR2B", "2026-04"));
  assert.notEqual(gstTransactionKey(a, "GSTR1", "2026-04"), gstTransactionKey(a, "GSTR1", "2026-05"));
});