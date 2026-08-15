import { Router } from "express";
import { runReconciliation } from "../services/reconciliation.service";
import { authenticate, authorize } from "../middleware/auth.middleware";
import { rateLimit } from "../middleware/rate-limit.middleware";

export const reconcileRouter = Router();

// Reconcile is a heavy DB + AI workload; throttle it per client.
const reconcileLimiter = rateLimit({ windowMs: 60_000, max: 10, message: "Too many reconciliation runs. Try again shortly." });

reconcileRouter.post("/reconcile", reconcileLimiter, authenticate, authorize("ADMIN", "ACCOUNTANT"), async (_req, res) => {
  try {
    const out = await runReconciliation();
    return res.json(out);
  } catch (e: any) {
    return res.status(500).json({ error: "ReconcileError", message: e.message });
  }
});
