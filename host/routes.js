/**
 * Exact Fetch routes served by the `@kuhufu/dsh-mcp-manager` Host half.
 *
 * Every route is a `POST` on `ctx.connection.fetch`, accepts and returns JSON,
 * and sends `cache-control: no-store`. The browser module calls the relative
 * form (`api/mcp-manager.list`) so the same code resolves under both the Web
 * server and the desktop carrier; the absolute path below is what the route
 * registry matches.
 *
 * Mutations always answer with the fresh `ServerView[]`, so the Client can
 * replace its list from one response. Every success payload also carries the
 * read-only foreign-entry rows (`external`) and the page preference (`ui`), so
 * one response can drive both surfaces. Protocol failures use HTTP 200 with
 * `{ ok: false, error }`; only a malformed request body is a 4xx.
 *
 * @module @kuhufu/dsh-mcp-manager/host/routes
 */

import { ManagerError, isRecord } from './store.js';

/** Absolute path of the list route. */
export const LIST_PATH = '/api/mcp-manager.list';
/** Absolute path of the create/update route. */
export const SAVE_PATH = '/api/mcp-manager.save';
/** Absolute path of the delete route. */
export const REMOVE_PATH = '/api/mcp-manager.remove';
/** Absolute path of the enable/disable route. */
export const TOGGLE_PATH = '/api/mcp-manager.toggle';
/** Absolute path of the reconnect route. */
export const RECONNECT_PATH = '/api/mcp-manager.reconnect';
/** Absolute path of the takeover route for a dsh-mcp-client entry. */
export const TAKEOVER_PATH = '/api/mcp-manager.takeover';
/** Absolute path of the enable/disable route for a dsh-mcp-client entry. */
export const EXTERNAL_TOGGLE_PATH = '/api/mcp-manager.toggle-external';
/** Absolute path of the page-preference route (`ui.railEntry`). */
export const UI_PATH = '/api/mcp-manager.ui';
/** Absolute path of the batch configuration import route. */
export const IMPORT_PATH = '/api/mcp-manager.import';
/** Absolute path of the configuration export route. */
export const EXPORT_PATH = '/api/mcp-manager.export';
/** Absolute path of the storage recovery route. */
export const RECOVER_PATH = '/api/mcp-manager.recover';
/** Absolute path of the individual tool enablement route. */
export const TOOL_PATH = '/api/mcp-manager.tool';
/** Absolute path of the per-Session MCP visibility route. */
export const SESSION_PATH = '/api/mcp-manager.session';
/** Absolute path of the per-Session override route. */
export const SESSION_SET_PATH = '/api/mcp-manager.session-set';
/** Absolute path of the external-entry default-injection route. */
export const EXTERNAL_DEFAULT_PATH = '/api/mcp-manager.external-default';
/** Absolute path of the duplicate-declaration repair route. */
export const REPAIR_PATCH_PATH = '/api/mcp-manager.repair-patch';

/** Every path this bundle owns, in registration order. */
export const ROUTE_PATHS = Object.freeze([
  LIST_PATH,
  SAVE_PATH,
  REMOVE_PATH,
  TOGGLE_PATH,
  RECONNECT_PATH,
  TAKEOVER_PATH,
  EXTERNAL_TOGGLE_PATH,
  UI_PATH,
  IMPORT_PATH,
  EXPORT_PATH,
  RECOVER_PATH,
  TOOL_PATH,
  SESSION_PATH,
  REPAIR_PATCH_PATH,
  EXTERNAL_DEFAULT_PATH,
  SESSION_SET_PATH,
]);

/**
 * Flatten one persisted record plus its runtime entry into the `ServerView`
 * the Client renders.
 * @param {object} server - persisted record.
 * @param {object|undefined} state - internal runtime state, treated as read-only.
 * @returns {object} view with flattened runtime fields.
 */
export function serverView(server, state) {
  /** @type {Record<string, unknown>} */
  const view = { ...server };
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
    publicName: tool.publicName,
    enabled: tool.enabled,
    ...(tool.description === undefined ? {} : { description: tool.description }),
  }));
  view.toolCount = state.toolCount;
  view.logs = state.logs.map((entry) => ({ ...entry }));
  view.retryAttempt = state.retryAttempt;
  view.nextRetryAt = state.nextRetryAt;
  view.protocolVersion = state.connection?.protocolVersion;
  if (state.serverInfo !== undefined) view.serverInfo = { ...state.serverInfo };
  if (state.instructions !== undefined) view.instructions = state.instructions;
  if (state.connectedAt !== undefined) view.connectedAt = state.connectedAt;
  return view;
}


/** Failure raised for a request body that is not a JSON object. */
class BodyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BodyError';
  }
}

/**
 * Build the twelve Fetch route descriptors for a manager.
 *
 * @param {ReturnType<import('./manager.js').createMcpManager>} manager - complete Host manager interface.
 * @param {{ logger?: { error?: (message: string) => void } }} [options] - diagnostics sink.
 * @returns {object[]} descriptors accepted by `ctx.connection.fetch.register`.
 */
export function createFetchRoutes(manager, options = {}) {
  const logger = options.logger;

  return [
    route(manager, LIST_PATH, async () => ({ ok: true, servers: manager.list() }), logger),
    route(manager, SAVE_PATH, async (body) => {
      if (body.server === undefined) {
        throw new ManagerError('invalid', 'request body must include "server"', 'server');
      }
      const saved = await manager.save({ id: body.id, server: body.server });
      return { ok: true, id: saved.id, servers: saved.servers };
    }, logger),
    route(manager, REMOVE_PATH, async (body) => {
      const result = await manager.remove({ id: requireId(body) });
      return { ok: true, servers: result.servers };
    }, logger),
    route(manager, TOGGLE_PATH, async (body) => {
      const id = requireId(body);
      if (typeof body.enabled !== 'boolean') {
        throw new ManagerError('invalid', 'enabled must be a boolean', 'enabled');
      }
      const result = await manager.toggle({ id, enabled: body.enabled });
      return { ok: true, servers: result.servers };
    }, logger),
    route(manager, RECONNECT_PATH, async (body) => {
      const result = await manager.reconnect({ id: requireId(body) });
      return { ok: true, servers: result.servers };
    }, logger),
    route(manager, TAKEOVER_PATH, async (body) => {
      if (typeof body.entryId !== 'string' || body.entryId === '') {
        throw new ManagerError('invalid', 'request body must include a non-empty "entryId"', 'entryId');
      }
      const result = await manager.takeover({ entryId: body.entryId });
      return {
        ok: true,
        id: result.id,
        replaced: result.replaced === true,
        servers: result.servers,
        warnings: result.warnings,
      };
    }, logger),
    route(manager, EXTERNAL_TOGGLE_PATH, async (body) => {
      if (typeof body.entryId !== 'string' || body.entryId === '') {
        throw new ManagerError('invalid', 'request body must include a non-empty "entryId"', 'entryId');
      }
      if (typeof body.enabled !== 'boolean') {
        throw new ManagerError('invalid', 'enabled must be a boolean', 'enabled');
      }
      const result = await manager.setExternalEnabled({ entryId: body.entryId, enabled: body.enabled });
      return { ok: true, repaired: result.repaired === true, servers: result.servers };
    }, logger),
    route(manager, UI_PATH, async (body) => {
      // The manager owns the boolean rule; a missing or non-boolean value is an
      // `invalid` failure with field `railEntry`, never a 4xx.
      const result = await manager.setUi({ railEntry: body.railEntry });
      return { ok: true, servers: result.servers, ui: result.ui };
    }, logger),
    route(manager, IMPORT_PATH, async (body) => ({ ok: true, ...await manager.importServers(body) }), logger),
    route(manager, EXPORT_PATH, async (body) => ({ ok: true, document: manager.exportServers(body) }), logger),
    route(manager, RECOVER_PATH, async (body) => ({ ok: true, ...await manager.recoverStorage(body) }), logger),
    route(manager, TOOL_PATH, async (body) => ({ ok: true, ...await manager.setToolEnabled({ ...body, id: requireId(body) }) }), logger),
    route(manager, SESSION_PATH, async (body) => {
      if (typeof body.sessionId !== 'string' || body.sessionId === '') {
        throw new ManagerError('invalid', 'request body must include a non-empty "sessionId"', 'sessionId');
      }
      return { ok: true, ...manager.sessionView(body.sessionId) };
    }, logger),
    route(manager, REPAIR_PATCH_PATH, async () => ({ ok: true, ...await manager.repairPatch() }), logger),
    route(manager, EXTERNAL_DEFAULT_PATH, async (body) => ({ ok: true, ...await manager.setExternalDefault(body) }), logger),
    route(manager, SESSION_SET_PATH, async (body) => {
      if (body.reset === true) return { ok: true, ...await manager.resetSession({ sessionId: body.sessionId }) };
      const enabled = body.enabled === undefined ? null : body.enabled;
      if (typeof body.entryId === 'string' && body.entryId !== '') {
        const result = await manager.setSessionExternalEnabled({ sessionId: body.sessionId, entryId: body.entryId, enabled });
        return { ok: true, ...result };
      }
      const result = await manager.setSessionEnabled({ sessionId: body.sessionId, serverId: body.serverId, enabled });
      return { ok: true, ...result };
    }, logger),
  ];
}

/**
 * Extract the required `id` request field.
 * @param {object} body - parsed request body.
 * @returns {string} server id.
 */
function requireId(body) {
  if (typeof body.id !== 'string' || body.id === '') {
    throw new ManagerError('invalid', 'request body must include a non-empty "id"', 'id');
  }
  return body.id;
}

/**
 * Wrap one handler as an exact Fetch route descriptor.
 * @param {object} manager - Host manager; `ready()` gates every request.
 * @param {string} path - absolute route path.
 * @param {(body: object) => Promise<object>} handle - JSON-in/JSON-out handler.
 * @param {{ error?: (message: string) => void }|undefined} logger - diagnostics sink.
 * @returns {object} route descriptor.
 */
function route(manager, path, handle, logger) {
  return {
    path,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      await manager.ready();
      let body;
      try {
        body = await readJsonObject(request);
      } catch (error) {
        return jsonResponse(400, {
          ok: false,
          error: { code: 'invalid', message: error instanceof Error ? error.message : String(error) },
        });
      }
      try {
        const payload = await handle(body);
        // Every success response also carries the read-only foreign rows and
        // the current page preference, so one response can drive the page.
        const enriched = { ...payload, external: payload.external ?? manager.external(), ui: manager.ui(), storage: manager.storage() };
        return jsonResponse(200, enriched);
      } catch (error) {
        const failure = toFailure(error, logger, path);
        return jsonResponse(200, { ok: false, error: failure });
      }
    },
  };
}

/**
 * Read a request body as a JSON object, tolerating an empty body.
 * @param {Request} request - incoming request.
 * @returns {Promise<object>} parsed object.
 * @throws {BodyError} when the body is not a JSON object.
 */
async function readJsonObject(request) {
  let text;
  try {
    text = await request.text();
  } catch {
    throw new BodyError('request body could not be read');
  }
  if (typeof text !== 'string' || text.trim() === '') return {};
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new BodyError('request body must be valid JSON');
  }
  if (!isRecord(parsed)) throw new BodyError('request body must be a JSON object');
  return parsed;
}

/**
 * Map a thrown value onto the documented failure shape.
 * @param {unknown} error - thrown value.
 * @param {{ error?: (message: string) => void }|undefined} logger - diagnostics sink.
 * @param {string} path - route path for the log message.
 * @returns {{ code: string, message: string, field?: string }} failure body.
 */
function toFailure(error, logger, path) {
  if (error instanceof ManagerError) {
    /** @type {{ code: string, message: string, field?: string }} */
    const failure = { code: error.code, message: error.message };
    if (error.field !== undefined) failure.field = error.field;
    return failure;
  }
  logger?.error?.(`mcp-manager: ${path} failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  return { code: 'internal', message: 'the MCP manager failed to complete the request' };
}

/**
 * Build a JSON response with the pinned no-store policy.
 * @param {number} status - HTTP status.
 * @param {object} body - JSON-serializable response body.
 * @returns {Response} fetch response.
 */
function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}
