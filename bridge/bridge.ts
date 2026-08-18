// Local Windows Tally Bridge agent.
//
// Runs on the SAME PC as TallyPrime. It talks to TallyPrime's XML-over-HTTP
// server at http://localhost:9000 (never exposed to the internet) and opens an
// OUTBOUND secure WebSocket (wss) to the Render-hosted backend. The backend
// routes /api/tally/* operations to this agent, which executes the very same
// tally.service code used in local development and returns normalized JSON.
//
// Because every connection is initiated by this PC (no inbound sockets), there
// is no port forwarding, no firewall rule, and port 9000 stays private.
//
// Usage:
//   1. copy .env.example -> .env and set TALLY_BRIDGE_URL + TALLY_BRIDGE_TOKEN
//   2. npm install
//   3. npm start   (or double-click start.bat)
import { fileURLToPath } from "node:url";
import path from "node:path";
import { config as loadEnv } from "dotenv";
import WebSocket from "ws";
import {
  fetchCurrentCompany,
  fetchVouchers,
  tallyRequest,
} from "../server/src/services/tally.service";

const here = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.join(here, ".env") });

const BRIDGE_URL = (process.env.TALLY_BRIDGE_URL || "").trim();
const BRIDGE_TOKEN = (process.env.TALLY_BRIDGE_TOKEN || "").trim();
const BRIDGE_DEVICE = (process.env.TALLY_BRIDGE_DEVICE || "default").trim().slice(0, 64);
// The agent targets the user's own machine. tally.service falls back to
// http://localhost:9000 when TALLY_URL is unset.
const TALLY_URL = process.env.TALLY_URL || "http://localhost:9000";

let retryDelayMs = 1000;
let quitting = false;
let socket: WebSocket | null = null;

function log(...args: unknown[]): void {
  console.log(new Date().toISOString(), ...args);
}

function die(message: string): never {
  console.error(message);
  process.exit(1);
}

// Execute an operation from the backend using the local tally.service. Errors
// are returned to the backend (never thrown across the socket).
async function handleOp(op: string, payload: unknown) {
  switch (op) {
    case "ping":
      // Prove we can reach TallyPrime on this PC with a minimal envelope.
      await tallyRequest("<ENVELOPE></ENVELOPE>", 3000);
      return { ok: true as const, data: { tallyUrl: TALLY_URL } };
    case "company": {
      const info = await fetchCurrentCompany();
      return { ok: true as const, data: info };
    }
    case "vouchers": {
      const p = (payload ?? {}) as { kind?: string; fromDate?: string; toDate?: string };
      const kind = p.kind === "purchases" ? "purchases" : "sales";
      if (!p.fromDate || !p.toDate) {
        return { ok: false as const, error: "vouchers requires fromDate and toDate" };
      }
      const result = await fetchVouchers(kind, p.fromDate, p.toDate);
      return { ok: true as const, data: result };
    }
    default:
      return { ok: false as const, error: `Unknown operation: ${op}` };
  }
}

function connect(): void {
  if (quitting) return;

  let endpoint: URL;
  try {
    endpoint = new URL(BRIDGE_URL);
  } catch {
    die("Invalid TALLY_BRIDGE_URL. Expected something like wss://your-app.onrender.com/ws/bridge");
  }
  endpoint.searchParams.set("device", BRIDGE_DEVICE);

  log(`Connecting to ${endpoint.origin}${endpoint.pathname}...`);
  const ws = new WebSocket(endpoint.toString(), {
    headers: { "x-bridge-token": BRIDGE_TOKEN },
    handshakeTimeout: 10_000,
  });
  socket = ws;

  ws.on("open", () => {
    retryDelayMs = 1000;
    log("Tally Bridge connected to the server.");
  });

  ws.on("message", (data) => {
    let msg: any;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "hello") return;
    if (typeof msg.id !== "string" || typeof msg.op !== "string") return;

    void handleOp(msg.op, msg.payload).then((reply) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: "reply", id: msg.id, ok: reply.ok, data: reply.data, error: reply.error }));
    });
  });

  ws.on("close", () => {
    socket = null;
    if (quitting) return;
    log(`Disconnected. Retrying in ${retryDelayMs / 1000}s...`);
    setTimeout(() => {
      retryDelayMs = Math.min(retryDelayMs * 2, 30_000) + Math.floor(Math.random() * 500);
      connect();
    }, retryDelayMs);
  });

  ws.on("error", (err) => {
    log("Connection error:", err.message);
  });
}

function shutdown(): void {
  quitting = true;
  log("Shutting down Tally Bridge.");
  socket?.close();
  // Allow the close handshake a moment, then force exit.
  setTimeout(() => process.exit(0), 500).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

if (!BRIDGE_URL) {
  die(
    "TALLY_BRIDGE_URL is not set.\nOpen bridge/.env, set TALLY_BRIDGE_URL to your Render app's WebSocket URL\n(e.g. wss://your-app.onrender.com/ws/bridge), then start again.",
  );
}
if (!BRIDGE_TOKEN) {
  die(
    "TALLY_BRIDGE_TOKEN is not set.\nIt must match TALLY_BRIDGE_TOKEN on the Render server. See bridge/.env.example.",
  );
}

log(`Tally Bridge starting (device=${BRIDGE_DEVICE}, tally=${TALLY_URL}).`);
connect();