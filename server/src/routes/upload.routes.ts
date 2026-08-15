import { Router } from "express";
import fs from "node:fs";
import { prisma } from "../utils/prisma";
import { uploader, extOf } from "../middleware/upload.middleware";
import { authenticate, authorize, AuthedRequest } from "../middleware/auth.middleware";
import { rateLimit } from "../middleware/rate-limit.middleware";
import { parseExcel, parseGstr2BJson, parse2BExcel, parseGstr1Json } from "../services/parsers.service";
import { normalizeGstin } from "../utils/gstin";

export const uploadRouter = Router();

const uploadLimiter = rateLimit({ windowMs: 60_000, max: 30, message: "Too many uploads. Try again shortly." });

// Which file extensions are accepted per data source. GSTR2B / GSTR1 come as
// JSON from the portal or as spreadsheets; the register extracts are xlsx/xls.
const SOURCE_EXTENSIONS: Record<string, string[]> = {
  PURCHASE: [".xlsx", ".xls", ".csv"],
  SALES: [".xlsx", ".xls", ".csv"],
  GSTR3B: [".xlsx", ".xls", ".csv"],
  PORTAL: [".xlsx", ".xls", ".csv"],
  GSTR2B: [".json", ".xlsx", ".xls"],
  GSTR1: [".json", ".xlsx", ".xls"],
};

async function saveInvoices(rows: any[], source: string, uploadId: number) {
  const data = rows.map(r => ({
    source,
    gstin: normalizeGstin(r.gstin),
    vendorName: r.vendorName || null,
    invoiceNo: r.invoiceNo,
    invoiceDate: r.invoiceDate,
    taxableValue: Number(r.taxableValue) || 0,
    cgst: Number(r.cgst) || 0,
    sgst: Number(r.sgst) || 0,
    igst: Number(r.igst) || 0,
    cess: Number(r.cess) || 0,
    noteType: r.noteType || "INVOICE",
    totalGst: (Number(r.cgst) || 0) + (Number(r.sgst) || 0) + (Number(r.igst) || 0) + (Number(r.cess) || 0),
    invoiceValue: (Number(r.taxableValue) || 0) + (Number(r.cgst) || 0) + (Number(r.sgst) || 0) + (Number(r.igst) || 0) + (Number(r.cess) || 0),
    uploadId,
  }));
  if (!data.length) return 0;
  // Clear previous invoices of same source before inserting fresh batch
  await prisma.invoice.deleteMany({ where: { source } });
  await prisma.invoice.createMany({ data });
  return data.length;
}

async function handleUpload(req: AuthedRequest, res: any, source: string) {
  if (!req.file) return res.status(400).json({ error: "BadRequest", message: "file is required" });

  const allowedExts = SOURCE_EXTENSIONS[source];
  const ext = extOf(req.file);
  if (allowedExts && !allowedExts.includes(ext)) {
    fs.unlinkSync(req.file.path);
    return res.status(400).json({
      error: "BadRequest",
      message: `Source "${source}" does not accept .${ext.replace(".", "")} files. Allowed: ${allowedExts.join(", ")}`,
    });
  }

  const upload = await prisma.upload.create({ data: { fileName: req.file.originalname, source, rows: 0, filePath: req.file.path } });
  try {
    const buf = fs.readFileSync(req.file.path);
    let rows: any[] = [];
    switch (source) {
      case "PURCHASE":
      case "SALES":
      case "GSTR3B":
      case "PORTAL":
        rows = parseExcel(buf);
        break;
      case "GSTR2B":
        rows = ext === ".json" ? parseGstr2BJson(buf) : parse2BExcel(buf);
        break;
      case "GSTR1":
        rows = ext === ".json" ? parseGstr1Json(buf) : parseExcel(buf);
        break;
    }
    if (!rows.length) return res.status(400).json({ error: "ParseError", message: "No usable rows extracted" });
    const cnt = await saveInvoices(rows, source, upload.id);
    await prisma.upload.update({ where: { id: upload.id }, data: { rows: cnt } });
    return res.json({ ok: true, count: cnt, source, fileId: upload.id, fileName: req.file.originalname });
  } catch (e: any) {
    // A file the client supplied that cannot be parsed is a client error, not a
    // server fault, so it must surface as 400 rather than 500.
    return res.status(400).json({ error: "ParseError", message: e.message ?? "Failed to parse file" });
  }
}

uploadRouter.post("/upload/purchase", uploadLimiter, authenticate, authorize("ADMIN", "ACCOUNTANT"), uploader.single("file"), (req, res) => handleUpload(req as any, res, "PURCHASE"));
uploadRouter.post("/upload/sales",    uploadLimiter, authenticate, authorize("ADMIN", "ACCOUNTANT"), uploader.single("file"), (req, res) => handleUpload(req as any, res, "SALES"));
uploadRouter.post("/upload/gstr2b",   uploadLimiter, authenticate, authorize("ADMIN", "ACCOUNTANT"), uploader.single("file"), (req, res) => handleUpload(req as any, res, "GSTR2B"));
uploadRouter.post("/upload/gstr1",    uploadLimiter, authenticate, authorize("ADMIN", "ACCOUNTANT"), uploader.single("file"), (req, res) => handleUpload(req as any, res, "GSTR1"));
uploadRouter.post("/upload/gstr3b",   uploadLimiter, authenticate, authorize("ADMIN", "ACCOUNTANT"), uploader.single("file"), (req, res) => handleUpload(req as any, res, "GSTR3B"));
uploadRouter.post("/upload/gstportal",uploadLimiter, authenticate, authorize("ADMIN", "ACCOUNTANT"), uploader.single("file"), (req, res) => handleUpload(req as any, res, "PORTAL"));
