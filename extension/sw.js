/**
 * browser-fetch extension service worker.
 *
 * Generic browser automation: navigate to any URL in the user's real browser
 * and return the rendered content. Connects to the bridge over WebSocket;
 * commands arrive from the MCP server via the bridge's HTTP relay.
 *
 * Handlers: dumpDom, fetchUrl, searchLinks, netLog
 */
const api = globalThis.browser ?? globalThis.chrome;

const WS_URL = "ws://127.0.0.1:8797";
let ws = null;

function connect() {
  ws = new WebSocket(WS_URL);
  ws.onopen = () => log("bridge connected");
  ws.onclose = () => { ws = null; setTimeout(connect, 2000); };
  ws.onerror = () => { try { ws.close(); } catch {} };
  ws.onmessage = async (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    const handler = HANDLERS[msg.type];
    if (!handler) {
      reply({ id: msg.id, ok: false, error: `unknown command: ${msg.type}` });
      return;
    }
    try { reply({ id: msg.id, ok: true, result: await handler(msg) }); }
    catch (e) { reply({ id: msg.id, ok: false, error: String((e && e.message) || e) }); }
  };
}
function reply(o) { try { ws && ws.send(JSON.stringify(o)); } catch {} }
function log(...a) { console.log("[browser-fetch]", ...a); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── tab helpers ──────────────────────────────────────────────────────────────
function waitForComplete(tabId, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const t = setTimeout(() => { api.tabs.onUpdated.removeListener(l); resolve(); }, timeoutMs);
    function l(id, info) {
      if (id === tabId && info.status === "complete") {
        clearTimeout(t); api.tabs.onUpdated.removeListener(l); resolve();
      }
    }
    api.tabs.onUpdated.addListener(l);
  });
}

// Resolve a container name (case-insensitive) or cookieStoreId to a
// cookieStoreId. Needed for sites a container add-on (e.g. Facebook Container)
// isolates: a tab opened in the default container is logged out, and the add-on
// may close it and reopen the URL in its own container.
async function resolveContainer(container) {
  if (!container) return undefined;
  const ids = await api.contextualIdentities.query({});
  const hit = ids.find((c) => c.cookieStoreId === container || c.name.toLowerCase() === container.toLowerCase());
  if (!hit) throw new Error(`no container "${container}"; available: ${ids.map((c) => c.name).join(", ")}`);
  return hit.cookieStoreId;
}

async function openTab(url, container) {
  const cookieStoreId = await resolveContainer(container);
  return api.tabs.create({ url, active: false, ...(cookieStoreId && { cookieStoreId }) });
}

async function assertTabAlive(tabId) {
  try { await api.tabs.get(tabId); } catch {
    throw new Error("tab was closed before it could be read; a container add-on probably moved the site into its own container. Retry with the container option (e.g. container: \"Facebook\").");
  }
}

async function readText(tabId) {
  try {
    const [{ result } = {}] = await api.scripting.executeScript({
      target: { tabId },
      func: () => (document.body ? document.body.innerText : ""),
    });
    return result || "";
  } catch { return ""; }
}

async function readHtml(tabId) {
  try {
    const [{ result } = {}] = await api.scripting.executeScript({
      target: { tabId },
      func: () => document.documentElement.outerHTML,
    });
    return result || "";
  } catch { return ""; }
}

async function reload(tabId) {
  await api.tabs.reload(tabId);
  await waitForComplete(tabId);
}

// ── dumpDom: navigate and return rendered content ────────────────────────────
const BOTWALL = /access denied|pardon our interruption|request unsuccessful|are you a human|verify you are|px-captcha|protected by akamai|enable javascript and cookies|reference #\d|incident id|robot or human|press (?:and|&) hold/i;

async function dumpDom({ url, kind = "text", settle = 4000, retries = 3, max = 400000, container }) {
  const tab = await openTab(url, container);
  try {
    await waitForComplete(tab.id);
    await sleep(settle);
    await assertTabAlive(tab.id);
    let content = kind === "html" ? await readHtml(tab.id) : await readText(tab.id);
    for (let i = 0; i < retries && BOTWALL.test(content); i++) {
      await sleep(5000);
      await reload(tab.id);
      await sleep(3000);
      content = kind === "html" ? await readHtml(tab.id) : await readText(tab.id);
    }
    return { len: content.length, body: content.slice(0, max) };
  } finally {
    try { await api.tabs.remove(tab.id); } catch {}
  }
}

// ── fetchUrl: direct fetch from extension context (no CORS) ──────────────────
async function fetchUrl({ url, max = 400000 }) {
  try {
    const r = await fetch(url, { credentials: "include" });
    const ct = r.headers.get("content-type") || "";
    const body = await r.text();
    return { status: r.status, contentType: ct, len: body.length, body: body.slice(0, max) };
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
}

// ── searchLinks: extract links matching a pattern ────────────────────────────
async function searchLinks({ url, pattern, settle = 3500, limit = 50, container }) {
  const re = new RegExp(pattern || ".", "i");
  const tab = await openTab(url, container);
  try {
    await waitForComplete(tab.id);
    await sleep(settle);
    await assertTabAlive(tab.id);
    let links = [];
    for (let i = 0; i < 6; i++) {
      const [{ result } = {}] = await api.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => [...document.querySelectorAll("a[href]")].map((a) => a.href),
      });
      links = [...new Set((result || []).filter((h) => re.test(h)))];
      if (links.length) break;
      await sleep(2000);
    }
    return { count: links.length, links: links.slice(0, limit) };
  } finally {
    try { await api.tabs.remove(tab.id); } catch {}
  }
}

// ── netLog: capture network requests a page makes ────────────────────────────
async function netLog({ url, settle = 7000, pattern, container }) {
  const tab = await openTab(url, container);
  try {
    await waitForComplete(tab.id);
    await sleep(settle);
    await assertTabAlive(tab.id);
    const [{ result } = {}] = await api.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => performance.getEntriesByType("resource").map((e) => e.name),
    });
    let urls = [...new Set(result || [])];
    if (pattern) {
      const re = new RegExp(pattern, "i");
      urls = urls.filter((u) => re.test(u));
    }
    return { count: urls.length, urls: urls.slice(0, 200) };
  } finally {
    try { await api.tabs.remove(tab.id); } catch {}
  }
}

const HANDLERS = { dumpDom, fetchUrl, searchLinks, netLog };

// Firefox kills MV3 service workers after ~30s idle. browser.alarms fires an
// event that wakes the SW; the handler reconnects the WS if it dropped.
api.alarms.create("keepalive", { periodInMinutes: 0.4 });
api.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "keepalive") {
    if (!ws || ws.readyState !== WebSocket.OPEN) connect();
  }
});

connect();
setInterval(() => { if (!ws || ws.readyState !== WebSocket.OPEN) connect(); }, 20000);
