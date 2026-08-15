import { useState } from "react";
import { http, api } from "../api/client";
import { Card, Table } from "../components/ui";

const TYPES = [
  { id: "match", label: "Match" },
  { id: "mismatch", label: "Mismatch" },
  { id: "vendor", label: "Vendor Summary" },
  { id: "missing", label: "Missing Invoice" },
  { id: "duplicate", label: "Duplicate" },
  { id: "gst", label: "GST Difference" },
];

async function downloadFile(type: string, format: "pdf" | "xlsx") {
  const r = await http.get(`/reports`, { params: { type, format }, responseType: "blob" });
  const url = URL.createObjectURL(r.data);
  const a = document.createElement("a");
  a.href = url;
  a.download = `report-${type}.${format}`;
  a.click();
  URL.revokeObjectURL(url);
}

export default function Reports() {
  const [type, setType] = useState("mismatch");
  const [data, setData] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  const load = async (t: string) => {
    setType(t);
    setLoading(true);
    try { const d = await api.reports(t, "json"); setData(d.rows || []); }
    finally { setLoading(false); }
  };

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Reports</h1>
      <div className="flex flex-wrap gap-2">
        {TYPES.map((t) => (
          <button key={t.id} onClick={() => load(t.id)}
            className={`px-3 py-1.5 rounded text-sm ${type === t.id ? "bg-brand-600 text-white" : "bg-gray-200 dark:bg-gray-700"}`}>
            {t.label}
          </button>
        ))}
        <div className="ml-auto flex gap-2">
          <button onClick={() => downloadFile(type, "pdf")}
            className="px-3 py-1.5 rounded bg-purple-600 text-white text-sm">PDF</button>
          <button onClick={() => downloadFile(type, "xlsx")}
            className="px-3 py-1.5 rounded bg-green-600 text-white text-sm">Excel XLSX</button>
        </div>
      </div>

      <Card className="p-5">
        {loading ? <div>Loading...</div> :
          data.length === 0 ? <div className="text-gray-500 text-sm">No rows for this report type.</div> :
          <Table headers={Object.keys(data[0])} rows={data.map((r) => Object.values(r) as any)} />}
      </Card>
    </div>
  );
}
