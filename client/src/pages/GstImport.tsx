import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import { Card, Pill, Table } from "../components/ui";
import { useAuth } from "../hooks/useAuth";

// Upload GSTR-1 (sales) / GSTR-2B (purchase) exports (Excel/CSV/JSON), validate
// them against the normalization rules, and import the clean rows into the GST
// transaction store that feeds the reconciliation engine.

interface ImportSummary {
  success: boolean;
  batchId?: number;
  fileName: string;
  returnType: "GSTR1" | "GSTR2B";
  period: string;
  totalRows: number;
  valid: number;
  invalid: number;
  duplicates: number;
  imported: number;
  errors: string[];
}

interface BatchRow {
  id: number;
  returnType: string;
  fileName: string;
  period: string;
  totalRows: number;
  validRows: number;
  invalidRows: number;
  duplicateRows: number;
  importedRows: number;
  createdAt: string;
}

interface GstTransactionView {
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

function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function fmt(n: unknown): string {
  const x = Number(n ?? 0);
  if (Number.isNaN(x)) return "0";
  return x.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function friendlyError(e: any): string {
  const status = e?.response?.status;
  if (status === 401) return "Authentication failed. Please log in again.";
  if (status === 403) return "You do not have permission to import GST data.";
  const msg: string = e?.response?.data?.message || "";
  return msg || "Failed to process the GST file. Please check the file format and try again.";
}

export default function GstImport() {
  const { user } = useAuth();
  const canImport = user?.role === "ADMIN" || user?.role === "ACCOUNTANT";

  const [returnType, setReturnType] = useState<"GSTR1" | "GSTR2B">("GSTR1");
  const [period, setPeriod] = useState(currentMonth());
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState<"validate" | "import" | null>(null);
  const [result, setResult] = useState<ImportSummary | null>(null);
  const [error, setError] = useState("");
  const [batches, setBatches] = useState<BatchRow[]>([]);
  const [openBatch, setOpenBatch] = useState<number | null>(null);
  const [batchDetail, setBatchDetail] = useState<GstTransactionView[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      const d = await api.gstImports();
      if (d?.ok) setBatches(d.batches as BatchRow[]);
    } catch {
      // History is auxiliary; keep the last known list.
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const reset = () => {
    setError("");
    setResult(null);
  };

  const run = async (mode: "validate" | "import") => {
    if (!file) {
      setError("Please choose a GST export file first.");
      return;
    }
    if (!/^\d{4}-\d{2}$/.test(period)) {
      setError("Period must be a month in YYYY-MM format.");
      return;
    }
    reset();
    setBusy(mode);
    try {
      const summary = mode === "validate"
        ? await api.gstValidate(returnType, period, file)
        : await api.gstImport(returnType, period, file);
      setResult(summary as ImportSummary);
      if (mode === "import") await refresh();
    } catch (e: any) {
      setError(friendlyError(e));
    } finally {
      setBusy(null);
    }
  };

  const toggleBatch = async (id: number) => {
    if (openBatch === id) {
      setOpenBatch(null);
      setBatchDetail([]);
      return;
    }
    setOpenBatch(id);
    setBatchDetail([]);
    try {
      const d = await api.gstImportDetail(id);
      if (d?.ok) setBatchDetail(d.batch.transactions as GstTransactionView[]);
    } catch {
      setBatchDetail([]);
    }
  };

  const label = returnType === "GSTR1" ? "GSTR-1 (Sales)" : "GSTR-2B (Purchases)";

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">GST Import</h1>

      <Card className="p-6">
        <h2 className="font-medium mb-3">Import GST Return</h2>
        <div className="flex flex-wrap items-end gap-4">
          <label className="text-sm">
            <span className="block text-gray-500 mb-1">Return Type</span>
            <select
              aria-label="Return Type"
              value={returnType}
              onChange={(e) => setReturnType(e.target.value as "GSTR1" | "GSTR2B")}
              disabled={busy !== null}
              className="px-3 py-2 border rounded text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100"
            >
              <option value="GSTR1">GSTR-1 (Sales)</option>
              <option value="GSTR2B">GSTR-2B (Purchases)</option>
            </select>
          </label>
          <label className="text-sm">
            <span className="block text-gray-500 mb-1">Period</span>
            <input
              type="month"
              aria-label="Period"
              value={period}
              onChange={(e) => setPeriod(e.target.value)}
              disabled={busy !== null}
              className="px-3 py-2 border rounded text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100"
            />
          </label>
          <label className="text-sm">
            <span className="block text-gray-500 mb-1">File (.xlsx, .csv, .json)</span>
            <input
              ref={fileRef}
              type="file"
              accept=".xlsx,.csv,.json"
              aria-label="GST file"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              disabled={busy !== null}
              className="text-sm"
            />
          </label>
          <div className="flex gap-2">
            <button
              onClick={() => void run("validate")}
              disabled={busy !== null || !canImport}
              className="px-4 py-2 rounded border border-brand-600 text-brand-600 text-sm disabled:opacity-50"
            >
              {busy === "validate" ? "Validating..." : "Validate File"}
            </button>
            <button
              onClick={() => void run("import")}
              disabled={busy !== null || !canImport}
              className="px-4 py-2 rounded bg-brand-600 text-white text-sm disabled:opacity-50"
            >
              {busy === "import" ? "Importing..." : "Import"}
            </button>
          </div>
        </div>

        {!canImport && (
          <div className="mt-3 text-red-600 text-sm">You do not have permission to import GST data.</div>
        )}
        {error && <div className="mt-3 text-red-600 text-sm">{error}</div>}

        {result && (
          <div className="mt-5">
            <div className="flex items-center gap-2">
              <span className="font-medium">{label} · {result.period}</span>
              {result.batchId && <Pill color="green">Batch #{result.batchId}</Pill>}
            </div>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mt-3">
              <MiniStat title="Total Rows" value={result.totalRows} />
              <MiniStat title="Valid" value={result.valid} />
              <MiniStat title="Invalid" value={result.invalid} />
              <MiniStat title="Duplicates" value={result.duplicates} />
              <MiniStat title="Imported" value={result.imported} accent="text-brand-600" />
            </div>
            {result.imported > 0 && (
              <div className="mt-3 text-sm text-green-600">
                {result.imported} row(s) imported into the GST transaction store.
              </div>
            )}
            {result.imported === 0 && result.totalRows > 0 && (
              <div className="mt-3 text-sm text-amber-600">
                Nothing new imported — all rows were duplicates or invalid.
              </div>
            )}
            {result.errors.length > 0 && (
              <ul className="mt-3 text-sm text-amber-700 dark:text-amber-300 list-disc pl-5 space-y-0.5">
                {result.errors.slice(0, 20).map((e, i) => <li key={i}>{e}</li>)}
              </ul>
            )}
          </div>
        )}
      </Card>

      <Card className="p-6">
        <h2 className="font-medium mb-3">Import History</h2>
        {batches.length === 0 ? (
          <div className="text-sm text-gray-500">No GST imports yet.</div>
        ) : (
          <div className="space-y-2">
            {batches.map((b) => (
              <div key={b.id} className="rounded-lg border border-gray-200 dark:border-gray-700">
                <button
                  onClick={() => void toggleBatch(b.id)}
                  className="w-full text-left px-4 py-3 flex flex-wrap items-center gap-3 text-sm hover:bg-gray-50 dark:hover:bg-gray-700/50"
                >
                  <span className="font-medium">{b.returnType} · {b.period}</span>
                  <span className="text-gray-500 truncate flex-1">{b.fileName}</span>
                  <span>Imported <b>{b.importedRows}</b></span>
                  <span>Valid <b>{b.validRows}</b></span>
                  <span>Invalid <b>{b.invalidRows}</b></span>
                  <span>Duplicates <b>{b.duplicateRows}</b></span>
                  <span className="text-gray-400">{new Date(b.createdAt).toLocaleString()}</span>
                </button>
                {openBatch === b.id && (
                  <div className="px-4 pb-4">
                    <Table
                      headers={["Invoice", "Date", "Party GSTIN", "Party", "Taxable", "CGST", "SGST", "IGST", "Value"]}
                      rows={batchDetail.map((t) => [
                        t.invoiceNumber,
                        t.invoiceDate,
                        t.counterpartyGstin || "—",
                        t.counterpartyName || "—",
                        fmt(t.taxableValue),
                        fmt(t.cgst),
                        fmt(t.sgst),
                        fmt(t.igst),
                        fmt(t.invoiceValue),
                      ])}
                    />
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

function MiniStat({ title, value, accent = "" }: { title: string; value: React.ReactNode; accent?: string }) {
  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 p-3 text-center">
      <div className={`text-xl font-semibold ${accent}`}>{value}</div>
      <div className="text-xs text-gray-500 mt-0.5">{title}</div>
    </div>
  );
}