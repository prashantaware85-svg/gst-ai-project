import { Router, Request, Response } from "express";
import * as XLSX from "xlsx";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import fs from "node:fs";
import path from "node:path";
import { Prisma } from "@prisma/client";
import { prisma } from "../utils/prisma";
import { authenticate } from "../middleware/auth.middleware";
import { num, numOrNull } from "../utils/db";

export const reportsRouter = Router();
const reportDir = process.env.REPORT_DIR || "./reports";
fs.mkdirSync(path.resolve(reportDir), { recursive: true });

type StatusFilter = "MATCHED" | "MISMATCHED" | "MISSING_IN_2B" | "MISSING_IN_BOOKS" | "DUPLICATE";

const COMMON_COLS = [
  "vendorName", "status", "confidence", "bookInvoiceNo", "bookGstin",
  "twoBInvoiceNo", "twoBGstin", "bookDate", "twoBDate", "dateDiff", "invoiceNoDiff",
  "bookTaxable", "twoBTaxable", "taxableDiff", "bookTax", "twoBTax", "gstDiff",
  "itcEligible", "itcPending", "mismatchTypes", "aiWhat", "aiReason", "aiAction",
] as const;
type Col = (typeof COMMON_COLS)[number];

// Each report maps to a Prisma WHERE clause so filtering happens in SQL and we
// never pull the entire run's rows into memory just to drop most of them.
const REPORTS: Record<string, {
  where: Prisma.ReconciliationResultWhereInput;
  cols: ReadonlyArray<Col>;
  title: string;
}> = {
  match:     { where: { status: "MATCHED" },                                        cols: COMMON_COLS, title: "Matched Invoices" },
  mismatch:  { where: { status: { not: "MATCHED" } },                               cols: COMMON_COLS, title: "Mismatched Invoices" },
  vendor:    { where: { OR: [{ bookGstin: { not: "" } }, { twoBGstin: { not: "" } }] }, cols: ["bookGstin", "vendorName", "bookTaxable", "gstDiff", "taxableDiff"], title: "Vendor Summary" },
  missing:   { where: { status: { in: ["MISSING_IN_2B", "MISSING_IN_BOOKS"] } },    cols: COMMON_COLS, title: "Missing Invoices" },
  duplicate: { where: { status: "DUPLICATE" },                                      cols: COMMON_COLS, title: "Duplicate Invoices" },
  gst:       { where: { OR: [{ gstDiff: { gt: 0.01 } }, { gstDiff: { lt: -0.01 } }] }, cols: ["vendorName", "bookInvoiceNo", "bookGstin", "bookTax", "twoBTax", "gstDiff", "itcEligible", "itcPending", "confidence", "aiWhat"], title: "GST Difference Report" },
  date:      { where: { dateDiff: { not: null } },                                  cols: ["vendorName", "bookInvoiceNo", "bookDate", "twoBDate", "dateDiff", "confidence", "aiWhat"], title: "Invoice Date Difference Report" },
  invoiceNo: { where: { invoiceNoDiff: { not: null } },                             cols: ["vendorName", "bookInvoiceNo", "twoBInvoiceNo", "invoiceNoDiff", "confidence", "aiWhat"], title: "Invoice Number Difference Report" },
};

const FIELD_WIDTHS: Partial<Record<Col, number>> = {
  vendorName: 28, bookInvoiceNo: 18, twoBInvoiceNo: 18,
  bookGstin: 18, twoBGstin: 18, dateDiff: 32, invoiceNoDiff: 38,
  aiWhat: 60, aiReason: 60, aiAction: 60, mismatchTypes: 30,
  bookDate: 12, twoBDate: 12,
};

// Cap the number of rows a report will read at once; very large exports page
// through the dataset internally instead of materialising everything.
const MAX_REPORT_ROWS = 50_000;

reportsRouter.get("/reports", authenticate, async (req: Request, res: Response) => {
  const type = String(req.query.type || "mismatch");
  const format = String(req.query.format || "json");
  const report = REPORTS[type];
  if (!report) return res.status(400).json({ error: "BadRequest", message: "Unknown report type" });

  const latest = await prisma.reconciliationResult.findFirst({ orderBy: { runId: "desc" } });
  const runId = latest?.runId ?? 0;

  if (format === "json") {
    // Server-side pagination keeps JSON payloads bounded.
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(Math.max(Number(req.query.pageSize) || 500, 1), 5000);
    const baseWhere: Prisma.ReconciliationResultWhereInput = { ...report.where, runId };
    const [rows, count] = await Promise.all([
      prisma.reconciliationResult.findMany({
        where: baseWhere,
        orderBy: { id: "asc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.reconciliationResult.count({ where: baseWhere }),
    ]);
    const arr = rows.map((r) => pick(serialize(r), report.cols));
    return res.json({ type, count, total: count, page, pageSize, runId, rows: arr });
  }

  // Spreadsheet / PDF exports stream paged batches through the pipeline so the
  // working set stays small for large result sets.
  const filtered: any[] = [];
  const baseWhere: Prisma.ReconciliationResultWhereInput = { ...report.where, runId };
  for (let page = 0; ; page++) {
    const batch = await prisma.reconciliationResult.findMany({
      where: baseWhere,
      orderBy: { id: "asc" },
      skip: page * MAX_REPORT_ROWS,
      take: MAX_REPORT_ROWS,
    }) as any[];
    if (!batch.length) break;
    for (const r of batch) filtered.push(serialize(r));
    if (filtered.length >= MAX_REPORT_ROWS) break;
  }

  if (format === "xlsx") return sendExcel(res, report.title, report.cols, filtered);
  if (format === "csv")  return sendCsv(res, report.title, report.cols, filtered);
  if (format === "pdf")  return sendPdf(res, report.title, report.cols, filtered, runId);
  return res.status(400).json({ error: "BadRequest", message: "Unknown format" });
});

function serialize(r: any) {
  return {
    ...r,
    bookDate: r.bookDate ? new Date(r.bookDate).toISOString().slice(0, 10) : "",
    twoBDate: r.twoBDate ? new Date(r.twoBDate).toISOString().slice(0, 10) : "",
    mismatchTypes: Array.isArray(r.mismatchTypes) ? r.mismatchTypes.join(", ") : r.mismatchTypes ?? "",
    dateDiff: r.dateDiff || "",
    invoiceNoDiff: r.invoiceNoDiff || "",
    bookTaxable: num(r.bookTaxable),
    twoBTaxable: numOrNull(r.twoBTaxable),
    taxableDiff: num(r.taxableDiff),
    bookTax: num(r.bookTax),
    twoBTax: numOrNull(r.twoBTax),
    gstDiff: num(r.gstDiff),
    itcEligible: num(r.itcEligible),
    itcPending: num(r.itcPending),
  };
}

function pick(r: any, cols: ReadonlyArray<Col>) {
  const out: any = {};
  for (const c of cols) out[c] = r[c] ?? "";
  return out;
}

function sendExcel(res: Response, title: string, cols: ReadonlyArray<Col>, rows: any[]) {
  const wb = XLSX.utils.book_new();
  const headerRow = cols.map((c) => titleFor(c));
  const dataRows = rows.map((r) => cols.map((c) => r[c] ?? ""));
  const ws = XLSX.utils.aoa_to_sheet([headerRow, ...dataRows]);
  // Set column widths
  ws["!cols"] = cols.map((c) => ({ wch: FIELD_WIDTHS[c] ?? 14 }));
  XLSX.utils.book_append_sheet(wb, ws, title.slice(0, 31));
  const file = path.resolve(reportDir, `${slug(title)}-${Date.now()}.xlsx`);
  XLSX.writeFile(wb, file);
  return res.download(file, path.basename(file), () => fs.unlinkSync(file));
}

async function sendPdf(res: Response, title: string, cols: ReadonlyArray<Col>, rows: any[], runId: number) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const pageW = 595; const pageH = 842;
  const left = 40, right = pageW - 40;
  let y = pageH - 60;

  const addPage = () => { const p = doc.addPage([pageW, pageH]); y = pageH - 60; return p; };
  let page = doc.addPage([pageW, pageH]);

  // Title bar
  page.drawRectangle({ x: 0, y: pageH - 50, width: pageW, height: 50, color: rgb(0.13, 0.34, 0.74) });
  page.drawText("GST AI Reconciliation Agent", { x: left, y: pageH - 30, size: 14, font: bold, color: rgb(1, 1, 1) });
  page.drawText(title, { x: left, y: pageH - 56, size: 18, font: bold, color: rgb(0.13, 0.34, 0.74) });
  y = pageH - 80;

  const rightAligned = (text: string, size = 9) => {
    page.drawText(text, { x: right - bold.widthOfTextAtSize(text, size), y, size, font, color: rgb(0.3, 0.3, 0.3) });
  };
  rightAligned(`Run #${runId} · ${new Date().toLocaleString()}`, 9);
  y -= 16;
  // Summary line
  page.drawText(`Total rows in this report: ${rows.length}`, { x: left, y, size: 10, font, color: rgb(0.2, 0.2, 0.2) });
  y -= 22;

  // Render row cards
  for (const r of rows) {
    if (y < 110) page = addPage();
    // Card border
    page.drawRectangle({ x: left, y: y - 50, width: right - left, height: 56, borderColor: rgb(0.85, 0.85, 0.85), borderWidth: 0.5, color: rgb(0.98, 0.98, 0.98) });

    const status = String(r.status || "");
    const statusColor =
      status === "MATCHED" ? rgb(0.1, 0.6, 0.2) :
      status === "MISMATCHED" ? rgb(0.85, 0.2, 0.1) :
      status === "MISSING_IN_2B" ? rgb(0.95, 0.55, 0.1) :
      status === "MISSING_IN_2B" ? rgb(0.95, 0.55, 0.1) :
      rgb(0.6, 0.4, 0.1);

    page.drawText(`Invoice ${r.bookInvoiceNo || r.twoBInvoiceNo || ""}  ·  ${status}`, { x: left + 6, y: y - 12, size: 11, font: bold, color: rgb(0.1, 0.1, 0.1) });
    page.drawText(`${r.vendorName || ""}  ·  GSTIN ${r.bookGstin || r.twoBGstin || ""}`, { x: left + 6, y: y - 26, size: 9, font, color: rgb(0.3, 0.3, 0.3) });

    // Metrics
    const metrics = [];
    if (cols.includes("gstDiff")) metrics.push(`GST diff: ${fmtNum(r.gstDiff)}`);
    if (cols.includes("taxableDiff")) metrics.push(`Taxable diff: ${fmtNum(r.taxableDiff)}`);
    if (cols.includes("dateDiff") && r.dateDiff) metrics.push(`Date: ${r.dateDiff}`);
    if (cols.includes("invoiceNoDiff") && r.invoiceNoDiff) metrics.push(`Inv-No diff`);
    if (cols.includes("itcEligible")) metrics.push(`ITC eligible: ${fmtNum(r.itcEligible)}`);
    if (cols.includes("itcPending")) metrics.push(`ITC pending: ${fmtNum(r.itcPending)}`);
    if (cols.includes("confidence")) metrics.push(`Confidence ${r.confidence}%`);
    page.drawText(metrics.join("   |   "), { x: left + 6, y: y - 40, size: 9, font, color: statusColor });

    if ((cols.includes("aiWhat") || cols.includes("aiAction")) && (r.aiWhat || r.aiAction)) {
      const ai = String(r.aiWhat || "") + (r.aiAction ? ` -> ${r.aiAction}` : "");
      const wrapped = wrap(ai, 110);
      for (let i = 0; i < Math.min(wrapped.length, 2); i++) {
        page.drawText(wrapped[i], { x: left + 6, y: y - 52 - i * 10, size: 8, font, color: rgb(0.25, 0.25, 0.25) });
      }
      y -= 60 + Math.min(wrapped.length, 2) * 10;
    } else {
      y -= 56;
    }
  }

  // Footer page numbers
  const pages = doc.getPages();
  pages.forEach((p, i) => {
    p.drawText(`GST AI Reconciliation Agent — page ${i + 1}/${pages.length}`, { x: left, y: 24, size: 8, font, color: rgb(0.4, 0.4, 0.4) });
  });

  const bytes = await doc.save();
  const file = path.resolve(reportDir, `${slug(title)}-${Date.now()}.pdf`);
  fs.writeFileSync(file, bytes);
  return res.download(file, path.basename(file), () => fs.unlinkSync(file));
}

function sendCsv(res: Response, title: string, cols: ReadonlyArray<Col>, rows: any[]) {
  const csv = rowsToCsv(cols, rows);
  const file = path.resolve(reportDir, `${slug(title)}-${Date.now()}.csv`);
  fs.writeFileSync(file, csv, "utf8");
  res.type("text/csv; charset=utf-8");
  return res.download(file, path.basename(file), () => fs.unlinkSync(file));
}

export function rowsToCsv(cols: ReadonlyArray<Col>, rows: any[]) {
  const headerRow = cols.map((c) => csvField(titleFor(c))).join(",");
  const dataRows = rows.map((r) => cols.map((c) => csvField(r[c])).join(","));
  return [headerRow, ...dataRows].join("\r\n");
}

function csvField(v: any) {
  const s = String(v ?? "");
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function fmtNum(n: any) {
  const x = Number(n ?? 0);
  if (Number.isNaN(x)) return String(n);
  return x.toLocaleString("en-IN", { maximumFractionDigits: 2 });
}
function titleFor(c: Col) {
  const map: Partial<Record<Col, string>> = {
    bookInvoiceNo: "Books Invoice No", twoBInvoiceNo: "2B Invoice No",
    bookGstin: "Books GSTIN", twoBGstin: "2B GSTIN",
    bookDate: "Books Date", twoBDate: "2B Date", dateDiff: "Date Difference",
    invoiceNoDiff: "Invoice No Difference",
    bookTaxable: "Books Taxable", twoBTaxable: "2B Taxable", taxableDiff: "Taxable Diff",
    bookTax: "Books GST", twoBTax: "2B GST", gstDiff: "GST Diff",
    itcEligible: "ITC Eligible", itcPending: "ITC Pending", mismatchTypes: "Mismatch Types",
    aiWhat: "AI - What is wrong", aiReason: "AI - Reason", aiAction: "AI - Action",
    vendorName: "Vendor", status: "Status", confidence: "Confidence %",
  };
  return map[c] || c;
}
function wrap(text: string, width: number): string[] {
  const words = String(text || "").split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    if ((line + " " + w).trim().length > width) {
      if (line) lines.push(line);
      line = w;
    } else line = (line ? line + " " : "") + w;
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}
function slug(s: string) { return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, ""); }
