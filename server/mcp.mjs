#!/usr/bin/env node
/**
 * browser-fetch MCP server.
 *
 * General-purpose "WebFetch through a real browser" — any URL, rendered by the
 * user's actual Firefox/Chrome with real cookies, fingerprint, and human-solvable
 * CAPTCHAs. Replaces the built-in WebFetch for sites that block it.
 *
 * Tools:
 *   browse       — navigate to a URL, return rendered text or HTML
 *   fetch        — direct fetch from extension context (no CORS, has cookies)
 *   search_links — load a page and extract links matching a regex
 *   net_log      — capture network requests a page makes
 *
 * Register:
 *   claude mcp add browser-fetch -- node ~/code/firefox_webfetch_MCP/server/mcp.mjs
 *
 * Requires the bridge running (`npm run bridge`) and the extension loaded in the browser.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BRIDGE = process.env.BROWSER_FETCH_BRIDGE || "http://127.0.0.1:8798";

async function rpc(cmd) {
  try {
    const r = await fetch(`${BRIDGE}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(cmd),
    });
    const body = await r.json();
    if (r.status !== 200) throw new Error(body.error || `bridge returned ${r.status}`);
    return body;
  } catch (e) {
    return { error: `bridge not reachable at ${BRIDGE} — start the bridge and load the extension (${String(e.message || e)})` };
  }
}

const asText = (obj) => ({
  content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }],
});

const server = new McpServer({ name: "browser-fetch", version: "0.1.0" });

server.tool(
  "browse",
  "Navigate the user's real browser to a URL and return the fully-rendered page content. " +
  "Beats CAPTCHAs, bot walls, and JS-rendered SPAs because it runs in the actual browser " +
  "with real cookies and fingerprint. Use instead of WebFetch when a site blocks automated access.",
  {
    url: z.string().describe("The URL to navigate to"),
    kind: z.enum(["text", "html"]).default("text").describe("Return visible text (default) or raw HTML"),
    settle: z.number().optional().default(4000).describe("Milliseconds to wait after page load before reading (default 4000)"),
    retries: z.number().optional().default(3).describe("Number of reload attempts if a bot wall is detected (default 3)"),
    max: z.number().optional().default(400000).describe("Max characters to return (default 400000)"),
  },
  async ({ url, kind, settle, retries, max }) => asText(await rpc({ type: "dumpDom", url, kind, settle, retries, max })),
);

server.tool(
  "fetch",
  "Fetch a URL directly from the browser extension context. No CORS restrictions, includes " +
  "the browser's cookies. Good for JSON APIs, data endpoints, and resources that need " +
  "authentication cookies but not full page rendering.",
  {
    url: z.string().describe("The URL to fetch"),
    max: z.number().optional().default(400000).describe("Max characters to return (default 400000)"),
  },
  async ({ url, max }) => asText(await rpc({ type: "fetchUrl", url, max })),
);

server.tool(
  "search_links",
  "Navigate to a URL and extract all links (<a href>) matching a regex pattern. " +
  "Useful for finding specific pages on a site (e.g. product links from a search, " +
  "document links from an index page).",
  {
    url: z.string().describe("The page URL to scan for links"),
    pattern: z.string().optional().default(".").describe("Regex to filter links (default matches all)"),
    limit: z.number().optional().default(50).describe("Max links to return (default 50)"),
  },
  async ({ url, pattern, limit }) => asText(await rpc({ type: "searchLinks", url, pattern, limit })),
);

server.tool(
  "net_log",
  "Navigate to a URL and capture all network requests the page makes. Useful for " +
  "discovering API endpoints, XHR calls, and data sources a page uses under the hood.",
  {
    url: z.string().describe("The page URL to monitor"),
    pattern: z.string().optional().describe("Regex to filter captured URLs"),
    settle: z.number().optional().default(7000).describe("Milliseconds to wait for requests to complete (default 7000)"),
  },
  async ({ url, pattern, settle }) => asText(await rpc({ type: "netLog", url, pattern, settle })),
);

await server.connect(new StdioServerTransport());
