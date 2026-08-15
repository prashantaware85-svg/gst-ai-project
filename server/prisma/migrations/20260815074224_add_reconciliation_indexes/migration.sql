-- CreateIndex
CREATE INDEX "Invoice_source_gstin_idx" ON "Invoice"("source", "gstin");

-- CreateIndex
CREATE INDEX "Invoice_source_invoiceNo_idx" ON "Invoice"("source", "invoiceNo");

-- CreateIndex
CREATE INDEX "Invoice_gstin_idx" ON "Invoice"("gstin");

-- CreateIndex
CREATE INDEX "Invoice_invoiceDate_idx" ON "Invoice"("invoiceDate");

-- CreateIndex
CREATE INDEX "Notification_userId_read_idx" ON "Notification"("userId", "read");

-- CreateIndex
CREATE INDEX "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_type_idx" ON "Notification"("type");

-- CreateIndex
CREATE INDEX "ReconciliationResult_runId_idx" ON "ReconciliationResult"("runId");

-- CreateIndex
CREATE INDEX "ReconciliationResult_runId_status_idx" ON "ReconciliationResult"("runId", "status");

-- CreateIndex
CREATE INDEX "ReconciliationResult_runId_bookGstin_idx" ON "ReconciliationResult"("runId", "bookGstin");

-- CreateIndex
CREATE INDEX "ReconciliationResult_runId_twoBGstin_idx" ON "ReconciliationResult"("runId", "twoBGstin");

-- CreateIndex
CREATE INDEX "ReconciliationResult_runId_vendorName_idx" ON "ReconciliationResult"("runId", "vendorName");

-- CreateIndex
CREATE INDEX "ReconciliationResult_runId_bookInvoiceNo_idx" ON "ReconciliationResult"("runId", "bookInvoiceNo");

-- CreateIndex
CREATE INDEX "ReconciliationResult_status_idx" ON "ReconciliationResult"("status");

-- CreateIndex
CREATE INDEX "SalesReconciliationResult_runId_idx" ON "SalesReconciliationResult"("runId");

-- CreateIndex
CREATE INDEX "SalesReconciliationResult_runId_bookGstin_idx" ON "SalesReconciliationResult"("runId", "bookGstin");

-- CreateIndex
CREATE INDEX "SalesReconciliationResult_runId_gstr1Gstin_idx" ON "SalesReconciliationResult"("runId", "gstr1Gstin");

-- CreateIndex
CREATE INDEX "SalesReconciliationResult_runId_customerName_idx" ON "SalesReconciliationResult"("runId", "customerName");

-- CreateIndex
CREATE INDEX "SalesReconciliationResult_runId_bookInvoiceNo_idx" ON "SalesReconciliationResult"("runId", "bookInvoiceNo");

-- CreateIndex
CREATE INDEX "SalesReconciliationResult_status_idx" ON "SalesReconciliationResult"("status");
