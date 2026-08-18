import "dotenv/config";
import express from "express";
import cors from "cors";
import fs from "node:fs";
import path from "node:path";
import { authRouter } from "./routes/auth.routes";
import { uploadRouter } from "./routes/upload.routes";
import { reconcileRouter } from "./routes/reconcile.routes";
import { dashboardRouter } from "./routes/dashboard.routes";
import { reportsRouter } from "./routes/reports.routes";
import { vendorsRouter } from "./routes/vendors.routes";
import { searchRouter } from "./routes/search.routes";
import { chatRouter } from "./routes/chat.routes";
import { notificationsRouter } from "./routes/notifications.routes";
import { tallyRouter } from "./routes/tally.routes";
import { gstRouter } from "./routes/gst.routes";
import { reconciliationRouter } from "./routes/reconciliation.routes";
import { errorHandler } from "./middleware/error.middleware";
import { logger } from "./utils/logger";
import { ensureDirs } from "./utils/fs";
import { corsOrigins, guestAuthEnabled } from "./utils/config";

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
app.use("/api", tallyRouter);
app.use("/api", gstRouter);
app.use("/api", reconciliationRouter);

app.get("/health", (_req, res) => res.json({ ok: true, guestAuth: guestAuthEnabled() }));

// Static frontend (single-service Render deployment). Serves the built
// client whenever it exists, with an SPA fallback to index.html. API + /health
// are registered above, so they always win over the catch-all.
function staticDirCandidates(): string[] {
  return [
    process.env.STATIC_DIR,
    path.resolve(__dirname, "../../../client/dist"), // compiled: server/dist/src
    path.resolve(process.cwd(), "client/dist"),       // started from repo root
    path.resolve(process.cwd(), "../client/dist"),    // started from server/
  ].filter((p): p is string => Boolean(p));
}

const staticDir = staticDirCandidates().find((dir) => fs.existsSync(path.join(dir, "index.html")));
if (staticDir) {
  app.use(express.static(staticDir));
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api") || req.path === "/health") return next();
    res.sendFile(path.join(staticDir, "index.html"));
  });
  logger.info(`Serving static client from ${staticDir}`);
}

app.use(errorHandler);

const PORT = Number(process.env.PORT || 4000);
const HOST = process.env.HOST || "0.0.0.0";
const server = app.listen(PORT, HOST, () =>
  logger.info(`GST AI Agent server on http://${HOST}:${PORT}`),
);

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    logger.error(`Port ${PORT} already in use`);
    process.exit(1);
  }
  throw err;
});