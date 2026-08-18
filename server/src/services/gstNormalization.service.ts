// GST data normalization layer (Phase 2).
//
// GST portal exports (Excel / CSV / JSON) use many different column spellings
// and value formats. This service normalizes:
//   * column headers -> canonical fields  (case-insensitive, alias tables)
//   * GSTIN           -> trimmed/upper/no separators (shares utils/gstin)
//   * invoice numbers -> uppercase, whitespace collapsed, separators preserved
//   * dates           -> ISO (DD/MM/YYYY, DD-MM-YYYY, YYYY-MM-DD, Excel serial)
//   * amounts         -> integer paise (cents) internally, Decimals out
//
// All money arithmetic for GST import happens on integer paise so tax math
// never relies on floating point; money only becomes a JS number / Decimal at
// the persistence boundary (the same roundtrip convention the Tally import uses).
import { normalizeGstin, isValidGstin } from "../utils/gstin";

// Canonical GST row shape produced by the importer. Money fields are plain
// numbers (rounded to paise); all optional string fields are trimmed
// or nulled. `gstin` is the owning company GSTIN when the file carries one;
// `counterpartyGstin` is the customer (GSTR-1) or supplier (GSTR-2B) GSTIN.
export interface NormalizedGstRow {
  gstin: string | null;
  counterpartyGstin: string | null;
  counterpartyName: string | null;
  invoiceNumber: string;
  invoiceDate: Date | null;
  taxableValue: number;
  cgst: number;
  sgst: number;
  igst: number;
  invoiceValue: number;
  placeOfSupply: string | null;
  hsn: string | null;
  documentType: string | null;
}

export type GstReturnType = "GSTR1" | "GSTR2B";

// ---------------------------------------------------------------------------
// Column aliases
// ---------------------------------------------------------------------------

// Aliases that always mean "our own company GSTIN". Bare "GSTIN" is NOT here:
// in both GSTR-1 and GSTR-2B export files the plain GSTIN column refers to the
// counterparty, and it already resolves through COUNTERPARTY_GSTIN_ALIASES.
const OWN_GSTIN_ALIASES = [
  "COMPANY GSTIN", "COMPANY GSTIN/UIN", "YOUR GSTIN", "OUR GSTIN", "OWN GSTIN",
  "COMPANY GSTIN NUMBER", "BUSINESS GSTIN",
];

// Aliases that mean the counterparty GSTIN. For GSTR-1 the counterparty is the
// customer; for GSTR-2B the counterparty is the supplier. A bare "GSTIN"
// column in either return type is treated as the counterparty.
const COUNTERPARTY_GSTIN_ALIASES = [
  "GSTIN", "GSTIN/UIN", "CUSTOMER GSTIN", "SUPPLIER GSTIN", "RECIPIENT GSTIN",
  "RECEIVER GSTIN", "COUNTERPARTY GSTIN", "PARTY GSTIN", "BUYER GSTIN",
  "SELLER GSTIN", "GSTIN OF SUPPLIER", "GSTIN OF CUSTOMER", "BILL TO GSTIN",
  "CTIN",
];

const COUNTERPARTY_NAME_ALIASES = [
  "CUSTOMER NAME", "SUPPLIER NAME", "VENDOR NAME", "PARTY NAME",
  "COUNTERPARTY NAME", "BUYER NAME", "SELLER NAME", "TRADE NAME",
  "TRADE/LEGAL NAME OF SUPPLIER", "TRADE/LEGAL NAME OF CUSTOMER",
  "LEGAL NAME", "BILL TO", "SUPPLIER", "CUSTOMER",
];

const INVOICE_NUMBER_ALIASES = [
  "INVOICE NO", "INVOICE NUMBER", "INVOICE NO.", "INVOICE #", "INVOICENO",
  "INVOICE NUM", "INVOICE NO#", "INVOICE", "INV NO", "INV NUMBER", "INV NO.",
  "DOCUMENT NO", "DOCUMENT NUMBER", "DOC NUMBER", "DOC NO", "NOTE NO",
  "NOTE NUMBER", "BILL NO", "BILL NUMBER",
];

const INVOICE_DATE_ALIASES = [
  "INVOICE DATE", "DOCUMENT DATE", "DATE", "NOTE DATE", "BILL DATE",
  "INVOICE DT", "DT", "INVOICEDATE",
];

const TAXABLE_VALUE_ALIASES = [
  "TAXABLE VALUE", "TAXABLE", "TAXABLE AMOUNT", "TAXABLE VALUE (INR)",
  "TAXABLE AMOUNT (INR)", "TAXABLE AMT", "TAXABLE VALUE(INR)", "TXVAL",
];

const CGST_ALIASES = [
  "CGST", "CGST AMOUNT", "CENTRAL TAX AMOUNT", "CENTRAL TAX",
  "CGST TAX AMOUNT", "CAMT",
];

const SGST_ALIASES = [
  "SGST", "SGST AMOUNT", "STATE/UT TAX AMOUNT", "STATE TAX AMOUNT", "STATE TAX",
  "SGST TAX AMOUNT", "SAMT",
];

const IGST_ALIASES = [
  "IGST", "IGST AMOUNT", "INTEGRATED TAX AMOUNT", "INTEGRATED TAX",
  "IGST TAX AMOUNT", "IAMT",
];

const INVOICE_VALUE_ALIASES = [
  "INVOICE VALUE", "INVOICE AMOUNT", "TOTAL INVOICE VALUE", "TOTAL VALUE",
  "GROSS AMOUNT", "TOTAL AMOUNT", "TOTAL", "INVOICE TOTAL", "TAXABLE AND TAX",
  "BILL VALUE",
];

const PLACE_OF_SUPPLY_ALIASES = [
  "PLACE OF SUPPLY", "PLACE OF SUPPLY (POS)", "PLACE OF SUPPLY - POS",
  "PLACE OF SUPPLY(POS)", "POS", "PLACE OF SUPPLY STATE", "STATE NAME",
];

const HSN_ALIASES = [
  "HSN", "HSN CODE", "HSN/SAC", "HSN/SAC CODE", "HSN CODE/SAC", "HSN NO",
  "HSN CODE NUMBER",
];

const DOCUMENT_TYPE_ALIASES = [
  "DOCUMENT TYPE", "DOC TYPE", "TYPE", "DOCUMENT", "DOCUMENT TYPE CODE",
  "DOC TYPE CODE", "INVOICE TYPE",
];

function headerKey(s: string): string {
  return String(s ?? "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, " ");
}

// Build a normalized header -> value lookup for an arbitrary row (object or
// JSON record). Duplicate normalized headers keep the first occurrence.
function rowLookup(row: Record<string, unknown>): Map<string, unknown> {
  const map = new Map<string, unknown>();
  for (const [key, value] of Object.entries(row)) {
    const k = headerKey(key);
    if (k && !map.has(k)) map.set(k, value);
  }
  return map;
}

function pick(lookup: Map<string, unknown>, aliases: string[]): unknown {
  for (const a of aliases) {
    if (lookup.has(a)) return lookup.get(a);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

// Normalized comparable invoice number: uppercase, collapsed whitespace,
// meaningful "/" and "-" preserved. The original is kept for display; this
// form is used for intra-file duplicate detection and matching falls back to
// utils/fuzzy for the canonical/equality rules.
export function normalizeInvoiceText(n: unknown): string {
  return String(n ?? "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
}

// Total days in Gregorian month (for Excel serial sanity + period math).
function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

// Converts a date-like value to a Date (UTC midnight) or null:
//   * JS Date                                -> itself (UTC midnight)
//   * Excel serial number (20000..80000)     -> 1899-12-30 + serial days
//   * "DD/MM/YYYY", "DD-MM-YYYY", "YYYY-MM-DD", "YYYY/MM/DD" (+2-digit years)
export function normalizeDate(v: unknown): Date | null {
  if (v === null || v === undefined || v === "") return null;
  if (v instanceof Date) {
    const d = v;
    return Number.isNaN(d.getTime())
      ? null
      : new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  }
  if (typeof v === "number") {
    // Fractional serials carry a time-of-day component (GST CSV exports parse
    // "05/07/2026" into serial + fraction); the date part is the whole days.
    if (v >= 20000 && v <= 80000) {
      return excelSerialToDate(Math.floor(v));
    }
    return null;
  }
  let s = String(v).trim();
  if (!s) return null;

  // Excel serials sometimes arrive as numeric strings ("46067").
  if (/^\d{5,6}$/.test(s)) {
    const n = Number(s);
    if (n >= 20000 && n <= 80000) return excelSerialToDate(n);
    return null;
  }

  // DD/MM/YYYY | DD-MM-YYYY | DD.MM.YYYY (also with 2-digit year)
  let m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
  if (m) {
    const day = Number(m[1]);
    const mon = Number(m[2]);
    const yr = Number(m[3].length === 2 ? `20${m[3]}` : m[3]);
    return validDateOrNull(yr, mon, day) ? new Date(Date.UTC(yr, mon - 1, day)) : null;
  }

  // YYYY/MM/DD
  m = s.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/);
  if (m) {
    const yr = Number(m[1]);
    const mon = Number(m[2]);
    const day = Number(m[3]);
    return validDateOrNull(yr, mon, day) ? new Date(Date.UTC(yr, mon - 1, day)) : null;
  }

  // Anything the JS parser understands (e.g. "01 Apr 2026", full ISO timestamps)
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) {
    return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  }
  return null;
}

function validDateOrNull(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false;
  return d <= daysInMonth(y, m);
}

function excelSerialToDate(serial: number): Date {
  const ms = Date.UTC(1899, 11, 30) + serial * 86400000;
  const d = new Date(ms);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export function isoOf(d: Date): string {
  if (!d) return "";
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(
    d.getUTCDate(),
  ).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Money (integer paise)
// ---------------------------------------------------------------------------

// Parse any reasonable monetary value ("1,00,000.50", "₹12,345", 10000,
// "10000.5", "-500") into whole paise. Returns null when unparseable.
export function toCents(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return null;
    return Math.round(v * 100);
  }
  const s = String(v).trim();
  if (!s) return null;
  const cleaned = s
    .replace(/[₹,\u00A0]/g, "") // currency sign, thousands grouping, nbsp
    .trim();
  if (!cleaned) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  // Guard against strings that produced a partial number ("12abc").
  if (!/^[+\-]?\d*(\.\d*)?$/.test(cleaned)) return null;
  return Math.round(n * 100);
}

export function amountFromCents(cents: number): number {
  return Math.round(cents) / 100;
}

// Parse one money cell. `present` distinguishes an absent column (defaults to
// zero, never an error) from a present-but-unparseable value (an error).
// Empty/null/whitespace cells are treated as zero — GST export files leave tax
// cells blank on non-applicable rows.
function moneyOf(
  lookup: Map<string, unknown>,
  aliases: string[],
): { cents: number; error: boolean } {
  const v = pick(lookup, aliases);
  if (v === undefined) return { cents: 0, error: false };
  const cents = toCents(v);
  if (cents === null) {
    if (v === null || v === "" || (typeof v === "string" && v.trim() === "")) {
      return { cents: 0, error: false };
    }
    return { cents: 0, error: true };
  }
  return { cents, error: false };
}

export function centsSum(...values: (number | null)[]): number {
  let sum = 0;
  for (const v of values) {
    if (typeof v === "number") sum += Math.round(v);
  }
  return Math.round(sum);
}

// Sum an unknown collection of amounts into paise then back to a 2-dp number.
export function sumMoney(...values: unknown[]): number {
  let cents = 0;
  for (const v of values) {
    const c = toCents(v);
    if (c !== null) cents += c;
  }
  return amountFromCents(cents);
}

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

export interface RowMappingResult {
  row: NormalizedGstRow;
  errors: string[];
}

// Map a single raw record onto the canonical GST row shape using the alias
// tables (case-insensitive). Validation of completeness is handled separately
// (validateGstRow) so callers can show per-row invalid reasons.
export function mapGstRow(
  raw: Record<string, unknown>,
  returnType: GstReturnType,
): RowMappingResult {
  const lookup = rowLookup(raw);
  const errors: string[] = [];

  const counterpartyGstin = normalizeGstin(pick(lookup, COUNTERPARTY_GSTIN_ALIASES));
  const ownGstin = normalizeGstin(pick(lookup, OWN_GSTIN_ALIASES));
  // A bare "GSTIN" column is the counterparty for both return types; only
  // explicit own-company headers fill `gstin`.
  const gstin = ownGstin || null;
  void returnType; // counterparty semantics are uniform via the alias tables

  const counterpartyName = clean(pick(lookup, COUNTERPARTY_NAME_ALIASES));
  const invoiceNumber = normalizeInvoiceText(pick(lookup, INVOICE_NUMBER_ALIASES));
  const invoiceDate = normalizeDate(pick(lookup, INVOICE_DATE_ALIASES));

  // Missing/empty money cells default to 0; only a genuinely non-numeric
  // value (e.g. "abc") is an attribute-level error. GSTR files legitimately
  // leave CGST/SGST blank on IGST rows, and an absent column is common.
  const taxable = moneyOf(lookup, TAXABLE_VALUE_ALIASES);
  const cgst = moneyOf(lookup, CGST_ALIASES);
  const sgst = moneyOf(lookup, SGST_ALIASES);
  const igst = moneyOf(lookup, IGST_ALIASES);
  const invoiceValue = toCents(pick(lookup, INVOICE_VALUE_ALIASES));

  if (taxable.error) errors.push("Taxable value is not numeric");
  if (cgst.error) errors.push("CGST is not numeric");
  if (sgst.error) errors.push("SGST is not numeric");
  if (igst.error) errors.push("IGST is not numeric");

  const computedInvoiceValue = centsSum(taxable.cents, cgst.cents, sgst.cents, igst.cents);

  return {
    row: {
      gstin,
      counterpartyGstin: counterpartyGstin || null,
      counterpartyName,
      invoiceNumber,
      invoiceDate,
      taxableValue: amountFromCents(taxable.cents),
      cgst: amountFromCents(cgst.cents),
      sgst: amountFromCents(sgst.cents),
      igst: amountFromCents(igst.cents),
      invoiceValue: amountFromCents(invoiceValue ?? computedInvoiceValue),
      placeOfSupply: clean(pick(lookup, PLACE_OF_SUPPLY_ALIASES)),
      hsn: clean(pick(lookup, HSN_ALIASES)),
      documentType: documentTypeOf(pick(lookup, DOCUMENT_TYPE_ALIASES)),
    },
    errors,
  };
}

// Validate a normalized row. Returns canonical error strings; an empty array
// means the row is importable.
export function validateGstRow(
  row: NormalizedGstRow,
  returnType: GstReturnType,
): string[] {
  const errors: string[] = [];
  if (!row.invoiceNumber) errors.push("Invoice number is required");
  if (!row.invoiceDate) errors.push("Invoice date is required");
  if (!Number.isFinite(row.taxableValue)) errors.push("Taxable value must be numeric");
  if (!Number.isFinite(row.cgst)) errors.push("CGST must be numeric");
  if (!Number.isFinite(row.sgst)) errors.push("SGST must be numeric");
  if (!Number.isFinite(row.igst)) errors.push("IGST must be numeric");
  if (
    row.invoiceValue !== undefined &&
    row.invoiceValue !== null &&
    !Number.isFinite(row.invoiceValue)
  ) {
    errors.push("Invoice value must be numeric");
  }
  const gstinToCheck = row.counterpartyGstin || row.gstin;
  if (gstinToCheck && !isValidGstin(gstinToCheck)) {
    errors.push(`GSTIN format is invalid: "${gstinToCheck}"`);
  }
  void returnType;
  return errors;
}

// The row is usable when no validation errors remain. Rows without any mapped
// columns produce an explicit "could not be mapped" error via row.isInvalid.
export function isGstRowValid(row: NormalizedGstRow, returnType: GstReturnType): boolean {
  return validateGstRow(row, returnType).length === 0;
}

// Deterministic dedupe key for one transaction (period, return type, GSTINs,
// invoice + date). NULLs are normalized to "" so code-level dedupe matches the
// unique index semantics when counterparty GSTIN is missing.
export function gstTransactionKey(
  row: Pick<
    NormalizedGstRow,
    "counterpartyGstin" | "invoiceNumber" | "invoiceDate"
  > & { gstin?: string | null },
  returnType: GstReturnType,
  period: string,
): string {
  const cust = (row.counterpartyGstin || "").toUpperCase();
  const own = (row.gstin || "").toUpperCase();
  return [returnType, period, own, cust, row.invoiceNumber, row.invoiceDate ? isoOf(row.invoiceDate) : ""].join("|");
}

function clean(v: unknown): string | null {
  const s = String(v ?? "").trim();
  return s || null;
}

function documentTypeOf(v: unknown): string | null {
  const s = String(v ?? "").trim().toUpperCase();
  if (!s) return null;
  if (s === "C" || s === "CREDIT" || s === "CREDIT_NOTE" || s === "CREDIT NOTE" || s === "CN") {
    return "CREDIT_NOTE";
  }
  if (s === "D" || s === "DEBIT" || s === "DEBIT_NOTE" || s === "DEBIT NOTE" || s === "DN") {
    return "DEBIT_NOTE";
  }
  return "INVOICE";
}