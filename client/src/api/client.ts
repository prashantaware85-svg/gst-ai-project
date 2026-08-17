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
};
