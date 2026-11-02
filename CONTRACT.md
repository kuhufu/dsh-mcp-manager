# `@kuhufu/dsh-mcp-manager` — pinned contract

A Harness bundle with one Host half (`index.js` + `host/`) and one Client half (`client.js`).
The Client renders a **Settings → MCP 服务器** page; the Host owns the MCP connections,
registers their tools on `ctx.tools`, and serves the page's data over exact Fetch routes.

Both halves are plain JavaScript (no build step). The Client half is a browser bundle in the
`window.__ModuleLoader__.load({ id, factory(require) })` format and may only `require('react')`.

## File ownership (do not edit files outside your scope)

| Path | Owner |
|---|---|
| `index.js`, `host/mcp.js`, `host/store.js`, `host/routes.js`, `test/**` | host teammate |
| `client.js` | client teammate |
| `package.json`, `cordis.patch.yml`, `locale/*.json`, `icon.svg`, `CONTRACT.md` | Lead |

## Persistence

Host-owned JSON at `<DSH_HOME>/storages/mcp-manager.json` (`DSH_HOME` env, else `~/.dsh`):

```json
{ "version": 1, "servers": [ Server ] }
```

`Server` (persisted):

```ts
{
  id: string            // opaque stable id, generated on create (crypto.randomUUID())
  name: string          // tool namespace; ^[A-Za-z0-9_-]{1,32}$; unique across servers
  enabled: boolean
  transport: "stdio" | "http"
  command?: string      // stdio: executable
  args?: string[]       // stdio
  env?: Record<string, string>   // stdio, merged over the scrubbed parent env
  cwd?: string          // stdio
  url?: string          // http: full URL
  headers?: Record<string, string> // http
  createdAt: number
}
```

Writes are atomic (`writeFile` to a temp sibling + `rename`) and serialized.

## Runtime status (not persisted)

Per server, the Host keeps:

```ts
{
  status: "stopped" | "connecting" | "ready" | "error",
  error?: string,                     // human-readable last failure
  tools: { name: string, description?: string }[],  // raw MCP tool names
  toolCount: number,
  serverInfo?: { name?: string, version?: string },
  instructions?: string,              // first 4000 chars, may be absent
  connectedAt?: number
}
```

## HTTP routes (exact Fetch routes on `ctx.connection.fetch`)

Path prefix `/api/`, all **POST**, JSON request and response, `cache-control: no-store`.
The browser module fetches the **relative** form (no leading slash): `api/mcp-manager.list`
so it resolves under both the Web server and the desktop carrier.

| Path | Request body | Response |
|---|---|---|
| `/api/mcp-manager.list` | `{}` | `{ ok: true, servers: ServerView[] }` |
| `/api/mcp-manager.save` | `{ id?, server: ServerInput }` | `{ ok: true, id, servers: ServerView[] }` |
| `/api/mcp-manager.remove` | `{ id }` | `{ ok: true, servers: ServerView[] }` |
| `/api/mcp-manager.toggle` | `{ id, enabled }` | `{ ok: true, servers: ServerView[] }` |
| `/api/mcp-manager.reconnect` | `{ id }` | `{ ok: true, servers: ServerView[] }` |
| `/api/mcp-manager.takeover` | `{ entryId }` | `{ ok: true, id, servers: ServerView[], warnings: string[] }` |
| `/api/mcp-manager.ui` | `{ railEntry: boolean }` | `{ ok: true, servers: ServerView[], ui: UiState }` |

`takeover` migrates one live `external` row into a managed record: it validates the copied
configuration, disables the source Loader entry through `pluginManager.setPluginEnabled`
first (so its tools and child process are gone before this bundle registers the same
`mcp__<server>__<tool>` names), then persists and connects the new record. A failure after the
source was disabled re-enables it; a validation failure touches nothing. `warnings` reports
copied environment values and headers, which land in this page's storage as plain text.

Every success response also carries `ui: { railEntry: boolean }` — the page-level preference
that decides whether this bundle also adds a left-rail entry (default `true`). The rail entry
is a *second* surface for the same page: Settings → MCP servers always exists, and when the
preference is on, `sidebar.panellist` gets an id `mcp-manager` entry with this bundle's own icon
that opens a `main`-slot page keyed `mcp-manager`. Turning the preference off removes both
registrations; the Settings page and the persisted data are unaffected.

Every success response also carries `external: ExternalView[]` — the MCP servers owned by
other *live* `@deepseek-ai/dsh-mcp-client` entries (bundle rows or `cordis.patch.yml` rows;
disabled rows are omitted).
This bundle shows them read-only: connecting them here as well would open a second connection
and collide on `mcp__<server>__<tool>` names.

```ts
ExternalView = {
  entryId: string            // Loader row id, e.g. "magpie-mcp-deepwiki"
  serverName?: string        // config.serverName
  transport?: "stdio" | "streamable-http"
  command?: string, args: string[], url?: string
  enabled: boolean           // entry.disabled === false
  toolCount: number          // live ctx.tools names starting with `mcp__<serverName>__`
}
```

Failure shape (HTTP 200 with `ok: false`, or 4xx only for malformed JSON):

```json
{ "ok": false, "error": { "code": "invalid" | "duplicate-name" | "not-found" | "internal",
                          "message": "…", "field": "name?" } }
```

`ServerInput` is `Server` without `id`/`createdAt` (all other fields accepted; unknown fields dropped).
`ServerView` is `Server` plus the flattened runtime status fields above
(`status`, `error`, `tools`, `toolCount`, `serverInfo`, `instructions`, `connectedAt`).

### Validation rules (Host, authoritative)

- `name` must match `^[A-Za-z0-9_-]{1,32}$` and be unique (case-sensitive) among other servers.
- `transport: "stdio"` requires a non-empty `command`; `http` requires an absolute `http(s)` `url`.
- `env`/`headers` entries: string keys, string values; keys match `^[A-Za-z_][A-Za-z0-9_]*$` for env.
- Saving an existing `id` replaces the record and reconciles the connection in place
  (restart if the connection-relevant fields changed).
- A failed connection never deletes the record: it shows `status: "error"` with `error`.

## Tool bridging (Host)

For each `ready` server, register `ctx.tools.register({...})` per MCP tool:

- public name: `mcp__<name>__<rawName>` with every char outside `[A-Za-z0-9_-]` replaced by `_`,
  truncated to 64 chars; collisions resolved by appending `_2`, `_3`, … (deterministic per server).
- `description`: MCP tool description, or `Tool <rawName> from MCP server <name>`.
- `parameters`: the MCP `inputSchema`, or `{ "type": "object", "properties": {} }`.
- `output`: `{ schema: { type: "object", properties: { content: { type: "array", items: {} }, structuredContent: {} }, required: ["content"], additionalProperties: false }, render: () => [{ type: "text", text: <flattened content> }] }`
- `execute(args, exec)`: `tools/call` for that raw name; MCP `isError: true` must throw an Error
  carrying the flattened text; otherwise return `{ content, structuredContent? }`.
- Text blocks (`{type:"text",text}`) are flattened joined by `\n`; non-text blocks become
  `[<type> content from <tool>]` diagnostics (no image persistence in v1).
- Registering/disconnecting swaps the whole tool set atomically; a dispose from plugin unload
  removes every tool and kills every child process.

## Client page

- Register into the `settings.section` slot exactly like the shipped settings pages:

```js
ctx.slots.inject("settings.section", () => ctx.slots.register({
  name: "settings.section",
  id: "mcp-manager",
  order: 60,
  label: () => t("nav"),
  locale: NS,
}, McpManagerSection));
```

- `inject = ["slots", "locale"]`; register dictionaries with
  `ctx.locale.register(NS, { zh, en })` inside `ctx.effect(...)`; bind with `ctx.locale.bind(NS)`.
- The page component receives `{ t }` (bound translator); fall back to its own dictionary if absent.
- The same page renders in two surfaces: the `settings.section` entry (always) and, when
  `ui.railEntry` is true, a `sidebar.panellist` entry (`id: "mcp-manager"`, own SVG icon sized
  from the slot's `size` prop) plus a `main` entry keyed `"mcp-manager"` that wraps the page in a
  full-height scrolling container with 24px padding. Toggling the preference installs or removes
  both registrations through `ctx.slots.inject(...)` disposers held in one `ctx.effect`.
- The page ends with a preference row: a `role="switch"` control labelled
  "Show in the sidebar" whose value is `ui.railEntry`; it writes through `/api/mcp-manager.ui`.
- Page contents: `<h2>` title + `<p>` intro (18px/600 heading, 13px secondary intro), then the
  body. There is no header action row: an empty list shows the empty-state card with its single
  add button, and a non-empty list ends with a full-width dashed add row (host Models-page
  pattern: height 44, `--dsw-radius-lg`, `1px dashed --dsw-alias-border-l3`). Each server is a
  card (`--dsw-alias-bg-module-platform`) with status dot, name, transport summary, meta chips,
  expandable tool details and the enable/reconnect/edit/delete actions.
- Add/edit uses a `<dialog>`-like modal (`role="dialog"`, `aria-modal="true"`, Escape closes,
  focus moves to the first field) with the fields for the chosen transport.
  Args are edited one per line; env and headers as `KEY=VALUE` lines.
- Delete asks for confirmation inside the row/modal before calling the Host.
- Only `--dsw-alias-*` theme tokens (see list below); class names prefixed `dshmcp-`.
  Render the `<style>` element inside the root component (unmounting removes it).
- All visible text goes through `t(...)`; dictionaries cover English and Simplified Chinese.
- After every mutation, render the `servers` array from the response. Poll `.list` every 5 s
  while mounted (cleared on unmount) so `connecting`/`error` states settle.

### Available theme tokens

`--dsw-alias-bg-base`, `--dsw-alias-bg-layer-1`, `--dsw-alias-bg-layer-2`,
`--dsw-alias-bg-overlay`, `--dsw-alias-border-l1`, `--dsw-alias-border-l2`,
`--dsw-alias-brand-primary`, `--dsw-alias-label-primary`, `--dsw-alias-label-secondary`,
`--dsw-alias-state-error-primary`, `--dsw-alias-state-idle-primary`,
`--dsw-alias-state-success-primary`, `--dsw-alias-state-warn-primary`.

## Constraints

- No dependencies, no imports of `@deepseek-ai/*` packages, no network at build time.
- Host half may import `node:*` builtins only.
- Client half may not touch `document` outside its component, must not require anything but
  `react`, and must keep factories side-effect free.
- Never write outside `mcp-manager/`. Do not install, enable, or remove any bundle.
