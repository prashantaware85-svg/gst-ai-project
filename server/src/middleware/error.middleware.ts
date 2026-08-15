import { Request, Response, NextFunction } from "express";
import multer from "multer";
import { logger } from "../utils/logger";

export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof multer.MulterError) {
    const message = err.code === "LIMIT_FILE_SIZE" ? "File too large (max 20MB)" : err.message;
    return res.status(400).json({ error: "BadRequest", message });
  }
  if ((err as any).code === "UNSUPPORTED_FILE_TYPE") {
    return res.status(400).json({ error: "BadRequest", message: err.message });
  }
  // express.json() body-parser errors carry their own HTTP status (413, 400).
  if ((err as any).type === "entity.too.large") {
    return res.status(413).json({ error: "PayloadTooLarge", message: "Request body too large" });
  }
  if ((err as any).type === "entity.parse.failed") {
    return res.status(400).json({ error: "BadRequest", message: "Malformed JSON body" });
  }
  logger.error(err.message, err.stack);
  // Never leak internal error details to clients in production.
  const message = process.env.NODE_ENV === "production" ? "Internal server error" : err.message;
  return res.status(500).json({ error: "InternalServerError", message });
}
