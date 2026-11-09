/**
 * Per-session MCP visibility overrides.
 *
 * The persisted server list is deployment-wide; this document records only the
 * deviations one Session made for itself through `/mcp`. An absent entry means
 * "follow the server's own `enabled` flag", so disabling a server globally still
 * hides it from every Session that never overrode it.
 *
 * The document lives beside the server store:
 * `<DSH_HOME>/storages/mcp-manager-sessions.json`
 *
 * ```json
 * { "version": 1, "sessions": { "<sessionId>": { "overrides": { "<serverId>": false }, "updatedAt": 0 } } }
 * ```
 *
 * Writes are atomic (temp sibling + `rename`) and serialized; reads are
 * tolerant, so a corrupt or future-version document degrades to "no overrides"
 * instead of breaking the plugin.
 *
 * @module @kuhufu/dsh-mcp-manager/host/session-state
 */

import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';

import { isRecord, resolveDshHome } from './store.js';

/** Persisted document version. */
export const SESSION_STORAGE_VERSION = 1;

/** Relative path of the session-override document below `DSH_HOME`. */
export const SESSION_STORAGE_RELATIVE_PATH = path.join('storages', 'mcp-manager-sessions.json');

/**
 * Coerce one persisted Session entry into the pinned shape.
 * @param {unknown} value - untrusted persisted entry.
 * @returns {{ overrides: Record<string, boolean>, updatedAt: number }|undefined} normalized entry.
 */
function coerceEntry(value) {
  if (!isRecord(value)) return undefined;
  /** @type {Record<string, boolean>} */
  const overrides = {};
  if (isRecord(value.overrides)) {
    for (const [serverId, enabled] of Object.entries(value.overrides)) {
      if (serverId !== '' && typeof enabled === 'boolean') overrides[serverId] = enabled;
    }
  }
  /** @type {Record<string, boolean>} */
  const external = {};
  if (isRecord(value.external)) {
    for (const [entryId, enabled] of Object.entries(value.external)) {
      if (entryId !== '' && typeof enabled === 'boolean') external[entryId] = enabled;
    }
  }
  const updatedAt = typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt) ? value.updatedAt : 0;
  return { overrides, external, updatedAt };
}

/**
 * Create the per-session override store.
 *
 * @param {{
 *   file?: string,
 *   logger?: { warn?: (message: string) => void },
 * }} [options] - `file` overrides the resolved path (tests), `logger` receives tolerant-read warnings.
 * @returns {{
 *   file: string,
 *   load: () => Promise<void>,
 *   overridesOf: (sessionId: string) => Record<string, boolean>,
 *   set: (sessionId: string, serverId: string, enabled: boolean|null) => Promise<void>,
 *   clearSession: (sessionId: string) => Promise<void>,
 *   prune: (knownSessionIds: Iterable<string>) => Promise<boolean>,
 *   flush: () => Promise<void>,
 *   snapshot: () => Record<string, { overrides: Record<string, boolean>, updatedAt: number }>,
 * }} store handle.
 */
export function createSessionState(options = {}) {
  const file = options.file ?? path.join(resolveDshHome(), SESSION_STORAGE_RELATIVE_PATH);
  const logger = options.logger;
  /** @type {Record<string, { overrides: Record<string, boolean>, updatedAt: number }>} */
  let sessions = {};
  let loaded = false;
  /** @type {Promise<void>|undefined} */
  let loading;
  let writeChain = Promise.resolve();
  let tempSequence = 0;

  const warn = (message) => {
    if (typeof logger?.warn === 'function') logger.warn(`mcp-manager: ${message}`);
  };

  async function readDocument() {
    let raw;
    try {
      raw = await readFile(file, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') warn(`could not read ${file}: ${error?.message ?? String(error)}`);
      return {};
    }
    let document;
    try {
      document = JSON.parse(raw);
    } catch {
      warn(`ignoring unreadable JSON at ${file}`);
      return {};
    }
    if (!isRecord(document) || !isRecord(document.sessions)) {
      warn(`ignoring ${file}: expected an object with a sessions map`);
      return {};
    }
    if (document.version !== undefined && document.version !== SESSION_STORAGE_VERSION) {
      warn(`ignoring ${file}: unsupported document version ${String(document.version)}`);
      return {};
    }
    /** @type {Record<string, { overrides: Record<string, boolean>, updatedAt: number }>} */
    const accepted = {};
    for (const [sessionId, value] of Object.entries(document.sessions)) {
      const entry = coerceEntry(value);
      if (entry !== undefined) accepted[sessionId] = entry;
    }
    return accepted;
  }

  function load() {
    if (loaded) return Promise.resolve();
    loading ??= readDocument().then((document) => {
      sessions = document;
      loaded = true;
      loading = undefined;
    }, (error) => {
      loading = undefined;
      warn(`could not load ${file}: ${error?.message ?? String(error)}`);
      sessions = {};
      loaded = true;
    });
    return loading;
  }

  async function writeSnapshot(candidate) {
    const payload = `${JSON.stringify({ version: SESSION_STORAGE_VERSION, sessions: candidate }, null, 2)}\n`;
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.tmp-${process.pid}-${tempSequence += 1}`;
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(payload, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, file);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw new Error(`could not persist session overrides to ${file}: ${error?.message ?? String(error)}`);
    }
  }

  function enqueue(task) {
    const run = writeChain.then(task);
    writeChain = run.then(() => undefined, () => undefined);
    return run;
  }

  /** @param {string} sessionId - Session identity. @returns {Record<string, boolean>} detached overrides. */
  function overridesOf(sessionId) {
    const entry = sessions[sessionId];
    return entry === undefined ? {} : { ...entry.overrides };
  }

  /** @param {string} sessionId - Session identity. @returns {Record<string, boolean>} detached external-entry overrides. */
  function externalOverridesOf(sessionId) {
    const entry = sessions[sessionId];
    return entry === undefined ? {} : { ...entry.external };
  }

  /**
   * Set, change or remove one external-entry override.
   * @param {string} sessionId - Session identity.
   * @param {string} entryId - Loader entry id.
   * @param {boolean|null} enabled - `true`/`false` to override, `null` to follow the entry.
   * @returns {Promise<void>} settles after the document is written.
   */
  function setExternal(sessionId, entryId, enabled) {
    return enqueue(async () => {
      await load();
      const candidate = { ...sessions };
      const entry = sessions[sessionId] ?? { overrides: {}, external: {}, updatedAt: 0 };
      /** @type {Record<string, boolean>} */
      const external = { ...entry.external };
      if (enabled === null) delete external[entryId];
      else external[entryId] = enabled;
      const overrides = { ...entry.overrides };
      if (Object.keys(overrides).length === 0 && Object.keys(external).length === 0) delete candidate[sessionId];
      else candidate[sessionId] = { overrides, external, updatedAt: Date.now() };
      await writeSnapshot(candidate);
      sessions = candidate;
    });
  }

  /**
   * Set, change or remove one override.
   * @param {string} sessionId - Session identity.
   * @param {string} serverId - managed server id.
   * @param {boolean|null} enabled - `true`/`false` to override, `null` to follow the global flag.
   * @returns {Promise<void>} settles after the document is written.
   */
  function set(sessionId, serverId, enabled) {
    return enqueue(async () => {
      await load();
      const candidate = { ...sessions };
      const entry = sessions[sessionId] ?? { overrides: {}, external: {}, updatedAt: 0 };
      /** @type {Record<string, boolean>} */
      const overrides = { ...entry.overrides };
      if (enabled === null) delete overrides[serverId];
      else overrides[serverId] = enabled;
      const external = { ...entry.external };
      if (Object.keys(overrides).length === 0 && Object.keys(external).length === 0) delete candidate[sessionId];
      else candidate[sessionId] = { overrides, external, updatedAt: Date.now() };
      await writeSnapshot(candidate);
      sessions = candidate;
    });
  }

  /** @param {string} sessionId - Session identity. @returns {Promise<void>} settles after the write. */
  function clearSession(sessionId) {
    return enqueue(async () => {
      await load();
      if (sessions[sessionId] === undefined) return;
      const candidate = { ...sessions };
      delete candidate[sessionId];
      await writeSnapshot(candidate);
      sessions = candidate;
    });
  }

  /**
   * Drop entries for Sessions that no longer exist.
   * @param {Iterable<string>} knownSessionIds - live Session identities.
   * @returns {Promise<boolean>} whether anything was dropped (and written).
   */
  function prune(knownSessionIds) {
    const known = new Set(knownSessionIds);
    return enqueue(async () => {
      await load();
      const stale = Object.keys(sessions).filter((sessionId) => !known.has(sessionId));
      if (stale.length === 0) return false;
      const candidate = { ...sessions };
      for (const sessionId of stale) delete candidate[sessionId];
      await writeSnapshot(candidate);
      sessions = candidate;
      return true;
    });
  }

  return {
    file,
    load,
    overridesOf,
    externalOverridesOf,
    set,
    setExternal,
    clearSession,
    prune,
    flush: () => writeChain,
    snapshot: () => JSON.parse(JSON.stringify(sessions)),
  };
}
