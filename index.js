/**
 * Host half of `@kuhufu/dsh-mcp-manager`.
 *
 * One Host plugin owns the persisted MCP server list, the live MCP connections,
 * and the tool bridge:
 *
 * - `host/store.js` validates and persists `<DSH_HOME>/storages/mcp-manager.json`
 *   (server records plus the `ui.railEntry` page preference).
 * - `host/mcp.js` speaks stdio/Streamable-HTTP MCP and shapes MCP tools into
 *   Harness `ToolDefinition`s.
 * - `host/routes.js` serves the twelve exact `POST /api/mcp-manager.*` routes the
 *   Settings page consumes.
 *
 * Tool registrations and MCP child processes are owned by `apply`'s effects:
 * plugin unload disposes every tool and settles every connection.
 *
 * @module @kuhufu/dsh-mcp-manager
 */

import { createFetchRoutes } from './host/routes.js';
import { createMcpManager } from './host/manager.js';

/** Cordis plugin name used by loader diagnostics. */
export const name = 'mcp-manager';

/** Services required by this plugin. */
export const inject = ['connection', 'tools'];

/**
 * Register the MCP manager Host plugin.
 *
 * The plugin holds no static state: one instance owns one store, one runtime
 * map, and all of its own registrations.
 *
 * @param {object} ctx - Cordis context carrying `connection`, `tools` and `logger`.
 * @param {object} [config] - unused (the bundle exposes no Config schema).
 * @returns {void}
 */
export function apply(ctx, config = {}) {
  const manager = createMcpManager({ ctx, logger: ctx.logger });
  ctx.effect(() => () => manager.dispose(), 'mcp-manager.lifecycle');
  ctx.effect(() => {
    const registered = [];
    try {
      for (const definition of createFetchRoutes(manager, { logger: ctx.logger })) {
        registered.push(ctx.connection.fetch.register(definition));
      }
    } catch (error) {
      for (const pending of registered) void pending.then((dispose) => dispose()).catch(() => {});
      throw error;
    }
    return () => Promise.allSettled(registered.map((pending) => pending.then((dispose) => dispose())));
  }, 'mcp-manager.routes');
  void manager.boot();
}
