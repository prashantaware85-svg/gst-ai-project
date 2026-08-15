import { Router, Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../utils/prisma";
import { authenticate } from "../middleware/auth.middleware";
import { num, numOrNull } from "../utils/db";

export const dashboardRouter = Router();

const STATUS_VALUES = ["MATCHED", "MISMATCHED", "MISSING_IN_2B", "MISSING_IN_BOOKS", "DUPLICATE"] as const;
type StatusFilter = (typeof STATUS_VALUES)[number];

interface RawRow {
  id: number; runId: number; status: string; confidence: number;
  mismatchTypes: string; bookInvoiceId: number; twoBInvoiceId: number | null;
  bookInvoiceNo: string; bookGstin: string;
  twoBInvoiceNo: string | null; twoBGstin: string | null; vendorName: string | null;
  bookDate: Date | null; twoBDate: Date | null;
  invoiceNoDiff: string | null; dateDiff: string | null;
  bookTaxable: number; twoBTaxable: number | null; taxableDiff: number;
  bookTax: number; twoBTax: number | null; gstDiff: number;
  itcEligible: number; itcPending: number;
  aiWhat: string | null; aiReason: string | null; aiAction: string | null;
}

interface SalesRawRow {
  id: number; runId: number; status: string; confidence: number;
  mismatchTypes: string; salesInvoiceId: number; gstr1InvoiceId: number | null;
  bookInvoiceNo: string; bookGstin: string;
  gstr1InvoiceNo: string | null; gstr1Gstin: string | null; customerName: string | null;
  bookDate: Date | null; gstr1Date: Date | null;
  invoiceNoDiff: string | null; dateDiff: string | null;
  bookTaxable: number; gstr1Taxable: number | null; taxableDiff: number;
  bookTax: number; gstr1Tax: number | null; gstDiff: number;
  itcEligible: number; itcPending: number;
  aiWhat: string | null; aiReason: string | null; aiAction: string | null;
}

function buildWhere(q: string): Prisma.ReconciliationResultWhereInput {
  const filters: Prisma.ReconciliationResultWhereInput = {};
  const status = ((q.match(/status=([^&]+)/) || [])[1] || "") as StatusFilter;
  const vendor = (q.match(/vendor=([^&]+)/) || [])[1] || "";
  const gstin = (q.match(/gstin=([^&]+)/) || [])[1] || "";
  const mismatch = (q.match(/mismatch=([^&]+)/) || [])[1] || "";
  if (STATUS_VALUES.includes(status as any)) filters.status = status as any;
  if (vendor) filters.vendorName = { contains: vendor };
  if (gstin) {
    filters.OR = [{ bookGstin: { contains: gstin } }, { twoBGstin: { contains: gstin } }];
  }
  if (mismatch) filters.mismatchTypes = { contains: mismatch };
  return filters;
}

// /dashboard returns summary + vendor breakdown + recent mismatches + chart datasets.
dashboardRouter.get("/dashboard", authenticate, async (_req: Request, res: Response) => {
  const latest = await prisma.reconciliationResult.findFirst({ orderBy: { runId: "desc" } });
  const runId = latest?.runId ?? 0;
  if (!runId) return res.json(emptyDashboard());

  const rows = (await prisma.reconciliationResult.findMany({
    where: { runId },
    orderBy: { id: "asc" },
  })).map(normalizeRow) as unknown as RawRow[];
  const salesRows = (await prisma.salesReconciliationResult.findMany({
    where: { runId },
    orderBy: { id: "asc" },
  })).map(normalizeSalesRow) as unknown as SalesRawRow[];

  const summary = computeSummary(rows, salesRows);
  const vendors = await buildVendorBreakdown(rows);
  const recentMismatches = rows.filter((r) => r.status !== "MATCHED").slice(0, 10);

  return res.json({
    summary,
    vendors,
    recentMismatches,
    runId,
    aiSummary: "", // populated by /reconcile, kept blank on read-only dashboards
  });
});

// /dashboard/invoices — paginated, filterable invoice list for the table page.
dashboardRouter.get("/dashboard/invoices", authenticate, async (req: Request, res: Response) => {
  const latest = await prisma.reconciliationResult.findFirst({ orderBy: { runId: "desc" } });
  if (!latest) return res.json({ rows: [], total: 0, page: 1, pageSize: 0 });
  const where = buildWhere(req.url.split("?")[1] || "");
  where.runId = latest.runId;

  const page = Number(req.query.page) || 1;
  const pageSize = Math.min(Number(req.query.pageSize) || 25, 200);

  const [rows, total] = await Promise.all([
    prisma.reconciliationResult.findMany({ where, orderBy: { id: "asc" }, skip: (page - 1) * pageSize, take: pageSize }),
    prisma.reconciliationResult.count({ where }),
  ]);

  return res.json({ rows: rows.map(normalizeRow), total, page, pageSize });
});

function emptyDashboard() {
  return {
    summary: { totalPurchase: 0, totalSales: 0, bookInvoices: 0, twoBInvoices: 0, matched: 0, mismatched: 0, missingIn2B: 0, missingInBooks: 0, duplicates: 0, gstDifference: 0, vendors: 0, matchPercent: 0, itcEligible: 0, itcPending: 0, taxableDifference: 0, salesMatched: 0, salesMismatched: 0, missingInGstr1: 0, missingInSales: 0, salesGstDifference: 0 },
    vendors: [], recentMismatches: [], runId: 0, aiSummary: "",
  };
}

// Decimal columns (prod Postgres) return decimal.js objects; normalise money
// fields to plain numbers so the JSON API stays identical on Float (dev).
function normalizeRow(r: any) {
  for (const k of ["bookTaxable", "twoBTaxable", "taxableDiff", "bookTax", "twoBTax", "gstDiff", "itcEligible", "itcPending"] as const) {
    if (Object.prototype.hasOwnProperty.call(r, k) && r[k] !== null && r[k] !== undefined) r[k] = num(r[k]);
  }
  return r;
}
function normalizeSalesRow(r: any) {
  for (const k of ["bookTaxable", "gstr1Taxable", "taxableDiff", "bookTax", "gstr1Tax", "gstDiff", "itcEligible", "itcPending"] as const) {
    if (Object.prototype.hasOwnProperty.call(r, k) && r[k] !== null && r[k] !== undefined) r[k] = num(r[k]);
  }
  return r;
}

function computeSummary(rows: RawRow[], salesRows: SalesRawRow[]) {
  const matched = rows.filter((r) => r.status === "MATCHED").length;
  const mismatched = rows.filter((r) => r.status === "MISMATCHED").length;
  const missingIn2B = rows.filter((r) => r.status === "MISSING_IN_2B").length;
  const missingInBooks = rows.filter((r) => r.status === "MISSING_IN_BOOKS").length;
  const duplicates = rows.filter((r) => r.status === "DUPLICATE").length;
  const bookingPairs = matched + mismatched + missingIn2B + duplicates;
  const matchPercent = bookingPairs ? Math.round((matched / bookingPairs) * 1000) / 10 : 0;

  const salesMatched = salesRows.filter((r) => r.status === "MATCHED").length;
  const salesMismatched = salesRows.filter((r) => r.status === "MISMATCHED").length;
  const missingInGstr1 = salesRows.filter((r) => r.status === "MISSING_IN_GSTR1").length;
  const missingInSales = salesRows.filter((r) => r.status === "MISSING_IN_SALES").length;

  return {
    totalPurchase: rows.reduce((s, r) => s + r.bookTaxable, 0),
    totalSales: salesRows.reduce((s, r) => s + r.bookTaxable, 0),
    bookInvoices: rows.filter((r) => r.bookInvoiceId).length,
    twoBInvoices: rows.filter((r) => r.twoBInvoiceId).length,
    matched, mismatched, missingIn2B, missingInBooks, duplicates,
    gstDifference: rows.reduce((s, r) => s + Math.abs(r.gstDiff), 0),
    taxableDifference: rows.reduce((s, r) => s + Math.abs(r.taxableDiff), 0),
    vendors: new Set(rows.map((r) => r.bookGstin || r.twoBGstin).filter(Boolean)).size,
    matchPercent,
    itcEligible: rows.reduce((s, r) => s + r.itcEligible, 0),
    itcPending: rows.reduce((s, r) => s + r.itcPending, 0),
    salesMatched,
    salesMismatched,
    missingInGstr1,
    missingInSales,
    salesGstDifference: salesRows.reduce((s, r) => s + Math.abs(r.gstDiff), 0),
  };
}

async function buildVendorBreakdown(rows: RawRow[]) {
  const map = new Map<string, any>();
  for (const r of rows) {
    const gstin = r.bookGstin || r.twoBGstin || "UNKNOWN";
    if (!map.has(gstin)) map.set(gstin, { gstin, vendorName: r.vendorName || "", matched: 0, mismatch: 0, pending: 0, missing: 0, duplicates: 0, totalGst: 0, itcEligible: 0, itcPending: 0 });
    const v = map.get(gstin);
    if (r.status === "MATCHED") v.matched++;
    else if (r.status === "MISSING_IN_2B") v.missing++;
    else if (r.status === "DUPLICATE") v.duplicates++;
    else v.mismatch++;
    const tax = r.bookTax || r.twoBTax || 0;
    v.totalGst += tax;
    v.itcEligible += r.itcEligible || 0;
    v.itcPending += r.itcPending || 0;
  }
  return Array.from(map.values());
}
