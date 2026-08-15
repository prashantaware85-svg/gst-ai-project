import { test } from "node:test";
import assert from "node:assert/strict";
import { num, numOrNull } from "../src/utils/db";

// Prisma returns Postgres DECIMAL columns as decimal.js objects. Their `+`
// concatenates strings, so money crossing the DB boundary must be coerced to
// plain numbers before any reconciliation arithmetic.
test("num() coerces Prisma Decimal objects like plain numbers", () => {
  const decimalLike = { toNumber: () => 9000, valueOf: () => "9000", toString: () => "9000" };
  assert.equal(num(decimalLike), 9000);
  assert.equal(num("18000.00"), 18000);
  assert.equal(num(5400), 5400);
  assert.equal(num(null), 0);
  assert.equal(num(undefined), 0);
  assert.equal(num("not-a-number"), 0);
  assert.ok(num(9000) + num("9000") === 18000); // addition, not concatenation
});

test("numOrNull() preserves null but coerces decimals", () => {
  assert.equal(numOrNull(null), null);
  assert.equal(numOrNull(undefined), null);
  assert.equal(numOrNull(-1800.5), -1800.5);
});