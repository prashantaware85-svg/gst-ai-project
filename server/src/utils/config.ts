// Centralised security configuration. Keeps JWT/CORS handling consistent
// across the app and fails fast in production when secrets are weak/missing
// instead of silently falling back to a hard-coded dev secret.

const isProd = process.env.NODE_ENV === "production";

export function jwtSecret(): string {
  const s = process.env.JWT_SECRET || "";
  if (s.trim()) {
    if (s.replace(/[^a-zA-Z0-9]/g, "").length < 16) {
      throw new Error("JWT_SECRET must be at least 16 characters long");
    }
    return s;
  }
  if (isProd) throw new Error("JWT_SECRET is required in production");
  return "dev-only-insecure-secret-please-change";
}

export function corsOrigins(): string[] {
  const raw = process.env.CORS_ORIGIN || "http://localhost:5173,http://localhost:4173";
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

export function isProdEnv(): boolean {
  return isProd;
}