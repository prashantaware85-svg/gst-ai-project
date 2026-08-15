import { Request, Response, NextFunction } from "express";

// Lightweight sliding-window rate limiter, keyed by client IP + message/route.
// Dependency-free so the server gains no new runtime deps. In-memory only —
// fine for single-instance dev/deploy, and applied to the sensitive endpoints
// (login, reconcile, upload, chat).

interface Bucket {
  timestamps: number[];
}

const buckets = new Map<string, Bucket>();

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  message: string;
}

export function rateLimit(opts: RateLimitOptions) {
  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    const key = `${opts.message}|${ip}`;

    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { timestamps: [] };
      buckets.set(key, bucket);
    }
    bucket.timestamps = bucket.timestamps.filter((t) => now - t < opts.windowMs);

    if (bucket.timestamps.length >= opts.max) {
      return res.status(429).json({ error: "TooManyRequests", message: opts.message });
    }

    bucket.timestamps.push(now);

    // Prevent unbounded growth of the map in long-running processes.
    if (buckets.size > 10_000) buckets.clear();

    next();
  };
}