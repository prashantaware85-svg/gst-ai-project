import { Router } from "express";
import type { Request, Response } from "express";
import fs from "node:fs";
import { uploader } from "../middleware/upload.middleware";
import { authenticate, authorize, AuthedRequest } from "../middleware/auth.middleware";
import { rateLimit } from "../middleware/rate-limit.middleware";
import {
  GstFileError,
  isValidPeriod,
  validateGstFileService,
  importGstFileService,
  listBatches,
  getBatch,
  listTransactions,
  type ImportBatchSummary,
} from "../services/gstImport.service";
import type { GstReturnType } from "../services/gstNormalization.service";

export const gstRouter = Router();

const gstLimiter = rateLimit({ windowMs: 60_000, max: 30, message: "Too many GST file operations. Try again shortly." });

function returnTypeOf(v: unknown): GstReturnType | null {
  const s = String(v ?? "").toUpperCase();
  return s === "GSTR1" || s === "GSTR2B" ? s : null;
}

// period (YYYY-MM) is required unless fromDate (YYYY-MM-DD) is provided, in
// which case its month is used.
function resolvePeriod(body: Record<string, any>): { period: string } | { error: string } {
  const period = String(body.period ?? "");
  if (period) {
    if (!isValidPeriod(period)) {
      return { error: "period must be a valid month in YYYY-MM format" };
    }
    return { period };
  }
  const fromDate = String(body.fromDate ?? "");
  if (/^\d{4}-\d{2}-\d{2}$/.test(fromDate)) {
    const p = fromDate.slice(0, 7);
    if (isValidPeriod(p)) return { period: p };
  }
  return { error: "period (YYYY-MM) or fromDate (YYYY-MM-DD) is required" };
}

// Shared handler for validate/import: parse the file, run the service, clean
// the temporary upload. Client-supplied files that cannot be parsed are a 400.
async function handleGstFile(
  req: AuthedRequest,
  res: Response,
  mode: "validate" | "import",
): Promise<Response> {
  if (!req.file) return res.status(400).json({ error: "BadRequest", message: "file is required" });
  const returnType = returnTypeOf(req.body.returnType);
  if (!returnType) {
    fs.unlinkSync(req.file.path);
    return res.status(400).json({ error: "BadRequest", message: "returnType must be GSTR1 or GSTR2B" });
  }
  const parsedPeriod = resolvePeriod(req.body);
  if ("error" in parsedPeriod) {
    fs.unlinkSync(req.file.path);
    return res.status(400).json({ error: "BadRequest", message: parsedPeriod.error });
  }
  try {
    const buf = fs.readFileSync(req.file.path);
    const summary: ImportBatchSummary =
      mode === "validate"
        ? await validateGstFileService(buf, req.file.originalname, returnType, parsedPeriod.period)
        : await importGstFileService(buf, req.file.originalname, returnType, parsedPeriod.period);
    return res.json({ success: true, ...summary });
  } catch (e: any) {
    const message = e instanceof GstFileError ? e.message : "Failed to process GST file";
    return res.status(400).json({ error: "ParseError", message });
  } finally {
    try { fs.unlinkSync(req.file.path); } catch { /* best-effort cleanup */ }
  }
}

// POST /api/gst/validate — validate a file without persisting anything.
gstRouter.post("/gst/validate", gstLimiter, authenticate, authorize("ADMIN", "ACCOUNTANT"), uploader.single("file"), (req: AuthedRequest, res: Response) => {
  void handleGstFile(req, res, "validate");
});

// POST /api/gst/import — validate + dedupe + persist, record an import batch.
gstRouter.post("/gst/import", gstLimiter, authenticate, authorize("ADMIN", "ACCOUNTANT"), uploader.single("file"), (req: AuthedRequest, res: Response) => {
  void handleGstFile(req, res, "import");
});

// GET /api/gst/imports — recent import batches (history).
gstRouter.get("/gst/imports", authenticate, async (req: Request, res: Response) => {
  try {
    const returnType = typeof req.query.returnType === "string" ? req.query.returnType : undefined;
    const batches = await listBatches(returnType);
    return res.json({ ok: true, count: batches.length, batches });
  } catch {
    return res.status(500).json({ ok: false, message: "Database error while loading import history" });
  }
});

// GET /api/gst/imports/:id — one batch with its imported transactions.
gstRouter.get("/gst/imports/:id", authenticate, async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: "BadRequest", message: "Invalid batch id" });
  }
  try {
    const batch = await getBatch(id);
    if (!batch) return res.status(404).json({ error: "NotFound", message: "Import batch not found" });
    return res.json({ ok: true, batch });
  } catch {
    return res.status(500).json({ ok: false, message: "Database error while loading import batch" });
  }
});

// GET /api/gst/transactions — stored, normalized GST rows.
gstRouter.get("/gst/transactions", authenticate, async (req: Request, res: Response) => {
  try {
    const data = await listTransactions({
      returnType: typeof req.query.returnType === "string" ? req.query.returnType : undefined,
      period: typeof req.query.period === "string" ? req.query.period : undefined,
      page: req.query.page ? Number(req.query.page) : undefined,
      pageSize: req.query.pageSize ? Number(req.query.pageSize) : undefined,
    });
    return res.json({ ok: true, ...data });
  } catch {
    return res.status(500).json({ ok: false, message: "Database error while loading transactions" });
  }
});