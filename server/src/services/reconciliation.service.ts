// Phase 2 Reconciliation engine.
//
// Matches the latest PURCHASE invoices against the latest GSTR-2B invoices and
// the latest SALES invoices against the latest GSTR-1 invoices using
// GSTIN + (fuzzy) invoice number, then validates date, taxable value, invoice
// number and per-head tax components (CGST, SGST, IGST). For each output row it
// records:
//   * status (MATCHED / MISMATCHED / MISSING_IN_2B / MISSING_IN_BOOKS /
//             DUPLICATE / MISSING_IN_GSTR1 / MISSING_IN_SALES)
//   * confidence (0-100)
//   * mismatch types and human-readable diff strings per field
//   * itcEligible / itcPending (ITC = input tax credit)
//
// Rules for ITC (as per Section 16 of CGST Act):
//   - Invoices fully matched in 2B                       => ITC eligible (full)
//   - Invoices that appear in 2B but with GST/date difference => ITC eligible on 2B amount only (pending the books-side difference)
//   - Invoices missing in 2B                             => ITC pending (full books tax deferred)
//   - Invoices missing in books (vendor filed but not purchased) => ITC not relevant for us (0 eligible, 0 pending)
//   - Duplicate                                          => ITC eligible once, on the first occurrence only and only when 2B confirms it; duplicate rows carry 0, and a duplicate with no 2B counterpart defers the full tax

import { prisma } from "../utils/prisma";
import { fuzzySame, normalizeInvoiceNo, levenshtein, invoiceKey, duplicateGroupInfo } from "../utils/fuzzy";
import { round3, totalTax, computeItc, isWithinTolerance, dateToleranceDays, NoteType } from "../utils/gst";
import { isValidGstin } from "../utils/gstin";
import { runPool } from "../utils/batch";
import { num } from "../utils/db";
import { openAISuggestion, explainMismatch as explainLocal } from "../ai/suggestions.ai";

export interface ReconSummary {
  totalPurchase: number;
  totalSales: number;
  bookInvoices: number;
  twoBInvoices: number;
  matched: number;
  mismatched: number;
  missingIn2B: number;
  missingInBooks: number;
  duplicates: number;
  gstDifference: number;
  vendors: number;
  matchPercent: number;
  itcEligible: number;
  itcPending: number;
  taxableDifference: number;
  salesMatched: number;
  salesMismatched: number;
  missingInGstr1: number;
  missingInSales: number;
  salesGstDifference: number;
}

export interface ReconMismatch {
  type: "WRONG_GSTIN" | "WRONG_TAX" | "WRONG_DATE" | "WRONG_TAXABLE" | "WRONG_INVOICE_NO" | "DUPLICATE" | "INVALID_GSTIN";
  detail: string;
}

export interface ReconPair {
  book?: DbInv;
  twoB?: DbInv;
  duplicateOf?: number;
}

type DbInv = {
  id: number; gstin: string; vendorName: string | null;
  invoiceNo: string; invoiceDate: Date;
  taxableValue: number; cgst: number; sgst: number; igst: number;
  cess?: number; noteType?: string;
};

type ResultRow = {
  runId: number;
  bookInvoiceId: number;
  twoBInvoiceId: number | null;
  status: string;
  confidence: number;
  mismatchTypes: string;
  bookInvoiceNo: string;
  bookGstin: string;
  twoBInvoiceNo: string | null;
  twoBGstin: string | null;
  vendorName: string | null;
  bookDate: Date | null;
  twoBDate: Date | null;
  invoiceNoDiff: string | null;
  dateDiff: string | null;
  bookTaxable: number;
  twoBTaxable: number | null;
  taxableDiff: number;
  bookTax: number;
  twoBTax: number | null;
  gstDiff: number;
  itcEligible: number;
  itcPending: number;
  aiWhat: string | null;
  aiReason: string | null;
  aiAction: string | null;
};

type SalesResultRow = {
  runId: number;
  salesInvoiceId: number;
  gstr1InvoiceId: number | null;
  status: string;
  confidence: number;
  mismatchTypes: string;
  bookInvoiceNo: string;
  bookGstin: string;
  gstr1InvoiceNo: string | null;
  gstr1Gstin: string | null;
  customerName: string | null;
  bookDate: Date | null;
  gstr1Date: Date | null;
  invoiceNoDiff: string | null;
  dateDiff: string | null;
  bookTaxable: number;
  gstr1Taxable: number | null;
  taxableDiff: number;
  bookTax: number;
  gstr1Tax: number | null;
  gstDiff: number;
  itcEligible: number;
  itcPending: number;
  aiWhat: string | null;
  aiReason: string | null;
  aiAction: string | null;
};

export async function runReconciliation(): Promise<{ runId: number; summary: ReconSummary; aiSummary: string; results: number }> {
  const purchase = (await prisma.invoice.findMany({ where: { source: "PURCHASE" }, orderBy: { id: "asc" } })) as unknown as DbInv[];
  const sales    = (await prisma.invoice.findMany({ where: { source: "SALES" },    orderBy: { id: "asc" } })) as unknown as DbInv[];
  const twoB     = (await prisma.invoice.findMany({ where: { source: "GSTR2B" },   orderBy: { id: "asc" } })) as unknown as DbInv[];
  const gstr1    = (await prisma.invoice.findMany({ where: { source: "GSTR1" },    orderBy: { id: "asc" } })) as unknown as DbInv[];

  // Decimal columns (production Postgres) come back as decimal.js objects; the
  // engine needs plain numbers. On the Float dev schema this is a no-op passthrough.
  const toDbInv = (i: any): DbInv => ({
    id: i.id, gstin: i.gstin, vendorName: i.vendorName, invoiceNo: i.invoiceNo,
    invoiceDate: i.invoiceDate,
    taxableValue: num(i.taxableValue), cgst: num(i.cgst), sgst: num(i.sgst), igst: num(i.igst),
    cess: num(i.cess), noteType: i.noteType,
  });
  const p = purchase.map(toDbInv);
  const s = sales.map(toDbInv);
  const t = twoB.map(toDbInv);
  const g = gstr1.map(toDbInv);

  const nextRun = await prisma.reconciliationResult.aggregate({ _max: { runId: true } });
  const runId = (nextRun._max.runId ?? 0) + 1;

  const results = await reconcilePurchases(p, t, runId);
  const salesResults = await reconcileSales(s, g, runId);

  // Clear previous run results for this runId (idempotent re-run) and persist
  await prisma.reconciliationResult.deleteMany({ where: { runId } });
  await prisma.reconciliationResult.createMany({ data: results as any });
  await prisma.salesReconciliationResult.deleteMany({ where: { runId } });
  await prisma.salesReconciliationResult.createMany({ data: salesResults as any });

  await buildNotifications(results as any);

  const matched = results.filter((r) => r.status === "MATCHED").length;
  const mismatched = results.filter((r) => r.status === "MISMATCHED").length;
  const missingIn2B = results.filter((r) => r.status === "MISSING_IN_2B").length;
  const missingInBooks = results.filter((r) => r.status === "MISSING_IN_BOOKS").length;
  const duplicates = results.filter((r) => r.status === "DUPLICATE").length;
  const totalBookingPairs = matched + mismatched + missingIn2B + duplicates;
  const matchPercent = totalBookingPairs ? Math.round((matched / totalBookingPairs) * 1000) / 10 : 0;
  const itcEligible = results.reduce((s, r) => s + r.itcEligible, 0);
  const itcPending = results.reduce((s, r) => s + r.itcPending, 0);
  const gstDifference = results.reduce((s, r) => s + Math.abs(r.gstDiff), 0);
  const taxableDifference = results.reduce((s, r) => s + Math.abs(r.taxableDiff), 0);

  const salesMatched = salesResults.filter((r) => r.status === "MATCHED").length;
  const salesMismatched = salesResults.filter((r) => r.status === "MISMATCHED").length;
  const missingInGstr1 = salesResults.filter((r) => r.status === "MISSING_IN_GSTR1").length;
  const missingInSales = salesResults.filter((r) => r.status === "MISSING_IN_SALES").length;

  const summary: ReconSummary = {
    totalPurchase: sum(p, "taxableValue"),
    totalSales: sum(s, "taxableValue"),
    bookInvoices: p.length,
    twoBInvoices: t.length,
    matched,
    mismatched,
    missingIn2B,
    missingInBooks,
    duplicates,
    gstDifference,
    vendors: new Set(p.map((x) => x.gstin)).size,
    matchPercent,
    itcEligible,
    itcPending,
    taxableDifference,
    salesMatched,
    salesMismatched,
    missingInGstr1,
    missingInSales,
    salesGstDifference: salesResults.reduce((s, r) => s + Math.abs(r.gstDiff), 0),
  };

  const aiSummary = await (await import("../ai/suggestions.ai")).openAISummary(summary, results);

  return { runId, summary, aiSummary, results: results.length };
}

interface AiJob {
  row: ResultRow | SalesResultRow;
  status: string;
  book: DbInv | undefined;
  twoB: DbInv | undefined;
  mismatches: ReconMismatch[];
}

export function reconcilePurchases(purchase: DbInv[], twoB: DbInv[], runId: number): Promise<ResultRow[]> {
  const twoBByGstin = groupBy(twoB, (i) => i.gstin);
  const results: ResultRow[] = [];
  const twoBUsedIds = new Set<number>();

  // O(N) duplicate grouping: rows sharing GSTIN + canonical invoice key. Every
  // member of a group with >1 rows is flagged DUPLICATE; only the first owns
  // its ITC, later rows carry 0.
  const { dupes: purchaseDupes, firstOwners: purchaseFirstOwners } = duplicateGroupInfo(
    purchase,
    (b) => `${b.gstin}|${invoiceKey(b.invoiceNo)}`,
  );

  // Deferred AI jobs so suggestion calls can run as a bounded concurrency pool
  // instead of one serial await per invoice.
  const aiJobs: AiJob[] = [];

  // 1) Walk every PURCHASE invoice; find its 2B counterpart.
  return (async () => {
    for (const b of purchase) {
      const candidates = twoBByGstin.get(b.gstin) || [];

      let twoBMatch: DbInv | undefined = candidates.find(t => t.invoiceNo === b.invoiceNo && !twoBUsedIds.has(t.id));
      if (!twoBMatch) twoBMatch = candidates.find(t => fuzzySame(t.invoiceNo, b.invoiceNo) && !twoBUsedIds.has(t.id));

      // Cross-GSTIN candidate to surface wrong-GSTIN case
      let wrongGstinCandidate: DbInv | undefined;
      if (!twoBMatch) {
        for (const [gstin, list] of twoBByGstin.entries()) {
          if (gstin === b.gstin) continue;
          const t = list.find(x => fuzzySame(x.invoiceNo, b.invoiceNo) && !twoBUsedIds.has(x.id));
          if (t) { wrongGstinCandidate = t; break; }
        }
      }

      const match = twoBMatch ?? wrongGstinCandidate;
      if (match) twoBUsedIds.add(match.id);

      // O(1) duplicate lookup (was an O(N) `find` per row).
      const isDuplicate = purchaseDupes.has(b);
      const ownsItc = purchaseFirstOwners.has(b);

      let status: ResultRow["status"];
      let confidence = 100;
      const mismatches: ReconMismatch[] = [];
      let invoiceNoDiff: string | null = null;
      let dateDiffStr: string | null = null;

      if (isDuplicate) {
        status = "DUPLICATE";
        mismatches.push({ type: "DUPLICATE", detail: `Invoice "${b.invoiceNo}" appears more than once in Purchase Register for GSTIN ${b.gstin}` });
        confidence = 80;
      } else if (!match) {
        status = "MISSING_IN_2B";
        mismatches.push({ type: "WRONG_GSTIN", detail: "Not present in GSTR-2B under any GSTIN" });
        confidence = 70;
      } else {
        const t = match;
        if (b.gstin !== t.gstin) {
          mismatches.push({ type: "WRONG_GSTIN", detail: `Books GSTIN ${b.gstin} vs 2B GSTIN ${t.gstin}` });
          confidence -= 40;
        }
        if (!isValidGstin(b.gstin) || !isValidGstin(t.gstin)) {
          mismatches.push({ type: "INVALID_GSTIN", detail: `GSTIN format invalid: books "${b.gstin}" / 2B "${t.gstin}"` });
          confidence -= 10;
        }
        // Invoice number difference: only when fuzzily matched, not exact
        if (normalizeInvoiceNo(b.invoiceNo) !== normalizeInvoiceNo(t.invoiceNo)) {
          const dist = levenshtein(normalizeInvoiceNo(b.invoiceNo), normalizeInvoiceNo(t.invoiceNo));
          invoiceNoDiff = `Books "${b.invoiceNo}" vs 2B "${t.invoiceNo}" (fuzzy distance ${dist})`;
          mismatches.push({ type: "WRONG_INVOICE_NO", detail: invoiceNoDiff });
          confidence -= 15;
        }
        // Date difference
        const dd = Math.round(dateDiffMs(b.invoiceDate, t.invoiceDate) / (1000 * 60 * 60 * 24));
        if (Math.abs(dd) > dateToleranceDays()) {
          dateDiffStr = `Books ${fmt(b.invoiceDate)} vs 2B ${fmt(t.invoiceDate)} (${dd > 0 ? "+" : ""}${dd} day${Math.abs(dd) > 1 ? "s" : ""})`;
          mismatches.push({ type: "WRONG_DATE", detail: dateDiffStr });
          confidence -= 15;
        }
        // Taxable difference (tolerance aware). Credit/debit notes are
        // recorded negated in the register but positive in the portal note
        // tables, so magnitudes are compared for note rows.
        const absNote = b.noteType !== undefined && b.noteType !== "INVOICE";
        const tDiff = absNote
          ? round3(Math.abs(b.taxableValue) - Math.abs(t.taxableValue))
          : round3(b.taxableValue - t.taxableValue);
        if (!isWithinTolerance(Math.abs(b.taxableValue), Math.abs(t.taxableValue))) {
          mismatches.push({ type: "WRONG_TAXABLE", detail: `Books taxable ${b.taxableValue} vs 2B ${t.taxableValue} (diff ${tDiff})` });
          confidence -= 20;
        }
        // Tax difference (incl. CESS, tolerance aware)
        const bookTax = totalTax(b.cgst, b.sgst, b.igst, b.cess ?? 0);
        const twoBTax = totalTax(t.cgst, t.sgst, t.igst, t.cess ?? 0);
        const gDiff = absNote
          ? round3(Math.abs(bookTax) - Math.abs(twoBTax))
          : round3(bookTax - twoBTax);
        if (!isWithinTolerance(Math.abs(bookTax), Math.abs(twoBTax))) {
          mismatches.push({ type: "WRONG_TAX", detail: `Books GST ${bookTax} vs 2B GST ${twoBTax} (diff ${gDiff})` });
          confidence -= 25;
        }
        status = mismatches.length === 0 ? "MATCHED" : "MISMATCHED";
      }

      const bookTax = totalTax(b.cgst, b.sgst, b.igst, b.cess ?? 0);
      const twoBTax = match ? totalTax(match.cgst, match.sgst, match.igst, match.cess ?? 0) : null;
      const absNote = b.noteType !== undefined && b.noteType !== "INVOICE";
      const gstDiff = match
        ? (absNote ? round3(Math.abs(bookTax) - Math.abs(twoBTax!)) : round3(bookTax - twoBTax!))
        : bookTax;
      const taxableDiff = match ? round3(b.taxableValue - match.taxableValue) : b.taxableValue;

      const itc = computeItc(status, bookTax, twoBTax, ownsItc, (b.noteType as NoteType) ?? "INVOICE");

      const row: ResultRow = {
        runId,
        bookInvoiceId: b.id,
        twoBInvoiceId: match?.id ?? null,
        status,
        confidence: Math.max(0, Math.min(100, confidence)),
        mismatchTypes: mismatches.map((m) => m.type).join(","),
        bookInvoiceNo: b.invoiceNo,
        bookGstin: b.gstin,
        twoBInvoiceNo: match?.invoiceNo ?? null,
        twoBGstin: match?.gstin ?? null,
        vendorName: b.vendorName,
        bookDate: b.invoiceDate,
        twoBDate: match?.invoiceDate ?? null,
        invoiceNoDiff,
        dateDiff: dateDiffStr,
        bookTaxable: b.taxableValue,
        twoBTaxable: match?.taxableValue ?? null,
        taxableDiff,
        bookTax,
        twoBTax,
        gstDiff,
        itcEligible: itc.itcEligible,
        itcPending: itc.itcPending,
        aiWhat: null,
        aiReason: null,
        aiAction: null,
      };
      results.push(row);
      aiJobs.push({ row, status, book: b, twoB: match, mismatches });
    }

    // 2) GSTR-2B rows that have no Books counterpart => MISSING_IN_BOOKS
    for (const t of twoB) {
      if (twoBUsedIds.has(t.id)) continue;
      const row: ResultRow = {
        runId,
        bookInvoiceId: 0,
        twoBInvoiceId: t.id,
        status: "MISSING_IN_BOOKS",
        confidence: 70,
        mismatchTypes: "",
        bookInvoiceNo: "",
        bookGstin: "",
        twoBInvoiceNo: t.invoiceNo,
        twoBGstin: t.gstin,
        vendorName: t.vendorName,
        bookDate: null,
        twoBDate: t.invoiceDate,
        invoiceNoDiff: null,
        dateDiff: null,
        bookTaxable: 0,
        twoBTaxable: t.taxableValue,
        taxableDiff: -t.taxableValue,
        bookTax: 0,
        twoBTax: totalTax(t.cgst, t.sgst, t.igst),
        gstDiff: -totalTax(t.cgst, t.sgst, t.igst),
        itcEligible: 0,
        itcPending: 0,
        aiWhat: null, aiReason: null, aiAction: null,
      };
      results.push(row);
      aiJobs.push({ row, status: "MISSING_IN_BOOKS", book: undefined, twoB: t, mismatches: [] });
    }

    await fillExplanations(aiJobs);

    return results;
  })();
}

export function reconcileSales(sales: DbInv[], gstr1: DbInv[], runId: number): Promise<SalesResultRow[]> {
  const byGstin = groupBy(gstr1, (i) => i.gstin);
  const used = new Set<number>();

  const { dupes: salesDupes } = duplicateGroupInfo(
    sales,
    (s) => `${s.gstin}|${invoiceKey(s.invoiceNo)}`,
  );
  const aiJobs: AiJob[] = [];

  return (async () => {
    const rows: SalesResultRow[] = [];

    // 1) Walk every SALES invoice; find its GSTR-1 counterpart.
    for (const s of sales) {
      const candidates = byGstin.get(s.gstin) || [];

      let match: DbInv | undefined = candidates.find(g => g.invoiceNo === s.invoiceNo && !used.has(g.id));
      if (!match) match = candidates.find(g => fuzzySame(g.invoiceNo, s.invoiceNo) && !used.has(g.id));

      // Cross-GSTIN candidate to surface wrong-GSTIN case
      let wrongGstinCandidate: DbInv | undefined;
      if (!match) {
        for (const [gstin, list] of byGstin.entries()) {
          if (gstin === s.gstin) continue;
          const t = list.find(x => fuzzySame(x.invoiceNo, s.invoiceNo) && !used.has(x.id));
          if (t) { wrongGstinCandidate = t; break; }
        }
      }

      match = match ?? wrongGstinCandidate;
      if (match) used.add(match.id);

      const isDuplicate = salesDupes.has(s);

      let status: SalesResultRow["status"];
      let confidence = 100;
      const mismatches: ReconMismatch[] = [];
      let invoiceNoDiff: string | null = null;
      let dateDiffStr: string | null = null;

      if (isDuplicate) {
        status = "DUPLICATE";
        mismatches.push({ type: "DUPLICATE", detail: `Invoice "${s.invoiceNo}" appears more than once in Sales Register for GSTIN ${s.gstin}` });
        confidence = 80;
      } else if (!match) {
        status = "MISSING_IN_GSTR1";
        mismatches.push({ type: "WRONG_GSTIN", detail: "Not present in GSTR-1 under any GSTIN" });
        confidence = 70;
      } else {
        const t = match;
        if (s.gstin !== t.gstin) {
          mismatches.push({ type: "WRONG_GSTIN", detail: `Books GSTIN ${s.gstin} vs GSTR-1 GSTIN ${t.gstin}` });
          confidence -= 40;
        }
        if (!isValidGstin(s.gstin) || !isValidGstin(t.gstin)) {
          mismatches.push({ type: "INVALID_GSTIN", detail: `GSTIN format invalid: books "${s.gstin}" / GSTR-1 "${t.gstin}"` });
          confidence -= 10;
        }
        if (normalizeInvoiceNo(s.invoiceNo) !== normalizeInvoiceNo(t.invoiceNo)) {
          const dist = levenshtein(normalizeInvoiceNo(s.invoiceNo), normalizeInvoiceNo(t.invoiceNo));
          invoiceNoDiff = `Books "${s.invoiceNo}" vs GSTR-1 "${t.invoiceNo}" (fuzzy distance ${dist})`;
          mismatches.push({ type: "WRONG_INVOICE_NO", detail: invoiceNoDiff });
          confidence -= 15;
        }
        const dd = Math.round(dateDiffMs(s.invoiceDate, t.invoiceDate) / (1000 * 60 * 60 * 24));
        if (Math.abs(dd) > dateToleranceDays()) {
          dateDiffStr = `Books ${fmt(s.invoiceDate)} vs GSTR-1 ${fmt(t.invoiceDate)} (${dd > 0 ? "+" : ""}${dd} day${Math.abs(dd) > 1 ? "s" : ""})`;
          mismatches.push({ type: "WRONG_DATE", detail: dateDiffStr });
          confidence -= 15;
        }
        const tDiff = round3(s.taxableValue - t.taxableValue);
        if (!isWithinTolerance(s.taxableValue, t.taxableValue)) {
          mismatches.push({ type: "WRONG_TAXABLE", detail: `Books taxable ${s.taxableValue} vs GSTR-1 ${t.taxableValue} (diff ${tDiff})` });
          confidence -= 20;
        }
        const bookTax = totalTax(s.cgst, s.sgst, s.igst, s.cess ?? 0);
        const gTax = totalTax(t.cgst, t.sgst, t.igst, t.cess ?? 0);
        const gDiff = round3(bookTax - gTax);
        if (!isWithinTolerance(bookTax, gTax)) {
          mismatches.push({ type: "WRONG_TAX", detail: `Books GST ${bookTax} vs GSTR-1 GST ${gTax} (diff ${gDiff})` });
          confidence -= 25;
        }
        status = mismatches.length === 0 ? "MATCHED" : "MISMATCHED";
      }

      const bookTax = totalTax(s.cgst, s.sgst, s.igst, s.cess ?? 0);
      const gTax = match ? totalTax(match.cgst, match.sgst, match.igst, match.cess ?? 0) : null;
      const gstDiff = match ? round3(bookTax - gTax!) : bookTax;
      const taxableDiff = match ? round3(s.taxableValue - match.taxableValue) : s.taxableValue;

      const row: SalesResultRow = {
        runId,
        salesInvoiceId: s.id,
        gstr1InvoiceId: match?.id ?? null,
        status,
        confidence: Math.max(0, Math.min(100, confidence)),
        mismatchTypes: mismatches.map((m) => m.type).join(","),
        bookInvoiceNo: s.invoiceNo,
        bookGstin: s.gstin,
        gstr1InvoiceNo: match?.invoiceNo ?? null,
        gstr1Gstin: match?.gstin ?? null,
        customerName: s.vendorName,
        bookDate: s.invoiceDate,
        gstr1Date: match?.invoiceDate ?? null,
        invoiceNoDiff,
        dateDiff: dateDiffStr,
        bookTaxable: s.taxableValue,
        gstr1Taxable: match?.taxableValue ?? null,
        taxableDiff,
        bookTax,
        gstr1Tax: gTax,
        gstDiff,
        itcEligible: 0,
        itcPending: 0,
        aiWhat: null,
        aiReason: null,
        aiAction: null,
      };
      rows.push(row);
      aiJobs.push({ row, status, book: s, twoB: match, mismatches });
    }

    // 2) GSTR-1 rows with no Sales counterpart => MISSING_IN_SALES
    for (const g of gstr1) {
      if (used.has(g.id)) continue;
      const row: SalesResultRow = {
        runId,
        salesInvoiceId: 0,
        gstr1InvoiceId: g.id,
        status: "MISSING_IN_SALES",
        confidence: 70,
        mismatchTypes: "",
        bookInvoiceNo: "",
        bookGstin: "",
        gstr1InvoiceNo: g.invoiceNo,
        gstr1Gstin: g.gstin,
        customerName: g.vendorName,
        bookDate: null,
        gstr1Date: g.invoiceDate,
        invoiceNoDiff: null,
        dateDiff: null,
        bookTaxable: 0,
        gstr1Taxable: g.taxableValue,
        taxableDiff: -g.taxableValue,
        bookTax: 0,
        gstr1Tax: totalTax(g.cgst, g.sgst, g.igst),
        gstDiff: -totalTax(g.cgst, g.sgst, g.igst),
        itcEligible: 0,
        itcPending: 0,
        aiWhat: null, aiReason: null, aiAction: null,
      };
      rows.push(row);
      aiJobs.push({ row, status: "MISSING_IN_SALES", book: undefined, twoB: g, mismatches: [] });
    }

    await fillExplanations(aiJobs);

    return rows;
  })();
}

// Runs all pending AI explanation jobs through a bounded concurrency pool so we
// never issue one serial request per invoice. GST figures are untouched: AI only
// fills the human-readable what/reason/action text fields.
async function fillExplanations(jobs: AiJob[]): Promise<void> {
  const concurrency = Math.max(1, Number(process.env.AI_CONCURRENCY || 5));
  await runPool(jobs, async (job) => {
    const ai = await buildExplanation(job.status, job.book, job.twoB, job.mismatches);
    (job.row as ResultRow).aiWhat = ai.what;
    (job.row as ResultRow).aiReason = ai.reason;
    (job.row as ResultRow).aiAction = ai.action;
  }, concurrency);
}

async function buildExplanation(status: string, book: DbInv | undefined, twoB: DbInv | undefined, mismatches: ReconMismatch[]) {
  const tryAI = process.env.OPENAI_API_KEY ? await openAISuggestion(status, book, twoB, mismatches) : null;
  if (tryAI) return tryAI;
  return explainLocal(status, book, twoB, mismatches);
}

async function buildNotifications(results: any[]) {
  const admins = await prisma.user.findMany({ where: { role: "ADMIN" } });
  if (!admins.length) return;
  const threshold = Number(process.env.GST_DIFF_THRESHOLD || 50);

  const mismatchCount = results.filter((r) => r.status !== "MATCHED").length;
  const missingVendors = results.filter((r) => r.status === "MISSING_IN_2B" && !r.mismatchTypes.includes("WRONG_GSTIN")).length;
  const gstDiffTotal = results.reduce((s, r) => s + Math.abs(r.gstDiff), 0);

  const notes: any[] = [];
  if (mismatchCount) notes.push({ type: "MISMATCH_DETECTED", title: "New mismatches detected", message: `${mismatchCount} invoices need attention` });
  if (missingVendors) notes.push({ type: "VENDOR_MISSING", title: "Missing vendors in 2B", message: `${missingVendors} invoices missing in GSTR-2B` });
  if (gstDiffTotal > threshold) notes.push({ type: "GST_DIFF_THRESHOLD_BREACHED", title: "GST difference high", message: `Total GST difference Rs. ${gstDiffTotal.toFixed(2)} exceeds threshold ${threshold}` });

  for (const a of admins) {
    for (const n of notes) {
      await prisma.notification.create({ data: { userId: a.id, type: n.type, title: n.title, message: n.message } });
    }
  }
}

// ---------- helpers ----------
function groupBy<T>(arr: T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const item of arr) {
    const k = key(item);
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(item);
  }
  return m;
}
function dateDiffMs(a: Date, b: Date) {
  const aMid = new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime();
  const bMid = new Date(b.getFullYear(), b.getMonth(), b.getDate()).getTime();
  return aMid - bMid;
}
function sum(arr: any[], key: string) { return arr.reduce((s, x) => s + Number(x[key] ?? 0), 0); }
function fmt(d: Date) { return d.toISOString().slice(0, 10); }