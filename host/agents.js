/**
 * Per-agent MCP tool registration.
 *
 * The deployment owns one connection per server, but tool visibility belongs to
 * the Agent: `agent.ctx` is the documented per-agent composition scope, so a
 * registration made there applies to that Agent alone and unwinds with it. That
 * is what lets `/mcp` hide a server from one Session without touching the
 * persisted configuration or any other Session.
 *
 * Lifecycle: `agent/created` attaches, `agent/disposed` (or the agent's own
 * effect) detaches. Registrations are kept per server id so a reconnect, a tool
 * list change, or an override only swaps the affected set.
 *
 * @module @kuhufu/dsh-mcp-manager/host/agents
 */

import { formatError } from './errors.js';

/**
 * Create the per-agent tool registry.
 *
 * @param {object} dependencies - Registry dependencies.
 * @param {object} dependencies.runtime - Connection runtime exposing `definitionsOf` and `subscribe`.
 * @param {object} dependencies.sessionState - Per-session override store.
 * @param {() => object[]} dependencies.listServers - Current persisted records.
 * @param {() => object[]} dependencies.listExternal - Current foreign entries, including namespace ownership.
 * @param {() => object[]} dependencies.listToolSchemas - Unfiltered Host tool catalog.
 * @param {(entryId: string) => boolean} dependencies.autoInjectOf - Foreign default visibility.
 * @param {(message: string) => void} dependencies.warn - Warning sink.
 * @returns {object} registry operations consumed by the manager and the plugin entry.
 */
export function createAgentRegistry({ runtime, sessionState, listServers, listExternal, listToolSchemas, autoInjectOf, warn }) {
  /** Per-agent registrations retain their definitions for failed-swap rollback. */
  const entries = new Map();

  /** Public-name prefix one external entry's tools use. */
  function prefixOf(serverName) {
    return `mcp__${String(serverName).replace(/[^A-Za-z0-9_-]/g, '_')}__`;
  }

  /** Release one external-entry restriction on one agent. */
  function releaseRestriction(entry, entryId) {
    const current = entry.restrictions.get(entryId);
    if (current === undefined) return;
    entry.restrictions.delete(entryId);
    try {
      current.dispose();
    } catch (error) {
      warn(`could not lift a tool restriction: ${formatError(error)}`);
    }
  }

  /**
   * Apply `agent.ctx.tools.restrict()` for external entries this Session hid.
   *
   * External MCP servers register their tools globally, so the only per-Session
   * lever is the documented agent-scoped deny mask. Names must exist when the
   * restriction is registered, so this runs again whenever the tool set changes.
   */
  function syncExternal(entry) {
    // Restrict/dispose may themselves emit tools/change synchronously.
    if (entry.syncingExternal) return;
    entry.syncingExternal = true;
    try {
      applyExternal(entry);
    } finally {
      entry.syncingExternal = false;
    }
  }

  function applyExternal(entry) {
    const overrides = sessionState.externalOverridesOf(entry.sessionId);
    const wanted = new Map();
    for (const item of listExternal()) {
      if (item.shadowed) continue;
      const visible = overrides[item.entryId] === undefined
        ? item.enabled === true && autoInjectOf(item.entryId)
        : overrides[item.entryId];
      if (visible) continue;
      const serverName = typeof item.serverName === 'string' && item.serverName !== '' ? item.serverName : undefined;
      if (serverName === undefined) continue;
      wanted.set(item.entryId, prefixOf(serverName));
    }
    for (const entryId of [...entry.restrictions.keys()]) {
      if (!wanted.has(entryId)) releaseRestriction(entry, entryId);
    }
    if (wanted.size === 0) return;
    const tools = entry.agent?.ctx?.tools;
    if (tools === undefined || typeof tools.restrict !== 'function') return;
    let schemas;
    try {
      // Query the Host catalog without an Agent scope. Agent-visible schemas
      // omit names already hidden by our own mask (or another restriction).
      schemas = listToolSchemas();
    } catch (error) {
      warn(`could not read tool catalog for session "${entry.sessionId}": ${formatError(error)}`);
      return;
    }
    // One O(T) pass groups visible names by `mcp__<server>__` prefix; per-entry
    // lookups then cost O(1) instead of O(T) each.
    const buckets = new Map();
    for (const schema of Array.isArray(schemas) ? schemas : []) {
      const name = schema !== null && typeof schema === 'object' ? schema.name : undefined;
      if (typeof name !== 'string' || !name.startsWith('mcp__')) continue;
      const end = name.indexOf('__', 5);
      if (end < 0) continue;
      const prefix = name.slice(0, end + 2);
      const bucket = buckets.get(prefix);
      if (bucket === undefined) buckets.set(prefix, [name]);
      else bucket.push(name);
    }
    for (const [entryId, prefix] of wanted) {
      const deny = (buckets.get(prefix) ?? []).slice().sort();
      const signature = deny.join('\u0000');
      const current = entry.restrictions.get(entryId);
      if (current !== undefined && current.names === signature) continue;
      if (deny.length === 0) {
        // The external connection has not registered its tools yet; retry on tools/change.
        if (current !== undefined) releaseRestriction(entry, entryId);
        continue;
      }
      try {
        // Install first so a failed replacement keeps the previous mask.
        const dispose = tools.restrict({ deny });
        if (current !== undefined) releaseRestriction(entry, entryId);
        entry.restrictions.set(entryId, { names: signature, dispose });
      } catch (error) {
        warn(`could not restrict "${entryId}" for session "${entry.sessionId}": ${formatError(error)}`);
      }
    }
  }

  const agentKey = (agent) => {
    const id = agent?.id;
    if (typeof id === 'string' && id !== '') return id;
    const sessionId = agent?.session?.id;
    return typeof sessionId === 'string' ? `session:${sessionId}` : '';
  };

  const sessionIdOf = (agent) => {
    const id = agent?.session?.id;
    return typeof id === 'string' && id !== '' ? id : undefined;
  };

  /** Whether one server is visible to a Session with these overrides. */
  function visible(server, overrides) {
    const override = overrides[server.id];
    const base = server.enabled === true && server.autoInject !== false;
    return override === undefined ? base : override;
  }

  /** @returns {object[]} servers visible to one Session. */
  function visibleServers(sessionId) {
    const overrides = sessionState.overridesOf(sessionId);
    return listServers().filter((server) => visible(server, overrides));
  }

  /** Release one server's registrations on one agent. */
  function releaseServer(entry, serverId) {
    const current = entry.registered.get(serverId);
    if (current === undefined) return;
    entry.registered.delete(serverId);
    for (const dispose of current.disposers) {
      try {
        dispose();
      } catch (error) {
        warn(`could not release tools: ${formatError(error)}`);
      }
    }
  }

  /** Release every registration on one agent. */
  function releaseAll(entry) {
    for (const serverId of [...entry.registered.keys()]) releaseServer(entry, serverId);
  }

  /** Register one server's current definitions on one agent. */
  function registerServer(entry, server, definitions, signature) {
    if (definitions.length === 0) return true;
    const tools = entry.agent?.ctx?.tools;
    if (tools === undefined || typeof tools.register !== 'function') {
      warn(`agent scope for session "${entry.sessionId}" exposes no tool registry`);
      return false;
    }
    const disposers = [];
    try {
      for (const item of definitions) disposers.push(tools.register(item.definition));
    } catch (error) {
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {
          /* best effort rollback */
        }
      }
      warn(`could not register "${server.name}" tools for session "${entry.sessionId}": ${formatError(error)}`);
      return false;
    }
    entry.registered.set(server.id, { definitions, signature, disposers });
    return true;
  }

  /** Bring one agent's registrations in line with its Session's visibility. */
  function syncEntry(entry) {
    syncExternal(entry);
    const wanted = new Map(visibleServers(entry.sessionId).map((server) => [server.id, server]));
    for (const serverId of [...entry.registered.keys()]) {
      if (!wanted.has(serverId)) releaseServer(entry, serverId);
    }
    for (const [serverId, server] of wanted) {
      const definitions = runtime.definitionsOf(serverId);
      // Include the complete declarative definition, not just its public name.
      // Reconnects release old registrations before installing new call closures.
      const signature = `${server.name}\u0000${definitions.map((item) => item.rawName).join('\u0000')}\u0000${runtime.revisionOf(serverId) ?? 0}\u0000${(server.disabledTools ?? []).join('\u0000')}`;
      const current = entry.registered.get(serverId);
      if (current !== undefined && current.signature === signature) continue;
      if (current !== undefined) releaseServer(entry, serverId);
      if (!registerServer(entry, server, definitions, signature) && current !== undefined) {
        registerServer(entry, server, current.definitions, current.signature);
      }
    }
  }

  /**
   * Attach one Agent: register the tools its Session may see.
   * @param {object} agent - Agent handle from an `agent/created` listener.
   * @returns {void}
   */
  function attach(agent) {
    const key = agentKey(agent);
    const sessionId = sessionIdOf(agent);
    if (key === '' || sessionId === undefined || entries.has(key)) return;
    const entry = { agent, sessionId, registered: new Map(), restrictions: new Map() };
    entries.set(key, entry);
    // The agent's own scope unwinds with it; this is the documented pairing.
    try {
      agent?.ctx?.effect?.(() => () => detach(agent));
    } catch {
      /* the agent may already be disposing */
    }
    syncEntry(entry);
  }

  /**
   * Detach one Agent and release its registrations.
   * @param {object} agent - Agent handle.
   * @returns {void}
   */
  function detach(agent) {
    const key = agentKey(agent);
    const entry = entries.get(key);
    if (entry === undefined) return;
    entries.delete(key);
    releaseAll(entry);
    for (const entryId of [...entry.restrictions.keys()]) releaseRestriction(entry, entryId);
  }

  /** Re-sync every attached agent (connection or definition changes). */
  function syncAll() {
    scheduled = false;
    for (const entry of entries.values()) syncEntry(entry);
  }

  /** Catalog events only affect foreign masks, not managed definition swaps. */
  function refreshExternal() {
    for (const entry of entries.values()) syncExternal(entry);
  }

  /** Re-sync every agent of one Session (override changes). */
  function syncSession(sessionId) {
    for (const entry of entries.values()) {
      if (entry.sessionId === sessionId) syncEntry(entry);
    }
  }

  /**
   * Servers some attached Session explicitly turned on while globally disabled.
   * @returns {Set<string>} server ids that need a connection for a Session.
   */
  function sessionEnabledServerIds() {
    const ids = new Set();
    for (const entry of entries.values()) {
      for (const [serverId, enabled] of Object.entries(sessionState.overridesOf(entry.sessionId))) {
        if (enabled) ids.add(serverId);
      }
    }
    return ids;
  }

  /** Release every registration and forget every agent. */
  function disposeAll() {
    const previous = [...entries.values()];
    entries.clear();
    for (const entry of previous) {
      releaseAll(entry);
      for (const entryId of [...entry.restrictions.keys()]) releaseRestriction(entry, entryId);
    }
  }

  /** @returns {number} number of attached agents (diagnostics). */
  function size() {
    return entries.size;
  }

  // `register`, `dispose` and `restrict` each notify; one action must not walk
  // every agent once per notification.
  let scheduled = false;
  function scheduleSync() {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      if (!scheduled) return;
      syncAll();
    });
  }

  const unsubscribe = runtime.subscribe(() => scheduleSync());

  return {
    attach,
    detach,
    syncAll,
    scheduleSync,
    refreshExternal,
    syncSession,
    sessionEnabledServerIds,
    visibleServers,
    dispose: () => {
      if (typeof unsubscribe === 'function') unsubscribe();
      disposeAll();
    },
    size,
  };
}
