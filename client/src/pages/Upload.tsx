import { useState } from "react";
import { api } from "../api/client";
import { Card } from "../components/ui";
import { useAuth } from "../hooks/useAuth";

const FILES = [
  { name: "Purchase Register", endpoint: "/upload/purchase", accept: ".xlsx,.csv", desc: "Excel / CSV from ERP" },
  { name: "Sales Register", endpoint: "/upload/sales", accept: ".xlsx,.csv", desc: "Excel / CSV from ERP" },
  { name: "GSTR-2B JSON", endpoint: "/upload/gstr2b", accept: ".json", desc: "Downloaded from GST portal" },
  { name: "GSTR-1 JSON", endpoint: "/upload/gstr1", accept: ".json", desc: "Downloaded from GST portal" },
  { name: "GSTR-3B Summary", endpoint: "/upload/gstr3b", accept: ".xlsx,.json", desc: "Excel / JSON" },
  { name: "GST Portal Excel", endpoint: "/upload/gstportal", accept: ".xlsx", desc: "Exported from portal" },
];

export default function UploadPage() {
  const { user } = useAuth();
  const canUpload = user?.role === "ADMIN" || user?.role === "ACCOUNTANT";
  const [status, setStatus] = useState<Record<string, string>>({});

  const onChange = async (endpoint: string, key: string, file?: File) => {
    if (!file) return;
    setStatus((s) => ({ ...s, [key]: "Uploading..." }));
    try {
      const d = await api.upload(endpoint, file);
      setStatus((s) => ({ ...s, [key]: `Uploaded ${d.count} rows` }));
    } catch (e: any) {
      setStatus((s) => ({ ...s, [key]: e?.response?.data?.message || "Failed" }));
    }
  };

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Import Files</h1>
      {!canUpload && <div className="text-red-600 text-sm">You do not have permission to upload.</div>}
      <div className="grid md:grid-cols-3 gap-4">
        {FILES.map((f) => (
          <Card key={f.endpoint} className="p-5">
            <div className="font-medium">{f.name}</div>
            <div className="text-xs text-gray-500">{f.desc}</div>
            <input
              type="file" accept={f.accept} disabled={!canUpload}
              onChange={(e) => onChange(f.endpoint, f.name, e.target.files?.[0])}
              className="mt-3 block w-full text-sm file:mr-3 file:px-3 file:py-2 file:rounded file:border-0 file:bg-brand-600 file:text-white"
            />
            <div className="text-xs mt-2 text-gray-500">{status[f.name] || ""}</div>
          </Card>
        ))}
      </div>
    </div>
  );
}
