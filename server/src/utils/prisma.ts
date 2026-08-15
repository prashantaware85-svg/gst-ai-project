import { PrismaClient } from "@prisma/client";
import { logger } from "./logger";

// Single PrismaClient for the whole process. Prisma manages its own connection
// pool (default pool_size is based on the provider; Postgres honours
// `?connection_limit=` in DATABASE_URL for tuning). Graceful shutdown lets an
// in-flight reconcile finish before the pool is closed.
export const prisma = new PrismaClient({
  log: process.env.NODE_ENV === "production"
    ? ["warn", "error"]
    : ["warn", "error"],
});

prisma
  .$connect()
  .then(() => logger.info("Database connection established"))
  .catch((e) => {
    logger.error("Database connection failed", e);
    process.exit(1);
  });

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`Received ${signal}, closing database pool`);
  await prisma.$disconnect();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));