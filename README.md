# dsh-mcp-manager

![icon](icon.svg)

MCP server management for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness):
manage **Model Context Protocol** servers from the Web UI and get their tools as native
`mcp__<server>__<tool>` tools for the agent — no hand-editing of `cordis.patch.yml`, no restart.

[中文](README.zh.md) | English

## Features

- **Two surfaces, one page.** Settings → **MCP servers** always exists; an optional left-rail
  entry with this plugin's own icon opens the same page as a standalone panel. A switch at the
  bottom of the page shows or hides the rail entry (default: shown).
- **Full lifecycle from the UI.** Add, edit, enable/disable, reconnect and delete servers.
  Saving connects immediately; disabling kills the child process and unregisters its tools;
  reconnecting re-handshakes and swaps the tool set atomically.
- **stdio and Streamable HTTP** transports, with environment variables, request headers and
  working directory.
- **Live status**: connected / connecting / failed (with the server's error text), tool count,
  server version, instructions, and the discovered tool list.
- **Foreign entries are visible, not duplicated.** MCP servers already configured as separate
  `@deepseek-ai/dsh-mcp-client` rows appear read-only, with their Entry id and live tool count.
  **Migrate here** moves one over: it disables the source row first, then copies the config into
  this page and connects — so two connections never compete for the same tool names.
- **No dependencies.** A small, self-contained MCP client (stdio JSON-RPC + Streamable HTTP),
  atomic JSON persistence, and seven exact Fetch routes. No build step.

## Install

Requires a Harness build that ships the Cordis Fetch-route and slot APIs used here
(developed and tested against `0.2.1-rc.5`).

From the Plugins page of the Harness Web UI, install the bundle with the package spec — for a
local checkout, install the checkout directory instead (it is linked, so edits are picked up):

```
@kuhufu/dsh-mcp-manager
```

The bundle ships one Loader row (`mcp-manager`) and one browser module; enabling the bundle is
enough, there is no configuration file to write. Install it in a profile whose Web UI is
running, then open **Settings → MCP servers**, or click the new icon in the left rail.

> The npm name `dsh-mcp-manager` belongs to an unrelated project, so this plugin publishes under
> the `@kuhufu` scope. If the package is not on npm yet, install from a Git checkout.

## Usage

| Action | What happens |
| --- | --- |
| Add server | Pick a transport, fill the fields, save. The connection is opened right away. |
| Enable / disable | Disabling ends the child process and removes the server's tools; the config stays. |
| Reconnect | New handshake and a fresh tool generation (use after changing env vars or upgrading the server). |
| Edit | Saves and restarts that connection; renaming changes the tool namespace. |
| Delete | Disconnects, unregisters the tools, removes the record (inline confirmation). |
| Show in the sidebar | Installs or removes the left-rail entry; the Settings page is unaffected. |

**Tool naming.** Tools are registered as `mcp__<serverName>__<rawToolName>`, with every character
outside `[A-Za-z0-9_-]` replaced by `_` (so `mix.content` becomes `mcp__mix_content`). An MCP
`isError` result fails the call with the server's text. Re-syncing (or restarting) a server swaps
the whole tool set atomically.

**Transports.**

- `stdio`: `command`, `args`, `env`, optional `cwd` — e.g. `command: npx`,
  `args: -y @modelcontextprotocol/server-filesystem /tmp`.
- `http` (Streamable HTTP): `url` and optional `headers` such as `Authorization: Bearer …`.

## Data and security

- Records live in `$DSH_HOME/storages/mcp-manager.json` (`$DSH_HOME` defaults to `~/.dsh`),
  written atomically and validated on load; a corrupt or legacy document degrades to empty
  servers plus the default preferences instead of breaking the page.
- Environment variables and headers are stored there as **plain text**. If a migrated
  `dsh-mcp-client` row used `!!js process.env.X`, the copy holds the resolved value.
- MCP servers are ordinary processes started as your user; this plugin adds no sandbox.
  Only add servers you trust.

## Architecture

| Part | File | Role |
| --- | --- | --- |
| Host | `index.js` + `host/mcp.js`, `host/store.js`, `host/routes.js` | Owns records, MCP connections, tool registration and the Fetch routes. |
| Client | `client.js` | One React page registered into `settings.section`, plus the optional `sidebar.panellist` + `main` pair. |

All page traffic uses exact `POST` routes on the Harness Fetch bridge (relative
`api/mcp-manager.*`, authenticated by the browser session, `cache-control: no-store`):

| Route | Purpose |
| --- | --- |
| `list` | Managed servers + read-only `external` rows + `ui` |
| `save` / `remove` / `toggle` / `reconnect` | Server mutations |
| `takeover` | Disable a `dsh-mcp-client` entry and re-create it as a managed record |
| `ui` | The `railEntry` preference |

`CONTRACT.md` pins the request/response shapes, validation rules and tool-bridge contract.

## Development

Plain ESM, no build step, no dependencies. Node 22+.

```bash
node --check index.js && node --check client.js
node test/mcp.smoke.mjs        # 29 checks: transports, store, routes, full plugin lifecycle
node test/external.smoke.mjs   # 54 checks: foreign entries, migration, ui preference
```

Both suites are framework-free: they drive the real modules over real stdio/HTTP transports
(and a real fake MCP server), and assert that every spawned process is reaped.

## Limitations

- MCP image/audio results are not persisted; non-text blocks are surfaced as text diagnostics.
- MCP prompts/resources subscriptions are not supported (matching the official
  `dsh-mcp-client` bridge).
- A cross-server tool-name collision (e.g. server `a__b` + tool `c` vs server `a` + tool `b__c`)
  fails that server's registration with an error status rather than renaming silently.
- The Settings navigation icon for third-party sections is fixed by the Harness shell (a gear);
  the rail entry is where this plugin's own icon is visible.

## License

[MIT](LICENSE)
