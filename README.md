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
claude mcp add browser-fetch -s local -- node "$PWD/server/mcp.mjs"   # per project
npm run bridge                                                         # keep running
```

Then load the extension in Firefox: `about:debugging#/runtime/this-firefox` →
**Load Temporary Add-on…** → `extension/manifest.json`. It reconnects to the
bridge every 2 s, so the bridge and Firefox can start in either order.

Error `bridge not reachable at http://127.0.0.1:8798`:
- `fetch failed` → the bridge isn't running.
- `no extension connected` → the bridge is up but the extension isn't loaded.
  It's unsigned, so Firefox drops it on every restart.

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
