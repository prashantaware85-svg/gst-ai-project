import { Router } from "express";
import type { Request, Response } from "express";
import { authenticate, authorize } from "../middleware/auth.middleware";
import { tallyUrl } from "../utils/config";
import {
  TallyError,
  fetchCurrentCompany,
  fetchVouchers,
  type VoucherKind,
} from "../services/tally.service";
import {
  getImportSummary,
  importVouchers,
  listImports,
} from "../services/tallyImport.service";

export const tallyRouter = Router();

// Local TallyPrime connector. TallyPrime accepts XML-over-HTTP POST requests
// at http://localhost:9000. This endpoint only pings TallyPrime to test
// connectivity — it does NOT read or write any GST/invoice data yet. Because a
// cloud server (e.g. Render) cannot reach a localhost TallyPrime, this route is
// intended for local development where TallyPrime runs on the same machine.
const CHECK_TIMEOUT_MS = 3000;

tallyRouter.get("/tally/status", authenticate, async (_req, res) => {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
    try {
      // Any HTTP response (even an error envelope) means TallyPrime is
      // reachable; only transport-level failures count as "not connected".
      await fetch(tallyUrl(), {
        method: "POST",
        headers: { "Content-Type": "text/xml" },
        body: "<ENVELOPE></ENVELOPE>",
        signal: controller.signal,
      });
      return res.json({ connected: true, message: "TallyPrime is running" });
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return res.json({ connected: false, message: "Unable to connect to TallyPrime" });
  }
});

// Reads the company currently loaded in TallyPrime. Read-only — no GST/invoice
// data is imported and the database is untouched. Errors are distinguished by
// message: Tally unreachable vs. reachable-but-no/invalid company info.
tallyRouter.get("/tally/company", authenticate, async (_req, res) => {
  try {
    const info = await fetchCurrentCompany();
    return res.json({
      connected: true,
      companyName: info.companyName,
      gstin: info.gstin,
      message: "Company information retrieved",
    });
  } catch (e) {
    const message = e instanceof TallyError ? e.message : "Unable to connect to TallyPrime";
    return res.json({ connected: false, message });
  }
});

// ---------------------------------------------------------------------------
// Sales / Purchase vouchers (read-only)
// ---------------------------------------------------------------------------

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Indian financial year containing "now": 1 April -> 31 March.
function currentFinancialYear(): { from: string; to: string } {
  const now = new Date();
  const y = now.getFullYear();
  const month = now.getMonth() + 1;
  return month >= 4
    ? { from: `${y}-04-01`, to: `${y + 1}-03-31` }
    : { from: `${y - 1}-04-01`, to: `${y}-03-31` };
}

// Resolves optional fromDate/toDate query params against the current financial
// year, validating format and ordering. Returns either { fromIso, toIso } or a
// 400-style { error } payload.
function resolveDateRange(query: Request["query"]):
  | { fromIso: string; toIso: string }
  | { error: string } {
  const { fromDate, toDate } = query;
  const fy = currentFinancialYear();
  let fromIso = fy.from;
  let toIso = fy.to;

  if (fromDate !== undefined) {
    if (typeof fromDate !== "string" || !ISO_DATE_RE.test(fromDate) || Number.isNaN(Date.parse(fromDate))) {
      return { error: "fromDate must be a valid date in YYYY-MM-DD format" };
    }
    fromIso = fromDate;
  }
  if (toDate !== undefined) {
    if (typeof toDate !== "string" || !ISO_DATE_RE.test(toDate) || Number.isNaN(Date.parse(toDate))) {
      return { error: "toDate must be a valid date in YYYY-MM-DD format" };
    }
    toIso = toDate;
  }
  if (fromIso > toIso) {
    return { error: "fromDate must be on or before toDate" };
  }
  return { fromIso, toIso };
}

// Shared handler for both voucher endpoints. Query params fromDate/toDate are
// optional and default to the current financial year. The response carries the
// normalised "vouchers" plus the raw parsed Tally export ("raw") separately, so
// consumers never have to reverse-engineer the normalisation.
function voucherHandler(kind: VoucherKind) {
  return async (req: Request, res: Response) => {
    const range = resolveDateRange(req.query);
    if ("error" in range) {
      return res.status(400).json({ error: "BadRequest", message: range.error });
    }

    try {
      // fetchVouchers converts ISO dates to Tally's d-MMM-yyyy internally.
      const result = await fetchVouchers(kind, range.fromIso, range.toIso);
      return res.json({
        connected: true,
        count: result.vouchers.length,
        fromDate: range.fromIso,
        toDate: range.toIso,
        vouchers: result.vouchers,
        raw: result.raw,
      });
    } catch (e) {
      const message = e instanceof TallyError ? e.message : "Unable to connect to TallyPrime";
      return res.json({ connected: false, message });
    }
  };
}

// Read-only: no vouchers are written to TallyPrime and no DB rows are created.
tallyRouter.get("/tally/sales", authenticate, voucherHandler("sales"));
tallyRouter.get("/tally/purchases", authenticate, voucherHandler("purchases"));

// ---------------------------------------------------------------------------
// Tally import (saves vouchers to the application database)
// ---------------------------------------------------------------------------

// POST /api/tally/import?type=sales|purchases&fromDate=...&toDate=...
// Fetches the vouchers from TallyPrime, saves new ones to TallyImport (skipping
// duplicates) and returns the run summary + totals for the imported batch.
tallyRouter.post("/tally/import", authenticate, authorize("ADMIN", "ACCOUNTANT"), async (req: Request, res: Response) => {
  const kind: VoucherKind = req.query.type === "purchases" ? "purchases" : "sales";
  const range = resolveDateRange(req.query);
  if ("error" in range) {
    return res.status(400).json({ error: "BadRequest", message: range.error });
  }

  try {
    const result = await importVouchers(kind, range.fromIso, range.toIso);
    return res.json({ ok: true, fromDate: range.fromIso, toDate: range.toIso, ...result });
  } catch (e) {
    const message = e instanceof TallyError ? e.message : "Unable to connect to TallyPrime";
    return res.json({ ok: false, connected: false, message });
  }
});

// GET /api/tally/import/summary — import counts per voucher type + last runs,
// used for the Tally Import Summary panel.
tallyRouter.get("/tally/import/summary", authenticate, async (_req: Request, res: Response) => {
  try {
    return res.json({ ok: true, ...(await getImportSummary()) });
  } catch (e) {
    const message = e instanceof TallyError ? e.message : "Database error while loading import summary";
    return res.status(500).json({ ok: false, message });
  }
});

// GET /api/tally/imports?type=Sales|Purchase — recent imported records.
tallyRouter.get("/tally/imports", authenticate, async (req: Request, res: Response) => {
  try {
    const type = typeof req.query.type === "string" ? req.query.type : undefined;
    const rows = await listImports(type);
    return res.json({ ok: true, count: rows.length, rows });
  } catch (e) {
    const message = e instanceof TallyError ? e.message : "Database error while loading imports";
    return res.status(500).json({ ok: false, message });
  }
});