import { Router } from "express";
import { prisma } from "../utils/prisma";
import { authenticate } from "../middleware/auth.middleware";
import { num, numOrNull } from "../utils/db";

export const searchRouter = Router();

searchRouter.get("/search", authenticate, async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (!q) return res.json({ results: [] });
  const invoices = await prisma.invoice.findMany({
    where: {
      OR: [
        { invoiceNo: { contains: q } },
        { gstin: { contains: q } },
        { vendorName: { contains: q } },
      ],
    },
    take: 100,
  });
  return res.json({ results: invoices.map((i: any) => ({
    ...i,
    taxableValue: num(i.taxableValue),
    cgst: num(i.cgst), sgst: num(i.sgst), igst: num(i.igst),
    cess: num(i.cess), totalGst: num(i.totalGst), invoiceValue: num(i.invoiceValue),
  })) });
});
