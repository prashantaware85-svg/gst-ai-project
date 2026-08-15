import { test } from "node:test";
import assert from "node:assert/strict";
import { round3, totalTax, computeItc, EPSILON } from "../src/utils/gst";

test("round3 rounds to three decimals", () => {
  assert.equal(round3(1.234567), 1.235);
  assert.equal(round3(100.0001), 100);
  assert.equal(round3(-1.234567), -1.235);
});

test("totalTax sums CGST + SGST + IGST and rounds", () => {
  assert.equal(totalTax(9000, 9000, 0), 18000);
  assert.equal(totalTax(0, 0, 13500), 13500);
  assert.equal(totalTax(1.234, 1.234, 0), 2.468);
  assert.equal(totalTax(undefined as any, 9000, 0), 9000);
});

test("EPSILON is the Rs.1 tolerance", () => {
  assert.equal(EPSILON, 1);
});

test("computeItc MATCHED gives full books tax as eligible", () => {
  const itc = computeItc("MATCHED", 18000, 18000);
  assert.deepEqual(itc, { itcEligible: 18000, itcPending: 0 });
});

test("computeItc MISMATCHED splits eligible vs pending on 2B amount", () => {
  // Books tax 36000, 2B confirms only 34000 => 34000 eligible, 2000 pending
  const itc = computeItc("MISMATCHED", 36000, 34000);
  assert.deepEqual(itc, { itcEligible: 34000, itcPending: 2000 });
});

test("computeItc MISMATCHED with no 2B amount keeps everything pending", () => {
  const itc = computeItc("MISMATCHED", 18000, null);
  assert.deepEqual(itc, { itcEligible: 0, itcPending: 18000 });
});

test("computeItc MISSING_IN_2B defers full books tax", () => {
  const itc = computeItc("MISSING_IN_2B", 13500, null);
  assert.deepEqual(itc, { itcEligible: 0, itcPending: 13500 });
});

test("computeItc DUPLICATE: only the first occurrence owns ITC", () => {
  assert.deepEqual(computeItc("DUPLICATE", 5400, 5400, true), { itcEligible: 5400, itcPending: 0 });
  assert.deepEqual(computeItc("DUPLICATE", 5400, 5400, false), { itcEligible: 0, itcPending: 0 });
});

test("computeItc MISSING_IN_BOOKS is not a books-side claim", () => {
  const itc = computeItc("MISSING_IN_BOOKS", 0, 21600);
  assert.deepEqual(itc, { itcEligible: 0, itcPending: 0 });
});