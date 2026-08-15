import { useDashboard, Vendor, Mismatch } from "../hooks/useDashboard";
import { Card, Stat, Table, Pill, StatusBadge } from "../components/ui";
import { api } from "../api/client";
import {
  BarChart, Bar, XAxis, YAxis, ResponsiveContainer, Tooltip, CartesianGrid, Legend,
  PieChart, Pie, Cell, LineChart, Line,
} from "recharts";
import { useState } from "react";
import { Link } from "react-router-dom";
import { Play, FileText, Download, AlertTriangle, CheckCircle2, XCircle } from "lucide-react";

const STATUS_COLOR: Record<string, string> = {
  MATCHED: "#16a34a", MISMATCHED: "#dc2626", MISSING_IN_2B: "#f97316",
  MISSING_IN_BOOKS: "#eab308", DUPLICATE: "#7c3aed",
};

export default function Dashboard() {
  const { summary, vendors, recent, loading, runId, reload } = useDashboard();
  const [running, setRunning] = useState(false);
  const [aiSummary, setAiSummary] = useState("");
  const [filter, setFilter] = useState<null | string>(null);

  if (loading) return <div className="text-gray-500">Loading dashboard…</div>;

  const runRecon = async () => {
    setRunning(true);
    try {
      const r = await api.reconcile();
      setAiSummary(r.aiSummary || "");
      await reload();
    } catch (e: any) {
      alert(e?.response?.data?.message || "Reconcile failed");
    } finally { setRunning(false); }
  };

  const filteredRecent = filter ? recent.filter((m) => m.status === filter) : recent;

  // Status pie data
  const pieData = [
    { name: "Matched", value: summary?.matched ?? 0 },
    { name: "Mismatched", value: summary?.mismatched ?? 0 },
    { name: "Missing in 2B", value: summary?.missingIn2B ?? 0 },
    { name: "Missing in Books", value: summary?.missingInBooks ?? 0 },
    { name: "Duplicate", value: summary?.duplicates ?? 0 },
  ].filter((d) => d.value > 0);

  const vendorChart = vendors.slice(0, 8).map((v: Vendor) => ({
    name: v.vendorName?.split(" ")[0] || v.gstin.slice(0, 6),
    matched: v.matched, mismatch: v.mismatch, missing: v.missing,
  }));

  // ITC chart
  const itcData = [
    { name: "Eligible", value: summary?.itcEligible ?? 0 },
    { name: "Pending", value: summary?.itcPending ?? 0 },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-2xl font-semibold">Reconciliation Dashboard</h1>
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500">Run #{runId}</span>
          <Link to="/reports" className="px-3 py-2 rounded bg-gray-200 dark:bg-gray-700 text-sm flex items-center gap-1">
            <FileText size={14} /> Reports
          </Link>
          <button onClick={runRecon} disabled={running}
            className="bg-brand-600 text-white px-4 py-2 rounded text-sm flex items-center gap-1 disabled:opacity-50">
            <Play size={14} /> {running ? "Reconciling…" : "Run Reconciliation"}
          </button>
        </div>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <Stat title="Total Purchase" value={`₹ ${inr(summary?.totalPurchase)}`} accent="text-blue-600" />
        <Stat title="Book Invoices" value={summary?.bookInvoices ?? 0} accent="text-blue-600" />
        <Stat title="2B Invoices" value={summary?.twoBInvoices ?? 0} accent="text-indigo-600" />
        <Stat title="Vendors" value={summary?.vendors ?? 0} accent="text-cyan-600" />
        <Stat title="GST Difference" value={`₹ ${inr(summary?.gstDifference)}`} accent="text-purple-600" />
        <Stat title="Taxable Difference" value={`₹ ${inr(summary?.taxableDifference)}`} accent="text-fuchsia-600" />
      </div>

      {/* Highlight cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-5 gap-3">
        <HighlightCard icon={<AlertTriangle size={16}/>} label="Missing in 2B"  value={summary?.missingIn2B ?? 0} color="text-orange-600" onClick={() => setFilter(f => f === "MISSING_IN_2B" ? null : "MISSING_IN_2B")} active={filter === "MISSING_IN_2B"} />
        <HighlightCard icon={<AlertTriangle size={16}/>} label="Missing in Books" value={summary?.missingInBooks ?? 0} color="text-amber-600" onClick={() => setFilter(f => f === "MISSING_IN_BOOKS" ? null : "MISSING_IN_BOOKS")} active={filter === "MISSING_IN_BOOKS"} />
        <HighlightCard icon={<XCircle size={16}/>} label="GST Difference"   value={`₹ ${inr(summary?.gstDifference)}`} color="text-purple-600" />
        <HighlightCard icon={<XCircle size={16}/>} label="Inv-No Difference" value={recent.filter((m:any) => m.invoiceNoDiff).length}  color="text-rose-600" />
        <HighlightCard icon={<XCircle size={16}/>} label="Date Difference"  value={recent.filter((m:any) => m.dateDiff).length}        color="text-red-600" />
      </div>

      {/* Match%, ITC eligible/pending */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <Card className="p-5">
          <div className="text-sm text-gray-500">Match %</div>
          <div className="text-3xl font-semibold mt-1 text-green-600">{summary?.matchPercent ?? 0}%</div>
          <div className="text-xs text-gray-500 mt-1">{summary?.matched ?? 0} matched of {((summary?.matched ?? 0) + (summary?.mismatched ?? 0) + (summary?.missingIn2B ?? 0) + (summary?.duplicates ?? 0))} Booking pairs</div>
        </Card>
        <Card className="p-5">
          <div className="text-sm text-gray-500">ITC Eligible</div>
          <div className="text-3xl font-semibold mt-1 text-green-600">₹ {inr(summary?.itcEligible)}</div>
          <div className="text-xs text-gray-500 mt-1">Claimable in GSTR-3B</div>
        </Card>
        <Card className="p-5">
          <div className="text-sm text-gray-500">ITC Pending</div>
          <div className="text-3xl font-semibold mt-1 text-orange-600">₹ {inr(summary?.itcPending)}</div>
          <div className="text-xs text-gray-500 mt-1">Awaiting supplier filing</div>
        </Card>
      </div>

      {aiSummary && (
        <Card className="p-5 border-l-4 border-brand-600">
          <div className="text-sm text-gray-500 mb-1 flex items-center gap-2"><CheckCircle2 size={14} className="text-brand-600"/> AI Summary</div>
          <div className="text-sm whitespace-pre-line">{aiSummary}</div>
        </Card>
      )}

      {/* Charts */}
      <div className="grid lg:grid-cols-3 gap-6">
        <Card className="p-5 lg:col-span-2">
          <div className="font-medium mb-3">Vendor-wise Reconciliation</div>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={vendorChart}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="name" />
              <YAxis />
              <Tooltip />
              <Legend />
              <Bar dataKey="matched" stackId="a" fill="#16a34a" name="Matched" />
              <Bar dataKey="mismatch" stackId="a" fill="#dc2626" name="Mismatched" />
              <Bar dataKey="missing" stackId="a" fill="#f97316" name="Missing" />
            </BarChart>
          </ResponsiveContainer>
        </Card>
        <Card className="p-5">
          <div className="font-medium mb-3">Status Breakdown</div>
          <ResponsiveContainer width="100%" height={300}>
            <PieChart>
              <Pie data={pieData} dataKey="value" outerRadius={100} label>
                {pieData.map((entry, i) => (
                  <Cell key={i} fill={STATUS_COLOR[entry.name === "Matched" ? "MATCHED" : entry.name === "Mismatched" ? "MISMATCHED" : entry.name === "Missing in 2B" ? "MISSING_IN_2B" : entry.name === "Missing in Books" ? "MISSING_IN_BOOKS" : "DUPLICATE"]} />
                ))}
              </Pie>
              <Tooltip />
              <Legend />
            </PieChart>
          </ResponsiveContainer>
        </Card>
      </div>

      <Card className="p-5">
        <div className="font-medium mb-3">ITC Eligible vs Pending</div>
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={itcData} layout="vertical">
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis type="number" />
            <YAxis type="category" dataKey="name" width={80} />
            <Tooltip formatter={(v: any) => `₹ ${inr(v)}`} />
            <Bar dataKey="value" fill="#16a34a" />
          </BarChart>
        </ResponsiveContainer>
      </Card>

      {/* Recent mismatches */}
      <Card className="p-5">
        <div className="flex items-center justify-between mb-3">
          <div className="font-medium flex items-center gap-2">
            <AlertTriangle size={16} className="text-amber-600" /> Recent Mismatches
            {filter && <Pill>{filter} <button onClick={() => setFilter(null)} className="ml-1">×</button></Pill>}
          </div>
          <Link to="/invoices" className="text-sm text-brand-600">View all invoices →</Link>
        </div>
        <div className="space-y-2 max-h-96 overflow-auto">
          {filteredRecent.length === 0 && <div className="text-sm text-gray-500">No mismatches.</div>}
          {filteredRecent.map((m: Mismatch, i: number) => (
            <div key={i} className="border border-gray-100 dark:border-gray-700 rounded p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{m.bookInvoiceNo || m.twoBInvoiceNo}</span>
                <StatusBadge status={m.status} />
                <span className="text-xs text-gray-500">{m.vendorName || "—"} · {m.bookGstin || m.twoBGstin}</span>
                <span className="text-[10px] text-gray-400 ml-auto">Confidence {m.confidence}%</span>
              </div>
              <div className="flex flex-wrap gap-1 mt-2">
                {(Array.isArray(m.mismatchTypes) ? m.mismatchTypes : String(m.mismatchTypes ?? "").split(",").filter(Boolean)).map((t, j) => (
                  <Pill key={j}>{t.replace(/_/g, " ")}</Pill>
                ))}
                {m.gstDiff != null && Math.abs(m.gstDiff) > 0.01 && <Pill color="purple">GST diff ₹ {inr(m.gstDiff)}</Pill>}
                {m.taxableDiff != null && Math.abs(m.taxableDiff) > 0.01 && <Pill color="fuchsia">Taxable diff ₹ {inr(m.taxableDiff)}</Pill>}
                {m.dateDiff && <Pill color="red">Date: {m.dateDiff}</Pill>}
                {m.invoiceNoDiff && <Pill color="rose">Inv-No diff</Pill>}
              </div>
              {m.aiWhat && <div className="mt-1 text-xs"><span className="text-red-600">Issue:</span> {m.aiWhat}</div>}
              {m.aiAction && <div className="text-xs"><span className="text-green-600">Action:</span> {m.aiAction}</div>}
              <div className="text-xs mt-1 text-gray-500">ITC Eligible ₹ {inr(m.itcEligible)} · Pending ₹ {inr(m.itcPending)}</div>
            </div>
          ))}
        </div>
      </Card>

      {/* Vendor table */}
      <Card className="p-5">
        <div className="font-medium mb-3">Vendor Summary</div>
        <Table
          headers={["Vendor", "GSTIN", "Matched", "Mismatch", "Missing", "Duplicates", "Total GST", "ITC Eligible", "ITC Pending"]}
          rows={vendors.map((v: Vendor) => [
            v.vendorName, v.gstin, v.matched, v.mismatch, v.missing, v.duplicates,
            `₹ ${inr(v.totalGst)}`, `₹ ${inr(v.itcEligible)}`, `₹ ${inr(v.itcPending)}`,
          ])}
        />
      </Card>
    </div>
  );
}

function HighlightCard({ icon, label, value, color, onClick, active }: { icon: React.ReactNode; label: string; value: React.ReactNode; color: string; onClick?: () => void; active?: boolean; }) {
  return (
    <button onClick={onClick}
      className={`flex items-center gap-3 p-4 rounded-xl border text-left transition-colors
      ${active ? "border-brand-600 bg-brand-50 dark:bg-gray-700" : "border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 hover:border-gray-300"}`}>
      <div className={`${color}`}>{icon}</div>
      <div>
        <div className="text-xs text-gray-500">{label}</div>
        <div className={`text-xl font-semibold ${color}`}>{value}</div>
      </div>
    </button>
  );
}

function inr(n: unknown) {
  const x = Number(n ?? 0);
  if (Number.isNaN(x)) return "0";
  return x.toLocaleString("en-IN", { maximumFractionDigits: 2 });
}
