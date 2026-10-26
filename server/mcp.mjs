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
  let r;
  try {
    r = await fetch(`${BRIDGE}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(cmd),
    });
  } catch (e) {
    return { error: `bridge not reachable at ${BRIDGE} — start the bridge and load the extension (${String(e.message || e)})` };
  }
  const body = await r.json().catch(() => ({}));
  if (r.status === 200) return body;
  const msg = body.error || `bridge returned ${r.status}`;
  // The bridge answers 502 "no extension connected" when Firefox isn't attached;
  // anything else is an error from the extension itself (bad container, etc.).
  return { error: /no extension connected/.test(msg) ? `bridge at ${BRIDGE} is up but ${msg}` : msg };
}

const asText = (obj) => ({
  content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }],
});

const server = new McpServer({ name: "browser-fetch", version: "0.1.0" });

server.tool(
  "browse",
  "Open a URL in a background tab of the user's real Firefox (their cookies, logins and " +
  "fingerprint), wait for it to render, and return its content. Use when WebFetch is blocked " +
  "(403, bot wall, challenge page), the page is built by JavaScript, or it needs the user's " +
  "login. It avoids most bot checks by being a real browser but cannot solve a CAPTCHA. " +
  "Default kind \"text\" is the cheapest; add selector to read only part of the page.",
  {
    url: z.string().describe("The URL to open"),
    kind: z.enum(["text", "outline", "html"]).default("text").describe(
      "text (default, cheapest): visible text. " +
      "outline: screen-reader view with landmarks, headings, links with targets, buttons and form " +
      "fields; several times larger than text, use it when you need the page's structure or " +
      "where its links go. html: raw DOM, by far the largest; only when you need markup."),
    selector: z.string().optional().describe(
      "CSS selector (e.g. \"main\", \"article\", \"#results\") to read only that element; " +
      "cuts navigation, footers and ads. Errors if nothing matches."),
    settle: z.number().optional().default(4000).describe("Milliseconds to wait after page load before reading (default 4000); raise for slow apps"),
    retries: z.number().optional().default(3).describe("Reloads to try if a bot-wall page is detected (default 3)"),
    max: z.number().optional().default(400000).describe("Max characters to return (default 400000)"),
    container: z.string().optional().describe("Firefox container to open the tab in (e.g. \"Facebook\"), for sites a container add-on isolates; an empty result for a logged-in site usually means this is needed"),
  },
  async ({ url, kind, selector, settle, retries, max, container }) =>
    asText(await rpc({ type: "dumpDom", url, kind, selector, settle, retries, max, container })),
);

server.tool(
  "fetch",
  "HTTP GET a URL from inside the Firefox extension, with no CORS restrictions, and return " +
  "the raw response body. No page is rendered, so it's fast. Use it for JSON APIs and data " +
  "endpoints (e.g. ones found with net_log). It can only use default-container cookies, so " +
  "prefer browse for logged-in pages.",
  {
    url: z.string().describe("The URL to fetch"),
    max: z.number().optional().default(400000).describe("Max characters to return (default 400000)"),
  },
  async ({ url, max }) => asText(await rpc({ type: "fetchUrl", url, max })),
);

server.tool(
  "search_links",
  "Open a URL in the user's real Firefox and return the absolute URLs of links matching a " +
  "regex. Cheaper than browse with kind \"outline\" when you only need to find pages " +
  "(e.g. product links from a search, documents from an index page).",
  {
    url: z.string().describe("The page URL to scan for links"),
    pattern: z.string().optional().default(".").describe("Regex to filter links (default matches all)"),
    limit: z.number().optional().default(50).describe("Max links to return (default 50)"),
    container: z.string().optional().describe("Firefox container name to open the tab in (e.g. \"Facebook\"), for sites a container add-on isolates"),
  },
  async ({ url, pattern, limit, container }) => asText(await rpc({ type: "searchLinks", url, pattern, limit, container })),
);

server.tool(
  "net_log",
  "Open a URL in the user's real Firefox and list the URLs of the network requests the page " +
  "made (XHR, fetch, scripts, images). Use it to find the JSON API behind a page, then call " +
  "that API with fetch instead of scraping the rendered page.",
  {
    url: z.string().describe("The page URL to monitor"),
    pattern: z.string().optional().describe("Regex to filter captured URLs"),
    settle: z.number().optional().default(7000).describe("Milliseconds to wait for requests to complete (default 7000)"),
    container: z.string().optional().describe("Firefox container name to open the tab in (e.g. \"Facebook\"), for sites a container add-on isolates"),
  },
  async ({ url, pattern, settle, container }) => asText(await rpc({ type: "netLog", url, pattern, settle, container })),
);

await server.connect(new StdioServerTransport());
