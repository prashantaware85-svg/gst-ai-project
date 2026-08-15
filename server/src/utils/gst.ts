// Pure GST math helpers shared by the reconciliation engine and its unit
// tests. GST values are always derived deterministically from the invoice
// amounts — never from AI output.

export const EPSILON = 1; // Rs.1 tolerance used to flag a difference

export type NoteType = "INVOICE" | "CREDIT_NOTE" | "DEBIT_NOTE";

export function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

// Taxable / tax totals from per-head components (incl. CESS).
export function totalTax(cgst: number, sgst: number, igst: number, cess = 0): number {
  return round3((cgst || 0) + (sgst || 0) + (igst || 0) + (cess || 0));
}

// Total invoice value (gross) from taxable + all tax heads.
export function grossValue(taxable: number, cgst = 0, sgst = 0, igst = 0, cess = 0): number {
  return round3((taxable || 0) + (cgst || 0) + (sgst || 0) + (igst || 0) + (cess || 0));
}

// Tolerance for numeric matching (item 18 - partial/tolerance matching).
// Configurable relative tolerance (percent of the larger value) plus an
// absolute rupee floor. Deterministic - reads env once per comparison.
export function matchTolerance(): { abs: number; pct: number } {
  const abs = Number(process.env.MATCH_TOLERANCE_RUPEES || EPSILON);
  const pct = Number(process.env.MATCH_TOLERANCE_PERCENT || 0.5); // 0.5% of the larger value
  return { abs: Number.isFinite(abs) ? abs : EPSILON, pct: Number.isFinite(pct) ? pct : 0.5 };
}

// True when the difference between two values is within tolerance.
export function isWithinTolerance(a: number, b: number): boolean {
  const { abs, pct } = matchTolerance();
  const diff = Math.abs(round3(a) - round3(b));
  if (diff <= abs) return true;
  const base = Math.max(Math.abs(a), Math.abs(b));
  return base > 0 && diff <= (base * pct) / 100;
}

// Day tolerance used for invoice date comparison (item 7). Portal filings can
// be off by a day across time zones, so a small configurable tolerance avoids
// spurious date mismatches. Default 1 day.
export function dateToleranceDays(): number {
  const d = Number(process.env.MATCH_DATE_TOLERANCE_DAYS || 1);
  return Number.isFinite(d) && d >= 0 ? d : 1;
}

// ITC computation. Deterministic rules:
//   MATCHED           => full books tax is eligible
//   MISMATCHED (match)=> eligible on the lesser of books/2B tax; the rest pending
//   MISSING_IN_2B     => nothing eligible, full books tax pending
//   DUPLICATE         => eligible when the row owns the ITC (first occurrence)
//   MISSING_IN_BOOKS  => not our purchase (0/0)
// The `ownsItc` flag resolves duplicates; callers pass whether this row is the
// first occurrence of its duplicate group.
//
// NOTE: amounts flow in with their portal/register sign (a books credit note is
// often negative while the portal lists it positive). The magnitude of the tax
// is taken for ITC and the effective sign is derived from `noteType`:
//   CREDIT_NOTE => reduces ITC (-1), DEBIT_NOTE / INVOICE => increases ITC (+1).
// A credit note missing in 2B defers nothing (it is a reduction the supplier
// must confirm, not extra credit you are owed), so its pending is 0.
export function computeItc(
  status: string,
  bookTax: number,
  twoBTax: number | null,
  ownsItc = true,
  noteType: NoteType = "INVOICE",
): { itcEligible: number; itcPending: number } {
  const sign = noteType === "CREDIT_NOTE" ? -1 : 1;
  const mag = Math.abs(round3(bookTax));

  switch (status) {
    case "MATCHED":
      return { itcEligible: round3(mag) * sign, itcPending: 0 };
    case "MISMATCHED": {
      if (twoBTax == null) {
        // No 2B counterpart at all: nothing eligible, deferred for confirmation.
        return noteType === "CREDIT_NOTE"
          ? { itcEligible: 0, itcPending: 0 }
          : { itcEligible: 0, itcPending: round3(mag) };
      }
      const eligible = Math.min(mag, Math.abs(round3(twoBTax)));
      const pending = Math.max(0, mag - eligible);
      return { itcEligible: round3(eligible) * sign, itcPending: round3(pending) };
    }
    case "MISSING_IN_2B":
      return noteType === "CREDIT_NOTE"
        ? { itcEligible: 0, itcPending: 0 }
        : { itcEligible: 0, itcPending: round3(mag) };
    case "DUPLICATE":
      return ownsItc
        ? { itcEligible: round3(mag) * sign, itcPending: 0 }
        : { itcEligible: 0, itcPending: 0 };
    default:
      // MISSING_IN_BOOKS and any unclassified rows: not a books-side claim.
      return { itcEligible: 0, itcPending: 0 };
  }
}