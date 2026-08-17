# GST AI Reconciliation Agent

A production-ready AI Agent that automatically reconciles India GST data from **Purchase Register, Sales Register, GSTR-2B, GSTR-3B, and GSTR-1** sources, detects mismatches in plain English, suggests corrections, and produces PDF + Excel reports.

---

## ✨ Features

- 📊 **Dashboard** — Total Purchase / Sales, Matched, Mismatched, Missing in 2B, Missing in Books, GST Difference, Vendor-wise summary, Report downloads.
- 📥 **Import Files** — Purchase Register (Excel), Sales Register (Excel), GSTR-2B JSON, GSTR-1 JSON, GSTR-3B Summary (Excel/JSON), GST Portal Excel.
- 🤖 **AI Reconciliation Engine** — Matches on GSTIN, Invoice No, Date, Taxable Value, CGST, SGST, IGST with **fuzzy matching** on invoice numbers. Detects missing, duplicate, wrong GSTIN, wrong tax, wrong date, wrong taxable value.
- 💡 **AI Suggestions** — For each mismatch, explains *what is wrong*, *possible reason*, and *suggested correction* in plain English with a confidence score.
- 📄 **Reports** — Match / Mismatch / Vendor Summary / Missing / Duplicate / GST Difference reports as **PDF** and **Excel**.
- 🏢 **Vendor Dashboard** — Vendor Name, GSTIN, Matched / Mismatch / Pending / Missing / Total GST.
- 🔎 **Smart Search** — By Invoice Number, GSTIN, or Vendor Name.
- 💬 **AI Chat Assistant** — Ask "Why is this invoice mismatched?", "How to fix GST difference?", "Explain Section 16", "Explain ITC eligibility", etc.
- 🔔 **Notifications** — New mismatch, vendor missing, GST difference exceeding threshold.
- 🔐 **Security** — JWT login, Role-Based Access (Admin / Accountant / Viewer).

---

## 🧱 Technology Stack

| Layer        | Tech                              |
|--------------|-----------------------------------|
| Frontend     | React + TypeScript + Tailwind CSS |
| Backend      | Node.js + Express + TypeScript    |
| Database     | PostgreSQL                        |
| ORM          | Prisma                            |
| AI           | OpenAI API (`gpt-4o-mini`)        |
| Excel         | `xlsx`                            |
| PDF          | `pdf-lib`                         |
| Auth         | JWT                               |
| File Storage | Local `uploads/` folder           |

---

## 📁 Folder Structure

```
gst-ai-agent/
├── client/                 # React + Tailwind frontend
│   └── src/
│       ├── api/            # API client wrappers
│       ├── components/      # Reusable UI components
│       └── pages/          # Dashboard, Reports, Vendors, Chat, Upload, Login
├── server/                # Express + Prisma backend
│   ├── prisma/            # schema.prisma + seed
│   ├── src/
│   │   ├── routes/        # Express routers
│   │   ├── controllers/   # Route handlers
│   │   ├── services/      # Business logic + reconciliation
│   │   ├── middleware/    # JWT auth + RBAC + error
│   │   ├── utils/         # logger, fuzzy, parsers
│   │   └── ai/            # OpenAI helpers
│   ├── uploads/           # Uploaded files
│   └── reports/           # Generated PDF + Excel
├── scripts/               # Sample-data + seeding helpers
├── docs/
│   ├── INSTALLATION.md
│   ├── API.md
│   └── SAMPLE_DATA.md
└── README.md
```

---

## 🚀 Quick Start

### Prerequisites
- Node.js >= 18
- SQLite (dev) or PostgreSQL >= 13 (production)
- OpenAI API key (optional — app falls back to offline rule-based mode)

### 1. Clone & install
```bash
git clone https://github.com/prashantaware85-svg/gst-ai-project.git
cd gst-ai-project

# Backend
cd server
cp .env.example .env       # fill in DATABASE_URL, JWT_SECRET, OPENAI_API_KEY
npm install
npx prisma migrate dev --name init
npm run seed               # creates demo users + sample invoices

# Frontend
cd ../client
npm install

# Sample-data generator (optional)
cd ../scripts && npm install
```

### 2. Run (development)
```bash
# Terminal A — backend
cd server && npm run dev      # http://localhost:4000

# Terminal B — frontend
cd client && npm run dev      # http://localhost:5173
```

Login with **demo users** (dev only — change passwords in seed):

| Role        | Email                | Password   |
|-------------|----------------------|------------|
| Admin       | `admin@gst.ai`        | `admin123` |
| Accountant  | `accountant@gst.ai`  | `acc123`   |
| Viewer      | `viewer@gst.ai`       | `view123`  |

---

## ⚙️ Environment Variables

### Server (`server/.env` — copy from `server/.env.example`)
| Variable | Required | Description |
|----------|:--------:|-------------|
| `PORT` | no | API port (default `4000`) |
| `NODE_ENV` | no | `development` / `production` |
| `DATABASE_URL` | yes | SQLite `file:./dev.db` (dev) or `postgresql://...` (prod) |
| `JWT_SECRET` | yes* | ≥16-char secret; **required in production**. Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `CORS_ORIGIN` | yes* | Comma-separated allowed browser origins |
| `OPENAI_API_KEY` | no | Empty → offline deterministic mode |
| `AI_CONCURRENCY` | no | Max parallel AI calls (default `5`) |
| `UPLOAD_DIR` / `REPORT_DIR` | no | File storage paths (default `./uploads` / `./reports`) |
| `GST_DIFF_THRESHOLD` | no | Rupee threshold for high-GST-diff notifications (default `50`) |
| `MATCH_TOLERANCE_*` | no | Matching tolerance: `RUPEES` (1), `PERCENT` (0.5), `DATE_TOLERANCE_DAYS` (1) |
| `GUEST_AUTH` | no | `true` → **read-only guest login** (frontend auto-login, skips the login screen). Works in any environment including production (default `false`) |

> ⚠️ **GUEST_AUTH SECURITY WARNING** — `GUEST_AUTH=true` lets anyone open the app without a password and browse GST data as a read-only **VIEWER** (dashboards, invoices, reports, vendors, notifications). In production this makes GST data readable by anyone who opens the site — only enable it if that exposure is acceptable (e.g. a demo deployment). The guest is always a real **VIEWER** user and can **never** call write endpoints: upload / reconcile / user-creation stay ADMIN/ACCOUNTANT-only and return `403` for the guest, and existing real-user JWT login is fully preserved. To revoke, set `GUEST_AUTH=false`.

### Client (`client/.env` — copy from `client/.env.example`)
| Variable | Required | Description |
|----------|:--------:|-------------|
| `VITE_API_URL` | no | Backend base URL with trailing slash. Unset → `/api` on same origin |

---

## 🧪 Testing

```bash
# Backend unit + reconciliation tests (Node built-in test runner via tsx)
cd server && npm test

# Type checks
cd server && npm run typecheck
cd client && npm run typecheck

# Production builds
cd server && npm run build        # -> server/dist
cd client && npm run build        # -> client/dist
```

38 tests cover GST math, GSTIN validation, fuzzy invoice matching, file parsers, purchase/sales reconciliation (matched, wrong-GSTIN/tax/date, missing in 2B/books, duplicates with correct 2B-aware ITC ownership, credit/debit notes) and report/CSV/DECIMAL handling.

---

## 🌍 Production Deployment Overview

1. **Database** — Provision PostgreSQL. Set production `DATABASE_URL` (add `?connection_limit=10` for pooling) and optionally `DIRECT_URL` for pooler deployments.
2. **Migrations** — Run the Postgres migration:
   ```bash
   cd server
   npm run prisma:generate:prod
   npm run prisma:deploy:prod    # applies prisma/prod/migrations
   ```
3. **Build** — `npm run build` in `server/` and `client/`.
4. **Env** — Set `NODE_ENV=production`, a strong `JWT_SECRET`, and `CORS_ORIGIN` to your public origin(s).
5. **Serve** — Run `npm start` in `server/` (serves API on `PORT`); serve `client/dist` behind any static host (reverse-proxy `/api` to the backend, or set `VITE_API_URL`).
6. **Storage** — Ensure `UPLOAD_DIR` and `REPORT_DIR` exist and are writable; keep them out of the repo.
7. **Security** — JWT auth, bcrypt password hashing, role-based access (Admin/Accountant/Viewer), CORS allow-list, per-route rate limiting, 20 MB upload limit with extension whitelist, and safe production error messages. No `.env` or generated files are ever committed.

---

## ☁️ Deploying to Render (single service)

A ready-to-use [`render.yaml`](render.yaml) Blueprint is included. It deploys ONE Web Service that serves both the Express API (`/api`, `/health`) **and** the built React client as static files (Express auto-detects `client/dist`).

1. **Push to GitHub**, then in Render: **New → Blueprint** and select this repo. Render provisions the service plus a 1 GB disk mounted at `/data` for `UPLOAD_DIR` / `REPORT_DIR`.
2. **Add secrets** (Render Dashboard → Environment) — never in `render.yaml`:
   - `DATABASE_URL` — your **PostgreSQL** URL, e.g. `postgresql://USER:PASSWORD@HOST:5432/gst_agent?connection_limit=10`
   - `JWT_SECRET` — ≥16 chars, generated value
   - `OPENAI_API_KEY` — optional (empty = offline deterministic mode)
   - `CORS_ORIGIN` — `https://<your-app>.onrender.com` (optional when same-origin)
3. **Migrations run automatically at boot** via `prisma migrate deploy --schema prisma/prod/schema.prisma`.
4. **Health check** — `GET /health` is pinged automatically by Render.
5. **First admin** — after deploy, create an admin (Render Shell, or locally against prod `DATABASE_URL`):
   ```bash
   cd server
   ADMIN_EMAIL=admin@company.com ADMIN_PASSWORD='<strong>' npm run bootstrap:admin
   ```
6. **Alternative (split services)** — serve `client/dist` as a static site (set `VITE_API_URL` at client build time) and point it at the API service.

---

## 📦 API Endpoints

See **[`docs/API.md`](docs/API.md)** for the complete list. Highlights:

```
POST /api/auth/login
POST /api/upload/purchase
POST /api/upload/sales
POST /api/upload/gstr2b
POST /api/upload/gstr1
POST /api/upload/gstr3b
POST /api/reconcile
GET  /api/dashboard
GET  /api/reports?format=pdf|xlsx&type=match|mismatch|...
GET  /api/vendors
GET  /api/search?q=
POST /api/chat
```

---

## 🤖 AI Rules

1. Always explain mismatches in **plain English**.
2. **Never guess** GST values — flag missing inputs.
3. Highlight a **confidence score** (0–100) on every suggestion.
4. Generate a top-line **reconciliation summary** after each run.

---

## 🔐 Roles

| Endpoint group | Admin | Accountant | Viewer |
|----------------|:-----:|:----------:|:------:|
| Read dashboard/reports | ✅ | ✅ | ✅ |
| Upload files           | ✅ | ✅ | ❌ |
| Run reconciliation     | ✅ | ✅ | ❌ |
| Manage users           | ✅ | ❌ | ❌ |

---

See **[`docs/INSTALLATION.md`](docs/INSTALLATION.md)**, **[`docs/API.md`](docs/API.md)**, and **[`docs/SAMPLE_DATA.md`](docs/SAMPLE_DATA.md)** for full details.
