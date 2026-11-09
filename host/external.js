/**
 * Loader entry enablement, migration and profile-patch repair coordination.
 *
 * @module @kuhufu/dsh-mcp-manager/host/external
 */

import { patchIdOf, repairDuplicateRow } from './profile-patch.js';
import { ManagerError, buildServerRecord, validateServerInput } from './store.js';

/**
 * Loader entry enablement, migration and profile-patch repair coordination.
 *
 * @param {object} dependencies - Migration dependencies.
 * @param {object} dependencies.ctx - Cordis service lookup and tool registry context.
 * @param {object} dependencies.store - Owned server configuration store.
 * @param {(message: string) => void} dependencies.warn - Warning sink.
 * @param {(task: Function) => Promise<unknown>} dependencies.enqueue - Serialized mutation runner.
 * @param {() => object[]} dependencies.list - Current managed server views.
 * @param {(server: object) => void} dependencies.reconcile - Applies a migrated record to its connection.
 * @param {() => number} [dependencies.toolsGeneration] - Counter bumped whenever the Host
 *   tool catalog may have changed; lets the catalog scan be cached.
 * @returns {{external: Function, setExternalEnabled: Function, takeover: Function}} external-entry operations.
 */
export function createExternalOperations({ ctx, store, warn, enqueue, list, reconcile, autoInjectOf, adoptDefault, toolsGeneration }) {
  /** Catalog index cache: the full `ctx.tools.schemas()` scan is the expensive half of `external()`. */
  let catalogCache;
  /** Managed-name cache, keyed by the identity of the shared store snapshot. */
  let namesCache;

  /** Read the Host tool catalog, tolerating a missing or throwing registry. */
  function toolCatalog() {
    try {
      const current = ctx.tools !== undefined && typeof ctx.tools.schemas === 'function' ? ctx.tools.schemas() : [];
      return Array.isArray(current) ? current : [];
    } catch {
      return [];
    }
  }

  /**
   * Count catalog tool names per `mcp__<serverName>__` prefix.
   *
   * Every prefix the catalog actually contains is counted, so a `serverName`
   * that itself contains `__` still resolves to an exact count instead of
   * falling into a first-segment bucket.
   *
   * @param {object[]} schemas - unfiltered Host tool catalog.
   * @returns {Map<string, number>} tool count per namespace prefix.
   */
  function prefixCounts(schemas) {
    const counts = new Map();
    for (const schema of schemas) {
      if (schema === null || typeof schema !== 'object') continue;
      const name = schema.name;
      if (typeof name !== 'string' || !name.startsWith('mcp__')) continue;
      for (let at = name.indexOf('__', 5); at >= 0; at = name.indexOf('__', at + 2)) {
        const prefix = name.slice(0, at + 2);
        counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
      }
    }
    return counts;
  }

  /**
   * Namespace counts, rescanned only when the caller's catalog generation moved.
   * @returns {Map<string, number>} cached prefix counts.
   */
  function catalogCounts() {
    const generation = typeof toolsGeneration === 'function' ? toolsGeneration() : undefined;
    // Without a generation source, stay correct and uncached.
    if (generation === undefined) return prefixCounts(toolCatalog());
    if (catalogCache === undefined || catalogCache.generation !== generation) {
      catalogCache = { generation, counts: prefixCounts(toolCatalog()) };
    }
    return catalogCache.counts;
  }

  /**
   * Managed server names. `store.list()` hands back one shared frozen snapshot,
   * so the set is rebuilt only when a write publishes a new one.
   * @returns {Set<string>} tool namespaces this page owns.
   */
  function managedNames() {
    const current = store.list();
    if (namesCache === undefined || namesCache.snapshot !== current) {
      namesCache = { snapshot: current, names: new Set(current.map((server) => server.name)) };
    }
    return namesCache.names;
  }

  /** Resolve optional Cordis services without requiring a particular deployment. */
  function service(name) {
    try { return typeof ctx.get === 'function' ? ctx.get(name) : undefined; }
    catch { return undefined; }
  }

  /** Resolve Loader access, raising a user-visible error only for mutations. */
  function resolveLoader(required = false) {
    const loader = service('loader');
    if (typeof loader?.entries === 'function') return loader;
    if (required) throw new ManagerError('unsupported', 'the Loader is not available in this deployment');
  }

  /** Find one Loader row, tolerating missing optional services during polling. */
  function findEntry(entryId, required = false) {
    const loader = resolveLoader(required);
    return loader && [...loader.entries()].find((entry) => entry?.id === entryId);
  }

  /** Require the selected row to be an MCP client before changing it. */
  function requireMcpEntry(entryId) {
    const entry = findEntry(entryId, true);
    if (!entry) throw new ManagerError('not-found', `no Loader entry "${entryId}"`);
    if (entry.options?.name !== '@deepseek-ai/dsh-mcp-client') {
      throw new ManagerError('invalid', `entry "${entryId}" is not a dsh-mcp-client entry`, 'entryId');
    }
    return entry;
  }

  /** Resolve the Host's enablement API for external-entry mutations. */
  function requirePluginManager() {
    const manager = service('pluginManager');
    if (typeof manager?.setPluginEnabled !== 'function') {
      throw new ManagerError('unsupported', 'plugin management is not available in this deployment');
    }
    return manager;
  }

  /** Older plugin managers acknowledge an applied change without a result. */
  function applicationOf(change) { return change == null ? 'applied' : change.application; }

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
    // Poll tightly at first (a released namespace is usually visible within one
    // tick) and back off once it is clear the old connection is still tearing
    // down, so a full 3 s wait costs a handful of catalog reads, not ~75.
    let delay = 40;
    for (;;) {
      let busy = false;
      try {
        busy = toolCatalog().some((schema) => schema !== null && typeof schema === 'object'
          && typeof schema.name === 'string' && schema.name.startsWith(prefix));
      } catch {
        busy = false;
      }
      if (!busy) return;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return;
      await new Promise((resolve) => setTimeout(resolve, Math.min(delay, remaining)));
      delay = Math.min(200, delay * 2);
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
    const loader = resolveLoader();
    if (!loader) return [];
    // Both expensive halves are cached: the catalog scan by tool generation and
    // the managed-name set by store snapshot. Rows themselves are rebuilt from
    // the Loader every call, because a row's own enablement flips without any
    // tool-catalog event (Settings → Plugins, profile reload).
    const counts = catalogCounts();
    const managed = managedNames();
    const rows = [];
    for (const entry of loader.entries()) {
      const options = entry === null || entry === undefined ? undefined : entry.options;
      if (options === undefined || options === null || options.name !== '@deepseek-ai/dsh-mcp-client') continue;
      const config = options.config !== null && typeof options.config === 'object' ? options.config : {};
      const serverName = typeof config.serverName === 'string' && config.serverName !== '' ? config.serverName : undefined;
      const toolCount = serverName === undefined ? 0 : counts.get(`mcp__${serverName}__`) ?? 0;
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
        shadowed: serverName !== undefined && managed.has(serverName),
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
    const profile = service('profileContext');
    const patchPath = profile !== undefined && profile !== null && typeof profile.patchPath === 'string'
      ? profile.patchPath
      : undefined;
    if (patchPath === undefined) return false;
    const result = await repairDuplicateRow(patchPath, patchIdOf(entryId), enabled);
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
        const entry = findEntry(entryId);
        if (entry && (entry.disabled !== true) === enabled) return true;
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
      const source = requireMcpEntry(entryId);
      if (payload.enabled) {
        const config = source.options.config !== null && typeof source.options.config === 'object' ? source.options.config : {};
        const name = typeof config.serverName === 'string' ? config.serverName : undefined;
        if (name !== undefined && managedNames().has(name)) {
          throw new ManagerError('invalid', `"${name}" is managed on this page; enabling its dsh-mcp-client row would collide on tool names`, 'enabled');
        }
      }
      const manager = requirePluginManager();
      const change = await manager.setPluginEnabled(entryId, payload.enabled);
      const application = applicationOf(change);
      if (application === 'overridden') {
        if (!await repairEntry(entryId, payload.enabled)) throw overriddenFailure(entryId, payload.enabled);
        if (!await waitForEntryState(entryId, payload.enabled, 3000)) {
          throw new ManagerError('internal', `repaired the profile patch for "${entryId}", but the Loader did not apply the new state; restart the app to pick it up`);
        }
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
      const source = requireMcpEntry(entryId);
      const wasEnabled = source.disabled !== true;
      const config = source.options.config !== null && typeof source.options.config === 'object' ? source.options.config : {};
      const input = {
        name: typeof config.serverName === 'string' ? config.serverName : `${entryId}`,
        // Migration keeps the source's enablement. A disabled source stays a
        // disabled managed record; enabling it is an explicit second action.
        enabled: wasEnabled,
        transport: config.transport === 'streamable-http' ? 'http' : 'stdio',
        command: config.command,
        args: config.args,
        env: config.env,
        cwd: config.cwd,
        url: config.url,
        headers: config.headers,
        // Migration carries the caller's default-injection preference across.
        autoInject: autoInjectOf(entryId),
      };
      const current = store.list();
      // Migrating onto a name this page already manages replaces that record in
      // place: the user's intent is to fix/repoint the server, not to fail on a
      // duplicate or to leave two records with the same tool namespace.
      const existing = current.find((server) => server.name === input.name);
      const validated = validateServerInput(input, { servers: current, id: existing === undefined ? undefined : existing.id });
      const record = buildServerRecord(validated, existing === undefined ? {} : { existing });
      const manager = requirePluginManager();
      if (wasEnabled) {
        const change = await manager.setPluginEnabled(entryId, false);
        const application = applicationOf(change);
        if (change !== null && change !== undefined && change.changed === false) {
          // Already off; nothing to undo.
        } else if (application === 'overridden') {
          if (!await repairEntry(entryId, false)) throw overriddenFailure(entryId, false);
          if (!await waitForEntryState(entryId, false, 3000)) {
            try { await manager.setPluginEnabled(entryId, true); } catch { /* best effort */ }
            throw new ManagerError('internal', `repaired the profile patch for "${entryId}", but the Loader did not disable it; restart the app and retry`);
          }
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
        try {
        await adoptDefault(entryId);
      } catch (error) {
        warn(`could not clear the external default for "${entryId}": ${error?.message ?? String(error)}`);
      }
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

  return { external, setExternalEnabled, takeover };
}
