-- CreateTable
CREATE TABLE "GstImportBatch" (
    "id" SERIAL NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'GST',
    "returnType" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "fromDate" TIMESTAMP(3),
    "toDate" TIMESTAMP(3),
    "totalRows" INTEGER NOT NULL DEFAULT 0,
    "validRows" INTEGER NOT NULL DEFAULT 0,
    "invalidRows" INTEGER NOT NULL DEFAULT 0,
    "duplicateRows" INTEGER NOT NULL DEFAULT 0,
    "importedRows" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GstImportBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GstTransaction" (
    "id" SERIAL NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'GST',
    "returnType" TEXT NOT NULL,
    "gstin" TEXT,
    "counterpartyGstin" TEXT,
    "counterpartyName" TEXT,
    "invoiceNumber" TEXT NOT NULL,
    "invoiceDate" TIMESTAMP(3) NOT NULL,
    "taxableValue" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "cgst" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "sgst" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "igst" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "invoiceValue" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "placeOfSupply" TEXT,
    "hsn" TEXT,
    "documentType" TEXT,
    "period" TEXT NOT NULL,
    "importBatchId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GstTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GstReconciliationRun" (
    "id" SERIAL NOT NULL,
    "period" TEXT NOT NULL,
    "transactionType" TEXT NOT NULL,
    "totalTally" INTEGER NOT NULL DEFAULT 0,
    "totalGst" INTEGER NOT NULL DEFAULT 0,
    "matched" INTEGER NOT NULL DEFAULT 0,
    "amountMismatch" INTEGER NOT NULL DEFAULT 0,
    "dateMismatch" INTEGER NOT NULL DEFAULT 0,
    "invoiceNumberMismatch" INTEGER NOT NULL DEFAULT 0,
    "gstinMismatch" INTEGER NOT NULL DEFAULT 0,
    "missingInGst" INTEGER NOT NULL DEFAULT 0,
    "missingInTally" INTEGER NOT NULL DEFAULT 0,
    "duplicateInTally" INTEGER NOT NULL DEFAULT 0,
    "duplicateInGst" INTEGER NOT NULL DEFAULT 0,
    "possibleMatch" INTEGER NOT NULL DEFAULT 0,
    "invalidData" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GstReconciliationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GstReconciliationResult" (
    "id" SERIAL NOT NULL,
    "runId" INTEGER NOT NULL,
    "period" TEXT NOT NULL,
    "transactionType" TEXT NOT NULL,
    "tallyTransactionId" INTEGER,
    "gstTransactionId" INTEGER,
    "status" TEXT NOT NULL,
    "matchLevel" TEXT,
    "confidence" INTEGER NOT NULL,
    "taxableDifference" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "cgstDifference" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "sgstDifference" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "igstDifference" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "invoiceValueDifference" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "reason" TEXT,
    "reviewStatus" TEXT,
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GstReconciliationResult_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GstImportBatch_returnType_idx" ON "GstImportBatch"("returnType");

-- CreateIndex
CREATE INDEX "GstImportBatch_period_idx" ON "GstImportBatch"("period");

-- CreateIndex
CREATE INDEX "GstImportBatch_createdAt_idx" ON "GstImportBatch"("createdAt");

-- CreateIndex
CREATE INDEX "GstTransaction_gstin_idx" ON "GstTransaction"("gstin");

-- CreateIndex
CREATE INDEX "GstTransaction_counterpartyGstin_idx" ON "GstTransaction"("counterpartyGstin");

-- CreateIndex
CREATE INDEX "GstTransaction_invoiceNumber_idx" ON "GstTransaction"("invoiceNumber");

-- CreateIndex
CREATE INDEX "GstTransaction_invoiceDate_idx" ON "GstTransaction"("invoiceDate");

-- CreateIndex
CREATE INDEX "GstTransaction_returnType_idx" ON "GstTransaction"("returnType");

-- CreateIndex
CREATE INDEX "GstTransaction_period_idx" ON "GstTransaction"("period");

-- CreateIndex
CREATE INDEX "GstTransaction_period_returnType_idx" ON "GstTransaction"("period", "returnType");

-- CreateIndex
CREATE UNIQUE INDEX "GstTransaction_returnType_period_counterpartyGstin_invoiceNumber_invoiceDate_key" ON "GstTransaction"("returnType", "period", "counterpartyGstin", "invoiceNumber", "invoiceDate");

-- CreateIndex
CREATE INDEX "GstReconciliationRun_period_transactionType_idx" ON "GstReconciliationRun"("period", "transactionType");

-- CreateIndex
CREATE INDEX "GstReconciliationRun_createdAt_idx" ON "GstReconciliationRun"("createdAt");

-- CreateIndex
CREATE INDEX "GstReconciliationResult_runId_idx" ON "GstReconciliationResult"("runId");

-- CreateIndex
CREATE INDEX "GstReconciliationResult_runId_status_idx" ON "GstReconciliationResult"("runId", "status");

-- CreateIndex
CREATE INDEX "GstReconciliationResult_period_transactionType_idx" ON "GstReconciliationResult"("period", "transactionType");

-- CreateIndex
CREATE INDEX "GstReconciliationResult_status_idx" ON "GstReconciliationResult"("status");

-- CreateIndex
CREATE INDEX "GstReconciliationResult_reviewStatus_idx" ON "GstReconciliationResult"("reviewStatus");

-- AddForeignKey
ALTER TABLE "GstTransaction" ADD CONSTRAINT "GstTransaction_importBatchId_fkey" FOREIGN KEY ("importBatchId") REFERENCES "GstImportBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GstReconciliationResult" ADD CONSTRAINT "GstReconciliationResult_runId_fkey" FOREIGN KEY ("runId") REFERENCES "GstReconciliationRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
