import { useState } from "react";
import { useInvoices } from "../hooks/useDashboard";
import { Card, Table, StatusBadge, Pill, TextInput, Select } from "../components/ui";
import { Link } from "react-router-dom";

const STATUS_OPTS = [
  { value: "", label: "All statuses" },
  { value: "MATCHED", label: "Matched" },
  { value: "MISMATCHED", label: "Mismatched" },
  { value: "MISSING_IN_2B", label: "Missing in 2B" },
  { value: "MISSING_IN_BOOKS", label: "Missing in Books" },
  { value: "DUPLICATE", label: "Duplicate" },
];
const MISMATCH_OPTS = [
  { value: "", label: "Any mismatch" },
  { value: "WRONG_GSTIN", label: "Wrong GSTIN" },
  { value: "WRONG_DATE", label: "Date difference" },
  { value: "WRONG_TAXABLE", label: "Taxable difference" },
  { value: "WRONG_TAX", label: "GST difference" },
  { value: "WRONG_INVOICE_NO", label: "Invoice no difference" },
  { value: "DUPLICATE", label: "Duplicate" },
];

export default function Invoices() {
  const [status, setStatus] = useState("");
  const [vendor, setVendor] = useState("");
  const [gstin, setGstin] = useState("");
  const [mismatch, setMismatch] = useState("");
  const [page, setPage] = useState(1);
  const pageSize = 25;

  const { rows, total, loading } = useInvoices({ status, vendor, gstin, mismatch, page, pageSize });
  const pages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Reconciled Invoices</h1>
        <Link to="/reports" className="text-sm text-brand-600">Download report →</Link>
      </div>

      <Card className="p-4">
        <div className="flex flex-wrap gap-2 items-end">
          <TextInput value={vendor} onChange={(v) => { setVendor(v); setPage(1); }} placeholder="Vendor name" />
          <TextInput value={gstin}  onChange={(v) => { setGstin(v);  setPage(1); }} placeholder="GSTIN" />
          <Select value={status} onChange={(v) => { setStatus(v); setPage(1); }} options={STATUS_OPTS} />
          <Select value={mismatch} onChange={(v) => { setMismatch(v); setPage(1); }} options={MISMATCH_OPTS} />
          <button onClick={() => { setStatus(""); setVendor(""); setGstin(""); setMismatch(""); setPage(1); }}
            className="px-3 py-2 text-sm rounded bg-gray-100 dark:bg-gray-700">Clear</button>
          <div className="ml-auto text-sm text-gray-500">{total} rows · page {page}/{pages}</div>
        </div>
      </Card>

      <Card className="p-3">
        {loading ? <div className="p-8 text-gray-500 text-sm">Loading…</div> :
        <Table
          headers={["Status", "Vendor", "Books Inv", "2B Inv", "Books GSTIN", "2B GSTIN", "Books Date", "2B Date", "Taxable Diff", "GST Diff", "ITC", "Conf"]}
          rows={rows.map((r) => [
            <StatusBadge status={r.status} />,
            r.vendorName || "—",
            r.bookInvoiceNo || "—",
            r.twoBInvoiceNo || "—",
            r.bookGstin || "",
            r.twoBGstin || "",
            r.bookDate || "—",
            r.twoBDate || "—",
            <Pill color={Math.abs(r.taxableDiff) > 0.01 ? "fuchsia" : "gray"}>₹ {fmt(r.taxableDiff)}</Pill>,
            <Pill color={Math.abs(r.gstDiff) > 0.01 ? "purple" : "gray"}>₹ {fmt(r.gstDiff)}</Pill>,
            `${fmt(r.itcEligible)}/${fmt(r.itcPending)}`,
            `${r.confidence}%`,
          ])}
        />}
      </Card>

      <div className="flex justify-between">
        <button disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))} className="px-3 py-1 rounded bg-gray-200 dark:bg-gray-700 text-sm disabled:opacity-50">Prev</button>
        <button disabled={page >= pages} onClick={() => setPage((p) => Math.min(pages, p + 1))} className="px-3 py-1 rounded bg-gray-200 dark:bg-gray-700 text-sm disabled:opacity-50">Next</button>
      </div>
    </div>
  );
}

function fmt(n: unknown) {
  const x = Number(n ?? 0);
  if (Number.isNaN(x)) return "0";
  return x.toLocaleString("en-IN", { maximumFractionDigits: 2 });
}
