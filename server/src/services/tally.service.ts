import { XMLParser } from "fast-xml-parser";
import { tallyUrl } from "../utils/config";

// Local TallyPrime connector. TallyPrime accepts XML-over-HTTP POST requests at
// http://localhost:9000 (TALLY_URL). This service only READS company metadata —
// it never writes GST/invoice data or touches the database. Cloud servers
// cannot reach a localhost TallyPrime, so these calls are local-development
// only.

// Raised when TallyPrime responded but the payload is unusable.
export class TallyError extends Error {}

const REQUEST_TIMEOUT_MS = 5000;

// Exports the list of companies TallyPrime can see. FETCH narrows the payload
// to the fields we care about (NAME + GSTIN), keeping the response tiny.
const LIST_COMPANIES_ENVELOPE = `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>ListOfCompanies</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVEXPORTXML>No</SVEXPORTXML>
      </STATICVARIABLES>
      <TDL>
        <TDLMESSAGE>
          <COLLECTION ISMODIFY="No" ISFIXED="No" ISINITIALIZE="No" ISOPTION="No" ISLINKED="No" ISASSOCIATE="No" ISFIXEDALL="No" ISCOMPONENT="No">
            <NAME>ListOfCompanies</NAME>
            <TYPE>Company</TYPE>
            <FETCH>Name,GSTIN</FETCH>
          </COLLECTION>
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>`;

// POST an XML envelope to TallyPrime. Resolves with the raw response body, or
// throws the transport-level error when TallyPrime is unreachable.
export async function tallyRequest(envelope: string, timeoutMs = REQUEST_TIMEOUT_MS): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(tallyUrl(), {
      method: "POST",
      headers: { "Content-Type": "text/xml" },
      body: envelope,
      signal: controller.signal,
    });
    return await resp.text();
  } finally {
    clearTimeout(timer);
  }
}

// Fetches the currently loaded company from TallyPrime. Returns its name and
// GSTIN (when Tally provides one). Throws TallyError on a usable-but-invalid
// response and lets transport errors bubble up as-is.
export async function fetchCurrentCompany(): Promise<{ companyName: string; gstin: string | null }> {
  const xml = await tallyRequest(LIST_COMPANIES_ENVELOPE);

  let parsed: any;
  try {
    parsed = new XMLParser({ ignoreAttributes: false }).parse(xml);
  } catch {
    throw new TallyError("Received an invalid response from TallyPrime");
  }

  // The XML parser tolerates some malformed input, so require a recognisable
  // TallyPrime envelope before trusting the payload.
  if (!parsed || typeof parsed !== "object" || !parsed.ENVELOPE) {
    throw new TallyError("Received an invalid response from TallyPrime");
  }

  const companies = extractCompanies(parsed);
  if (!companies.length) {
    throw new TallyError("No company is currently loaded in TallyPrime");
  }

  const first = companies[0];
  return {
    companyName: textOf(first.NAME) ?? "Unknown",
    gstin: textOf(first.GSTIN),
  };
}

// TallyPrime exports scalar fields as plain text or, when the element carries
// attributes (e.g. <NAME TYPE="String">…</NAME>), as { "#text": "…" }. Normalise
// both shapes before returning a value.
function textOf(v: any): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v === "string") {
    const t = v.trim();
    return t ? t : null;
  }
  // fast-xml-parser converts unadorned tags with numeric-looking text (e.g.
  // <AMOUNT>900</AMOUNT>) into plain numbers; coerce them back to text.
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (typeof v === "object") {
    const t = v["#text"];
    if (t === undefined || t === null) return null;
    return String(t).trim() || null;
  }
  return null;
}

// TallyPrime nests COMPANY entries as ENVELOPE > BODY > DATA > COLLECTION, which
// the XML parser may return as arrays or single objects depending on the shape.
function extractCompanies(parsed: any): Array<{ NAME?: string; GSTIN?: string }> {
  const collection = parsed?.ENVELOPE?.BODY?.DATA?.COLLECTION;
  if (!collection) return [];
  const raw = Array.isArray(collection) ? collection : [collection];
  const entries: any[] = [];
  for (const c of raw) {
    if (!c?.COMPANY) continue;
    entries.push(...(Array.isArray(c.COMPANY) ? c.COMPANY : [c.COMPANY]));
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Sales / Purchase vouchers (read-only)
// ---------------------------------------------------------------------------

export interface VoucherItem {
  itemName: string | null;
  quantity: number;
  unit: string | null;
  rate: number;
  rateUnit: string | null;
  amount: number;
  hsn: string | null;
}

// Normalised view of one TallyPrime voucher, shaped for the frontend. The raw
// Tally export is kept separate (see fetchVouchers -> raw) so consumers can
// debug against the source structure without guessing at the normalisation.
export interface NormalizedVoucher {
  voucherNumber: string | null;
  voucherDate: string | null; // ISO YYYY-MM-DD
  voucherType: string | null;
  partyName: string | null;
  partyGSTIN: string | null;
  invoiceNumber: string | null;
  taxableValue: number;
  cgst: number;
  sgst: number;
  igst: number;
  roundOff: number;
  totalAmount: number;
  items: VoucherItem[];
}

export type VoucherKind = "sales" | "purchases";

// TallyPrime's built-in voucher type names used to filter the Day Book export.
const VOUCHER_TYPE_NAME: Record<VoucherKind, string> = {
  sales: "Sales",
  purchases: "Purchase",
};

const TALLY_MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

// ISO YYYY-MM-DD -> "18-Aug-2026". TallyPrime accepts d-MMM-yyyy inside
// SVFROMDATE/SVTODATE when the tag carries TYPE="Date" (verified live).
function toTallyDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}-${TALLY_MONTHS[Number(m) - 1]}-${y}`;
}

// Exports the Day Book report filtered to a single voucher type. The built-in
// $$VchSales / $$VchPurchase collections fail on TallyPrime ("Could not find
// description"), so a REPORT ISMODIFY filter + Formulae SYSTEM is injected into
// a TYPE=Data, ID=DayBook export instead.
function voucherEnvelope(kind: VoucherKind, fromDate: string, toDate: string): string {
  const vchType = VOUCHER_TYPE_NAME[kind];
  return `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Data</TYPE>
    <ID>DayBook</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
        <SVFROMDATE TYPE="Date">${toTallyDate(fromDate)}</SVFROMDATE>
        <SVTODATE TYPE="Date">${toTallyDate(toDate)}</SVTODATE>
      </STATICVARIABLES>
      <TDL>
        <TDLMESSAGE>
          <REPORT NAME="Day Book" ISMODIFY="Yes">
            <LOCAL>Collection : Default : Add : Filter : VchTypeFilter</LOCAL>
            <LOCAL>Collection : Default : Add : Fetch : VoucherTypeName</LOCAL>
          </REPORT>
          <SYSTEM TYPE="Formulae" NAME="VchTypeFilter">$VoucherTypeName = "${vchType}"</SYSTEM>
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>`;
}

// Fetches all Sales/Purchase vouchers for the given range (ISO YYYY-MM-DD) and
// returns both the raw parsed Tally export (raw) and the normalised shape
// (vouchers). Vouchers whose VOUCHERTYPENAME does not match the requested kind
// are filtered out. Throws TallyError on a usable-but-invalid response;
// transport errors bubble up.
export async function fetchVouchers(
  kind: VoucherKind,
  fromDate: string, // ISO YYYY-MM-DD
  toDate: string, // ISO YYYY-MM-DD
): Promise<{ raw: any[]; vouchers: NormalizedVoucher[] }> {
  const xml = await tallyRequest(voucherEnvelope(kind, fromDate, toDate));

  let parsed: any;
  try {
    parsed = new XMLParser({ ignoreAttributes: false }).parse(xml);
  } catch {
    throw new TallyError("Received an invalid response from TallyPrime");
  }
  if (!parsed || typeof parsed !== "object" || !parsed.ENVELOPE) {
    throw new TallyError("Received an invalid response from TallyPrime");
  }

  const raw = extractVouchers(parsed);
  const expectedType = VOUCHER_TYPE_NAME[kind];
  const vouchers = raw
    .map(normalizeVoucher)
    .filter((v) => v.voucherType === expectedType);
  return { raw, vouchers };
}

// Day Book exports each voucher directly under DATA > TALLYMESSAGE > VOUCHER
// (no COLLECTION wrapper). TALLYMESSAGE can repeat; normalise with toArray.
function extractVouchers(parsed: any): any[] {
  const out: any[] = [];
  for (const message of toArray(parsed?.ENVELOPE?.BODY?.DATA?.TALLYMESSAGE)) {
    if (!message?.VOUCHER) continue;
    out.push(...toArray(message.VOUCHER));
  }
  return out;
}

function toArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

// In the Day Book export each repeated <LEDGERENTRIES.LIST> block IS one ledger
// entry (party line, CGST/SGST/IGST, Round Off, ...) — there is no
// ALLLEDGERENTRIES/LEDGERENTRY wrapper. The nested shape is also flattened
// defensively in case other Tally versions wrap the entries.
function collectLedgerEntries(raw: any): any[] {
  const out: any[] = [];
  for (const block of toArray(raw?.["LEDGERENTRIES.LIST"])) {
    if (textOf(block?.LEDGERNAME) !== null) {
      out.push(block);
      continue;
    }
    for (const group of toArray(block?.ALLLEDGERENTRIES)) {
      out.push(...toArray(group?.LEDGERENTRY));
    }
  }
  return out;
}

// Likewise for stock: each repeated <ALLINVENTORYENTRIES.LIST> block is one
// item (STOCKITEMNAME, ACTUALQTY, RATE, AMOUNT, GSTHSNNAME).
function collectInventoryEntries(raw: any): any[] {
  const out: any[] = [];
  for (const block of toArray(raw?.["ALLINVENTORYENTRIES.LIST"])) {
    if (textOf(block?.STOCKITEMNAME) !== null) {
      out.push(block);
      continue;
    }
    for (const group of toArray(block?.ALLINVENTORYENTRIES)) {
      out.push(...toArray(group?.INVENTORYENTRY));
    }
  }
  return out;
}

function numOf(v: any): number {
  const t = textOf(v);
  if (t === null) return 0;
  const n = Number(t.replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}

// Day Book exports <DATE>YYYYMMDD</DATE>. The parser yields a plain number
// (20260818) when the tag carries no attributes, so stringify before matching.
function parseTallyDate(v: any): string | null {
  const t = typeof v === "number" ? String(v) : textOf(v);
  if (!t) return null;
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(t);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

// ACTUALQTY exports as " 10 NOS"; RATE as "247.61/NOS".
function quantityOf(v: any): number {
  const t = textOf(v);
  if (!t) return 0;
  const m = /^([\d.]+)/.exec(t.trim());
  return m ? Number(m[1]) || 0 : 0;
}

function unitOf(v: any): string | null {
  const t = textOf(v);
  if (!t) return null;
  const m = /^[\d.]+\s*(.*)$/.exec(t.trim());
  const unit = m?.[1]?.trim();
  return unit || null;
}

function rateOf(v: any): number {
  const t = textOf(v);
  if (!t) return 0;
  const m = /^([\d.,]+)/.exec(t.trim());
  return m ? Number(m[1].replace(/,/g, "")) || 0 : 0;
}

function rateUnitOf(v: any): string | null {
  const t = textOf(v);
  if (!t) return null;
  const m = /^[\d.,]+\/?\s*([A-Za-z%]+)$/.exec(t.trim());
  return m ? m[1] : null;
}

// The invoice number lives in the party line's <BILLALLOCATIONS.LIST><NAME>
// (e.g. ACO/26-27/227). Collected from voucher and ledger levels; the first
// non-empty NAME wins.
function extractInvoiceNumber(raw: any, ledgerEntries: any[]): string | null {
  const names: string[] = [];
  const collect = (node: any) => {
    for (const bill of toArray(node?.["BILLALLOCATIONS.LIST"])) {
      const name = textOf(bill?.NAME);
      if (name) names.push(name);
    }
  };
  collect(raw);
  for (const entry of ledgerEntries) collect(entry);
  return names[0] ?? null;
}

function normalizeVoucher(raw: any): NormalizedVoucher {
  const ledgerEntries = collectLedgerEntries(raw);
  const inventoryEntries = collectInventoryEntries(raw);

  // Tax ledgers carry exact Tally names (CGST / SGST / IGST / Round Off); the
  // party line is the only ISPARTYLEDGER="Yes" entry and its |amount| is the
  // invoice total. The taxable value is the sum of the stock-item amounts (each
  // item posts its taxable value via ACCOUNTINGALLOCATIONS -> SALES GST).
  let cgst = 0;
  let sgst = 0;
  let igst = 0;
  let roundOff = 0;
  let partyAmount: number | null = null;
  for (const entry of ledgerEntries) {
    const name = textOf(entry.LEDGERNAME);
    const amount = Math.abs(numOf(entry.AMOUNT));
    if (name === "CGST") cgst += amount;
    else if (name === "SGST") sgst += amount;
    else if (name === "IGST") igst += amount;
    else if (name === "Round Off") roundOff += amount;
    if (textOf(entry.ISPARTYLEDGER) === "Yes") partyAmount = amount;
  }

  const items: VoucherItem[] = inventoryEntries.map((entry) => ({
    itemName: textOf(entry.STOCKITEMNAME) ?? null,
    quantity: quantityOf(entry.ACTUALQTY),
    unit: unitOf(entry.ACTUALQTY),
    rate: rateOf(entry.RATE),
    rateUnit: rateUnitOf(entry.RATE),
    amount: numOf(entry.AMOUNT),
    hsn: textOf(entry.GSTHSNNAME) ?? null,
  }));

  const itemsTaxable = items.reduce((sum, item) => sum + Math.abs(item.amount), 0);
  const totalAmount = Math.round((partyAmount ?? itemsTaxable + cgst + sgst + igst + roundOff) * 100) / 100;
  const taxableValue =
    itemsTaxable > 0
      ? Math.round(itemsTaxable * 100) / 100
      : Math.round(Math.max(0, totalAmount - cgst - sgst - igst - roundOff) * 100) / 100;

  const voucherNumber = textOf(raw.VOUCHERNUMBER) ?? textOf(raw["@_VOUCHERNUMBER"]) ?? null;
  // The voucher carries the party's GSTIN (may be empty); the company's own
  // GSTIN lives in CMPGSTIN and must never be used here.
  const partyGSTIN = textOf(raw.PARTYGSTIN);
  const invoiceNumber = extractInvoiceNumber(raw, ledgerEntries) ?? voucherNumber;

  return {
    voucherNumber,
    voucherDate: parseTallyDate(raw.DATE),
    voucherType: textOf(raw.VOUCHERTYPENAME) ?? null,
    partyName: textOf(raw.PARTYLEDGERNAME) ?? null,
    partyGSTIN,
    invoiceNumber,
    taxableValue,
    cgst: Math.round(cgst * 100) / 100,
    sgst: Math.round(sgst * 100) / 100,
    igst: Math.round(igst * 100) / 100,
    roundOff: Math.round(roundOff * 100) / 100,
    totalAmount,
    items,
  };
}