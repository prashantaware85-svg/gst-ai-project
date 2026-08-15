-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Invoice" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "source" TEXT NOT NULL,
    "gstin" TEXT NOT NULL,
    "vendorName" TEXT,
    "invoiceNo" TEXT NOT NULL,
    "invoiceDate" DATETIME NOT NULL,
    "taxableValue" REAL NOT NULL,
    "cgst" REAL NOT NULL DEFAULT 0,
    "sgst" REAL NOT NULL DEFAULT 0,
    "igst" REAL NOT NULL DEFAULT 0,
    "cess" REAL NOT NULL DEFAULT 0,
    "totalGst" REAL NOT NULL DEFAULT 0,
    "invoiceValue" REAL NOT NULL DEFAULT 0,
    "noteType" TEXT,
    "uploadId" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_Invoice" ("cgst", "createdAt", "gstin", "id", "igst", "invoiceDate", "invoiceNo", "invoiceValue", "sgst", "source", "taxableValue", "totalGst", "uploadId", "vendorName") SELECT "cgst", "createdAt", "gstin", "id", "igst", "invoiceDate", "invoiceNo", "invoiceValue", "sgst", "source", "taxableValue", "totalGst", "uploadId", "vendorName" FROM "Invoice";
DROP TABLE "Invoice";
ALTER TABLE "new_Invoice" RENAME TO "Invoice";
CREATE INDEX "Invoice_source_gstin_invoiceNo_idx" ON "Invoice"("source", "gstin", "invoiceNo");
CREATE INDEX "Invoice_source_gstin_idx" ON "Invoice"("source", "gstin");
CREATE INDEX "Invoice_source_invoiceNo_idx" ON "Invoice"("source", "invoiceNo");
CREATE INDEX "Invoice_invoiceNo_idx" ON "Invoice"("invoiceNo");
CREATE INDEX "Invoice_gstin_idx" ON "Invoice"("gstin");
CREATE INDEX "Invoice_invoiceDate_idx" ON "Invoice"("invoiceDate");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
