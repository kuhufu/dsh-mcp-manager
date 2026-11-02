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
/** Absolute path of the page-preference route (`ui.railEntry`). */
export const UI_PATH = '/api/mcp-manager.ui';

/** Every path this bundle owns, in registration order. */
export const ROUTE_PATHS = Object.freeze([
  LIST_PATH,
  SAVE_PATH,
  REMOVE_PATH,
  TOGGLE_PATH,
  RECONNECT_PATH,
  TAKEOVER_PATH,
  UI_PATH,
]);

/** Failure raised for a request body that is not a JSON object. */
class BodyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BodyError';
  }
}

/**
 * Build the seven Fetch route descriptors for a manager.
 *
 * @param {{
 *   list: () => object[],
 *   save: (payload: { id?: string, server: unknown }) => Promise<{ id: string, servers: object[] }>,
 *   remove: (payload: { id: string }) => Promise<{ servers: object[] }>,
 *   toggle: (payload: { id: string, enabled: boolean }) => Promise<{ servers: object[] }>,
 *   reconnect: (payload: { id: string }) => Promise<{ servers: object[] }>,
 *   takeover: (payload: { entryId: string }) => Promise<{ id: string, servers: object[], warnings: string[] }>,
 *   ui?: () => { railEntry: boolean },
 *   setUi?: (payload: { railEntry: boolean }) => Promise<{ servers: object[], ui: { railEntry: boolean } }>,
 * }} manager - Host manager the routes delegate to.
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
      return { ok: true, id: result.id, servers: result.servers, warnings: result.warnings };
    }, logger),
    route(manager, UI_PATH, async (body) => {
      // The manager owns the boolean rule; a missing or non-boolean value is an
      // `invalid` failure with field `railEntry`, never a 4xx.
      const result = await manager.setUi({ railEntry: body.railEntry });
      return { ok: true, servers: result.servers, ui: result.ui };
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
 * @param {object} manager - Host manager (its `ready` promise, when present, gates every request).
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
      if (typeof manager.ready === 'function') await manager.ready();
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
        let enriched = payload;
        if (typeof manager.external === 'function') enriched = { ...enriched, external: manager.external() };
        if (typeof manager.ui === 'function') enriched = { ...enriched, ui: manager.ui() };
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
