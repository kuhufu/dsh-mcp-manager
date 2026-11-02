# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
