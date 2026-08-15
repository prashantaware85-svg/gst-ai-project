import { test } from "node:test";
import assert from "node:assert/strict";
import {
  levenshtein,
  normalizeInvoiceNo,
  fuzzySame,
  invoiceKey,
  buildDuplicateExtras,
} from "../src/utils/fuzzy";

test("normalizeInvoiceNo strips prefixes and non-alphanumerics", () => {
  assert.equal(normalizeInvoiceNo("INVOICE-2024/042"), "2024042");
  assert.equal(normalizeInvoiceNo("INV-042"), "042");
  assert.equal(normalizeInvoiceNo("INVOICE-001"), "001");
  assert.equal(normalizeInvoiceNo("INVOICE-INV-001"), "001");
  assert.equal(normalizeInvoiceNo("ACME-001"), "ACME001");
  assert.equal(normalizeInvoiceNo("GLBX-101"), "GLBX101");
});

test("fuzzySame exact and normalized equality", () => {
  assert.equal(fuzzySame("ACME-001", "ACME-001"), true);
  assert.equal(fuzzySame("INVOICE-001", "INV-001"), true);
  assert.equal(fuzzySame("2024-042", "INVOICE-2024/042"), true);
});

test("fuzzySame leading-zero canonicalization (ACME-1 == ACME-01)", () => {
  assert.equal(fuzzySame("ACME-1", "ACME-01"), true);
  assert.equal(fuzzySame("GLBX-100", "GLBX-0100"), true);
});

test("fuzzySame rejects same-prefix different numeric sequences", () => {
  assert.equal(fuzzySame("ACME-001", "ACME-002"), false);
  assert.equal(fuzzySame("GLBX-101", "GLBX-102"), false);
});

test("fuzzySame small edit distance within tolerance", () => {
  assert.equal(fuzzySame("ACME-001", "ACME-00I"), true);
  assert.equal(fuzzySame("ACME-001", "GLBX-101"), false);
});

test("fuzzySame does not match a note number against its source invoice (prefix insertion)", () => {
  // "DN-GLBX-100" (debit note) differs from "GLBX-100" only by the inserted
  // "DN" prefix; they are two different documents and must not fuzzy-match.
  assert.equal(fuzzySame("GLBX-100", "DN-GLBX-100"), false);
  assert.equal(fuzzySame("CN-ACME-001", "ACME-001"), false);
  // A genuine keystroke typo still matches (same leading character).
  assert.equal(fuzzySame("DN-GLBX-100", "DN-GLBX-1O0"), true);
});

test("levenshtein basic cases", () => {
  assert.equal(levenshtein("kitten", "sitting"), 3);
  assert.equal(levenshtein("abc", "abc"), 0);
  assert.equal(levenshtein("", "abc"), 3);
});

test("invoiceKey groups leading-zero equivalents but not sequential invoices", () => {
  assert.equal(invoiceKey("ACME-1"), invoiceKey("ACME-01"));
  assert.notEqual(invoiceKey("ACME-001"), invoiceKey("ACME-002"));
  assert.equal(invoiceKey("GLBX-100"), invoiceKey("GLBX-0100"));
});

test("buildDuplicateExtras flags later occurrences, keeps first", () => {
  const items = [
    { id: 1, gstin: "27A", invoiceNo: "GLBX-101" },
    { id: 2, gstin: "27A", invoiceNo: "GLBX-101" },
    { id: 3, gstin: "27B", invoiceNo: "GLBX-101" },
  ];
  const extras = buildDuplicateExtras(items, (i) => `${i.gstin}|${invoiceKey(i.invoiceNo)}`);
  assert.deepEqual(
    [...extras].map((i) => i.id),
    [2],
  );
});

test("buildDuplicateExtras leaves single occurrences alone", () => {
  const items = [
    { id: 1, gstin: "27A", invoiceNo: "GLBX-101" },
    { id: 2, gstin: "27A", invoiceNo: "GLBX-102" },
  ];
  const extras = buildDuplicateExtras(items, (i) => `${i.gstin}|${invoiceKey(i.invoiceNo)}`);
  assert.equal(extras.size, 0);
});