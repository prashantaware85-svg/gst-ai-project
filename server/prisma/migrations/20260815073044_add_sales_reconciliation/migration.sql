-- CreateTable
CREATE TABLE "SalesReconciliationResult" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "runId" INTEGER NOT NULL,
    "salesInvoiceId" INTEGER NOT NULL,
    "gstr1InvoiceId" INTEGER,
    "status" TEXT NOT NULL,
    "confidence" INTEGER NOT NULL,
    "mismatchTypes" TEXT NOT NULL,
    "bookInvoiceNo" TEXT NOT NULL,
    "bookGstin" TEXT NOT NULL,
    "gstr1InvoiceNo" TEXT,
    "gstr1Gstin" TEXT,
    "customerName" TEXT,
    "bookDate" DATETIME,
    "gstr1Date" DATETIME,
    "invoiceNoDiff" TEXT,
    "dateDiff" TEXT,
    "bookTaxable" REAL NOT NULL,
    "gstr1Taxable" REAL,
    "taxableDiff" REAL NOT NULL DEFAULT 0,
    "bookTax" REAL NOT NULL,
    "gstr1Tax" REAL,
    "gstDiff" REAL NOT NULL DEFAULT 0,
    "itcEligible" REAL NOT NULL DEFAULT 0,
    "itcPending" REAL NOT NULL DEFAULT 0,
    "aiWhat" TEXT,
    "aiReason" TEXT,
    "aiAction" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ReconciliationResult" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "runId" INTEGER NOT NULL,
    "bookInvoiceId" INTEGER NOT NULL,
    "twoBInvoiceId" INTEGER,
    "status" TEXT NOT NULL,
    "confidence" INTEGER NOT NULL,
    "mismatchTypes" TEXT NOT NULL,
    "bookInvoiceNo" TEXT NOT NULL,
    "bookGstin" TEXT NOT NULL,
    "twoBInvoiceNo" TEXT,
    "twoBGstin" TEXT,
    "vendorName" TEXT,
    "bookDate" DATETIME,
    "twoBDate" DATETIME,
    "invoiceNoDiff" TEXT,
    "dateDiff" TEXT,
    "bookTaxable" REAL NOT NULL,
    "twoBTaxable" REAL,
    "taxableDiff" REAL NOT NULL DEFAULT 0,
    "bookTax" REAL NOT NULL,
    "twoBTax" REAL,
    "gstDiff" REAL NOT NULL,
    "itcEligible" REAL NOT NULL DEFAULT 0,
    "itcPending" REAL NOT NULL DEFAULT 0,
    "aiWhat" TEXT,
    "aiReason" TEXT,
    "aiAction" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_ReconciliationResult" ("aiAction", "aiReason", "aiWhat", "bookDate", "bookGstin", "bookInvoiceId", "bookInvoiceNo", "bookTax", "bookTaxable", "confidence", "createdAt", "dateDiff", "gstDiff", "id", "invoiceNoDiff", "itcEligible", "itcPending", "mismatchTypes", "runId", "status", "taxableDiff", "twoBDate", "twoBGstin", "twoBInvoiceId", "twoBInvoiceNo", "twoBTax", "twoBTaxable", "vendorName") SELECT "aiAction", "aiReason", "aiWhat", "bookDate", "bookGstin", "bookInvoiceId", "bookInvoiceNo", "bookTax", "bookTaxable", "confidence", "createdAt", "dateDiff", "gstDiff", "id", "invoiceNoDiff", "itcEligible", "itcPending", "mismatchTypes", "runId", "status", "taxableDiff", "twoBDate", "twoBGstin", "twoBInvoiceId", "twoBInvoiceNo", "twoBTax", "twoBTaxable", "vendorName" FROM "ReconciliationResult";
DROP TABLE "ReconciliationResult";
ALTER TABLE "new_ReconciliationResult" RENAME TO "ReconciliationResult";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "SalesReconciliationResult_runId_status_idx" ON "SalesReconciliationResult"("runId", "status");
