-- CreateTable
CREATE TABLE "User" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'VIEWER',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Upload" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "fileName" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "rows" INTEGER NOT NULL,
    "filePath" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Invoice" (
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
    "totalGst" REAL NOT NULL DEFAULT 0,
    "invoiceValue" REAL NOT NULL DEFAULT 0,
    "uploadId" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "ReconciliationResult" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "runId" INTEGER NOT NULL,
    "bookInvoiceId" INTEGER NOT NULL,
    "twoBInvoiceId" INTEGER,
    "status" TEXT NOT NULL,
    "confidence" INTEGER NOT NULL,
    "mismatchTypes" TEXT NOT NULL DEFAULT '',
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

-- CreateTable
CREATE TABLE "Notification" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "Invoice_source_gstin_invoiceNo_idx" ON "Invoice"("source", "gstin", "invoiceNo");

-- CreateIndex
CREATE INDEX "Invoice_invoiceNo_idx" ON "Invoice"("invoiceNo");
