#!/usr/bin/env node
/**
 * browser-fetch bridge.
 *
 * Two listeners in one process:
 *   - WS server on :8787  — the browser extension connects here.
 *   - HTTP server on :8788 — the MCP server POSTs commands; we relay to the
 *     extension over WS and return its reply.
 */
import { WebSocketServer } from "ws";
import http from "node:http";

const WS_PORT = Number(process.env.BROWSER_FETCH_WS_PORT || 8797);
const HTTP_PORT = Number(process.env.BROWSER_FETCH_HTTP_PORT || 8798);
const CALL_TIMEOUT_MS = 90_000;

let ext = null;
const pending = new Map();
let seq = 0;

const wss = new WebSocketServer({ port: WS_PORT });
wss.on("connection", (sock) => {
  ext = sock;
  console.error(`[bridge] extension connected`);
  sock.on("message", (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    const resolve = pending.get(msg.id);
    if (resolve) { pending.delete(msg.id); resolve(msg); }
  });
  sock.on("close", () => { if (ext === sock) ext = null; console.error("[bridge] extension disconnected"); });
  sock.on("error", () => {});
});

// Firefox suspends extension event pages after ~30s idle; ping keeps it alive.
setInterval(() => {
  try { if (ext && ext.readyState === ext.OPEN) ext.send(JSON.stringify({ type: "ping" })); } catch {}
}, 15000);

function call(cmd) {
  return new Promise((resolve, reject) => {
    if (!ext || ext.readyState !== ext.OPEN)
      return reject(new Error("no extension connected — load the extension and keep a browser window open"));
    const id = ++seq;
    pending.set(id, (msg) => (msg.ok === false ? reject(new Error(msg.error || "extension error")) : resolve(msg.result)));
    ext.send(JSON.stringify({ ...cmd, id }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error("extension call timed out")); } }, CALL_TIMEOUT_MS);
  });
}

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/rpc") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const cmd = JSON.parse(body || "{}");
        const out = await call(cmd);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(out));
      } catch (e) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: String(e.message || e) }));
      }
    });
  } else if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ extensionConnected: !!(ext && ext.readyState === ext.OPEN) }));
  } else {
    res.writeHead(404);
    res.end();
  }
});
server.listen(HTTP_PORT, () => console.error(`[bridge] ws :${WS_PORT}  http :${HTTP_PORT}`));
