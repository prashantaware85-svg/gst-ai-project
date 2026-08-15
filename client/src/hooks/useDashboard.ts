import { useEffect, useState } from "react";
import { api } from "../api/client";

export interface Summary {
  totalPurchase: number; totalSales: number;
  bookInvoices: number; twoBInvoices: number;
  matched: number; mismatched: number;
  missingIn2B: number; missingInBooks: number; duplicates: number;
  gstDifference: number; vendors: number;
  matchPercent: number; itcEligible: number; itcPending: number;
  taxableDifference: number;
}
export interface Vendor {
  gstin: string; vendorName: string;
  matched: number; mismatch: number; pending: number;
  missing: number; duplicates: number; totalGst: number;
  itcEligible: number; itcPending: number;
}
export interface Mismatch {
  id: number; bookInvoiceNo: string; bookGstin: string;
  twoBInvoiceNo?: string | null; twoBGstin?: string | null;
  vendorName?: string | null;
  mismatchTypes: string[]; status: string; confidence: number;
  gstDiff: number; taxableDiff: number;
  itcEligible: number; itcPending: number;
  dateDiff?: string | null; invoiceNoDiff?: string | null;
  aiWhat?: string; aiReason?: string; aiAction?: string;
}

export function useDashboard() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [recent, setRecent] = useState<Mismatch[]>([]);
  const [loading, setLoading] = useState(true);
  const [runId, setRunId] = useState(0);

  const reload = async () => {
    setLoading(true);
    try {
      const d = await api.dashboard();
      setSummary(d.summary);
      setVendors(d.vendors || []);
      setRecent(d.recentMismatches || []);
      setRunId(d.runId || 0);
    } finally { setLoading(false); }
  };
  useEffect(() => { reload(); }, []);
  return { summary, vendors, recent, loading, runId, reload };
}

export interface InvoiceRow {
  id: number; status: string; confidence: number;
  bookInvoiceNo: string; bookGstin: string;
  twoBInvoiceNo?: string | null; twoBGstin?: string | null;
  vendorName?: string | null;
  bookDate?: string | null; twoBDate?: string | null;
  dateDiff?: string | null; invoiceNoDiff?: string | null;
  bookTaxable: number; twoBTaxable?: number | null; taxableDiff: number;
  bookTax: number; twoBTax?: number | null; gstDiff: number;
  itcEligible: number; itcPending: number;
  mismatchTypes: string[] | string;
  aiWhat?: string; aiAction?: string;
}

export function useInvoices(filters: { status?: string; vendor?: string; gstin?: string; mismatch?: string; page: number; pageSize: number }) {
  const [rows, setRows] = useState<InvoiceRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams();
    if (filters.status) params.set("status", filters.status);
    if (filters.vendor) params.set("vendor", filters.vendor);
    if (filters.gstin)  params.set("gstin",  filters.gstin);
    if (filters.mismatch) params.set("mismatch", filters.mismatch);
    params.set("page", String(filters.page));
    params.set("pageSize", String(filters.pageSize));
    fetch(`/api/dashboard/invoices?${params.toString()}`, {
      headers: { Authorization: `Bearer ${localStorage.getItem("gst_token")}` },
    })
      .then((r) => r.json())
      .then((d) => { setRows(d.rows || []); setTotal(d.total || 0); })
      .catch(() => { setRows([]); setTotal(0); })
      .finally(() => setLoading(false));
  }, [filters.status, filters.vendor, filters.gstin, filters.mismatch, filters.page, filters.pageSize]);

  return { rows, total, loading };
}
