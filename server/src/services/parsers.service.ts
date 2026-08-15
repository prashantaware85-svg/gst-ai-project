// Unified ingestion layer. Each parser returns an array of Invoice-shaped
// records that the upload controller bulk-inserts into the database.
//
// The GST portal (GSTN) downloads come in a handful of well-known shapes:
//   * GSTR-2B JSON  -> { data: { b2b: [{ ctin, trdnm, in: [...], ... }] } }
//                      plus credit/debit note tables (cdnur/cdn) and imports.
//   * GSTR-1 JSON   -> { b2b: [{ ctin, trdnm, in: [...] }], cdn: [...] , ... }
//   * GSTR-2B XLSX  -> portal spreadsheet with supplier/invoice/tax columns.
//
// Real portal invoices carry one or many line items (`itms[].itm_det`) and the
// CESS component (`csamt`). All line items are summed per invoice. Invoice
// document type comes from `inv_typ` (R/C/D) or note tables' `ntty`.
import * as XLSX from "xlsx";
import fs from "node:fs";
import { parseDate, parseNum } from "../utils/parse";
import { normalizeGstin } from "../utils/gstin";

export type NoteType = "INVOICE" | "CREDIT_NOTE" | "DEBIT_NOTE";

export interface ParsedRow {
  gstin: string;
  vendorName?: string;
  invoiceNo: string;
  invoiceDate: Date;
  taxableValue: number;
  cgst: number;
  sgst: number;
  igst: number;
  cess: number;
  noteType: NoteType;
}

function noteTypeFrom(code: string | undefined | null): NoteType {
  const c = String(code ?? "").toUpperCase();
  if (c === "C" || c === "CREDIT" || c === "CREDIT_NOTE" || c === "CN") return "CREDIT_NOTE";
  if (c === "D" || c === "DEBIT" || c === "DEBIT_NOTE" || c === "DN") return "DEBIT_NOTE";
  return "INVOICE";
}

const cols = (row: any) => {
  const gstin = normalizeGstin(
    row["GSTIN"] ?? row["gstin"] ?? row["Supplier GSTIN"] ?? row["GSTIN Of Supplier"] ?? row["Recipient GSTIN"] ?? row["ctin"],
  );
  const invNo = String(row["Invoice Number"] ?? row["Invoice No"] ?? row["InvoiceNo"] ?? row["inum"] ?? row["Note No"] ?? "").trim();
  return {
    gstin,
    vendorName: String(row["Vendor Name"] ?? row["Supplier Name"] ?? row["Party Name"] ?? row["Trade/Legal Name Of Supplier"] ?? row["vendorName"] ?? row["trdnm"] ?? "").trim() || undefined,
    invoiceNo: invNo,
    invoiceDate: parseDate(row["Invoice Date"] ?? row["Date"] ?? row["dt"] ?? row["inDate"] ?? row["Note Date"] ?? row["nt_dt"]) ?? new Date(0),
    taxableValue: parseNum(row["Taxable Value"] ?? row["Taxable Amount"] ?? row["txval"] ?? row["OTXVAL"] ?? row["Taxable"] ?? 0),
    cgst: parseNum(row["CGST"] ?? row["Camt"] ?? row["cgst"] ?? row["Central Tax Amount"] ?? 0),
    sgst: parseNum(row["SGST"] ?? row["Samt"] ?? row["sgst"] ?? row["State/UT Tax Amount"] ?? 0),
    igst: parseNum(row["IGST"] ?? row["Iamt"] ?? row["igst"] ?? row["Integrated Tax Amount"] ?? 0),
    cess: parseNum(row["Cess"] ?? row["cess"] ?? row["CSamt"] ?? row["csamt"] ?? row["Cess Amount"] ?? 0),
    noteType: noteTypeFrom(row["Document Type"] ?? row["Doc Type"] ?? row["Type"] ?? row["inv_typ"] ?? row["ntty"]),
  };
};

export function parseExcel(buffer: Buffer): ParsedRow[] {
  const wb = XLSX.read(buffer, { cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  // raw:true keeps date cells as real Date objects (cellDates:true); raw:false
  // would format them as US "M/D/YY" strings that parseDate would mis-read.
  const json: any[] = XLSX.utils.sheet_to_json(ws, { defval: null, raw: true });
  return json.map(cols).filter(r => r.gstin && r.invoiceNo);
}

export function parsePurchaseOrSales(buffer: Buffer): ParsedRow[] {
  return parseExcel(buffer);
}

// Sum the amounts across every line item of a portal invoice. A real invoice
// may have several `itms[]` entries (different rates / HSAs), so taking only
// the first item would understate taxes. Item amounts live in `itms[].itm_det`;
// imports sometimes carry a single flattened `itm_det` on the entry itself.
function sumPortfolio(entry: any) {
  const items = Array.isArray(entry?.itms) ? entry.itms : Array.isArray(entry?.items) ? entry.items : [];
  let txval = 0, camt = 0, samt = 0, iamt = 0, csamt = 0;
  if (items.length) {
    for (const el of items) {
      const d = el?.itm_det ?? el ?? {};
      txval += parseNum(d.txval);
      camt += parseNum(d.camt);
      samt += parseNum(d.samt);
      iamt += parseNum(d.iamt);
      csamt += parseNum(d.csamt);
    }
  } else {
    const d = entry?.itm_det ?? {};
    txval = parseNum(d.txval);
    camt = parseNum(d.camt);
    samt = parseNum(d.samt);
    iamt = parseNum(d.iamt);
    csamt = parseNum(d.csamt);
  }
  // Trailing tax zeros might be omitted when an entry uses only one tax head;
  // honor any top-level totals the portal sets on the invoice node itself.
  const present = (v: unknown) => v !== undefined && v !== null && v !== "";
  if (present(entry?.txval) && txval === 0) txval = parseNum(entry.txval);
  if (present(entry?.camt) && camt === 0) camt = parseNum(entry.camt);
  if (present(entry?.samt) && samt === 0) samt = parseNum(entry.samt);
  if (present(entry?.iamt) && iamt === 0) iamt = parseNum(entry.iamt);
  if (present(entry?.csamt) && csamt === 0) csamt = parseNum(entry.csamt);
  return { txval, camt, samt, iamt, csamt };
}

// Push one portal invoice (`inum`/`idt` + `itms`) under a supplier GSTIN+name.
function pushInvoice(out: ParsedRow[], gstin: string, trdnm: string | undefined, inv: any) {
  const sums = sumPortfolio(inv);
  // Notes key by the document number `nt_num` (books register uses it), not the
  // original invoice number `inum` that the note references.
  const invNo = String(inv?.nt_num ?? inv?.inum ?? inv?.ino ?? "").trim();
  if (!gstin || !invNo) return;
  const invTypeSrc = inv?.ntty ?? inv?.inv_typ;
  const noteType = noteTypeFrom(invTypeSrc);
  out.push({
    gstin,
    vendorName: trdnm || undefined,
    invoiceNo: invNo,
    invoiceDate: parseDate(inv?.nt_dt ?? inv?.dt ?? inv?.idt) ?? new Date(0),
    taxableValue: sums.txval,
    cgst: sums.camt,
    sgst: sums.samt,
    igst: sums.iamt,
    cess: sums.csamt,
    noteType,
  });
}

// Real GSTR-2B JSON: { data: { b2b: [{ctin, trdnm, in:[...]}], b2ba: [...],
// cdnur: [{ctin, trdnm, nt:[{ntty, nt_num, nt_dt, inum, idt, itms}]}],
// impg/impb/...: imports } }. We ingest the B2B invoices plus credit/debit note
// tables; documents-issued / nil-rated / HSN summaries carry no invoice lines.
export function parseGstr2BJson(buffer: Buffer): ParsedRow[] {
  const data = JSON.parse(buffer.toString("utf8"));
  const out: ParsedRow[] = [];
  const root = data?.data ?? data?.gstr2b ?? data ?? {};

  const suppliers = root.b2b || root.b2ba || [];
  for (const s of suppliers) {
    const cstin = normalizeGstin(s.ctin || s.ntin || s.gstin || s);
    const trdnm = String(s.trdnm ?? s.tradeName ?? s.name ?? "").trim() || undefined;
    for (const inv of s.in || []) pushInvoice(out, cstin, trdnm, inv);
  }

  // Credit/Debit Notes (B2B note table) — `cdnur` for 2B, `cdn` also accepted.
  const notes = root.cdnur || root.cdn || [];
  for (const s of notes) {
    const cstin = normalizeGstin(s.ctin || s.gstin || "");
    const trdnm = String(s.trdnm ?? "").trim() || undefined;
    for (const nt of s.nt || []) pushInvoice(out, cstin, trdnm, nt);
  }

  return out.filter(r => r.gstin && r.invoiceNo);
}

// Real GSTR-1 JSON: { b2b: [{ctin, trdnm, in:[...]}], cdn: [{ctin, trdnm,
// nt:[...]}], b2ba: [...], b2cs/b2cl (registered/unregistered consumers) }.
// We reconcile B2B + credit/debit notes; B2CS/B2CL are typically not part of
// the sales register being reconciled here.
export function parseGstr1Json(buffer: Buffer): ParsedRow[] {
  const data = JSON.parse(buffer.toString("utf8"));
  const out: ParsedRow[] = [];
  const root = data?.data ?? data?.gstr1 ?? data ?? {};

  const suppliers = root.b2b || root.b2ba || [];
  for (const s of suppliers) {
    const gstin = normalizeGstin(s.ctin || s.gstin || "");
    const trdnm = String(s.trdnm ?? "").trim() || undefined;
    for (const inv of s.in || []) pushInvoice(out, gstin, trdnm, inv);
  }

  const notes = root.cdn || root.cdnur || [];
  for (const s of notes) {
    const gstin = normalizeGstin(s.ctin || s.gstin || "");
    const trdnm = String(s.trdnm ?? "").trim() || undefined;
    for (const nt of s.nt || []) pushInvoice(out, gstin, trdnm, nt);
  }

  return out.filter(r => r.gstin && r.invoiceNo);
}

// GSTR-2B Excel export from the GST portal. Column names used by GSTN:
//   "GSTIN Of Supplier", "Invoice Number", "Invoice Date", "Taxable Value",
//   "Integrated Tax Amount", "Central Tax Amount", "State/UT Tax Amount",
//   "Cess Amount", "Document Type".
export function parse2BExcel(buffer: Buffer): ParsedRow[] {
  const wb = XLSX.read(buffer, { cellDates: true });
  const out: ParsedRow[] = [];
  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    if (!ws) continue;
    const json: any[] = XLSX.utils.sheet_to_json(ws, { defval: null, raw: true });
    if (!json.length) continue;
    for (const row of json) {
      const gstin = normalizeGstin(
        row["GSTIN Of Supplier"] ?? row["Supplier GSTIN"] ?? row["GSTIN"] ?? row["gstin"] ?? "",
      );
      const invNo = String(
        row["Invoice Number"] ?? row["Invoice No"] ?? row["InvoiceNo"] ?? row["INUM"] ?? row["inum"] ?? "",
      ).trim();
      if (!gstin || !invNo) continue;
      out.push({
        gstin,
        vendorName: String(row["Trade/Legal Name Of Supplier"] ?? row["Supplier Name"] ?? row["Vendor Name"] ?? "").trim() || undefined,
        invoiceNo: invNo,
        invoiceDate: parseDate(row["Invoice Date"] ?? row["Date"] ?? row["dt"] ?? row["idt"]) ?? new Date(0),
        taxableValue: parseNum(row["Taxable Value"] ?? row["Taxable Amount"] ?? row["txval"] ?? 0),
        cgst: parseNum(row["Central Tax Amount"] ?? row["CGST"] ?? row["Camt"] ?? row["cgst"] ?? 0),
        sgst: parseNum(row["State/UT Tax Amount"] ?? row["State Tax Amount"] ?? row["SGST"] ?? row["Samt"] ?? row["sgst"] ?? 0),
        igst: parseNum(row["Integrated Tax Amount"] ?? row["IGST"] ?? row["Iamt"] ?? row["igst"] ?? 0),
        cess: parseNum(row["Cess Amount"] ?? row["Cess"] ?? row["CSamt"] ?? row["csamt"] ?? 0),
        noteType: noteTypeFrom(row["Document Type"] ?? row["Doc Type"] ?? row["Type"]),
      });
    }
  }
  return out;
}

export function readBuffer(filePath: string): Buffer {
  return fs.readFileSync(filePath);
}

// Decide if a GSTR-2B upload is JSON or Excel and dispatch.
export function parse2BAuto(buffer: Buffer, fileName: string): ParsedRow[] {
  const ext = fileName.toLowerCase().split(".").pop();
  if (ext === "json") return parseGstr2BJson(buffer);
  return parse2BExcel(buffer);
}