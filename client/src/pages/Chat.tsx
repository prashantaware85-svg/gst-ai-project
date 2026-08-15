import { useState } from "react";
import { api } from "../api/client";
import { Card } from "../components/ui";

const QUICK = [
  "Explain Section 16",
  "Explain ITC eligibility",
  "Why is invoice GLBX-101 mismatched?",
  "How to fix GST difference?",
  "Suggest next action for missing in 2B",
];

export default function Chat() {
  const [history, setHistory] = useState<{ q: string; a: string; conf: number }[]>([]);
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);

  const ask = async (qText?: string) => {
    const text = (qText ?? question).trim();
    if (!text) return;
    setQuestion("");
    setLoading(true);
    try {
      // Try and extract an invoice number, e.g. "GLBX-101"
      const m = text.match(/\b([A-Z]{2,5}-?\d{2,4})\b/i);
      const d = await api.chat(text, m?.[1]);
      setHistory((h) => [...h, { q: text, a: d.answer, conf: d.confidence }]);
    } finally { setLoading(false); }
  };

  return (
    <div className="space-y-4 max-w-3xl">
      <h1 className="text-xl font-semibold">AI Chat Assistant</h1>
      <Card className="p-4">
        <div className="flex flex-wrap gap-2 mb-3">
          {QUICK.map((q) => (
            <button key={q} onClick={() => ask(q)}
              className="text-xs bg-gray-100 dark:bg-gray-700 px-2 py-1 rounded">{q}</button>
          ))}
        </div>
        <div className="space-y-3 max-h-96 overflow-auto mb-3">
          {history.length === 0 && <div className="text-gray-500 text-sm">Ask something like "Explain Section 16" or "Why is invoice ACME-003 mismatched?"</div>}
          {history.map((h, i) => (
            <div key={i} className="space-y-1">
              <div className="bg-brand-600 text-white inline-block px-3 py-1.5 rounded max-w-full">{h.q}</div>
              <div className="bg-gray-100 dark:bg-gray-700 px-3 py-2 rounded inline-block max-w-full">
                <div className="text-[10px] text-gray-500 dark:text-gray-400 mb-1">Confidence {h.conf}%</div>
                <div className="whitespace-pre-line text-sm">{h.a}</div>
              </div>
            </div>
          ))}
        </div>
        <div className="flex gap-2">
          <input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && ask()}
            placeholder="Type your question"
            className="flex-1 px-3 py-2 border rounded dark:bg-gray-700 dark:border-gray-600"
          />
          <button onClick={() => ask()} disabled={loading} className="bg-brand-600 text-white px-4 rounded disabled:opacity-50">
            {loading ? "..." : "Ask"}
          </button>
        </div>
      </Card>
    </div>
  );
}
