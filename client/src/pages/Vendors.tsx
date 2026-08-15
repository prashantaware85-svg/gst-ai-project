import { useEffect, useState } from "react";
import { api } from "../api/client";
import { Card, Table } from "../components/ui";

export default function Vendors() {
  const [vendors, setVendors] = useState([]);
  useEffect(() => { api.vendors().then((d) => setVendors(d.vendors)); }, []);
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Vendor Dashboard</h1>
      <Card className="p-5">
        <Table
          headers={["Vendor", "GSTIN", "Matched", "Mismatch", "Pending", "Missing", "Total GST"]}
          rows={vendors.map((v: any) => [v.vendorName, v.gstin, v.matched, v.mismatch, v.pending, v.missing, `₹${v.totalGst.toLocaleString()}`])}
        />
      </Card>
    </div>
  );
}
