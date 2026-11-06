import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rename, rm, readdir, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { createStore, validateServerInput } from '../host/store.js';
import { connect, createHttpTransport, createRpcConnection } from '../host/mcp.js';
import { createMcpManager } from '../host/manager.js';
import { createFetchRoutes } from '../host/routes.js';
import { createSessionState } from '../host/session-state.js';
import { repairPatchLayers } from '../host/patch-repair.js';
import { createExternalDefaults } from '../host/external-defaults.js';
import { apply } from '../index.js';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await predicate()) return; await pause(10); }
  assert.fail('condition did not settle');
}
async function temporary(t) {
  const dir = await mkdtemp(path.join(import.meta.dirname, '.regression-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const record = (name) => ({ id: name, name, transport: 'stdio', command: 'node', args: [], env: {}, enabled: false, createdAt: 1 });
async function http(t, handler) {
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    try { await handler(req, res, raw ? JSON.parse(raw) : undefined); }
    catch (error) { res.writeHead(500); res.end(error.message); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}/mcp`;
}
function reply(res, id, result) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
}

test('failed writes leave memory, UI and subsequent snapshots unchanged', async (t) => {
  const dir = await temporary(t), file = path.join(dir, 'config.json');
  const store = createStore({ file });
  await store.setServers([record('before')]);
  await rename(file, file + '.old'); await mkdir(file);
  await assert.rejects(store.setServers([record('failed')]));
  await assert.rejects(store.setUi({ railEntry: false }));
  assert.deepEqual(store.list(), [record('before')]);
  assert.deepEqual(store.ui(), { railEntry: true });
  await rm(file, { recursive: true }); await rename(file + '.old', file);
  await store.setUi({ railEntry: false });
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).servers, [record('before')]);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test('damaged and future-version documents are locked until explicit recovery', async (t) => {
  const dir = await temporary(t), file = path.join(dir, 'config.json');
  const store = createStore({ file });
  await store.setServers([record('saved')]); await store.setUi({ railEntry: false });
  const corrupt = '{ damaged'; await writeFile(file, corrupt);
  const broken = createStore({ file }); await broken.load();
  assert.equal(broken.status().readOnly, true); assert.equal(broken.status().hasBackup, true);
  await assert.rejects(broken.setServers([]), { code: 'storage-readonly' });
  assert.equal(await readFile(file, 'utf8'), corrupt);
  const restored = await broken.recover('backup');
  assert.equal(await readFile(restored.archive, 'utf8'), corrupt);
  assert.equal(broken.list()[0].name, 'saved'); assert.equal(broken.status().readOnly, false);
  const future = JSON.stringify({ version: 99, servers: [] }); await writeFile(file, future);
  const newer = createStore({ file }); await newer.load();
  await assert.rejects(newer.setUi({ railEntry: false }), { code: 'storage-readonly' });
  const reset = await newer.recover('reset');
  assert.equal(await readFile(reset.archive, 'utf8'), future); assert.deepEqual(newer.list(), []);
});

test('legacy documents migrate and duplicate persisted ids do not silently collapse', async (t) => {
  const dir = await temporary(t), file = path.join(dir, 'config.json');
  await writeFile(file, JSON.stringify({ servers: [record('legacy')] }));
  const store = createStore({ file }); await store.load(); await store.setUi({ railEntry: false });
  assert.equal(JSON.parse(await readFile(file, 'utf8')).version, 1);
  await writeFile(file, JSON.stringify({ version: 1, servers: [record('same'), record('same')] }));
  const duplicate = createStore({ file }); await duplicate.load();
  assert.equal(duplicate.status().readOnly, false);
  assert.equal(duplicate.status().skippedRecords, 1);
  assert.deepEqual(duplicate.list(), [record('same')]);
});

test('HTTP uses the JSON-negotiated version without a response version header', async (t) => {
  let initialized = false;
  const url = await http(t, (req, res, body) => {
    if (body.method === 'initialize') return reply(res, body.id, { protocolVersion: '2025-06-18', capabilities: { tools: {} } });
    assert.equal(req.headers['mcp-protocol-version'], '2025-06-18');
    if (body.method === 'notifications/initialized') { initialized = true; res.writeHead(202); return res.end(); }
    reply(res, body.id, { tools: [] });
  });
  const connection = await connect({ name: 'strict', transport: 'http', url });
  assert.equal(initialized, true); await connection.close();
});

test('unsupported negotiated versions are rejected before initialized', async (t) => {
  const methods = [];
  const url = await http(t, (_req, res, body) => { methods.push(body.method); reply(res, body.id, { protocolVersion: '9999-01-01' }); });
  await assert.rejects(connect({ name: 'future', transport: 'http', url }), /unsupported MCP protocol version/);
  assert.deepEqual(methods, ['initialize']);
});

test('request timeout and abort cancel HTTP work without closing healthy RPC', async (t) => {
  const active = new Set(), canceled = [];
  const url = await http(t, (_req, res, body) => {
    if (body.method === 'notifications/cancelled') { canceled.push(body.params.requestId); res.writeHead(202); return res.end(); }
    if (body.method === 'ping') return reply(res, body.id, {});
    active.add(res); res.on('close', () => active.delete(res));
  });
  const rpc = createRpcConnection(createHttpTransport({ url }), { requestTimeoutMs: 100 });
  t.after(() => rpc.close());
  await assert.rejects(rpc.request('hang', {}), /timed out/);
  await until(() => active.size === 0 && canceled.length === 1);
  const controller = new AbortController();
  const work = rpc.request('hang', {}, { signal: controller.signal });
  const rejected = assert.rejects(work, /canceled/);
  await until(() => active.size === 1); controller.abort(); await rejected;
  await until(() => active.size === 0 && canceled.length === 2);
  assert.deepEqual(await rpc.request('ping', {}), {}); assert.equal(rpc.closed, false);
});

test('HTTP failures release other in-flight requests and terminate session once', async (t) => {
  const active = new Set(); let deletes = 0;
  const url = await http(t, (req, res, body) => {
    if (req.method === 'DELETE') { deletes++; res.writeHead(204); return res.end(); }
    if (body.method === 'start') { res.setHeader('mcp-session-id', 'session'); return reply(res, body.id, {}); }
    if (body.method === 'fail') { res.writeHead(500); return res.end('failed'); }
    active.add(res); res.on('close', () => active.delete(res));
  });
  const rpc = createRpcConnection(createHttpTransport({ url }));
  await rpc.request('start', {});
  const hanging = assert.rejects(rpc.request('hang', {}), /500/);
  await until(() => active.size === 1);
  await assert.rejects(rpc.request('fail', {}), /500/); await hanging;
  await Promise.all([rpc.close(), rpc.close()]);
  await until(() => active.size === 0); assert.equal(deletes, 1);
});

test('server-initiated requests never resolve a pending client request with the same id', async () => {
  let receive; const sent = [];
  const transport = { stderrTail: () => '', setMessageHandler(fn) { receive = fn; }, setCloseHandler() {}, close() {}, send(message) { sent.push(message); } };
  const rpc = createRpcConnection(transport);
  const pending = rpc.request('tools/list', {}); await pause(0);
  receive({ jsonrpc: '2.0', id: 1, method: 'ping' }); await pause(0);
  assert.ok(sent.some((item) => item.id === 1 && 'result' in item));
  receive({ jsonrpc: '2.0', id: 1, result: { tools: [] } });
  assert.deepEqual(await pending, { tools: [] }); await rpc.close();
});

async function managerFixture(t, { rejectDefinition } = {}) {
  const dir = await temporary(t), previous = process.env.DSH_HOME;
  process.env.DSH_HOME = dir;
  const tools = new Map();
  const registry = {
    register(definition) { rejectDefinition?.(definition); if (tools.has(definition.name)) throw new Error('duplicate tool'); tools.set(definition.name, definition); return () => tools.delete(definition.name); },
    schemas: () => [...tools.values()],
  };
  const manager = createMcpManager({ ctx: { tools: registry } });
  t.after(async () => { await manager.dispose(); if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous; });
  await manager.boot();
  // Tools are agent-scoped now: attach one Session so its Agent owns them.
  manager.attachAgent({ id: 'agent-test', session: { id: 'session-test' }, ctx: { tools: registry, effect: (body) => body() } });
  return { manager, tools, dir };
}

test('batch import is atomic, imports disabled, exports omit credentials by default', async (t) => {
  const { manager } = await managerFixture(t);
  const routes = createFetchRoutes(manager);
  const call = async (action, body) => (await routes.find((route) => route.path.endsWith('.' + action)).fetch(new Request('http://localhost/', { method: 'POST', body: JSON.stringify(body) }))).json();
  const imported = await call('import', { document: { mcpServers: { alpha: { command: 'node', env: { TOKEN: 'private' } } } } });
  assert.equal(imported.ok, true); assert.equal(imported.servers[0].enabled, false);
  const bad = await call('import', { document: [record('beta'), record('alpha')] });
  assert.equal(bad.error.code, 'duplicate-name'); assert.equal(manager.list().length, 1);
  const safe = await call('export', {}); assert.equal(Object.hasOwn(safe.document.servers[0], 'env'), false);
  assert.equal(Object.hasOwn(safe.document.servers[0], 'headers'), false);
  const full = await call('export', { includeSecrets: true }); assert.equal(full.document.servers[0].env.TOKEN, 'private');
});

test('tool switches persist, preserve public names, and activity avoids tool arguments', async (t) => {
  const { manager, tools } = await managerFixture(t);
  const saved = await manager.save({ server: { name: 'fake', transport: 'stdio', command: process.execPath, args: [path.join(import.meta.dirname, 'fake-server.mjs')] } });
  await until(() => manager.list()[0].status === 'ready');
  const before = manager.list()[0]; assert.equal(before.tools.find((tool) => tool.name === 'mix.content').publicName, 'mcp__fake__mix_content');
  await tools.get('mcp__fake__echo').execute({ text: 'sensitive-input' });
  assert.equal(JSON.stringify(manager.list()[0].logs).includes('sensitive-input'), false);
  await manager.setToolEnabled({ id: saved.id, name: 'echo', enabled: false });
  assert.equal(tools.has('mcp__fake__echo'), false); assert.equal(manager.list()[0].toolCount, 3);
  await manager.reconnect({ id: saved.id }); await until(() => manager.list()[0].status === 'ready');
  assert.equal(tools.has('mcp__fake__echo'), false);
  await manager.setToolEnabled({ id: saved.id, name: 'echo', enabled: true }); assert.equal(tools.has('mcp__fake__echo'), true);
});

test('HTTP tool list notifications refresh registrations while retaining disabled tools', async (t) => {
  const { manager, tools } = await managerFixture(t);
  let stream, generation = 0;
  const url = await http(t, (req, res, body) => {
    if (req.method === 'GET') { stream = res; res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': ready\n\n'); return; }
    if (body.method === 'initialize') return reply(res, body.id, { protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: true } } });
    if (body.method === 'notifications/initialized') { res.writeHead(202); return res.end(); }
    if (body.method === 'tools/list') return reply(res, body.id, { tools: [{ name: 'echo' }, ...(generation ? [{ name: 'new' }] : [])] });
  });
  const { id } = await manager.save({ server: { name: 'dynamic', transport: 'http', url } });
  await until(() => manager.list()[0].status === 'ready' && stream);
  await manager.setToolEnabled({ id, name: 'echo', enabled: false });
  generation++;
  stream.write('data: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n\n');
  await until(() => tools.has('mcp__dynamic__new'));
  assert.equal(tools.has('mcp__dynamic__echo'), false); assert.equal(manager.list()[0].tools.length, 2);
});

test('automatic retries stop at the configured limit and disabling clears timers', async (t) => {
  const { manager } = await managerFixture(t);
  const saved = await manager.save({ server: { name: 'missing', transport: 'stdio', command: '/nonexistent-mcp-review', retryCount: 1 } });
  await until(() => manager.list()[0].nextRetryAt);
  await until(() => manager.list()[0].retryAttempt === 1 && !manager.list()[0].nextRetryAt && manager.list()[0].status === 'error');
  assert.equal(manager.list()[0].logs.filter((entry) => entry.message === 'Connecting').length, 2);
  await manager.reconnect({ id: saved.id }); await until(() => manager.list()[0].nextRetryAt);
  await manager.toggle({ id: saved.id, enabled: false });
  assert.equal(manager.list()[0].nextRetryAt, undefined);
  await pause(1100); assert.equal(manager.list()[0].status, 'stopped');
});

test('connection options reject invalid limits', () => {
  for (const settings of [{ retryCount: -1 }, { retryCount: 11 }, { requestTimeoutMs: 0 }, { initializeTimeoutMs: 300001 }]) {
    assert.throws(() => validateServerInput({ name: 'test', transport: 'stdio', command: 'node', ...settings }), { code: 'invalid' });
  }
});

test('invalid records are skipped and original bytes are archived before a later write', async (t) => {
  const dir = await temporary(t), file = path.join(dir, 'config.json');
  const original = JSON.stringify({ version: 1, servers: [record('first'), { id: 'invalid' }, record('last'), record('first')] });
  await writeFile(file, original);
  const warnings = [];
  const store = createStore({ file, logger: { warn: (message) => warnings.push(message) } });
  assert.deepEqual(await store.load(), [record('first'), record('last')]);
  assert.equal(store.status().readOnly, false); assert.equal(store.status().skippedRecords, 2);
  assert.ok(warnings.length >= 2);
  await store.setUi({ railEntry: false });
  const archives = (await readdir(dir)).filter((name) => name.includes('.recovery-'));
  assert.equal(archives.length, 1);
  assert.equal(await readFile(path.join(dir, archives[0]), 'utf8'), original);
  assert.equal(store.status().skippedRecords, undefined);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).servers, [record('first'), record('last')]);
});

test('unknown raw tool names are rejected before changing the persisted configuration', async (t) => {
  const { manager, dir } = await managerFixture(t);
  const { id } = await manager.save({ server: { name: 'validated', transport: 'stdio', command: process.execPath, args: [path.join(import.meta.dirname, 'fake-server.mjs')] } });
  await until(() => manager.list()[0].status === 'ready');
  const file = path.join(dir, 'storages/mcp-manager.json'), before = await readFile(file, 'utf8');
  const route = createFetchRoutes(manager).find((item) => item.path.endsWith('.tool'));
  const response = await route.fetch(new Request('http://localhost/', { method: 'POST', body: JSON.stringify({ id, name: 'echho', enabled: false }) }));
  const result = await response.json();
  assert.equal(result.error.code, 'not-found'); assert.equal(result.error.field, 'name');
  assert.equal(await readFile(file, 'utf8'), before);
  await manager.setToolEnabled({ id, name: 'echo', enabled: false });
  assert.deepEqual(manager.list()[0].disabledTools, ['echo']);
});

test('session overrides hide MCP tools from one agent and persist', async (t) => {
  const { manager, tools, dir } = await managerFixture(t);
  const saved = await manager.save({ server: { name: 'fs', transport: 'stdio', command: process.execPath, args: [path.join(import.meta.dirname, 'fake-server.mjs')] } });
  await until(() => manager.list()[0]?.status === 'ready');
  assert.ok(tools.size > 0, 'tools are registered for the attached agent');

  const hidden = await manager.setSessionEnabled({ sessionId: 'session-test', serverId: saved.id, enabled: false });
  assert.equal(hidden.servers[0].visible, false);
  assert.equal(tools.size, 0, 'hiding a server releases its tools on that agent');
  assert.equal(manager.list()[0].enabled, true, 'the global configuration is untouched');

  const shown = await manager.setSessionEnabled({ sessionId: 'session-test', serverId: saved.id, enabled: true });
  assert.equal(shown.servers[0].visible, true);
  assert.ok(tools.size > 0, 'enabling restores the tools');

  const document = JSON.parse(await readFile(path.join(dir, 'storages', 'mcp-manager-sessions.json'), 'utf8'));
  assert.equal(document.sessions['session-test'].overrides[saved.id], true, 'the override is persisted');
});

test('/mcp command toggles one session and reports the list', async (t) => {
  const { manager, tools } = await managerFixture(t);
  await manager.save({ server: { name: 'fs', transport: 'stdio', command: process.execPath, args: [path.join(import.meta.dirname, 'fake-server.mjs')] } });
  await until(() => manager.list()[0]?.status === 'ready');
  const agent = { session: { id: 'session-test' } };
  const off = await manager.runCommand(agent, 'off fs');
  assert.equal(off.kind, 'success');
  assert.equal(tools.size, 0, 'the argument form hides the tools');
  const listed = await manager.runCommand(agent, 'list');
  assert.match(listed.text, /fs/);
  const reset = await manager.runCommand(agent, 'reset');
  assert.equal(reset.kind, 'success');
  assert.ok(tools.size > 0, 'reset follows the global configuration again');
});

test('session/default write failures never commit candidates or leak into later writes', async (t) => {
  const dir = await temporary(t), file = path.join(dir, 'sessions.json');
  const store = createSessionState({ file });
  await store.set('a', 'managed', false);
  await store.setExternal('a', 'external', false);
  const before = store.snapshot();
  await rename(file, file + '.old'); await mkdir(file);
  for (const change of [
    () => store.set('a', 'managed', true),
    () => store.set('a', 'managed', null),
    () => store.setExternal('a', 'external', true),
    () => store.setExternal('a', 'external', null),
    () => store.clearSession('a'),
    () => store.prune([]),
  ]) {
    await assert.rejects(change());
    assert.deepEqual(store.snapshot(), before);
  }
  await rm(file, { recursive: true }); await rename(file + '.old', file);
  await Promise.all([store.set('b', 'other', true), store.setExternal('b', 'foreign', false)]);
  const persisted = JSON.parse(await readFile(file, 'utf8')).sessions;
  assert.deepEqual(persisted.a, before.a);
  assert.deepEqual(persisted.b.overrides, { other: true });
  assert.deepEqual(persisted.b.external, { foreign: false });
  // Pruning must compute its candidate after earlier queued mutations commit.
  await Promise.all([store.set('stale', 'other', false), store.prune(['a', 'b'])]);
  assert.equal(store.snapshot().stale, undefined);

  const defaultsFile = path.join(dir, 'defaults.json');
  const defaults = createExternalDefaults({ file: defaultsFile });
  await defaults.set('hidden', false);
  await rename(defaultsFile, defaultsFile + '.old'); await mkdir(defaultsFile);
  await assert.rejects(defaults.set('hidden', true));
  await assert.rejects(defaults.set('failed', false));
  assert.equal(defaults.autoInjectOf('hidden'), false);
  assert.equal(defaults.autoInjectOf('failed'), true);
  await rm(defaultsFile, { recursive: true }); await rename(defaultsFile + '.old', defaultsFile);
  await defaults.set('later', false);
  assert.deepEqual(JSON.parse(await readFile(defaultsFile, 'utf8')).entries, { hidden: false, later: false });
});

async function externalFixture(t) {
  const dir = await temporary(t), previous = process.env.DSH_HOME;
  process.env.DSH_HOME = dir;
  const listeners = new Map(), routes = new Map(), commands = new Map(), effects = [];
  const catalog = new Map();
  const rows = [{ id: 'foreign', options: { name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'foreign' } } }];
  const emit = (event, payload) => { for (const fn of [...(listeners.get(event) ?? [])]) fn(payload); };
  const ctx = {
    tools: { schemas: () => [...catalog.values()] },
    logger: { warn() {}, error() {} },
    get(name) {
      if (name === 'loader') return { entries: () => rows };
      if (name === 'commands') return { register(command) { commands.set(command.name, command); return () => commands.delete(command.name); } };
    },
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
      return () => listeners.get(event).delete(fn);
    },
    effect(body) { effects.push(body()); },
    connection: { fetch: { register(route) { routes.set(route.path, route); return Promise.resolve(() => routes.delete(route.path)); } } },
  };
  apply(ctx);
  async function dispose() {
    for (const effect of effects.splice(0).reverse()) await effect();
  }
  t.after(async () => {
    await dispose();
    if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous;
  });
  const call = async (action, body = {}) => {
    const response = await routes.get('/api/mcp-manager.' + action).fetch(new Request('http://localhost/', { method: 'POST', body: JSON.stringify(body) }));
    const payload = await response.json();
    assert.equal(payload.ok, true, JSON.stringify(payload));
    return payload;
  };
  await call('list');
  function attach(sessionId) {
    const masks = new Set(), local = new Map();
    const schemas = (scope) => [...catalog.values(), ...local.values()]
      .filter((tool) => scope === undefined || local.has(tool.name) || ![...masks].some((mask) => mask.includes(tool.name)));
    const tools = {
      schemas,
      restrict({ deny }) {
        assert.ok(deny.every((name) => catalog.has(name)));
        masks.add(deny); emit('tools/change');
        return () => { masks.delete(deny); emit('tools/change'); };
      },
      register(definition) {
        assert.equal(local.has(definition.name), false);
        local.set(definition.name, definition); emit('tools/change');
        return () => { local.delete(definition.name); emit('tools/change'); };
      },
    };
    const agent = { id: sessionId, session: { id: sessionId }, ctx: { tools, effect() {} } };
    emit('agent/created', { agent });
    return { agent, masks, visible: () => schemas(agent).map((item) => item.name) };
  }
  const addTool = (name) => { catalog.set(name, { name }); emit('tools/change'); };
  return { call, attach, addTool, catalog, emit, listeners, dispose, command: (agent, rawInput) => commands.get('mcp').handler({ agent, rawInput }) };
}

test('external masks survive repeated sync, late tools and catalog replacement, with lifecycle cleanup', async (t) => {
  const f = await externalFixture(t), a = f.attach('a'), b = f.attach('b');
  assert.equal(f.listeners.get('tools/change').size, 1);
  await f.call('session-set', { sessionId: 'a', entryId: 'foreign', enabled: false });
  f.addTool('mcp__foreign__one');
  assert.deepEqual(a.visible(), []);
  assert.deepEqual(b.visible(), ['mcp__foreign__one']);
  for (let i = 0; i < 3; i++) f.emit('tools/change');
  assert.deepEqual(a.visible(), []);
  f.addTool('mcp__foreign__two');
  assert.deepEqual(a.visible(), []);
  assert.equal(a.masks.size, 1);
  f.catalog.delete('mcp__foreign__one'); f.emit('tools/change');
  assert.deepEqual([...a.masks][0], ['mcp__foreign__two']);
  f.emit('agent/disposed', { agent: a.agent });
  assert.equal(a.masks.size, 0);
  await f.dispose();
  assert.equal(f.listeners.get('tools/change').size, 0);
  assert.equal(b.masks.size, 0);
});

test('managed namespace ownership releases the old external mask', async (t) => {
  const f = await externalFixture(t), a = f.attach('a');
  f.addTool('mcp__foreign__one');
  await f.call('session-set', { sessionId: 'a', entryId: 'foreign', enabled: false });
  assert.equal(a.masks.size, 1);
  await f.call('save', { server: { name: 'foreign', transport: 'stdio', command: process.execPath, args: [path.join(import.meta.dirname, 'fake-server.mjs')], enabled: true } });
  await until(() => a.visible().includes('mcp__foreign__echo'));
  assert.equal(a.masks.size, 0);
  f.emit('tools/change');
  assert.equal(a.masks.size, 0);
});

test('command and panel reset clear managed and external overrides only for the selected session', async (t) => {
  const f = await externalFixture(t), a = f.attach('a'), b = f.attach('b');
  f.addTool('mcp__foreign__one');
  const saved = await f.call('save', { server: { name: 'managed', transport: 'stdio', command: 'node', enabled: false } });
  await f.call('session-set', { sessionId: 'b', entryId: 'foreign', enabled: false });
  for (const reset of [() => f.command(a.agent, 'reset'), () => f.call('session-set', { sessionId: 'a', reset: true })]) {
    await f.command(a.agent, 'off foreign');
    await f.call('session-set', { sessionId: 'a', serverId: saved.id, enabled: false });
    assert.deepEqual(a.visible(), []);
    await reset();
    const view = await f.call('session', { sessionId: 'a' });
    assert.deepEqual(view.overrides, {});
    assert.deepEqual(a.visible(), ['mcp__foreign__one']);
    assert.deepEqual(b.visible(), []);
  }
  await f.call('external-default', { entryId: 'foreign', autoInject: false });
  await f.command(a.agent, 'on foreign');
  assert.equal(a.visible().length, 1);
  await f.command(a.agent, 'reset');
  assert.deepEqual(a.visible(), []);
});

test('same-name schema refresh works on demand and a failed replacement restores executable definitions', async (t) => {
  const { manager, tools } = await managerFixture(t, {
    rejectDefinition(definition) { if (definition.name.endsWith('__invalid')) throw new Error('unsupported schema'); },
  });
  let stream, generation = 0;
  const url = await http(t, (req, res, body) => {
    if (req.method === 'GET') { stream = res; res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': ready\n\n'); return; }
    if (body.method === 'initialize') return reply(res, body.id, { protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: true } } });
    if (body.method === 'notifications/initialized') { res.writeHead(202); return res.end(); }
    if (body.method === 'tools/list') return reply(res, body.id, { tools: [
      { name: 'echo', description: `v${generation}`, inputSchema: { type: 'object', properties: { text: { type: generation === 0 ? 'string' : 'number' } } } },
      { name: 'stable' },
      ...(generation === 2 ? [{ name: 'partial' }, { name: 'invalid' }] : []),
    ] });
    if (body.method === 'tools/call') return reply(res, body.id, { content: [{ type: 'text', text: 'still works' }] });
  });
  await manager.save({ server: { name: 'dynamic', transport: 'http', url, enabled: false } });
  await manager.runCommand({ session: { id: 'session-test' } }, 'on dynamic');
  await until(() => manager.list()[0].status === 'ready' && stream);
  const name = 'mcp__dynamic__echo';
  assert.equal(tools.get(name).description, 'v0');
  const refresh = () => stream.write('data: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n\n');
  generation = 1; refresh();
  await until(() => tools.get(name)?.description === 'v1');
  assert.equal(tools.get(name).parameters.properties.text.type, 'number');
  const previous = new Map(tools);
  generation = 2; refresh();
  await until(() => manager.list()[0].tools[0].description === 'v2');
  assert.deepEqual(tools, previous, 'all previous definitions and call closures are restored');
  assert.equal(tools.has('mcp__dynamic__partial'), false, 'partial new registrations are released');
  assert.equal((await tools.get(name).execute({ text: 1 })).content[0].text, 'still works');
  generation = 3; refresh();
  await until(() => tools.get(name)?.description === 'v3');
  assert.equal(manager.list()[0].enabled, false);
});

test('saving cwd and timeout edits reconnects; default injection edits update attached agents', async (t) => {
  const { manager, tools, dir } = await managerFixture(t);
  const { id } = await manager.save({ server: { name: 'saved', transport: 'stdio', command: process.execPath, args: [path.join(import.meta.dirname, 'fake-server.mjs')] } });
  await until(() => manager.list()[0].status === 'ready');
  for (const edit of [{ cwd: dir }, { requestTimeoutMs: 2345 }, { initializeTimeoutMs: 3456 }]) {
    const count = manager.list()[0].logs.filter((log) => log.message === 'Connecting').length;
    await manager.save({ id, server: { ...manager.list()[0], ...edit } });
    await until(() => manager.list()[0].status === 'ready');
    assert.equal(manager.list()[0].logs.filter((log) => log.message === 'Connecting').length, count + 1);
    assert.ok(tools.size > 0);
  }
  await manager.save({ id, server: { ...manager.list()[0], autoInject: false } });
  assert.equal(tools.size, 0);
  assert.equal(manager.sessionView('session-test').servers[0].visible, false);
  await manager.save({ id, server: { ...manager.list()[0], autoInject: true } });
  await until(() => manager.list()[0].status === 'ready');
  const count = manager.list()[0].logs.filter((log) => log.message === 'Connecting').length;
  await manager.save({ id, server: { ...manager.list()[0], description: 'metadata only' } });
  assert.equal(manager.list()[0].logs.filter((log) => log.message === 'Connecting').length, count);
});

test('a per-session override connects a default-off server on demand', async (t) => {
  const { manager, tools } = await managerFixture(t);
  const url = await http(t, (req, res, body) => {
    if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
    if (body.method === 'initialize') {
      return reply(res, body.id, { protocolVersion: '2025-06-18', capabilities: { tools: {} } });
    }
    if (body.method === 'notifications/initialized') { res.writeHead(202); return res.end(); }
    if (body.method === 'tools/list') return reply(res, body.id, { tools: [{ name: 'lazy-tool' }] });
    return reply(res, body.id, { content: [] });
  });
  await manager.save({ server: { name: 'lazy', transport: 'http', url, autoInject: false } });
  await until(() => manager.list()[0].status === 'stopped');
  assert.equal(tools.size, 0, 'a default-off server never connects on its own');

  const on = await manager.runCommand({ session: { id: 'session-test' } }, 'on lazy');
  assert.equal(on.kind, 'success');
  await until(() => manager.list()[0].status === 'ready');
  await until(() => tools.has('mcp__lazy__lazy-tool'));
  assert.equal(manager.sessionView('session-test').servers[0].visible, true);

  await manager.runCommand({ session: { id: 'session-test' } }, 'off lazy');
  await until(() => !tools.has('mcp__lazy__lazy-tool'));
  await until(() => manager.list()[0].status === 'stopped');
});

const unrelatedAgent = (id) => ({ id, session: { id }, ctx: { tools: { register: () => () => {} }, effect() {} } });

test('unrelated sessions and visibility changes do not interrupt an unchanged handshake', async (t) => {
  const { manager, tools } = await managerFixture(t);
  let initializes = 0, initialized;
  const url = await http(t, (req, res, body) => {
    if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
    if (body.method === 'initialize') {
      initializes++;
      initialized = () => reply(res, body.id, { protocolVersion: '2025-06-18', capabilities: { tools: {} } });
      return;
    }
    if (body.method === 'notifications/initialized') { res.writeHead(202); return res.end(); }
    if (body.method === 'tools/list') return reply(res, body.id, { tools: [{ name: 'echo' }] });
  });
  const { id } = await manager.save({ server: { name: 'slow', transport: 'http', url } });
  await until(() => initializes === 1);
  for (let i = 0; i < 3; i++) {
    const agent = unrelatedAgent(`unrelated-${i}`);
    manager.attachAgent(agent); manager.detachAgent(agent);
    await manager.setSessionEnabled({ sessionId: 'session-test', serverId: id, enabled: i % 2 === 0 });
  }
  await pause(50);
  assert.equal(initializes, 1);
  assert.equal(manager.list()[0].logs.filter((log) => log.message === 'Connecting').length, 1);
  initialized();
  await until(() => manager.list()[0].status === 'ready');
  assert.equal(tools.has('mcp__slow__echo'), true);
});

test('on-demand retries preserve backoff and exhausted budgets across unrelated session activity', async (t) => {
  const { manager } = await managerFixture(t);
  await manager.save({ server: { name: 'missing', transport: 'stdio', command: '/nonexistent-mcp-review', retryCount: 1, enabled: false } });
  const owner = { session: { id: 'session-test' } }, other = unrelatedAgent('unrelated');
  await manager.runCommand(owner, 'on missing');
  await until(() => manager.list()[0].nextRetryAt);
  const deadline = manager.list()[0].nextRetryAt;
  manager.attachAgent(other); manager.detachAgent(other);
  assert.equal(manager.list()[0].nextRetryAt, deadline);
  assert.equal(manager.list()[0].retryAttempt, 1);
  await until(() => manager.list()[0].status === 'error' && !manager.list()[0].nextRetryAt);
  assert.equal(manager.list()[0].logs.filter((log) => log.message === 'Connecting').length, 2);
  manager.attachAgent(other); manager.detachAgent(other);
  await pause(30);
  assert.equal(manager.list()[0].status, 'error');
  assert.equal(manager.list()[0].logs.filter((log) => log.message === 'Connecting').length, 2);
  await manager.runCommand(owner, 'off missing');
  assert.equal(manager.list()[0].status, 'stopped');
});

test('a cross-layer duplicate is moved into the profile layer and stays disabled', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mcp-repair-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const homePatch = path.join(dir, 'home.yml');
  const profilePatch = path.join(dir, 'profile.yml');
  await writeFile(homePatch, '[ { insert: [ { id: rea-mcp, name: "@deepseek-ai/dsh-mcp-client", config: { serverName: rea } } ] } ]\n');
  await writeFile(profilePatch, '- id: locale\n  config:\n    preference: zh\n- id: rea-mcp\n  disabled: true\n');

  const report = await repairPatchLayers({ homePatch, profilePatch });
  assert.deepEqual(report.moved, ['rea-mcp']);
  assert.match(await readFile(homePatch, 'utf8'), /insert: \[\]/);

  const profile = await readFile(profilePatch, 'utf8');
  assert.ok(profile.indexOf('insert:') < profile.indexOf('- id: rea-mcp'), 'the insert must precede the override');
  assert.equal(profile.match(/^\s*-\s+id: rea-mcp$/gm).length, 1, 'exactly one declaration survives');

  const again = await repairPatchLayers({ homePatch, profilePatch });
  assert.deepEqual(again.moved, [], 'repair is idempotent');
});
