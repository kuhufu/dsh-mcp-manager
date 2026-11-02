/**
 * Persistence and input validation for the `@kuhufu/dsh-mcp-manager` bundle.
 *
 * The Host owns one JSON document at `<DSH_HOME>/storages/mcp-manager.json`
 * (`DSH_HOME` environment variable, else `~/.dsh`). It holds the managed server
 * records plus the page-level UI preference (`ui.railEntry`, default `true`).
 * Writes are atomic (a temp sibling plus `rename`) and serialized so concurrent
 * route handlers can never interleave two documents. Reads are tolerant: a
 * missing, unreadable, corrupt or unrecognized file yields an empty server list
 * (and a warning) instead of failing plugin startup; a missing or malformed
 * `ui` block simply falls back to the default preference.
 *
 * Validation functions are the authoritative Host-side rules from
 * `mcp-manager/CONTRACT.md`; the Client mirrors them only for ergonomics.
 *
 * @module @kuhufu/dsh-mcp-manager/host/store
 */

import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

/** Persisted document version. */
export const STORAGE_VERSION = 1;

/** Relative path of the storage document below `DSH_HOME`. */
export const STORAGE_RELATIVE_PATH = path.join('storages', 'mcp-manager.json');

/**
 * Persisted page-level preference: whether this bundle also installs a
 * left-rail entry for the same page. The Settings page always exists; only the
 * rail surface follows this flag.
 */
export const DEFAULT_UI = Object.freeze({ railEntry: true });

/** Tool-namespace rule for one MCP server: `^[A-Za-z0-9_-]{1,32}$`. */
export const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

/** Environment variable name rule for stdio servers. */
export const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** HTTP header name rule (RFC 9110 token, deliberately permissive). */
export const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/**
 * Every machine-readable failure code the Host can put on the wire.
 *
 * `invalid`/`duplicate-name`/`not-found`/`internal` originate here;
 * `overridden` and `unsupported` come from the Loader/profile layer
 * (`host/profile-patch.js` and `index.js`) when a row cannot be switched.
 */
export const ERROR_CODES = Object.freeze([
  'invalid',
  'duplicate-name',
  'not-found',
  'overridden',
  'unsupported',
  'internal',
]);

/** Failure carrying a stable wire code, a human message and an optional field. */
export class ManagerError extends Error {
  /**
   * @param {'invalid'|'duplicate-name'|'not-found'|'overridden'|'unsupported'|'internal'} code - stable wire code.
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
export function coerceUi(value, warn) {
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
    let parsed;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw new ManagerError('invalid', 'url must be an absolute http(s) URL', 'url');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new ManagerError('invalid', 'url must be an absolute http(s) URL', 'url');
    }
    normalized.url = rawUrl;
    normalized.headers = normalizeStringMap(input.headers, 'headers', HEADER_NAME_PATTERN);
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
    out[key] = entry;
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
export function coerceStoredServer(value, context = {}) {
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
 * Create the JSON document store.
 *
 * @param {{ file?: string, logger?: { warn?: (message: string) => void } }} [options]
 *   `file` overrides the resolved storage path (tests), `logger` receives
 *   tolerant-read warnings.
 * @returns {{
 *   file: string,
 *   load: () => Promise<object[]>,
 *   list: () => object[],
 *   ui: () => { railEntry: boolean },
 *   setServers: (servers: object[]) => Promise<object[]>,
 *   setUi: (ui: { railEntry: boolean }) => Promise<{ railEntry: boolean }>,
 *   flush: () => Promise<void>,
 * }} store handle.
 */
export function createStore(options = {}) {
  const file = options.file ?? resolveStoragePath();
  const logger = options.logger;
  /** @type {object[]} */
  let servers = [];
  /** @type {{ railEntry: boolean }} */
  let ui = { railEntry: DEFAULT_UI.railEntry };
  /** @type {Promise<object[]>|undefined} */
  let loading;
  let loaded = false;
  /** Serializes every write (and therefore every document snapshot rename). */
  let writeChain = Promise.resolve();
  let tempSequence = 0;

  const warn = (message) => {
    if (logger !== undefined && typeof logger.warn === 'function') logger.warn(`mcp-manager: ${message}`);
  };

  async function readDocument() {
    const empty = { servers: [], ui: { railEntry: DEFAULT_UI.railEntry } };
    let raw;
    try {
      raw = await readFile(file, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') warn(`could not read ${file}: ${error?.message ?? String(error)}`);
      return empty;
    }
    let document;
    try {
      document = JSON.parse(raw);
    } catch {
      warn(`ignoring unreadable JSON at ${file}`);
      return empty;
    }
    if (!isRecord(document) || !Array.isArray(document.servers)) {
      warn(`ignoring ${file}: expected an object with a servers array`);
      return empty;
    }
    if (document.version !== undefined && document.version !== STORAGE_VERSION) {
      warn(`ignoring ${file}: unsupported document version ${String(document.version)}`);
      return empty;
    }
    const accepted = [];
    for (const entry of document.servers) {
      const server = coerceStoredServer(entry, { servers: accepted, warn });
      if (server !== undefined) accepted.push(server);
    }
    return { servers: accepted, ui: coerceUi(document.ui, warn) };
  }

  function load() {
    if (loaded) return Promise.resolve(clone(servers));
    loading ??= readDocument().then((document) => {
      servers = document.servers;
      ui = document.ui;
      loaded = true;
      loading = undefined;
      return clone(servers);
    }, (error) => {
      loading = undefined;
      warn(`could not load ${file}: ${error?.message ?? String(error)}`);
      servers = [];
      ui = { railEntry: DEFAULT_UI.railEntry };
      loaded = true;
      return [];
    });
    return loading.then((records) => clone(records));
  }

  function list() {
    return clone(servers);
  }

  /** @returns {{ railEntry: boolean }} resolved page-level preference. */
  function getUi() {
    return clone(ui);
  }

  async function writeSnapshot() {
    const payload = `${JSON.stringify({ version: STORAGE_VERSION, servers, ui }, null, 2)}\n`;
    await mkdir(path.dirname(file), { recursive: true });
    const tempFile = `${file}.tmp-${process.pid}-${tempSequence += 1}`;
    try {
      const handle = await open(tempFile, 'w');
      try {
        await handle.writeFile(payload, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(tempFile, file);
    } catch (error) {
      await rm(tempFile, { force: true }).catch(() => {});
      throw new ManagerError('internal', `could not persist MCP servers to ${file}: ${error?.message ?? String(error)}`);
    }
  }

  function enqueue(task) {
    const run = writeChain.then(task);
    writeChain = run.then(() => undefined, () => undefined);
    return run;
  }

  function setServers(next) {
    if (!Array.isArray(next)) throw new ManagerError('internal', 'servers must be an array');
    return enqueue(async () => {
      servers = clone(next);
      await writeSnapshot();
      return clone(servers);
    });
  }

  function setUi(next) {
    const normalized = validateUi(next);
    return enqueue(async () => {
      ui = normalized;
      await writeSnapshot();
      return clone(ui);
    });
  }

  return {
    file,
    load,
    list,
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
