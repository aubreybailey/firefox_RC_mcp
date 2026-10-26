---
name: browser-fetch
description: Read web pages through the user's real Firefox (their cookies, logins, containers and fingerprint) via the browser-fetch MCP tools (mcp__browser-fetch__browse, fetch, search_links, net_log). Use when WebFetch gets a 403, bot wall or challenge page, or an empty JS-rendered page; when a page needs the user's login; or to find the JSON API behind a page. Covers picking the cheapest output (text by default, outline or a CSS selector when needed), Firefox containers, and starting the stack when a tool returns "bridge not reachable" or "no extension connected".
---

# browser-fetch

Repo: `~/code/firefox_webfetch_MCP` (see its README.md). The tools work by
opening **background tabs in the user's own Firefox** (closed again after
reading), so they see the user's logins. Two pieces must be running: the
**bridge** (`:8798` HTTP, `:8797` WS) and the **extension**, which is installed
permanently in the user's main Firefox.

Try plain WebFetch first for ordinary public pages. Switch to these tools when
it's blocked, the page is built by JavaScript, or it needs the user's login.

## Pick the tool

| Need | Tool |
|---|---|
| Read a page | `browse` |
| Find links to other pages | `search_links` (regex on link URLs) |
| Find the API behind a page | `net_log`, then `fetch` that endpoint |
| JSON API or raw file, no rendering | `fetch` |

## Keep `browse` output small

Pick the cheapest output that answers the question:

1. **`kind: "text"` (default):** visible text only, usually a few thousand
   characters. Enough for reading content.
2. **`selector`:** add `"main"`, `"article"` or a specific selector to skip
   navigation, footers and ads. It works with any `kind`. If nothing matches,
   it returns an error; retry without it.
3. **`kind: "outline"`:** a screen-reader view: landmarks, headings, links
   with their targets, buttons and form fields. It's 3–10× larger than text,
   so use it only when you need structure: where links go, what a form asks,
   or how a page is laid out. Pair it with `selector` where you can.
4. **`kind: "html"`:** raw DOM, often hundreds of KB. Only when you need the
   markup itself; always set `selector` and `max`.

Also: raise `settle` (default 4000 ms) for slow apps, and set `max` when you
only need the start of a page.

## Logged-in sites and Firefox containers

The user may isolate sites in Firefox containers (e.g. Facebook Container).
Outside its container, such a site is logged out. If `browse`, `search_links` or `net_log` returns an empty body,
a login page, or "tab was closed before it could be read", retry with
`container: "<name>"`, e.g. `"Facebook"`. An unknown name returns an error
listing the containers. `fetch` has no container option and uses
default-container cookies only.

## If a tool returns `bridge not reachable` or `no extension connected`

- **`bridge not reachable`:** the bridge isn't running. Run
  `~/code/firefox_webfetch_MCP/scripts/start-stack.sh` and retry. It prints
  `stack up` or `stack already up`.
- **`… is up but no extension connected`:** the user's Firefox is closed.
  For anything that needs their logins, **ask the user to open Firefox**. The
  extension reconnects within seconds. `start-stack.sh` would instead open a
  separate fallback window with no logins or containers, which is only
  useful for public pages.

Check state with `curl -s http://127.0.0.1:8798/health`. If `start-stack.sh`
fails, read `~/.local/state/browser-fetch/{bridge,firefox}.log`:
- `bridge.log`: "port already in use" means another bridge is running
  (`pgrep -af bridge.mjs`).
- `firefox.log`: a display error means there's no graphical session.

Never kill the user's main Firefox.

## Changing the extension

After editing `extension/`, bump `version` in `extension/manifest.json`, then
push a matching tag (`git tag vX.Y.Z && git push origin vX.Y.Z`). The Release
workflow signs it, and the user installs the `.xpi` from the GitHub Release.
After changing `server/mcp.mjs`, the user must reconnect `browser-fetch` with
`/mcp`. Don't add a `connect-src` to the extension's CSP: it breaks `fetch`.
