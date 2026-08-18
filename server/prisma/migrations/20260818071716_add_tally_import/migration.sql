-- CreateTable
CREATE TABLE "TallyImport" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "source" TEXT NOT NULL DEFAULT 'TALLY',
    "voucherType" TEXT NOT NULL,
    "voucherNumber" TEXT NOT NULL,
    "voucherDate" DATETIME NOT NULL,
    "partyName" TEXT,
    "partyGSTIN" TEXT,
    "invoiceNumber" TEXT,
    "taxableValue" DECIMAL NOT NULL DEFAULT 0,
    "cgst" DECIMAL NOT NULL DEFAULT 0,
    "sgst" DECIMAL NOT NULL DEFAULT 0,
    "igst" DECIMAL NOT NULL DEFAULT 0,
    "roundOff" DECIMAL NOT NULL DEFAULT 0,
    "totalAmount" DECIMAL NOT NULL DEFAULT 0,
    "items" TEXT NOT NULL DEFAULT '[]',
    "companyName" TEXT,
    "importedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "TallyImportRun" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "voucherType" TEXT NOT NULL,
    "fromDate" DATETIME NOT NULL,
    "toDate" DATETIME NOT NULL,
    "imported" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "companyName" TEXT,
    "ranAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "TallyImport_voucherType_voucherDate_idx" ON "TallyImport"("voucherType", "voucherDate");

-- CreateIndex
CREATE INDEX "TallyImport_source_idx" ON "TallyImport"("source");

-- CreateIndex
CREATE INDEX "TallyImport_importedAt_idx" ON "TallyImport"("importedAt");

-- CreateIndex
CREATE UNIQUE INDEX "TallyImport_companyName_voucherType_voucherNumber_voucherDate_key" ON "TallyImport"("companyName", "voucherType", "voucherNumber", "voucherDate");

-- CreateIndex
CREATE INDEX "TallyImportRun_ranAt_idx" ON "TallyImportRun"("ranAt");
