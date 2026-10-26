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

// Runs in the page. Returns null when `selector` matches nothing.
function pageRead(kind, selector) {
  const root = selector ? document.querySelector(selector) : document.body;
  if (!root) return null;
  if (kind === "html") return selector ? root.outerHTML : document.documentElement.outerHTML;
  if (kind !== "outline") return root.innerText;

  // Screen-reader view: landmarks, headings, links with targets, controls, text.
  const LANDMARK = { NAV: "nav", MAIN: "main", HEADER: "banner", FOOTER: "contentinfo",
                     ASIDE: "complementary", FORM: "form", DIALOG: "dialog" };
  const ROLES = new Set(Object.values(LANDMARK).concat(["navigation", "search", "region"]));
  const BLOCK = new Set(["P", "LI", "TD", "TH", "DD", "DT", "BLOCKQUOTE", "PRE", "FIGCAPTION", "CAPTION"]);
  const IGNORE = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "IFRAME", "HEAD"]);
  const NESTED = "a,button,input,select,textarea,h1,h2,h3,h4,h5,h6,[role]";
  const clip = (s, n = 160) => {
    s = (s || "").replace(/\s+/g, " ").trim();
    return s.length > n ? s.slice(0, n) + "…" : s;
  };
  const label = (el) => clip(el.getAttribute("aria-label") || el.labels?.[0]?.innerText || el.alt ||
    el.title || el.placeholder || el.innerText);
  // checkVisibility() is false for display:contents boxes (e.g. MDN's <main>),
  // though their children render, so those count as visible.
  const hidden = (el) => IGNORE.has(el.tagName) || el.getAttribute("aria-hidden") === "true" ||
    (el.checkVisibility && !el.checkVisibility() && getComputedStyle(el).display !== "contents");
  // What actually renders: a shadow root's tree (slots pull light DOM in) or the children.
  const kids = (el) => el.tagName === "SLOT" ? el.assignedNodes({ flatten: true }) :
    (el.shadowRoot || el).childNodes;

  const out = [];
  function walk(el, d) {
    if (hidden(el)) return;
    const pad = "  ".repeat(d), t = el.tagName, role = el.getAttribute("role");
    const emit = (s) => out.push(pad + s);
    const h = /^H([1-6])$/.exec(t);
    if (h || role === "heading")
      return emit("#".repeat(h ? +h[1] : +(el.getAttribute("aria-level") || 2)) + " " + label(el));
    if ((t === "A" && el.hasAttribute("href")) || role === "link")
      return emit(`link "${label(el)}" ${el.getAttribute("href") || ""}`);
    if (t === "BUTTON" || role === "button") return emit(`button "${label(el)}"`);
    if (t === "INPUT" || t === "SELECT" || t === "TEXTAREA")
      return el.type !== "hidden" && emit(`${t === "INPUT" ? el.type : t.toLowerCase()} "${label(el)}"`);
    if (t === "IMG") return el.alt && emit(`img "${clip(el.alt)}"`);
    const lm = ROLES.has(role) ? role : LANDMARK[t];
    if (lm) { emit(`[${lm}]`); d++; }
    else if (BLOCK.has(t) && !el.querySelector(NESTED)) {
      const s = clip(el.innerText, 2000);
      return s && emit(s);
    }
    for (const c of kids(el)) {
      if (c.nodeType === Node.ELEMENT_NODE) walk(c, d);
      else if (c.nodeType === Node.TEXT_NODE) {
        const s = clip(c.nodeValue, 2000);
        if (s) out.push("  ".repeat(d) + s);
      }
    }
  }
  walk(root, 0);
  return out.filter((l, i) => l !== out[i - 1]).join("\n");
}

async function readPage(tabId, kind, selector) {
  let result;
  try {
    [{ result } = {}] = await api.scripting.executeScript({
      target: { tabId }, func: pageRead, args: [kind, selector || null],
    });
  } catch { return ""; }
  if (result === null) throw new Error(`selector ${JSON.stringify(selector)} matched nothing on the page`);
  return result || "";
}

async function reload(tabId) {
  await api.tabs.reload(tabId);
  await waitForComplete(tabId);
}

// ── dumpDom: navigate and return rendered content ────────────────────────────
const BOTWALL = /access denied|pardon our interruption|request unsuccessful|are you a human|verify you are|px-captcha|protected by akamai|enable javascript and cookies|reference #\d|incident id|robot or human|press (?:and|&) hold/i;

async function dumpDom({ url, kind = "text", selector, settle = 4000, retries = 3, max = 400000, container }) {
  const tab = await openTab(url, container);
  try {
    await waitForComplete(tab.id);
    await sleep(settle);
    await assertTabAlive(tab.id);
    // Check the whole page's text for a bot wall before reading the requested
    // part: a challenge page won't contain `selector`.
    const walled = async () => BOTWALL.test(await readPage(tab.id, "text"));
    for (let i = 0; i < retries && await walled(); i++) {
      await sleep(5000);
      await reload(tab.id);
      await sleep(3000);
    }
    const content = await readPage(tab.id, kind, selector);
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
