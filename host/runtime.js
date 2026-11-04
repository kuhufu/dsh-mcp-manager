/**
 * MCP connection lifetimes, retry scheduling, tool registrations and activity.
 *
 * @module @kuhufu/dsh-mcp-manager/host/runtime
 */

import { formatError } from './errors.js';
import { connect, buildToolDefinitions } from './mcp.js';

/**
 * MCP connection lifetimes, retry scheduling, tool registrations and activity.
 *
 * @param {object} dependencies - Runtime dependencies.
 * @param {object} dependencies.ctx - Host tool registry context.
 * @param {object} dependencies.store - Read-only access to current server records.
 * @param {object} [dependencies.logger] - Host information logger.
 * @param {(promise: Promise<unknown>) => Promise<void>} dependencies.track - Tracks and logs background failures.
 * @param {(message: string) => void} dependencies.warn - Warning sink.
 * @param {(message: string) => void} dependencies.fail - Error sink.
 * @param {() => boolean} dependencies.isDisposed - Whether plugin shutdown has started.
 * @returns {object} connection operations and access to runtime state.
 */
export function createRuntime({ ctx, store, logger, track, warn, fail, isDisposed }) {
  const runtime = new Map();
  /** @type {Set<(serverId: string) => void>} */
  const definitionListeners = new Set();
  /** @type {Set<string>|null} desired connection set; `null` follows each record's own flag. */
  let desired = null;

  /**
   * Notify observers that one server's tool definitions changed.
   * @param {string} serverId - server id.
   * @returns {void}
   */
  function notify(serverId) {
    for (const listener of [...definitionListeners]) {
      try {
        listener(serverId);
      } catch (error) {
        warn(`definition listener failed: ${formatError(error)}`);
      }
    }
  }

  /**
   * Observe definition changes (per-agent registrations re-sync on them).
   * @param {(serverId: string) => void} listener - change sink.
   * @returns {() => void} unsubscribe.
   */
  function subscribe(listener) {
    definitionListeners.add(listener);
    return () => definitionListeners.delete(listener);
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
        fingerprint: undefined,
        attempt: 0,
        retryAttempt: 0,
        logs: [],
        definitions: [],
      };
      runtime.set(id, state);
    }
    return state;
  }

  /** Reset one runtime entry to a non-connected status. */
  function resetState(state, status) {
    state.status = status;
    state.error = undefined;
    state.tools = [];
    state.definitions = [];
    state.toolCount = 0;
    state.serverInfo = undefined;
    state.instructions = undefined;
    state.connectedAt = undefined;
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
      server.requestTimeoutMs,
      server.initializeTimeoutMs,
    ]);
  }

  function log(state, level, message) {
    state.logs.push({ time: Date.now(), level, message: String(message).slice(0, 1000) });
    if (state.logs.length > 50) state.logs.shift();
  }

  function cancelRetry(state) {
    clearTimeout(state.retryTimer);
    state.retryTimer = undefined;
    state.nextRetryAt = undefined;
  }

  /** Use the same connection demand for initial attempts, retries and refreshes. */
  function wantsConnection(server) {
    return server !== undefined && (desired === null ? server.enabled : desired.has(server.id));
  }

  function retry(server, state) {
    if (isDisposed() || !wantsConnection(server) || state.retryAttempt >= (server.retryCount ?? 0)) return;
    cancelRetry(state);
    const delay = Math.min(30000, 1000 * 2 ** state.retryAttempt);
    state.retryAttempt += 1;
    state.nextRetryAt = Date.now() + delay;
    log(state, 'info', `Retry ${state.retryAttempt}/${server.retryCount} in ${delay} ms`);
    state.retryTimer = setTimeout(() => {
      state.retryTimer = undefined;
      state.nextRetryAt = undefined;
      const current = store.list().find((item) => item.id === server.id);
      if (!isDisposed() && wantsConnection(current)) track(startServer(current));
    }, delay);
  }

  function installTools(server, state, connection, tools) {
    const all = buildToolDefinitions({
      serverName: server.name,
      tools,
      callTool: async (rawName, args, signal) => {
        const started = Date.now();
        try {
          const result = await connection.callTool(rawName, args, signal);
          log(state, result?.isError ? 'error' : 'info', `${rawName}: ${result?.isError ? 'failed' : 'completed'} (${Date.now() - started} ms)`);
          return result;
        } catch (error) {
          log(state, 'error', `${rawName}: request failed (${Date.now() - started} ms)`);
          throw error;
        }
      },
    });
    const disabled = new Set(server.disabledTools ?? []);
    // Re-installing an identical generation only re-notifies every agent.
    const signature = `${server.name}\u0000${all.map((item) => item.rawName).join('\u0000')}\u0000${[...disabled].sort().join('\u0000')}`;
    // A restarted connection needs its tools registered again even when the
    // definition list is identical, so the connection identity is part of the key.
    if (
      state.toolsConnection === connection
      && state.toolsSource === tools
      && state.toolsSignature === signature
      && Array.isArray(state.tools)
    ) return;
    state.toolsConnection = connection;
    state.toolsSource = tools;
    state.toolsSignature = signature;
    // Same names can still carry new descriptions/schemas: agents key their
    // registrations off this revision, not off the definition bodies.
    state.toolsRevision = (state.toolsRevision ?? 0) + 1;
    const next = all.filter((item) => !disabled.has(item.rawName));
    state.definitions = next;
    state.tools = all.map((item) => ({ name: item.rawName, publicName: item.name, description: item.description, enabled: !disabled.has(item.rawName) }));
    state.toolCount = next.length;
    connection.tools = tools;
    notify(server.id);
  }

  /**
   * Connect one server and swap its tool generation in.
   * @param {object} server - persisted record to connect.
   * @param {number} [generation] - pre-allocated connection generation from {@link reconnectServer}.
   * @returns {Promise<void>} settles when the attempt finishes, success or not.
   */
  async function startServer(server, generation) {
    const state = ensureState(server.id);
    const attempt = generation ?? (state.attempt += 1);
    if (attempt !== state.attempt || isDisposed()) return;

    const previous = state.connection;
    state.connection = undefined;
    resetState(state, 'connecting');
    state.fingerprint = fingerprintOf(server);
    notify(server.id);
    if (previous !== undefined) {
      // Only reachable through an explicit restart; settle the old child first.
      try {
        await previous.close();
      } catch (error) {
        warn(`could not close the previous connection for "${server.name}": ${formatError(error)}`);
      }
      if (attempt !== state.attempt || isDisposed()) return;
    }

    const controller = new AbortController();
    state.controller = controller;
    const finishAttempt = () => {
      if (state.controller === controller) state.controller = undefined;
    };

    let connection;
    try {
      log(state, 'info', 'Connecting');
      connection = await connect(server, { signal: controller.signal, requestTimeoutMs: server.requestTimeoutMs, initializeTimeoutMs: server.initializeTimeoutMs });
    } catch (error) {
      finishAttempt();
      if (attempt !== state.attempt || isDisposed()) return;
      state.status = 'error';
      state.error = formatError(error);
      warn(`"${server.name}" failed to connect: ${state.error}`);
      log(state, 'error', state.error);
      retry(server, state);
      return;
    }
    finishAttempt();

    if (attempt !== state.attempt || isDisposed()) {
      await connection.close().catch(() => {});
      return;
    }

    state.connection = connection;
    connection.onClose((reason) => {
      if (state.connection !== connection || attempt !== state.attempt) return;
      state.connection = undefined;
      resetState(state, 'error');
      notify(server.id);
      state.error = reason;
      warn(`"${server.name}" connection closed: ${reason}`);
      log(state, 'error', reason);
      retry(store.list().find((item) => item.id === server.id) ?? server, state);
    });

    if (connection.closed) return;
    try {
      installTools(store.list().find((item) => item.id === server.id) ?? server, state, connection, connection.tools);
    } catch (error) {
      await connection.close().catch(() => {});
      state.connection = undefined;
      resetState(state, 'error');
      state.error = `tool registration failed: ${formatError(error)}`;
      log(state, 'error', state.error);
      fail(`"${server.name}": ${state.error}`);
      return;
    }

    let refreshing = false;
    let dirty = false;
    connection.onToolsChanged(() => {
      dirty = true;
      if (refreshing) return;
      refreshing = true;
      track((async () => {
        try {
          while (dirty && state.connection === connection && !isDisposed()) {
            dirty = false;
            const tools = await connection.listTools();
            if (state.connection !== connection || isDisposed()) return;
            const current = store.list().find((item) => item.id === server.id);
            if (!wantsConnection(current)) return;
            installTools(current, state, connection, tools);
            log(state, 'info', `Tool list refreshed: ${state.toolCount} enabled`);
          }
        } catch (error) { log(state, 'error', `Tool refresh failed: ${formatError(error)}`); }
        finally { refreshing = false; }
      })());
    });
    state.serverInfo = connection.serverInfo;
    state.instructions = connection.instructions;
    state.connectedAt = Date.now();
    state.fingerprint = fingerprintOf(server);
    state.status = 'ready';
    log(state, 'info', `Connected: ${state.toolCount} tools, protocol ${connection.protocolVersion}`);
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
    cancelRetry(state);
    state.retryAttempt = 0;
    state.controller?.abort();
    state.controller = undefined;
    const connection = state.connection;
    state.connection = undefined;
    resetState(state, 'stopped');
    state.fingerprint = undefined;
    notify(server.id);
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
  function reconnectServer(server) {
    const state = ensureState(server.id);
    cancelRetry(state);
    state.retryAttempt = 0;
    const previous = state.connection;
    state.connection = undefined;
    const attempt = (state.attempt += 1);
    state.controller?.abort();
    state.controller = undefined;
    resetState(state, 'connecting');
    state.fingerprint = fingerprintOf(server);
    notify(server.id);
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
    if (!wantsConnection(server)) {
      if (state.status !== 'stopped') track(stopServer(server));
      return;
    }
    // An errored generation keeps its own retry timer and backoff budget; only a
    // demand or configuration change should restart it.
    if (state.status !== 'stopped' && state.fingerprint === fingerprintOf(server)) {
      if (state.status === 'ready' && state.connection !== undefined) {
        installTools(server, state, state.connection, state.connection.tools);
      }
      // An unchanged connecting/error generation owns its handshake, retry
      // timer and exhausted retry budget until demand or configuration changes.
      return;
    }
    reconnectServer(server);
  }


  /**
   * Replace the desired connection set and reconcile every record.
   * @param {Iterable<string>} desiredIds - server ids that should be connected.
   * @returns {void}
   */
  function applyDesired(desiredIds) {
    desired = new Set(desiredIds);
    for (const server of store.list()) reconcile(server);
  }

  /**
   * Revision of the installed tool generation of one server; bumps on every
   * successful (re)installation.
   * @param {string} id - server id.
   * @returns {number} revision counter.
   */
  function revisionOf(id) {
    return ensureState(id).toolsRevision ?? 0;
  }

  /**
   * Connection generation of one server: changes across reconnects, so callers
   * can detect that the registered closures point at a closed connection.
   * @param {string} id - server id.
   * @returns {number} monotonically increasing attempt counter.
   */
  function generationOf(id) {
    return ensureState(id).attempt;
  }

  /**
   * Current tool definitions for one connected server.
   * @param {string} id - server id.
   * @returns {object[]} definitions registered per agent.
   */
  function definitionsOf(id) {
    return runtime.get(id)?.definitions ?? [];
  }

  async function stopAll() {
    await Promise.all([...runtime.keys()].map((id) => stopServer({ id })));
    runtime.clear();
  }
  function updateTools(server) {
    const state = runtime.get(server.id);
    if (state?.connection && state.status === 'ready') installTools(server, state, state.connection, state.connection.tools);
  }
  return { stateOf: (id) => runtime.get(id), startServer, stopServer, reconnectServer, reconcile, updateTools, applyDesired, definitionsOf, generationOf, revisionOf, subscribe, stopAll,
    hasTool: (id, name) => runtime.get(id)?.tools.some((tool) => tool.name === name) ?? false,
    forget: (id) => runtime.delete(id) };
}

