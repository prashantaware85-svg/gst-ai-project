import { Router } from "express";
import { prisma } from "../utils/prisma";
import { authenticate, AuthedRequest } from "../middleware/auth.middleware";
import { chatAssistant } from "../ai/suggestions.ai";
import { rateLimit } from "../middleware/rate-limit.middleware";

export const chatRouter = Router();

const chatLimiter = rateLimit({ windowMs: 60_000, max: 30, message: "Too many chat requests. Try again shortly." });

chatRouter.post("/chat", chatLimiter, authenticate, async (req, res) => {
  const { question, invoiceNo } = req.body as { question?: string; invoiceNo?: string };
  if (!question) return res.status(400).json({ error: "BadRequest", message: "question required" });

  let context = "";
  if (invoiceNo) {
    const r = await prisma.reconciliationResult.findFirst({ where: { bookInvoiceNo: invoiceNo }, orderBy: { id: "desc" } });
if (r) {
      const mm = Array.isArray(r.mismatchTypes) ? r.mismatchTypes.join(", ") : String(r.mismatchTypes ?? "");
      context = `Status: ${r.status}, GSTIN books: ${r.bookGstin} vs 2B ${r.twoBGstin ?? "N/A"}, ` +
        `bookTax: ${r.bookTax} vs 2BTax ${r.twoBTax ?? "N/A"}, ` +
        `gstDiff: ${r.gstDiff}, mismatches: ${mm}. ` +
        `Reason: ${r.aiReason || ""}`;
    } else {
      context = `No reconciled invoice found with invoice number ${invoiceNo}.`;
    }
  }
  const { answer, confidence } = await chatAssistant(question, context);
  return res.json({ answer, confidence });
});
