# browser-fetch MCP

Lets an MCP client (Claude Code) fetch pages through a real Firefox, with real
cookies and fingerprint, so sites that block bots (Cloudflare 403s, CAPTCHAs,
JS-rendered pages) still work.

Three pieces:

| Piece | File | Role |
|---|---|---|
| MCP server | `server/mcp.mjs` | stdio MCP server; tools `browse`, `fetch`, `search_links`, `net_log` |
| Bridge | `server/bridge.mjs` | WebSocket `:8797` for the extension, HTTP `:8798` for the MCP server |
| Extension | `extension/` | Firefox add-on that connects to the bridge and does the browsing |

## Setup

```sh
npm install
claude mcp add browser-fetch -s user -- node "$PWD/server/mcp.mjs"   # all projects
scripts/start-stack.sh                                                # bridge + Firefox
```

`start-stack.sh` is the quickest path; the rest of this section and the next
explain what it does and how to run the pieces by hand.

To do it by hand, run `npm run bridge` and load the extension in Firefox: `about:debugging#/runtime/this-firefox` →
**Load Temporary Add-on…** → `extension/manifest.json`. It reconnects to the
bridge every 2 s, so the bridge and Firefox can start in either order.

Error `bridge not reachable at http://127.0.0.1:8798`:
- `fetch failed` → the bridge isn't running.
- `no extension connected` → the bridge is up but the extension isn't loaded.
  It's unsigned, so Firefox drops it on every restart.

## Installing permanently (signed)

Release Firefox drops unsigned add-ons on restart. Sign the extension as
**unlisted** (private, auto-approved, not published on AMO) to install it for
good:

1. Get API credentials at
   <https://addons.mozilla.org/developers/addon/api/key/> (free AMO account).
2. Sign it:
   ```sh
   export WEB_EXT_API_KEY=user:...  WEB_EXT_API_SECRET=...
   npm run sign            # writes dist/browser_fetch-<version>.xpi
   ```
3. Open the `.xpi` in Firefox (drag it onto a window, or `firefox dist/*.xpi`)
   and accept the install prompt.

Mozilla rejects a version number it has already signed, so bump `version` in
`extension/manifest.json` before re-signing after changes.

## Firefox containers

If a container add-on (Facebook Container, Multi-Account Containers) isolates a
site, a tab opened in the default container is logged out, and the add-on may
close it and reopen the URL in its own container before the page is read. Pass
`container` (the container's name, e.g. `"Facebook"`) to `browse`,
`search_links` or `net_log` to open the tab in that container. An unknown name
returns an error listing the available containers. `fetch` doesn't take a
container.

## Loading the extension without touching your Firefox

When you can't reach the Firefox UI (remote session, keyboard/mouse passed to a
VM) or don't want to restart your main browser, start a **separate Firefox
instance** with its own profile and the extension preloaded, using Mozilla's
`web-ext`:

```sh
export XDG_RUNTIME_DIR=/run/user/$(id -u) WAYLAND_DISPLAY=wayland-0 DISPLAY=:0 \
       DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$(id -u)/bus
P=~/snap/firefox/common/browser-fetch-profile; mkdir -p "$P"
nohup npx -y web-ext run --source-dir extension \
  --firefox=/snap/bin/firefox --firefox-profile="$P" --keep-profile-changes \
  --no-reload --arg=--new-instance --arg=-no-remote --start-url about:blank &
```

Watch the bridge output for `[bridge] extension connected`.

Gotchas:
- **Display variables.** A shell without a desktop session (SSH, Claude Code)
  has no `DISPLAY`/`WAYLAND_DISPLAY`; export your session's values or Firefox
  can't open a window.
- **`--new-instance -no-remote`.** Without these, launching Firefox while
  another instance runs hands off to the existing window, and web-ext fails
  with `ECONNREFUSED 127.0.0.1:<port>` because its debugger never comes up.
- **Snap Firefox.** Keep the profile under `~/snap/firefox/common/`; snap
  confinement gives Firefox a private `/tmp`, so web-ext's default temporary
  profile won't work.
- `--keep-profile-changes` keeps logins and cookies between runs. Close the
  window to stop it.

## One command for the whole stack

`scripts/start-stack.sh` brings everything up and blocks until the extension
is connected. It's idempotent, so it's safe to run before every session, and an
agent (e.g. Claude Code) can run it on its own when a tool call returns
`bridge not reachable`. It:

1. Checks `GET http://127.0.0.1:8798/health`; if the bridge isn't up, starts
   it in the background.
2. If `extensionConnected` is false, borrows the desktop session's display
   variables, then opens a **new Firefox window** in its own instance and
   profile, with the extension loaded (the `web-ext` command above).
3. Polls `/health` for up to 60 s until `"extensionConnected": true`.

Logs go to `~/.local/state/browser-fetch/{bridge,firefox}.log`. Overrides:
`BROWSER_FETCH_PROFILE`, `FIREFOX_BIN`, `BROWSER_FETCH_BRIDGE`.

To stop: close the Firefox window and `pkill -f server/bridge.mjs`. After
editing the extension, close the window and rerun the script (it runs with
`--no-reload`).

A global Claude Code skill (`~/.claude/skills/browser-fetch/SKILL.md`) tells
Claude when to use these tools over WebFetch and to run this script when the
stack is down.
