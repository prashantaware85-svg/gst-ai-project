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
// is intended for local development where TallyPrime runs on the same machine
// (direct mode) and for the Windows Tally Bridge agent (which imports the same
// service and talks to localhost:9000 on the user's PC).
export function tallyUrl(): string {
  return process.env.TALLY_URL || "http://localhost:9000";
}

export type TallyMode = "direct" | "bridge";

// How the backend reaches TallyPrime:
//   direct  - POST XML to TALLY_URL (localhost:9000). Works only when the
//             Express server runs on the same machine as TallyPrime (local dev
//             and the test suite).
//   bridge  - route /api/tally/* through the outbound WebSocket connection of
//             the Windows Tally Bridge agent. Required for cloud deployments
//             (Render), whose localhost is never the user's PC.
// Anything other than TALLY_MODE=bridge means direct, so dev/tests are
// untouched and existing behaviour is preserved.
export function tallyMode(): TallyMode {
  return process.env.TALLY_MODE === "bridge" ? "bridge" : "direct";
}

// Secret shared with the Windows Tally Bridge agent. The agent authenticates
// its outbound WebSocket connection to the Render server with this token. Read
// server-side only — it must never reach the frontend or be logged.
export function tallyBridgeToken(): string {
  const t = process.env.TALLY_BRIDGE_TOKEN || "";
  if (t.trim()) return t.trim();
  if (isProd && tallyMode() === "bridge") {
    throw new Error("TALLY_BRIDGE_TOKEN is required in production when TALLY_MODE=bridge");
  }
  return "";
}