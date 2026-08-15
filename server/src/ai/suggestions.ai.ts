// OpenAI helpers for the GST AI Reconciliation Agent.
//
// Three exported functions:
//   * openAISuggestion() - explain a single mismatch
//   * openAISummary()    - top-line reconciliation summary
//   * chatAssistant()    - a generic GST Q&A helper used by /chat
//
// When no OPENAI_API_KEY is configured, all three fall back to deterministic,
// rule-based English explanations.

import OpenAI from "openai";

const apiKey = process.env.OPENAI_API_KEY || "";
export const openai = apiKey ? new OpenAI({ apiKey }) : null;

const gModel = "gpt-4o-mini";

export interface DbInv {
  id: number; gstin: string; vendorName: string | null;
  invoiceNo: string; invoiceDate: Date;
  taxableValue: number; cgst: number; sgst: number; igst: number;
}
export interface ReconMismatch { type: string; detail: string; }

export async function openAISuggestion(
  status: string,
  book: DbInv | undefined,
  twoB: DbInv | undefined,
  mismatches: ReconMismatch[],
): Promise<{ what: string; reason: string; action: string } | null> {
  if (!openai) return null;
  const prompt = `You are a GST reconciliation expert in India.
Explain this mismatch clearly and suggest the next corrective action.
Be specific and reference actual figures. Limit each field to 2 sentences.
Known mismatch types: WRONG_GSTIN, WRONG_DATE, WRONG_TAXABLE, WRONG_TAX, WRONG_INVOICE_NO, DUPLICATE.

Status: ${status}
Books invoice: ${book ? JSON.stringify({ invoiceNo: book.invoiceNo, gstin: book.gstin, taxable: book.taxableValue, cgst: book.cgst, sgst: book.sgst, igst: book.igst, date: book.invoiceDate.toISOString().slice(0,10) }) : "N/A"}
GSTR-2B invoice: ${twoB ? JSON.stringify({ invoiceNo: twoB.invoiceNo, gstin: twoB.gstin, taxable: twoB.taxableValue, cgst: twoB.cgst, sgst: twoB.sgst, igst: twoB.igst, date: twoB.invoiceDate.toISOString().slice(0,10) }) : "N/A"}
Mismatches: ${JSON.stringify(mismatches)}

Return STRICT JSON ONLY: {"what":"...","reason":"...","action":"..."}`;

  try {
    const r = await openai.chat.completions.create({
      model: gModel,
      temperature: 0.3,
      messages: [
        { role: "system", content: "You output only valid minified JSON." },
        { role: "user", content: prompt },
      ],
    });
    return JSON.parse(r.choices[0]?.message?.content || "{}");
  } catch {
    return null;
  }
}

export async function openAISummary(summary: any, results: any[]): Promise<string> {
  if (!openai) return ruleBasedSummary(summary);
  try {
    const r = await openai.chat.completions.create({
      model: gModel,
      temperature: 0.4,
      messages: [
        { role: "system", content: "Write a 4-6 line executive summary in plain English for an Indian CA reconciling GST. Mention match %, ITC eligible and pending, GST difference, and next action." },
        { role: "user", content: `Summary: ${JSON.stringify(summary)}. Top mismatches: ${JSON.stringify(results.slice(0, 8))}` },
      ],
    });
    return r.choices[0]?.message?.content || ruleBasedSummary(summary);
  } catch {
    return ruleBasedSummary(summary);
  }
}

// Deterministic, offline fallback explanation generator.
export function explainMismatch(
  status: string,
  book: DbInv | undefined,
  twoB: DbInv | undefined,
  mismatches: ReconMismatch[],
): { what: string; reason: string; action: string } {
  switch (status) {
    case "MATCHED":
      return { what: "Invoice matches between Purchase Register and GSTR-2B.",
               reason: "GSTIN, invoice number, date and tax components all reconcile.",
               action: "No action required. ITC can be claimed." };
    case "MISSING_IN_2B":
      return { what: `Invoice ${book?.invoiceNo} from ${book?.gstin} is in books but not in GSTR-2B.`,
               reason: "Supplier has likely not filed GSTR-1, or filed late, or used a different GSTIN.",
               action: "Contact supplier and request filing. Do not claim ITC until it appears in 2B." };
case "MISSING_IN_BOOKS":
      return { what: `Invoice ${twoB?.invoiceNo} from ${twoB?.gstin} appears in 2B but is not in your books.`,
               reason: "Invoice may not have been booked, or was wrongly entered under a different vendor GSTIN.",
               action: "Check the supplier invoice and AP ledger. Book the purchase if genuine; otherwise raise dispute." };
    case "MISSING_IN_GSTR1":
      return { what: `Invoice ${book?.invoiceNo} from ${book?.gstin} is in the Sales Register but not in GSTR-1.`,
               reason: "Sales may not have been reported on the GSTN portal, filed late, or uploaded under a different customer GSTIN.",
               action: "Contact your GST consultant and file/rectify GSTR-1 before the due date; match the invoice in books to GSTR-1." };
    case "MISSING_IN_SALES":
      return { what: `Invoice ${twoB?.invoiceNo} from ${twoB?.gstin} appears in GSTR-1 but is not in your Sales Register.`,
               reason: "The invoice may not have been booked, or was entered under a different customer GSTIN.",
               action: "Check the outward register and reconcile; book the sale if genuine, otherwise file an amendment for the excess declared." };
    case "DUPLICATE":
      return { what: `Invoice ${book?.invoiceNo} appears more than once in the Purchase Register.`,
               reason: "Possible duplicate data entry or vendor re-billing the same invoice.",
               action: "Verify and delete the duplicate entry to avoid double counting of input tax credit." };
    case "MISMATCHED": {
      const lines = mismatches.map(m => `${m.type}: ${m.detail}`).join("; ");
      const reasonByType: Record<string, string> = {
        WRONG_GSTIN: "Supplier or ERP has a wrong vendor-master GSTIN, or supplier uploaded under a different GSTIN.",
        WRONG_DATE: "Books invoice date differs from the date the supplier used while filing GSTR-1.",
        WRONG_TAXABLE: "Taxable value entered wrongly in books or supplier changed the rate basis / discount.",
        WRONG_TAX: "GST rate or tax amount entered incorrectly in books, or supplier rounded differently.",
        WRONG_INVOICE_NO: "Supplier truncated or reformatted the invoice number while uploading GSTR-1.",
        DUPLICATE: "Same invoice was booked twice, perhaps under different vouchers.",
      };
      const reasons = mismatches.map(m => reasonByType[m.type]).filter(Boolean).join(" ");
      const actions = mismatches.map(m => {
        switch (m.type) {
          case "WRONG_GSTIN": return "Correct the vendor master GSTIN or ask supplier to amend GSTR-1 with right GSTIN.";
          case "WRONG_DATE": return "Obtain physical invoice, correct the date in books, or request supplier amendment.";
          case "WRONG_TAXABLE": return "Recompute taxable value (rate x qty - discount) in both books and GSTR-1; rectify whichever is wrong.";
          case "WRONG_TAX": return "Re-verify GST rate and place of supply so CGST+SGST vs IGST is correctly applied.";
          case "WRONG_INVOICE_NO": return "Update the books invoice number to match supplier's invoicing convention, or request amendment.";
          case "DUPLICATE": return "Reverse the second booking entry and recover any double-taken ITC.";
          default: return "";
        }
      }).join(" ");
      return {
        what: `Invoice ${book?.invoiceNo} from ${book?.gstin} reconciles to 2B with mismatches. ${lines}`,
        reason: reasons || "Likely incorrect entry in books or supplier filed different figures in GSTR-1.",
        action: actions || "Reconcile each field with the supplier; amend your books or request GSTR-1 amendment by supplier." };
    }
    default:
      return { what: "Unknown", reason: "Unknown", action: "Investigate" };
  }
}

function ruleBasedSummary(s: any): string {
  return [
    `Reconciliation completed across Rs. ${Number(s.totalPurchase || 0).toLocaleString()} of purchase (books ${s.bookInvoices} invoices) against ${s.twoBInvoices} invoices in GSTR-2B.`,
    `Match rate ${Number(s.matchPercent || 0)}% — ${s.matched} matched, ${s.mismatched} mismatched, ${s.missingIn2B} missing in 2B, ${s.missingInBooks} missing in books, ${s.duplicates || 0} duplicate.`,
    `Total GST difference detected: Rs. ${Number(s.gstDifference || 0).toFixed(2)}; taxable difference Rs. ${Number(s.taxableDifference || 0).toFixed(2)}.`,
    `ITC eligible Rs. ${Number(s.itcEligible || 0).toLocaleString()} and ITC pending Rs. ${Number(s.itcPending || 0).toLocaleString()} across ${s.vendors} vendors.`,
    `Sales side: ${Number(s.salesMatched || 0)} matched, ${Number(s.salesMismatched || 0)} mismatched, ${Number(s.missingInGstr1 || 0)} missing in GSTR-1, ${Number(s.missingInSales || 0)} missing in Sales Register.`,
    `Next step: contact vendors for missing in 2B, reverse any excess ITC, and request amendments where supplier figures differ.`,
  ].join(" ");
}

// Chat assistant used by /api/chat
export async function chatAssistant(question: string, context?: string): Promise<{ answer: string; confidence: number }> {
  const KNOWLEDGE: Record<string, string> = {
    "section 16": "Section 16 of the CGST Act enumerates five conditions for claiming ITC: (1) possession of tax invoice, (2) receipt of goods/services, (3) supplier has actually paid tax to government, (4) furnished return under section 39, and (5) tax along with interest (if any) paid to supplier within 180 days. Failing any condition disentitles ITC.",
    "itc eligibility": "ITC is eligible only if the invoice appears in GSTR-2B (auto-populated from supplier's GSTR-1), the supplier has filed returns and paid tax, goods/services are received, and the taxpayer has filed their own GSTR-3B. Rule 37 requires payment to supplier within 180 days.",
    "section 17": "Section 17 lists blocked credits (motor vehicles, personal consumption, etc.) and apportionment rules. Blocked ITC cannot be claimed even if it appears in 2B.",
    "section 16(4)": "Section 16(4) prescribes the outer time limit: ITC cannot be taken after 30th November following the end of FY (for FY 2022-23 onwards).",
    "missing in 2b": "An invoice lives in GSTR-2B only after the supplier files GSTR-1. If it is missing, confirm supplier filing status on portal, request rectification / amendment, and defer ITC for that invoice.",
    "invoice in 2b but not in books": "Such an invoice indicates either supplier filed on a GSTIN you don't track, or it has not been booked. Possibility of taxpayer dispute or wrong vendor master. Investigate before claiming ITC.",
    "gst difference": "If GST amount differs between books and 2B, it could be due to wrong rate applied, wrong taxable value, or supplier changed rate. Reconcile taxable value, tax rates, and place of supply (CGST+SGST vs IGST).",
  };

  const q = (question || "").toLowerCase();
  for (const key of Object.keys(KNOWLEDGE)) {
    if (q.includes(key)) {
      return { answer: KNOWLEDGE[key], confidence: 96 };
    }
  }

  if (openai) {
    try {
      const r = await openai.chat.completions.create({
        model: gModel,
        temperature: 0.4,
        messages: [
          { role: "system", content: "You are a precise GST reconciliation expert assistant for India. Keep replies under 150 words and bullet the action steps when relevant." },
          { role: "user", content: context ? `${question}\n\nContext:\n${context}` : question },
        ],
      });
      return { answer: r.choices[0]?.message?.content || "No answer", confidence: 88 };
    } catch {
      // fall through
    }
  }

  return {
    answer: "I cannot answer that specific question right now. Configure OPENAI_API_KEY, or rephrase as 'Explain Section 16', 'Explain ITC eligibility', 'Why is invoice X mismatched?', etc.",
    confidence: 30,
  };
}
