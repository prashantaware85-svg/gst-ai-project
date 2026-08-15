import { Router, Request, Response } from "express";
import { prisma } from "../utils/prisma";
import { authenticate } from "../middleware/auth.middleware";
import { num } from "../utils/db";

export const vendorsRouter = Router();

vendorsRouter.get("/vendors", authenticate, async (_req: Request, res: Response) => {
  const latest = await prisma.reconciliationResult.findFirst({ orderBy: { runId: "desc" } });
  if (!latest) return res.json({ vendors: [] });
  const rows = await prisma.reconciliationResult.findMany({ where: { runId: latest.runId } });

  const map = new Map<string, any>();
  for (const r of rows as any[]) {
    const gstin = r.bookGstin || r.twoBGstin || "UNKNOWN";
    if (!map.has(gstin)) map.set(gstin, { gstin, vendorName: r.vendorName || "", matched: 0, mismatch: 0, pending: 0, missing: 0, duplicates: 0, totalGst: 0, itcEligible: 0, itcPending: 0 });
    const v = map.get(gstin);
    if (r.status === "MATCHED") v.matched++;
    else if (r.status === "MISSING_IN_2B") v.missing++;
    else if (r.status === "DUPLICATE") v.duplicates++;
    else v.mismatch++;
    const tax = num(r.bookTax) || num(r.twoBTax) || 0;
    v.totalGst += tax;
    v.itcEligible += num(r.itcEligible);
    v.itcPending += num(r.itcPending);
  }
  return res.json({ vendors: Array.from(map.values()) });
});
