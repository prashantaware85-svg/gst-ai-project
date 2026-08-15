import { FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { Card } from "../components/ui";

export default function Login() {
  const { login } = useAuth();
  const nav = useNavigate();
  const [email, setEmail] = useState("admin@gst.ai");
  const [password, setPassword] = useState("admin123");
  const [err, setErr] = useState("");

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try { await login(email, password); nav("/"); }
    catch { setErr("Invalid credentials"); }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900">
      <Card className="p-8 w-96">
        <h1 className="text-xl font-semibold mb-4 text-brand-600">GST AI Reconciliation Agent</h1>
        <form onSubmit={submit} className="space-y-3">
          <input className="w-full px-3 py-2 border rounded dark:bg-gray-700 dark:border-gray-600" placeholder="Email"
            value={email} onChange={(e) => setEmail(e.target.value)} />
          <input className="w-full px-3 py-2 border rounded dark:bg-gray-700 dark:border-gray-600" placeholder="Password"
            type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          {err && <div className="text-red-500 text-sm">{err}</div>}
          <button className="w-full bg-brand-600 text-white rounded py-2">Login</button>
          <div className="text-xs text-gray-500">admin@gst.ai / admin123</div>
        </form>
      </Card>
    </div>
  );
}
