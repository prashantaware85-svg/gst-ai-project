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

// Controlled guest login (demo or production). Enabled ONLY when the operator
// explicitly sets GUEST_AUTH=true. The guest is always a real, read-only
// VIEWER user, so even a production deployment stays read-only: upload /
// reconcile / user-creation remain ADMIN/ACCOUNTANT-only and the guest gets
// 403 on every write endpoint. Reads the live environment on every call;
// anything else means guest access is off.
export function guestAuthEnabled(): boolean {
  return process.env.GUEST_AUTH === "true";
}

// Local TallyPrime connector. TallyPrime listens on localhost:9000 by default
// (XML-over-HTTP). Cloud servers cannot reach a localhost TallyPrime, so this
// is intended for local development where TallyPrime runs on the same machine.
export function tallyUrl(): string {
  return process.env.TALLY_URL || "http://localhost:9000";
}