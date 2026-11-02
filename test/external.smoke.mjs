/**
 * Focused checks for the foreign-entry face of the bundle:
 *
 * 1. `external` lists only live `@deepseek-ai/dsh-mcp-client` entries, with the
 *    full Loader entry id, the resolved target and the live tool count.
 * 2. `/api/mcp-manager.takeover` disables the source entry first, copies its
 *    configuration into a managed record and never leaks secrets into `external`.
 *
 * Runs the real `apply()` against a fake Cordis context: no network, and the
 * copied command does not exist, so the connection settles as an error — which
 * is exactly what the test asserts.
 *
 * @module @kuhufu/dsh-mcp-manager/test/external.smoke
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';

/**
 * Count executed assertions so the closing line reports a real number instead
 * of a hand-maintained one.
 */
let checks = 0;
for (const method of ['ok', 'equal', 'deepEqual', 'match', 'throws']) {
  const original = assert[method];
  if (typeof original !== 'function') continue;
  assert[method] = (...args) => {
    checks += 1;
    return original(...args);
  };
}

import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = await mkdtemp(join(tmpdir(), 'dshmcp-external-'));
process.env.DSH_HOME = home;

const { apply } = await import('../index.js');
const { LIST_PATH, TAKEOVER_PATH, EXTERNAL_TOGGLE_PATH, UI_PATH } = await import('../host/routes.js');

/** Tool schemas visible to the fake registry. */
const schemas = [
  { name: 'mcp__deepwiki__ask_wiki_question', description: 'ask' },
  { name: 'mcp__deepwiki__read_wiki_structure', description: 'structure' },
  { name: 'mcp__other__ping', description: 'ping' },
  { name: 'bash', description: 'not mcp' },
];

/** One live mcp-client row, one disabled mcp-client row, one unrelated row. */
const deepwiki = {
  id: 'include:magpie-mcp-deepwiki',
  options: {
    id: 'magpie-mcp-deepwiki',
    name: '@deepseek-ai/dsh-mcp-client',
    config: {
      serverName: 'deepwiki',
      transport: 'stdio',
      command: '/nonexistent-mcp-binary',
      args: ['--flag'],
      env: { TOKEN: 'hidden' },
    },
  },
  disabled: false,
  fiber: { state: 2 },
};
const disabledRow = {
  id: 'include:mcp-web',
  options: {
    id: 'mcp-web',
    name: '@deepseek-ai/dsh-mcp-client',
    config: { serverName: 'web', transport: 'streamable-http', url: 'http://127.0.0.1:9/mcp' },
  },
  disabled: true,
};
const unrelated = {
  id: 'include:timer',
  options: { id: 'timer', name: '@deepseek-ai/cordis-plugin-timer' },
  disabled: false,
  fiber: { state: 2 },
};

const loader = {
  *entries() {
    yield deepwiki;
    yield disabledRow;
    yield unrelated;
  },
};

/** Plugin-manager stub: records calls and flips the addressed row's disabled flag. */
const pluginCalls = [];
const rowsById = { [deepwiki.id]: deepwiki, [disabledRow.id]: disabledRow };
const pluginManager = {
  async setPluginEnabled(id, enabled) {
    pluginCalls.push([id, enabled]);
    const target = rowsById[id];
    if (target !== undefined) target.disabled = !enabled;
    return { stage: 'enable', target: id, enabled, changed: true, application: 'applied', warnings: [] };
  },
};

const routes = new Map();
const registeredTools = [];

const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  tools: {
    register: (definition) => {
      registeredTools.push(definition.name);
      return () => {};
    },
    schemas: () => schemas,
  },
  connection: {
    fetch: {
      register: (route) => {
        routes.set(route.path, route);
        return Promise.resolve(() => Promise.resolve());
      },
    },
  },
  effect: (callback) => {
    const dispose = callback();
    return () => {
      if (typeof dispose === 'function') return dispose();
      return undefined;
    };
  },
  get: (name) => {
    if (name === 'loader') return loader;
    if (name === 'pluginManager') return pluginManager;
    return undefined;
  },
};

apply(ctx);

const call = async (path, body) => {
  const route = routes.get(path);
  assert.ok(route, `${path} registered`);
  const response = await route.fetch(
    new Request(`http://127.0.0.1${path}`, { method: 'POST', body: JSON.stringify(body) }),
  );
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const payload = await response.json();
  return { status: response.status, payload };
};

const ok = async (path, body) => {
  const { payload } = await call(path, body);
  assert.equal(payload.ok, true, JSON.stringify(payload));
  return payload;
};

let list = await ok(LIST_PATH, {});
assert.deepEqual(list.servers, [], 'no managed servers yet');
assert.deepEqual(list.ui, { railEntry: true }, 'the list response carries the default ui preference');
assert.equal(list.external.length, 2, 'live and disabled mcp-client rows are both listed');
const externalByName = new Map(list.external.map((item) => [item.serverName, item]));
assert.equal(externalByName.get('web').enabled, false);
assert.equal(externalByName.get('web').toolCount, 0);
const [row] = list.external;
assert.deepEqual(
  {
    entryId: row.entryId,
    serverName: row.serverName,
    transport: row.transport,
    command: row.command,
    args: row.args,
    url: row.url,
    enabled: row.enabled,
    toolCount: row.toolCount,
  },
  {
    entryId: 'include:magpie-mcp-deepwiki',
    serverName: 'deepwiki',
    transport: 'stdio',
    command: '/nonexistent-mcp-binary',
    args: ['--flag'],
    url: undefined,
    enabled: true,
    toolCount: 2,
  },
);
assert.equal(JSON.stringify(list).includes('hidden'), false, 'env values never cross the wire');

// Take the entry over: the source must be disabled before the record exists.
const taken = await ok(TAKEOVER_PATH, { entryId: row.entryId });
assert.deepEqual(taken.ui, { railEntry: true }, 'the takeover response carries the ui preference');
assert.deepEqual(pluginCalls, [['include:magpie-mcp-deepwiki', false]]);
assert.equal(typeof taken.id, 'string');
assert.equal(taken.servers.length, 1);
assert.equal(taken.servers[0].name, 'deepwiki');
assert.equal(taken.servers[0].transport, 'stdio');
assert.equal(taken.servers[0].command, '/nonexistent-mcp-binary');
assert.deepEqual(taken.servers[0].args, ['--flag']);
assert.deepEqual(taken.servers[0].env, { TOKEN: 'hidden' }, 'the managed record owns the copied env');
assert.equal(Array.isArray(taken.warnings) && taken.warnings.length, 1, 'copying env is reported');
assert.equal(taken.external.length, 2, 'the disabled source stays listed as disabled');
assert.equal(taken.external.find((item) => item.serverName === 'deepwiki').enabled, false);

// The copied command does not exist, so the connection settles as an error.
const deadline = Date.now() + 5000;
let settled = taken.servers[0];
while (settled.status === 'connecting' && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 25));
  settled = (await ok(LIST_PATH, {})).servers[0];
}
assert.equal(settled.status, 'error');
assert.match(String(settled.error), /ENOENT|nonexistent/i);
assert.deepEqual(registeredTools, [], 'a failed connection registers no tools');

// A row whose name this page already manages is marked shadowed and cannot be
// switched on: that would collide with the managed connection.
const afterTakeover = await ok(LIST_PATH, {});
const shadowedRow = afterTakeover.external.find((item) => item.serverName === 'deepwiki');
assert.equal(shadowedRow.shadowed, true);
const blocked = await call(EXTERNAL_TOGGLE_PATH, { entryId: deepwiki.id, enabled: true });
assert.equal(blocked.payload.ok, false);
assert.equal(blocked.payload.error.code, 'invalid');
assert.equal(blocked.payload.error.field, 'enabled');

// A foreign row with no managed twin can be switched on and off without migrating.
// Foreign rows can be switched on and off without migrating them.
const enabledWeb = await ok(EXTERNAL_TOGGLE_PATH, { entryId: disabledRow.id, enabled: true });
assert.equal(enabledWeb.external.find((item) => item.serverName === 'web').enabled, true);
assert.deepEqual(pluginCalls[pluginCalls.length - 1], [disabledRow.id, true]);
const disabledAgain = await ok(EXTERNAL_TOGGLE_PATH, { entryId: disabledRow.id, enabled: false });
assert.equal(disabledAgain.external.find((item) => item.serverName === 'web').enabled, false);
const badToggle = await call(EXTERNAL_TOGGLE_PATH, { entryId: disabledRow.id });
assert.equal(badToggle.payload.ok, false);
assert.equal(badToggle.payload.error.code, 'invalid');
assert.equal(badToggle.payload.error.field, 'enabled');

// Migrating the same name again reuses the record: no duplicate-name failure.
const again = await call(TAKEOVER_PATH, { entryId: row.entryId });
assert.equal(again.payload.ok, true, JSON.stringify(again.payload));
assert.equal(again.payload.replaced, true);
assert.equal(again.payload.servers.length, 1, 'no duplicate record');
assert.equal(again.payload.servers[0].id, taken.id, 'the existing record is reused');
assert.deepEqual(pluginCalls.slice(0, 1), [['include:magpie-mcp-deepwiki', false]]);
assert.equal(pluginCalls.filter(([id]) => id === deepwiki.id).length, 1, 'an already-disabled source is not touched again');

// Unknown entries are a clean not-found and never disable anything.
const callsBefore = pluginCalls.length;
const { payload: missingPayload } = await call(TAKEOVER_PATH, { entryId: 'include:nope' });
assert.equal(missingPayload.ok, false);
assert.equal(missingPayload.error.code, 'not-found');
assert.equal(pluginCalls.length, callsBefore, 'a failed takeover never disables anything');

list = await ok(LIST_PATH, {});
assert.equal(list.servers.length, 1);
assert.equal(list.external.length, 2);

// The page preference is a plain persisted boolean; takeover never touches it.
const uiOff = await ok(UI_PATH, { railEntry: false });
assert.deepEqual(uiOff.ui, { railEntry: false });
assert.deepEqual((await ok(LIST_PATH, {})).ui, { railEntry: false }, 'the list carries the stored preference');
const { payload: badUi } = await call(UI_PATH, { railEntry: 'yes' });
assert.equal(badUi.ok, false);
assert.equal(badUi.error.code, 'invalid');
assert.deepEqual((await ok(LIST_PATH, {})).ui, { railEntry: false }, 'a rejected write leaves the preference untouched');

await rm(home, { recursive: true, force: true });
console.log(`external smoke: ${checks} checks passed, 0 failed`);
