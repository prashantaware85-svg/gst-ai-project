import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcilePurchases, reconcileSales } from "../src/services/reconciliation.service";

function inv(partial: Record<string, any> & { id: number; gstin: string; invoiceNo: string }) {
  return {
    vendorName: partial.vendorName ?? null,
    invoiceDate: partial.invoiceDate ?? new Date(2026, 0, 1),
    taxableValue: partial.taxableValue ?? 100000,
    cgst: partial.cgst ?? 0,
    sgst: partial.sgst ?? 0,
    igst: partial.igst ?? 0,
    cess: partial.cess ?? 0,
    noteType: "INVOICE",
    ...partial,
  };
}

test("purchase reconciliation classifies MATCHED correctly", async () => {
  const purchase = [inv({ id: 1, gstin: "27AAAAA0000A1Z5", invoiceNo: "ACME-001", taxableValue: 100000, cgst: 9000, sgst: 9000 })];
  const twoB = [inv({ id: 10, gstin: "27AAAAA0000A1Z5", invoiceNo: "ACME-001", taxableValue: 100000, cgst: 9000, sgst: 9000 })];
  const rows = await reconcilePurchases(purchase, twoB, 1);
  const r = rows.find((x) => x.bookInvoiceId === 1)!;
  assert.equal(r.status, "MATCHED");
  assert.equal(r.itcEligible, 18000);
  assert.equal(r.itcPending, 0);
  assert.equal(r.gstDiff, 0);
});

test("purchase reconciliation detects amount mismatch and pending ITC", async () => {
  const purchase = [inv({ id: 1, gstin: "27AAAAA0000A1Z5", invoiceNo: "ACME-003", taxableValue: 200000, cgst: 18000, sgst: 18000 })];
  const twoB = [inv({ id: 10, gstin: "27AAAAA0000A1Z5", invoiceNo: "ACME-003", taxableValue: 200000, cgst: 17000, sgst: 17000 })];
  const rows = await reconcilePurchases(purchase, twoB, 1);
  const r = rows.find((x) => x.bookInvoiceId === 1)!;
  assert.equal(r.status, "MISMATCHED");
  assert.ok(r.mismatchTypes.includes("WRONG_TAX"));
  assert.equal(r.itcEligible, 34000);
  assert.equal(r.itcPending, 2000);
});

test("purchase reconciliation exposes wrong-GSTIN matches", async () => {
  const purchase = [inv({ id: 1, gstin: "27AAAAA0000A1Z5", invoiceNo: "WRONG-001", igst: 10800 })];
  const twoB = [inv({ id: 10, gstin: "27BBBBB1111B1Z5", invoiceNo: "WRONG-001", igst: 10800 })];
  const rows = await reconcilePurchases(purchase, twoB, 1);
  const r = rows.find((x) => x.bookInvoiceId === 1)!;
  assert.equal(r.status, "MISMATCHED");
  assert.ok(r.mismatchTypes.includes("WRONG_GSTIN"));
});

test("purchase reconciliation flags MISSING_IN_2B", async () => {
  const purchase = [inv({ id: 1, gstin: "27AAAAA0000A1Z5", invoiceNo: "GLBX-100", igst: 13500 })];
  const rows = await reconcilePurchases(purchase, [], 1);
  const r = rows.find((x) => x.bookInvoiceId === 1)!;
  assert.equal(r.status, "MISSING_IN_2B");
  assert.equal(r.itcPending, 13500);
});

test("purchase reconciliation flags MISSING_IN_BOOKS for 2B-only rows", async () => {
  const twoB = [inv({ id: 10, gstin: "27AAAAA0000A1Z5", invoiceNo: "INTC-999", cgst: 10800, sgst: 10800 })];
  const rows = await reconcilePurchases([], twoB, 1);
  const r = rows.find((x) => x.twoBInvoiceId === 10)!;
  assert.equal(r.status, "MISSING_IN_BOOKS");
  assert.equal(r.itcEligible, 0);
  assert.equal(r.itcPending, 0);
});

test("purchase duplicate detection: first occurrence only owns ITC", async () => {
  const purchase = [
    inv({ id: 1, gstin: "27AAAAA0000A1Z5", invoiceNo: "GLBX-101", igst: 5400 }),
    inv({ id: 2, gstin: "27AAAAA0000A1Z5", invoiceNo: "GLBX-101", igst: 5400 }),
  ];
  const rows = await reconcilePurchases(purchase, [], 1);
  const first = rows.find((x) => x.bookInvoiceId === 1)!;
  const second = rows.find((x) => x.bookInvoiceId === 2)!;
  assert.equal(first.status, "DUPLICATE");
  assert.equal(second.status, "DUPLICATE");
  assert.equal(first.itcEligible, 5400); // first owns it
  assert.equal(second.itcEligible, 0);   // duplicate carries zero
});

test("sales reconciliation classifies MATCHED and MISSING_IN_GSTR1", async () => {
  const sales = [
    inv({ id: 1, gstin: "27AAAAA0000A1Z5", invoiceNo: "SALES-001", taxableValue: 100000, cgst: 9000, sgst: 9000 }),
    inv({ id: 2, gstin: "27CCCCC3333C1Z5", invoiceNo: "SALES-002", taxableValue: 50000, igst: 9000, invoiceDate: new Date(2026, 1, 5) }),
  ];
  const gstr1 = [inv({ id: 10, gstin: "27AAAAA0000A1Z5", invoiceNo: "SALES-001", taxableValue: 100000, cgst: 9000, sgst: 9000 })];
  const rows = await reconcileSales(sales, gstr1, 1);
  assert.equal(rows.find((x) => x.salesInvoiceId === 1)!.status, "MATCHED");
  assert.equal(rows.find((x) => x.salesInvoiceId === 2)!.status, "MISSING_IN_GSTR1");
});

test("credit note matches 2B note even with negated books amounts", async () => {
  // Books typically record a credit note as a negative reduction; the portal
  // lists it positively. Magnitudes must be compared, so the pair is MATCHED
  // and ITC is negative (reduces credit).
  const purchase = [inv({
    id: 1, gstin: "27AAAAA0000A1Z5", invoiceNo: "CN-ACME-001",
    taxableValue: -10000, cgst: -900, sgst: -900, noteType: "CREDIT_NOTE",
  })];
  const twoB = [inv({
    id: 10, gstin: "27AAAAA0000A1Z5", invoiceNo: "CN-ACME-001",
    taxableValue: 10000, cgst: 900, sgst: 900, noteType: "CREDIT_NOTE",
  })];
  const rows = await reconcilePurchases(purchase, twoB, 1);
  const r = rows.find((x) => x.bookInvoiceId === 1)!;
  assert.equal(r.status, "MATCHED");
  assert.equal(r.gstDiff, 0);
  assert.equal(r.itcEligible, -1800); // credit note reduces ITC
  assert.equal(r.itcPending, 0);
});

test("invoice number never fuzzy-matches a note against its source invoice", async () => {
  // GLBX-100 (invoice) and DN-GLBX-100 (debit note) must stay distinct, so the
  // true debit note still finds its 2B counterpart instead of being consumed.
  const purchase = [
    inv({ id: 1, gstin: "29XYZAB5678C1Z2", invoiceNo: "GLBX-100", taxableValue: 75000, igst: 13500 }),
    inv({ id: 2, gstin: "29XYZAB5678C1Z2", invoiceNo: "DN-GLBX-100", taxableValue: 5000, igst: 900, noteType: "DEBIT_NOTE" }),
  ];
  const twoB = [
    inv({ id: 10, gstin: "29XYZAB5678C1Z2", invoiceNo: "DN-GLBX-100", taxableValue: 5000, igst: 900, noteType: "DEBIT_NOTE" }),
  ];
  const rows = await reconcilePurchases(purchase, twoB, 1);
  const invoice = rows.find((x) => x.bookInvoiceId === 1)!;
  const note = rows.find((x) => x.bookInvoiceId === 2)!;
  assert.equal(invoice.status, "MISSING_IN_2B");       // GLBX-100 not in 2B
  assert.equal(note.status, "MATCHED");                // DN-GLBX-100 matched its note
  assert.equal(note.twoBInvoiceId, 10);
});