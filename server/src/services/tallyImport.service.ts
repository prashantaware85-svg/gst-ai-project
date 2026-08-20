import { Prisma } from "@prisma/client";
import { prisma } from "../utils/prisma";
import { num } from "../utils/db";
import {
  fetchCurrentCompany,
  fetchVouchers,
  type NormalizedVoucher,
  type VoucherKind,
} from "./tallyTransport.service";

// Persists TallyPrime vouchers into the application database (read-only; Tally
// itself is never written to). Duplicate prevention is two-layered: a code-level
// key check (voucherType + voucherNumber + voucherDate) plus the unique index
// on TallyImport, so re-running an import never creates duplicate records.
//
// Money is stored as Prisma Decimal; every value crossing back to the API is
// normalised to a plain number via num() (same convention as reconciliation).

export interface ImportTotals {
  count: number;
  taxableValue: number;
  cgst: number;
  sgst: number;
  igst: number;
  roundOff: number;
  totalAmount: number;
}

export interface ImportRunResult {
  voucherType: string;
  imported: number;
  skipped: number;
  failed: number;
  vouchers: NormalizedVoucher[];
  totals: ImportTotals;
}

const VOUCHER_TYPE_NAME: Record<VoucherKind, string> = {
  sales: "Sales",
  purchases: "Purchase",
};

// "2026-08-18" -> Date at UTC midnight, so stored dates round-trip as stable
// YYYY-MM-DD values regardless of the server timezone.
function dateOf(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function isoOf(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function keyOf(v: Pick<NormalizedVoucher, "voucherNumber" | "voucherDate">): string | null {
  if (!v.voucherNumber || !v.voucherDate) return null;
  return `${v.voucherNumber}|${v.voucherDate}`;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function sumTotals(vouchers: NormalizedVoucher[], voucherType: string): ImportTotals {
  return vouchers.reduce<ImportTotals>(
    (acc, v) => {
      acc.count += 1;
      acc.taxableValue += round2(v.taxableValue);
      acc.cgst += round2(v.cgst);
      acc.sgst += round2(v.sgst);
      acc.igst += round2(v.igst);
      acc.roundOff += round2(v.roundOff);
      acc.totalAmount += round2(v.totalAmount);
      return acc;
    },
    { count: 0, taxableValue: 0, cgst: 0, sgst: 0, igst: 0, roundOff: 0, totalAmount: 0 },
  );
}

// Keys already stored for this voucher type within the date range. Checking by
// voucherDate is enough: a duplicate re-import always covers the same dates.
async function existingKeys(voucherType: string, from: Date, to: Date): Promise<Set<string>> {
  const rows = await prisma.tallyImport.findMany({
    where: { voucherType, voucherDate: { gte: from, lte: to } },
    select: { voucherNumber: true, voucherDate: true },
  });
  return new Set(rows.map((r) => `${r.voucherNumber}|${isoOf(r.voucherDate)}`));
}

// Batched insert, honouring the unique index as a backstop: rows that collide
// (a concurrent import slipped in between the key check and the insert) are
// counted as duplicates, everything else is inserted. Returns the number of
// rows actually created.
async function saveRows(data: Prisma.TallyImportCreateManyInput[]): Promise<number> {
  try {
    return (await prisma.tallyImport.createMany({ data })).count;
  } catch {
    let created = 0;
    for (const row of data) {
      try {
        await prisma.tallyImport.create({ data: row });
        created += 1;
      } catch {
        // Unique constraint violation — duplicate, skip silently.
      }
    }
    return created;
  }
}

// Fetches vouchers of the requested kind from TallyPrime, saves the new ones to
// the database and records an import run. Throws the transport-level error when
// TallyPrime is unreachable (same contract as fetchVouchers).
export async function importVouchers(
  kind: VoucherKind,
  fromDate: string,
  toDate: string,
): Promise<ImportRunResult> {
  const voucherType = VOUCHER_TYPE_NAME[kind];
  const company = await fetchCurrentCompany();
  const companyName = company.companyName ?? null;

  const { vouchers } = await fetchVouchers(kind, fromDate, toDate);
  const from = dateOf(fromDate);
  const to = dateOf(toDate);

  const existing = await existingKeys(voucherType, from, to);
  const toInsert = vouchers.filter((v) => {
    const key = keyOf(v);
    return key !== null && !existing.has(key);
  });
  const skipped = vouchers.length - toInsert.length;

  let imported = 0;
  if (toInsert.length) {
    const data = toInsert
      .filter((v) => v.voucherNumber && v.voucherDate)
      .map((v) => ({
        source: "TALLY",
        voucherType,
        voucherNumber: v.voucherNumber!,
        voucherDate: dateOf(v.voucherDate!),
        partyName: v.partyName,
        partyGSTIN: v.partyGSTIN,
        invoiceNumber: v.invoiceNumber,
        taxableValue: round2(v.taxableValue),
        cgst: round2(v.cgst),
        sgst: round2(v.sgst),
        igst: round2(v.igst),
        roundOff: round2(v.roundOff),
        totalAmount: round2(v.totalAmount),
        items: JSON.stringify(v.items ?? []),
        companyName,
      }));
    imported = await saveRows(data);
  }
  const failed = Math.max(0, toInsert.length - imported);

  await prisma.tallyImportRun.create({
    data: {
      voucherType,
      fromDate: from,
      toDate: to,
      imported,
      skipped,
      failed,
      companyName,
    },
  });

  const totals = sumTotals(toInsert, voucherType);
  totals.count = imported;
  return { voucherType, imported, skipped, failed, vouchers: toInsert, totals };
}

export interface ImportSummaryRow {
  imported: number;
  skipped: number;
  failed: number;
  count: number;
}

export interface ImportSummary {
  total: number;
  byVoucherType: { Sales: number; Purchase: number };
  last: { Sales: ImportSummaryRow; Purchase: ImportSummaryRow };
  runs: Array<{
    id: number;
    voucherType: string;
    fromDate: string;
    toDate: string;
    imported: number;
    skipped: number;
    failed: number;
    ranAt: string;
  }>;
}

export async function getImportSummary(): Promise<ImportSummary> {
  const [sales, purchases, total, runs] = await Promise.all([
    prisma.tallyImport.count({ where: { voucherType: "Sales" } }),
    prisma.tallyImport.count({ where: { voucherType: "Purchase" } }),
    prisma.tallyImport.count(),
    prisma.tallyImportRun.findMany({ orderBy: { ranAt: "desc" }, take: 100 }),
  ]);

  const empty = { imported: 0, skipped: 0, failed: 0, count: 0 };
  const lastByType: Record<string, ImportSummaryRow> = {};
  for (const r of runs) {
    if (!lastByType[r.voucherType]) {
      lastByType[r.voucherType] = {
        imported: r.imported,
        skipped: r.skipped,
        failed: r.failed,
        count: r.voucherType === "Sales" ? sales : purchases,
      };
    }
  }

  return {
    total,
    byVoucherType: { Sales: sales, Purchase: purchases },
    last: {
      Sales: lastByType.Sales ?? { ...empty, count: sales },
      Purchase: lastByType.Purchase ?? { ...empty, count: purchases },
    },
    runs: runs.map((r) => ({
      id: r.id,
      voucherType: r.voucherType,
      fromDate: isoOf(r.fromDate),
      toDate: isoOf(r.toDate),
      imported: r.imported,
      skipped: r.skipped,
      failed: r.failed,
      ranAt: r.ranAt.toISOString(),
    })),
  };
}

// Recent imported records (read-only, for review/debugging in the UI). When a
// date range is supplied the rows are restricted to vouchers dated within it, so
// the UI can show exactly the selected period rather than the global latest.
export async function listImports(voucherType?: string, fromIso?: string, toIso?: string, limit = 200) {
  const where: Prisma.TallyImportWhereInput = {};
  if (voucherType === "Sales" || voucherType === "Purchase") where.voucherType = voucherType;
  if (fromIso || toIso) {
    const date: Prisma.DateTimeFilter = {};
    if (fromIso) date.gte = dateOf(fromIso);
    if (toIso) date.lte = dateOf(toIso);
    where.voucherDate = date;
  }
  const rows = await prisma.tallyImport.findMany({
    where,
    orderBy: { importedAt: "desc" },
    take: Math.min(limit, 500),
  });
  return rows.map((r) => ({
    id: r.id,
    source: r.source,
    voucherType: r.voucherType,
    voucherNumber: r.voucherNumber,
    voucherDate: isoOf(r.voucherDate),
    partyName: r.partyName,
    partyGSTIN: r.partyGSTIN,
    invoiceNumber: r.invoiceNumber,
    taxableValue: num(r.taxableValue),
    cgst: num(r.cgst),
    sgst: num(r.sgst),
    igst: num(r.igst),
    roundOff: num(r.roundOff),
    totalAmount: num(r.totalAmount),
    items: safeParseItems(r.items),
    companyName: r.companyName,
    importedAt: r.importedAt.toISOString(),
  }));
}

function safeParseItems(raw: string): unknown[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
