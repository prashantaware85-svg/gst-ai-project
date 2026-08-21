import { useCallback, useEffect, useState } from "react";
import { api } from "../api/client";
import { Card, Pill, StatusBadge, Stat, Table } from "../components/ui";
import { useAuth } from "../hooks/useAuth";

// GST <-> Tally reconciliation: run the matching engine for a period and return
// type, review unmatched/possible rows, and export the side-by-side report.

interface RunSummary {
  success: boolean;
  runId: number;
  period: string;
  transactionType: "SALES" | "PURCHASE";
  totalTally: number;
  totalGst: number;
  matched: number;
  amountMismatch: number;
  dateMismatch: number;
  invoiceNumberMismatch: number;
  gstinMismatch: number;
  missingInGst: number;
  missingInTally: number;
  duplicateInTally: number;
  duplicateInGst: number;
  possibleMatch: number;
  invalidData: number;
  b2b: number;
  b2c: number;
}

interface ReconResultRow {
  id: number;
  runId: number;
  status: string;
  matchLevel: string | null;
  confidence: number;
  taxableDifference: number;
  cgstDifference: number;
  sgstDifference: number;
  igstDifference: number;
  invoiceValueDifference: number;
  reason: string | null;
  type: "B2B" | "B2C";
  reviewStatus: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  tally: {
    id: number;
    voucherNumber: string;
    voucherDate: string;
    partyName: string | null;
    partyGSTIN: string | null;
    invoiceNumber: string | null;
    taxableValue: number;
    totalAmount: number;
  } | null;
  gst: {
    id: number;
    invoiceNumber: string;
    invoiceDate: string;
    counterpartyGstin: string | null;
    counterpartyName: string | null;
    taxableValue: number;
    invoiceValue: number;
  } | null;
}

function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function fmt(n: unknown): string {
  const x = Number(n ?? 0);
  if (Number.isNaN(x)) return "0";
  return x.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function diffCell(v: number): React.ReactNode {
  if (v === 0) return <span className="text-gray-400">0</span>;
  return <span className={v > 0 ? "text-red-600" : "text-green-600"}>{v > 0 ? "+" : ""}{fmt(v)}</span>;
}

function friendlyError(e: any, fallback: string): string {
  const status = e?.response?.status;
  if (status === 401) return "Authentication failed. Please log in again.";
  if (status === 403) return "You do not have permission to perform this action.";
  return e?.response?.data?.message || fallback;
}

export default function Reconciliation() {
  const { user } = useAuth();
  const canWrite = user?.role === "ADMIN" || user?.role === "ACCOUNTANT";

  const [period, setPeriod] = useState(currentMonth());
  const [txnType, setTxnType] = useState<"SALES" | "PURCHASE">("SALES");
  const [statusFilter, setStatusFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [page, setPage] = useState(1);
  const pageSize = 50;

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [summary, setSummary] = useState<RunSummary | null>(null);
  const [rows, setRows] = useState<ReconResultRow[]>([]);
  const [total, setTotal] = useState(0);
  const [runActive, setRunActive] = useState(false);

  const [reviewFor, setReviewFor] = useState<number | null>(null);
  const [reviewStatus, setReviewStatus] = useState("ACCEPTED");
  const [reviewNote, setReviewNote] = useState("");
  const [savingReview, setSavingReview] = useState(false);

  const loadSummary = useCallback(async () => {
    try {
      const s = await api.reconSummary(period, txnType);
      if (s?.success) setSummary(s as RunSummary);
      else setSummary(null);
    } catch {
      setSummary(null);
    }
  }, [period, txnType]);

  const loadResults = useCallback(async () => {
    try {
      const params: Record<string, string | number> = { period, transactionType: txnType, page, pageSize };
      if (statusFilter) params.status = statusFilter;
      const d = await api.reconResults(params);
      if (d?.ok) {
        setRows(d.rows as ReconResultRow[]);
        setTotal(d.total);
      }
    } catch {
      setRows([]);
      setTotal(0);
    }
  }, [period, txnType, statusFilter, page]);

  useEffect(() => {
    void loadSummary();
  }, [loadSummary]);

  useEffect(() => {
    void loadResults();
  }, [loadResults]);

  const run = async () => {
    if (!/^\d{4}-\d{2}$/.test(period)) {
      setError("Period must be a month in YYYY-MM format.");
      return;
    }
    setError("");
    setRunActive(true);
    setBusy(true);
    try {
      const s = await api.reconRun(period, txnType);
      setSummary(s as RunSummary);
      setPage(1);
      await loadResults();
    } catch (e: any) {
      setError(friendlyError(e, "Reconciliation run failed. Is the period within a filed return?"));
    } finally {
      setBusy(false);
      setRunActive(false);
    }
  };

  const openReview = (row: ReconResultRow) => {
    setReviewFor(reviewFor === row.id ? null : row.id);
    setReviewStatus(row.reviewStatus || "ACCEPTED");
    setReviewNote(row.reviewNote || "");
  };

  const saveReview = async (row: ReconResultRow) => {
    if (!reviewStatus) return;
    setSavingReview(true);
    try {
      const d = await api.reconReview(row.id, reviewStatus, reviewNote.trim() || undefined);
      if (d?.ok) {
        setReviewFor(null);
        await Promise.all([loadSummary(), loadResults()]);
      }
    } catch (e: any) {
      setError(friendlyError(e, "Failed to save the review."));
    } finally {
      setSavingReview(false);
    }
  };

  const exportFile = async (format: "xlsx" | "csv") => {
    setError("");
    try {
      await api.reconExport(period, txnType, format);
    } catch (e: any) {
      setError(friendlyError(e, "Export failed."));
    }
  };

  const totals = [
    { title: "Tally Rows", value: summary?.totalTally ?? 0 },
    { title: "GST Rows", value: summary?.totalGst ?? 0 },
    { title: "Matched", value: summary?.matched ?? 0, accent: "text-green-600" },
    { title: "Possible", value: summary?.possibleMatch ?? 0, accent: "text-fuchsia-600" },
    { title: "Amount Mismatch", value: summary?.amountMismatch ?? 0, accent: "text-red-600" },
    { title: "Date Mismatch", value: summary?.dateMismatch ?? 0 },
    { title: "Missing in GST", value: summary?.missingInGst ?? 0, accent: "text-orange-600" },
    { title: "Missing in Tally", value: summary?.missingInTally ?? 0, accent: "text-orange-600" },
    { title: "Dup Tally / GST", value: (summary?.duplicateInTally ?? 0) + (summary?.duplicateInGst ?? 0) },
    { title: "Invalid", value: summary?.invalidData ?? 0 },
    { title: "B2B", value: summary?.b2b ?? 0, accent: "text-green-600" },
    { title: "B2C", value: summary?.b2c ?? 0, accent: "text-fuchsia-600" },
  ];

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">GST Reconciliation</h1>

      <Card className="p-6">
        <h2 className="font-medium mb-3">Run Reconciliation</h2>
        <div className="flex flex-wrap items-end gap-4">
          <label className="text-sm">
            <span className="block text-gray-500 mb-1">Period</span>
            <input
              type="month"
              aria-label="Period"
              value={period}
              onChange={(e) => setPeriod(e.target.value)}
              disabled={busy}
              className="px-3 py-2 border rounded text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100"
            />
          </label>
          <label className="text-sm">
            <span className="block text-gray-500 mb-1">Type</span>
            <select
              aria-label="Transaction Type"
              value={txnType}
              onChange={(e) => setTxnType(e.target.value as "SALES" | "PURCHASE")}
              disabled={busy}
              className="px-3 py-2 border rounded text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100"
            >
              <option value="SALES">Sales vs GSTR-1</option>
              <option value="PURCHASE">Purchases vs GSTR-2B</option>
            </select>
          </label>
          <div className="flex gap-2">
            <button
              onClick={() => void run()}
              disabled={busy || !canWrite}
              className="px-4 py-2 rounded bg-brand-600 text-white text-sm disabled:opacity-50"
            >
              {runActive ? "Running..." : "Run Reconciliation"}
            </button>
            <button
              onClick={() => void exportFile("xlsx")}
              disabled={busy || !summary?.success}
              className="px-3 py-2 rounded border border-gray-300 dark:border-gray-600 text-sm disabled:opacity-50"
            >
              Export XLSX
            </button>
            <button
              onClick={() => void exportFile("csv")}
              disabled={busy || !summary?.success}
              className="px-3 py-2 rounded border border-gray-300 dark:border-gray-600 text-sm disabled:opacity-50"
            >
              Export CSV
            </button>
          </div>
        </div>
        {!canWrite && (
          <div className="mt-3 text-red-600 text-sm">You do not have permission to run reconciliation.</div>
        )}
        {error && <div className="mt-3 text-red-600 text-sm">{error}</div>}
        {summary && (
          <div className="mt-4 text-sm text-gray-500">
            Latest run: <span className="font-medium">#{summary.runId}</span> · {summary.period} · {summary.transactionType}
            {summary.success ? " (completed)" : " (no run yet)"}
          </div>
        )}
      </Card>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {totals.map((t) => (
          <Stat key={t.title} title={t.title} value={t.value} accent={t.accent || "text-brand-600"} />
        ))}
      </div>

      <Card className="p-6">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
          <h2 className="font-medium">Results</h2>
<div className="flex flex-wrap items-center gap-2">
            <select
              aria-label="Status Filter"
              value={statusFilter}
              onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}
              className="px-3 py-2 border rounded text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100"
            >
              <option value="">All statuses</option>
              {["MATCHED", "AMOUNT_MISMATCH", "DATE_MISMATCH", "INVOICE_NUMBER_MISMATCH", "GSTIN_MISMATCH", "MISSING_IN_GST", "MISSING_IN_TALLY", "DUPLICATE_IN_TALLY", "DUPLICATE_IN_GST", "POSSIBLE_MATCH", "INVALID_DATA"].map((s) => (
                <option key={s} value={s}>{s.replace(/_/g, " ")}</option>
              ))}
            </select>
            <select
              aria-label="Type Filter"
              value={typeFilter}
              onChange={(e) => { setTypeFilter(e.target.value); setPage(1); }}
              className="px-3 py-2 border rounded text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100"
            >
              <option value="">All types</option>
              <option value="B2B">B2B</option>
              <option value="B2C">B2C</option>
            </select>
          </div>
        </div>

        <Table
          headers={["Type", "Status", "Invoice (Tally / GST)", "Dates", "GSTIN", "Taxable Diff", "Value Diff", "Conf", "Review"]}
          rows={(typeFilter ? rows.filter((r) => r.type === typeFilter) : rows).map((r) => [
            <div key={`t-${r.id}`} className="font-medium">{r.type}</div>,
            <StatusBadge key={`s-${r.id}`} status={r.status} />,
            <div key={`i-${r.id}`} className="space-y-0.5">
              <div className="font-medium">{r.tally?.invoiceNumber || "—"}</div>
              <div className="text-gray-500">{r.gst?.invoiceNumber || "—"}</div>
            </div>,
            <div key={`d-${r.id}`} className="space-y-0.5">
              <div>{r.tally?.voucherDate || "—"}</div>
              <div className="text-gray-500">{r.gst?.invoiceDate || "—"}</div>
            </div>,
            <div key={`g-${r.id}`} className="space-y-0.5 text-xs">
              <div>{r.tally?.partyGSTIN || "—"}</div>
              <div className="text-gray-500">{r.gst?.counterpartyGstin || "—"}</div>
            </div>,
            diffCell(r.taxableDifference),
            diffCell(r.invoiceValueDifference),
            <div key={`c-${r.id}`} className="text-center">
              <span className="font-medium">{r.confidence}</span>
              {r.matchLevel && <div className="text-[10px] text-gray-400">{r.matchLevel}</div>}
            </div>,
            <ReviewCell
              key={`r-${r.id}`}
              row={r}
              canWrite={canWrite}
              editing={reviewFor === r.id}
              reviewStatus={reviewStatus}
              reviewNote={reviewNote}
              saving={savingReview}
              onEdit={() => openReview(r)}
              onStatus={(v) => setReviewStatus(v)}
              onNote={(v) => setReviewNote(v)}
              onSave={() => void saveReview(r)}
            />,
          ])}
        />

        {rows.length > 0 && (
          <div className="mt-3 flex items-center justify-between text-sm">
            <span className="text-gray-500">{total} result(s)</span>
            <div className="flex gap-2">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
                className="px-3 py-1 rounded border border-gray-300 dark:border-gray-600 disabled:opacity-50"
              >
                Prev
              </button>
              <span className="px-2 py-1">Page {page}</span>
              <button
                onClick={() => setPage((p) => p + 1)}
                disabled={page * pageSize >= total}
                className="px-3 py-1 rounded border border-gray-300 dark:border-gray-600 disabled:opacity-50"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}

function ReviewCell({
  row, canWrite, editing, reviewStatus, reviewNote, saving, onEdit, onStatus, onNote, onSave,
}: {
  row: ReconResultRow;
  canWrite: boolean;
  editing: boolean;
  reviewStatus: string;
  reviewNote: string;
  saving: boolean;
  onEdit: () => void;
  onStatus: (v: string) => void;
  onNote: (v: string) => void;
  onSave: () => void;
}) {
  if (row.reviewStatus) {
    return (
      <div className="text-xs space-y-0.5">
        <Pill color="green">{row.reviewStatus}</Pill>
        {row.reviewNote && <div className="text-gray-500 max-w-[220px]">{row.reviewNote}</div>}
        <div className="text-gray-400">{row.reviewedBy || ""}</div>
      </div>
    );
  }
  if (!canWrite) return <span className="text-gray-400">—</span>;
  if (!editing) {
    return (
      <button onClick={onEdit} className="text-xs px-2 py-1 rounded border border-gray-300 dark:border-gray-600">
        Review
      </button>
    );
  }
  return (
    <div className="space-y-1.5 min-w-[200px]">
      <select
        aria-label="Review Status"
        value={reviewStatus}
        onChange={(e) => onStatus(e.target.value)}
        className="px-2 py-1 border rounded text-xs w-full dark:bg-gray-700 dark:border-gray-600"
      >
        <option value="ACCEPTED">Accept</option>
        <option value="REJECTED">Reject</option>
        <option value="REVIEWED">Reviewed</option>
      </select>
      <input
        aria-label="Review Note"
        value={reviewNote}
        onChange={(e) => onNote(e.target.value)}
        placeholder="Note (optional)"
        className="px-2 py-1 border rounded text-xs w-full dark:bg-gray-700 dark:border-gray-600"
      />
      <div className="flex gap-2">
        <button onClick={onSave} disabled={saving} className="px-2 py-1 rounded bg-brand-600 text-white text-xs disabled:opacity-50">
          {saving ? "Saving..." : "Save"}
        </button>
        <button onClick={onEdit} className="px-2 py-1 rounded border border-gray-300 dark:border-gray-600 text-xs">
          Cancel
        </button>
      </div>
    </div>
  );
}