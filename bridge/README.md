# GST AI Agent — Windows Tally Bridge

A tiny agent that runs on the **same PC as TallyPrime** and connects it to the
hosted (Render) app. TallyPrime stays on your machine at `http://localhost:9000`;
the bridge only ever talks to it locally, then maintains an **outbound secure
WebSocket** to the server. No port forwarding, no public exposure of port 9000.

## How it works

```
TallyPrime (localhost:9000)  <--HTTP XML-->  Tally Bridge (this PC)
                                               ^
                                               | outbound wss:// + TALLY_BRIDGE_TOKEN
Render app  <--WebSocket /ws/bridge--         |
   ^                                           |
   | browser /api/tally/*                      v
browser  --------------------------------------+
```

- The bridge **re-uses the exact parser** the server uses in local dev
  (`server/src/services/tally.service.ts`), so data is normalized identically.
- The server never tries to reach `localhost:9000`; it only relays operations
  (`ping`, `company`, `vouchers`) over the socket.
- Authentication: the bridge sends `TALLY_BRIDGE_TOKEN` as an HTTP header on the
  WebSocket upgrade. Invalid/missing tokens are rejected (`401`). The token is
  never placed in a URL, never logged, and never sent to the browser.
- Reconnect: if the link drops, the bridge retries with exponential backoff
  (1s → 2s → … up to 30s). The server evicts dead bridges via WebSocket
  ping/pong heartbeats (30s).

## Prerequisites on the Windows PC

1. **TallyPrime** with its **XML/HTTP server enabled** on port 9000:
   - TallyPrime → press `Ctrl+Alt+F12` → **Advanced Configuration** → check
     **Enable Server** and set **Port = 9000**. Restart TallyPrime, then open a
     company (the bridge reads the currently loaded company).
2. **Node.js LTS** — https://nodejs.org (only needed for the scripted mode; the
   packaged `.exe` below does not require it).

## Run it (scripted, no build)

1. Copy `bridge/.env.example` → `bridge/.env` and edit:
   - `TALLY_BRIDGE_URL` → your Render app's WebSocket endpoint:
     `wss://YOUR-APP.onrender.com/ws/bridge`
   - `TALLY_BRIDGE_TOKEN` → the exact same secret set as `TALLY_BRIDGE_TOKEN`
     in Render's environment variables. Generate with
     `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
   - Leave `TALLY_URL=http://localhost:9000`.
2. Double-click **`bridge\start-bridge.bat`** (it installs dependencies on first
   run), or from a terminal:

   ```
   cd bridge
   npm install
   npm start
   ```

3. Keep the window open. You should see `Tally Bridge connected to the server.`
4. In the app's *Tally Integration* page, press **Connect Tally**.

## Package as a Windows .exe (no Node required) — optional

A single static executable can be produced with **Bun** (bundles the runtime):

```
cd bridge
npm install
bun install          # if you prefer bun-managed install
bun build ./bridge.ts --compile --minify --outfile dist/TallyBridge.exe
```

Then distribute `bridge/dist/TallyBridge.exe`. The user just places the `.exe`
next to **`.env`** (same folder, same variables as above) and double-clicks it.
If you need a `.bat` for the packaged exe, create one that runs the exe from its
own directory.

> Note: the bridge imports typescript source from `server/src` for parsing; the
> bundler (esbuild via bun) resolves it into the exe, so the exe is fully
> self-contained. `dist/` is gitignored by the repo root.

## Render-side environment variables

On Render, set:

| Variable | Value |
|---|---|
| `TALLY_MODE` | `bridge` |
| `TALLY_BRIDGE_TOKEN` | long random secret (same as the bridge `.env`) |

Everything else (`TALLY_URL`, etc.) is unused in bridge mode. In local dev leave
`TALLY_MODE` unset (defaults to `direct`) so the existing local connector and
tests keep working.

## Security notes

- Port 9000 is only ever contacted from `localhost` on your PC.
- The WebSocket connection is initiated by your PC and authenticated with the
  shared secret; the Render server rejects unknown tokens with `401`.
- No credentials are stored in or sent through the browser.