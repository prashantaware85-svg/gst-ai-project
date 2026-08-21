// GST ↔ Tally reconciliation engine (Phase 2).
//
// Compares the TallyPrime Day Book rows (TallyImport) against uploaded GST
// filings (GstTransaction):
//   * TALLY   SALES  vs  GSTR-1  (returnType GSTR1)
//   * TALLY   PURCHASE vs GSTR-2B (returnType GSTR2B)
// Sales are never compared against GSTR-2B and purchases never against GSTR-1:
// the run function derives the voucher/return types from transactionType.
//
// Matching levels (section 10 of the Phase 2 spec):
//   LEVEL 1 — exact     GSTIN + invoice no + date          -> confidence 100
//   LEVEL 2 — strong    GSTIN + invoice no (+date window)  -> confidence 95
//   LEVEL 3 — amount    GSTIN + taxable/tax (₹ tolerance)  -> confidence 80
//   LEVEL 4 — fuzzy     GSTIN + normalized invoice similarity -> 60..79
//   LEVEL 5 — cross-GSTIN invoice match                    -> confidence 60
//
// Confidence outcomes (section 14):
//   >= 90  -> automatically matched (MATCHED / AMOUNT_MISMATCH / DATE_MISMATCH)
//   70..89 -> POSSIBLE_MATCH / INVOICE_NUMBER_MISMATCH / DUPLICATE_*
//   <  70  -> not auto-matched (MISSING_IN_GST / MISSING_IN_TALLY)
//
// Every result row stores the ACTUAL differences (never hides them) and only
// references the source rows by id — the original Tally/GST data is never
// overwritten. Review workflow fields ride on the result row.
import { prisma } from "../utils/prisma";
import { num } from "../utils/db";
import { dateToleranceDays } from "../utils/gst";
import { normalizeInvoiceNo, invoiceKey, fuzzySame, levenshtein } from "../utils/fuzzy";
import { normalizeGstin } from "../utils/gstin";

export const STATUS = {
  MATCHED: "MATCHED",
  AMOUNT_MISMATCH: "AMOUNT_MISMATCH",
  DATE_MISMATCH: "DATE_MISMATCH",
  INVOICE_NUMBER_MISMATCH: "INVOICE_NUMBER_MISMATCH",
  GSTIN_MISMATCH: "GSTIN_MISMATCH",
  MISSING_IN_GST: "MISSING_IN_GST",
  MISSING_IN_TALLY: "MISSING_IN_TALLY",
  DUPLICATE_IN_TALLY: "DUPLICATE_IN_TALLY",
  DUPLICATE_IN_GST: "DUPLICATE_IN_GST",
  POSSIBLE_MATCH: "POSSIBLE_MATCH",
  INVALID_DATA: "INVALID_DATA",
} as const;
export type GstReconStatus = (typeof STATUS)[keyof typeof STATUS];

export type TransactionType = "SALES" | "PURCHASE";

export interface TallyForRecon {
  id: number;
  voucherNumber: string;
  voucherDate: Date;
  partyName: string | null;
  partyGSTIN: string | null;
  invoiceNumber: string | null;
  taxableValue: number;
  cgst: number;
  sgst: number;
  igst: number;
  roundOff: number;
  totalAmount: number;
}

export interface GstForRecon {
  id: number;
  gstin: string | null;
  counterpartyGstin: string | null;
  counterpartyName: string | null;
  invoiceNumber: string;
  invoiceDate: Date;
  taxableValue: number;
  cgst: number;
  sgst: number;
  igst: number;
  invoiceValue: number;
}

export interface ReconResultRow {
  period: string;
  transactionType: TransactionType;
  tallyTransactionId: number | null;
  gstTransactionId: number | null;
  status: GstReconStatus;
  matchLevel: string | null;
  confidence: number;
  taxableDifference: number;
  cgstDifference: number;
  sgstDifference: number;
  igstDifference: number;
  invoiceValueDifference: number;
  reason: string | null;
  // B2B = GSTIN or party GSTIN is present in source data.
  // B2C = neither GSTIN is available in the actual source data.
  type: "B2B" | "B2C";
}

export function toTallyForRecon(r: any): TallyForRecon {
  return {
    id: r.id,
    voucherNumber: r.voucherNumber,
    voucherDate: r.voucherDate instanceof Date ? r.voucherDate : new Date(r.voucherDate),
    partyName: r.partyName,
    partyGSTIN: r.partyGSTIN,
    invoiceNumber: r.invoiceNumber,
    taxableValue: num(r.taxableValue),
    cgst: num(r.cgst),
    sgst: num(r.sgst),
    igst: num(r.igst),
    roundOff: num(r.roundOff),
    totalAmount: num(r.totalAmount),
  };
}

export function toGstForRecon(r: any): GstForRecon {
  return {
    id: r.id,
    gstin: r.gstin,
    counterpartyGstin: r.counterpartyGstin,
    counterpartyName: r.counterpartyName,
    invoiceNumber: r.invoiceNumber,
    invoiceDate: r.invoiceDate instanceof Date ? r.invoiceDate : new Date(r.invoiceDate),
    taxableValue: num(r.taxableValue),
    cgst: num(r.cgst),
    sgst: num(r.sgst),
    igst: num(r.igst),
    invoiceValue: num(r.invoiceValue),
  };
}

// ---------------------------------------------------------------------------
// Configuration (configurable tolerance + thresholds)
// ---------------------------------------------------------------------------

export function tolerances() {
  const t = (key: string, dflt: number) => {
    const v = Number(process.env[key]);
    return Number.isFinite(v) && v >= 0 ? v : dflt;
  };
  return {
    taxable: t("GST_TOLERANCE_TAXABLE", 1),
    tax: t("GST_TOLERANCE_TAX", 1),
    invoiceValue: t("GST_TOLERANCE_VALUE", 1),
  };
}

function within(a: number, b: number, tol: number): boolean {
  return Math.abs(round2(a) - round2(b)) <= tol;
}

export function autoMatchConfidence(): number {
  const v = Number(process.env.GST_AUTO_MATCH_CONFIDENCE || 90);
  return Number.isFinite(v) ? v : 90;
}

export function possibleMatchMinConfidence(): number {
  const v = Number(process.env.GST_POSSIBLE_MIN_CONFIDENCE || 70);
  return Number.isFinite(v) ? v : 70;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function dateDiffDays(a: Date, b: Date): number {
  const am = Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate());
  const bm = Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate());
  return Math.round(Math.abs(am - bm) / 86400000);
}

function sameMonth(a: Date, b: Date): boolean {
  return (
    a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth()
  );
}

function invoiceNoOf(t: TallyForRecon): string {
  return t.invoiceNumber || t.voucherNumber || "";
}

function tallyGstinOf(t: TallyForRecon): string {
  return normalizeGstin(t.partyGSTIN);
}

function gstGstinOf(g: GstForRecon): string {
  return normalizeGstin(g.counterpartyGstin);
}

// B2B = GSTIN or party GSTIN is present in source data.
// B2C = neither GSTIN is available in the actual source data.
function classifyType(t: TallyForRecon, g: GstForRecon): "B2B" | "B2C" {
  const tallyHasGstin = t.partyGSTIN && normalizeGstin(t.partyGSTIN) !== "";
  const gstHasGstin = g.counterpartyGstin && normalizeGstin(g.counterpartyGstin) !== "";
  return (tallyHasGstin || gstHasGstin) ? "B2B" : "B2C";
}

// Fuzzy invoice similarity as a confidence score in the 60..79 band.
function fuzzyConfidence(a: string, b: string): number {
  const na = normalizeInvoiceNo(a);
  const nb = normalizeInvoiceNo(b);
  const maxLen = Math.max(na.length, nb.length, 1);
  const sim = 1 - levenshtein(na, nb) / maxLen;
  return Math.min(79, Math.max(60, Math.round(59 + sim * 20)));
}

// ---------------------------------------------------------------------------
// Core matching
// ---------------------------------------------------------------------------

interface Candidate {
  g: GstForRecon;
  level: 1 | 2 | 3 | 4 | 5;
  confidence: number;
}

function findCandidate(
  t: TallyForRecon,
  gst: GstForRecon[],
  gstKeys: Map<number, { gstin: string; invKey: string; invNo: string }>,
  used: Set<number>,
  tol: { taxable: number; tax: number; invoiceValue: number },
  dateTolDays: number,
): Candidate | null {
  const tallyGst = tallyGstinOf(t);
  const tallyInv = invoiceNoOf(t);
  const tallyInvKey = invoiceKey(tallyInv);
  const tallyTax = t.cgst + t.sgst + t.igst;

  const group: GstForRecon[] = [];
  for (const g of gst) {
    if (used.has(g.id)) continue;
    group.push(g);
  }

  let best: Candidate | null = null;

  // LEVEL 1/2 — same GSTIN + same invoice key (date decides confidence).
  // When both sides are unregistered (empty GSTIN) this is NOT an exact match;
  // the unregistered branch below reports it as a possible match.
  const sameInv: GstForRecon[] = [];
  for (const g of group) {
    const key = gstKeys.get(g.id)!;
    if (tallyGst !== "" && key.gstin === tallyGst && key.invKey === tallyInvKey) sameInv.push(g);
  }
  if (sameInv.length) {
    const byDate = [...sameInv].sort(
      (a, b) => dateDiffDays(t.voucherDate, a.invoiceDate) - dateDiffDays(t.voucherDate, b.invoiceDate),
    );
    const g = byDate[0];
    const dd = dateDiffDays(t.voucherDate, g.invoiceDate);
    if (dd === 0) best = { g, level: 1, confidence: 100 };
    else if (dd <= dateTolDays) best = { g, level: 2, confidence: 95 };
    else best = { g, level: 2, confidence: 90 }; // DATE_MISMATCH
    return best;
  }

  // LEVEL 3/4 — same GSTIN, different invoice key, amounts within tolerance
  // and same month. Fuzzy-similar invoices land on LEVEL 4 (POSSIBLE_MATCH
  // 60..79), unrelated invoice numbers on LEVEL 3 (INVOICE_NUMBER_MISMATCH 80).
  const amountMatches: GstForRecon[] = [];
  for (const g of group) {
    const key = gstKeys.get(g.id)!;
    if (tallyGst === "" && key.gstin === "") continue; // both unregistered -> branch below
    if (key.gstin !== tallyGst) continue;
    const gstTax = g.cgst + g.sgst + g.igst;
    if (!within(t.taxableValue, g.taxableValue, tol.taxable)) continue;
    if (!within(tallyTax, gstTax, tol.tax)) continue;
    if (!within(t.totalAmount, g.invoiceValue, tol.invoiceValue)) continue;
    if (!sameMonth(t.voucherDate, g.invoiceDate)) continue;
    amountMatches.push(g);
  }
  if (amountMatches.length) {
    for (const g of amountMatches) {
      if (fuzzySame(tallyInv, g.invoiceNumber)) {
        const conf = fuzzyConfidence(tallyInv, g.invoiceNumber);
        if (conf >= possibleMatchMinConfidence()) {
          best = { g, level: 4, confidence: conf };
          return best;
        }
      }
    }
    const g = amountMatches[0];
    best = { g, level: 3, confidence: 80 };
    return best;
  }

  // Same invoice key, both parties unregistered (no GSTIN on either side).
  for (const g of group) {
    const key = gstKeys.get(g.id)!;
    if (key.gstin !== "" || tallyGst !== "") continue;
    if (key.invKey === tallyInvKey && dateDiffDays(t.voucherDate, g.invoiceDate) <= dateTolDays) {
      best = { g, level: 4, confidence: 75 };
      return best;
    }
  }

  // LEVEL 5 — same invoice number under a different GSTIN.
  for (const g of group) {
    const key = gstKeys.get(g.id)!;
    if (key.gstin !== tallyGst && key.invKey === tallyInvKey) {
      best = { g, level: 5, confidence: 60 };
      return best;
    }
  }

  return best;
}

function tallyInvalid(t: TallyForRecon): boolean {
  return !t.voucherDate || !t.voucherNumber;
}

function gstInvalid(g: GstForRecon): boolean {
  return !g.invoiceDate || !g.invoiceNumber;
}

function mkRow(
  period: string,
  transactionType: TransactionType,
  t: TallyForRecon | null,
  g: GstForRecon | null,
  type: "B2B" | "B2C" = "B2C",
): ReconResultRow {
  let taxable = 0, cgst = 0, sgst = 0, igst = 0, invValue = 0;
  if (t && g) {
    taxable = round2(t.taxableValue - g.taxableValue);
    cgst = round2(t.cgst - g.cgst);
    sgst = round2(t.sgst - g.sgst);
    igst = round2(t.igst - g.igst);
    invValue = round2(t.totalAmount - g.invoiceValue);
  } else if (t) {
    taxable = round2(t.taxableValue);
    cgst = round2(t.cgst);
    sgst = round2(t.sgst);
    igst = round2(t.igst);
    invValue = round2(t.totalAmount);
  } else if (g) {
    taxable = round2(-g.taxableValue);
    cgst = round2(-g.cgst);
    sgst = round2(-g.sgst);
    igst = round2(-g.igst);
    invValue = round2(-g.invoiceValue);
  }
  return {
    period,
    transactionType,
    tallyTransactionId: t?.id ?? null,
    gstTransactionId: g?.id ?? null,
    status: STATUS.MISSING_IN_GST,
    matchLevel: null,
    confidence: 0,
    taxableDifference: taxable,
    cgstDifference: cgst,
    sgstDifference: sgst,
    igstDifference: igst,
    invoiceValueDifference: invValue,
    reason: null,
    type,
  };
}

export function classifyReconciliation(
  tally: TallyForRecon[],
  gst: GstForRecon[],
  transactionType: TransactionType,
  period: string,
): ReconResultRow[] {
  const tol = tolerances();
  const dateTolDays = dateToleranceDays();

  const gstKeys = new Map<number, { gstin: string; invKey: string; invNo: string }>();
  const tallyDupes = new Set<number>();
  const gstDupes = new Set<number>();

  const seenTally = new Map<string, number>();
  for (const t of tally) {
    const key = `${tallyGstinOf(t)}|${invoiceKey(invoiceNoOf(t))}`;
    if (seenTally.has(key)) tallyDupes.add(t.id);
    else seenTally.set(key, t.id);
  }
  const seenGst = new Map<string, number>();
  for (const g of gst) {
    gstKeys.set(g.id, { gstin: gstGstinOf(g), invKey: invoiceKey(g.invoiceNumber), invNo: g.invoiceNumber });
    const key = `${gstGstinOf(g)}|${invoiceKey(g.invoiceNumber)}`;
    if (seenGst.has(key)) gstDupes.add(g.id);
    else seenGst.set(key, g.id);
  }

  const rows: ReconResultRow[] = [];
  const used = new Set<number>();

  for (const t of tally) {
    if (tallyInvalid(t)) {
      const row = mkRow(period, transactionType, t, null, "B2C");
      row.status = STATUS.INVALID_DATA;
      row.confidence = 0;
      row.matchLevel = "NONE";
      row.reason = "Voucher has no invoice number or date";
      rows.push(row);
      continue;
    }
    if (tallyDupes.has(t.id)) {
      const row = mkRow(period, transactionType, t, null, "B2C");
      row.status = STATUS.DUPLICATE_IN_TALLY;
      row.confidence = 75;
      row.matchLevel = "DUPLICATE";
      row.reason = `Duplicate voucher "${invoiceNoOf(t)}" appears more than once in Tally`;
      rows.push(row);
      continue;
    }

    const cand = findCandidate(t, gst, gstKeys, used, tol, dateTolDays);
    if (!cand) {
      const row = mkRow(period, transactionType, t, null, "B2C");
      row.status = STATUS.MISSING_IN_GST;
      row.confidence = 70;
      row.matchLevel = "NONE";
      row.reason = "No matching invoice in the GST return";
      rows.push(row);
      continue;
    }
    used.add(cand.g.id);
    rows.push(buildResult(t, cand, period, transactionType, tol));
  }

  // GST-side leftovers.
  for (const g of gst) {
    if (used.has(g.id)) continue;
    if (gstInvalid(g)) {
      const row = mkRow(period, transactionType, null, g, "B2C");
      row.status = STATUS.INVALID_DATA;
      row.confidence = 0;
      row.matchLevel = "NONE";
      row.reason = "GST row has no invoice number or date";
      rows.push(row);
      continue;
    }
    if (gstDupes.has(g.id)) {
      const row = mkRow(period, transactionType, null, g, "B2C");
      row.status = STATUS.DUPLICATE_IN_GST;
      row.confidence = 75;
      row.matchLevel = "DUPLICATE";
      row.reason = `Duplicate invoice "${g.invoiceNumber}" appears more than once in the GST return`;
      rows.push(row);
      continue;
    }
    const row = mkRow(period, transactionType, null, g, "B2C");
    row.status = STATUS.MISSING_IN_TALLY;
    row.confidence = 70;
    row.matchLevel = "NONE";
    row.reason = "Filing exists but no matching invoice in Tally";
    rows.push(row);
  }

  return rows;
}

function buildResult(
  t: TallyForRecon,
  cand: Candidate,
  period: string,
  transactionType: TransactionType,
  tol: { taxable: number; tax: number; invoiceValue: number },
): ReconResultRow {
  const g = cand.g;
  const tallyTax = t.cgst + t.sgst + t.igst;
  const gstTax = g.cgst + g.sgst + g.igst;
  const tallyInv = invoiceNoOf(t);

  // Classify B2B/B2C based on actual GSTIN presence in source data.
  const tallyHasGstin = t.partyGSTIN && normalizeGstin(t.partyGSTIN) !== "";
  const gstHasGstin = g.counterpartyGstin && normalizeGstin(g.counterpartyGstin) !== "";
  const type: "B2B" | "B2C" = (tallyHasGstin || gstHasGstin) ? "B2B" : "B2C";

  const row = mkRow(period, transactionType, t, g, type);
  row.confidence = cand.confidence;
  row.matchLevel = `LEVEL${cand.level}`;

  switch (cand.level) {
    case 1:
    case 2: {
      if (cand.confidence === 90) {
        row.status = STATUS.DATE_MISMATCH;
        row.reason = `Invoice matches but dates differ: Tally ${iso(t.voucherDate)} vs GST ${iso(g.invoiceDate)}`;
        break;
      }
      const amountsOk =
        within(t.taxableValue, g.taxableValue, tol.taxable) &&
        within(tallyTax, gstTax, tol.tax) &&
        within(t.totalAmount, g.invoiceValue, tol.invoiceValue);
      if (amountsOk) {
        row.status = STATUS.MATCHED;
        row.reason = null;
      } else {
        // A fully-matching invoice whose figures disagree drops from the
        // 95/100 tier to 90 (same as DATE_MISMATCH) so the confidence band
        // still reads "auto-matched" but reflects the discrepancy.
        row.status = STATUS.AMOUNT_MISMATCH;
        row.confidence = 90;
        row.reason =
          `Amounts differ: taxable ${round2(t.taxableValue)} vs ${round2(g.taxableValue)}, ` +
          `tax ${round2(tallyTax)} vs ${round2(gstTax)}, invoice value ${round2(t.totalAmount)} vs ${round2(g.invoiceValue)}`;
      }
      break;
    }
    case 3:
      row.status = STATUS.INVOICE_NUMBER_MISMATCH;
      row.reason = `Invoice numbers differ but amounts match: Tally "${tallyInv}" vs GST "${g.invoiceNumber}"`;
      break;
    case 4:
      row.status = STATUS.POSSIBLE_MATCH;
      row.reason =
        tallyGstinOf(t) === "" && gstGstinOf(g) === ""
          ? `Invoice "${tallyInv}" matched without GSTIN (unregistered party)`
          : `Invoice "${tallyInv}" fuzzy-matched to "${g.invoiceNumber}"`;
      break;
    case 5:
      row.status = STATUS.GSTIN_MISMATCH;
      row.reason = `Invoice "${tallyInv}" found under a different GSTIN: Tally ${tallyGstinOf(t) || "—"} vs GST ${gstGstinOf(g) || "—"}`;
      break;
  }
  return row;
}

function iso(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(
    d.getUTCDate(),
  ).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Persistence (run + summary + listing)
// ---------------------------------------------------------------------------

export const PERIOD_RE = /^(\d{4})-(\d{2})$/;

export function isValidPeriod(period: string): boolean {
  const m = PERIOD_RE.exec(period);
  if (!m) return false;
  const month = Number(m[2]);
  return month >= 1 && month <= 12;
}

export function monthRange(period: string): { start: Date; end: Date } {
  const [y, m] = period.split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end = new Date(Date.UTC(y, m, 0)); // last day, UTC midnight
  return { start, end };
}

export interface RunSummary {
  success: boolean;
  runId: number;
  period: string;
  transactionType: TransactionType;
  totalTally: number;
  totalGst: number;
  matched: number;
  amountMismatch: number;
  dateMismatch: number;
  invoiceNumberMismatch: number;
  gstinMismatch: number;
  missingInGst: number;
  missingInTally: number;
  duplicateInTally: number;
  duplicateInGst: number;
  possibleMatch: number;
  invalidData: number;
  b2b: number;
  b2c: number;
}

export function summarize(rows: ReconResultRow[]): {
  matched: number;
  amountMismatch: number;
  dateMismatch: number;
  invoiceNumberMismatch: number;
  gstinMismatch: number;
  missingInGst: number;
  missingInTally: number;
  duplicateInTally: number;
  duplicateInGst: number;
  possibleMatch: number;
  invalidData: number;
  b2b: number;
  b2c: number;
} {
  const counts = {
    matched: 0,
    amountMismatch: 0,
    dateMismatch: 0,
    invoiceNumberMismatch: 0,
    gstinMismatch: 0,
    missingInGst: 0,
    missingInTally: 0,
    duplicateInTally: 0,
    duplicateInGst: 0,
    possibleMatch: 0,
    invalidData: 0,
    b2b: 0,
    b2c: 0,
  };
  for (const r of rows) {
    switch (r.status) {
      case STATUS.MATCHED: counts.matched += 1; break;
      case STATUS.AMOUNT_MISMATCH: counts.amountMismatch += 1; break;
      case STATUS.DATE_MISMATCH: counts.dateMismatch += 1; break;
      case STATUS.INVOICE_NUMBER_MISMATCH: counts.invoiceNumberMismatch += 1; break;
      case STATUS.GSTIN_MISMATCH: counts.gstinMismatch += 1; break;
      case STATUS.MISSING_IN_GST: counts.missingInGst += 1; break;
      case STATUS.MISSING_IN_TALLY: counts.missingInTally += 1; break;
      case STATUS.DUPLICATE_IN_TALLY: counts.duplicateInTally += 1; break;
      case STATUS.DUPLICATE_IN_GST: counts.duplicateInGst += 1; break;
      case STATUS.POSSIBLE_MATCH: counts.possibleMatch += 1; break;
      case STATUS.INVALID_DATA: counts.invalidData += 1; break;
    }
    if (r.type === "B2B") counts.b2b += 1;
    if (r.type === "B2C") counts.b2c += 1;
  }
  return counts;
}

const VOUCHER_TYPE: Record<TransactionType, string> = {
  SALES: "Sales",
  PURCHASE: "Purchase",
};
const RETURN_TYPE: Record<TransactionType, string> = {
  SALES: "GSTR1",
  PURCHASE: "GSTR2B",
};

export async function runGstReconciliation(
  period: string,
  transactionType: TransactionType,
): Promise<RunSummary> {
  if (!isValidPeriod(period)) throw new Error("period must be a valid month in YYYY-MM format");
  if (transactionType !== "SALES" && transactionType !== "PURCHASE") {
    throw new Error("transactionType must be SALES or PURCHASE");
  }

  const { start, end } = monthRange(period);
  const voucherType = VOUCHER_TYPE[transactionType];
  const returnType = RETURN_TYPE[transactionType];

  // SALES vs GSTR-1, PURCHASE vs GSTR-2B — enforced by the derived types above.
  const [tallyRows, gstRows] = await Promise.all([
    prisma.tallyImport.findMany({
      where: { voucherType, voucherDate: { gte: start, lte: end } },
      orderBy: { id: "asc" },
    }),
    prisma.gstTransaction.findMany({
      where: { returnType, period },
      orderBy: { id: "asc" },
    }),
  ]);

  const tally = tallyRows.map(toTallyForRecon);
  const gst = gstRows.map(toGstForRecon);

  const rows = classifyReconciliation(tally, gst, transactionType, period);
  const counts = summarize(rows);

  // Idempotent re-run for the same period + type: replace the previous run.
  const prev = await prisma.gstReconciliationRun.findMany({
    where: { period, transactionType },
    select: { id: true },
  });
  if (prev.length) {
    await prisma.gstReconciliationResult.deleteMany({
      where: { runId: { in: prev.map((p) => p.id) } },
    });
    await prisma.gstReconciliationRun.deleteMany({
      where: { id: { in: prev.map((p) => p.id) } },
    });
  }

  const run = await prisma.gstReconciliationRun.create({
    data: {
      period,
      transactionType,
      totalTally: tally.length,
      totalGst: gst.length,
      ...counts,
    },
  });

  if (rows.length) {
    await prisma.gstReconciliationResult.createMany({
      data: rows.map((r) => ({
        runId: run.id,
        period: r.period,
        transactionType: r.transactionType,
        tallyTransactionId: r.tallyTransactionId,
        gstTransactionId: r.gstTransactionId,
        status: r.status,
        matchLevel: r.matchLevel,
        confidence: r.confidence,
        taxableDifference: r.taxableDifference,
        cgstDifference: r.cgstDifference,
        sgstDifference: r.sgstDifference,
        igstDifference: r.igstDifference,
        invoiceValueDifference: r.invoiceValueDifference,
        reason: r.reason,
        reviewStatus: null,
      })),
    });
  }

  return {
    success: true,
    runId: run.id,
    period,
    transactionType,
    totalTally: tally.length,
    totalGst: gst.length,
    ...counts,
  };
}

// Latest run for a period + type (read-only; zeros when none exists).
export async function getRunSummary(
  period: string,
  transactionType: TransactionType,
): Promise<RunSummary> {
  if (!isValidPeriod(period)) throw new Error("period must be a valid month in YYYY-MM format");
  const run = await prisma.gstReconciliationRun.findFirst({
    where: { period, transactionType },
    orderBy: { createdAt: "desc" },
  });
  if (!run) {
    return {
      success: false,
      runId: 0,
      period,
      transactionType,
      totalTally: 0,
      totalGst: 0,
      matched: 0,
      amountMismatch: 0,
      dateMismatch: 0,
      invoiceNumberMismatch: 0,
      gstinMismatch: 0,
      missingInGst: 0,
      missingInTally: 0,
      duplicateInTally: 0,
      duplicateInGst: 0,
      possibleMatch: 0,
      invalidData: 0,
      b2b: 0,
      b2c: 0,
    };
  }
  return {
    success: true,
    runId: run.id,
    period: run.period,
    transactionType: run.transactionType as TransactionType,
    totalTally: run.totalTally,
    totalGst: run.totalGst,
    matched: run.matched,
    amountMismatch: run.amountMismatch,
    dateMismatch: run.dateMismatch,
    invoiceNumberMismatch: run.invoiceNumberMismatch,
    gstinMismatch: run.gstinMismatch,
    missingInGst: run.missingInGst,
    missingInTally: run.missingInTally,
    duplicateInTally: run.duplicateInTally,
    duplicateInGst: run.duplicateInGst,
    possibleMatch: run.possibleMatch,
    invalidData: run.invalidData,
    b2b: (run as any).b2b ?? 0,
    b2c: (run as any).b2c ?? 0,
  };
}

// Results for a period + type (optionally filtered by status), joined with the
// source Tally and GST rows so the UI can render side-by-side without extra calls.
export interface JoinedResult {
  id: number;
  runId: number;
  status: string;
  matchLevel: string | null;
  confidence: number;
  taxableDifference: number;
  cgstDifference: number;
  sgstDifference: number;
  igstDifference: number;
  invoiceValueDifference: number;
  reason: string | null;
  reviewStatus: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  tally: TallyView | null;
  gst: GstView | null;
}

export interface TallyView {
  id: number;
  voucherNumber: string;
  voucherDate: string;
  partyName: string | null;
  partyGSTIN: string | null;
  invoiceNumber: string | null;
  taxableValue: number;
  cgst: number;
  sgst: number;
  igst: number;
  roundOff: number;
  totalAmount: number;
}

export interface GstView {
  id: number;
  invoiceNumber: string;
  invoiceDate: string;
  counterpartyGstin: string | null;
  counterpartyName: string | null;
  taxableValue: number;
  cgst: number;
  sgst: number;
  igst: number;
  invoiceValue: number;
}

export async function listResults(params: {
  period: string;
  transactionType: TransactionType;
  status?: string;
  page?: number;
  pageSize?: number;
}): Promise<{ rows: JoinedResult[]; total: number; page: number; pageSize: number }> {
  const where: Record<string, unknown> = { period: params.period, transactionType: params.transactionType };
  if (params.status) where.status = params.status;
  const page = Math.max(1, params.page ?? 1);
  const pageSize = Math.min(Math.max(params.pageSize ?? 50, 1), 500);
  const [results, total] = await Promise.all([
    prisma.gstReconciliationResult.findMany({
      where,
      orderBy: { id: "asc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.gstReconciliationResult.count({ where }),
  ]);
  return { rows: await joinResults(results as any[]), total, page, pageSize };
}

export async function getResultById(id: number): Promise<JoinedResult | null> {
  const r = await prisma.gstReconciliationResult.findUnique({ where: { id } });
  if (!r) return null;
  const [joined] = await joinResults([r as any]);
  return joined;
}

async function joinResults(results: any[]): Promise<JoinedResult[]> {
  if (!results.length) return [];
  const tallyIds = Array.from(new Set(results.map((r) => r.tallyTransactionId).filter((x): x is number => Boolean(x))));
  const gstIds = Array.from(new Set(results.map((r) => r.gstTransactionId).filter((x): x is number => Boolean(x))));
  const [tallyRows, gstRows] = await Promise.all([
    tallyIds.length
      ? prisma.tallyImport.findMany({ where: { id: { in: tallyIds } } })
      : Promise.resolve([]),
    gstIds.length
      ? prisma.gstTransaction.findMany({ where: { id: { in: gstIds } } })
      : Promise.resolve([]),
  ]);
  const tallyById = new Map(tallyRows.map((t) => [t.id, t]));
  const gstById = new Map(gstRows.map((g) => [g.id, g]));
  return results.map((r) => {
    const t = r.tallyTransactionId ? tallyById.get(r.tallyTransactionId as number) : undefined;
    const g = r.gstTransactionId ? gstById.get(r.gstTransactionId as number) : undefined;
    return {
      id: r.id,
      runId: r.runId,
      status: r.status,
      matchLevel: r.matchLevel,
      confidence: r.confidence,
      taxableDifference: num(r.taxableDifference),
      cgstDifference: num(r.cgstDifference),
      sgstDifference: num(r.sgstDifference),
      igstDifference: num(r.igstDifference),
      invoiceValueDifference: num(r.invoiceValueDifference),
      reason: r.reason,
      reviewStatus: r.reviewStatus,
      reviewedBy: r.reviewedBy,
      reviewedAt: r.reviewedAt ? new Date(r.reviewedAt).toISOString() : null,
      reviewNote: r.reviewNote,
      tally: t
        ? {
            id: t.id,
            voucherNumber: t.voucherNumber,
            voucherDate: iso(t.voucherDate),
            partyName: t.partyName,
            partyGSTIN: t.partyGSTIN,
            invoiceNumber: t.invoiceNumber,
            taxableValue: num(t.taxableValue),
            cgst: num(t.cgst),
            sgst: num(t.sgst),
            igst: num(t.igst),
            roundOff: num(t.roundOff),
            totalAmount: num(t.totalAmount),
          }
        : null,
      gst: g
        ? {
            id: g.id,
            invoiceNumber: g.invoiceNumber,
            invoiceDate: iso(g.invoiceDate),
            counterpartyGstin: g.counterpartyGstin,
            counterpartyName: g.counterpartyName,
            taxableValue: num(g.taxableValue),
            cgst: num(g.cgst),
            sgst: num(g.sgst),
            igst: num(g.igst),
            invoiceValue: num(g.invoiceValue),
          }
        : null,
    };
  });
}

const REVIEWABLE = ["ACCEPTED", "REJECTED", "REVIEWED"];

export async function reviewResult(
  id: number,
  body: { reviewStatus?: string; reviewNote?: string },
  reviewer: string,
): Promise<JoinedResult | null> {
  if (!body.reviewStatus || !REVIEWABLE.includes(body.reviewStatus)) {
    throw new Error("reviewStatus must be ACCEPTED, REJECTED or REVIEWED");
  }
  const existing = await prisma.gstReconciliationResult.findUnique({ where: { id } });
  if (!existing) return null;
  const updated = await prisma.gstReconciliationResult.update({
    where: { id },
    data: {
      reviewStatus: body.reviewStatus,
      reviewNote: body.reviewNote?.trim() ? body.reviewNote.trim() : null,
      reviewedBy: reviewer,
      reviewedAt: new Date(),
    },
  });
  const [joined] = await joinResults([updated as any]);
  return joined;
}