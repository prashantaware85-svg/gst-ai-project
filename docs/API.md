# API Documentation

Base URL: `http://localhost:4000/api`

All protected endpoints require header:
```
Authorization: Bearer <jwt>
```

---

## Auth

### POST /auth/login
```json
{ "email": "admin@gst.ai", "password": "admin123" }
```
Response:
```json
{ "token": "...", "user": { "id": 1, "name": "Admin", "role": "ADMIN" } }
```

### GET /auth/me
Returns the currently logged-in user.

### POST /auth/users *(ADMIN)*
Create a new user.
```json
{ "name": "...", "email": "...", "password": "...", "role": "VIEWER|ACCOUNTANT|ADMIN" }
```

### GET /auth/users *(ADMIN)*
List users.

---

## Upload

All upload endpoints accept `multipart/form-data` with a `file` field. Require ACCOUNTANT or ADMIN role.

| Endpoint | Accepted formats | Stored as |
|----------|------------------|-----------|
| POST /upload/purchase  | `.xlsx`, `.csv`        | `PURCHASE` |
| POST /upload/sales     | `.xlsx`, `.csv`        | `SALES`    |
| POST /upload/gstr2b    | `.json`                | `GSTR2B`   |
| POST /upload/gstr1     | `.json`                | `GSTR1`    |
| POST /upload/gstr3b    | `.xlsx`, `.json`       | `GSTR3B`   |
| POST /upload/gstportal | `.xlsx`                | `PORTAL`   |

Response:
```json
{ "ok": true, "count": 42, "source": "PURCHASE", "fileId": 7 }
```

---

## Reconciliation

### POST /reconcile *(ACCOUNTANT, ADMIN)*
Triggers an AI reconciliation run across the latest uploaded sources.

Response:
```json
{
  "runId": 12,
  "summary": {
    "totalPurchase": 1825000,
    "totalSales": 1640000,
    "matched": 38,
    "mismatched": 7,
    "missingIn2B": 4,
    "missingInBooks": 3,
    "gstDifference": 2150,
    "vendors": 6
  },
  "aiSummary": "..."
}
```

---

## Dashboard

### GET /dashboard
Returns latest reconciliation summary plus vendor-wise breakdown.

```json
{
  "summary": { ...same as above },
  "vendors": [
    { "vendorName": "Acme Pvt Ltd", "gstin": "27ABCDE1234F1Z5",
      "matched": 5, "mismatch": 2, "pending": 1, "missing": 0,
      "totalGst": 184500 }
  ],
  "recentMismatches": [ {...invoice...} ]
}
```

---

## Reports

### GET /reports
Query params:
| Param | Values                                                  |
|-------|---------------------------------------------------------|
| type  | `match`/`mismatch`/`vendor`/`missing`/`duplicate`/`gst`  |
| format| `json`(default)/`xlsx`/`pdf`                             |

`json` returns an array of rows. `xlsx` and `pdf` return a file download.

---

## Vendors

### GET /vendors
Vendor-wise rollup (matched, mismatch, pending, missing, totalGst).

---

## Smart Search

### GET /search?q=
Searches across invoices by invoice number, GSTIN, or vendor name substring.

---

## Chat

### POST /chat
```json
{ "question": "Why is invoice INV-204 mismatched?",
  "invoiceNo": "INV-204" }
```
Response:
```json
{ "answer": "...", "confidence": 92 }
```

The assistant:
- Auto-loads context (matched invoice, mismatch reasons) when an invoice number is provided.
- Falls back to general GST knowledge for generic questions ("Explain Section 16", "Explain ITC eligibility").
- Always includes a confidence score.

---

## Notifications

### GET /notifications
List notifications generated after each reconciliation run:
- `MISMATCH_DETECTED`
- `VENDOR_MISSING`
- `GST_DIFF_THRESHOLD_BREACHED`

### POST /notifications/:id/read *(any role for own, ADMIN for any)*
Mark a notification read.

---

## Error format

```json
{ "error": "Unauthorized", "message": "Invalid or expired token" }
```

HTTP codes used: 200, 201, 400, 401, 403, 404, 500.
