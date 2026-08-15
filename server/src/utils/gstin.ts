// GSTIN validation and normalisation helpers.
//
// A valid Goods and Services Taxpayer Identification Number (GSTIN):
//   * 15 characters
//   * first 2 digits  = state code (01..38-ish)
//   * next 10 chars   = PAN (5 letters + 4 digits + 1 check letter)
//   * 13th char       = entity code (digit or letter A-Z)
//   * 14th char       = "Z" (default)
//   * 15th char       = checksum / alphanumeric
//
// We normalise consistently (trim, uppercase, strip separators) and validate
// shape + state code. These helpers are deterministic and never rely on AI.

export const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;

// Standard two-digit state codes used by the GSTN portal. 97/99 style codes for
// special territories are tolerated via the isValidStateCode fallback.
const STATE_CODES = new Set<number>([
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21,
  22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38,
]);

export function normalizeGstin(s: unknown): string {
  return String(s ?? "")
    .toUpperCase()
    .replace(/[\s\-]/g, "")
    .trim();
}

export function isValidGstin(s: unknown): boolean {
  const g = normalizeGstin(s);
  if (!GSTIN_RE.test(g)) return false;
  return isValidStateCode(Number(g.slice(0, 2)));
}

export function isValidStateCode(code: number): boolean {
  return STATE_CODES.has(code) || code === 97 || code === 99;
}

export function stateCodeOf(s: unknown): number | null {
  const g = normalizeGstin(s);
  if (!GSTIN_RE.test(g)) return null;
  return Number(g.slice(0, 2));
}

// Two-char state code of the GSTIN (for same-state vs inter-state classification).
export function stateCode2(s: unknown): string | null {
  const g = normalizeGstin(s);
  return GSTIN_RE.test(g) ? g.slice(0, 2) : null;
}

// Whether two GSTINs belong to the same state (used for CGST+SGST vs IGST sanity).
export function sameState(a: unknown, b: unknown): boolean {
  const ca = stateCode2(a);
  const cb = stateCode2(b);
  return ca !== null && cb !== null && ca === cb;
}