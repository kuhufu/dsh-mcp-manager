import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rename, rm, readdir, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { createStore, validateServerInput } from '../host/store.js';
import { connect, createHttpTransport, createRpcConnection } from '../host/mcp.js';
import { createMcpManager } from '../host/manager.js';
import { createFetchRoutes } from '../host/routes.js';

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

async function managerFixture(t) {
  const dir = await temporary(t), previous = process.env.DSH_HOME;
  process.env.DSH_HOME = dir;
  const tools = new Map();
  const manager = createMcpManager({ ctx: { tools: {
    register(definition) { if (tools.has(definition.name)) throw new Error('duplicate tool'); tools.set(definition.name, definition); return () => tools.delete(definition.name); },
    schemas: () => [...tools.values()],
  } } });
  t.after(async () => { await manager.dispose(); if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous; });
  await manager.boot(); return { manager, tools, dir };
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
