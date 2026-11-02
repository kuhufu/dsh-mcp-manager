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
  and seven exact `POST /api/mcp-manager.*` routes.
- Two framework-free test suites: `test/mcp.smoke.mjs` (29 checks, real stdio
  and HTTP transports, full plugin lifecycle) and `test/external.smoke.mjs`
  (54 checks, foreign entries and migration).
