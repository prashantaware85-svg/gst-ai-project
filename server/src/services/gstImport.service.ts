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
  resolveHeaderField,
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
  // Portal multi-rate rows collapsed into single transactions.
  aggregated?: number;
}

interface ParsedEntry {
  row: NormalizedGstRow;
  columnErrors: string[];
}

interface ParsedFile {
  entries: ParsedEntry[];
  // Spreadsheet rows collapsed into a single transaction by multi-rate
  // aggregation (one portal row per invoice per tax rate).
  aggregated: number;
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
    cess: Number(r.cess) || 0,
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
  return parseGstFileDetailed(buffer, fileName, returnType).entries;
}

// parseGstFile plus the number of spreadsheet rows collapsed by multi-rate
// aggregation (so summaries can report raw-vs-aggregated counts).
export function parseGstFileDetailed(
  buffer: Buffer,
  fileName: string,
  returnType: GstReturnType,
): ParsedFile {
  const ext = extOf(fileName);
  if (ext === "json") return { entries: parseGstJson(buffer, returnType), aggregated: 0 };
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

// The GST portal offline-utility workbook ships one full-report sheet plus one
// breakdown sheet per table. Only invoice-level B2B tables belong in the sales
// register; the summary/aggregate tables (HSN, B2CS, docs, advances, ...) carry
// no invoice lines and must not be imported.
const REPORT_SHEET = "gstr1 report";
const B2B_SHEET = "b2b,sez,de";
const SKIP_SHEETS = new Set([
  "b2cl", "b2cs", "cdnr", "cdnur", "exp", "at", "atadj", "exemp",
  "hsn(b2b)", "hsn(b2c)", "docs",
  "itemwisesale", "itemwisesalereturn", "itemsummary",
]);
// Header rows never sit deeper than this many rows from the top of a sheet.
const MAX_HEADER_SCAN = 12;

function sheetKey(name: string): string {
  return String(name ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

// Actual sheet name in the workbook whose normalized key matches, or null.
function findSheetName(wb: XLSX.WorkBook, targetKey: string): string | null {
  for (const name of wb.SheetNames) {
    if (sheetKey(name) === targetKey) return name;
  }
  return null;
}

function sheetAoa(ws: XLSX.WorkSheet): unknown[][] {
  return XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: "" }) as unknown[][];
}

// Index of the last row in the scan window that looks like a header (>=2 cells
// resolve to known GST columns), or -1. Taking the last match lets a two-row
// merged header (portal's GSTR1 Report) resolve to its detail row.
function findHeaderRowIndex(aoa: unknown[][]): number {
  const limit = Math.min(aoa.length, MAX_HEADER_SCAN);
  let found = -1;
  for (let i = 0; i < limit; i++) {
    const row = aoa[i] || [];
    let matches = 0;
    for (const cell of row) {
      if (resolveHeaderField(cell) !== null) matches += 1;
    }
    if (matches >= 2) found = i;
  }
  return found;
}

interface ResolvedColumn {
  field: string | null;
  text: string | null;
}

// Effective field per column, merging two-row headers: a sub-header cell wins
// when it resolves alone, otherwise the parent cell is tried and parent+child
// combined (portal's "Invoice | No. / Date / Value" merge).
function resolveHeaderColumns(parentRow: unknown[], childRow: unknown[]): ResolvedColumn[] {
  const count = Math.max(parentRow.length, childRow.length);
  const out: ResolvedColumn[] = [];
  for (let c = 0; c < count; c++) {
    const p = String(parentRow[c] ?? "").trim();
    const ch = String(childRow[c] ?? "").trim();
    const candidates = ch ? [ch, p && ch ? `${p} ${ch}` : null, p || null] : p ? [p] : [];
    let resolved: ResolvedColumn = { field: null, text: null };
    for (const cand of candidates) {
      const field = cand ? resolveHeaderField(cand) : null;
      if (field !== null) {
        resolved = { field, text: cand };
        break;
      }
    }
    out.push(resolved);
  }
  return out;
}

// Emit mapped rows for one sheet in place. Only rows that could be a
// transaction are pushed: rows with none of GSTIN / invoice number / invoice
// date (empty footers, "Totals" lines, stray cells) are skipped — never
// imported as phantom zero records. With `requireGstin`, rows without a
// counterparty GSTIN are also dropped (the GSTR1 Report mixes B2B invoices and
// B2CS/consumer lines; only the registered-recipient rows are the sales
// register).
function emitSheet(
  wb: XLSX.WorkBook,
  sheetName: string,
  returnType: GstReturnType,
  out: ParsedEntry[],
  options?: { requireGstin?: boolean },
): void {
  const ws = wb.Sheets[sheetName];
  if (!ws) return;
  const aoa = sheetAoa(ws);
  const headerIdx = findHeaderRowIndex(aoa);
  if (headerIdx < 0) return;
  const columns = resolveHeaderColumns(aoa[headerIdx - 1] || [], aoa[headerIdx] || []);
  // A transaction sheet must expose an invoice-number or invoice-date column;
  // aggregate tables (HSN, B2CS, documents issued, ...) have neither.
  const hasInvoiceCol = columns.some(
    (col) => col.field === "invoiceNumber" || col.field === "invoiceDate",
  );
  if (!hasInvoiceCol) return;

  for (let r = headerIdx + 1; r < aoa.length; r++) {
    const cells = aoa[r] || [];
    const raw: Record<string, unknown> = {};
    for (let c = 0; c < columns.length; c++) {
      const col = columns[c];
      if (!col.field || !col.text) continue;
      if (!(col.text in raw)) raw[col.text] = cells[c];
    }
    if (!Object.keys(raw).length) continue;
    // A trailing "Totals" line reuses the sheet's GSTIN column as a label; it
    // is a summary row, not a transaction.
    let totalLike = false;
    for (const col of columns) {
      if (col.field === "counterpartyGstin" && col.text) {
        const label = String(raw[col.text] ?? "").trim().toUpperCase();
        if (/^(GRAND\s+)?TOTAL/i.test(label)) {
          totalLike = true;
          break;
        }
      }
    }
    if (totalLike) continue;
    const mapped = mapGstRow(raw, returnType);
    const row = mapped.row;
    if (!row.counterpartyGstin && !row.invoiceNumber && !row.invoiceDate) continue;
    if (options?.requireGstin && !row.counterpartyGstin) continue;
    out.push({ row, columnErrors: mapped.errors });
  }
}

// Collapse the multi-rate rows the portal emits for one invoice (a row per tax
// rate) into a single transaction per (gstin, invoice number, date). Rows that
// are exact duplicates (same identity AND same amounts) are NOT merged — they
// stay separate so validateBatch flags them as duplicates.
function aggregateEntries(
  entries: ParsedEntry[],
  returnType: GstReturnType,
): { entries: ParsedEntry[]; aggregated: number } {
  const out: ParsedEntry[] = [];
  const seen = new Map<string, number>();
  let aggregated = 0;
  for (const entry of entries) {
    const key = aggregateKey(entry.row, returnType);
    const existing = seen.get(key);
    if (existing === undefined) {
      seen.set(key, out.length);
      out.push(entry);
    } else {
      const prev = out[existing].row;
      if (isExactDuplicate(prev, entry.row)) {
        // Genuine duplicate row — leave it in place for dedupe to catch.
        out.push(entry);
      } else {
        out[existing] = {
          row: mergeRows(prev, entry.row),
          columnErrors: out[existing].columnErrors,
        };
        aggregated += 1;
      }
    }
  }
  return { entries: out, aggregated };
}

function isExactDuplicate(a: NormalizedGstRow, b: NormalizedGstRow): boolean {
  return (
    a.taxableValue === b.taxableValue &&
    a.cgst === b.cgst &&
    a.sgst === b.sgst &&
    a.igst === b.igst &&
    a.cess === b.cess
  );
}

// Same identity dimensions as gstTransactionKey without the period (constant
// for a single file) — used to merge the portal's per-rate rows before dedupe.
function aggregateKey(row: NormalizedGstRow, returnType: GstReturnType): string {
  const own = (row.gstin || "").toUpperCase();
  const cust = (row.counterpartyGstin || "").toUpperCase();
  return [returnType, own, cust, row.invoiceNumber, row.invoiceDate ? isoOf(row.invoiceDate) : ""].join("|");
}

// Sum the money components of two rows sharing the same transaction identity.
// The portal repeats the full invoice value on every rate row, so the merged
// invoice value is recomputed from the summed components instead of summed.
function mergeRows(a: NormalizedGstRow, b: NormalizedGstRow): NormalizedGstRow {
  const taxableValue = round2(a.taxableValue + b.taxableValue);
  const cgst = round2(a.cgst + b.cgst);
  const sgst = round2(a.sgst + b.sgst);
  const igst = round2(a.igst + b.igst);
  const cess = round2(a.cess + b.cess);
  return {
    gstin: a.gstin,
    counterpartyGstin: a.counterpartyGstin,
    counterpartyName: a.counterpartyName ?? b.counterpartyName,
    invoiceNumber: a.invoiceNumber,
    invoiceDate: a.invoiceDate,
    taxableValue,
    cgst,
    sgst,
    igst,
    cess,
    invoiceValue: round2(taxableValue + cgst + sgst + igst + cess),
    placeOfSupply: a.placeOfSupply ?? b.placeOfSupply,
    hsn: a.hsn ?? b.hsn,
    documentType: a.documentType ?? b.documentType,
  };
}

function parseSpreadsheet(
  buffer: Buffer,
  fileName: string,
  returnType: GstReturnType,
): ParsedFile {
  let wb: XLSX.WorkBook;
  try {
    wb =
      extOf(fileName) === "csv"
        ? XLSX.read(buffer.toString("utf8"), { type: "string" })
        : XLSX.read(buffer, { cellDates: true });
  } catch {
    throw new GstFileError("File is not a valid Excel/CSV spreadsheet");
  }

  // The GSTR1 Report is the authoritative B2B source: it carries actual
  // CGST/SGST/IGST and complete taxable values (the b2b breakdown sheet omits
  // nil-rated lines). Its rows mix B2B and B2CS/consumer lines, so only rows
  // with a recipient GSTIN are imported. When the Report is absent or unusable
  // the b2b,sez,de breakdown sheet is used as a fallback. Both are never parsed
  // for the same file — the same invoice appears in each and would double count.
  const reportName = findSheetName(wb, REPORT_SHEET);
  const b2bName = findSheetName(wb, B2B_SHEET);

  const entries: ParsedEntry[] = [];
  let reportEmitted = false;
  for (const sheetName of wb.SheetNames) {
    const key = sheetKey(sheetName);
    if (key === REPORT_SHEET) {
      if (reportName) {
        const before = entries.length;
        emitSheet(wb, sheetName, returnType, entries, { requireGstin: true });
        reportEmitted = entries.length > before;
      }
      continue;
    }
    if (key === B2B_SHEET) {
      if (b2bName && !reportEmitted) emitSheet(wb, sheetName, returnType, entries);
      continue;
    }
    if (SKIP_SHEETS.has(key)) continue;
    // Non-portal sheets (generic Excel/CSV uploads) are parsed only when they
    // expose a recognized transaction header.
    emitSheet(wb, sheetName, returnType, entries);
  }

  const { entries: merged, aggregated } = aggregateEntries(entries, returnType);
  return { entries: merged, aggregated };
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
    cess: 0,
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
  const parsed = parseGstFileDetailed(buffer, fileName, returnType);
  const validated = validateBatch(parsed.entries, returnType, period);
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
    valid: parsed.entries.length - validated.invalidRows.length,
    invalid: validated.invalidRows.length,
    duplicates,
    imported,
    errors: validated.errors,
    aggregated: parsed.aggregated,
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
  const parsed = parseGstFileDetailed(buffer, fileName, returnType);
  const validated = validateBatch(parsed.entries, returnType, period);
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
    aggregated: parsed.aggregated,
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