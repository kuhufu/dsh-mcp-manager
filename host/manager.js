/**
 * Serialized configuration operations and persistence ownership.
 *
 * @module @kuhufu/dsh-mcp-manager/host/manager
 */

import { createAgentRegistry } from './agents.js';
import { formatError } from './errors.js';
import { createExternalOperations } from './external.js';
import { createRuntime } from './runtime.js';
import { serverView } from './routes.js';
import { createExternalDefaults } from './external-defaults.js';
import { createSessionState } from './session-state.js';
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

  const { stateOf, startServer, stopServer, reconnectServer, reconcile, updateTools, applyDesired: applyRuntimeDesired, definitionsOf, generationOf, revisionOf, subscribe, stopAll, forget, hasTool } = createRuntime({ ctx, store, logger, track, warn, fail, isDisposed: () => disposed });
  const sessionState = createSessionState({ logger });
  const externalDefaults = createExternalDefaults({ logger });
  const agents = createAgentRegistry({ runtime: { definitionsOf, revisionOf, subscribe }, sessionState, listServers: () => store.list(), listExternal: () => external(), listToolSchemas: () => ctx.tools.schemas(), autoInjectOf: (entryId) => externalDefaults.autoInjectOf(entryId), warn });

  /**
   * Recompute which servers need a connection: every globally enabled server,
   * plus any server some live Session explicitly turned on for itself.
   * @returns {Set<string>} desired server ids.
   */
  function desiredServerIds() {
    const ids = new Set(store.list().filter((server) => server.enabled && server.autoInject !== false).map((server) => server.id));
    for (const id of agents.sessionEnabledServerIds()) ids.add(id);
    return ids;
  }

  /** Apply the desired connection set to every record and re-sync agent tools. */
  function applyDesired() {
    applyRuntimeDesired(desiredServerIds());
    agents.syncAll();
  }

  /** @returns {object[]} external rows carrying their default-injection flag. */
  function externalView() {
    return external().map((item) => ({ ...item, autoInject: externalDefaults.autoInjectOf(item.entryId) }));
  }

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
      await sessionState.load();
      await externalDefaults.load();
      pruneSessions();
      applyDesired();
    })();
    return booted;
  }

  /**
   * Create or replace one server record, then reconcile its connection.
   * @param {{ id?: string, server: unknown }} payload - route payload.
   * @returns {Promise<{ id: string, servers: object[] }>} new id plus fresh views.
   */
  /** Drop session overrides whose Session no longer exists. */
  function pruneSessions() {
    try {
      const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined;
      const list = sessions !== undefined && typeof sessions.list === 'function' ? sessions.list() : undefined;
      if (!Array.isArray(list)) return;
      const known = list.map((entry) => entry?.id).filter((id) => typeof id === 'string');
      if (known.length === 0) return;
      void sessionState.prune(known).catch((error) => warn(`could not prune session overrides: ${formatError(error)}`));
    } catch {
      /* the Session registry is optional in some deployments */
    }
  }

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
      applyDesired();
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
      applyDesired();
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
      applyDesired();
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
      if (desiredServerIds().has(server.id)) reconnectServer(server);
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
      applyDesired();
      return { servers: list(), archive: result.archive };
    });
  }

  /**
   * Resolve one Session's MCP visibility.
   * @param {string} sessionId - Session identity.
   * @returns {{ sessionId: string, overrides: Record<string, boolean>, servers: object[] }} panel state.
   */
  function sessionView(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') {
      throw new ManagerError('invalid', 'request body must include a non-empty "sessionId"', 'sessionId');
    }
    const overrides = sessionState.overridesOf(sessionId);
    const externalOverrides = sessionState.externalOverridesOf(sessionId);
    return {
      sessionId,
      overrides,
      external: external().map((item) => ({
        entryId: item.entryId,
        serverName: item.serverName,
        enabled: item.enabled,
        toolCount: item.toolCount,
        autoInject: externalDefaults.autoInjectOf(item.entryId),
        visible: externalOverrides[item.entryId] === undefined
          ? item.enabled === true && externalDefaults.autoInjectOf(item.entryId)
          : externalOverrides[item.entryId],
      })),
      servers: list().map((view) => ({
        id: view.id,
        name: view.name,
        enabled: view.enabled,
        status: view.status,
        toolCount: view.toolCount,
        autoInject: view.autoInject !== false,
        visible: overrides[view.id] === undefined ? view.enabled && view.autoInject !== false : overrides[view.id],
      })),
    };
  }

  /**
   * Override one server's visibility for one Session.
   * @param {{ sessionId: string, serverId: string, enabled: boolean|null }} payload - override request.
   * @returns {Promise<object>} fresh panel state.
   */
  function setSessionEnabled(payload) {
    return enqueue(async () => {
      await store.load();
      const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : '';
      if (sessionId === '') throw new ManagerError('invalid', 'request body must include a non-empty "sessionId"', 'sessionId');
      const server = requireServer(payload.serverId);
      const enabled = payload.enabled;
      if (enabled !== null && typeof enabled !== 'boolean') {
        throw new ManagerError('invalid', 'enabled must be a boolean or null', 'enabled');
      }
      await sessionState.set(sessionId, server.id, enabled);
      agents.syncSession(sessionId);
      applyDesired();
      return sessionView(sessionId);
    });
  }

  /** Clear managed and external overrides together, then apply the defaults. */
  function resetSession({ sessionId }) {
    return enqueue(async () => {
      await store.load();
      if (typeof sessionId !== 'string' || sessionId === '') {
        throw new ManagerError('invalid', 'request body must include a non-empty "sessionId"', 'sessionId');
      }
      await sessionState.clearSession(sessionId);
      applyDesired();
      return sessionView(sessionId);
    });
  }

  /**
   * Render one Session's visibility as plain text for the `/mcp` command.
   * @param {object} view - `sessionView` result.
   * @returns {string} multi-line summary.
   */
  function describeSession(view) {
    const managed = view.servers
      .map((server) => `${server.visible ? '●' : '○'} ${server.name} — ${server.visible ? server.status : 'hidden for this session'}`);
    const externalRows = view.external
      .map((item) => `${item.visible ? '●' : '○'} ${item.serverName || item.entryId} — ${item.visible ? 'global entry' : 'hidden for this session'}`);
    const lines = [...managed, ...externalRows];
    return lines.length === 0 ? 'No MCP servers are configured.' : lines.join('\n');
  }

  /**
   * `/mcp` argument form: `list`, `on <server>`, `off <server>`, `reset`.
   * @param {object} agent - receiving Agent (its Session owns the overrides).
   * @param {string} rawInput - text after the command name.
   * @returns {Promise<{ kind: 'success'|'error', text: string }>} command result.
   */
  async function runCommand(agent, rawInput) {
    const sessionId = agent?.session?.id;
    if (typeof sessionId !== 'string' || sessionId === '') {
      return { kind: 'error', text: 'This command needs an active Session.' };
    }
    await store.load();
    const tokens = String(rawInput ?? '').trim().split(/\s+/).filter(Boolean);
    const verb = tokens[0];
    const target = tokens.slice(1).join(' ');
    if (verb === undefined || verb === 'list') {
      return { kind: 'success', text: describeSession(sessionView(sessionId)) };
    }
    if (verb === 'reset') {
      await resetSession({ sessionId });
      return { kind: 'success', text: `Reset to the global configuration.\n${describeSession(sessionView(sessionId))}` };
    }
    if (verb === 'on' || verb === 'off') {
      if (target === '') return { kind: 'error', text: `Usage: /mcp ${verb} <server>` };
      const server = store.list().find((item) => item.name === target || item.id === target);
      if (server !== undefined) {
        await sessionState.set(sessionId, server.id, verb === 'on');
        agents.syncSession(sessionId);
        applyDesired();
        return { kind: 'success', text: `"${server.name}" is now ${verb} for this session.\n${describeSession(sessionView(sessionId))}` };
      }
      const externalRow = external().find((item) => item.serverName === target || item.entryId === target);
      if (externalRow !== undefined) {
        if (verb === 'on' && externalRow.enabled !== true) {
          return { kind: 'error', text: `"${target}" is disabled in the profile; enable it on the settings page first.` };
        }
        await sessionState.setExternal(sessionId, externalRow.entryId, verb === 'on');
        agents.syncSession(sessionId);
        return { kind: 'success', text: `"${target}" is now ${verb} for this session.\n${describeSession(sessionView(sessionId))}` };
      }
      return { kind: 'error', text: `No MCP server named "${target}".` };
    }
    return { kind: 'error', text: `Unknown argument "${verb}". Use list, on <server>, off <server> or reset.` };
  }

  /**
   * Override one external entry's visibility for one Session.
   *
   * External servers register their tools globally, so this is a deny mask on
   * the agent scope (`agent.ctx.tools.restrict`) rather than a registration.
   *
   * @param {{ sessionId: string, entryId: string, enabled: boolean|null }} payload - override request.
   * @returns {Promise<object>} fresh panel state.
   */
  function setSessionExternalEnabled(payload) {
    return enqueue(async () => {
      await store.load();
      const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : '';
      if (sessionId === '') throw new ManagerError('invalid', 'request body must include a non-empty "sessionId"', 'sessionId');
      const entryId = typeof payload.entryId === 'string' ? payload.entryId : '';
      if (entryId === '') throw new ManagerError('invalid', 'request body must include a non-empty "entryId"', 'entryId');
      const row = external().find((item) => item.entryId === entryId);
      if (row === undefined) throw new ManagerError('not-found', `no dsh-mcp-client entry "${entryId}"`);
      const enabled = payload.enabled;
      if (enabled !== null && typeof enabled !== 'boolean') {
        throw new ManagerError('invalid', 'enabled must be a boolean or null', 'enabled');
      }
      if (enabled === true && row.enabled !== true) {
        throw new ManagerError('invalid', `entry "${entryId}" is disabled in the profile; enable it on the settings page first`, 'enabled');
      }
      await sessionState.setExternal(sessionId, entryId, enabled);
      agents.syncSession(sessionId);
      return sessionView(sessionId);
    });
  }

  /**
   * Set one external entry's deployment-wide default injection.
   * @param {{ entryId: string, autoInject: boolean }} payload - request.
   * @returns {Promise<{ entryId: string, autoInject: boolean }>} stored value.
   */
  function setExternalDefault(payload) {
    return enqueue(async () => {
      const entryId = typeof payload.entryId === 'string' ? payload.entryId : '';
      if (entryId === '') throw new ManagerError('invalid', 'request body must include a non-empty "entryId"', 'entryId');
      if (typeof payload.autoInject !== 'boolean') throw new ManagerError('invalid', 'autoInject must be a boolean', 'autoInject');
      await externalDefaults.load();
      await externalDefaults.set(entryId, payload.autoInject);
      agents.syncAll();
      return { entryId, autoInject: payload.autoInject };
    });
  }

  /**
   * Re-sync every attached agent after the global tool set changed.
   * @returns {void}
   */
  function refreshAgents() {
    if (!disposed) agents.refreshExternal();
  }

  /**
   * Attach one Agent so its Session's MCP tools become visible to it.
   * @param {object} agent - Agent handle.
   * @returns {void}
   */
  function attachAgent(agent) {
    agents.attach(agent);
    applyDesired();
  }

  /**
   * Detach one Agent and release its tools.
   * @param {object} agent - Agent handle.
   * @returns {void}
   */
  function detachAgent(agent) {
    agents.detach(agent);
    applyDesired();
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
      agents.dispose();
      await Promise.allSettled([...inflight]);
      await store.flush();
      await sessionState.flush();
      await externalDefaults.flush();
    })();
    return disposal;
  }

  const { external, setExternalEnabled, takeover } = createExternalOperations({
    ctx, store, warn, enqueue, list, reconcile: applyDesired,
    autoInjectOf: (entryId) => externalDefaults.autoInjectOf(entryId),
    adoptDefault: (entryId) => externalDefaults.set(entryId, true),
  });

  return {
    list,
    storage: store.status,
    recoverStorage,
    importServers,
    exportServers,
    setToolEnabled,
    external: externalView,
    setExternalEnabled,
    takeover,
    sessionView,
    setSessionEnabled,
    resetSession,
    setSessionExternalEnabled,
    setExternalDefault,
    refreshAgents,
    runCommand,
    attachAgent,
    detachAgent,
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

