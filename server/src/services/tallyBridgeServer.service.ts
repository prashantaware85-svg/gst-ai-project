import { randomUUID } from "node:crypto";
import type { Server as HttpServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { tallyBridgeToken } from "../utils/config";
import { logger } from "../utils/logger";
import { TallyError } from "./tally.service";

// Inbound WebSocket endpoint for the Windows Tally Bridge agent (production
// only, though the server may also run in dev). The agent on the user's PC
// dials out to wss://<render-app>/ws/bridge, so:
//   * Render never tries to reach its own localhost:9000,
//   * TallyPrime's port 9000 is never exposed to the internet,
//   * no port forwarding is required.
//
// The agent authenticates the upgrade with the TALLY_BRIDGE_TOKEN header, then
// the app requests operations (ping / company / vouchers) over the socket and
// correlates replies by id. Protocol-level ping/pong frames keep dead bridges
// evicted so the registry always reflects live connections.

export const BRIDGE_OFFLINE_MSG =
  "Tally Bridge is not connected. Start the Tally Bridge on this PC.";

export const BRIDGE_REQUEST_TIMEOUT_MSG = "Tally Bridge request timed out";

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const PING_REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_HEARTBEAT_MS = 30_000;

interface BridgeConnection {
  socket: WebSocket;
  deviceId: string;
  connectedAt: number;
  isAlive: boolean;
}

interface PendingRequest {
  resolve: (reply: BridgeReply) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

type BridgeReply = { ok: true; data: unknown } | { ok: false; error: string };

let wss: WebSocketServer | null = null;
let bridgeId: string | null = null;
const connections = new Map<string, BridgeConnection>();
const pending = new Map<string, PendingRequest>();
let heartbeatTimer: NodeJS.Timeout | null = null;
let heartbeatMs = DEFAULT_HEARTBEAT_MS;

export interface BridgeServerOptions {
  heartbeatMs?: number;
  token?: string;
}

// Attach the /ws/bridge endpoint to an already-created HTTP server (the Express
// app in index.ts, or a plain http server in tests). Idempotent.
export function startTallyBridgeServer(server: HttpServer, options: BridgeServerOptions = {}): void {
  if (wss) return;
  bridgeId = options.token ?? tallyBridgeToken();
  heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;

  wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "", "http://localhost");
    if (url.pathname !== "/ws/bridge") {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }
    // The bridge sends the shared token as a header (not a query param) so it
    // never appears in URLs, access logs or browser histories.
    const token = String(req.headers["x-bridge-token"] ?? "");
    if (!bridgeId || token !== bridgeId) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss!.handleUpgrade(req, socket, head, (ws) => {
      wss!.emit("connection", ws, req);
    });
  });

  wss.on("connection", (socket, req) => {
    const url = new URL(req.url ?? "", "http://localhost");
    const deviceId = String(url.searchParams.get("device") || "default").slice(0, 64);

    // A freshly dialed-in agent for the same device replaces any stale one.
    const stale = connections.get(deviceId);
    if (stale && stale.socket.readyState === WebSocket.OPEN) {
      try {
        stale.socket.terminate();
      } catch {
        // ignore
      }
    }

    const conn: BridgeConnection = { socket, deviceId, connectedAt: Date.now(), isAlive: true };
    socket.on("pong", () => {
      conn.isAlive = true;
    });
    socket.on("message", (data) => handleBridgeMessage(conn, String(data)));
    socket.on("close", () => {
      if (connections.get(deviceId) === conn) connections.delete(deviceId);
    });
    socket.on("error", () => {
      // errors surface as 'close'; nothing else to do here.
    });

    connections.set(deviceId, conn);
    logger.info(`Tally Bridge connected (${deviceId})`);
    socket.send(JSON.stringify({ type: "hello", deviceId }));
  });

  if (heartbeatMs > 0) {
    heartbeatTimer = setInterval(() => {
      for (const [deviceId, conn] of [...connections]) {
        if (!conn.isAlive) {
          logger.warn(`Tally Bridge heartbeat timeout (${deviceId})`);
          try {
            conn.socket.terminate();
          } catch {
            // ignore
          }
          connections.delete(deviceId);
          continue;
        }
        conn.isAlive = false;
        try {
          conn.socket.ping();
        } catch {
          // ignore - the close handler evicts it
        }
      }
    }, heartbeatMs);
    heartbeatTimer.unref?.();
  }
}

export function closeTallyBridgeServer(): void {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
  bridgeId = null;
  if (wss) {
    for (const conn of connections.values()) {
      try {
        conn.socket.terminate();
      } catch {
        // ignore
      }
    }
    connections.clear();
    pending.clear();
    wss.close();
    wss = null;
  }
}

// True when at least one authenticated bridge agent is connected.
export function bridgeConnected(): boolean {
  return connections.size > 0;
}

// Device ids of currently connected bridge agents.
export function bridgeDevices(): string[] {
  return [...connections.keys()];
}

// Send an operation to the most recently connected bridge and await its reply.
// Resolves with the bridge's payload, or throws TallyError when the bridge is
// offline, the request times out, or the agent reports a TallySide error.
export function bridgeRequest(
  op: string,
  payload: unknown = {},
  timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
): Promise<unknown> {
  if (!wss) throw new TallyError(BRIDGE_OFFLINE_MSG);
  const conn = latestConnection();
  if (!conn) throw new TallyError(BRIDGE_OFFLINE_MSG);

  const id = randomUUID();
  return new Promise<BridgeReply>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new TallyError(BRIDGE_REQUEST_TIMEOUT_MSG));
    }, timeoutMs);
    if (timeoutMs > 0) timer.unref?.();
    pending.set(id, { resolve, reject, timer });
    try {
      conn.socket.send(JSON.stringify({ id, op, payload }), (sendErr) => {
        if (!sendErr) return;
        pending.delete(id);
        clearTimeout(timer);
        reject(new TallyError(BRIDGE_OFFLINE_MSG));
      });
    } catch {
      pending.delete(id);
      clearTimeout(timer);
      reject(new TallyError(BRIDGE_OFFLINE_MSG));
    }
  }).then((reply) => {
    if (!reply.ok) throw new TallyError(reply.error);
    return reply.data;
  });
}

export function bridgeRequestTimeoutFor(op: string): number {
  return op === "ping" ? PING_REQUEST_TIMEOUT_MS : DEFAULT_REQUEST_TIMEOUT_MS;
}

function handleBridgeMessage(conn: BridgeConnection, raw: string): void {
  let msg: any;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "reply" && typeof msg.id === "string") {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok === true) p.resolve({ ok: true, data: msg.data });
    else p.reject(new TallyError(String(msg.error || "Tally Bridge reported an error")));
  }
}

function latestConnection(): BridgeConnection | undefined {
  const list = [...connections.values()];
  return list[list.length - 1];
}