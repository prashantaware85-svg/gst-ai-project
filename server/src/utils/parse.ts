export function parseNum(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v.replace(/[^0-9.\-]/g, ""));
    if (!Number.isNaN(n)) return n;
  }
  return 0;
}

export function parseDate(v: unknown): Date | null {
  if (!v) return null;
  if (v instanceof Date) return v;
  let s = String(v).trim();
  // dd-mm-yyyy or dd/mm/yyyy → standard form
  const m = s.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{2,4})$/);
  if (m) {
    const day = m[1].padStart(2, "0");
    const mon = m[2].padStart(2, "0");
    const yr = m[3].length === 2 ? `20${m[3]}` : m[3];
    s = `${yr}-${mon}-${day}`;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}
