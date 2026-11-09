/**
 * Direct import of third-party MCP configuration documents.
 *
 * The page's own JSON transfer box accepts this plugin's export format, but
 * people normally arrive with an `mcp.json` written for another client:
 * Claude Desktop, Claude Code or Cursor (`{ "mcpServers": { ... } }`), VS Code
 * (`{ "servers": { ... } }`, usually JSONC), or just the inner server map.
 * This module turns any of those into validated `ServerInput` records and
 * resolves what those documents leave implicit — transport, the tool-namespace
 * name grammar, duplicate names. Unusable entries are reported and skipped
 * instead of rejecting the whole paste.
 *
 * It is pure: no filesystem, no connection, no persistence.
 *
 * @module @kuhufu/dsh-mcp-manager/host/mcp-json
 */

import { CONNECTION_OPTIONS, ManagerError, isRecord, validateServerInput } from './store.js';

/** Maximum number of server entries one document may import. */
export const MAX_IMPORT_ENTRIES = 200;

/** `type`/`transport` spellings that mean the stdio transport. */
const STDIO_TYPES = new Set(['stdio', 'command', 'process']);

/** `type`/`transport` spellings that mean the Streamable HTTP transport. */
const HTTP_TYPES = new Set(['http', 'streamable-http', 'streamablehttp', 'streamable_http', 'http-streamable']);

/** Legacy SSE spellings; this bundle has no SSE transport, so they cannot run. */
const SSE_TYPES = new Set(['sse', 'sse-http', 'server-sent-events']);

/** Document keys that are configuration metadata, never server names. */
const NON_SERVER_KEYS = new Set(['inputs', '$schema', 'version', 'name', 'description']);

/**
 * Coerce one document-supplied name into the tool-namespace grammar
 * (`^[A-Za-z0-9_-]{1,32}$`) without ever failing: spaces, dots and non-ASCII
 * runs collapse to a dash, and an emptied name falls back to `server`.
 *
 * @param {unknown} raw - name taken from a document key or `name` field.
 * @returns {string} a grammar-valid name of 1–32 characters.
 */
export function sanitizeServerName(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  let name = text.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  if (name.length > 32) name = name.slice(0, 32).replace(/-+$/g, '');
  return name === '' ? 'server' : name;
}

/**
 * Make one sanitized name unique against everything already claimed.
 *
 * @param {string} base - sanitized name.
 * @param {Set<string>} taken - names already present (existing records and earlier entries).
 * @returns {string} `base`, or `base-2`, `base-3`, … that no one has claimed.
 */
export function uniqueServerName(base, taken) {
  if (!taken.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const tail = `-${suffix}`;
    const candidate = `${base.slice(0, 32 - tail.length).replace(/-+$/g, '')}${tail}`;
    if (candidate !== '' && !taken.has(candidate)) return candidate;
  }
}

/**
 * Read the raw server entries a document declares.
 *
 * Shapes are tried in order of specificity: Claude/Cursor `mcpServers`, a VS
 * Code `servers` object or this plugin's `servers` array, a top-level server
 * array, a single server object, then a bare `{ name: config }` map.
 *
 * @param {unknown} document - parsed JSON document.
 * @returns {{ name: unknown, config: unknown }[]} candidates in document order.
 * @throws {ManagerError} `invalid` when the document declares no servers or too many.
 */
export function readMcpJsonEntries(document) {
  /** @type {{ name: unknown, config: unknown }[]} */
  let candidates = [];
  if (Array.isArray(document)) {
    candidates = document.map((entry) => ({ name: isRecord(entry) ? entry.name : undefined, config: entry }));
  } else if (!isRecord(document)) {
    throw new ManagerError('invalid', 'document must be a JSON object or servers array', 'document');
  } else if (isRecord(document.mcpServers) && Object.keys(document.mcpServers).length > 0) {
    candidates = mapEntries(document.mcpServers);
  } else if (Array.isArray(document.servers)) {
    candidates = document.servers.map((entry) => ({ name: isRecord(entry) ? entry.name : undefined, config: entry }));
  } else if (isRecord(document.servers)) {
    candidates = mapEntries(document.servers);
  } else if (looksLikeServer(document)) {
    candidates = [{ name: document.name, config: document }];
  } else {
    candidates = bareEntries(document) ?? [];
  }
  if (candidates.length === 0) {
    throw new ManagerError(
      'invalid',
      'no MCP servers found in this document: expected "mcpServers", a "servers" object or array, a top-level server array, one server object, or a { name: config } map',
      'document',
    );
  }
  if (candidates.length > MAX_IMPORT_ENTRIES) {
    throw new ManagerError('invalid', `a document may import at most ${MAX_IMPORT_ENTRIES} servers`, 'document');
  }
  return candidates;
}

/**
 * Normalize one whole document into validated `ServerInput` records.
 *
 * Every entry is resolved independently: one unusable entry becomes a
 * `skipped` warning while the rest still import. Names are sanitized and
 * de-duplicated against `servers` (the already-persisted records) and against
 * earlier entries of the same batch; a changed name is reported as `renamed`.
 *
 * @param {unknown} document - parsed JSON/JSONC document (comments already stripped).
 * @param {{ servers?: object[], enable?: boolean }} [options] - existing records and
 *   the requested default for imported servers (`true` unless explicitly `false`).
 * @returns {{ entries: object[], warnings: object[], enabled: number }} normalized inputs,
 *   non-fatal report rows, and how many of those inputs will connect immediately.
 * @throws {ManagerError} `invalid` when nothing at all can be imported.
 */
export function normalizeMcpJsonDocument(document, options = {}) {
  const existing = Array.isArray(options.servers) ? options.servers : [];
  const enable = options.enable !== false;
  const taken = new Set(existing.map((server) => server.name).filter((name) => typeof name === 'string'));
  /** @type {{ kind: string, [key: string]: unknown }[]} */
  const warnings = [];
  /** @type {object[]} */
  const entries = [];
  for (const candidate of readMcpJsonEntries(document)) {
    const entry = normalizeEntry(candidate, { enable, taken, warnings });
    if (entry !== undefined) entries.push(entry);
  }
  if (entries.length === 0) {
    throw new ManagerError('invalid', 'no importable MCP servers in this document', 'document');
  }
  return {
    entries,
    warnings,
    enabled: entries.filter((entry) => entry.enabled === true && entry.autoInject !== false).length,
  };
}

/**
 * Normalize one raw entry, reporting why it cannot be imported instead of throwing.
 *
 * @param {{ name: unknown, config: unknown }} candidate - one document entry.
 * @param {{ enable: boolean, taken: Set<string>, warnings: object[] }} context - shared batch state.
 * @returns {object|undefined} validated `ServerInput`, or undefined when skipped.
 */
function normalizeEntry(candidate, context) {
  const { enable, taken, warnings } = context;
  const { config } = candidate;
  const rawName = typeof candidate.name === 'string' && candidate.name.trim() !== ''
    ? candidate.name.trim()
    : undefined;
  const displayName = rawName ?? 'server';
  if (!isRecord(config)) {
    warnings.push({ kind: 'skipped', name: displayName, reason: 'invalid-entry' });
    return undefined;
  }

  const declared = declaredTransport(config);
  if (declared.sse === true) {
    warnings.push({ kind: 'skipped', name: displayName, reason: 'sse-unsupported' });
    return undefined;
  }
  const { command, extraArgs } = commandParts(config);
  const hasCommand = typeof config.command === 'string' || Array.isArray(config.command);
  const url = typeof config.url === 'string' ? config.url.trim() : '';
  /** @type {'stdio'|'http'|undefined} */
  let transport = declared.transport;
  if (transport === undefined) {
    if (url !== '') transport = 'http';
    else if (hasCommand) transport = 'stdio';
  }
  if (transport === undefined) {
    warnings.push({ kind: 'skipped', name: displayName, reason: 'missing-transport' });
    return undefined;
  }

  /** Reasons that matter once the entry is known to be importable. */
  const notes = [];
  if (declared.unknown === true) notes.push('unknown-transport');
  const sourceDisabled = config.disabled === true || config.enabled === false;
  if (sourceDisabled) notes.push('source-disabled');
  if (typeof config.envFile === 'string' && config.envFile.trim() !== '') notes.push('env-file-ignored');
  if (mentionsInputPlaceholder(config)) notes.push('input-placeholder');

  /** @type {Record<string, unknown>} */
  const input = { transport, enabled: enable && !sourceDisabled };
  if (transport === 'stdio') {
    if (command === undefined || command === '') {
      warnings.push({ kind: 'skipped', name: displayName, reason: 'missing-command' });
      return undefined;
    }
    input.command = command;
    input.args = [...extraArgs, ...stringList(config.args, notes)];
    input.env = stringMap(config.env, /^[A-Za-z_][A-Za-z0-9_]*$/, notes);
    if (typeof config.cwd === 'string' && config.cwd.trim() !== '') input.cwd = config.cwd.trim();
  } else {
    if (url === '') {
      warnings.push({ kind: 'skipped', name: displayName, reason: 'missing-url' });
      return undefined;
    }
    if (!isHttpUrl(url)) {
      warnings.push({ kind: 'skipped', name: displayName, reason: 'invalid-url' });
      return undefined;
    }
    input.url = url;
    input.headers = stringMap(config.headers, /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/, notes);
  }

  for (const [field, { min, max }] of Object.entries(CONNECTION_OPTIONS)) {
    const value = config[field];
    if (value === undefined) continue;
    // Stay inside the Host's documented ranges: an out-of-range value from a
    // foreign client drops to the default instead of rejecting the batch.
    if (Number.isInteger(value) && value >= min && value <= max) input[field] = value;
    else notes.push('dropped-fields');
  }
  if (typeof config.autoInject === 'boolean') input.autoInject = config.autoInject;
  if (Array.isArray(config.disabledTools)) {
    input.disabledTools = config.disabledTools.filter((name) => typeof name === 'string');
  }

  const finalName = uniqueServerName(sanitizeServerName(rawName), taken);
  taken.add(finalName);
  if (rawName !== undefined && rawName !== finalName) {
    warnings.push({ kind: 'renamed', from: rawName, to: finalName });
  }
  for (const reason of new Set(notes)) warnings.push({ kind: 'note', name: finalName, reason });
  // The name is assigned last so a skipped entry never claims one; validation is
  // re-run through the store's authoritative rules to stay contract-identical.
  return validateServerInput({ ...input, name: finalName }, { servers: [] });
}

/**
 * Decide which transport a third-party entry declares.
 *
 * @param {object} config - one raw server config.
 * @returns {{ transport?: 'stdio'|'http', sse?: boolean, unknown?: boolean }} the reading;
 *   `transport` is undefined when the type is absent or unfamiliar.
 */
function declaredTransport(config) {
  const raw = typeof config.type === 'string'
    ? config.type
    : typeof config.transport === 'string'
      ? config.transport
      : '';
  const type = raw.trim().toLowerCase();
  if (type === '') return {};
  if (STDIO_TYPES.has(type)) return { transport: 'stdio' };
  if (HTTP_TYPES.has(type)) return { transport: 'http' };
  if (SSE_TYPES.has(type)) return { sse: true };
  return { unknown: true };
}

/**
 * Read the command and any arguments folded into it.
 *
 * `command` is normally a string; a few clients fold the executable and its
 * arguments into one array, which is accepted and split.
 *
 * @param {object} config - one raw server config.
 * @returns {{ command?: string, extraArgs: string[] }} executable and folded arguments.
 */
function commandParts(config) {
  const raw = config.command;
  if (typeof raw === 'string') {
    const command = raw.trim();
    return command === '' ? { extraArgs: [] } : { command, extraArgs: [] };
  }
  if (Array.isArray(raw) && raw.length > 0 && raw.every((item) => typeof item === 'string' || typeof item === 'number')) {
    const [first, ...rest] = raw.map(String);
    const command = first.trim();
    return command === '' ? { extraArgs: [] } : { command, extraArgs: rest };
  }
  return { extraArgs: [] };
}

/**
 * A plain string list, coercing scalar JSON values (clients sometimes write
 * numbers) and dropping anything structural.
 *
 * @param {unknown} value - raw `args` value.
 * @param {string[]} notes - per-entry note sink.
 * @returns {string[]} arguments.
 */
function stringList(value, notes) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    notes.push('dropped-fields');
    return [];
  }
  const out = [];
  for (const item of value) {
    if (typeof item === 'string') out.push(item);
    else if (typeof item === 'number' || typeof item === 'boolean') out.push(String(item));
    else notes.push('dropped-fields');
  }
  return out;
}

/**
 * A plain string map, coercing scalar JSON values and dropping keys the Host's
 * grammar rejects.
 *
 * @param {unknown} value - raw `env`/`headers` value.
 * @param {RegExp} keyPattern - the field's key rule.
 * @param {string[]} notes - per-entry note sink.
 * @returns {Record<string, string>} environment variables or headers.
 */
function stringMap(value, keyPattern, notes) {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) {
    notes.push('dropped-fields');
    return {};
  }
  /** @type {Record<string, string>} */
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (!keyPattern.test(key)) {
      notes.push('dropped-fields');
      continue;
    }
    if (typeof item === 'string') out[key] = item;
    else if (typeof item === 'number' || typeof item === 'boolean') out[key] = String(item);
    else notes.push('dropped-fields');
  }
  return out;
}

/**
 * Whether a config still contains a VS Code `${input:…}` prompt placeholder.
 *
 * Import cannot prompt, so the placeholder is kept verbatim and flagged: the
 * server will not work until the user edits the value.
 *
 * @param {object} config - one raw server config.
 * @returns {boolean} true when a placeholder remains anywhere relevant.
 */
function mentionsInputPlaceholder(config) {
  const fields = [config.command, config.url, config.cwd, config.env, config.headers, config.args];
  return fields.some((value) => JSON.stringify(value ?? null).includes('${input:'));
}

/**
 * Validate one absolute http(s) URL without throwing.
 *
 * @param {string} url - candidate endpoint.
 * @returns {boolean} whether the endpoint is usable.
 */
function isHttpUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Whether a value looks like one complete server object rather than a document.
 *
 * @param {object} value - parsed JSON object.
 * @returns {boolean} true when it carries a transport or endpoint field.
 */
function looksLikeServer(value) {
  return ['command', 'url', 'transport', 'type'].some((field) => value[field] !== undefined);
}

/**
 * Turn an object map into raw candidates.
 *
 * @param {Record<string, unknown>} map - `mcpServers`/`servers` object.
 * @returns {{ name: unknown, config: unknown }[]} candidates.
 */
function mapEntries(map) {
  return Object.entries(map).map(([name, config]) => ({ name, config }));
}

/**
 * Read a bare `{ name: config }` document, if it is one.
 *
 * Metadata keys are ignored; every remaining value must be an object and at
 * least one must look like a server, so an unrelated settings document is not
 * mistaken for a server map.
 *
 * @param {Record<string, unknown>} document - parsed JSON object.
 * @returns {{ name: unknown, config: unknown }[]|undefined} candidates, or undefined.
 */
function bareEntries(document) {
  const entries = Object.entries(document).filter(([key]) => !NON_SERVER_KEYS.has(key));
  if (entries.length === 0) return undefined;
  if (!entries.every(([, config]) => isRecord(config))) return undefined;
  if (!entries.some(([, config]) => looksLikeServer(config))) return undefined;
  return entries.map(([name, config]) => ({ name, config }));
}
