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
 * - `host/routes.js` serves the seven exact `POST /api/mcp-manager.*` routes the
 *   Settings page consumes.
 *
 * Tool registrations and MCP child processes are owned by `apply`'s effects:
 * plugin unload disposes every tool and settles every connection.
 *
 * @module @kuhufu/dsh-mcp-manager
 */

import { repairDuplicateRow } from './host/profile-patch.js';
import { connect, buildToolDefinitions } from './host/mcp.js';
import { createFetchRoutes } from './host/routes.js';
import {
  ManagerError,
  buildServerRecord,
  createStore,
  validateServerInput,
  validateUi,
} from './host/store.js';

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

/**
 * Create the live manager: persisted records plus their runtime status, tool
 * registrations and connections.
 *
 * @param {{
 *   ctx: { tools: { register: (definition: object) => () => void }, logger?: object },
 *   logger?: { warn?: (message: string) => void, info?: (message: string) => void, error?: (message: string) => void },
 * }} options - plugin context and diagnostics sink.
 * @returns {object} manager handle consumed by the routes and the plugin effects.
 */
function createMcpManager({ ctx, logger }) {
  const store = createStore({ logger });
  /** @type {Map<string, object>} */
  const runtime = new Map();
  /** @type {Set<Promise<unknown>>} */
  const inflight = new Set();
  let disposed = false;
  let mutationChain = Promise.resolve();
  /** @type {Promise<void>|undefined} */
  let booted;

  const warn = (message) => {
    if (typeof logger?.warn === 'function') logger.warn(`mcp-manager: ${message}`);
  };
  const fail = (message) => {
    if (typeof logger?.error === 'function') logger.error(`mcp-manager: ${message}`);
    else warn(message);
  };

  /**
   * Serialize every mutation so validation, persistence and reconciliation
   * cannot interleave across concurrent route handlers.
   * @template T
   * @param {() => Promise<T>} task - mutation body.
   * @returns {Promise<T>} task result.
   */
  function enqueue(task) {
    const run = mutationChain.then(task);
    mutationChain = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * Track one background connection attempt so unload can await quiescence.
   * @template T
   * @param {Promise<T>} promise - attempt.
   * @returns {Promise<T>} same promise, with failures logged.
   */
  function track(promise) {
    const tracked = promise
      .catch((error) => {
        warn(`background connection attempt failed: ${formatError(error)}`);
      })
      .finally(() => {
        inflight.delete(tracked);
      });
    inflight.add(tracked);
    return tracked;
  }

  /**
   * Fetch (or create) the runtime entry for one server id.
   * @param {string} id - server id.
   * @returns {object} mutable runtime entry.
   */
  function ensureState(id) {
    let state = runtime.get(id);
    if (state === undefined) {
      state = {
        status: 'stopped',
        error: undefined,
        tools: [],
        toolCount: 0,
        serverInfo: undefined,
        instructions: undefined,
        connectedAt: undefined,
        connection: undefined,
        controller: undefined,
        disposers: [],
        fingerprint: undefined,
        attempt: 0,
      };
      runtime.set(id, state);
    }
    return state;
  }

  /** Release one runtime entry's tool registrations. */
  function disposeTools(state) {
    for (const dispose of state.disposers.splice(0)) {
      try {
        dispose();
      } catch (error) {
        warn(`tool disposal failed: ${formatError(error)}`);
      }
    }
  }

  /** Reset one runtime entry to a non-connected status. */
  function resetState(state, status) {
    state.status = status;
    state.error = undefined;
    state.tools = [];
    state.toolCount = 0;
    state.serverInfo = undefined;
    state.instructions = undefined;
    state.connectedAt = undefined;
    state.fingerprint = undefined;
  }

  /** Fields whose change requires a fresh connection and tool swap. */
  function fingerprintOf(server) {
    return JSON.stringify([
      server.name,
      server.transport,
      server.command,
      server.args,
      server.env,
      server.cwd,
      server.url,
      server.headers,
    ]);
  }

  /**
   * Flatten one persisted record plus its runtime entry into the `ServerView`
   * the Client renders.
   * @param {object} server - persisted record.
   * @returns {object} view with flattened runtime fields.
   */
  function toView(server) {
    /** @type {Record<string, unknown>} */
    const view = { ...server };
    const state = runtime.get(server.id);
    if (state === undefined) {
      view.status = 'stopped';
      view.tools = [];
      view.toolCount = 0;
      return view;
    }
    view.status = state.status;
    if (state.error !== undefined) view.error = state.error;
    view.tools = state.tools.map((tool) => ({
      name: tool.name,
      ...(tool.description === undefined ? {} : { description: tool.description }),
    }));
    view.toolCount = state.toolCount;
    if (state.serverInfo !== undefined) view.serverInfo = state.serverInfo;
    if (state.instructions !== undefined) view.instructions = state.instructions;
    if (state.connectedAt !== undefined) view.connectedAt = state.connectedAt;
    return view;
  }

  /** @returns {object[]} fresh `ServerView[]`. */
  function list() {
    return store.list().map(toView);
  }

  /**
   * Connect one server and swap its tool generation in.
   * @param {object} server - persisted record to connect.
   * @param {number} [token] - pre-allocated attempt token from {@link scheduleReconnect}.
   * @returns {Promise<void>} settles when the attempt finishes, success or not.
   */
  async function startServer(server, token) {
    const state = ensureState(server.id);
    const attempt = token ?? (state.attempt += 1);
    if (attempt !== state.attempt || disposed) return;

    const previous = state.connection;
    state.connection = undefined;
    disposeTools(state);
    resetState(state, 'connecting');
    if (previous !== undefined) {
      // Only reachable through an explicit restart; settle the old child first.
      try {
        await previous.close();
      } catch (error) {
        warn(`could not close the previous connection for "${server.name}": ${formatError(error)}`);
      }
      if (attempt !== state.attempt || disposed) return;
    }

    const controller = new AbortController();
    state.controller = controller;
    const finishAttempt = () => {
      if (state.controller === controller) state.controller = undefined;
    };

    let connection;
    try {
      connection = await connect(server, { signal: controller.signal });
    } catch (error) {
      finishAttempt();
      if (attempt !== state.attempt || disposed) return;
      state.status = 'error';
      state.error = formatError(error);
      warn(`"${server.name}" failed to connect: ${state.error}`);
      return;
    }
    finishAttempt();

    if (attempt !== state.attempt || disposed) {
      await connection.close().catch(() => {});
      return;
    }

    state.connection = connection;
    connection.onClose((reason) => {
      if (state.connection !== connection || attempt !== state.attempt) return;
      state.connection = undefined;
      disposeTools(state);
      resetState(state, 'error');
      state.error = reason;
      warn(`"${server.name}" connection closed: ${reason}`);
    });

    /** @type {Array<() => void>} */
    const registered = [];
    try {
      const definitions = buildToolDefinitions({
        serverName: server.name,
        tools: connection.tools,
        callTool: (rawName, args, signal) => connection.callTool(rawName, args, signal),
      });
      for (const item of definitions) registered.push(ctx.tools.register(item.definition));
    } catch (error) {
      for (const dispose of registered) {
        try {
          dispose();
        } catch {
          // Registration rollback is best effort.
        }
      }
      await connection.close().catch(() => {});
      if (attempt !== state.attempt || disposed) return;
      state.connection = undefined;
      resetState(state, 'error');
      state.error = `tool registration failed: ${formatError(error)}`;
      fail(`"${server.name}": ${state.error}`);
      return;
    }

    if (attempt !== state.attempt || disposed) {
      for (const dispose of registered) {
        try {
          dispose();
        } catch {
          // Late cancellation cleanup.
        }
      }
      await connection.close().catch(() => {});
      return;
    }

    state.disposers = registered;
    state.tools = connection.tools.map((tool) => {
      const description = typeof tool.description === 'string' && tool.description.trim() !== '' ? tool.description : undefined;
      return description === undefined ? { name: tool.name } : { name: tool.name, description };
    });
    state.toolCount = state.tools.length;
    state.serverInfo = connection.serverInfo;
    state.instructions = connection.instructions;
    state.connectedAt = Date.now();
    state.fingerprint = fingerprintOf(server);
    state.status = 'ready';
    if (typeof logger?.info === 'function') logger.info(`mcp-manager: "${server.name}" connected with ${state.toolCount} tool(s)`);
  }

  /**
   * Tear one server down: kill the child, remove its tools, show `stopped`.
   * @param {object} server - persisted record.
   * @returns {Promise<void>} settles after the transport is closed.
   */
  async function stopServer(server) {
    const state = runtime.get(server.id);
    if (state === undefined) return;
    state.attempt += 1;
    state.controller?.abort();
    state.controller = undefined;
    disposeTools(state);
    const connection = state.connection;
    state.connection = undefined;
    resetState(state, 'stopped');
    if (connection !== undefined) {
      try {
        await connection.close();
      } catch (error) {
        warn(`could not close "${server.name}": ${formatError(error)}`);
      }
    }
  }

  /**
   * Restart one server: invalidate the current attempt, kill the connection,
   * then reconnect with a fresh tool generation.
   * @param {object} server - persisted record.
   * @returns {void}
   */
  function scheduleReconnect(server) {
    const state = ensureState(server.id);
    const previous = state.connection;
    state.connection = undefined;
    const attempt = (state.attempt += 1);
    state.controller?.abort();
    state.controller = undefined;
    disposeTools(state);
    resetState(state, 'connecting');
    track((async () => {
      if (previous !== undefined) {
        try {
          await previous.close();
        } catch (error) {
          warn(`could not close "${server.name}": ${formatError(error)}`);
        }
      }
      await startServer(server, attempt);
    })());
  }

  /**
   * Apply the desired state of one record to its live connection.
   * @param {object} server - freshly persisted record.
   * @returns {void}
   */
  function reconcile(server) {
    const state = ensureState(server.id);
    if (!server.enabled) {
      void stopServer(server).catch((error) => {
        warn(`could not stop "${server.name}": ${formatError(error)}`);
      });
      return;
    }
    if (state.status === 'ready' && state.connection !== undefined && state.fingerprint === fingerprintOf(server)) return;
    scheduleReconnect(server);
  }

  /**
   * Resolve one persisted record by id or raise `not-found`.
   * @param {unknown} id - requested id.
   * @returns {object} persisted record.
   */
  function requireServer(id) {
    if (typeof id !== 'string' || id === '') {
      throw new ManagerError('invalid', 'request body must include a non-empty "id"', 'id');
    }
    const server = store.list().find((entry) => entry.id === id);
    if (server === undefined) throw new ManagerError('not-found', `no MCP server with id "${id}"`);
    return server;
  }

  /**
   * Load persisted state and connect every enabled server.
   * @returns {Promise<void>} settles once the initial sweep is scheduled.
   */
  function boot() {
    booted ??= (async () => {
      try {
        await store.load();
      } catch (error) {
        fail(`could not load persisted servers: ${formatError(error)}`);
        return;
      }
      if (disposed) return;
      for (const server of store.list()) {
        if (!server.enabled) continue;
        track(startServer(server));
      }
    })();
    return booted;
  }

  /**
   * Create or replace one server record, then reconcile its connection.
   * @param {{ id?: string, server: unknown }} payload - route payload.
   * @returns {Promise<{ id: string, servers: object[] }>} new id plus fresh views.
   */
  function save(payload) {
    return enqueue(async () => {
      await store.load();
      const id = payload.id;
      if (id !== undefined && (typeof id !== 'string' || id === '')) {
        throw new ManagerError('invalid', 'id must be a non-empty string', 'id');
      }
      const current = store.list();
      const existing = id === undefined ? undefined : current.find((entry) => entry.id === id);
      if (id !== undefined && existing === undefined) {
        throw new ManagerError('not-found', `no MCP server with id "${id}"`);
      }
      const validated = validateServerInput(payload.server, { servers: current, id: existing?.id });
      const record = buildServerRecord(validated, { existing });
      const next = existing === undefined
        ? [...current, record]
        : current.map((entry) => (entry.id === record.id ? record : entry));
      await store.setServers(next);
      reconcile(record);
      return { id: record.id, servers: list() };
    });
  }

  /**
   * Remove one server record and release its connection and tools.
   * @param {{ id: string }} payload - route payload.
   * @returns {Promise<{ servers: object[] }>} fresh views.
   */
  function remove(payload) {
    return enqueue(async () => {
      await store.load();
      const server = requireServer(payload.id);
      const current = store.list();
      await store.setServers(current.filter((entry) => entry.id !== server.id));
      await stopServer(server);
      runtime.delete(server.id);
      return { servers: list() };
    });
  }

  /**
   * Enable or disable one server, reconnecting when it becomes enabled.
   * @param {{ id: string, enabled: boolean }} payload - route payload.
   * @returns {Promise<{ servers: object[] }>} fresh views.
   */
  function toggle(payload) {
    return enqueue(async () => {
      await store.load();
      const server = requireServer(payload.id);
      if (typeof payload.enabled !== 'boolean') {
        throw new ManagerError('invalid', 'enabled must be a boolean', 'enabled');
      }
      if (server.enabled === payload.enabled) return { servers: list() };
      const record = { ...server, enabled: payload.enabled };
      const current = store.list();
      await store.setServers(current.map((entry) => (entry.id === record.id ? record : entry)));
      if (record.enabled) reconcile(record);
      else await stopServer(record);
      return { servers: list() };
    });
  }

  /**
   * Force a fresh connection and tool generation for one enabled server.
   * @param {{ id: string }} payload - route payload.
   * @returns {Promise<{ servers: object[] }>} fresh views.
   */
  function reconnect(payload) {
    return enqueue(async () => {
      await store.load();
      const server = requireServer(payload.id);
      if (server.enabled) scheduleReconnect(server);
      return { servers: list() };
    });
  }

  /**
   * Resolve the page-level preference that decides whether this bundle also
   * installs a left-rail entry. The Settings page is unaffected by it.
   *
   * @returns {{ railEntry: boolean }} resolved preference (default `true`).
   */
  function ui() {
    return store.ui();
  }

  /**
   * Persist the page-level preference. Serialized with the server mutations so
   * concurrent route handlers can never interleave two documents.
   *
   * @param {{ railEntry: boolean }} payload - route payload.
   * @returns {Promise<{ servers: object[], ui: { railEntry: boolean } }>} fresh views plus the stored preference.
   */
  function setUi(payload) {
    return enqueue(async () => {
      const normalized = validateUi(payload);
      await store.load();
      await store.setUi(normalized);
      return { servers: list(), ui: ui() };
    });
  }

  /**
   * Release every tool registration and settle every MCP child process.
   * Idempotent; awaited by plugin unload.
   * @returns {Promise<void>} settles when all connections are closed.
   */
  async function dispose() {
    if (disposed) return;
    disposed = true;
    const states = [...runtime.values()];
    runtime.clear();
    for (const state of states) {
      state.attempt += 1;
      state.controller?.abort();
      state.controller = undefined;
      disposeTools(state);
      const connection = state.connection;
      state.connection = undefined;
      resetState(state, 'stopped');
      if (connection !== undefined) {
        try {
          await connection.close();
        } catch (error) {
          warn(`could not close a connection during unload: ${formatError(error)}`);
        }
      }
    }
    await Promise.allSettled([...inflight]);
    await Promise.allSettled([mutationChain]);
    await store.flush().catch((error) => {
      warn(`could not flush the storage document during unload: ${formatError(error)}`);
    });
  }

  /**
   * Wait until nothing still registers `mcp__<serverName>__*`.
   *
   * Disabling a Loader row releases its tools asynchronously; migrating the
   * server before that lands would collide on the shared tool names. The wait
   * is bounded: on timeout the migration continues and the registration error
   * reports the conflict.
   *
   * @param {string} serverName - tool namespace of the migrated server.
   * @param {number} timeoutMs - upper bound for the wait.
   * @returns {Promise<void>} settles when the namespace is free or the bound is hit.
   */
  async function waitForToolRelease(serverName, timeoutMs) {
    if (typeof serverName !== 'string' || serverName === '') return;
    const prefix = `mcp__${serverName}__`;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      let busy = false;
      try {
        const schemas = ctx.tools !== undefined && typeof ctx.tools.schemas === 'function' ? ctx.tools.schemas() : [];
        busy = Array.isArray(schemas)
          && schemas.some((schema) => schema !== null && typeof schema === 'object'
            && typeof schema.name === 'string' && schema.name.startsWith(prefix));
      } catch {
        busy = false;
      }
      if (!busy) return;
      if (Date.now() >= deadline) return;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
  }

  /**
   * Describe the MCP servers owned by other `@deepseek-ai/dsh-mcp-client` entries.
   *
   * The page manages this bundle's own records only, so the whole deployment
   * would otherwise hide every row configured through a bundle or the profile
   * patch. These rows are read-only on purpose: connecting them here as well
   * would open a second connection and collide on `mcp__<server>__<tool>` names.
   *
   * @returns {object[]} `{ entryId, serverName, transport, command, args, url, enabled, toolCount }`.
   */
  function external() {
    let loader;
    try {
      loader = typeof ctx.get === 'function' ? ctx.get('loader') : undefined;
    } catch {
      loader = undefined;
    }
    if (loader === undefined || typeof loader.entries !== 'function') return [];
    let schemas = [];
    try {
      const current = ctx.tools !== undefined && typeof ctx.tools.schemas === 'function' ? ctx.tools.schemas() : [];
      if (Array.isArray(current)) schemas = current;
    } catch {
      schemas = [];
    }
    const managedNames = new Set(store.list().map((server) => server.name));
    const rows = [];
    for (const entry of loader.entries()) {
      const options = entry === null || entry === undefined ? undefined : entry.options;
      if (options === undefined || options === null || options.name !== '@deepseek-ai/dsh-mcp-client') continue;
      const config = options.config !== null && typeof options.config === 'object' ? options.config : {};
      const serverName = typeof config.serverName === 'string' && config.serverName !== '' ? config.serverName : undefined;
      const prefix = serverName === undefined ? undefined : `mcp__${serverName}__`;
      const toolCount = prefix === undefined
        ? 0
        : schemas.filter((schema) => schema !== null && typeof schema === 'object' && typeof schema.name === 'string' && schema.name.startsWith(prefix)).length;
      rows.push({
        entryId: typeof entry.id === 'string' ? entry.id : (typeof options.id === 'string' ? options.id : ''),
        serverName,
        transport: config.transport === 'stdio' || config.transport === 'streamable-http' ? config.transport : undefined,
        command: typeof config.command === 'string' ? config.command : undefined,
        args: Array.isArray(config.args) ? config.args.filter((arg) => typeof arg === 'string') : [],
        url: typeof config.url === 'string' ? config.url : undefined,
        enabled: entry.disabled !== true,
        // A managed record with this name owns the namespace; switching the source
        // on would collide with it, so the page disables that control.
        shadowed: serverName !== undefined && managedNames.has(serverName),
        toolCount,
      });
    }
    return rows;
  }

  /**
   * Rewrite the profile patch when one row is declared twice.
   *
   * The Host's Plugin Manager updates the last override row in place, so a later
   * `insert` of the same id keeps winning. Rewriting the enablement at the end of
   * the sequence is the only way to make the request effective; the helper keeps a
   * backup and refuses shapes it does not understand.
   *
   * @param {string} entryId - Loader row id.
   * @param {boolean} enabled - requested state.
   * @returns {Promise<boolean>} whether the patch was rewritten.
   */
  async function repairEntry(entryId, enabled) {
    let profile;
    try {
      profile = typeof ctx.get === 'function' ? ctx.get('profileContext') : undefined;
    } catch {
      profile = undefined;
    }
    const patchPath = profile !== undefined && profile !== null && typeof profile.patchPath === 'string'
      ? profile.patchPath
      : undefined;
    if (patchPath === undefined) return false;
    const result = await repairDuplicateRow(patchPath, entryId, enabled);
    if (!result.repaired) {
      if (typeof result.reason === 'string') warn(`could not repair "${entryId}": ${result.reason}`);
      return false;
    }
    warn(`repaired duplicate declarations for "${entryId}"; backup at ${String(result.backup)}`);
    return true;
  }

  /**
   * Wait until the Loader reflects the requested enablement of one row.
   *
   * @param {string} entryId - Loader row id.
   * @param {boolean} enabled - requested state.
   * @param {number} timeoutMs - upper bound.
   * @returns {Promise<boolean>} whether the state was observed.
   */
  async function waitForEntryState(entryId, enabled, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const loader = typeof ctx.get === 'function' ? ctx.get('loader') : undefined;
        if (loader !== undefined && typeof loader.entries === 'function') {
          for (const entry of loader.entries()) {
            if (entry !== null && entry !== undefined && entry.id === entryId) {
              if ((entry.disabled !== true) === enabled) return true;
              break;
            }
          }
        }
      } catch {
        // fall through to the next poll
      }
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
  }

  /**
   * Build the failure for a row another layer keeps re-declaring.
   *
   * A profile patch can hold both a `disabled: true` override and a later
   * `insert` for the same id. `pluginManager.setPluginEnabled` updates the
   * override in place, so the later insert still wins and reports `overridden`;
   * the loader, not this plugin, decides that outcome.
   *
   * @param {string} entryId - Loader row id.
   * @param {boolean} enabled - requested state.
   * @returns {ManagerError} failure carrying the `overridden` code.
   */
  function overriddenFailure(entryId, enabled) {
    return new ManagerError(
      'overridden',
      `entry "${entryId}" is declared more than once in the profile patch, so the profile cannot ${enabled ? 'enable' : 'disable'} it: remove the duplicate row or move the disabled row after the insert`,
    );
  }

  /**
   * Enable or disable one `@deepseek-ai/dsh-mcp-client` row.
   *
   * The page must not edit another bundle's rows as configuration, but switching
   * one on or off is ordinary profile state, exactly what Settings → Plugins
   * does; routing it through `pluginManager` keeps the persisted override and
   * the live reload in one place.
   *
   * @param {{ entryId: string, enabled: boolean }} payload - Loader row id and target state.
   * @returns {Promise<{ servers: object[] }>} fresh managed views; the route adds `external` and `ui`.
   */
  function setExternalEnabled(payload) {
    return enqueue(async () => {
      const entryId = typeof payload.entryId === 'string' ? payload.entryId : '';
      if (entryId === '') {
        throw new ManagerError('invalid', 'request body must include a non-empty "entryId"', 'entryId');
      }
      if (typeof payload.enabled !== 'boolean') {
        throw new ManagerError('invalid', 'enabled must be a boolean', 'enabled');
      }
      let loader;
      try {
        loader = typeof ctx.get === 'function' ? ctx.get('loader') : undefined;
      } catch {
        loader = undefined;
      }
      if (loader === undefined || typeof loader.entries !== 'function') {
        throw new ManagerError('unsupported', 'the Loader is not available in this deployment');
      }
      let source;
      for (const entry of loader.entries()) {
        if (entry === null || entry === undefined || entry.id !== entryId) continue;
        source = entry;
        break;
      }
      if (source === undefined) throw new ManagerError('not-found', `no Loader entry "${entryId}"`);
      if (source.options === null || source.options === undefined || source.options.name !== '@deepseek-ai/dsh-mcp-client') {
        throw new ManagerError('invalid', `entry "${entryId}" is not a dsh-mcp-client entry`, 'entryId');
      }
      if (payload.enabled) {
        const config = source.options.config !== null && typeof source.options.config === 'object' ? source.options.config : {};
        const name = typeof config.serverName === 'string' ? config.serverName : undefined;
        if (name !== undefined && store.list().some((server) => server.name === name)) {
          throw new ManagerError('invalid', `"${name}" is managed on this page; enabling its dsh-mcp-client row would collide on tool names`, 'enabled');
        }
      }
      const manager = typeof ctx.get === 'function' ? ctx.get('pluginManager') : undefined;
      if (manager === undefined || manager === null || typeof manager.setPluginEnabled !== 'function') {
        throw new ManagerError('unsupported', 'plugin management is not available in this deployment');
      }
      const change = await manager.setPluginEnabled(entryId, payload.enabled);
      const application = change === null || change === undefined ? 'applied' : change.application;
      if (application === 'overridden') {
        if (!await repairEntry(entryId, payload.enabled)) throw overriddenFailure(entryId, payload.enabled);
        await waitForEntryState(entryId, payload.enabled, 3000);
        return { servers: list(), repaired: true };
      }
      if (application !== 'applied') {
        throw new ManagerError('internal', `entry "${entryId}" could not be ${payload.enabled ? 'enabled' : 'disabled'} live (${String(application)}); restart the app and retry`);
      }
      if (payload.enabled && source.options.config !== null && typeof source.options.config === 'object') {
        const name = source.options.config.serverName;
        if (typeof name === 'string' && name !== '') await waitForToolRelease(name, 300);
      }
      return { servers: list() };
    });
  }

  /**
   * Take over one live `@deepseek-ai/dsh-mcp-client` entry.
   *
   * Order matters: the source row is disabled first so its tools and child
   * process are gone before this bundle registers the same `mcp__<server>__<tool>`
   * names. Validation runs before either change, and a failure after disabling
   * re-enables the source rather than leaving the deployment without the server.
   *
   * @param {{ entryId: string }} payload - Loader row id of the source entry.
   * @returns {Promise<{ id: string, servers: object[], warnings: string[] }>} created id plus fresh views.
   */
  function takeover(payload) {
    return enqueue(async () => {
      await store.load();
      const entryId = typeof payload.entryId === 'string' ? payload.entryId : '';
      if (entryId === '') {
        throw new ManagerError('invalid', 'request body must include a non-empty "entryId"', 'entryId');
      }
      let loader;
      try {
        loader = typeof ctx.get === 'function' ? ctx.get('loader') : undefined;
      } catch {
        loader = undefined;
      }
      if (loader === undefined || typeof loader.entries !== 'function') {
        throw new ManagerError('unsupported', 'the Loader is not available in this deployment');
      }
      let source;
      for (const entry of loader.entries()) {
        if (entry === null || entry === undefined) continue;
        if (entry.id !== entryId) continue;
        source = entry;
        break;
      }
      if (source === undefined) {
        throw new ManagerError('not-found', `no Loader entry "${entryId}"`);
      }
      if (source.options === null || source.options === undefined || source.options.name !== '@deepseek-ai/dsh-mcp-client') {
        throw new ManagerError('invalid', `entry "${entryId}" is not a dsh-mcp-client entry`, 'entryId');
      }
      const config = source.options.config !== null && typeof source.options.config === 'object' ? source.options.config : {};
      const input = {
        name: typeof config.serverName === 'string' ? config.serverName : `${entryId}`,
        enabled: true,
        transport: config.transport === 'streamable-http' ? 'http' : 'stdio',
        command: config.command,
        args: config.args,
        env: config.env,
        cwd: config.cwd,
        url: config.url,
        headers: config.headers,
      };
      const current = store.list();
      // Migrating onto a name this page already manages replaces that record in
      // place: the user's intent is to fix/repoint the server, not to fail on a
      // duplicate or to leave two records with the same tool namespace.
      const existing = current.find((server) => server.name === input.name);
      const validated = validateServerInput(input, { servers: current, id: existing === undefined ? undefined : existing.id });
      const record = buildServerRecord(validated, existing === undefined ? {} : { existing });
      const manager = typeof ctx.get === 'function' ? ctx.get('pluginManager') : undefined;
      if (manager === undefined || manager === null || typeof manager.setPluginEnabled !== 'function') {
        throw new ManagerError('unsupported', 'plugin management is not available in this deployment');
      }
      const wasEnabled = source.disabled !== true;
      if (wasEnabled) {
        const change = await manager.setPluginEnabled(entryId, false);
        const application = change === null || change === undefined ? 'applied' : change.application;
        if (change !== null && change !== undefined && change.changed === false) {
          // Already off; nothing to undo.
        } else if (application === 'overridden') {
          if (!await repairEntry(entryId, false)) throw overriddenFailure(entryId, false);
          await waitForEntryState(entryId, false, 3000);
        } else if (application !== 'applied') {
          try {
            await manager.setPluginEnabled(entryId, true);
          } catch {
            // Best effort: the row stays disabled and the error names the reason.
          }
          throw new ManagerError('internal', `entry "${entryId}" could not be disabled live (${String(application)}); restart the app and retry`);
        }
        // The source's tools leave the registry asynchronously; wait them out so
        // our registration cannot collide with the connections being torn down.
        await waitForToolRelease(input.name, 3000);
      }
      try {
        const next = existing === undefined
          ? [...current, record]
          : current.map((server) => (server.id === record.id ? record : server));
        await store.setServers(next);
      } catch (error) {
        if (wasEnabled) {
          try {
            await manager.setPluginEnabled(entryId, true);
          } catch {
            // Best effort rollback.
          }
        }
        throw error;
      }
      reconcile(record);
      const warnings = [];
      const env = input.env !== null && typeof input.env === 'object' ? Object.keys(input.env) : [];
      const headers = input.headers !== null && typeof input.headers === 'object' ? Object.keys(input.headers) : [];
      if (env.length > 0 || headers.length > 0) {
        warnings.push(`copied ${env.length} environment value(s) and ${headers.length} header(s) into this page's storage as plain text`);
      }
      return {
        id: record.id,
        replaced: existing !== undefined,
        servers: list(),
        warnings,
      };
    });
  }

  return {
    list,
    external,
    setExternalEnabled,
    takeover,
    save,
    remove,
    toggle,
    reconnect,
    ui,
    setUi,
    boot,
    dispose,
    ready: boot,
  };
}

/**
 * Render any thrown value as human-readable failure text.
 * @param {unknown} error - thrown value.
 * @returns {string} message.
 */
function formatError(error) {
  if (error instanceof Error) return error.message === '' ? error.name : error.message;
  return String(error);
}
