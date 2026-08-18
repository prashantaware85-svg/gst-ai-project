import { Router } from "express";
import type { Request, Response } from "express";
import * as XLSX from "xlsx";
import fs from "node:fs";
import path from "node:path";
import { authenticate, authorize, AuthedRequest } from "../middleware/auth.middleware";
import { rateLimit } from "../middleware/rate-limit.middleware";
import {
  runGstReconciliation,
  getRunSummary,
  listResults,
  getResultById,
  reviewResult,
  isValidPeriod,
  type TransactionType,
  type JoinedResult,
} from "../services/gstReconciliation.service";

export const reconciliationRouter = Router();

const runLimiter = rateLimit({ windowMs: 60_000, max: 10, message: "Too many reconciliation runs. Try again shortly." });

const reportDir = process.env.REPORT_DIR || "./reports";
fs.mkdirSync(path.resolve(reportDir), { recursive: true });

const MAX_EXPORT_ROWS = 50_000;

function transactionTypeOf(v: unknown): TransactionType | null {
  const s = String(v ?? "").toUpperCase();
  return s === "SALES" || s === "PURCHASE" ? s : null;
}

function periodAndType(query: Request["query"]): { period: string; type: TransactionType } | { error: string } {
  const period = typeof query.period === "string" ? query.period : "";
  const type = transactionTypeOf(query.transactionType);
  if (!isValidPeriod(period)) return { error: "period must be a valid month in YYYY-MM format" };
  if (!type) return { error: "transactionType must be SALES or PURCHASE" };
  return { period, type };
}

// POST /api/reconciliation/run { period: "2026-04", transactionType: "SALES" }
reconciliationRouter.post("/reconciliation/run", runLimiter, authenticate, authorize("ADMIN", "ACCOUNTANT"), async (req: Request, res: Response) => {
  const parsed = periodAndType(req.body ?? {});
  if ("error" in parsed) return res.status(400).json({ error: "BadRequest", message: parsed.error });
  try {
    const summary = await runGstReconciliation(parsed.period, parsed.type);
    return res.json(summary);
  } catch (e: any) {
    return res.status(500).json({ error: "ReconcileError", message: e.message });
  }
});

// GET /api/reconciliation/summary?period=2026-04&transactionType=SALES
reconciliationRouter.get("/reconciliation/summary", authenticate, async (req: Request, res: Response) => {
  const parsed = periodAndType(req.query);
  if ("error" in parsed) return res.status(400).json({ error: "BadRequest", message: parsed.error });
  try {
    return res.json(await getRunSummary(parsed.period, parsed.type));
  } catch (e: any) {
    return res.status(500).json({ error: "ReconcileError", message: e.message });
  }
});

// GET /api/reconciliation/results?period&transactionType&status&page&pageSize
reconciliationRouter.get("/reconciliation/results", authenticate, async (req: Request, res: Response) => {
  const parsed = periodAndType(req.query);
  if ("error" in parsed) return res.status(400).json({ error: "BadRequest", message: parsed.error });
  try {
    const data = await listResults({
      period: parsed.period,
      transactionType: parsed.type,
      status: typeof req.query.status === "string" && req.query.status ? req.query.status : undefined,
      page: req.query.page ? Number(req.query.page) : undefined,
      pageSize: req.query.pageSize ? Number(req.query.pageSize) : undefined,
    });
    return res.json({ ok: true, ...data });
  } catch (e: any) {
    return res.status(500).json({ ok: false, message: e.message });
  }
});

// GET /api/reconciliation/results/:id — side-by-side detail.
reconciliationRouter.get("/reconciliation/results/:id", authenticate, async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: "BadRequest", message: "Invalid result id" });
  }
  try {
    const row = await getResultById(id);
    if (!row) return res.status(404).json({ error: "NotFound", message: "Reconciliation result not found" });
    return res.json({ ok: true, result: row });
  } catch (e: any) {
    return res.status(500).json({ ok: false, message: e.message });
  }
});

// PATCH /api/reconciliation/results/:id { reviewStatus, reviewNote }
reconciliationRouter.patch("/reconciliation/results/:id", authenticate, authorize("ADMIN", "ACCOUNTANT"), async (req: AuthedRequest, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: "BadRequest", message: "Invalid result id" });
  }
  if (!req.body || typeof req.body.reviewStatus !== "string") {
    return res.status(400).json({ error: "BadRequest", message: "reviewStatus is required" });
  }
  try {
    const reviewer = req.user ? `${req.user.name} <${req.user.email}>` : "unknown";
    const row = await reviewResult(id, req.body, reviewer);
    if (!row) return res.status(404).json({ error: "NotFound", message: "Reconciliation result not found" });
    return res.json({ ok: true, result: row });
  } catch (e: any) {
    return res.status(400).json({ error: "BadRequest", message: e.message });
  }
});

// GET /api/reconciliation/export?period&transactionType&format=xlsx|csv
reconciliationRouter.get("/reconciliation/export", authenticate, async (req: Request, res: Response) => {
  const parsed = periodAndType(req.query);
  if ("error" in parsed) return res.status(400).json({ error: "BadRequest", message: parsed.error });
  const format = String(req.query.format || "xlsx");
  if (format !== "xlsx" && format !== "csv") {
    return res.status(400).json({ error: "BadRequest", message: "format must be xlsx or csv" });
  }
  try {
    const data = await listResults({
      period: parsed.period,
      transactionType: parsed.type,
      pageSize: MAX_EXPORT_ROWS,
    });
    const rows = data.rows;
    const headers = [
      "Status", "Invoice Number", "Date", "GSTIN",
      "Tally Taxable", "GST Taxable", "Taxable Difference",
      "Tally CGST", "GST CGST", "CGST Difference",
      "Tally SGST", "GST SGST", "SGST Difference",
      "Tally IGST", "GST IGST", "IGST Difference",
      "Confidence", "Reason",
    ];
    const fileBase = `reconciliation-${parsed.period}-${parsed.type.toLowerCase()}-${Date.now()}`;
    if (format === "xlsx") {
      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.aoa_to_sheet([headers, ...rows.map(rowToExportArray)]);
      ws["!cols"] = headers.map((_, i) => ({ wch: i === headers.length - 1 ? 60 : 18 }));
      XLSX.utils.book_append_sheet(wb, ws, "Reconciliation");
      const file = path.resolve(reportDir, `${fileBase}.xlsx`);
      XLSX.writeFile(wb, file);
      return res.download(file, path.basename(file), () => fs.unlinkSync(file));
    }
    // CSV
    const csvRows = [headers, ...rows.map(rowToExportArray)].map((r) =>
      r.map((c) => {
        const s = String(c ?? "");
        return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      }).join(","),
    );
    const file = path.resolve(reportDir, `${fileBase}.csv`);
    fs.writeFileSync(file, csvRows.join("\r\n"), "utf8");
    res.type("text/csv; charset=utf-8");
    return res.download(file, path.basename(file), () => fs.unlinkSync(file));
  } catch (e: any) {
    return res.status(500).json({ ok: false, message: e.message });
  }
});

function rowToExportArray(r: JoinedResult): (string | number | null)[] {
  const invNo = r.tally?.invoiceNumber || r.gst?.invoiceNumber || "";
  const date = r.tally?.voucherDate || r.gst?.invoiceDate || "";
  const gstin = r.tally?.partyGSTIN || r.gst?.counterpartyGstin || "";
  const t = r.tally;
  const g = r.gst;
  return [
    r.status,
    invNo,
    date,
    gstin,
    t?.taxableValue ?? null, g?.taxableValue ?? null, r.taxableDifference,
    t?.cgst ?? null, g?.cgst ?? null, r.cgstDifference,
    t?.sgst ?? null, g?.sgst ?? null, r.sgstDifference,
    t?.igst ?? null, g?.igst ?? null, r.igstDifference,
    r.confidence,
    r.reason ?? "",
  ];
}