import { ReactNode } from "react";
export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`bg-white dark:bg-gray-800 rounded-xl shadow border border-gray-100 dark:border-gray-700 ${className}`}>
      {children}
    </div>
  );
}
export function Stat({ title, value, accent = "text-brand-600" }: { title: string; value: ReactNode; accent?: string }) {
  return (
    <Card className="p-5">
      <div className="text-sm text-gray-500 dark:text-gray-400">{title}</div>
      <div className={`text-2xl font-semibold mt-1 ${accent}`}>{value}</div>
    </Card>
  );
}

const PILL_COLORS: Record<string, string> = {
  green: "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-200",
  purple: "bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-200",
  fuchsia: "bg-fuchsia-100 text-fuchsia-700 dark:bg-fuchsia-900 dark:text-fuchsia-200",
  red: "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-200",
  rose: "bg-rose-100 text-rose-700 dark:bg-rose-900 dark:text-rose-200",
  amber: "bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-200",
  gray: "bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-200",
};
export function Pill({ children, color = "gray" }: { children: ReactNode; color?: keyof typeof PILL_COLORS }) {
  return <span className={`text-[10px] px-2 py-0.5 rounded-full ${PILL_COLORS[color] || PILL_COLORS.gray}`}>{children}</span>;
}

const STATUS_STYLES: Record<string, string> = {
  MATCHED:        "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-200",
  MISMATCHED:      "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-200",
  MISSING_IN_2B:   "bg-orange-100 text-orange-700 dark:bg-orange-900 dark:text-orange-200",
  MISSING_IN_BOOKS:"bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-200",
  DUPLICATE:       "bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-200",
  // Phase 2 GST reconciliation statuses.
  AMOUNT_MISMATCH:  "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-200",
  DATE_MISMATCH:    "bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-200",
  INVOICE_NUMBER_MISMATCH: "bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-200",
  GSTIN_MISMATCH:   "bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-200",
  MISSING_IN_GST:   "bg-orange-100 text-orange-700 dark:bg-orange-900 dark:text-orange-200",
  MISSING_IN_TALLY: "bg-orange-100 text-orange-700 dark:bg-orange-900 dark:text-orange-200",
  DUPLICATE_IN_TALLY: "bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-200",
  DUPLICATE_IN_GST: "bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-200",
  POSSIBLE_MATCH:   "bg-fuchsia-100 text-fuchsia-700 dark:bg-fuchsia-900 dark:text-fuchsia-200",
  INVALID_DATA:     "bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-200",
};
export function StatusBadge({ status }: { status: string }) {
  return <span className={`text-xs px-2 py-0.5 rounded ${STATUS_STYLES[status] || STATUS_STYLES.MISMATCHED}`}>{status.replace(/_/g, " ")}</span>;
}

export function Table({ headers, rows }: { headers: string[]; rows: ReactNode[][] }) {
  return (
    <div className="overflow-auto rounded-lg border border-gray-200 dark:border-gray-700">
      <table className="min-w-full text-sm">
        <thead className="bg-gray-50 dark:bg-gray-700 text-left">
          <tr>{headers.map((h, i) => <th key={i} className="px-3 py-2 font-medium">{h}</th>)}</tr>
        </thead>
        <tbody>
          {rows.length === 0 && <tr><td colSpan={headers.length} className="px-3 py-6 text-center text-gray-400">No data</td></tr>}
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-gray-100 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700/50">
              {r.map((c, j) => <td key={j} className="px-3 py-2">{c}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function TextInput({ value, onChange, placeholder, className = "" }: { value: string; onChange: (v: string) => void; placeholder?: string; className?: string }) {
  return (
    <input
      value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
      className={`px-3 py-2 border rounded text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100 ${className}`}
    />
  );
}

export function Select({ value, onChange, options, className = "" }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; className?: string }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}
      className={`px-3 py-2 border rounded text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100 ${className}`}>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}
