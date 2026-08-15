// Levenshtein distance used for fuzzy invoice number matching.
export function levenshtein(a: string, b: string): number {
  a = String(a ?? "").toLowerCase().replace(/\s+/g, "");
  b = String(b ?? "").toLowerCase().replace(/\s+/g, "");
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = Array.from({ length: m + 1 }, (_, i) => i);
  for (let j = 1; j <= n; j++) {
    let prev = dp[0];
    dp[0] = j;
    for (let i = 1; i <= m; i++) {
      const tmp = dp[i];
      dp[i] = Math.min(dp[i] + 1, dp[i - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[m];
}

// Normalizes common invoice number shorthands so INV-2024/042 matches 2024-042
// and INVOICE-001 matches INV-001. Non-alphanumeric characters are stripped and
// common leading tokens (INVOICE/INVNO/BILLNO/BILL/DOC/INV/NO) are removed.
// Leading zeroes are preserved here; fuzzySame() handles them via canonical
// numeric tails so sequential invoices (ACME-001 vs ACME-002) do not collide.
export function normalizeInvoiceNo(n: string): string {
  const s = String(n ?? "").toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .replace(/^(INVOICE|INVNO|BILLNO|DOC|BILL|INV|NO)+/, "");
  return s;
}

// Matches when two invoice numbers are the same invoice: either exactly, after
// normalization, after leading-zero canonicalization (ACME-1 == ACME-01), or
// within a small edit distance. Two invoices sharing the same non-numeric
// prefix but carrying different numeric sequences (ACME-001 vs ACME-002) are
// never treated as the same invoice.
//
// The edit-distance fallback is deliberately guarded: it only applies when the
// two numbers share at least one leading character. This prevents inserting a
// prefix from creating a phantom match (e.g. a credit note "DN-GLBX-100"
// against the original invoice "GLBX-100" differ only by the inserted "DN" and
// must NOT be treated as the same document).
export function fuzzySame(a: string, b: string, tolerance = 2): boolean {
  if (String(a ?? "") === String(b ?? "")) return true;
  const na = normalizeInvoiceNo(a);
  const nb = normalizeInvoiceNo(b);
  if (na === nb) return true;
  if (!na || !nb) return false;

  const ma = /^(\D*)(\d*)$/.exec(na);
  const mb = /^(\D*)(\d*)$/.exec(nb);
  if (ma && mb && ma[1] === mb[1]) {
    if (stripLeadZeros(ma[2]) === stripLeadZeros(mb[2])) return true;
    return false;
  }
  if (na[0] !== nb[0]) return false;
  return levenshtein(na, nb) <= tolerance;
}

function stripLeadZeros(s: string): string {
  return s.replace(/^0+(?=\d)/, "");
}

// Canonical grouping key used by the reconciliation engine (and unit tests) to
// detect duplicate invoices in O(N) instead of O(N²). It applies the same rules
// fuzzySame() uses for the exact/canonical branches: normalization plus
// leading-zero canonicalization of the trailing numeric tail, so
// "ACME-001" and "ACME-1" share one key while "ACME-001" and "ACME-002" do not.
export function invoiceKey(n: string): string {
  const na = normalizeInvoiceNo(n);
  if (!na) return na;
  const m = /^(\D*)(\d*)$/.exec(na);
  if (m && m[2]) return `${m[1]}${stripLeadZeros(m[2])}`;
  return na;
}

// Returns the subset of `items` that are duplicates within the same group as
// defined by `key(item)`. The first occurrence of each key keeps its identity;
// every later occurrence is returned. Runs in O(N).
export function buildDuplicateExtras<T>(items: T[], key: (t: T) => string): Set<T> {
  const seen = new Map<string, T>();
  const extras = new Set<T>();
  for (const it of items) {
    const k = key(it);
    if (seen.has(k)) extras.add(it);
    else seen.set(k, it);
  }
  return extras;
}

// Returns every item belonging to a group with more than one member, plus the
// first occurrence of each such group (which owns its ITC). Both members of a
// duplicate pair are therefore flagged DUPLICATE, while only the first carries
// the credit. Runs in O(N).
export function duplicateGroupInfo<T>(items: T[], key: (t: T) => string): { dupes: Set<T>; firstOwners: Set<T> } {
  const groups = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    const arr = groups.get(k);
    if (arr) arr.push(it);
    else groups.set(k, [it]);
  }
  const dupes = new Set<T>();
  const firstOwners = new Set<T>();
  for (const group of groups.values()) {
    if (group.length > 1) {
      for (const it of group) dupes.add(it);
      firstOwners.add(group[0]);
    }
  }
  return { dupes, firstOwners };
}