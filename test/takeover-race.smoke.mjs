/**
 * Regression check for the migration race: disabling a `dsh-mcp-client` row
 * releases its tools asynchronously, so the takeover must wait for the old
 * namespace before connecting — otherwise the new connection collides on
 * `mcp__<server>__<tool>` names and lands in an error state.
 *
 * The fake registry simulates exactly that: it keeps the source's tool names
 * alive for a moment after the disable, and rejects any registration that
 * collides with a name still present.
 *
 * @module @local/dsh-mcp-manager/test/takeover-race.smoke
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const home = await mkdtemp(path.join(tmpdir(), 'dshmcp-race-'));
process.env.DSH_HOME = home;

const { apply } = await import('../index.js');
const { LIST_PATH, TAKEOVER_PATH } = await import('../host/routes.js');

/** The fake MCP server this test migrates. */
const fakeServerPath = path.join(here, 'fake-server.mjs');
/** Public tool names of `test/fake-server.mjs` under the server name `race`. */
const fakeToolNames = ['mcp__race__echo', 'mcp__race__explode', 'mcp__race__mix_content', 'mcp__race__bare'];

/** The source row being migrated. */
const source = {
  id: 'include:mcp-race',
  options: {
    id: 'mcp-race',
    name: '@deepseek-ai/dsh-mcp-client',
    config: {
      serverName: 'race',
      transport: 'stdio',
      command: process.execPath,
      args: [fakeServerPath],
    },
  },
  disabled: false,
};

const loader = {
  *entries() {
    yield source;
  },
};

/** Tool names still claimed by the source row while the registry settles. */
let live = [...fakeToolNames];
const registered = [];
let releasedBeforeRegistration = null;

const tools = {
  schemas: () => live.map((name) => ({ name })),
  register: (definition) => {
    if (live.includes(definition.name)) {
      throw new Error(`tool "${definition.name}" is already registered (for a per-agent variant, register through that agent's \`agent.ctx\` instead)`);
    }
    if (releasedBeforeRegistration === null) releasedBeforeRegistration = live.length === 0;
    registered.push(definition.name);
    return () => {
      const at = registered.indexOf(definition.name);
      if (at >= 0) registered.splice(at, 1);
    };
  },
};

/** Plugin manager stub: disables the row, then releases its tools 120 ms later. */
const pluginManager = {
  async setPluginEnabled(id, enabled) {
    assert.equal(id, source.id);
    source.disabled = !enabled;
    if (!enabled) {
      setTimeout(() => {
        live = [];
      }, 120);
    }
    return { stage: 'enable', target: id, enabled, changed: true, application: 'applied', warnings: [] };
  },
};

const routes = new Map();
const cleanups = [];
/** Event listeners the plugin registers (agent lifecycle). */
const listeners = new Map();

const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  tools,
  connection: {
    fetch: {
      register: (route) => {
        routes.set(route.path, route);
        return Promise.resolve(() => Promise.resolve());
      },
    },
  },
  effect: (callback) => {
    const disposer = callback();
    if (typeof disposer === 'function') cleanups.push(disposer);
    return () => {};
  },
  on(event, listener) {
    const list = listeners.get(event) ?? [];
    list.push(listener);
    listeners.set(event, list);
    return () => {
      const index = list.indexOf(listener);
      if (index >= 0) list.splice(index, 1);
    };
  },
  get: (name) => {
    if (name === 'loader') return loader;
    if (name === 'pluginManager') return pluginManager;
    return undefined;
  },
};

apply(ctx);
const fakeAgent = {
  id: 'agent-race',
  session: { id: 'session-race' },
  ctx: { tools, effect: (body) => body() },
};
for (const listener of [...(listeners.get('agent/created') ?? [])]) listener({ agent: fakeAgent });

const call = async (routePath, body) => {
  const route = routes.get(routePath);
  assert.ok(route, `${routePath} registered`);
  const response = await route.fetch(
    new Request(`http://127.0.0.1${routePath}`, { method: 'POST', body: JSON.stringify(body) }),
  );
  return response.json();
};

const taken = await call(TAKEOVER_PATH, { entryId: source.id });
assert.equal(taken.ok, true, JSON.stringify(taken));
assert.equal(taken.servers.length, 1);

// The connection settles as ready with every fake-server tool bridged.
const deadline = Date.now() + 5000;
let row = taken.servers[0];
while ((row.status === 'connecting' || row.status === 'stopped') && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 25));
  row = (await call(LIST_PATH, {})).servers[0];
}
assert.equal(row.status, 'ready', JSON.stringify(row.error));
assert.equal(row.toolCount, fakeToolNames.length);
assert.deepEqual([...registered].sort(), [...fakeToolNames].sort());

// The migration waited for the source namespace: the first registration only
// happened after the old tools were gone.
assert.equal(releasedBeforeRegistration, true, 'registered while the source still owned the names');

// Unload settles the child process and releases every tool.
for (const cleanup of cleanups.reverse()) {
  try {
    await cleanup();
  } catch {
    /* the fake context may hold non-async disposers */
  }
}
await new Promise((resolve) => setTimeout(resolve, 100));
assert.deepEqual(registered, [], 'unload released the tools');
await rm(home, { recursive: true, force: true });
console.log('takeover race smoke: 8 checks passed, 0 failed');
