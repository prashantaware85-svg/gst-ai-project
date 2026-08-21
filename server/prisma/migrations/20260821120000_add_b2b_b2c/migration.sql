-- AlterTable
ALTER TABLE "GstReconciliationRun" ADD COLUMN "b2b" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "GstReconciliationRun" ADD COLUMN "b2c" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "GstReconciliationResult" ADD COLUMN "type" TEXT;
