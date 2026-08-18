// GST file import service (Phase 2).
//
// Accepts Excel / CSV / JSON exports of GSTR-1 (sales) or GSTR-2B (purchase)
// data, normalizes every row, validates rows individually (a bad row can never
// abort the whole import), detects duplicates within the file AND against the
// database, and persists the valid unique rows into GstTransaction. Each
// import is recorded as a GstImportBatch; the uploaded file is never stored.
//
// Dedup strategy is deterministic and two-layered (same convention as the
// Tally import):
//   1. code-level existing-key check against a normalized
//      (returnType, period, gstin, counterpartyGstin, invoice, date) key
//   2. the unique index on GstTransaction as a backstop for concurrent imports
import * as XLSX from "xlsx";
import { Prisma } from "@prisma/client";
import { prisma } from "../utils/prisma";
import { num } from "../utils/db";
import {
  mapGstRow,
  normalizeInvoiceText,
  validateGstRow,
  type GstReturnType,
  type NormalizedGstRow,
} from "./gstNormalization.service";
import { parseGstr1Json, parseGstr2BJson } from "./parsers.service";
import { gstTransactionKey, isoOf } from "./gstNormalization.service";

export { gstTransactionKey };

export class GstFileError extends Error {}

export const PERIOD_RE = /^(\d{4})-(\d{2})$/;

export function isValidPeriod(period: string): boolean {
  const m = PERIOD_RE.exec(period);
  if (!m) return false;
  const month = Number(m[2]);
  return month >= 1 && month <= 12;
}

export interface ImportBatchSummary {
  batchId?: number;
  fileName: string;
  returnType: GstReturnType;
  period: string;
  totalRows: number;
  valid: number;
  invalid: number;
  duplicates: number;
  imported: number;
  errors: string[];
}

interface ParsedEntry {
  row: NormalizedGstRow;
  columnErrors: string[];
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function extOf(fileName: string): string {
  return fileName.toLowerCase().split(".").pop() ?? "";
}

function portalRowToNormalized(r: any): NormalizedGstRow {
  const taxable = Number(r.taxableValue) || 0;
  const cgst = Number(r.cgst) || 0;
  const sgst = Number(r.sgst) || 0;
  const igst = Number(r.igst) || 0;
  const cess = Number(r.cess) || 0;
  return {
    gstin: null,
    counterpartyGstin: String(r.gstin ?? "").toUpperCase() || null,
    counterpartyName: r.vendorName || null,
    invoiceNumber: normalizeInvoiceText(r.invoiceNo),
    invoiceDate: r.invoiceDate instanceof Date ? r.invoiceDate : null,
    taxableValue: taxable,
    cgst,
    sgst,
    igst,
    invoiceValue: taxable + cgst + sgst + igst + cess,
    placeOfSupply: null,
    hsn: null,
    documentType: r.noteType || null,
  };
}

// Parse an uploaded file into normalized entries. Never throws for content
// that is merely empty; malformed binary/JSON throws GstFileError.
export function parseGstFile(
  buffer: Buffer,
  fileName: string,
  returnType: GstReturnType,
): ParsedEntry[] {
  const ext = extOf(fileName);
  if (ext === "json") return parseGstJson(buffer, returnType);
  return parseSpreadsheet(buffer, fileName, returnType);
}

function parseGstJson(buffer: Buffer, returnType: GstReturnType): ParsedEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(buffer.toString("utf8"));
  } catch {
    throw new GstFileError("File is not valid JSON");
  }
  if (Array.isArray(parsed)) {
    // Simple array of flat records.
    return parsed.map((raw) => {
      if (raw === null || typeof raw !== "object") {
        return { row: blankRow(), columnErrors: ["Row is not an object"] };
      }
      const mapped = mapGstRow(raw as Record<string, unknown>, returnType);
      return { row: mapped.row, columnErrors: mapped.errors };
    });
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new GstFileError("JSON file has no usable rows");
  }
  // Portal JSON shapes handled by the existing parsers.
  try {
    const rows =
      returnType === "GSTR1"
        ? parseGstr1Json(buffer)
        : parseGstr2BJson(buffer);
    if (!rows.length) return [];
    return rows.map((r) => ({ row: portalRowToNormalized(r), columnErrors: [] }));
  } catch {
    throw new GstFileError("Could not read GSTR data from the JSON file");
  }
}

function parseSpreadsheet(buffer: Buffer, fileName: string, returnType: GstReturnType): ParsedEntry[] {
  let wb: XLSX.WorkBook;
  try {
    wb =
      extOf(fileName) === "csv"
        ? XLSX.read(buffer.toString("utf8"), { type: "string" })
        : XLSX.read(buffer, { cellDates: true });
  } catch {
    throw new GstFileError("File is not a valid Excel/CSV spreadsheet");
  }
  const rows: ParsedEntry[] = [];
  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    if (!ws) continue;
    const json: unknown[] = XLSX.utils.sheet_to_json(ws, { defval: null, raw: true });
    for (const raw of json) {
      if (raw === null || typeof raw !== "object") {
        rows.push({ row: blankRow(), columnErrors: ["Row is not an object"] });
        continue;
      }
      const mapped = mapGstRow(raw as Record<string, unknown>, returnType);
      rows.push({ row: mapped.row, columnErrors: mapped.errors });
    }
  }
  return rows;
}

function blankRow(): NormalizedGstRow {
  return {
    gstin: null,
    counterpartyGstin: null,
    counterpartyName: null,
    invoiceNumber: "",
    invoiceDate: null,
    taxableValue: 0,
    cgst: 0,
    sgst: 0,
    igst: 0,
    invoiceValue: 0,
    placeOfSupply: null,
    hsn: null,
    documentType: null,
  };
}

// ---------------------------------------------------------------------------
// Validation + dedupe (shared by /gst/validate and /gst/import)
// ---------------------------------------------------------------------------

export interface RowError {
  rowIndex: number;
  invoiceNumber: string;
  errors: string[];
}

export interface ValidatedBatch {
  totalRows: number;
  validRows: ParsedEntry[];
  invalidRows: RowError[];
  duplicates: number;
  errors: string[];
}

export function validateBatch(
  entries: ParsedEntry[],
  returnType: GstReturnType,
  period: string,
): ValidatedBatch {
  const validRows: ParsedEntry[] = [];
  const invalidRows: RowError[] = [];
  const seen = new Set<string>();
  let duplicates = 0;
  const errors: string[] = [];

  entries.forEach((entry, index) => {
    const rowErrors = [...entry.columnErrors, ...validateGstRow(entry.row, returnType)];
    if (rowErrors.length) {
      invalidRows.push({
        rowIndex: index + 1,
        invoiceNumber: entry.row.invoiceNumber || "—",
        errors: rowErrors,
      });
      return;
    }
    const key = gstTransactionKey(entry.row, returnType, period);
    if (seen.has(key)) {
      duplicates += 1;
      if (errors.length < 20) {
        errors.push(`Duplicate invoice "${entry.row.invoiceNumber}" within the file`);
      }
      return;
    }
    seen.add(key);
    validRows.push(entry);
  });

  return { totalRows: entries.length, validRows, invalidRows, duplicates, errors };
}

async function existingKeys(
  returnType: GstReturnType,
  period: string,
  rows: ParsedEntry[],
): Promise<Set<string>> {
  const set = new Set<string>();
  const invoiceNos = Array.from(new Set(rows.map((e) => e.row.invoiceNumber))).filter(Boolean);
  if (!invoiceNos.length) return set;
  // Chunked lookup so very large files do not produce one giant IN query.
  for (let i = 0; i < invoiceNos.length; i += 500) {
    const chunk = invoiceNos.slice(i, i + 500);
    const existing = await prisma.gstTransaction.findMany({
      where: { returnType, period, invoiceNumber: { in: chunk } },
      select: { returnType: true, period: true, gstin: true, counterpartyGstin: true, invoiceNumber: true, invoiceDate: true },
    });
    for (const r of existing) {
      set.add(
        gstTransactionKey(
          {
            gstin: r.gstin,
            counterpartyGstin: r.counterpartyGstin,
            invoiceNumber: r.invoiceNumber,
            invoiceDate: r.invoiceDate,
          } as NormalizedGstRow,
          returnType,
          period,
        ),
      );
    }
  }
  return set;
}

// Insert with the unique index as a backstop: rows colliding (concurrent
// import slipped between the key check and insert) count as duplicates.
async function saveRows(data: Prisma.GstTransactionCreateManyInput[]): Promise<number> {
  if (!data.length) return 0;
  try {
    return (await prisma.gstTransaction.createMany({ data })).count;
  } catch {
    let created = 0;
    for (const row of data) {
      try {
        await prisma.gstTransaction.create({ data: row });
        created += 1;
      } catch {
        // Unique constraint violation — duplicate, skip silently.
      }
    }
    return created;
  }
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

// Validates a file WITHOUT writing to the database — powers the Validate File
// button on the GST Import page. `dbCheck` includes records already imported
// in a previous batch (true for /gst/validate, false for tests that have no DB).
export async function validateGstFileService(
  buffer: Buffer,
  fileName: string,
  returnType: GstReturnType,
  period: string,
  dbCheck = true,
): Promise<ImportBatchSummary> {
  const entries = parseGstFile(buffer, fileName, returnType);
  const validated = validateBatch(entries, returnType, period);
  let duplicates = validated.duplicates;
  let imported = 0;

  if (validated.validRows.length && dbCheck) {
    const existing = await existingKeys(returnType, period, validated.validRows);
    const fresh = validated.validRows.filter((e) => !existing.has(gstTransactionKey(e.row, returnType, period)));
    duplicates += validated.validRows.length - fresh.length;
  }

  return {
    fileName,
    returnType,
    period,
    totalRows: validated.totalRows,
    valid: entries.length - validated.invalidRows.length,
    invalid: validated.invalidRows.length,
    duplicates,
    imported,
    errors: validated.errors,
  };
}

// Parses, validates, dedupes and persists a file. Creates the import batch and
// returns the summary + batch id.
export async function importGstFileService(
  buffer: Buffer,
  fileName: string,
  returnType: GstReturnType,
  period: string,
): Promise<ImportBatchSummary> {
  const entries = parseGstFile(buffer, fileName, returnType);
  const validated = validateBatch(entries, returnType, period);
  const errors = [...validated.errors];

  let imported = 0;
  let batchId: number | undefined;

  if (validated.validRows.length) {
    const existing = await existingKeys(returnType, period, validated.validRows);
    const fresh = validated.validRows.filter(
      (e) => !existing.has(gstTransactionKey(e.row, returnType, period)),
    );
    const dbDuplicates = validated.validRows.length - fresh.length;
    if (dbDuplicates) {
      validated.duplicates += dbDuplicates;
      if (errors.length < 20) errors.push(`${dbDuplicates} record(s) already present in the database`);
    }

    if (fresh.length) {
      const data = fresh.map((e) => ({
        source: "GST",
        returnType,
        gstin: e.row.gstin,
        counterpartyGstin: e.row.counterpartyGstin,
        counterpartyName: e.row.counterpartyName,
        invoiceNumber: e.row.invoiceNumber,
        invoiceDate: e.row.invoiceDate as Date,
        taxableValue: round2(e.row.taxableValue),
        cgst: round2(e.row.cgst),
        sgst: round2(e.row.sgst),
        igst: round2(e.row.igst),
        invoiceValue: round2(e.row.invoiceValue),
        placeOfSupply: e.row.placeOfSupply,
        hsn: e.row.hsn,
        documentType: e.row.documentType,
        period,
        importBatchId: undefined, // assigned after the batch row is created
      }));
      // The batch row must exist before transactions can reference it.
      const batch = await prisma.gstImportBatch.create({
        data: {
          source: "GST",
          returnType,
          fileName,
          period,
          totalRows: validated.totalRows,
          validRows: validated.totalRows - validated.invalidRows.length,
          invalidRows: validated.invalidRows.length,
          duplicateRows: validated.duplicates,
          importedRows: 0,
        },
      });
      batchId = batch.id;
      imported = await saveRows(data.map((d) => ({ ...d, importBatchId: batchId })));
      const failedInserts = data.length - imported;
      if (failedInserts) validated.duplicates += failedInserts;
      await prisma.gstImportBatch.update({
        where: { id: batch.id },
        data: { importedRows: imported, duplicateRows: validated.duplicates },
      });
    }
  }

  if (!batchId) {
    // Nothing imported — still record the attempt so history is complete.
    const batch = await prisma.gstImportBatch.create({
      data: {
        source: "GST",
        returnType,
        fileName,
        period,
        totalRows: validated.totalRows,
        validRows: validated.totalRows - validated.invalidRows.length,
        invalidRows: validated.invalidRows.length,
        duplicateRows: validated.duplicates,
        importedRows: 0,
      },
    });
    batchId = batch.id;
  }

  return {
    batchId,
    fileName,
    returnType,
    period,
    totalRows: validated.totalRows,
    valid: validated.totalRows - validated.invalidRows.length,
    invalid: validated.invalidRows.length,
    duplicates: validated.duplicates,
    imported,
    errors,
  };
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// ---------------------------------------------------------------------------
// History / listing
// ---------------------------------------------------------------------------

export async function listBatches(returnType?: string) {
  const where =
    returnType === "GSTR1" || returnType === "GSTR2B" ? { returnType } : {};
  const batches = await prisma.gstImportBatch.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  return batches.map((b) => ({
    id: b.id,
    returnType: b.returnType,
    fileName: b.fileName,
    period: b.period,
    totalRows: b.totalRows,
    validRows: b.validRows,
    invalidRows: b.invalidRows,
    duplicateRows: b.duplicateRows,
    importedRows: b.importedRows,
    createdAt: b.createdAt.toISOString(),
  }));
}

export async function getBatch(id: number) {
  const batch = await prisma.gstImportBatch.findUnique({ where: { id } });
  if (!batch) return null;
  const transactions = await prisma.gstTransaction.findMany({
    where: { importBatchId: id },
    orderBy: { id: "asc" },
  });
  return {
    id: batch.id,
    returnType: batch.returnType,
    fileName: batch.fileName,
    period: batch.period,
    totalRows: batch.totalRows,
    validRows: batch.validRows,
    invalidRows: batch.invalidRows,
    duplicateRows: batch.duplicateRows,
    importedRows: batch.importedRows,
    createdAt: batch.createdAt.toISOString(),
    transactions: transactions.map(serializeTransaction),
  };
}

export interface GstTransactionView {
  id: number;
  returnType: string;
  gstin: string | null;
  counterpartyGstin: string | null;
  counterpartyName: string | null;
  invoiceNumber: string;
  invoiceDate: string;
  taxableValue: number;
  cgst: number;
  sgst: number;
  igst: number;
  invoiceValue: number;
  placeOfSupply: string | null;
  hsn: string | null;
  documentType: string | null;
  period: string;
}

export function serializeTransaction(r: any): GstTransactionView {
  return {
    id: r.id,
    returnType: r.returnType,
    gstin: r.gstin,
    counterpartyGstin: r.counterpartyGstin,
    counterpartyName: r.counterpartyName,
    invoiceNumber: r.invoiceNumber,
    invoiceDate: r.invoiceDate ? isoOf(new Date(r.invoiceDate)) : "",
    taxableValue: num(r.taxableValue),
    cgst: num(r.cgst),
    sgst: num(r.sgst),
    igst: num(r.igst),
    invoiceValue: num(r.invoiceValue),
    placeOfSupply: r.placeOfSupply,
    hsn: r.hsn,
    documentType: r.documentType,
    period: r.period,
  };
}

export async function listTransactions(params: {
  returnType?: string;
  period?: string;
  page?: number;
  pageSize?: number;
}) {
  const where: Prisma.GstTransactionWhereInput = {};
  if (params.returnType === "GSTR1" || params.returnType === "GSTR2B") {
    where.returnType = params.returnType;
  }
  if (params.period && isValidPeriod(params.period)) where.period = params.period;
  const page = Math.max(1, params.page ?? 1);
  const pageSize = Math.min(Math.max(params.pageSize ?? 50, 1), 500);
  const [rows, total] = await Promise.all([
    prisma.gstTransaction.findMany({
      where,
      orderBy: { invoiceDate: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.gstTransaction.count({ where }),
  ]);
  return { rows: rows.map(serializeTransaction), total, page, pageSize };
}