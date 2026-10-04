---
name: browser-fetch
description: Fetch web pages through a real Firefox (real cookies/fingerprint) via the browser-fetch MCP tools (mcp__browser-fetch__browse, fetch, search_links, net_log). Use when WebFetch gets a 403, Cloudflare/bot wall, CAPTCHA, or an empty JS-rendered page; when a page needs the user's login cookies; or to discover a site's hidden API endpoints. Also covers starting the stack (bridge + Firefox window) when a tool returns "bridge not reachable".
---

# browser-fetch

Repo: `~/code/firefox_webfetch_MCP` (see its README.md). The MCP server is
registered at user scope, so the tools exist in every project. They need two
background pieces: the **bridge** (`:8798` HTTP, `:8797` WS) and a **Firefox
window with the extension** connected to it.

## Pick the tool

| Need | Tool |
|---|---|
| Rendered page text/HTML (SPAs, bot walls) | `browse` (`kind: "text"` default, `"html"` for markup) |
| JSON API / raw resource, with browser cookies, no CORS | `fetch` |
| Find links on a page by regex | `search_links` |
| Find the XHR/API endpoints a page calls | `net_log`, then `fetch` the endpoint directly |

Prefer plain WebFetch first for ordinary public pages; switch to these when
it fails or the content is JS-rendered. `browse` drives a visible tab, so
it's slower (default `settle` 4000 ms). Raise `settle` for slow SPAs, and use
`max` to cap large pages.

## If a tool returns `bridge not reachable` or `no extension connected`

`bridge not reachable` means the bridge process isn't running; `bridge … is up
but no extension connected` means Firefox (with the extension) isn't attached.
Either way, bring the stack up yourself, then retry the call:

```sh
~/code/firefox_webfetch_MCP/scripts/start-stack.sh
```

It's idempotent: it starts the bridge if needed, opens a separate Firefox
instance/window (own profile, extension preloaded via `web-ext`), and waits
until `/health` reports `"extensionConnected": true`. It prints
`stack up` / `stack already up` on success.

Check state at any point: `curl -s http://127.0.0.1:8798/health`.

On failure, read the logs in `~/.local/state/browser-fetch/`:
- `bridge.log`: port already in use usually means a bridge is running
  elsewhere; check `pgrep -af bridge.mjs`.
- `firefox.log`: `ECONNREFUSED` means Firefox handed off to an existing
  instance (the script already passes `--new-instance -no-remote`); a display
  error means no `DISPLAY`/`WAYLAND_DISPLAY`, i.e. no graphical session.

The signed extension is installed permanently in the user's main Firefox, so
usually only the bridge needs starting. `start-stack.sh` opens a separate
window (profile `~/snap/firefox/common/browser-fetch-profile`, no user logins)
only when no extension is connected. Don't kill the user's main Firefox.

## Firefox containers

If `browse` returns an empty body, or the error "tab was closed before it could
be read", for a site the user is logged into (Facebook, Google, Amazon…), the site
probably lives in a Firefox container. Retry with `container: "<name>"`, e.g.
`"Facebook"`. An unknown name returns an error listing the available
containers. `fetch` has no container option, so it sees the default container's
cookies.

## Notes

- Logins persist in that profile. If a site needs auth, ask the user to log in
  inside the browser-fetch window once.
- `fetch` runs from the extension context. Don't add a `connect-src` to the
  extension CSP: it breaks `fetch` to arbitrary hosts.
