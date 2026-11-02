#!/usr/bin/env node
/**
 * Minimal stdio MCP server used by `mcp.smoke.mjs`.
 *
 * It speaks newline-delimited JSON-RPC 2.0 over stdin/stdout and implements the
 * exact surface the Host bridge exercises:
 *
 * - `initialize` / `notifications/initialized`
 * - `tools/list` with one `nextCursor` page (pagination)
 * - `tools/call` for `echo` (text + structuredContent), `explode` (`isError`),
 *   `mix.content` (text plus a non-text block) and `bare` (no inputSchema)
 *
 * When `FAKE_SERVER_REPORT` names a file, the process appends one JSON line per
 * start describing its pid and the environment it actually received, so the
 * smoke test can prove child cleanup and environment scrubbing.
 *
 * @module @kuhufu/dsh-mcp-manager/test/fake-server
 */

import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const TOOLS = [
  {
    name: 'echo',
    description: 'Echo the provided text',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
  },
  {
    name: 'explode',
    description: 'Always fails',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'mix.content',
    description: 'Returns mixed content blocks',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'bare',
    // Deliberately no description and no inputSchema.
  },
];

/** Write one JSON-RPC message as a single line. */
function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

/** Reply with a JSON-RPC error object. */
function sendError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

/** Handle one parsed JSON-RPC message. */
function handle(message) {
  if (typeof message !== 'object' || message === null) return;
  const { id, method, params } = message;
  const isRequest = id !== undefined && id !== null;

  if (process.env.FAKE_SERVER_HANG === '1' && method === 'initialize') {
    // Never answer: lets the smoke test prove that disabling or unloading a
    // server stuck in its handshake settles immediately.
    process.stderr.write('fake-mcp: hanging initialize on purpose\n');
    return;
  }

  switch (method) {
    case 'initialize':
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2025-06-18',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'fake-mcp', version: '1.2.3' },
          instructions: `Fake instructions. ${'padding '.repeat(600)}`,
        },
      });
      return;
    case 'notifications/initialized':
      return;
    case 'tools/list': {
      const cursor = params?.cursor;
      if (cursor === undefined) {
        send({ jsonrpc: '2.0', id, result: { tools: TOOLS.slice(0, 2), nextCursor: 'page-2' } });
        return;
      }
      if (cursor === 'page-2') {
        send({ jsonrpc: '2.0', id, result: { tools: TOOLS.slice(2) } });
        return;
      }
      sendError(id, -32602, `unknown cursor: ${String(cursor)}`);
      return;
    }
    case 'tools/call': {
      const name = params?.name;
      const args = params?.arguments ?? {};
      switch (name) {
        case 'echo':
          send({
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: `echo:${String(args.text)}` }],
              structuredContent: { echoed: args.text },
            },
          });
          return;
        case 'explode':
          send({
            jsonrpc: '2.0',
            id,
            result: {
              isError: true,
              content: [{ type: 'text', text: 'boom: intentional failure' }],
            },
          });
          return;
        case 'mix.content':
          send({
            jsonrpc: '2.0',
            id,
            result: {
              content: [
                { type: 'text', text: 'first' },
                { type: 'resource', resource: { uri: 'file:///fake/resource.txt', text: 'payload' } },
                { type: 'text', text: 'last' },
              ],
            },
          });
          return;
        case 'bare':
          send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'bare ok' }] } });
          return;
        default:
          sendError(id, -32602, `unknown tool: ${String(name)}`);
          return;
      }
    }
    default:
      if (isRequest) sendError(id, -32601, `method not found: ${String(method)}`);
  }
}

const reportFile = process.env.FAKE_SERVER_REPORT;
if (typeof reportFile === 'string' && reportFile !== '') {
  appendFileSync(
    reportFile,
    `${JSON.stringify({
      pid: process.pid,
      command: process.argv[1] ?? '',
      explicitEnv: process.env.FAKE_SERVER_EXPLICIT ?? null,
      sawScrubbedSecret: process.env.FAKE_SCRUB_SECRET !== undefined,
      sawDshHome: process.env.DSH_HOME !== undefined,
      sawDshPrefix: Object.keys(process.env).some((key) => key.startsWith('DSH_')),
    })}\n`,
    'utf8',
  );
}

process.stderr.write('fake-mcp: started\n');

const lines = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
lines.on('line', (line) => {
  const text = line.trim();
  if (text === '') return;
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    return;
  }
  try {
    handle(message);
  } catch (error) {
    process.stderr.write(`fake-mcp: handler failed: ${error instanceof Error ? error.message : String(error)}\n`);
  }
});
lines.on('close', () => {
  setImmediate(() => process.exit(0));
});
