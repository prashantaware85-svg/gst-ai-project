import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { LogOut, Bell, Sun, Moon } from "lucide-react";
import { useState } from "react";

const links = [
  { to: "/", label: "Dashboard" },
  { to: "/upload", label: "Upload" },
  { to: "/vendors", label: "Vendors" },
  { to: "/reports", label: "Reports" },
  { to: "/search", label: "Smart Search" },
  { to: "/chat", label: "AI Assistant" },
  { to: "/notifications", label: "Notifications" },
];

export default function Layout() {
  const { user, logout } = useAuth();
  const [dark, setDark] = useState(document.documentElement.classList.contains("dark"));
  const toggleDark = () => {
    document.documentElement.classList.toggle("dark");
    setDark(document.documentElement.classList.contains("dark"));
  };

  return (
    <div className="flex min-h-screen bg-gray-50 dark:bg-gray-900 text-gray-800 dark:text-gray-100">
      <aside className="w-60 bg-white dark:bg-gray-800 border-r border-gray-200 dark:border-gray-700 p-4 flex flex-col">
        <div className="font-bold text-lg text-brand-600 mb-6">GST AI Agent</div>
        <nav className="flex-1 space-y-1">
          {links.map((l) => (
            <NavLink key={l.to} to={l.to} end={l.to === "/"}
              className={({ isActive }) =>
                "block px-3 py-2 rounded-md text-sm font-medium " +
                (isActive ? "bg-brand-600 text-white" : "hover:bg-gray-100 dark:hover:bg-gray-700")}>
              {l.label}
            </NavLink>
          ))}
        </nav>
        <div className="mt-4 pt-4 border-t border-gray-200 dark:border-gray-700 text-xs">
          {user && <div className="mb-1">{user.name}<br /><span className="text-gray-500">{user.role}</span></div>}
          <button onClick={logout} className="flex items-center gap-1 text-red-600 hover:underline mt-2">
            <LogOut size={14} /> Logout
          </button>
        </div>
      </aside>
      <div className="flex-1 flex flex-col">
        <header className="h-14 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between px-6 bg-white dark:bg-gray-800">
          <div className="font-medium">GST Reconciliation</div>
          <div className="flex items-center gap-3">
            <button onClick={toggleDark} className="p-2 rounded hover:bg-gray-100 dark:hover:bg-gray-700">
              {dark ? <Sun size={18} /> : <Moon size={18} />}
            </button>
            <Bell size={18} />
          </div>
        </header>
        <main className="p-6 flex-1 overflow-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
