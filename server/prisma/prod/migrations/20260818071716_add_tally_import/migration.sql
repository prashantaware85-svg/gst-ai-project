-- CreateTable
CREATE TABLE "TallyImport" (
    "id" SERIAL NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'TALLY',
    "voucherType" TEXT NOT NULL,
    "voucherNumber" TEXT NOT NULL,
    "voucherDate" TIMESTAMP(3) NOT NULL,
    "partyName" TEXT,
    "partyGSTIN" TEXT,
    "invoiceNumber" TEXT,
    "taxableValue" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "cgst" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "sgst" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "igst" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "roundOff" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "totalAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "items" TEXT NOT NULL DEFAULT '[]',
    "companyName" TEXT,
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TallyImport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TallyImportRun" (
    "id" SERIAL NOT NULL,
    "voucherType" TEXT NOT NULL,
    "fromDate" TIMESTAMP(3) NOT NULL,
    "toDate" TIMESTAMP(3) NOT NULL,
    "imported" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "companyName" TEXT,
    "ranAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TallyImportRun_pkey" PRIMARY KEY ("id")
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
