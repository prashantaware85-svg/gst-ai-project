import axios from "axios";

const token = () => localStorage.getItem("gst_token") || "";

// API base is configurable for production deployments. In dev and same-origin
// (reverse-proxy) setups it stays "/api"; set VITE_API_URL in a production
// build when the client is served from a different origin than the backend.
const baseURL = (import.meta.env.VITE_API_URL as string | undefined) || "/api";

export const http = axios.create({ baseURL });

http.interceptors.request.use((cfg) => {
  const t = token();
  if (t) cfg.headers.Authorization = `Bearer ${t}`;
  return cfg;
});

http.interceptors.response.use(
  (r) => r,
  (err) => {
    if (err?.response?.status === 401) {
      localStorage.removeItem("gst_token");
      if (!window.location.pathname.startsWith("/login")) window.location.href = "/login";
    }
    return Promise.reject(err);
  },
);

export const api = {
  login: (email: string, password: string) =>
    http.post("/auth/login", { email, password }).then((r) => r.data),
  guestLogin: () => http.post("/auth/guest").then((r) => r.data),
  me: () => http.get("/auth/me").then((r) => r.data),
  dashboard: () => http.get("/dashboard").then((r) => r.data),
  vendors: () => http.get("/vendors").then((r) => r.data),
  invoices: (params: Record<string, string | number>) =>
    http.get("/dashboard/invoices", { params }).then((r) => r.data),
  reports: (type: string, format = "json") =>
    http.get("/reports", { params: { type, format } }).then((r) => r.data),
  reportFileUrl: (type: string, format: "pdf" | "xlsx") =>
    `/api/reports?type=${type}&format=${format}`,
  reconcile: () => http.post("/reconcile").then((r) => r.data),
  upload: (endpoint: string, file: File) => {
    const form = new FormData();
    form.append("file", file);
    return http.post(endpoint, form).then((r) => r.data);
  },
  search: (q: string) => http.get("/search", { params: { q } }).then((r) => r.data),
  chat: (question: string, invoiceNo?: string) =>
    http.post("/chat", { question, invoiceNo }).then((r) => r.data),
  notifications: () => http.get("/notifications").then((r) => r.data),
  markNotification: (id: number) =>
    http.post(`/notifications/${id}/read`).then((r) => r.data),
  // TallyPrime local connector (read-only; Tally itself is never written to).
  tallyStatus: () => http.get("/tally/status").then((r) => r.data),
  tallyCompany: () => http.get("/tally/company").then((r) => r.data),
  tallyVouchers: (type: "sales" | "purchases", fromDate: string, toDate: string) =>
    http.get(`/tally/${type}`, { params: { fromDate, toDate } }).then((r) => r.data),
  tallyImport: (type: "sales" | "purchases", fromDate: string, toDate: string) =>
    http.post(`/tally/import`, null, { params: { type, fromDate, toDate } }).then((r) => r.data),
  tallyImportSummary: () => http.get("/tally/import/summary").then((r) => r.data),
  tallyImports: (type?: string, fromDate?: string, toDate?: string) =>
    http.get("/tally/imports", { params: { type, fromDate, toDate } }).then((r) => r.data),
  // GST return file import (Excel / CSV / JSON of GSTR-1 or GSTR-2B).
  gstValidate: (returnType: "GSTR1" | "GSTR2B", period: string, file: File) => {
    const form = new FormData();
    form.append("file", file);
    form.append("returnType", returnType);
    form.append("period", period);
    return http.post("/gst/validate", form).then((r) => r.data);
  },
  gstImport: (returnType: "GSTR1" | "GSTR2B", period: string, file: File) => {
    const form = new FormData();
    form.append("file", file);
    form.append("returnType", returnType);
    form.append("period", period);
    return http.post("/gst/import", form).then((r) => r.data);
  },
  gstImports: (returnType?: string) =>
    http.get("/gst/imports", { params: { returnType } }).then((r) => r.data),
  gstImportDetail: (id: number) => http.get(`/gst/imports/${id}`).then((r) => r.data),
  gstTransactions: (params: Record<string, string | number>) =>
    http.get("/gst/transactions", { params }).then((r) => r.data),
  // GST <-> Tally reconciliation engine.
  reconRun: (period: string, transactionType: "SALES" | "PURCHASE") =>
    http.post("/reconciliation/run", { period, transactionType }).then((r) => r.data),
  reconSummary: (period: string, transactionType: "SALES" | "PURCHASE") =>
    http.get("/reconciliation/summary", { params: { period, transactionType } }).then((r) => r.data),
  reconResults: (params: Record<string, string | number>) =>
    http.get("/reconciliation/results", { params }).then((r) => r.data),
  reconResultDetail: (id: number) => http.get(`/reconciliation/results/${id}`).then((r) => r.data),
  reconReview: (id: number, reviewStatus: string, reviewNote?: string) =>
    http.patch(`/reconciliation/results/${id}`, { reviewStatus, reviewNote }).then((r) => r.data),
  reconExport: async (period: string, transactionType: "SALES" | "PURCHASE", format: "xlsx" | "csv") => {
    const r = await http.get("/reconciliation/export", {
      params: { period, transactionType, format },
      responseType: "blob",
    });
    const url = URL.createObjectURL(r.data as Blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `reconciliation-${period}-${transactionType.toLowerCase()}.${format}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },
};
