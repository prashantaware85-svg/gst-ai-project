import multer from "multer";
import fs from "node:fs";
import path from "node:path";

const uploadDir = process.env.UPLOAD_DIR || "./uploads";
fs.mkdirSync(path.resolve(uploadDir), { recursive: true });

const ALLOWED_EXTENSIONS = new Set([".xlsx", ".xls", ".csv", ".json"]);

function extOf(file: Express.Multer.File): string {
  return path.extname(file.originalname).toLowerCase();
}

export const uploader = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir),
    filename: (_req, file, cb) => {
      const stamp = Date.now();
      const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
      cb(null, `${stamp}-${safe}`);
    },
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = extOf(file);
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      const err: any = new Error(`Unsupported file type "${ext}". Allowed: xlsx, xls, csv, json`);
      err.code = "UNSUPPORTED_FILE_TYPE";
      return cb(err);
    }
    cb(null, true);
  },
});

export { ALLOWED_EXTENSIONS, extOf };