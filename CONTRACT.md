# `@kuhufu/dsh-mcp-manager` — pinned contract

A Harness bundle with one Host half (`index.js` + `host/`) and one Client half (`client.js`).
The Client renders a **Settings → MCP 服务器** page; the Host owns the MCP connections,
registers their tools on `ctx.tools`, and serves the page's data over exact Fetch routes.

Both halves are plain JavaScript (no build step). The Client half is a browser bundle in the
`window.__ModuleLoader__.load({ id, factory(require) })` format and may only `require('react')`.

## Module boundaries

- `index.js`: plugin activation and route registration.
- `host/manager.js`: serialized configuration operations and store ownership.
- `host/runtime.js`: connections, bounded retries, tool definitions and activity.
- `host/agents.js`: per-agent tool registration and `/mcp` visibility sync.
- `host/session-state.js`: persisted per-session visibility overrides.
- `host/external.js`: Loader entry enablement and migration.
- `host/external-defaults.js`: persisted default-injection flags for foreign entries.
- `host/profile-patch.js`: targeted profile-patch repair with a backup.
- `host/patch-repair.js`: cross-layer duplicate repair with a top-level-array guard.
- `host/errors.js`: shared Host diagnostic formatting.
- `host/atomic-file.js`: the atomic write and never-overwrite backup used by every persisted document and patch writer.
- `host/mcp.js`, `host/mcp-json.js`, `host/store.js`, `host/routes.js`: transport, third-party import normalization, persistence and wire adapters.
- `client.js`: one browser factory containing a data hook and React components for recovery,
  transfer and presentation; these are logical boundaries within the same distributable file.

## Persistence

Host-owned JSON at `<DSH_HOME>/storages/mcp-manager.json` (`DSH_HOME` env, else `~/.dsh`):

```json
{ "version": 1, "servers": [ Server ], "ui": { "railEntry": true } }
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
  requestTimeoutMs?: number     // integer 1000–600000; default 60000
  initializeTimeoutMs?: number  // integer 1000–300000; default 30000
  retryCount?: number           // integer 0–10; default 0 (no automatic retries)
  disabledTools?: string[]      // raw names; preserved across reconnect/list changes
  autoInject?: boolean          // default true; false connects only when a Session shows it
}
```

Writes are serialized and atomic (exclusive `0600` temporary file, fsync, rename).
Memory is committed only after persistence succeeds. The previous valid file is atomically
saved to `mcp-manager.json.bak` before replacement. Missing files start empty; corrupt,
unreadable and unsupported-version files expose an empty view with
`storage.readOnly: true` and reject writes. Legacy unversioned documents and documents without
`ui` migrate to version 1 on the next successful write. Other versions require explicit recovery.
Invalid or duplicate individual records are skipped with warnings; valid records remain usable.
`storage.skippedRecords` reports the skipped count. Before replacing such a document, archive
its original bytes so tolerated bad records are not silently discarded.
Recovery archives the original bytes in `mcp-manager.json.recovery-<time>-<uuid>` before restoring
the validated backup or resetting to defaults. No damaged document is silently overwritten.

Every write first re-reads the document and compares it with the bytes this process last read or
wrote. A difference means another Harness instance sharing the same `DSH_HOME` replaced the file:
the store follows the on-disk document and refuses the write with the `conflict` code instead of
dropping the other writer's records. The same guard protects `mcp-manager-sessions.json` and
`mcp-manager-external.json`. Connections are per process, so one deployment should run a single
Harness instance per `DSH_HOME`; two instances otherwise also spawn every MCP server twice.

Env and header keys are stored verbatim, including names such as `__proto__`, which are written
as own properties rather than through the prototype setter.
Foreign `dsh-mcp-client` entries keep their configuration in the profile patch; their
default-injection flags live in `<DSH_HOME>/storages/mcp-manager-external.json`:

```json
{ "version": 1, "entries": { "<entryId>": false } }
```

Only entries turned off are recorded, so an entry injected by default stays absent. The file is
written atomically; a corrupt document degrades to "inject every entry" instead of failing boot.

## Runtime status (not persisted)

Per server, the Host keeps:

```ts
{
  status: "stopped" | "connecting" | "ready" | "error",
  error?: string,                     // human-readable last failure
  tools: { name: string, publicName: string, enabled: boolean, description?: string }[],
  toolCount: number,
  serverInfo?: { name?: string, version?: string },
  instructions?: string,              // first 4000 chars, may be absent
  connectedAt?: number,
  protocolVersion?: string,
  retryAttempt?: number,
  nextRetryAt?: number,
  logs?: { time: number, level: "info" | "error", message: string }[] // bounded recent activity
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
| `/api/mcp-manager.takeover` | `{ entryId }` | `{ ok: true, id, replaced: boolean, servers: ServerView[], warnings: string[] }` |
| `/api/mcp-manager.toggle-external` | `{ entryId, enabled }` | `{ ok: true, repaired: boolean, servers: ServerView[] }` |
| `/api/mcp-manager.ui` | `{ railEntry: boolean }` | `{ ok: true, servers: ServerView[], ui: UiState }` |
| `/api/mcp-manager.import` | `{ document }` | `{ ok: true, imported: number, servers: ServerView[] }` |
| `/api/mcp-manager.import-json` | `{ document, enable?: boolean }` | `{ ok: true, imported: number, enabled: number, warnings: ImportWarning[], servers: ServerView[] }` |
| `/api/mcp-manager.export` | `{ includeSecrets?: boolean }` | `{ ok: true, document: { version: 1, servers: ServerInput[] } }` |
| `/api/mcp-manager.recover` | `{ mode: "backup" | "reset" }` | `{ ok: true, servers: ServerView[], archive?: string }` |
| `/api/mcp-manager.tool` | `{ id, name: string, enabled: boolean }` | `{ ok: true, servers: ServerView[] }` |
| `/api/mcp-manager.external-default` | `{ entryId, autoInject: boolean }` | `{ ok: true, entryId, autoInject }` |
| `/api/mcp-manager.repair-patch` | `{}` | `{ ok: true, moved: string[], problems: string[], backups: string[] }` |
| `/api/mcp-manager.session` | `{ sessionId }` | `{ ok: true, sessionId, overrides, servers: SessionServerView[] }` |
| `/api/mcp-manager.session-set` | `{ sessionId, serverId, enabled: boolean \| null }` | `{ ok: true, sessionId, overrides, servers: SessionServerView[] }` |
| `/api/mcp-manager.session-set` | `{ sessionId, reset: true }` | Same session payload; atomically clears both managed and external overrides |

Every success response includes `storage: { readOnly: boolean, hasBackup: boolean, error?: string, skippedRecords?: number }`.
`storage-readonly` is a stable failure code for attempts to overwrite a damaged document.
Imports accept an array, `{ version: 1, servers }`, or `{ mcpServers: { name: config } }`.
The batch (1–200 records) is fully validated before any write; duplicate names reject the
whole batch. Imported records get fresh ids and are always disabled. Export omits environment
variables and headers unless `includeSecrets: true`; command arguments and URLs are retained
and may themselves contain credentials. Restore missing credentials before enabling an import.
Tool switches use raw names from the current advertised catalog; unknown names fail with
`not-found` before persistence. Disabled tools remain in the displayed catalog.

`import-json` is the direct path for a document written by another client; the page's paste box
sends it after stripping JSONC comments and trailing commas. Accepted shapes, tried in order:
`{ mcpServers: { name: config } }` (Claude Desktop, Claude Code, Cursor), a `servers` object
(VS Code; sibling `inputs` is ignored) or this bundle's own `servers` array, a top-level server
array, one server object, or a bare `{ name: config }` map. Entries are resolved individually: unusable ones become
`skipped` warnings and the rest still import, in one atomic write. `enable` defaults to `true`;
imported servers are persisted enabled, and the manager reconciles connections before replying,
so `enabled` counts enabled records that are not default-off (`autoInject !== false`). A source
entry with `"disabled": true` or `"enabled": false` stays disabled and is reported as a `note`.

Names are coerced to the tool-namespace grammar (`^[A-Za-z0-9_-]{1,32}$`): invalid runs become
`-`, leading/trailing dashes are trimmed, an empty result becomes `server`, and a collision with
an existing record or an earlier entry of the batch appends `-2`, `-3`, …; every change is a
`renamed` warning. Transport comes from `type`/`transport` when present, otherwise from `url`
(http) or `command` (stdio). The legacy SSE transport is not supported by this bundle, so such
entries are skipped rather than stored as broken servers. Scalar JSON values in `args`, `env`
and `headers` are stringified; keys that violate the Host's `env`/header rules are dropped (the
entry is then reported with a `dropped-fields` note). `envFile` is not read, and a VS Code
`${input:…}` placeholder is kept verbatim, both flagged as notes. Connection options,
`autoInject` and `disabledTools` are preserved when present; an out-of-range connection option
falls back to its default and is reported as a note. Environment values and headers are copied
into this page's storage as plain text, exactly like a save or the batch import. The request fails
with `invalid` only when the document declares no servers, exceeds 200 entries, or nothing in it
is importable.

```ts
ImportWarning =
  | { kind: "renamed", from: string, to: string }
  | { kind: "skipped", name: string, reason: "sse-unsupported" | "missing-command" | "missing-url"
      | "invalid-url" | "missing-transport" | "invalid-entry" }
  | { kind: "note", name: string, reason: "unknown-transport" | "source-disabled"
      | "env-file-ignored" | "input-placeholder" | "dropped-fields" }
```

`takeover` migrates one live `external` row into a managed record (or replaces the managed record
with the same `name`, keeping its id, so a broken row can be repaired in place): it validates the
copied configuration, disables the source Loader entry through `pluginManager.setPluginEnabled`
first (so its tools and child process are gone before this bundle registers the same
`mcp__<server>__<tool>` names), then persists the new record with the source's enablement (a disabled source stays disabled)
and connects it only when enabled. A failure after the source was disabled re-enables it; a
validation failure touches nothing. `warnings` reports copied environment values and headers,
which land in this page's storage as plain text.

Every success response also carries `ui: { railEntry: boolean }` — the page-level preference
that decides whether this bundle also adds a left-rail entry (default `true`). The rail entry
is a *second* surface for the same page: Settings → MCP servers always exists, and when the
preference is on, `sidebar.panellist` gets an id `mcp-manager` entry with this bundle's own icon
that opens a `main`-slot page keyed `mcp-manager`. Turning the preference off removes both
registrations; the Settings page and the persisted data are unaffected.

Every success response also carries `external: ExternalView[]` — the MCP servers owned by
other `@deepseek-ai/dsh-mcp-client` entries (bundle rows or `cordis.patch.yml` rows). Disabled
rows are included so the page can switch them back on; `enabled` carries the state.
The page can switch each one on or off through `pluginManager.setPluginEnabled(entryId, …)`
(except a `shadowed` row: enabling it would collide with the managed record of the same name, so
both the control and the route refuse) —
ordinary profile state, not configuration — and offers **Migrate here** for taking the
configuration over. Connecting a second copy without migrating would open two connections and
collide on `mcp__<server>__<tool>` names.

```ts
ExternalView = {
  entryId: string            // Loader row id, e.g. "magpie-mcp-deepwiki"
  serverName?: string        // config.serverName
  transport?: "stdio" | "streamable-http"
  command?: string, args: string[], url?: string
  enabled: boolean           // entry.disabled === false
  shadowed: boolean          // a managed record with this name exists; the switch is disabled
  toolCount: number          // live ctx.tools names starting with `mcp__<serverName>__`
  autoInject: boolean        // default-injection preference from mcp-manager-external.json
}
```

`overridden` means the Plugin Manager updated an override that a later `insert` of the same id
still outranks (a `disabled: true` row before the insert). The route does not stop there: it
rewrites the enablement itself with `host/profile-patch.js` — the stale `id`/`disabled`-only rows
for that id are dropped, the declaration carrying the configuration is kept, and a final
`- id: …` / `disabled: true` row is appended so the last declaration wins. The patch is backed up
as `cordis.patch.yml.bak-<timestamp>` first, only that exact shape is touched (anything else keeps
the `overridden` failure), and the response carries `repaired: true`. The migration performs the
same repair when it cannot disable its source row.

`repair-patch` handles the cross-layer variant: an entry inserted by the home patch and overridden
by the profile patch. `host/patch-repair.js` moves the insert into the profile layer, re-emits the
last override after it, and backs both files up. It accepts flow-style and block-style `insert`
items, and verifies both files still begin with a top-level YAML array before writing; otherwise
it returns the problem and leaves the files untouched. If the profile already inserts the same
id, the repair refuses instead of creating a duplicate declaration. `boot()` runs it once, so a
stuck row is repaired before the user opens the page.

Failure shape (HTTP 200 with `ok: false`, or 4xx only for malformed JSON):

```json
{ "ok": false, "error": { "code": "invalid" | "duplicate-name" | "not-found" | "overridden" | "unsupported" | "conflict" | "storage-readonly" | "internal",
                          "message": "…", "field": "name?" } }
```

`ServerInput` is `Server` without `id`/`createdAt` (all other fields accepted; unknown fields dropped).
`ServerView` is `Server` plus the flattened runtime status fields above
(`status`, `error`, `tools`, `toolCount`, `serverInfo`, `instructions`, `connectedAt`,
`protocolVersion`, `retryAttempt`, `nextRetryAt`, `logs`). `logs` and `retryAttempt` are always
present (`[]`/`0` before the first connection); `nextRetryAt` is present only while a retry is
scheduled.

`conflict` means another process replaced the storage document between the last read and the
write; the in-memory state already follows the document, so the caller reloads and retries.
`reconnect` refuses a server nothing asked to connect (`autoInject: false` with no Session showing
it, or a disabled record) with `invalid` instead of answering `ok` without a new connection.

### Validation rules (Host, authoritative)

- `name` must match `^[A-Za-z0-9_-]{1,32}$` and be unique (case-sensitive) among other servers.
- `transport: "stdio"` requires a non-empty `command`; `http` requires an absolute `http(s)` `url`.
- `env`/`headers` entries: string keys, string values; keys match `^[A-Za-z_][A-Za-z0-9_]*$` for env.
- `autoInject`, when present, must be a boolean (default `true`).
- Saving an existing `id` replaces the record and reconciles the connection in place
  (restart if the connection-relevant fields changed).
- A failed connection never deletes the record: it shows `status: "error"` with `error`.

## Per-session visibility (`/mcp`)

A Session may hide or show individual servers for itself without touching the persisted
configuration:

- Overrides persist in `<DSH_HOME>/storages/mcp-manager-sessions.json` as
  `{ version: 1, sessions: { [sessionId]: { overrides: { [serverId]: boolean }, external: { [entryId]: boolean }, updatedAt } } }`;
  an absent entry follows the server's own `enabled` flag.
- Tools are registered on `agent.ctx` (the documented per-agent composition scope) from an
  `agent/created` listener and released on `agent/disposed`; hiding a server therefore removes
  its tools from that Session's Agent only. Unloading the plugin releases every registration.
  Agents that already exist when the bundle loads (enablement or hot reload) are attached from the
  optional `agents` service (`list()`/`roots()`), so live Sessions are not left without tools.
- A server stays connected while any Session explicitly shows it, so `/mcp on` can reveal a
  globally disabled server without enabling it for everyone.
- `session` / `session-set` are the panel's routes; `SessionServerView` is
  `{ id, name, enabled, status, toolCount, autoInject, visible }`, and the same payload carries
  `external: { entryId, serverName, enabled, toolCount, autoInject, visible }[]`.
  The `/mcp` surfaces derive the shown phase from `visible` first, so a server this Session shows
  is reported by its real connection state (never "disabled" just because the global switch is off).
- `autoInject: false` on a managed server or a foreign entry makes it default-off: it stays
  disconnected (or unregistered) until a Session explicitly shows it with `/mcp on`. The
  preference persists in the server record or `mcp-manager-external.json`, not in session state.
- External `dsh-mcp-client` entries register their tools globally, so hiding one for a Session is
  `agent.ctx.tools.restrict({ deny: [...] })` over that entry's `mcp__<server>__*` names in the
  unfiltered Host catalog (the documented agent-scoped deny mask). Migrated entries whose
  namespace is managed here are excluded. The mask is re-applied on `tools/change`; an entry
  disabled in the profile has no tools to hide, so it can only be enabled there.
- The Host registers the `mcp` command (`list`, `on <server>`, `off <server>`, `reset`); the Web
  client decorates that name with a bare-invocation panel in `conversation.input.overlay`.
- The panel also ships as a Session View: `ctx.slots.register({ name: 'conversation.view',
  id: 'mcp' })` puts an "MCP" tab beside Chat and Trajectory and renders the same rows as a
  full page. No Conversation target is registered; the View reads `api/mcp-manager.session`.
  The View is the only header-level entry: there is no separate header action button.
- Client data is a module-level snapshot behind `dataListeners`; one process-wide timer polls
  only while a server is connecting or waiting on an automatic retry, and the stylesheet is
  injected once from `apply()`.
- Command and panel reset both clear the Session's managed and external overrides in one
  persisted operation. Failed writes preserve the previous in-memory state. Panel responses
  apply only to the Session and opening/request generation that issued them.

## Tool bridging (Host)

For each `ready` server, register `ctx.tools.register({...})` per MCP tool:

- public name: `mcp__<name>__<rawName>` with every char outside `[A-Za-z0-9_-]` replaced by `_`,
  truncated to 64 chars; collisions inside one server resolved by appending `_2`, `_3`, …
  (deterministic per server). A collision **between** servers is detected before registering and
  reported as that server's `status: "error"` with a message naming the tool, instead of silently
  registering nothing; the runtime clears the error once a later sync succeeds (for example after
  the conflicting server is removed or hidden for the Session).
- `description`: MCP tool description, or `Tool <rawName> from MCP server <name>`.
- `parameters`: the MCP `inputSchema`, or `{ "type": "object", "properties": {} }`. A schema
  larger than 64 KiB (UTF-8 JSON) is dropped to the empty object and reported in the server's
  activity log.
- `output`: `{ schema: { type: "object", properties: { content: { type: "array", items: {} }, structuredContent: {} }, required: ["content"], additionalProperties: false }, render: () => [{ type: "text", text: <flattened content> }] }`
- `execute(args, exec)`: `tools/call` for that raw name; MCP `isError: true` must throw an Error
  carrying the flattened text; otherwise return `{ content, structuredContent? }`.
- Text blocks (`{type:"text",text}`) are flattened joined by `\n`; non-text blocks become
  `[<type> content from <tool>]` diagnostics (no image persistence in v1).
- Registering/disconnecting swaps the whole tool set atomically; a failed replacement restores the
  previous executable definitions, and a dispose from plugin unload removes every tool and kills
  every child process.
- The advertised catalog is bounded: more than 512 tools, or more than 8 MiB of serialized schemas,
  fails the handshake with a visible error instead of registering an unbounded tool set on every
  Agent.

## Connection lifecycle

HTTP headers use the protocol version negotiated in the initialize JSON result, accepting
2025-06-18, 2025-03-26 and 2024-11-05; unsupported versions fail before `initialized`.
RPC distinguishes server requests, notifications and responses. Pings receive responses;
unknown server requests receive method-not-found. Timeout/cancel abort the individual HTTP
request and send best-effort cancellation (except initialize). All close paths release active
HTTP work and terminate sessions, including after transport failure.

`initializeTimeoutMs` bounds the **whole handshake** — the `initialize` request, the
`notifications/initialized` notification and every `tools/list` page — so a server that answers
`initialize` and then stalls cannot hold the attempt for the tool timeout. `requestTimeoutMs`
bounds each tool call and each post-handshake catalog refresh.

When advertised, HTTP uses an optional GET SSE stream for notifications (405 is tolerated).
`notifications/tools/list_changed` refreshes the full catalog without restarting the server;
failed registration restores the previous tool set. Retries use bounded exponential backoff
and stop at `retryCount`. Manual reconnect, disable, or config-triggered reconnect
resets the retry budget. Disable/remove/unload cancel outstanding retry timers. Activity retains
bounded recent connection, refresh and tool-call outcomes, excluding tool arguments and results.

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
  body. A toolbar provides search, status filtering and refresh. An empty deployment shows an
  empty-state card with its add button; a non-empty managed list ends with a dashed add row (host Models-page
  pattern: height 44, `--dsw-radius-lg`, `1px dashed --dsw-alias-border-l3`). Each server is a
  card (`--dsw-alias-bg-module-platform`) with status dot, name, transport summary, meta chips,
  expandable tool details and the enable/reconnect/edit/delete actions.
- Add/edit uses a `<dialog>`-like modal (`role="dialog"`, `aria-modal="true"`, Escape closes,
  focus moves to the first field) with the fields for the chosen transport.
  Args are edited one per line; env and headers as `KEY=VALUE` lines.
- Delete asks for confirmation inside the row/modal before calling the Host.
- Only the `--dsw-*` theme tokens listed below; class names prefixed `dshmcp-`.
  Render the `<style>` element inside the root component (unmounting removes it).
- Both surfaces reflect the same committed state. Late background responses must not undo
  completed edits. Leaving a page cancels its background reads; network operations have finite
  deadlines. Dismissing a saving dialog does not cancel an already submitted configuration change
  or allow its completion to close a subsequently opened editor.
- Search and status filters apply to managed and external rows. Copy opens an editable,
  disabled draft with a unique name. Import/export and confirmed recovery are inline sections
  before the final sidebar preference row.
- All visible text goes through `t(...)`; dictionaries cover English and Simplified Chinese.
- After every mutation, render the `servers` array from the response. A 5 s timer exists while
  mounted (cleared on unmount) but each tick reads only while a server is connecting or has a
  scheduled retry, so retry transitions are observed without an idle request loop.

### Theme tokens

The page reads only these variables, all supplied by the Harness theme; tints and veils are
derived from them with `color-mix()`, so light and dark both follow.

Colour: `--dsw-alias-bg-base`, `--dsw-alias-bg-layer-1`, `--dsw-alias-bg-layer-2`,
`--dsw-alias-bg-mask-1`, `--dsw-alias-bg-module-platform`, `--dsw-alias-border-l1`,
`--dsw-alias-border-l2`, `--dsw-alias-border-l3`, `--dsw-alias-brand-primary`,
`--dsw-alias-button-primary-fill`, `--dsw-alias-button-primary-hover`,
`--dsw-alias-interactive-bg-hover`, `--dsw-alias-label-primary`,
`--dsw-alias-label-primary-foreground`, `--dsw-alias-label-secondary`,
`--dsw-alias-label-tertiary`, `--dsw-alias-label-quaternary`,
`--dsw-alias-state-business-primary`, `--dsw-alias-state-error-primary`,
`--dsw-alias-state-idle-primary`, `--dsw-alias-state-success-primary`,
`--dsw-alias-state-warn-primary`, `--dsw-focus-ring-color`.

Geometry and depth: `--dsw-radius-sm`, `--dsw-radius-md`, `--dsw-radius-lg`,
`--dsw-radius-panel`, `--dsw-elevation-prominent`, `--dsw-mask-blur`.

## Constraints

- No runtime dependencies, no imports of `@deepseek-ai/*` packages, no network at build time.
- Host half may import `node:*` builtins only.
- Client half may not touch `document` outside its component, must not require anything but
  `react`, and must keep factories side-effect free.
- Never write outside `mcp-manager/`. Do not install, enable, or remove any bundle.

The optional browser test suite uses isolated development-only Python/Playwright and React
fixtures. These dependencies are not part of the plugin package or the Node-only test suite.
