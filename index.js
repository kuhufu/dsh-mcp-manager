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
 * - `host/routes.js` serves the exact `POST /api/mcp-manager.*` routes the
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
  // Per-agent visibility: `agent.ctx` is the documented composition scope, so a
  // Session's `/mcp` overrides only affect that Agent's tool set.
  ctx.effect(() => {
    if (typeof ctx.on !== 'function') return () => {};
    const offCreated = ctx.on('agent/created', ({ agent }) => manager.attachAgent(agent), { global: true });
    const offDisposed = ctx.on('agent/disposed', ({ agent }) => manager.detachAgent(agent), { global: true });
    const offTools = ctx.on('tools/change', () => manager.refreshAgents(), { global: true });
    return () => {
      if (typeof offCreated === 'function') offCreated();
      if (typeof offDisposed === 'function') offDisposed();
      if (typeof offTools === 'function') offTools();
    };
  }, 'mcp-manager.agents');
  // `/mcp` argument form; the Web client decorates the same name with a panel.
  // `commands` is optional (UI-less deployments have no command surface), so the
  // registration waits for the service instead of failing the plugin.
  const registerCommand = (commands, scope) => {
    const dispose = commands.register({
      name: 'mcp',
      description: 'Show or toggle MCP servers for this session',
      input: { hint: '[list|on|off|reset] [server]' },
      handler: ({ agent, rawInput }) => manager.runCommand(agent, rawInput),
    });
    return () => {
      try {
        if (typeof dispose === 'function') dispose();
      } catch {
        /* the command registry may already be gone */
      }
    };
  };
  if (typeof ctx.inject === 'function') {
    ctx.inject(['commands'], (scope) => {
      scope.effect(() => registerCommand(scope.commands, scope), 'mcp-manager.command');
    });
  } else {
    let commands;
    try {
      commands = typeof ctx.get === 'function' ? ctx.get('commands') : undefined;
    } catch {
      commands = undefined;
    }
    if (commands !== undefined && typeof commands.register === 'function') {
      ctx.effect(() => registerCommand(commands, ctx), 'mcp-manager.command');
    }
  }
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
  void manager.boot().catch((error) => {
    const message = `mcp-manager: boot failed: ${error instanceof Error ? error.message : String(error)}`;
    if (typeof ctx.logger?.error === 'function') ctx.logger.error(message);
    else if (typeof ctx.logger?.warn === 'function') ctx.logger.warn(message);
  });
}
