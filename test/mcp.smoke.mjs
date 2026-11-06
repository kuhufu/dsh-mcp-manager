#!/usr/bin/env node
/**
 * Smoke test for the Host half of `@kuhufu/dsh-mcp-manager`.
 *
 * Runs with plain Node (no test framework, no dependencies) and exercises:
 *
 * 1. tool-name / content-flattening helpers,
 * 2. the stdio MCP client against `fake-server.mjs` (handshake, paginated
 *    `tools/list`, `tools/call`, an `isError` call, non-text content, clean and
 *    idempotent shutdown, environment scrubbing),
 * 3. the JSON store (atomic write, serialized concurrent writes, tolerant reads,
 *    validation rules),
 * 4. the Fetch routes in isolation (paths, status codes, no-store policy,
 *    failure shape, the `ui` preference echo),
 * 5. the real `index.js` plugin against a minimal fake Cordis context: routes
 *    registered, save → connect → tools on `ctx.tools` → execute, duplicate and
 *    invalid input, failed connection keeps the record, toggle, rename restart,
 *    reconnect, remove, and unload that kills every child.
 *
 * Usage (from the workspace root): `node mcp-manager/test/mcp.smoke.mjs`
 * Set `KEEP_TMP=1` to keep the temporary directory for debugging.
 */

import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildToolDefinitions,
  connect,
  flattenContent,
  publicToolNames,
  sanitizePublicName,
} from '../host/mcp.js';
import {
  ROUTE_PATHS,
  EXTERNAL_TOGGLE_PATH,
  LIST_PATH,
  RECONNECT_PATH,
  REMOVE_PATH,
  SAVE_PATH,
  TAKEOVER_PATH,
  TOGGLE_PATH,
  UI_PATH,
  createFetchRoutes,
} from '../host/routes.js';
import {
  ManagerError,
  createStore,
  resolveDshHome,
  resolveStoragePath,
  validateServerInput,
} from '../host/store.js';
import { apply } from '../index.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const fakeServerPath = path.join(testDir, 'fake-server.mjs');
const runDir = path.join(testDir, '.tmp');
const storeHome = path.join(runDir, 'store-home');
const pluginHome = path.join(runDir, 'plugin-home');
const reportFile = path.join(runDir, 'children.jsonl');

let passed = 0;
/** @type {{ name: string, error: unknown }[]} */
const failures = [];

/** Run one named check, recording failures instead of aborting the suite. */
async function test(name, body) {
  try {
    await body();
    passed += 1;
    console.log(`ok ${passed} - ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.error(`not ok - ${name}`);
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  }
}

/** Sleep for a fixed number of milliseconds. */
function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Poll a predicate until it returns a truthy value.
 * @returns the truthy value, or undefined after the timeout.
 */
async function waitFor(predicate, timeoutMs = 10_000, intervalMs = 40) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() >= deadline) return undefined;
    await delay(intervalMs);
  }
}

/** Whether a process id is still signalable. */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/** Build a POST request with a JSON body for a Fetch route. */
function jsonRequest(body) {
  return new Request('http://localhost/api/mcp-manager', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** The stdio server record the smoke test connects to. */
function fakeServerRecord(overrides = {}) {
  return {
    name: 'fake',
    transport: 'stdio',
    command: process.execPath,
    args: [fakeServerPath],
    env: { FAKE_SERVER_REPORT: reportFile, FAKE_SERVER_EXPLICIT: 'present' },
    ...overrides,
  };
}

/** Read every child report line written by `fake-server.mjs`. */
async function readReports() {
  let raw;
  try {
    raw = await readFile(reportFile, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  return raw
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

async function main() {
  await rm(runDir, { recursive: true, force: true });
  await mkdir(runDir, { recursive: true });
  await mkdir(storeHome, { recursive: true });
  await mkdir(pluginHome, { recursive: true });

  // Child-environment facts the scrub assertions depend on: a credential-shaped
  // parent name and the Harness home must never reach a spawned server.
  process.env.DSH_HOME = pluginHome;
  process.env.FAKE_SCRUB_SECRET = 'must-not-leak';

  const unhandled = [];
  process.on('unhandledRejection', (reason) => {
    unhandled.push(reason);
    console.error('unhandledRejection:', reason instanceof Error ? reason.stack : String(reason));
  });

  await test('public tool names follow the mcp__<server>__<tool> contract', () => {
    assert.equal(sanitizePublicName('fake', 'echo'), 'mcp__fake__echo');
    assert.equal(sanitizePublicName('fake', 'mix.content'), 'mcp__fake__mix_content');
    assert.deepEqual(publicToolNames('fake', ['echo', 'mix.content']), [
      'mcp__fake__echo',
      'mcp__fake__mix_content',
    ]);
    const names = publicToolNames('fake', ['same', 'same', 'same']);
    assert.deepEqual(names, ['mcp__fake__same', 'mcp__fake__same_2', 'mcp__fake__same_3']);
    const longName = 'x'.repeat(80);
    const truncated = publicToolNames('srv', [longName, longName]);
    assert.ok(truncated[0].length <= 64, 'truncated to the 64 character budget');
    assert.ok(truncated[1].length <= 64, 'collision suffix stays inside the budget');
    assert.notEqual(truncated[0], truncated[1], 'collision suffix keeps names unique');
  });

  await test('MCP content flattens to text with non-text diagnostics', () => {
    assert.equal(
      flattenContent([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }], 'tool'),
      'a\nb',
    );
    assert.equal(
      flattenContent(
        [{ type: 'text', text: 'a' }, { type: 'image', data: 'x' }, { type: 'text', text: 'b' }],
        'shot',
      ),
      'a\n[image content from shot]\nb',
    );
    assert.equal(flattenContent('not-an-array', 'tool'), '');
    assert.equal(flattenContent([null], 'tool'), '[unsupported content from tool]');
  });

  let connection;
  await test('stdio MCP client completes the handshake and aggregates tools/list pages', async () => {
    connection = await connect(fakeServerRecord());
    assert.equal(connection.transportKind, 'stdio');
    assert.ok(Number.isInteger(connection.pid) && connection.pid > 0, 'child pid is exposed');
    assert.equal(connection.protocolVersion, '2025-06-18');
    assert.deepEqual(connection.serverInfo, { name: 'fake-mcp', version: '1.2.3' });
    assert.ok(typeof connection.instructions === 'string');
    assert.ok(connection.instructions.startsWith('Fake instructions.'), 'instructions are captured');
    assert.ok(connection.instructions.length <= 4_000, 'instructions are capped at 4000 chars');
    assert.deepEqual(
      connection.tools.map((tool) => tool.name),
      ['echo', 'explode', 'mix.content', 'bare'],
      'both tools/list pages were followed via nextCursor',
    );
  });

  await test('tool definitions match the pinned schema/description/execute shape', async () => {
    assert.ok(connection !== undefined, 'the handshake connection exists');
    const definitions = buildToolDefinitions({
      serverName: 'fake',
      tools: connection.tools,
      callTool: (rawName, args, signal) => connection.callTool(rawName, args, signal),
    });
    const byName = new Map(definitions.map((entry) => [entry.name, entry]));
    assert.deepEqual([...byName.keys()], [
      'mcp__fake__echo',
      'mcp__fake__explode',
      'mcp__fake__mix_content',
      'mcp__fake__bare',
    ]);

    const echo = byName.get('mcp__fake__echo');
    assert.equal(echo.definition.name, 'mcp__fake__echo');
    assert.equal(echo.definition.description, 'Echo the provided text');
    assert.deepEqual(echo.definition.parameters, {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    });
    assert.deepEqual(echo.definition.output.schema, {
      type: 'object',
      properties: {
        content: { type: 'array', items: {} },
        structuredContent: {},
      },
      required: ['content'],
      additionalProperties: false,
    });

    const echoValue = await echo.definition.execute({ text: 'hello' }, {});
    assert.deepEqual(echoValue, {
      content: [{ type: 'text', text: 'echo:hello' }],
      structuredContent: { echoed: 'hello' },
    });
    assert.deepEqual(echo.definition.output.render({}, echoValue), [
      { type: 'text', text: 'echo:hello' },
    ]);

    const bare = byName.get('mcp__fake__bare');
    assert.equal(bare.definition.description, 'Tool bare from MCP server fake');
    assert.deepEqual(bare.definition.parameters, { type: 'object', properties: {} });
    const bareValue = await bare.definition.execute({}, {});
    assert.equal(bare.definition.output.render({}, bareValue)[0].text, 'bare ok');

    const mix = byName.get('mcp__fake__mix_content');
    const mixValue = await mix.definition.execute({}, {});
    assert.equal(mixValue.content.length, 3, 'every MCP block is preserved in the value');
    assert.equal(
      mix.definition.output.render({}, mixValue)[0].text,
      'first\n[resource content from mix.content]\nlast',
    );

    const explode = byName.get('mcp__fake__explode');
    await assert.rejects(
      explode.definition.execute({}, {}),
      (error) => error instanceof Error && error.message === 'boom: intentional failure',
      'MCP isError must reject with the flattened text',
    );

    await assert.rejects(connection.callTool('missing-tool', {}), /unknown tool/);
  });

  await test('stdio shutdown is idempotent and reaps the child process', async () => {
    assert.ok(connection !== undefined, 'the handshake connection exists');
    const pid = connection.pid;
    await connection.close();
    assert.equal(connection.closed, true);
    await connection.close();
    assert.ok(await waitFor(() => !isAlive(pid)), `child ${pid} exited`);
  });

  await test('child environment is scrubbed but explicit env survives', async () => {
    const reports = await readReports();
    assert.ok(reports.length >= 1, 'the fake server reported its environment');
    const [first] = reports;
    assert.equal(first.explicitEnv, 'present', 'explicit server env reaches the child');
    assert.equal(first.sawScrubbedSecret, false, 'credential-shaped parent env is dropped');
    assert.equal(first.sawDshHome, false, 'DSH_HOME is not forwarded implicitly');
    assert.equal(first.sawDshPrefix, false, 'no DSH_* name reaches the child');
  });


  await test('streamable HTTP transport handshakes over JSON and SSE', async () => {
    /** @type {{ method?: string, headers: object, body?: any }[]} */
    const requests = [];
    const sockets = new Set();
    const server = createServer((request, response) => {
      response.on('error', () => {});
      const chunks = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const body = raw.trim() === '' ? undefined : JSON.parse(raw);
        requests.push({ method: request.method, headers: request.headers, body });
        if (request.method === 'DELETE') {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end('{}');
          return;
        }
        if (body?.method === 'notifications/initialized') {
          response.writeHead(202);
          response.end();
          return;
        }
        const headers = {
          'content-type': 'application/json',
          'mcp-session-id': 'sess-1',
          'mcp-protocol-version': '2025-06-18',
        };
        if (body?.method === 'initialize') {
          response.writeHead(200, headers);
          response.end(JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            result: {
              protocolVersion: '2025-06-18',
              capabilities: { tools: {} },
              serverInfo: { name: 'http-fake', version: '2.0.0' },
              instructions: 'HTTP fake instructions',
            },
          }));
          return;
        }
        if (body?.method === 'tools/list') {
          const payload = JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            result: {
              tools: [{
                name: 'http.echo',
                description: 'HTTP echo',
                inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
              }],
            },
          });
          response.writeHead(200, { ...headers, 'content-type': 'text/event-stream' });
          // Split the SSE frame across two TCP chunks to exercise streaming parse.
          const frame = `event: message\ndata: ${payload}\n\n`;
          response.write(frame.slice(0, 20));
          setTimeout(() => response.end(frame.slice(20)), 10);
          return;
        }
        if (body?.method === 'tools/call') {
          const payload = JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            result: { content: [{ type: 'text', text: `http:${String(body.params.arguments.text)}` }] },
          });
          response.writeHead(200, { ...headers, 'content-type': 'text/event-stream' });
          response.end(`data: ${payload}\n\n`);
          return;
        }
        response.writeHead(200, headers);
        response.end(JSON.stringify({ jsonrpc: '2.0', id: body?.id, error: { code: -32601, message: 'not found' } }));
      });
    });
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address !== null && typeof address === 'object');
    const httpConnection = await connect({
      name: 'httpfake',
      transport: 'http',
      url: `http://127.0.0.1:${address.port}/mcp`,
    });
    try {
      assert.equal(httpConnection.transportKind, 'http');
      assert.deepEqual(httpConnection.serverInfo, { name: 'http-fake', version: '2.0.0' });
      assert.equal(httpConnection.instructions, 'HTTP fake instructions');
      assert.deepEqual(httpConnection.tools.map((tool) => tool.name), ['http.echo']);

      const value = await httpConnection.callTool('http.echo', { text: 'hi' });
      assert.deepEqual(value, { content: [{ type: 'text', text: 'http:hi' }] });

      const initializeRequest = requests.find((entry) => entry.body?.method === 'initialize');
      assert.ok(initializeRequest !== undefined, 'initialize was POSTed');
      assert.match(String(initializeRequest.headers.accept), /application\/json/);
      assert.match(String(initializeRequest.headers.accept), /text\/event-stream/);
      const listRequest = requests.find((entry) => entry.body?.method === 'tools/list');
      assert.equal(listRequest?.headers['mcp-session-id'], 'sess-1', 'the initialize session id is carried');
      assert.equal(listRequest?.headers['mcp-protocol-version'], '2025-06-18');

      await httpConnection.close();
      assert.ok(requests.some((entry) => entry.method === 'DELETE'), 'the HTTP session is terminated on close');
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  const storeFile = path.join(storeHome, 'storages', 'mcp-manager.json');
  await test('store round-trips through the documented document shape', async () => {
    const store = createStore({ file: storeFile, logger: { warn() {} } });
    assert.deepEqual(await store.load(), [], 'a missing file loads as empty');

    const record = {
      id: 'id-1',
      name: 'alpha',
      enabled: true,
      transport: 'stdio',
      command: 'node',
      args: ['-v'],
      env: { A_B: '1' },
      createdAt: 111,
    };
    await store.setServers([record]);

    const document = JSON.parse(await readFile(storeFile, 'utf8'));
    assert.equal(document.version, 1);
    assert.deepEqual(document.servers, [record]);
    assert.deepEqual(document.ui, { railEntry: true }, 'a new document persists the default ui preference');
    assert.deepEqual(store.ui(), { railEntry: true }, 'the store resolves the default ui preference');
    assert.deepEqual(store.list(), [record], 'the in-memory view matches the document');

    const entries = await readdir(path.dirname(storeFile));
    assert.deepEqual(entries, ['mcp-manager.json'], 'atomic write leaves no temp sibling');

    const reloaded = createStore({ file: storeFile, logger: { warn() {} } });
    assert.deepEqual(await reloaded.load(), [record], 'a fresh store reloads the record');
  });

  await test('store serializes concurrent writes without leaving temp files', async () => {
    const store = createStore({ file: storeFile, logger: { warn() {} } });
    await store.load();
    const base = {
      id: 'id-1',
      name: 'alpha',
      enabled: true,
      transport: 'stdio',
      command: 'node',
      args: [],
      env: {},
      createdAt: 111,
    };
    await Promise.all(
      Array.from({ length: 20 }, (_, index) => store.setServers([{ ...base, name: `alpha-${index}` }])),
    );
    const document = JSON.parse(await readFile(storeFile, 'utf8'));
    assert.equal(document.servers[0].name, 'alpha-19', 'the last queued write wins');
    const leftovers = (await readdir(path.dirname(storeFile))).filter((name) => name.includes('.tmp-'));
    assert.ok((await readdir(path.dirname(storeFile))).includes('mcp-manager.json.bak'), 'previous good snapshot is backed up');
    assert.deepEqual(leftovers, [], 'no temp files remain after concurrent writes');
  });

  await test('store reads are tolerant of corrupt and missing documents', async () => {
    await writeFile(storeFile, '{ definitely not json', 'utf8');
    const corrupt = createStore({ file: storeFile, logger: { warn() {} } });
    assert.deepEqual(await corrupt.load(), [], 'corrupt JSON loads as empty');

    await writeFile(storeFile, JSON.stringify({ version: 99, servers: [{ id: 'x' }] }), 'utf8');
    const wrongVersion = createStore({ file: storeFile, logger: { warn() {} } });
    assert.deepEqual(await wrongVersion.load(), [], 'an unknown version loads as empty');

    const missing = createStore({ file: path.join(runDir, 'missing', 'mcp-manager.json'), logger: { warn() {} } });
    assert.deepEqual(await missing.load(), [], 'a missing directory loads as empty');
  });

  await test('store persists the ui preference and upgrades older documents', async () => {
    const uiFile = path.join(runDir, 'ui-home', 'storages', 'mcp-manager.json');
    const first = createStore({ file: uiFile, logger: { warn() {} } });
    assert.deepEqual(await first.load(), []);
    assert.deepEqual(first.ui(), { railEntry: true }, 'a missing document defaults to railEntry true');

    await first.setUi({ railEntry: false });
    const written = JSON.parse(await readFile(uiFile, 'utf8'));
    assert.deepEqual(written.ui, { railEntry: false });
    assert.deepEqual(written.servers, []);
    assert.deepEqual(first.ui(), { railEntry: false });

    const reloaded = createStore({ file: uiFile, logger: { warn() {} } });
    assert.deepEqual(await reloaded.load(), []);
    assert.deepEqual(reloaded.ui(), { railEntry: false }, 'the preference survives a reload');

    // A document written before the preference existed keeps working.
    await writeFile(uiFile, JSON.stringify({ version: 1, servers: [] }), 'utf8');
    const legacy = createStore({ file: uiFile, logger: { warn() {} } });
    assert.deepEqual(await legacy.load(), []);
    assert.deepEqual(legacy.ui(), { railEntry: true }, 'a legacy document defaults to railEntry true');
    await legacy.setServers([]);
    const upgraded = JSON.parse(await readFile(uiFile, 'utf8'));
    assert.deepEqual(upgraded.ui, { railEntry: true }, 'the next write upgrades the document');

    // Server mutations keep the stored preference.
    const record = {
      id: 'id-2',
      name: 'beta',
      enabled: false,
      transport: 'stdio',
      command: 'node',
      args: [],
      env: {},
      createdAt: 222,
    };
    const combined = createStore({ file: uiFile, logger: { warn() {} } });
    await combined.load();
    await combined.setUi({ railEntry: false });
    await combined.setServers([record]);
    const combinedDocument = JSON.parse(await readFile(uiFile, 'utf8'));
    assert.deepEqual(combinedDocument.ui, { railEntry: false }, 'server mutations preserve the ui preference');
    assert.deepEqual(combinedDocument.servers, [record]);

    // Malformed ui tolerates to the default.
    await writeFile(uiFile, JSON.stringify({ version: 1, servers: [], ui: { railEntry: 'yes' } }), 'utf8');
    const malformed = createStore({ file: uiFile, logger: { warn() {} } });
    await malformed.load();
    assert.deepEqual(malformed.ui(), { railEntry: true }, 'malformed ui falls back to railEntry true');

    // The store enforces the same boolean rule as the manager.
    assert.throws(
      () => malformed.setUi({ railEntry: 'yes' }),
      (error) => error instanceof ManagerError && error.code === 'invalid' && error.field === 'railEntry',
    );
  });

  await test('storage path resolution follows DSH_HOME and falls back to ~/.dsh', () => {
    assert.equal(resolveDshHome({}), path.join(homedir(), '.dsh'));
    assert.equal(resolveDshHome({ DSH_HOME: '/tmp/custom-home' }), '/tmp/custom-home');
    assert.equal(resolveDshHome({ DSH_HOME: '   ' }), path.join(homedir(), '.dsh'));
    assert.equal(
      resolveStoragePath({ DSH_HOME: '/tmp/custom-home' }),
      path.join('/tmp/custom-home', 'storages', 'mcp-manager.json'),
    );
  });

  await test('validation rules match the contract', () => {
    const existing = [{ id: 'id-1', name: 'alpha' }];
    const expectInvalid = (input, field, context) => {
      assert.throws(
        () => validateServerInput(input, context),
        (error) => error instanceof ManagerError && error.code === 'invalid' && error.field === field,
        `expected invalid/${field}`,
      );
    };
    expectInvalid({ name: 'bad name', transport: 'stdio', command: 'node' }, 'name');
    expectInvalid({ name: '', transport: 'stdio', command: 'node' }, 'name');
    expectInvalid({ name: 'x'.repeat(33), transport: 'stdio', command: 'node' }, 'name');
    expectInvalid({ name: 'beta', transport: 'carrier-pigeon' }, 'transport');
    expectInvalid({ name: 'beta', transport: 'stdio' }, 'command');
    expectInvalid({ name: 'beta', transport: 'stdio', command: 'node', args: [1] }, 'args');
    expectInvalid({ name: 'beta', transport: 'stdio', command: 'node', env: { '1BAD': 'x' } }, 'env');
    expectInvalid({ name: 'beta', transport: 'stdio', command: 'node', env: { OK: 1 } }, 'env');
    expectInvalid({ name: 'beta', transport: 'http', url: 'ftp://example.com' }, 'url');
    expectInvalid({ name: 'beta', transport: 'http', url: 'not-a-url' }, 'url');
    expectInvalid({ name: 'beta', transport: 'stdio', command: 'node', enabled: 'yes' }, 'enabled');
    expectInvalid({ name: 'beta', transport: 'stdio', command: 'node', autoInject: 'yes' }, 'autoInject');
    assert.throws(
      () => validateServerInput({ name: 'alpha', transport: 'stdio', command: 'node' }, { servers: existing }),
      (error) => error instanceof ManagerError && error.code === 'duplicate-name' && error.field === 'name',
    );
    assert.equal(
      validateServerInput(
        { name: 'alpha', transport: 'stdio', command: 'node' },
        { servers: existing, id: 'id-1' },
      ).name,
      'alpha',
      'replacing a record may keep its own name',
    );

    const stdio = validateServerInput(
      {
        name: ' beta ',
        transport: 'stdio',
        command: ' node ',
        args: ['-v'],
        env: { A_B: '1' },
        cwd: ' /tmp ',
        url: 'http://ignored',
        unknown: true,
      },
      {},
    );
    assert.deepEqual(stdio, {
      name: 'beta',
      enabled: true,
      transport: 'stdio',
      command: 'node',
      args: ['-v'],
      env: { A_B: '1' },
      cwd: '/tmp',
    });
    assert.equal(
      validateServerInput({ name: 'beta2', transport: 'stdio', command: 'node', autoInject: false }, {}).autoInject,
      false,
      'autoInject is preserved as a boolean',
    );

    const http = validateServerInput(
      { name: 'web', transport: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer x' } },
      {},
    );
    assert.deepEqual(http, {
      name: 'web',
      enabled: true,
      transport: 'http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer x' },
    });
  });

  await test('the sixteen Fetch routes match the pinned paths and failure shape', async () => {
    const view = { id: 's1', name: 'alpha', status: 'ready', tools: [], toolCount: 0 };
    let railEntry = true;
    const manager = {
      ready: async () => {},
      external: () => [],
      storage: () => ({ readOnly: false, hasBackup: false }),
      list: () => [view],
      save: async ({ id, server }) => {
        if (server.name === 'dup') throw new ManagerError('duplicate-name', 'dup', 'name');
        return { id: id ?? 'new-id', servers: [view] };
      },
      remove: async () => ({ servers: [] }),
      toggle: async () => ({ servers: [] }),
      reconnect: async () => ({ servers: [] }),
      takeover: async ({ entryId }) => ({ id: 'taken', servers: [], warnings: [entryId] }),
      ui: () => ({ railEntry }),
      setUi: async ({ railEntry: next }) => {
        if (typeof next !== 'boolean') throw new ManagerError('invalid', 'railEntry must be a boolean', 'railEntry');
        railEntry = next;
        return { servers: [view], ui: { railEntry } };
      },
    };
    const routes = createFetchRoutes(manager);
    assert.deepEqual(
      routes.map((route) => route.path),
      [...ROUTE_PATHS],
    );
    for (const route of routes) {
      assert.deepEqual(route.methods, ['POST']);
      assert.equal(route.requestBody, 'buffered');
    }

    const routeOf = (routePath) => {
      const found = routes.find((route) => route.path === routePath);
      assert.ok(found, `${routePath} exists`);
      return found;
    };

    const listResponse = await routeOf(LIST_PATH).fetch(jsonRequest({}));
    assert.equal(listResponse.status, 200);
    assert.equal(listResponse.headers.get('cache-control'), 'no-store');
    assert.match(listResponse.headers.get('content-type') ?? '', /application\/json/);
    assert.deepEqual(await listResponse.json(), { ok: true, servers: [view], ui: { railEntry: true }, external: [], storage: { readOnly: false, hasBackup: false } });

    const uiResponse = await routeOf(UI_PATH).fetch(jsonRequest({ railEntry: false }));
    assert.deepEqual(
      await uiResponse.json(),
      { ok: true, servers: [view], ui: { railEntry: false }, external: [], storage: { readOnly: false, hasBackup: false } },
      'the ui route persists and echoes the preference',
    );
    const badUi = await routeOf(UI_PATH).fetch(jsonRequest({ railEntry: 'yes' }));
    assert.deepEqual((await badUi.json()).error, {
      code: 'invalid',
      message: 'railEntry must be a boolean',
      field: 'railEntry',
    });
    const missingUi = await routeOf(UI_PATH).fetch(jsonRequest({}));
    assert.deepEqual((await missingUi.json()).error, {
      code: 'invalid',
      message: 'railEntry must be a boolean',
      field: 'railEntry',
    });
    assert.deepEqual(
      (await (await routeOf(LIST_PATH).fetch(jsonRequest({}))).json()).ui,
      { railEntry: false },
      'other success payloads carry the stored preference',
    );

    const malformed = await routeOf(SAVE_PATH).fetch(
      new Request('http://localhost/api/mcp-manager.save', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{oops',
      }),
    );
    assert.equal(malformed.status, 400, 'malformed JSON is the only 4xx');
    const malformedBody = await malformed.json();
    assert.equal(malformedBody.ok, false);
    assert.equal(malformedBody.error.code, 'invalid');

    const duplicate = await routeOf(SAVE_PATH).fetch(jsonRequest({ server: { name: 'dup' } }));
    assert.equal(duplicate.status, 200);
    assert.deepEqual(await duplicate.json(), {
      ok: false,
      error: { code: 'duplicate-name', message: 'dup', field: 'name' },
    });

    const noServer = await routeOf(SAVE_PATH).fetch(jsonRequest({}));
    assert.deepEqual((await noServer.json()).error, {
      code: 'invalid',
      message: 'request body must include "server"',
      field: 'server',
    });

    const badToggle = await routeOf(TOGGLE_PATH).fetch(jsonRequest({ id: 's1', enabled: 'yes' }));
    assert.deepEqual((await badToggle.json()).error, {
      code: 'invalid',
      message: 'enabled must be a boolean',
      field: 'enabled',
    });

    const badRemove = await routeOf(REMOVE_PATH).fetch(jsonRequest({}));
    assert.deepEqual((await badRemove.json()).error, {
      code: 'invalid',
      message: 'request body must include a non-empty "id"',
      field: 'id',
    });

    const exploding = {
      ...manager,
      list: () => {
        throw new Error('secret implementation detail');
      },
    };
    const internal = await createFetchRoutes(exploding)[0].fetch(jsonRequest({}));
    const internalBody = await internal.json();
    assert.equal(internalBody.error.code, 'internal');
    assert.equal(internalBody.ok, false);
    assert.ok(!internalBody.error.message.includes('secret'), 'internal details are not leaked');
  });

  // ---------------------------------------------------------------------
  // End-to-end: the real plugin against a minimal fake Cordis context.
  // ---------------------------------------------------------------------
  const effects = [];
  /** Event listeners the plugin registers (agent lifecycle). */
  const listeners = new Map();
  const routesByPath = new Map();
  const registeredTools = new Map();
  const logs = [];
  const ctx = {
    logger: {
      info: (message) => logs.push(['info', message]),
      warn: (message) => logs.push(['warn', message]),
      error: (message) => logs.push(['error', message]),
    },
    effect(body, label) {
      const dispose = body();
      effects.push({ label, dispose });
      return dispose;
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
    tools: {
      register(definition) {
        registeredTools.set(definition.name, definition);
        return () => {
          registeredTools.delete(definition.name);
        };
      },
    },
    connection: {
      fetch: {
        register(route) {
          routesByPath.set(route.path, route);
          return Promise.resolve(() => {
            routesByPath.delete(route.path);
          });
        },
      },
    },
  };

  /** One fake Agent whose scope shares this suite's tool registry. */
  const fakeAgent = {
    id: 'agent-smoke',
    session: { id: 'session-smoke' },
    ctx: {
      tools: ctx.tools,
      effect(body) {
        return body();
      },
    },
  };
  const emit = (event, payload) => {
    for (const listener of [...(listeners.get(event) ?? [])]) listener(payload);
  };

  const call = async (routePath, body) => {
    const route = routesByPath.get(routePath);
    assert.ok(route !== undefined, `route ${routePath} is registered`);
    const response = await route.fetch(jsonRequest(body));
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const payload = await response.json();
    if (payload.ok === true) {
      assert.ok(payload.ui !== null && typeof payload.ui === 'object', 'a success payload carries ui');
      assert.equal(typeof payload.ui.railEntry, 'boolean', 'ui.railEntry is a boolean');
    }
    return payload;
  };

  const viewFor = async (id) => {
    const payload = await call(LIST_PATH, {});
    return payload.servers.find((server) => server.id === id);
  };

  let pluginServerId;
  await test('apply registers the sixteen routes on ctx.connection.fetch', () => {
    apply(ctx);
    emit('agent/created', { agent: fakeAgent });
    assert.deepEqual(
      [...routesByPath.keys()].sort(),
      [...ROUTE_PATHS].sort(),
    );
    const labels = effects.map((entry) => entry.label);
    for (const label of ['mcp-manager.lifecycle', 'mcp-manager.agents', 'mcp-manager.routes']) {
      assert.ok(labels.includes(label), `${label} effect is registered`);
    }
  });

  await test('the ui preference defaults to true and persists through /api/mcp-manager.ui', async () => {
    const initial = await call(LIST_PATH, {});
    assert.deepEqual(initial.ui, { railEntry: true }, 'a document without ui defaults to the rail entry being on');

    const off = await call(UI_PATH, { railEntry: false });
    assert.deepEqual(off.ui, { railEntry: false });
    assert.deepEqual(off.servers, []);
    assert.deepEqual((await call(LIST_PATH, {})).ui, { railEntry: false }, 'the list carries the stored preference');

    const storageFile = path.join(pluginHome, 'storages', 'mcp-manager.json');
    const document = JSON.parse(await readFile(storageFile, 'utf8'));
    assert.deepEqual(document.ui, { railEntry: false }, 'the preference is persisted in the storage document');
    assert.deepEqual(document.servers, []);

    const reloaded = createStore({ file: storageFile, logger: { warn() {} } });
    assert.deepEqual(await reloaded.load(), []);
    assert.deepEqual(reloaded.ui(), { railEntry: false }, 'the preference survives a reload of the store');

    const invalid = await call(UI_PATH, { railEntry: 'yes' });
    assert.equal(invalid.ok, false);
    assert.deepEqual(invalid.error, {
      code: 'invalid',
      message: 'railEntry must be a boolean',
      field: 'railEntry',
    });
    const missing = await call(UI_PATH, {});
    assert.equal(missing.error.code, 'invalid');
    assert.deepEqual((await call(LIST_PATH, {})).ui, { railEntry: false }, 'a rejected write leaves the preference untouched');

    // Restore the shipped default so later checks model a fresh install.
    const on = await call(UI_PATH, { railEntry: true });
    assert.deepEqual(on.ui, { railEntry: true });
  });

  await test('save connects the server and registers its tools on ctx.tools', async () => {
    const saved = await call(SAVE_PATH, { server: fakeServerRecord() });
    assert.equal(saved.ok, true);
    assert.equal(typeof saved.id, 'string');
    pluginServerId = saved.id;
    assert.equal(saved.servers.length, 1);
    assert.equal(saved.servers[0].name, 'fake');
    assert.equal(saved.servers[0].enabled, true);
    assert.ok(['connecting', 'ready'].includes(saved.servers[0].status));

    const ready = await waitFor(async () => {
      const view = await viewFor(pluginServerId);
      return view?.status === 'ready' ? view : undefined;
    });
    assert.ok(ready !== undefined, `server became ready (logs: ${JSON.stringify(logs)})`);
    assert.equal(ready.toolCount, 4);
    assert.deepEqual(ready.tools.map((tool) => tool.name), ['echo', 'explode', 'mix.content', 'bare']);
    assert.equal(ready.serverInfo.name, 'fake-mcp');
    assert.ok(typeof ready.connectedAt === 'number');
    assert.deepEqual([...registeredTools.keys()].sort(), [
      'mcp__fake__bare',
      'mcp__fake__echo',
      'mcp__fake__explode',
      'mcp__fake__mix_content',
    ]);

    const echo = registeredTools.get('mcp__fake__echo');
    const value = await echo.execute({ text: 'via-manager' }, {});
    assert.deepEqual(echo.output.render({}, value), [{ type: 'text', text: 'echo:via-manager' }]);
    await assert.rejects(registeredTools.get('mcp__fake__explode').execute({}, {}), /boom/);
  });

  await test('invalid and duplicate saves fail without touching the live server', async () => {
    const duplicate = await call(SAVE_PATH, { server: fakeServerRecord({ name: 'fake' }) });
    assert.deepEqual(duplicate, {
      ok: false,
      error: { code: 'duplicate-name', message: 'a server named "fake" already exists', field: 'name' },
    });

    const badName = await call(SAVE_PATH, { server: fakeServerRecord({ name: 'bad name' }) });
    assert.equal(badName.ok, false);
    assert.equal(badName.error.code, 'invalid');
    assert.equal(badName.error.field, 'name');

    const badTransport = await call(SAVE_PATH, {
      server: { name: 'weird', transport: 'stdio', command: '' },
    });
    assert.equal(badTransport.error.field, 'command');

    const view = await viewFor(pluginServerId);
    assert.equal(view.status, 'ready');
    assert.equal(registeredTools.size, 4);
  });

  await test('a failed connection keeps the record and reports status error', async () => {
    const saved = await call(SAVE_PATH, {
      server: { name: 'broken', transport: 'stdio', command: '/definitely/not/a/real/binary-xyz' },
    });
    assert.equal(saved.ok, true);
    const brokenId = saved.id;
    const broken = await waitFor(async () => {
      const view = await viewFor(brokenId);
      return view?.status === 'error' ? view : undefined;
    }, 15_000);
    assert.ok(broken !== undefined, 'broken server reports error');
    assert.ok(typeof broken.error === 'string' && broken.error.length > 0);
    assert.equal(broken.toolCount, 0);
    assert.ok((await viewFor(brokenId)) !== undefined, 'the failed record is retained');

    const removed = await call(REMOVE_PATH, { id: brokenId });
    assert.ok(!removed.servers.some((server) => server.id === brokenId));
  });

  await test('disabling a server stuck in its handshake settles promptly', async () => {
    const saved = await call(SAVE_PATH, {
      server: fakeServerRecord({
        name: 'hung',
        env: { FAKE_SERVER_REPORT: reportFile, FAKE_SERVER_HANG: '1' },
      }),
    });
    assert.equal(saved.ok, true);
    const hungId = saved.id;
    assert.equal(saved.servers.find((server) => server.id === hungId).status, 'connecting');

    const startedAt = Date.now();
    const disabled = await call(TOGGLE_PATH, { id: hungId, enabled: false });
    const elapsed = Date.now() - startedAt;
    const view = disabled.servers.find((server) => server.id === hungId);
    assert.equal(view?.enabled, false);
    assert.equal(view?.status, 'stopped');
    assert.ok(elapsed < 5_000, `disable settled in ${elapsed} ms instead of waiting for the 30 s initialize timeout`);

    const removed = await call(REMOVE_PATH, { id: hungId });
    assert.ok(!removed.servers.some((server) => server.id === hungId));
  });

  await test('toggle disables the server, stops the child and removes its tools', async () => {
    const disabled = await call(TOGGLE_PATH, { id: pluginServerId, enabled: false });
    const view = disabled.servers.find((server) => server.id === pluginServerId);
    assert.equal(view.enabled, false);
    assert.equal(view.status, 'stopped');
    assert.equal(view.toolCount, 0);
    assert.equal(registeredTools.size, 0, 'every tool of the disabled server is unregistered');
  });

  await test('toggle re-enables the server and restores its tools', async () => {
    const enabled = await call(TOGGLE_PATH, { id: pluginServerId, enabled: true });
    assert.equal(enabled.servers.find((server) => server.id === pluginServerId).enabled, true);
    const ready = await waitFor(async () => {
      const view = await viewFor(pluginServerId);
      return view?.status === 'ready' ? view : undefined;
    });
    assert.ok(ready !== undefined, `server reconnected (logs: ${JSON.stringify(logs)})`);
    assert.equal(registeredTools.size, 4);
  });

  await test('a server that dies is reported as error and its tools are removed', async () => {
    const reports = await readReports();
    assert.ok(reports.length >= 1);
    const latest = reports[reports.length - 1];
    assert.ok(isAlive(latest.pid), 'the current MCP child is alive');
    process.kill(latest.pid, 'SIGTERM');
    const errored = await waitFor(async () => {
      const view = await viewFor(pluginServerId);
      return view?.status === 'error' ? view : undefined;
    });
    assert.ok(errored !== undefined, `the dead child flipped the status to error (logs: ${JSON.stringify(logs)})`);
    assert.match(errored.error, /SIGTERM|exited/i);
    assert.equal(errored.toolCount, 0);
    assert.equal(registeredTools.size, 0, 'the dead server\'s tools were unregistered');
    assert.ok(await waitFor(() => !isAlive(latest.pid)), 'the child is gone');
  });

  await test('renaming a server restarts it and swaps the tool namespace', async () => {
    const renamed = await call(SAVE_PATH, { id: pluginServerId, server: fakeServerRecord({ name: 'renamed' }) });
    assert.equal(renamed.ok, true);
    assert.equal(renamed.id, pluginServerId);
    assert.equal(renamed.servers.find((server) => server.id === pluginServerId).name, 'renamed');

    const ready = await waitFor(async () => {
      const view = await viewFor(pluginServerId);
      return view?.status === 'ready' && view.name === 'renamed' ? view : undefined;
    });
    assert.ok(ready !== undefined, 'renamed server reconnected');
    assert.deepEqual([...registeredTools.keys()].sort(), [
      'mcp__renamed__bare',
      'mcp__renamed__echo',
      'mcp__renamed__explode',
      'mcp__renamed__mix_content',
    ]);
  });

  await test('reconnect swaps in a fresh connection without changing the record', async () => {
    const before = await viewFor(pluginServerId);
    const response = await call(RECONNECT_PATH, { id: pluginServerId });
    assert.equal(response.ok, true);
    const reconnecting = response.servers.find((server) => server.id === pluginServerId);
    assert.equal(reconnecting.status, 'connecting');
    const ready = await waitFor(async () => {
      const view = await viewFor(pluginServerId);
      return view?.status === 'ready' ? view : undefined;
    });
    assert.ok(ready !== undefined, 'server reconnected');
    assert.equal(ready.name, 'renamed');
    assert.ok(ready.connectedAt >= before.connectedAt, 'a new connection was established');
    assert.equal(registeredTools.size, 4);
  });

  await test('unknown ids fail with the not-found code', async () => {
    const missingToggle = await call(TOGGLE_PATH, { id: 'missing-id', enabled: true });
    assert.deepEqual(missingToggle, {
      ok: false,
      error: { code: 'not-found', message: 'no MCP server with id "missing-id"' },
    });
    const missingRemove = await call(REMOVE_PATH, { id: 'missing-id' });
    assert.equal(missingRemove.error.code, 'not-found');
    const missingReconnect = await call(RECONNECT_PATH, { id: 'missing-id' });
    assert.equal(missingReconnect.error.code, 'not-found');
    const missingSave = await call(SAVE_PATH, { id: 'missing-id', server: fakeServerRecord() });
    assert.equal(missingSave.error.code, 'not-found');
  });

  await test('remove deletes the record and unregisters its tools', async () => {
    const removed = await call(REMOVE_PATH, { id: pluginServerId });
    assert.deepEqual(removed, { ok: true, servers: [], external: [], ui: { railEntry: true }, storage: { readOnly: false, hasBackup: true } });
    assert.equal(registeredTools.size, 0);
    const payload = await call(LIST_PATH, {});
    assert.deepEqual(payload, { ok: true, servers: [], external: [], ui: { railEntry: true }, storage: { readOnly: false, hasBackup: true } });
  });

  await test('plugin unload removes every route and kills every child process', async () => {
    const reportsBefore = await readReports();
    assert.ok(reportsBefore.length >= 4, 'the test spawned several MCP children');
    for (const effect of effects.reverse()) {
      await effect.dispose?.();
    }
    assert.equal(routesByPath.size, 0, 'unload removed the Fetch routes');
    assert.equal(registeredTools.size, 0, 'unload removed every tool registration');
    for (const report of reportsBefore) {
      assert.ok(await waitFor(() => !isAlive(report.pid)), `child ${report.pid} exited after unload`);
    }
    const finalReports = await readReports();
    assert.ok(finalReports.length >= reportsBefore.length, 'every child reported its start');
  });

  await test('no unhandled rejection escaped the suite', () => {
    assert.deepEqual(unhandled, []);
  });

  console.log(`\n${passed} checks passed, ${failures.length} failed`);
  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`\nFAILED: ${failure.name}`);
      console.error(failure.error instanceof Error ? failure.error.stack ?? failure.error.message : String(failure.error));
    }
    console.error(`\nTemporary directory kept for debugging: ${runDir}`);
    process.exitCode = 1;
    return;
  }
  if (process.env.KEEP_TMP !== '1') await rm(runDir, { recursive: true, force: true });
  process.exitCode = 0;
}

await main();
