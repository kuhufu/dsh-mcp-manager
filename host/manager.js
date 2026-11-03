/**
 * Serialized configuration operations and persistence ownership.
 *
 * @module @kuhufu/dsh-mcp-manager/host/manager
 */

import { formatError } from './errors.js';
import { createExternalOperations } from './external.js';
import { createRuntime } from './runtime.js';
import { serverView } from './routes.js';
import {
  ManagerError,
  buildServerRecord,
  createStore,
  validateServerInput,
  validateUi,
} from './store.js';

/**
 * Serialized configuration operations and persistence ownership.
 *
 * @param {object} options - Host dependencies.
 * @param {object} options.ctx - Cordis context with tools and optional Loader services.
 * @param {object} [options.logger] - Host diagnostics sink.
 * @returns {object} manager operations consumed by the Fetch route adapter.
 */
export function createMcpManager({ ctx, logger }) {
  const store = createStore({ logger });
  /** @type {Set<Promise<unknown>>} */
  const inflight = new Set();
  let disposed = false;
  let disposal;
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
    const run = mutationChain.then(() => {
      if (disposed) throw new ManagerError('internal', 'MCP manager is shutting down');
      return task();
    });
    mutationChain = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * Track one background connection attempt so unload can await quiescence.
   * @param {Promise<unknown>} promise - background operation.
   * @returns {Promise<void>} tracked completion; failures are logged and consumed.
   */
  function track(promise) {
    const tracked = promise
      .catch((error) => {
        warn(`background connection attempt failed: ${formatError(error)}`);
      })
      .then(() => undefined)
      .finally(() => {
        inflight.delete(tracked);
      });
    inflight.add(tracked);
    return tracked;
  }

  const { stateOf, startServer, stopServer, reconnectServer, reconcile, updateTools, stopAll, forget, hasTool } = createRuntime({ ctx, store, logger, track, warn, fail, isDisposed: () => disposed });

  /** @returns {object[]} detached views suitable for the route responses. */
  function list() { return store.list().map((server) => serverView(server, stateOf(server.id))); }

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
      forget(server.id);
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
      if (server.enabled) reconnectServer(server);
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

  function importServers(payload) {
    return enqueue(async () => {
      await store.load();
      const document = payload.document;
      let inputs = Array.isArray(document) ? document : document?.servers;
      if (!inputs && document?.mcpServers && typeof document.mcpServers === 'object') {
        inputs = Object.entries(document.mcpServers).map(([name, config]) => ({ ...config, name, transport: config?.url ? 'http' : 'stdio' }));
      }
      if (!Array.isArray(inputs) || inputs.length === 0 || inputs.length > 200) throw new ManagerError('invalid', 'Import must contain 1–200 servers', 'document');
      if (document?.version !== undefined && document.version !== 1) throw new ManagerError('invalid', 'Unsupported import version', 'document');
      const next = store.list();
      for (const input of inputs) {
        const validated = validateServerInput({ ...input, enabled: false }, { servers: next });
        next.push(buildServerRecord(validated));
      }
      await store.setServers(next);
      return { servers: list(), imported: inputs.length };
    });
  }

  function exportServers(payload = {}) {
    const servers = store.list().map(({ id, createdAt, ...server }) => {
      if (payload.includeSecrets !== true) { delete server.env; delete server.headers; }
      return server;
    });
    return { version: 1, servers };
  }

  function setToolEnabled(payload) {
    return enqueue(async () => {
      await store.load();
      const server = requireServer(payload.id);
      if (typeof payload.name !== 'string' || !payload.name || typeof payload.enabled !== 'boolean') throw new ManagerError('invalid', 'Tool name and enabled boolean are required');
      if (!hasTool(server.id, payload.name)) {
        throw new ManagerError('not-found', `no advertised tool "${payload.name}" on server "${server.name}"`, 'name');
      }
      const disabled = new Set(server.disabledTools ?? []);
      if (payload.enabled) disabled.delete(payload.name); else disabled.add(payload.name);
      const record = { ...server, disabledTools: [...disabled] };
      await store.setServers(store.list().map((item) => item.id === record.id ? record : item));
      updateTools(record);
      return { servers: list() };
    });
  }

  function recoverStorage(payload) {
    return enqueue(async () => {
      const result = await store.recover(payload.mode);
      await stopAll();
      for (const server of store.list()) if (server.enabled) track(startServer(server));
      return { servers: list(), archive: result.archive };
    });
  }

  /**
   * Release every tool registration and settle every MCP child process.
   * Idempotent; awaited by plugin unload.
   * @returns {Promise<void>} settles when all connections are closed.
   */
  function dispose() {
    disposal ??= (async () => {
      disposed = true;
      // Interrupt active connections first, then drain mutations before the final sweep.
      await stopAll();
      await mutationChain;
      await stopAll();
      await Promise.allSettled([...inflight]);
      await store.flush();
    })();
    return disposal;
  }

  const { external, setExternalEnabled, takeover } = createExternalOperations({ ctx, store, warn, enqueue, list, reconcile });

  return {
    list,
    storage: store.status,
    recoverStorage,
    importServers,
    exportServers,
    setToolEnabled,
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

