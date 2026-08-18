import { useCallback, useEffect, useState } from "react";
import { api } from "../api/client";
import { Card, Stat, Table } from "../components/ui";
import { useAuth } from "../hooks/useAuth";

// TallyPrime connector. The browser talks ONLY to our API. How the backend
// reaches the user's localhost:9000 TallyPrime is chosen server-side:
//   direct  - the Express server runs on the same PC as TallyPrime (local dev),
//   bridge  - a Windows "Tally Bridge" agent on the PC dials out to the hosted
//             app over a secure WebSocket (production / Render).
// The `mode` field in /api/tally responses drives which instructions are shown.

interface CompanyInfo {
  connected: boolean;
  companyName?: string;
  gstin?: string | null;
  message?: string;
  mode?: "direct" | "bridge";
}

interface ImportTotals {
  count: number;
  taxableValue: number;
  cgst: number;
  sgst: number;
  igst: number;
  roundOff: number;
  totalAmount: number;
}

interface ImportResult {
  ok: boolean;
  voucherType: string;
  imported: number;
  skipped: number;
  failed: number;
  totals?: ImportTotals;
  connected?: boolean;
  message?: string;
}

interface SummaryRow {
  imported: number;
  skipped: number;
  failed: number;
  count: number;
}

interface ImportSummary {
  total: number;
  byVoucherType: { Sales: number; Purchase: number };
  last: { Sales: SummaryRow; Purchase: SummaryRow };
}

interface ImportedRow {
  id: number;
  voucherType: string;
  voucherNumber: string;
  voucherDate: string;
  partyName: string | null;
  invoiceNumber: string | null;
  taxableValue: number;
  totalAmount: number;
}

const TALLY_URL = "http://localhost:9000";

const IMPORT_STEPS: Record<"sales" | "purchases", string[]> = {
  sales: ["Connecting to Tally...", "Fetching Sales...", "Processing vouchers...", "Saving data..."],
  purchases: ["Connecting to Tally...", "Fetching Purchase...", "Processing vouchers...", "Saving data..."],
};

// Shown when the backend is in bridge mode and no bridge agent is connected.
const BRIDGE_STEPS = [
  "Open TallyPrime on this PC and enable the Tally XML/HTTP server on port 9000 (Advanced Configuration).",
  "Start the Tally Bridge on this PC: double-click start-bridge.bat (or run TallyBridge.exe).",
  "The bridge stays connected in the background; press Connect here again.",
];

function currentFinancialYear(): { from: string; to: string } {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  return m >= 4
    ? { from: `${y}-04-01`, to: `${y + 1}-03-31` }
    : { from: `${y - 1}-04-01`, to: `${y}-03-31` };
}

function fmt(n: unknown) {
  const x = Number(n ?? 0);
  if (Number.isNaN(x)) return "0";
  return x.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Map transport/HTTP failures to short, user-friendly messages. Never show raw
// stack traces to the user.
function friendlyError(e: any): string {
  const status = e?.response?.status;
  if (status === 401) return "Authentication failed. Please log in again.";
  if (status === 403) return "You do not have permission to import Tally data.";
  if (status && status >= 500) return "Database error while saving Tally data. Please try again.";
  const msg: string = e?.response?.data?.message || "";
  if (msg && msg.toLowerCase().includes("date")) return msg;
  if (msg) return msg;
  return NOT_CONNECTED_MSG;
}

const NOT_CONNECTED_MSG = "TallyPrime is not running or Tally XML/HTTP server is not enabled.";

export default function TallyIntegration() {
  const { user } = useAuth();
  const canImport = user?.role === "ADMIN" || user?.role === "ACCOUNTANT";

  const fy = currentFinancialYear();
  const [fromDate, setFromDate] = useState(fy.from);
  const [toDate, setToDate] = useState(fy.to);
  const [dateError, setDateError] = useState("");

  const [status, setStatus] = useState<"idle" | "checking" | "connected" | "disconnected">("idle");
  const [mode, setMode] = useState<"direct" | "bridge">("direct");
  const [company, setCompany] = useState<CompanyInfo | null>(null);
  const [statusMsg, setStatusMsg] = useState("");

  const [busy, setBusy] = useState<"connect" | "test" | "sales" | "purchases" | null>(null);
  const [progressStep, setProgressStep] = useState(0);
  const [importResult, setImportResult] = useState<{ type: "sales" | "purchases"; data: ImportResult } | null>(null);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [recent, setRecent] = useState<ImportedRow[]>([]);
  const [error, setError] = useState("");

  const refreshSummary = useCallback(async () => {
    try {
      const s = await api.tallyImportSummary();
      if (s?.ok) setSummary(s);
    } catch {
      // Keep the last known summary; a fresh DB is not an error.
    }
    try {
      const r = await api.tallyImports();
      if (r?.ok) setRecent(r.rows as ImportedRow[]);
    } catch {
      // Ignore — recent list is auxiliary.
    }
  }, []);

  useEffect(() => {
    void refreshSummary();
  }, [refreshSummary]);

  const connect = async () => {
    setBusy("connect");
    setError("");
    setStatus("checking");
    try {
      const c: CompanyInfo = await api.tallyCompany();
      setCompany(c);
      setMode(c.mode === "bridge" ? "bridge" : "direct");
      if (c.connected) {
        setStatus("connected");
        setStatusMsg(c.message || "TallyPrime is running");
      } else {
        setStatus("disconnected");
        setStatusMsg(c.message || NOT_CONNECTED_MSG);
      }
    } catch {
      setCompany(null);
      setStatus("disconnected");
      setStatusMsg(NOT_CONNECTED_MSG);
    } finally {
      setBusy(null);
    }
  };

  const testConnection = async () => {
    setBusy("test");
    setError("");
    try {
      const d = await api.tallyStatus();
      setMode(d.mode === "bridge" ? "bridge" : "direct");
      if (d.connected) {
        setStatus("connected");
        setStatusMsg(d.message || "TallyPrime is running");
      } else {
        setStatus("disconnected");
        setStatusMsg(d.message || NOT_CONNECTED_MSG);
      }
    } catch {
      setStatus("disconnected");
      setStatusMsg(NOT_CONNECTED_MSG);
    } finally {
      setBusy(null);
    }
  };

  const runImport = async (type: "sales" | "purchases") => {
    if (!fromDate || !toDate) {
      setDateError("Please select From and To dates.");
      return;
    }
    if (fromDate > toDate) {
      setDateError("From Date must be on or before To Date.");
      return;
    }
    setDateError("");
    setError("");
    setImportResult(null);
    setBusy(type);
    setProgressStep(0);
    const steps = IMPORT_STEPS[type];
    const timer = setInterval(
      () => setProgressStep((s) => Math.min(s + 1, steps.length - 1)),
      700,
    );
    try {
      const res: ImportResult = await api.tallyImport(type, fromDate, toDate);
      if (!res.ok) {
        if (res.connected === false) {
          setError(NOT_CONNECTED_MSG);
          setStatus("disconnected");
          setStatusMsg(NOT_CONNECTED_MSG);
        } else {
          setError(res.message || NOT_CONNECTED_MSG);
        }
      } else {
        setImportResult({ type, data: res });
        setStatus("connected");
        setStatusMsg(type === "sales" ? "Sales imported successfully" : "Purchase import completed");
      }
      await refreshSummary();
    } catch (e: any) {
      const msg = friendlyError(e);
      if (msg.toLowerCase().includes("date")) setDateError(msg);
      else setError(msg);
    } finally {
      clearInterval(timer);
      setBusy(null);
    }
  };

  const result = importResult?.data;

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Tally Integration</h1>

      {/* Phase 1: connection card */}
      <Card className="p-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-2xl">●</span>
              <span className="font-medium">
                {status === "connected" ? "Connected" : status === "checking" ? "Checking..." : "Not Connected"}
              </span>
            </div>
            <div className="text-sm text-gray-500 mt-1">{statusMsg || "TallyPrime not detected yet"}</div>
          </div>
          <button
            onClick={connect}
            disabled={busy !== null}
            className="px-4 py-2 rounded bg-brand-600 text-white disabled:opacity-50"
          >
            {busy === "connect" ? "Connecting..." : "Connect Tally"}
          </button>
        </div>

        {status === "connected" && company?.companyName && (
          <div className="mt-4 grid sm:grid-cols-3 gap-4 text-sm">
            <div>
              <div className="text-gray-500">Company</div>
              <div className="font-medium">{company.companyName}</div>
            </div>
            <div>
              <div className="text-gray-500">Connection Mode</div>
              <div className="font-medium">{mode === "bridge" ? "Tally Bridge" : "Direct (local)"}</div>
            </div>
            <div>
              <div className="text-gray-500">Tally URL</div>
              <div className="font-mono text-xs">{TALLY_URL}</div>
            </div>
          </div>
        )}

        <div className="mt-5 flex flex-wrap gap-2">
          <button
            onClick={testConnection}
            disabled={busy !== null}
            className="px-3 py-2 rounded border border-gray-300 dark:border-gray-600 text-sm disabled:opacity-50"
          >
            {busy === "test" ? "Testing..." : "Test Connection"}
          </button>
        </div>
      </Card>

      {!canImport && (
        <div className="text-red-600 text-sm">You do not have permission to import Tally data.</div>
      )}

      {/* Phase 3: date range */}
      <Card className="p-6">
        <h2 className="font-medium mb-3">Import Tally Data</h2>
        <div className="flex flex-wrap items-end gap-4">
          <label className="text-sm">
            <span className="block text-gray-500 mb-1">From Date</span>
            <input
              type="date"
              aria-label="From Date"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
              disabled={busy !== null}
              className="px-3 py-2 border rounded text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100"
            />
          </label>
          <label className="text-sm">
            <span className="block text-gray-500 mb-1">To Date</span>
            <input
              type="date"
              aria-label="To Date"
              value={toDate}
              onChange={(e) => setToDate(e.target.value)}
              disabled={busy !== null}
              className="px-3 py-2 border rounded text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100"
            />
          </label>
          <div className="flex gap-2">
            <button
              onClick={() => void runImport("sales")}
              disabled={busy !== null || !canImport}
              className="px-4 py-2 rounded bg-brand-600 text-white text-sm disabled:opacity-50"
            >
              {busy === "sales" ? "Importing..." : "Import Sales"}
            </button>
            <button
              onClick={() => void runImport("purchases")}
              disabled={busy !== null || !canImport}
              className="px-4 py-2 rounded bg-gray-200 dark:bg-gray-700 text-sm disabled:opacity-50"
            >
              {busy === "purchases" ? "Importing..." : "Import Purchase"}
            </button>
          </div>
        </div>
        {dateError && <div className="mt-3 text-red-600 text-sm">{dateError}</div>}
        {error && <div className="mt-3 text-red-600 text-sm">{error}</div>}

        {/* Phase 4: import progress */}
        {busy && (
          <div className="mt-4 text-sm text-gray-500 space-y-1">
            {IMPORT_STEPS[busy === "connect" ? "sales" : busy === "test" ? "sales" : busy].map((step, i) => (
              <div key={step} className={i <= progressStep ? "text-brand-600 font-medium" : ""}>
                {i < progressStep ? "✓ " : i === progressStep ? "… " : "· "}
                {step}
              </div>
            ))}
          </div>
        )}

        {/* Phase 4/5: import result */}
        {result && result.ok && result.totals && result.totals.count > 0 && (
          <div className="mt-5">
            <div className="font-medium text-brand-600">{result.voucherType} Imported</div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-2">
              <Stat title="Vouchers" value={result.imported} />
              <Stat title="Total Taxable" value={`₹${fmt(result.totals.taxableValue)}`} />
              <Stat title="CGST" value={`₹${fmt(result.totals.cgst)}`} />
              <Stat title="SGST" value={`₹${fmt(result.totals.sgst)}`} />
              <Stat title="IGST" value={`₹${fmt(result.totals.igst)}`} />
              <Stat title="Round Off" value={`₹${fmt(result.totals.roundOff)}`} />
              <Stat title="Total Invoice Value" value={`₹${fmt(result.totals.totalAmount)}`} />
            </div>
            {result.skipped > 0 && (
              <div className="mt-2 text-sm text-amber-600">
                {result.skipped} duplicate voucher(s) already present, skipped.
              </div>
            )}
          </div>
        )}

        {/* Phase 5: empty is not an error */}
        {result && result.ok && result.totals && result.totals.count === 0 && (
          <div className="mt-5 text-sm text-gray-500">
            {result.voucherType === "Purchase"
              ? "No Purchase vouchers found for the selected period."
              : result.skipped > 0
                ? `${result.skipped} duplicate Sales voucher(s) already present; nothing new imported.`
                : "No Sales vouchers found for the selected period."}
          </div>
        )}
      </Card>

      {/* Phase 7: import summary */}
      <Card className="p-6">
        <h2 className="font-medium mb-3">Tally Import Summary</h2>
        <div className="grid sm:grid-cols-2 gap-4">
          <SummaryColumn title="Sales" row={summary?.last.Sales} dbCount={summary?.byVoucherType.Sales ?? 0} />
          <SummaryColumn title="Purchases" row={summary?.last.Purchase} dbCount={summary?.byVoucherType.Purchase ?? 0} />
        </div>
        <div className="mt-4 text-sm text-gray-500">
          <span>Total records in database: {summary?.total ?? 0}</span>
        </div>
      </Card>

      {/* Recent imports */}
      {recent.length > 0 && (
        <Card className="p-4">
          <h2 className="font-medium mb-3">Recent Imports</h2>
          <Table
            headers={["Voucher", "Type", "Date", "Party", "Invoice", "Taxable", "Total"]}
            rows={recent.map((r) => [
              r.voucherNumber,
              r.voucherType,
              r.voucherDate,
              r.partyName || "—",
              r.invoiceNumber || "—",
              `₹${fmt(r.taxableValue)}`,
              `₹${fmt(r.totalAmount)}`,
            ])}
          />
        </Card>
      )}
    </div>
  );
}

function SummaryColumn({ title, row, dbCount }: { title: string; row?: SummaryRow; dbCount: number }) {
  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 p-4 text-sm">
      <div className="font-medium mb-2">{title}</div>
      <div className="space-y-1 text-gray-600 dark:text-gray-300">
        <div>Imported: <span className="font-medium">{row?.imported ?? 0}</span></div>
        <div>Skipped/Duplicate: <span className="font-medium">{row?.skipped ?? 0}</span></div>
        <div>Failed: <span className="font-medium">{row?.failed ?? 0}</span></div>
        <div>In database: <span className="font-medium">{dbCount}</span></div>
      </div>
    </div>
  );
}
