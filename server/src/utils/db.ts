// Numeric coercion at the Prisma boundary.
//
// The dev schema stores money as Float (JS numbers) while the production
// Postgres schema uses Decimal(18,2). Prisma returns Decimal columns as
// decimal.js objects, whose `+` triggers string concatenation instead of
// addition. Every money field crossing the DB boundary must be normalised to a
// plain JS number so reconciliation arithmetic stays deterministic on both
// backends. Number(x) is safe for numbers, numeric strings and Prisma Decimal
// (via valueOf), and null/undefined collapse to 0 here.

export function num(x: unknown): number {
  if (x === null || x === undefined) return 0;
  const n = Number(x as any);
  return Number.isFinite(n) ? n : 0;
}

export function numOrNull(x: unknown): number | null {
  if (x === null || x === undefined) return null;
  const n = Number(x as any);
  return Number.isFinite(n) ? n : null;
}