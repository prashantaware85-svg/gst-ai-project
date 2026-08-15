import { useState } from "react";
import { api } from "../api/client";
import { Card, Table } from "../components/ui";

export default function SmartSearch() {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<any[]>([]);

  const search = async () => {
    if (!q.trim()) { setResults([]); return; }
    const d = await api.search(q);
    setResults(d.results || []);
  };

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Smart Search</h1>
      <Card className="p-4">
        <div className="flex gap-2">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && search()}
            placeholder="Invoice Number / GSTIN / Vendor Name"
            className="flex-1 px-3 py-2 border rounded dark:bg-gray-700 dark:border-gray-600"
          />
          <button onClick={search} className="bg-brand-600 text-white px-4 rounded">Search</button>
        </div>
      </Card>
      <Card className="p-5">
        <Table
          headers={["Source", "GSTIN", "Vendor", "Invoice No", "Date", "Taxable", "IGST"]}
          rows={results.map((r: any) => [
            r.source, r.gstin, r.vendorName || "—", r.invoiceNo,
            r.invoiceDate?.slice(0, 10), r.taxableValue, r.igst,
          ])}
        />
      </Card>
    </div>
  );
}
