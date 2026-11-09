# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Added

- Direct MCP JSON import: paste or load a Claude Desktop / Claude Code / Cursor `mcpServers`
  document, a VS Code `servers` object, a top-level server array or a bare map (JSONC comments
  and trailing commas included). Names are normalized and de-duplicated, the transport is
  detected, legacy-SSE entries are skipped with a reason, and imported servers connect
  immediately unless the import is switched to disabled.
- Repair cross-layer duplicate patch declarations at boot, so an entry inserted by the
  home patch and overridden by the profile patch becomes toggleable again.
- Per-Session MCP visibility: the `/mcp` composer panel and `list`/`on`/`off`/`reset` commands,
  an "MCP" View tab beside Chat and Trajectory, and `autoInject` defaults for tool-heavy servers.
  Tools are registered on `agent.ctx`, so one Session can hide a server without changing the
  saved configuration or any other Session; overrides persist in
  `storages/mcp-manager-sessions.json`.
- Configurable handshake/tool deadlines, bounded exponential reconnect, and recent activity.
- Public tool names, per-tool enablement, and dynamic tool-catalog notifications.
- Atomic JSON batch import (disabled by default), credential-optional export, copy, search,
  status filtering, and a confirmed storage recovery interface.
- Host/runtime/migration module separation, a shared client data hook, regression tests,
  a separate `npm run test:browser` command with a CI browser job, and unified
  `npm test` / `npm run check` commands.

### Fixed

- Keep patch repair from ever leaving `cordis.patch.yml` without a top-level YAML array:
  block-style `insert` items are handled, both files are validated before writing, and a
  failed backup now aborts the rewrite.
- Preserve profile header comments and write `[]` instead of an empty file when the last
  declaration is removed; a nested insert entry is never mistaken for a bare override, and
  two inserts for one id are refused instead of merged into a duplicate.
- Reset the automatic retry budget after a successful connection, poll scheduled retries,
  and poll the `/mcp` panel and View while a server is still settling.
- Respect `enabled: false` in imported documents, accept a top-level servers array, count
  only entries that actually start, and reject request bodies over 2 MB.
- Serialize `/mcp on|off` with other mutations and resolve the profile patch through
  `profileContext` instead of guessing `desktop`; preserve a disabled source row's state when
  migrating it, and report a patch repair the Loader did not apply instead of claiming success.
- Commit in-memory configuration only after successful persistence; retain a previous-good
  backup and protect corrupt/future-version files until explicit, archived recovery.
- Use the initialize result for HTTP protocol negotiation; abort canceled/timed-out HTTP
  requests, distinguish server requests from responses, and clean up failed sessions.
- Serialize frontend mutations across both surfaces, reject stale polls, abort reads on
  unmount, and preserve environment-value whitespace when editing.
- Preserve valid records when individual stored rows are invalid, archiving the original before
  the next write; validate raw tool names and omit secret fields entirely from default exports.
- Keep saving dialogs dismissible, protect newer editors from older save completions, show
  accurate external-only filter results, and retain the sidebar preference as the final row.

## [0.1.0] - 2026-11-02

### Added

- Settings → MCP servers page, plus an optional left-rail panel with the
  plugin's own icon, sharing one implementation.
- Add, edit, enable/disable, reconnect and delete MCP servers over stdio or
  Streamable HTTP; tools are registered on `ctx.tools` as
  `mcp__<server>__<tool>` and removed when a server stops.
- Read-only view of MCP servers that other `@deepseek-ai/dsh-mcp-client` entries
  already own, with one-click migration that disables the source entry before
  the new connection is created.
- Page-level preference `ui.railEntry` (default on) stored in
  `$DSH_HOME/storages/mcp-manager.json` and served by
  `POST /api/mcp-manager.ui`.
- Dependency-free MCP client (stdio + Streamable HTTP), atomic JSON persistence
  and eight exact `POST /api/mcp-manager.*` routes.
- The read-only foreign section now lists disabled `dsh-mcp-client` rows too, and each
  row can be switched on or off in place (`/api/mcp-manager.toggle-external`), which is
  the same profile state change as Settings → Plugins. A row whose name is already
  managed here is marked `shadowed` and cannot be enabled, so the two connections can
  never compete for one tool namespace.
- A foreign row the profile patch declares twice is repaired in place: stale override-only
  rows are dropped and the decisive `disabled` row is appended, with a timestamped backup
  beside the patch (`test/patch-repair.smoke.mjs`). Shapes the repair does not understand
  still fail with `overridden` instead of guessing.
- Migrating a server whose name is already managed replaces that record in place
  (id preserved) instead of failing with `duplicate-name`, so a stuck row can be
  repaired by pressing **Migrate here** again.
- Migration waits, bounded at 3 s, for the source entry's tool namespace to be
  released before connecting, so a takeover cannot collide with the connections
  being torn down; a duplicate-name failure now also explains itself in the UI.
- Four framework-free test suites: `test/mcp.smoke.mjs` (29 checks, real stdio
  and HTTP transports, full plugin lifecycle), `test/external.smoke.mjs`
  (93 checks, foreign entries and migration), `test/takeover-race.smoke.mjs`
  (8 checks, the asynchronous tool release during a migration) and
  `test/patch-repair.smoke.mjs` (23 checks, repairing a row the profile patch
  declares twice).
