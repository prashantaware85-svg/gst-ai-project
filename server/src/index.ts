import "dotenv/config";
import express from "express";
import cors from "cors";
import { authRouter } from "./routes/auth.routes";
import { uploadRouter } from "./routes/upload.routes";
import { reconcileRouter } from "./routes/reconcile.routes";
import { dashboardRouter } from "./routes/dashboard.routes";
import { reportsRouter } from "./routes/reports.routes";
import { vendorsRouter } from "./routes/vendors.routes";
import { searchRouter } from "./routes/search.routes";
import { chatRouter } from "./routes/chat.routes";
import { notificationsRouter } from "./routes/notifications.routes";
import { errorHandler } from "./middleware/error.middleware";
import { logger } from "./utils/logger";
import { ensureDirs } from "./utils/fs";
import { corsOrigins } from "./utils/config";

const app = express();

ensureDirs([
  process.env.UPLOAD_DIR || "./uploads",
  process.env.REPORT_DIR || "./reports",
]);

app.use(cors({
  origin: corsOrigins(),
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));
app.disable("x-powered-by");
app.use(express.json({ limit: "2mb" }));
app.use("/api", authRouter);
app.use("/api", uploadRouter);
app.use("/api", reconcileRouter);
app.use("/api", dashboardRouter);
app.use("/api", reportsRouter);
app.use("/api", vendorsRouter);
app.use("/api", searchRouter);
app.use("/api", chatRouter);
app.use("/api", notificationsRouter);

app.get("/health", (_req, res) => res.json({ ok: true }));

app.use(errorHandler);

const PORT = Number(process.env.PORT || 4000);
app.listen(PORT, () => logger.info(`GST AI Agent server on http://localhost:${PORT}`));