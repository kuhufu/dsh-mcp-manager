/**
 * Dependency-free MCP client used by the `@kuhufu/dsh-mcp-manager` Host half.
 *
 * Supports the two transports the bundle exposes:
 *
 * - `stdio`: spawn the configured command with a scrubbed parent environment
 *   plus the server's explicit `env`, and speak newline-delimited JSON-RPC 2.0
 *   over the child's piped stdio.
 * - `http`: the MCP Streamable HTTP transport — POST JSON-RPC messages with
 *   `Accept: application/json, text/event-stream`, parse SSE `data:` frames,
 *   and carry the `mcp-session-id` issued by `initialize` on later requests.
 *
 * The client performs the standard handshake (`initialize` →
 * `notifications/initialized`), aggregates `tools/list` pages (following
 * `nextCursor`), and invokes `tools/call`. It also owns the tool-bridge helpers
 * that translate MCP tools into Harness `ToolDefinition`s.
 *
 * Only `node:*` builtins are imported: the bundle has no dependencies.
 *
 * @module @kuhufu/dsh-mcp-manager/host/mcp
 */

import { spawn } from 'node:child_process';

/** MCP protocol revision this client speaks. */
const PROTOCOL_VERSION = '2025-06-18';
/** Protocol revisions this implementation can negotiate during initialization. */
const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze(['2025-06-18', '2025-03-26', '2024-11-05']);

/** Client identity announced during `initialize`. */
const CLIENT_INFO = Object.freeze({ name: 'dsh-mcp-manager', version: '0.1.0' });

/** Default per-request deadline (ms). */
const REQUEST_TIMEOUT_MS = 60_000;

/** Deadline for the `initialize` request (ms). */
const INITIALIZE_TIMEOUT_MS = 30_000;

/** Maximum characters of server instructions exposed to the Client. */
const MAX_INSTRUCTIONS_LENGTH = 4_000;

/** DeepSeek function-name budget for a public tool name. */
const MAX_PUBLIC_NAME_LENGTH = 64;

/** DeepSeek function-name character vocabulary. */
const INVALID_PUBLIC_NAME_CHARS = /[^A-Za-z0-9_-]/g;

/** Upper bound on `tools/list` pages followed in one handshake. */
const MAX_TOOL_PAGES = 200;

/**
 * Upper bound on the tools one server may advertise. A runaway catalog would be
 * copied into every attached Agent's registry, so it fails the handshake with a
 * visible error instead of growing without limit.
 */
export const MAX_TOOL_COUNT = 512;

/** Upper bound on one advertised `inputSchema` (UTF-8 bytes, serialized). */
export const MAX_TOOL_SCHEMA_BYTES = 64 * 1024;

/** Upper bound on the whole advertised catalog (UTF-8 bytes, serialized). */
const MAX_TOOL_CATALOG_BYTES = 8 * 1024 * 1024;

/** Bytes of child stderr retained for failure diagnostics. */
const STDERR_TAIL_LIMIT = 4_096;

/** Fallback JSON Schema for a tool that advertises nothing usable. */
const EMPTY_INPUT_SCHEMA = Object.freeze({ type: 'object', properties: {} });

/** Failure raised by this MCP client. */
class McpError extends Error {
  /**
   * @param {string} message - human-readable failure text.
   * @param {{ cause?: unknown, code?: number }} [options] - JSON-RPC error code or cause.
   */
  constructor(message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'McpError';
    if (options.code !== undefined) this.code = options.code;
  }
}

/** Whether a value is a non-array object. */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether a value is a usable JSON-RPC id. */
function isRequestId(value) {
  return (typeof value === 'string' && value !== '') || (typeof value === 'number' && Number.isFinite(value));
}

/** Trim a captured stderr tail into a printable diagnostic. */
function cleanStderrTail(tail) {
  const trimmed = tail.replace(/\u0000/g, '').trim();
  if (trimmed === '') return '';
  const lines = trimmed.split(/\r?\n/).slice(-20).join('\n');
  return lines.length > STDERR_TAIL_LIMIT ? lines.slice(-STDERR_TAIL_LIMIT) : lines;
}

/**
 * The ambient parent environment minus credential-shaped names (`KEY`,
 * `PASSWORD`, `SECRET`, `TOKEN`) and minus `DSH_*` Harness identity names, so a
 * spawned MCP server never inherits implicit secrets. An explicit server `env`
 * entry is merged on top and therefore survives.
 *
 * @returns {Record<string, string>} fresh environment object.
 */
function scrubbedParentEnv() {
  /** @type {Record<string, string>} */
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (/KEY|PASSWORD|SECRET|TOKEN/i.test(key)) continue;
    if (key.toUpperCase().startsWith('DSH_')) continue;
    env[key] = value;
  }
  return env;
}

/**
 * Resolve the environment handed to a stdio child.
 * @param {object} server - server record with optional `env`.
 * @returns {Record<string, string>} merged environment.
 */
function childEnv(server) {
  return { ...scrubbedParentEnv(), ...(server.env ?? {}) };
}

/**
 * Start the stdio transport for one server.
 *
 * @param {object} server - stdio server record (`command`, `args`, `env`, `cwd`).
 * @returns {object} transport handle used by {@link createRpcConnection}.
 */
function createStdioTransport(server) {
  const child = spawn(server.command, server.args ?? [], {
    cwd: server.cwd ?? undefined,
    env: childEnv(server),
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stderrTail = '';
  let buffer = '';
  let settle;
  const settled = new Promise((resolve) => {
    settle = resolve;
  });
  let settledInfo;
  let notified = false;
  let messageHandler = () => {};
  let closeHandler = () => {};
  const decoder = new TextDecoder('utf-8');

  const notifyClose = () => {
    if (notified) return;
    notified = true;
    closeHandler(settledInfo);
  };

  const deliver = (line) => {
    const text = line.trim();
    if (text === '') return;
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    try {
      messageHandler(message);
    } catch {
      // A consumer failure must never take the transport down.
    }
  };

  child.stdout?.on('data', (chunk) => {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    buffer = buffer.replace(/\r\n/g, '\n');
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      deliver(line);
    }
  });
  child.stdout?.on('end', () => {
    buffer += decoder.decode();
    if (buffer.trim() !== '') deliver(buffer);
    buffer = '';
  });
  child.stderr?.on('data', (chunk) => {
    stderrTail = `${stderrTail}${chunk.toString('utf8')}`.slice(-STDERR_TAIL_LIMIT);
  });

  child.once('error', (error) => {
    settledInfo = { error };
    settle(settledInfo);
    notifyClose();
  });
  child.once('close', (code, signal) => {
    settledInfo = { code, signal };
    settle(settledInfo);
    notifyClose();
  });

  let closing;
  async function close() {
    closing ??= (async () => {
      try {
        child.stdin?.end();
      } catch {
        // The child may already have exited and closed the pipe.
      }
      const graceful = await Promise.race([settled.then(() => true), waitFor(1_000)]);
      if (!graceful) {
        kill('SIGTERM');
        const terminated = await Promise.race([settled.then(() => true), waitFor(1_500)]);
        if (!terminated) {
          kill('SIGKILL');
          await Promise.race([settled.then(() => true), waitFor(1_000)]);
        }
      }
      child.stdout?.destroy();
      child.stderr?.destroy();
      try {
        child.stdin?.destroy();
      } catch {
        // Ignore: the pipe is already gone.
      }
      notifyClose();
    })();
    return closing;
  }

  function kill(signal) {
    try {
      child.kill(signal);
    } catch {
      // The process is already gone; the settled promise already recorded it.
    }
  }

  return {
    kind: 'stdio',
    pid: child.pid,
    setMessageHandler(handler) {
      messageHandler = handler;
    },
    setCloseHandler(handler) {
      if (notified) handler(settledInfo);
      else closeHandler = handler;
    },
    stderrTail() {
      return cleanStderrTail(stderrTail);
    },
    send(message) {
      if (notified) throw new McpError('stdio transport is closed');
      const stdin = child.stdin;
      if (stdin === null || stdin === undefined || stdin.destroyed) throw new McpError('stdio transport is closed');
      stdin.write(`${JSON.stringify(message)}\n`);
    },
    close,
  };
}

/**
 * Start the MCP Streamable HTTP transport for one server.
 *
 * @param {object} server - http server record (`url`, `headers`).
 * @returns {object} transport handle used by {@link createRpcConnection}.
 */
export function createHttpTransport(server) {
  const endpoint = new URL(server.url);
  const baseHeaders = { ...(server.headers ?? {}) };
  const controller = new AbortController();
  let sessionId;
  let protocolVersion;
  let closed = false;
  let messageHandler = () => {};
  let closeHandler = () => {};

  const headersFor = () => {
    /** @type {Record<string, string>} */
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...baseHeaders,
    };
    if (sessionId !== undefined) headers['mcp-session-id'] = sessionId;
    if (protocolVersion !== undefined) headers['mcp-protocol-version'] = protocolVersion;
    return headers;
  };

  const dispatch = (payload) => {
    if (Array.isArray(payload)) {
      for (const message of payload) if (isRecord(message)) messageHandler(message);
      return;
    }
    if (isRecord(payload)) messageHandler(payload);
  };

  const fail = (error) => {
    if (closed) return;
    closed = true;
    controller.abort();
    closeHandler({ error });
    void close();
  };

  async function readEventStream(response, id) {
    const body = response.body;
    if (body === null || body === undefined) throw new McpError('HTTP response carried an empty event stream');
    const reader = body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let matched = false;
    try {
      while (!matched) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer = `${buffer}${decoder.decode(value, { stream: true })}`.replace(/\r\n/g, '\n');
        let boundary;
        while (!matched && (boundary = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = extractSseData(frame);
          if (data === undefined) continue;
          let payload;
          try {
            payload = JSON.parse(data);
          } catch {
            continue;
          }
          if (id !== undefined && containsResponseFor(payload, id)) matched = true;
          dispatch(payload);
        }
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        // Reader already finished or the connection dropped.
      }
    }
    if (id !== undefined && !matched) throw new McpError('HTTP event stream ended before the JSON-RPC response arrived');
  }

  async function send(message, options = {}) {
    if (closed) throw new McpError('HTTP transport is closed');
    const expectsResponse = typeof message.method === 'string' && isRequestId(message.id);
    let response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: headersFor(),
        body: JSON.stringify(message),
        signal: options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal,
      });
    } catch (error) {
      if (!options.signal?.aborted) fail(error);
      throw new McpError(`MCP HTTP request failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }

    const issuedSession = response.headers.get('mcp-session-id');
    if (issuedSession !== null && issuedSession !== '') sessionId = issuedSession;

    const contentType = (response.headers.get('content-type') ?? '').toLowerCase();

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      fail(new McpError(`MCP HTTP server returned ${response.status}`));
      throw new McpError(`MCP HTTP server returned ${response.status}${detail.trim() === '' ? '' : `: ${detail.trim().slice(0, 500)}`}`);
    }
    if (!expectsResponse) {
      // Notifications are acknowledged with an empty body; do not wait on a
      // server that keeps an event stream open for them.
      try {
        await response.body?.cancel();
      } catch {
        // The body was already consumed or the connection dropped.
      }
      return;
    }
    if (contentType.includes('text/event-stream')) {
      await readEventStream(response, message.id);
      return;
    }
    if (response.status === 202 || response.status === 204) return;
    const text = await response.text();
    if (text.trim() === '') return;
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new McpError(`MCP HTTP server returned invalid JSON: ${text.trim().slice(0, 500)}`);
    }
    dispatch(payload);
  }

  let closing;
  async function close() {
    closing ??= (async () => {
      closed = true;
      controller.abort();
      const activeSession = sessionId;
      if (activeSession === undefined) return;
      // Streamable HTTP: terminate the session so the server can release it.
      try {
        await fetch(endpoint, {
          method: 'DELETE',
          headers: { ...headersFor(), 'mcp-session-id': activeSession },
          signal: AbortSignal.timeout(2_000),
        });
      } catch {
        // Best effort: the server may not implement session termination.
      }
    })();
    return closing;
  }

  return {
    kind: 'http',
    setMessageHandler(handler) {
      messageHandler = handler;
    },
    setCloseHandler(handler) {
      if (closed) handler({ error: new McpError('HTTP transport is closed') });
      else closeHandler = handler;
    },
    stderrTail() {
      return '';
    },
    send,
    close,
    setProtocolVersion(value) {
      protocolVersion = value;
    },
    listen() {
      // Optional server notification stream. A 405 means POST-only support.
      void (async () => {
        try {
          const response = await fetch(endpoint, { headers: { ...headersFor(), accept: 'text/event-stream' }, signal: controller.signal });
          if (response.ok && response.headers.get('content-type')?.includes('text/event-stream')) await readEventStream(response);
          else await response.body?.cancel();
        } catch { /* POST requests still work if the optional stream is unavailable. */ }
      })();
    },
  };
}

/** Parse one SSE frame into its `data:` payload. */
function extractSseData(frame) {
  const data = [];
  for (const rawLine of frame.split('\n')) {
    if (!rawLine.startsWith('data:')) continue;
    const value = rawLine.slice(5);
    data.push(value.startsWith(' ') ? value.slice(1) : value);
  }
  return data.length === 0 ? undefined : data.join('\n');
}

/** Whether one parsed JSON-RPC payload carries the response for `id`. */
function containsResponseFor(payload, id) {
  const messages = Array.isArray(payload) ? payload : [payload];
  return messages.some((message) => isRecord(message) && message.id === id && (message.result !== undefined || message.error !== undefined));
}

/** Await a delay that resolves to `false`, so `Promise.race` can use it as a timeout. */
function waitFor(ms) {
  return new Promise((resolve) => {
    setTimeout(() => resolve(false), ms);
  });
}

/**
 * Build the JSON-RPC request/response layer on top of a transport.
 *
 * @param {object} transport - handle from {@link createStdioTransport} or {@link createHttpTransport}.
 * @param {{ label?: string, requestTimeoutMs?: number }} [options] - diagnostics label and default deadline.
 * @returns {object} RPC connection handle.
 */
export function createRpcConnection(transport, options = {}) {
  const label = options.label ?? 'mcp-manager';
  const requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  /** @type {Map<string|number, object>} */
  const pending = new Map();
  const closeListeners = [];
  const notificationListeners = new Set();
  let nextId = 1;
  let closed = false;
  let closeReason;
  let closing;

  const describeTransportClose = (info) => {
    if (info?.error !== undefined) {
      return `${label}: ${info.error instanceof Error ? info.error.message : String(info.error)}`;
    }
    const code = info?.code === undefined || info?.code === null ? 'unknown' : String(info.code);
    const signal = info?.signal === undefined || info?.signal === null ? '' : ` (signal ${info.signal})`;
    const tail = cleanStderrTail(transport.stderrTail());
    return `${label}: MCP server exited with code ${code}${signal}${tail === '' ? '' : `\n--- stderr ---\n${tail}`}`;
  };

  const settleAll = (reason) => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.removeAbortListener?.();
      entry.controller.abort();
      entry.reject(new McpError(reason));
    }
    pending.clear();
  };

  const handleClose = (info) => {
    if (closed) return;
    closed = true;
    closeReason = describeTransportClose(info);
    settleAll(closeReason);
    void close().catch(() => {});
    for (const listener of closeListeners.splice(0)) {
      try {
        listener(closeReason);
      } catch {
        // Listener failures must not break teardown.
      }
    }
  };

  transport.setMessageHandler((message) => {
    if (!isRecord(message) || message.jsonrpc !== '2.0') return;
    if (typeof message.method === 'string') {
      if (isRequestId(message.id)) {
        const reply = message.method === 'ping' ? { result: {} } : { error: { code: -32601, message: 'Method not found' } };
        void Promise.resolve().then(() => transport.send({ jsonrpc: '2.0', id: message.id, ...reply }, { signal: AbortSignal.timeout(2_000) })).catch(() => {});
      } else {
        for (const listener of notificationListeners) {
          try { listener(message.method, message.params); } catch { /* isolate subscribers */ }
        }
      }
      return;
    }
    if (!isRequestId(message.id) || (!('result' in message) && !('error' in message))) return;
    const entry = pending.get(message.id);
    if (entry === undefined) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    entry.removeAbortListener?.();
    if (message.error !== undefined && message.error !== null) {
      const detail = isRecord(message.error) ? message.error : {};
      const text = typeof detail.message === 'string' && detail.message !== '' ? detail.message : 'MCP request failed';
      entry.reject(new McpError(`${label}: ${text}`, { code: typeof detail.code === 'number' ? detail.code : undefined }));
      return;
    }
    entry.resolve(message.result ?? null);
  });
  transport.setCloseHandler(handleClose);

  async function request(method, params, requestOptions = {}) {
    if (closed) return Promise.reject(new McpError(`${label}: connection is closed${closeReason === undefined ? '' : ` (${closeReason})`}`));
    const timeoutMs = requestOptions.timeoutMs ?? requestTimeoutMs;
    const signal = requestOptions.signal;
    const controller = new AbortController();
    const id = nextId;
    nextId += 1;
    /** @type {Record<string, unknown>} */
    const message = { jsonrpc: '2.0', id, method };
    if (params !== undefined) message.params = params;

    return new Promise((resolve, reject) => {
      const finish = () => {
        clearTimeout(timer);
        if (signal !== undefined) signal.removeEventListener('abort', onAbort);
      };
      const timer = setTimeout(() => {
        if (!pending.delete(id)) return;
        finish();
        cancel('Request timed out');
        reject(new McpError(`${label}: ${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      const onAbort = () => {
        if (!pending.delete(id)) return;
        finish();
        cancel('Request canceled');
        reject(new McpError(`${label}: ${method} was canceled`));
      };
      let sent = false;
      const cancel = (reason) => {
        controller.abort();
        if (sent && method !== 'initialize' && !closed) {
          void notify('notifications/cancelled', { requestId: id, reason }).catch(() => {});
        }
      };
      pending.set(id, {
        controller,
        resolve(value) {
          finish();
          resolve(value);
        },
        reject(error) {
          finish();
          reject(error);
        },
        timer,
        removeAbortListener: signal === undefined ? undefined : () => signal.removeEventListener('abort', onAbort),
      });
      if (signal !== undefined) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }
      Promise.resolve()
        .then(() => {
          if (controller.signal.aborted || closed) return;
          sent = true;
          return transport.send(message, { signal: controller.signal });
        })
        .catch((error) => {
          if (!pending.delete(id)) return;
          finish();
          reject(error instanceof McpError ? error : new McpError(`${label}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }));
        });
    });
  }

  async function notify(method, params, notifyOptions = {}) {
    if (closed) throw new McpError(`${label}: connection is closed`);
    /** @type {Record<string, unknown>} */
    const message = { jsonrpc: '2.0', method };
    if (params !== undefined) message.params = params;
    try {
      await transport.send(message, { signal: AbortSignal.timeout(notifyOptions.timeoutMs ?? requestTimeoutMs) });
    } catch (error) {
      throw error instanceof McpError ? error : new McpError(`${label}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }

  async function close() {
    closed = true;
    closeReason ??= `${label}: connection closed`;
    settleAll(closeReason);
    notificationListeners.clear();
    closing ??= Promise.resolve().then(() => transport.close());
    await closing;
    closeListeners.splice(0);
  }

  return {
    request,
    notify,
    onNotification(listener) {
      notificationListeners.add(listener);
      return () => notificationListeners.delete(listener);
    },
    close,
    get closed() {
      return closed;
    },
    onClose(listener) {
      if (closed) {
        listener(closeReason);
        return () => {};
      }
      closeListeners.push(listener);
      return () => {
        const index = closeListeners.indexOf(listener);
        if (index >= 0) closeListeners.splice(index, 1);
      };
    },
  };
}

/**
 * Connect one MCP server and complete the handshake.
 *
 * @param {object} server - server record (`name`, `transport`, plus transport fields).
 * @param {{ requestTimeoutMs?: number, initializeTimeoutMs?: number, signal?: AbortSignal }} [options]
 *   deadlines plus an attempt-scoped abort signal (plugin unload / disable must
 *   settle a handshake against an unresponsive server immediately).
 * @returns {Promise<object>} live connection handle.
 * @throws {McpError} when spawning, transporting or the handshake fails; the
 *   child process/HTTP session is always closed before the rejection.
 */
export async function connect(server, options = {}) {
  const label = `mcp-manager(${server.name})`;
  const requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const initializeTimeoutMs = options.initializeTimeoutMs ?? INITIALIZE_TIMEOUT_MS;
  const signal = options.signal;
  if (signal !== undefined && signal.aborted) {
    throw new McpError(`${label}: connection attempt was canceled`);
  }
  const transport = server.transport === 'http' ? createHttpTransport(server) : createStdioTransport(server);
  const rpc = createRpcConnection(transport, { label, requestTimeoutMs });
  const onAbort = () => {
    void rpc.close();
  };
  if (signal !== undefined) {
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      await rpc.close().catch(() => {});
      throw new McpError(`${label}: connection attempt was canceled`);
    }
  }

  const decorate = (error) => {
    const base = error instanceof Error ? error.message : String(error);
    const tail = cleanStderrTail(transport.stderrTail());
    return new McpError(tail === '' ? base : `${base}\n--- stderr ---\n${tail}`, { cause: error });
  };

  try {
    // `initializeTimeoutMs` bounds the whole handshake — initialize, the
    // `initialized` notification and every `tools/list` page — not just the
    // first request, so a server that answers `initialize` and then stalls
    // cannot hold the connection attempt for the tool timeout.
    const handshake = {
      deadline: Date.now() + initializeTimeoutMs,
      timeoutMs: initializeTimeoutMs,
      label,
    };
    const init = await rpc.request(
      'initialize',
      { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO },
      { timeoutMs: Math.min(initializeTimeoutMs, handshakeTimeLeft(handshake)) },
    );
    if (!isRecord(init)) throw new McpError(`${label}: initialize returned a non-object result`);
    if (!SUPPORTED_PROTOCOL_VERSIONS.includes(init.protocolVersion)) {
      throw new McpError(`${label}: unsupported MCP protocol version ${String(init.protocolVersion)}`);
    }
    transport.setProtocolVersion?.(init.protocolVersion);
    await rpc.notify('notifications/initialized', undefined, {
      timeoutMs: Math.min(requestTimeoutMs, handshakeTimeLeft(handshake)),
    });
    const capabilities = isRecord(init.capabilities) ? init.capabilities : {};
    const listed = capabilities.tools === undefined
      ? { tools: [], warnings: [] }
      : await listAllTools(rpc, requestTimeoutMs, handshake);
    const tools = listed.tools;
    const instructions = typeof init.instructions === 'string' ? init.instructions.slice(0, MAX_INSTRUCTIONS_LENGTH) : undefined;
    signal?.removeEventListener('abort', onAbort);
    return {
      transportKind: transport.kind,
      pid: transport.pid,
      serverInfo: normalizeServerInfo(init.serverInfo),
      protocolVersion: typeof init.protocolVersion === 'string' ? init.protocolVersion : undefined,
      instructions: instructions === '' ? undefined : instructions,
      tools,
      warnings: listed.warnings,
      listTools() {
        return listAllTools(rpc, requestTimeoutMs);
      },
      onToolsChanged(listener) {
        const dispose = rpc.onNotification((method) => {
          if (method === 'notifications/tools/list_changed') listener();
        });
        if (capabilities.tools?.listChanged) transport.listen?.();
        return dispose;
      },
      callTool(rawName, args, signal) {
        return rpc.request('tools/call', { name: rawName, arguments: args ?? {} }, { timeoutMs: requestTimeoutMs, signal });
      },
      onClose(listener) {
        return rpc.onClose(listener);
      },
      async close() {
        await rpc.close();
      },
      get closed() {
        return rpc.closed;
      },
    };
  } catch (error) {
    signal?.removeEventListener('abort', onAbort);
    await rpc.close().catch(() => {});
    throw decorate(error);
  }
}

/**
 * Remaining handshake budget in milliseconds.
 * @param {{ deadline: number, timeoutMs: number, label: string }} handshake - handshake descriptor.
 * @returns {number} milliseconds left, at least 1.
 * @throws {McpError} once the budget is exhausted.
 */
function handshakeTimeLeft(handshake) {
  const left = handshake.deadline - Date.now();
  if (left <= 0) throw new McpError(`${handshake.label}: the MCP handshake did not finish within ${handshake.timeoutMs} ms`);
  return Math.max(1, left);
}

/**
 * Aggregate every `tools/list` page, following `nextCursor`, inside an optional
 * handshake deadline and the catalog caps.
 *
 * @param {object} rpc - live RPC connection.
 * @param {number} requestTimeoutMs - per-request deadline when no handshake bounds it.
 * @param {{ deadline: number, timeoutMs: number, label: string }} [handshake] - whole-handshake budget.
 * @returns {Promise<{ tools: object[], warnings: string[] }>} advertised tools plus non-fatal reports.
 */
async function listAllTools(rpc, requestTimeoutMs, handshake) {
  const scope = handshake === undefined ? 'the MCP server' : handshake.label;
  /** @type {object[]} */
  const tools = [];
  /** @type {string[]} */
  const warnings = [];
  let catalogBytes = 0;
  let cursor;
  const cursors = new Set();
  const budget = () => (handshake === undefined ? requestTimeoutMs : Math.min(requestTimeoutMs, handshakeTimeLeft(handshake)));
  for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
    const result = await rpc.request('tools/list', cursor === undefined ? {} : { cursor }, { timeoutMs: budget() });
    if (!isRecord(result) || !Array.isArray(result.tools)) throw new McpError('Invalid tools/list response');
    for (const tool of result.tools) {
      if (!isRecord(tool) || typeof tool.name !== 'string' || tool.name === '') continue;
      if (tools.length >= MAX_TOOL_COUNT) throw new McpError(`${scope} advertises more than ${MAX_TOOL_COUNT} tools`);
      const bounded = boundToolSchema(tool, warnings, scope);
      catalogBytes += Buffer.byteLength(JSON.stringify(bounded.inputSchema ?? {}), 'utf8');
      if (catalogBytes > MAX_TOOL_CATALOG_BYTES) {
        throw new McpError(`${scope} advertises a tool catalog larger than ${MAX_TOOL_CATALOG_BYTES} bytes`);
      }
      tools.push(bounded);
    }
    cursor = typeof result.nextCursor === 'string' && result.nextCursor !== '' ? result.nextCursor : undefined;
    if (cursor === undefined) return { tools, warnings };
    if (cursors.has(cursor)) throw new McpError('Repeated tools/list cursor');
    cursors.add(cursor);
  }
  throw new McpError('Too many tools/list pages');
}

/**
 * Keep an advertised input schema inside the per-tool budget: an oversized one
 * is dropped (the tool keeps an open parameter object) and reported, so the
 * catalog cannot be used to inflate every Agent's registry.
 *
 * @param {object} tool - raw advertised tool.
 * @param {string[]} warnings - non-fatal report sink.
 * @param {string} scope - label naming the server in the report.
 * @returns {object} the tool, possibly with its schema removed.
 */
function boundToolSchema(tool, warnings, scope) {
  if (tool.inputSchema === undefined || tool.inputSchema === null) return tool;
  let serialized;
  try {
    serialized = JSON.stringify(tool.inputSchema);
  } catch {
    serialized = undefined;
  }
  if (serialized !== undefined && Buffer.byteLength(serialized, 'utf8') <= MAX_TOOL_SCHEMA_BYTES) return tool;
  warnings.push(`${scope}: the input schema of tool "${tool.name}" is larger than ${MAX_TOOL_SCHEMA_BYTES} bytes and was dropped`);
  return { ...tool, inputSchema: undefined };
}

/** Normalize MCP `serverInfo` to the persisted view vocabulary. */
function normalizeServerInfo(value) {
  if (!isRecord(value)) return undefined;
  /** @type {{ name?: string, version?: string }} */
  const info = {};
  if (typeof value.name === 'string' && value.name !== '') info.name = value.name;
  if (typeof value.version === 'string' && value.version !== '') info.version = value.version;
  return info.name === undefined && info.version === undefined ? undefined : info;
}

/**
 * Compute the model-facing public name for one MCP tool: `mcp__<server>__<raw>`
 * with every character outside `[A-Za-z0-9_-]` replaced by `_` and truncation to
 * the 64-character function-name budget.
 *
 * @param {string} serverName - tool namespace.
 * @param {string} rawName - the MCP server's own tool name.
 * @returns {string} normalized public name.
 */
export function sanitizePublicName(serverName, rawName) {
  return `mcp__${serverName}__${rawName}`.replace(INVALID_PUBLIC_NAME_CHARS, '_').slice(0, MAX_PUBLIC_NAME_LENGTH);
}

/**
 * Deterministically allocate public names for one server's tool list,
 * resolving collisions with `_2`, `_3`, … suffixes.
 *
 * @param {string} serverName - tool namespace.
 * @param {string[]} rawNames - raw MCP tool names, in listing order.
 * @returns {string[]} public names aligned with `rawNames`.
 */
export function publicToolNames(serverName, rawNames) {
  const used = new Set();
  return rawNames.map((rawName) => {
    const base = sanitizePublicName(serverName, rawName);
    let candidate = base;
    let suffix = 1;
    while (used.has(candidate)) {
      suffix += 1;
      const tail = `_${suffix}`;
      candidate = `${base.slice(0, MAX_PUBLIC_NAME_LENGTH - tail.length)}${tail}`;
    }
    used.add(candidate);
    return candidate;
  });
}

/**
 * Project an MCP content array into flattened plain text.
 *
 * Text blocks are joined with `\n`; every non-text block becomes a
 * `[<type> content from <tool>]` diagnostic because v1 persists no images.
 *
 * @param {unknown} content - MCP content blocks.
 * @param {string} toolName - raw tool name used in diagnostics.
 * @returns {string} flattened text.
 */
export function flattenContent(content, toolName) {
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
      continue;
    }
    if (isRecord(block) && typeof block.type === 'string' && block.type !== '') {
      parts.push(`[${block.type} content from ${toolName}]`);
      continue;
    }
    parts.push(`[unsupported content from ${toolName}]`);
  }
  return parts.join('\n');
}

/**
 * Keep a usable MCP `inputSchema`; anything that is not an object schema falls
 * back to the empty object schema.
 *
 * @param {unknown} schema - advertised MCP input schema.
 * @returns {object} JSON Schema handed to the tool registry.
 */
function normalizeInputSchema(schema) {
  if (!isRecord(schema)) return { ...EMPTY_INPUT_SCHEMA };
  const normalized = { ...schema };
  if (normalized.type === undefined && isRecord(normalized.properties)) normalized.type = 'object';
  if (normalized.type !== 'object') return { ...EMPTY_INPUT_SCHEMA };
  if (!isRecord(normalized.properties)) normalized.properties = {};
  return normalized;
}

/**
 * Build the Harness `ToolDefinition`s for one ready server.
 *
 * The definitions are pure data plus closures over the live connection; the
 * caller registers them and owns the returned disposers.
 *
 * @param {object} options - bridge inputs.
 * @param {string} options.serverName - tool namespace.
 * @param {object[]} options.tools - raw MCP tools from `tools/list`.
 * @param {(rawName: string, args: object, signal?: AbortSignal) => Promise<object>} options.callTool - `tools/call` invoker.
 * @returns {{ name: string, rawName: string, description: string, definition: object }[]} definitions.
 */
export function buildToolDefinitions({ serverName, tools, callTool }) {
  const rawNames = tools.map((tool) => tool.name);
  const publicNames = publicToolNames(serverName, rawNames);
  return tools.map((tool, index) => {
    const rawName = tool.name;
    const name = publicNames[index];
    const description = typeof tool.description === 'string' && tool.description.trim() !== ''
      ? tool.description
      : `Tool ${rawName} from MCP server ${serverName}`;
    const definition = {
      name,
      description,
      parameters: normalizeInputSchema(tool.inputSchema),
      output: {
        schema: {
          type: 'object',
          properties: {
            content: { type: 'array', items: {} },
            structuredContent: {},
          },
          required: ['content'],
          additionalProperties: false,
        },
        render(_args, value) {
          const content = isRecord(value) && Array.isArray(value.content) ? value.content : [];
          return [{ type: 'text', text: flattenContent(content, rawName) }];
        },
      },
      async execute(args, exec) {
        const callArgs = isRecord(args) ? args : {};
        const result = await callTool(rawName, callArgs, exec?.signal);
        const content = isRecord(result) && Array.isArray(result.content) ? result.content : [];
        const text = flattenContent(content, rawName);
        if (isRecord(result) && result.isError === true) {
          throw new Error(text === '' ? `MCP tool "${rawName}" failed` : text);
        }
        /** @type {Record<string, unknown>} */
        const value = { content };
        if (isRecord(result) && result.structuredContent !== undefined) {
          value.structuredContent = result.structuredContent;
        }
        return value;
      },
    };
    return { name, rawName, description, definition };
  });
}
