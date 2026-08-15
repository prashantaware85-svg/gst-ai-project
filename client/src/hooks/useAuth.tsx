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
    const t = localStorage.getItem("gst_token");
    if (!t) { setLoading(false); return; }
    api.me()
      .then((d) => setUser(d.user))
      .catch(() => { localStorage.removeItem("gst_token"); })
      .finally(() => setLoading(false));
  }, []);

  const login = async (email: string, password: string) => {
    const d = await api.login(email, password);
    localStorage.setItem("gst_token", d.token);
    setUser(d.user);
  };
  const logout = () => { localStorage.removeItem("gst_token"); setUser(null); };

  return (
    <AuthContext.Provider value={{ user, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}
