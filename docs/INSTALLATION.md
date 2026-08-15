# Installation Guide

## 1. System Requirements

| Tool | Min version | Notes |
|------|-------------|-------|
| Node.js | 18 LTS | comes with npm |
| PostgreSQL | 13 | local or cloud |
| OpenAI API | — | get key at https://platform.openai.com |

## 2. Setup PostgreSQL

```bash
# Linux / macOS
sudo -u postgres psql
# Windows (use pgAdmin or psql)
```

```sql
CREATE DATABASE gst_ai;
CREATE USER gst_user WITH PASSWORD 'gst_pass';
GRANT ALL PRIVILEGES ON DATABASE gst_ai TO gst_user;
```

## 3. Backend

```bash
cd server
cp .env.example .env
npm install
npx prisma migrate dev --name init
npm run seed
npm run dev
```

### Environment (`.env`)
```ini
PORT=4000
DATABASE_URL="postgresql://gst_user:gst_pass@localhost:5432/gst_ai?schema=public"
JWT_SECRET="change-me-super-secret"
OPENAI_API_KEY="sk-..."
UPLOAD_DIR="./uploads"
REPORT_DIR="./reports"
GST_DIFF_THRESHOLD=50
```

If you do not want to call OpenAI during development, leave `OPENAI_API_KEY` empty — the AI service will fall back to a deterministic rule-based explainer so the app still works end-to-end.

## 4. Frontend

```bash
cd client
npm install
npm run dev
```

Open http://localhost:5173 and log in with the demo credentials listed in README.md.

## 5. Production build

```bash
cd server && npm run build && npm start
cd ../client && npm run build   # outputs to client/dist
```

A reverse proxy (nginx) can serve `client/dist` and proxy `/api` to the backend.

## 6. Troubleshooting

- **`Prisma can't reach database`** → check `DATABASE_URL`, ensure Postgres is running, and run `npx prisma db push` if migrations fail.
- **AI chat returns generic text** → `OPENAI_API_KEY` missing or invalid; app keeps working.
- **Port 4000 / 5173 already in use** → change `PORT` env / vite `server.port`.
