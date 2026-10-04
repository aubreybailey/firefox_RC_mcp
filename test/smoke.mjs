// Smoke test without a browser: start the bridge, then drive the MCP server
// over stdio and check it lists its tools and reports the missing extension.
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const fail = (msg) => { console.error(`FAIL: ${msg}`); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Off-default ports so a running bridge (and its connected extension) doesn't interfere.
const env = { ...process.env, BROWSER_FETCH_WS_PORT: "18797", BROWSER_FETCH_HTTP_PORT: "18798", BROWSER_FETCH_BRIDGE: "http://127.0.0.1:18798" };
const bridge = spawn("node", ["server/bridge.mjs"], { stdio: "inherit", env });
try {
  let health;
  for (let i = 0; i < 20 && !health; i++) {
    await sleep(250);
    health = await fetch(`${env.BROWSER_FETCH_BRIDGE}/health`).then((r) => r.json()).catch(() => null);
  }
  if (!health) fail("bridge /health never answered");
  if (health.extensionConnected !== false) fail(`unexpected health ${JSON.stringify(health)}`);

  const client = new Client({ name: "smoke", version: "0" });
  await client.connect(new StdioClientTransport({ command: "node", args: ["server/mcp.mjs"], env }));
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  const want = ["browse", "fetch", "net_log", "search_links"];
  if (JSON.stringify(names) !== JSON.stringify(want)) fail(`tools ${names}`);
  const browse = (await client.listTools()).tools.find((t) => t.name === "browse");
  if (!browse.inputSchema.properties.container) fail("browse has no container option");

  const res = await client.callTool({ name: "browse", arguments: { url: "https://example.com" } });
  if (!/no extension connected/.test(res.content[0].text)) fail(`browse: ${res.content[0].text}`);
  await client.close();
  console.log("smoke ok:", names.join(", "));
} finally {
  bridge.kill();
}
