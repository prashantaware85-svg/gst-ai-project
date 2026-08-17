import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { api } from "../api/client";

interface AuthState {
  user: { id: number; name: string; role: "ADMIN" | "ACCOUNTANT" | "VIEWER" } | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthState>(undefined as any);
export const useAuth = () => useContext(AuthContext);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthState["user"]>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // The server decides whether a read-only guest login is available
      // (GUEST_AUTH=true and not production — advertised via /api/health as a
      // non-secret boolean). If so, frontend auto-logs-in with the guest token
      // and the login screen is skipped. Otherwise normal login is preserved.
      let guestAvailable = false;
      try {
        const r = await fetch("/api/health");
        const h = await r.json();
        guestAvailable = Boolean(h?.guestAuth);
      } catch {
        // Health unreachable (offline/dev) — fall back to normal auth.
      }
      if (cancelled) return;
      if (guestAvailable) {
        try {
          const d = await api.guestLogin();
          localStorage.setItem("gst_token", d.token);
          setUser(d.user);
          setLoading(false);
          return;
        } catch {
          // Guest endpoint rejected — fall through to normal auth.
        }
      }
      const t = localStorage.getItem("gst_token");
      if (!t) { setLoading(false); return; }
      api.me()
        .then((d) => setUser(d.user))
        .catch(() => { localStorage.removeItem("gst_token"); })
        .finally(() => setLoading(false));
    })();
    return () => { cancelled = true; };
  }, []);

  const login = async (email: string, password: string) => {
    const d = await api.login(email, password);
    localStorage.setItem("gst_token", d.token);
    setUser(d.user);
  };
  const logout = () => {
    localStorage.removeItem("gst_token");
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}
