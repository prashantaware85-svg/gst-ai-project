import { useEffect, useState } from "react";
import { api } from "../api/client";
import { Card } from "../components/ui";

export default function Notifications() {
  const [rows, setRows] = useState<any[]>([]);
  const load = () => api.notifications().then((d) => setRows(d.notifications || []));
  useEffect(() => { load(); }, []);
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Notifications</h1>
      <Card className="p-5">
        <div className="space-y-2">
          {rows.length === 0 && <div className="text-gray-500">No notifications.</div>}
          {rows.map((n) => (
            <div key={n.id} className={`border-l-4 pl-3 py-2 ${n.read ? "border-gray-300" : "border-brand-600"}`}>
              <div className="font-medium text-sm">{n.title}</div>
              <div className="text-sm text-gray-500 dark:text-gray-400">{n.message}</div>
              {!n.read && (
                <button onClick={() => api.markNotification(n.id).then(load)} className="text-xs text-brand-600 mt-1">Mark read</button>
              )}
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
