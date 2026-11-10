/**
 * Persistence and input validation for the `@kuhufu/dsh-mcp-manager` bundle.
 *
 * The Host owns one JSON document at `<DSH_HOME>/storages/mcp-manager.json`
 * (`DSH_HOME` environment variable, else `~/.dsh`). It holds the managed server
 * records plus the page-level UI preference (`ui.railEntry`, default `true`).
 * Writes are atomic (a temp sibling plus `rename`) and serialized so concurrent
 * route handlers can never interleave two documents. Reads are tolerant: a
 * missing file starts empty; unreadable, corrupt or unrecognized files expose
 * a read-only recovery state instead of failing plugin startup; a missing or malformed
 * `ui` block simply falls back to the default preference.
 *
 * Validation functions are the authoritative Host-side rules from
 * `mcp-manager/CONTRACT.md`; the Client mirrors them only for ergonomics.
 *
 * Reads are cheap by construction: `list()` and `ui()` hand back one frozen
 * snapshot that every reader shares until the next write publishes a new one,
 * and `get(id)` resolves through an index, so a hot path never deep-copies the
 * server list (credentials included) just to look at it. Callers that need to
 * edit a record copy it first. Committed records also carry their connection
 * fingerprint as a non-enumerable symbol property, so `JSON.stringify` and
 * `structuredClone` never carry it onto the wire or into the document.
 *
 * @module @kuhufu/dsh-mcp-manager/host/store
 */

import { randomUUID } from 'node:crypto';
import { copyFile, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import { writeFileAtomic } from './atomic-file.js';

/** Persisted document version. */
const STORAGE_VERSION = 1;

/** Relative path of the storage document below `DSH_HOME`. */
const STORAGE_RELATIVE_PATH = path.join('storages', 'mcp-manager.json');

/**
 * Persisted page-level preference: whether this bundle also installs a
 * left-rail entry for the same page. The Settings page always exists; only the
 * rail surface follows this flag.
 */
const DEFAULT_UI = Object.freeze({ railEntry: true });

/** Tool-namespace rule for one MCP server: `^[A-Za-z0-9_-]{1,32}$`. */
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

/** Environment variable name rule for stdio servers. */
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** HTTP header name rule (RFC 9110 token, deliberately permissive). */
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** Authoritative connection option ranges; the browser mirrors these without Host imports. */
export const CONNECTION_OPTIONS = Object.freeze({
  requestTimeoutMs: Object.freeze({ min: 1000, max: 600000, default: 60000 }),
  initializeTimeoutMs: Object.freeze({ min: 1000, max: 300000, default: 30000 }),
  retryCount: Object.freeze({ min: 0, max: 10, default: 0 }),
});

/** Failure carrying a stable wire code, a human message and an optional field. */
export class ManagerError extends Error {
  /**
   * @param {'invalid'|'duplicate-name'|'not-found'|'overridden'|'unsupported'|'conflict'|'storage-readonly'|'internal'} code - stable wire code.
   * @param {string} message - human-readable explanation shown by the Client.
   * @param {string} [field] - offending request field, when there is one.
   */
  constructor(code, message, field) {
    super(message);
    this.name = 'ManagerError';
    this.code = code;
    if (field !== undefined) this.field = field;
  }
}

/** Whether a value is a non-array object with a plain prototype. */
export function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Coerce a persisted `ui` block into the pinned shape.
 *
 * A document written before the preference existed has no `ui` at all; a
 * damaged document may hold a non-boolean. Both resolve to the default so the
 * server list stays loadable, and the next write upgrades the document.
 *
 * @param {unknown} value - persisted `ui` value.
 * @param {(message: string) => void} [warn] - diagnostics sink for malformed values.
 * @returns {{ railEntry: boolean }} resolved preference.
 */
function coerceUi(value, warn) {
  if (isRecord(value) && typeof value.railEntry === 'boolean') return { railEntry: value.railEntry };
  if (value !== undefined) warn?.('ignoring ui: "railEntry" must be a boolean, using the default (true)');
  return { railEntry: DEFAULT_UI.railEntry };
}

/**
 * Validate the writable `ui` preference. Only `railEntry` exists; unknown keys
 * are dropped.
 *
 * @param {unknown} value - untrusted `ui` payload.
 * @returns {{ railEntry: boolean }} normalized preference.
 * @throws {ManagerError} `invalid` with field `railEntry`.
 */
export function validateUi(value) {
  if (!isRecord(value) || typeof value.railEntry !== 'boolean') {
    throw new ManagerError('invalid', 'railEntry must be a boolean', 'railEntry');
  }
  return { railEntry: value.railEntry };
}

/**
 * Resolve `DSH_HOME`, honouring a non-empty environment override.
 * @param {Record<string, string | undefined>} [env] - environment source (defaults to `process.env`).
 * @returns {string} absolute Harness home directory.
 */
export function resolveDshHome(env = process.env) {
  const configured = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : '';
  return configured !== '' ? configured : path.join(homedir(), '.dsh');
}

/**
 * Resolve the absolute storage document path.
 * @param {Record<string, string | undefined>} [env] - environment source (defaults to `process.env`).
 * @returns {string} absolute JSON path.
 */
export function resolveStoragePath(env = process.env) {
  return path.join(resolveDshHome(env), STORAGE_RELATIVE_PATH);
}

/**
 * Whether a value is an absolute http(s) URL — the Host's rule for
 * `transport: "http"`.
 *
 * @param {unknown} value - candidate endpoint.
 * @returns {boolean} true for an absolute `http:`/`https:` URL.
 */
export function isHttpUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') return false;
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Validate one `ServerInput` (a `Server` without `id`/`createdAt`) and return
 * the normalized record the Host persists: unknown fields are dropped, defaults
 * are applied, and fields that do not belong to the chosen transport are
 * removed.
 *
 * @param {unknown} input - untrusted request payload.
 * @param {{ servers?: object[], id?: string }} [context] - existing records and
 *   the id being replaced (excluded from the uniqueness check).
 * @returns {object} normalized `ServerInput`.
 * @throws {ManagerError} `invalid`/`duplicate-name` with the offending field.
 */
export function validateServerInput(input, context = {}) {
  const { servers = [], id } = context;
  if (!isRecord(input)) throw new ManagerError('invalid', 'server must be a JSON object', 'server');

  const name = typeof input.name === 'string' ? input.name.trim() : input.name;
  if (typeof name !== 'string' || !SERVER_NAME_PATTERN.test(name)) {
    throw new ManagerError('invalid', 'name must match ^[A-Za-z0-9_-]{1,32}$', 'name');
  }
  const duplicate = servers.find((server) => server.id !== id && server.name === name);
  if (duplicate !== undefined) {
    throw new ManagerError('duplicate-name', `a server named "${name}" already exists`, 'name');
  }

  const transport = input.transport;
  if (transport !== 'stdio' && transport !== 'http') {
    throw new ManagerError('invalid', 'transport must be "stdio" or "http"', 'transport');
  }

  const enabled = input.enabled === undefined ? true : input.enabled;
  if (typeof enabled !== 'boolean') {
    throw new ManagerError('invalid', 'enabled must be a boolean', 'enabled');
  }

  /** @type {Record<string, unknown>} */
  const normalized = { name, enabled, transport };

  if (transport === 'stdio') {
    const command = typeof input.command === 'string' ? input.command.trim() : '';
    if (command === '') {
      throw new ManagerError('invalid', 'stdio servers require a non-empty command', 'command');
    }
    normalized.command = command;
    normalized.args = normalizeStringList(input.args, 'args');
    normalized.env = normalizeStringMap(input.env, 'env', ENV_NAME_PATTERN);
    const cwd = normalizeOptionalString(input.cwd, 'cwd');
    if (cwd !== undefined) normalized.cwd = cwd;
  } else {
    const rawUrl = typeof input.url === 'string' ? input.url.trim() : '';
    if (!isHttpUrl(rawUrl)) throw new ManagerError('invalid', 'url must be an absolute http(s) URL', 'url');
    normalized.url = rawUrl;
    normalized.headers = normalizeStringMap(input.headers, 'headers', HEADER_NAME_PATTERN);
  }

  for (const [field, { min, max }] of Object.entries(CONNECTION_OPTIONS)) {
    if (input[field] !== undefined) {
      const value = input[field];
      if (!Number.isInteger(value) || value < min || value > max) {
        throw new ManagerError('invalid', `${field} must be an integer from ${min} to ${max}`, field);
      }
      normalized[field] = value;
    }
  }
  if (input.disabledTools !== undefined) {
    normalized.disabledTools = [...new Set(normalizeStringList(input.disabledTools, 'disabledTools'))];
  }
  if (input.autoInject !== undefined) {
    if (typeof input.autoInject !== 'boolean') {
      throw new ManagerError('invalid', 'autoInject must be a boolean', 'autoInject');
    }
    normalized.autoInject = input.autoInject;
  }
  return normalized;
}

/**
 * Validate a list of CLI arguments.
 * @param {unknown} value - untrusted value.
 * @param {string} field - request field name used in failures.
 * @returns {string[]} normalized argument list.
 */
function normalizeStringList(value, field) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ManagerError('invalid', `${field} must be an array of strings`, field);
  const out = [];
  for (const entry of value) {
    if (typeof entry !== 'string') throw new ManagerError('invalid', `${field} must be an array of strings`, field);
    out.push(entry);
  }
  return out;
}

/**
 * Define one own enumerable property, even for keys such as `__proto__` that a
 * plain assignment would route through the prototype setter and silently drop.
 * @param {Record<string, string>} target - destination object.
 * @param {string} key - property name.
 * @param {string} value - property value.
 * @returns {void}
 */
export function setOwn(target, key, value) {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

/**
 * Validate an env/header map: string keys, string values, keys matching the
 * field-specific pattern.
 * @param {unknown} value - untrusted value.
 * @param {string} field - request field name used in failures.
 * @param {RegExp} keyPattern - allowed key shape.
 * @returns {Record<string, string>} normalized map.
 */
function normalizeStringMap(value, field, keyPattern) {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) throw new ManagerError('invalid', `${field} must be an object of string values`, field);
  /** @type {Record<string, string>} */
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!keyPattern.test(key)) {
      throw new ManagerError('invalid', `${field} keys must match ${keyPattern.source}`, field);
    }
    if (typeof entry !== 'string') {
      throw new ManagerError('invalid', `${field}.${key} must be a string`, field);
    }
    setOwn(out, key, entry);
  }
  return out;
}

/**
 * Validate one optional, non-empty string.
 * @param {unknown} value - untrusted value.
 * @param {string} field - request field name used in failures.
 * @returns {string|undefined} trimmed value, or undefined when absent.
 */
function normalizeOptionalString(value, field) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new ManagerError('invalid', `${field} must be a string`, field);
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Coerce one persisted record back into a valid `Server`, dropping anything
 * the current contract no longer accepts.
 *
 * @param {unknown} value - untrusted persisted entry.
 * @param {{ servers?: object[], warn?: (message: string) => void }} [context] -
 *   previously accepted records (for the uniqueness check).
 * @returns {object|undefined} normalized server, or undefined when invalid.
 */
function coerceStoredServer(value, context = {}) {
  if (!isRecord(value)) return undefined;
  const id = typeof value.id === 'string' && value.id.trim() !== '' ? value.id : undefined;
  const createdAt = typeof value.createdAt === 'number' && Number.isFinite(value.createdAt) ? value.createdAt : undefined;
  if (id === undefined || createdAt === undefined) return undefined;
  let input;
  try {
    input = validateServerInput(value, { servers: context.servers ?? [], id });
  } catch (error) {
    context.warn?.(`ignoring invalid persisted MCP server ${id}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
  return { id, ...input, createdAt };
}

/**
 * Deep-copy plain JSON data.
 * @template T
 * @param {T} value - JSON value.
 * @returns {T} detached copy.
 */
function clone(value) {
  return structuredClone(value);
}

/**
 * Fields whose change requires a fresh connection and tool swap.
 *
 * The connection runtime compares this identity to decide whether a record
 * still matches its live connection. It is computed once per committed record
 * here, at the only point where the record becomes authoritative.
 */
const FINGERPRINT_FIELDS = Object.freeze([
  'name',
  'transport',
  'command',
  'args',
  'env',
  'cwd',
  'url',
  'headers',
  'requestTimeoutMs',
  'initializeTimeoutMs',
]);

/**
 * Symbol key holding the fingerprint cached on a committed record.
 *
 * Symbol-keyed properties are never serialized by `JSON.stringify` and are
 * dropped by `structuredClone`, so the cache can never reach the document on
 * disk or leak into a caller's copy.
 */
export const CONNECTION_FINGERPRINT = Symbol('mcp-manager.connectionFingerprint');

/**
 * Connection identity of one record: the fields whose change forces a
 * reconnect. Host-internal only; never persisted or sent to the Client.
 *
 * @param {object} server - persisted record (or an unsaved edit of one).
 * @returns {string} stable identity string.
 */
export function connectionFingerprint(server) {
  return JSON.stringify(FINGERPRINT_FIELDS.map((field) => server[field]));
}

/**
 * Attach the cached fingerprint to one record before it is frozen.
 * @param {object} record - committed server record.
 * @returns {object} the same record.
 */
function stampFingerprint(record) {
  Object.defineProperty(record, CONNECTION_FINGERPRINT, {
    value: connectionFingerprint(record),
    enumerable: false,
    configurable: true,
    writable: true,
  });
  return record;
}

/**
 * Recursively freeze plain JSON data so one snapshot can be shared by every
 * reader instead of being copied per caller.
 * @template T
 * @param {T} value - JSON value.
 * @returns {T} the same value, frozen in place.
 */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  const stack = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    Object.freeze(current);
    for (const entry of Object.values(current)) {
      if (entry !== null && typeof entry === 'object' && !Object.isFrozen(entry)) stack.push(entry);
    }
  }
  return value;
}

/**
 * Create the JSON document store.
 *
 * @param {{ file?: string, logger?: { warn?: (message: string) => void } }} [options]
 *   `file` overrides the resolved storage path (tests), `logger` receives
 *   tolerant-read warnings.
 * @returns {{
 *   file: string,
 *   load: () => Promise<readonly object[]>,
 *   list: () => readonly object[],
 *   get: (id: string) => object|undefined,
 *   ui: () => { railEntry: boolean },
 *   setServers: (servers: object[]) => Promise<readonly object[]>,
 *   setUi: (ui: { railEntry: boolean }) => Promise<{ railEntry: boolean }>,
 *   flush: () => Promise<void>,
 * }} store handle.
 */
export function createStore(options = {}) {
  const file = options.file ?? resolveStoragePath();
  const logger = options.logger;
  /** Authoritative in-memory records; replaced (never mutated) on every commit. */
  /** @type {object[]} */
  let servers = [];
  /** @type {{ railEntry: boolean }} */
  let ui = { railEntry: DEFAULT_UI.railEntry };
  /** Frozen read-only view of `servers`, shared by every reader until the next commit. */
  /** @type {readonly object[]|undefined} */
  let snapshot;
  /** Frozen read-only view of `ui`, shared by every reader until the next commit. */
  /** @type {{ railEntry: boolean }|undefined} */
  let uiSnapshot;
  /** @type {Map<string, object>|undefined} */
  let index;
  /** @type {Promise<object[]>|undefined} */
  let loading;
  let loaded = false;
  /** Serializes every write (and therefore every document snapshot rename). */
  let writeChain = Promise.resolve();

  const warn = (message) => {
    if (logger !== undefined && typeof logger.warn === 'function') logger.warn(`mcp-manager: ${message}`);
  };

  let storageError;
  let skippedRecords = 0;
  let hasBackup = false;
  /**
   * Exact bytes this store last read from, or successfully wrote to, the
   * document. A write whose re-read differs is a concurrent modification by
   * another process: silently replacing it would drop that process's records.
   * `baselineKnown` stays false when the load failed, and writes are already
   * blocked by `storageError` in that case.
   */
  let baseline = '';
  let baselineKnown = false;
  const backupFile = `${file}.bak`;

  function parseDocument(raw, report = false) {
    const document = JSON.parse(raw);
    if (!isRecord(document) || !Array.isArray(document.servers)) throw new Error('expected a servers array');
    if (document.version !== undefined && document.version !== STORAGE_VERSION) {
      throw new Error(`unsupported document version ${String(document.version)}`);
    }
    const accepted = [];
    const ids = new Set();
    let skipped = 0;
    for (const entry of document.servers) {
      const server = coerceStoredServer(entry, { servers: accepted, warn: report ? warn : undefined });
      if (!server || ids.has(server.id)) {
        skipped += 1;
        if (report) warn(`ignoring invalid or duplicate persisted server at index ${accepted.length + skipped - 1}`);
        continue;
      }
      ids.add(server.id);
      accepted.push(server);
    }
    return { servers: accepted, ui: coerceUi(document.ui, report ? warn : undefined), skipped };
  }

  function load() {
    if (loaded) return Promise.resolve(list());
    loading ??= (async () => {
      try {
        const raw = await readFile(file, 'utf8');
        const document = parseDocument(raw, true);
        commit(document.servers, document.ui);
        skippedRecords = document.skipped;
        baseline = raw;
        baselineKnown = true;
      } catch (error) {
        if (error?.code === 'ENOENT') {
          baseline = '';
          baselineKnown = true;
        } else {
          storageError = `Could not load configuration: ${error?.message ?? String(error)}`;
          warn(storageError);
        }
      }
      try {
        parseDocument(await readFile(backupFile, 'utf8'));
        hasBackup = true;
      } catch { hasBackup = false; }
      loaded = true;
      return list();
    })();
    return loading;
  }

  /**
   * Publish a new in-memory configuration and drop the derived read-only views.
   * @param {object[]} nextServers - records to become authoritative.
   * @param {{ railEntry: boolean }} nextUi - preference to become authoritative.
   * @returns {void}
   */
  function commit(nextServers, nextUi) {
    servers = nextServers;
    ui = nextUi;
    snapshot = undefined;
    uiSnapshot = undefined;
    index = undefined;
  }

  /**
   * Frozen read-only view of the committed records.
   *
   * The clone is built once per commit and shared, so repeated reads during one
   * agent sync (which used to deep-copy every record including credentials)
   * become O(1). The view is frozen, so a caller can never corrupt it; copy
   * before editing.
   *
   * @returns {readonly object[]} shared frozen snapshot.
   */
  function list() {
    if (snapshot === undefined) {
      const frozen = servers.map((record) => deepFreeze(stampFingerprint(record)));
      snapshot = Object.freeze(frozen);
      index = new Map(frozen.map((record) => [record.id, record]));
    }
    return snapshot;
  }

  /**
   * Look one committed record up by id in O(1).
   * @param {string} id - server id.
   * @returns {object|undefined} frozen record, or undefined when absent.
   */
  function get(id) {
    if (typeof id !== 'string' || id === '') return undefined;
    list();
    return index.get(id);
  }

  /**
   * Frozen read-only copy of the page preference.
   * @returns {{ railEntry: boolean }} shared frozen preference.
   */
  function getUi() {
    uiSnapshot ??= deepFreeze(clone(ui));
    return uiSnapshot;
  }
  function status() {
    return { readOnly: storageError !== undefined, hasBackup,
      ...(skippedRecords ? { skippedRecords } : {}), ...(storageError ? { error: storageError } : {}) };
  }

  async function persist(nextServers, nextUi, recovering = false) {
    if (storageError && !recovering) throw new ManagerError('storage-readonly', storageError);
    const payload = JSON.stringify({ version: STORAGE_VERSION, servers: nextServers, ui: nextUi }, null, 2) + '\n';
    try {
      if (!recovering) {
        let previous;
        try { previous = await readFile(file, 'utf8'); }
        catch (error) { if (error?.code !== 'ENOENT') throw error; }
        // Another process replaced, removed or created the document since this
        // store last read or wrote it. Follow the on-disk state and refuse this
        // write instead of dropping the other writer's records.
        if (baselineKnown && (previous ?? '') !== baseline) {
          let parsed;
          if (previous === undefined) {
            parsed = { servers: [], ui: { railEntry: DEFAULT_UI.railEntry }, skipped: 0 };
          } else {
            try { parsed = parseDocument(previous); }
            catch {
              storageError = 'Configuration changed or became unreadable: the document was replaced by another process';
              throw new ManagerError('storage-readonly', storageError);
            }
          }
          commit(parsed.servers, parsed.ui);
          skippedRecords = parsed.skipped;
          baseline = previous ?? '';
          throw new ManagerError('conflict', `${file} was changed by another process; the stored configuration was reloaded, retry the change`);
        }
        if (previous !== undefined) {
          // Never replace an externally damaged document with a stale memory snapshot.
          let parsed;
          try { parsed = parseDocument(previous); }
          catch (error) {
            storageError = `Configuration changed or became unreadable: ${error.message}`;
            throw new ManagerError('storage-readonly', storageError);
          }
          if (parsed.skipped) {
            await writeFileAtomic(`${file}.recovery-${Date.now()}-${randomUUID()}`, previous);
          }
          await writeFileAtomic(backupFile, previous);
          hasBackup = true;
        }
      }
      await writeFileAtomic(file, payload);
    } catch (error) {
      if (error instanceof ManagerError) throw error;
      throw new ManagerError('internal', `could not persist MCP servers: ${error?.message ?? String(error)}`);
    }
    // Commit the in-memory state only after rename succeeds.
    commit(clone(nextServers), clone(nextUi));
    baseline = payload;
    baselineKnown = true;
    storageError = undefined;
    skippedRecords = 0;
  }

  function enqueue(task) {
    const run = writeChain.then(task);
    writeChain = run.then(() => undefined, () => undefined);
    return run;
  }

  function setServers(next) {
    if (!Array.isArray(next)) throw new ManagerError('internal', 'servers must be an array');
    const candidate = clone(next);
    return enqueue(async () => {
      await load();
      await persist(candidate, ui);
      return list();
    });
  }

  function setUi(next) {
    const normalized = validateUi(next);
    return enqueue(async () => {
      await load();
      await persist(servers, normalized);
      return getUi();
    });
  }

  function recover(mode) {
    return enqueue(async () => {
      await load();
      if (!['backup', 'reset'].includes(mode)) throw new ManagerError('invalid', 'recovery mode must be backup or reset', 'mode');
      const document = mode === 'backup'
        ? parseDocument(await readFile(backupFile, 'utf8'))
        : { servers: [], ui: { ...DEFAULT_UI } };
      // Keep the exact original bytes, including unknown future versions.
      let archive;
      try {
        await stat(file);
        archive = `${file}.recovery-${Date.now()}-${randomUUID()}`;
        await copyFile(file, archive);
      } catch (error) { if (error?.code !== 'ENOENT') throw error; }
      await persist(document.servers, document.ui, true);
      return { servers: list(), archive };
    });
  }

  return {
    status,
    recover,
    load,
    list,
    get,
    ui: getUi,
    setServers,
    setUi,
    flush() {
      return writeChain;
    },
  };
}

/**
 * Build the persisted record for a create/update, preserving `id` and
 * `createdAt` across edits.
 *
 * @param {object} input - normalized `ServerInput`.
 * @param {{ existing?: object }} [context] - record being replaced, if any.
 * @returns {object} `Server` to persist.
 */
export function buildServerRecord(input, context = {}) {
  const existing = context.existing;
  return {
    id: existing?.id ?? randomUUID(),
    ...clone(input),
    createdAt: existing?.createdAt ?? Date.now(),
  };
}
