/**
 * `@kuhufu/dsh-mcp-manager` — browser half.
 *
 * One Settings section ("MCP servers") over the Host's `api/mcp-manager.*`
 * Fetch routes: list, add/edit, enable, reconnect and delete servers, and show
 * each one's runtime status and the MCP tools it currently bridges.
 *
 * The factory is side-effect free and requires only `react`; styles render as
 * one React `<style>` element inside the root component, so unmounting the
 * section removes them.
 */
window.__ModuleLoader__.load({
  id: '@kuhufu/dsh-mcp-manager',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Dictionary namespace owned by this plugin. */
    const NS = 'settings.mcp-manager';
    /** How often the mounted page refreshes server status. */
    const POLL_MS = 5000;
    /** Relative Fetch routes; they resolve under both the Web server and the desktop carrier. */
    const ROUTES = {
      list: 'api/mcp-manager.list',
      save: 'api/mcp-manager.save',
      remove: 'api/mcp-manager.remove',
      toggle: 'api/mcp-manager.toggle',
      reconnect: 'api/mcp-manager.reconnect',
      takeover: 'api/mcp-manager.takeover',
      ui: 'api/mcp-manager.ui',
      toggleExternal: 'api/mcp-manager.toggle-external',
      import: 'api/mcp-manager.import',
      export: 'api/mcp-manager.export',
      recover: 'api/mcp-manager.recover',
      tool: 'api/mcp-manager.tool',
    };
    /** Tool names are registered as `mcp__<server>__<tool>`; the UI only needs the prefix. */
    const TOOL_PREFIX = 'mcp__';
    /** Host validation rules, mirrored for inline form errors. */
    const NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;
    const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
    const HEADER_KEY_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

    /** Mirror Host validation without importing Node code; parity is regression-tested. */
    const CONNECTION_OPTIONS = {
      requestTimeoutMs: { min: 1000, max: 600000, default: 60000 },
      initializeTimeoutMs: { min: 1000, max: 300000, default: 30000 },
      retryCount: { min: 0, max: 10, default: 0 },
    };

    // ── dictionaries ──────────────────────────────────────────────────────
    /** English copy. */
    const en = {
      storageSkipped: "Skipped {count} invalid or duplicate record(s). Valid servers remain available; the original file will be archived before the next save.",
      fileTooLarge: "Choose a JSON file smaller than 2 MB.",
      search: "Search servers",
      filter: "Filter by status",
      all: "All statuses",
      noMatches: "No servers match these filters.",
      copy: "Duplicate {name}",
      advanced: "Connection options",
      requestTimeoutMs: "Tool timeout (ms)",
      initializeTimeoutMs: "Handshake timeout (ms)",
      retryCount: "Automatic retries (0–10)",
      retryHint: "0 disables automatic retries. Retries use exponential backoff, at most 30 seconds apart. Manual reconnect resets the limit.",
      errNumber: "Enter an integer from {min} to {max}.",
      logs: "Recent activity",
      noLogs: "No connection activity yet.",
      nextRetry: "Next retry",
      protocol: "Protocol version",
      enableTool: "Enable tool {name}",
      disableTool: "Disable tool {name}",
      configTransfer: "Import / export configuration",
      jsonConfig: "JSON configuration",
      importConfig: "Import as disabled servers",
      exportConfig: "Export configuration",
      includeSecrets: "Include environment variables and request headers",
      secretsHint: "Exports with this option contain credentials in plain text. Store them carefully.",
      importHint: "Paste a servers array, an exported document, or an mcpServers object. Existing names are rejected. Imported servers remain disabled until you enable them.",
      importPreview: "{count} server(s) in this document",
      jsonInvalid: "Enter valid JSON.",
      importDone: "Imported {count} disabled server(s).",
      download: "Download JSON",
      chooseFile: "Load JSON file",
      storageProblem: "Configuration could not be loaded. Changes are locked to preserve the original file.",
      restoreBackup: "Restore previous backup",
      resetStorage: "Start with an empty configuration",
      recoverConfirm: "Continue? The current file will be archived before recovery.",
      refreshStatus: "Refresh status",
      exportHint: "Environment variables and headers are omitted by default. Refill them before enabling imported servers.",

      nav: 'MCP servers',
      title: 'MCP servers',
      intro:
        'Connect Model Context Protocol servers so their tools become available to the agent. Changes take effect immediately.',
      add: 'Add server',
      refresh: 'Refresh status',
      refreshing: 'Refreshing…',
      loading: 'Loading servers…',
      emptyTitle: 'No MCP servers yet',
      emptyHint: 'Add a local command or an HTTP endpoint to expose its tools to the agent.',
      emptyAction: 'Add your first server',
      retry: 'Retry',
      dismiss: 'Dismiss',
      statusReady: 'Ready',
      statusConnecting: 'Connecting…',
      statusError: 'Connection failed',
      statusStopped: 'Stopped',
      statusDisabled: 'Disabled',
      toolCount: 'Tools {count}',
      externalTitle: 'Configured as dsh-mcp-client entries',
      externalHint:
        'These servers are separate @deepseek-ai/dsh-mcp-client entries from a bundle or cordis.patch.yml. Switch one on or off here, or migrate it to this page to edit its configuration — connecting a second copy without migrating would collide on tool names.',
      externalActive: 'Active',
      takeover: 'Migrate here',
      externalShadowed: 'Managed here',
      externalShadowedHint:
        '{name} is managed on this page, so its dsh-mcp-client row cannot be switched on — that would collide on tool names.',
      takeoverBusy: 'Migrating…',
      takeoverConfirm: 'Migrate "{name}" to this page and disable its dsh-mcp-client entry?',
      takeoverConfirmHint:
        'Its configuration is copied into this page\'s storage — environment values and headers included, as plain text.',
      takeoverConfirmAction: 'Migrate',
      showTools: 'Show tools',
      hideTools: 'Hide tools',
      toolsEmpty: 'This server declares no tools.',
      toolsHint: 'Registered for the agent as {prefix}__<tool>.',
      instructions: 'Server instructions',
      lastError: 'Last error',
      errorLine: '{label}: {message}',
      duplicateHint:
        'Another MCP connection already owns these tool names. Disable that entry (or migrate it here from the read-only list below) and press reconnect.',
      labelCwd: 'Working directory',
      labelConnected: 'Connected',
      enable: 'Enable {name}',
      disable: 'Disable {name}',
      reconnect: 'Reconnect {name}',
      edit: 'Edit {name}',
      remove: 'Delete {name}',
      cancel: 'Cancel',
      confirmDelete: 'Delete',
      deleteConfirm: 'Delete “{name}”?',
      deleteConfirmHint: 'Its tools are removed from the agent immediately. This cannot be undone.',
      save: 'Save',
      saving: 'Saving…',
      addTitle: 'Add MCP server',
      editTitle: 'Edit {name}',
      closeDialog: 'Close',
      fieldName: 'Name',
      fieldNameHint: 'Tool namespace: 1–32 letters, digits, underscores or dashes, unique across servers.',
      fieldTransport: 'Transport',
      fieldCommand: 'Command',
      fieldCommandHint: 'Executable to launch, for example npx.',
      fieldArgs: 'Arguments',
      fieldArgsHint: 'One argument per line.',
      fieldEnv: 'Environment variables',
      fieldEnvHint: 'One KEY=VALUE per line, merged over the process environment.',
      fieldCwd: 'Working directory',
      fieldCwdHint: 'Optional. Defaults to the app process directory.',
      fieldUrl: 'URL',
      fieldUrlHint: 'Full http(s) endpoint, for example https://example.com/mcp.',
      fieldHeaders: 'Headers',
      fieldHeadersHint: 'One KEY=VALUE per line.',
      transportStdio: 'Local command (stdio)',
      transportHttp: 'HTTP endpoint',
      shortStdio: 'stdio',
      shortHttp: 'http',
      labelUrl: 'URL',
      versionShort: 'v{version}',
      optional: 'optional',
      errName: 'Use 1–32 letters, digits, underscores or dashes.',
      errNameDuplicate: 'Another server already uses this name.',
      errCommand: 'Enter the command to launch.',
      errUrl: 'Enter a full URL starting with http:// or https://.',
      errLineFormat: 'Line {line}: expected KEY=VALUE.',
      errLineKey: 'Line {line}: names may contain only letters, digits and underscores.',
      errLineHeader: 'Line {line}: header names may not contain spaces or separators.',
      errOverridden:
        'This row is declared more than once in the profile patch, so the profile layer cannot change it. Remove the duplicate entry, or move the disabled row after its insert.',
      errNetwork: 'Could not reach the host service.',
      errInternal: 'The host reported an error.',
      errLoad: 'Could not load the server list.',
      railLabel: 'Show in the sidebar',
      railHint: 'Adds this page as a panel in the left rail; turning it off keeps Settings → MCP servers.',
    };
    /** Simplified Chinese copy. */
    const zh = {
      storageSkipped: "已跳过 {count} 条无效或重复记录，其余服务器仍可使用；下次保存前会先归档原文件。",
      fileTooLarge: "请选择小于 2 MB 的 JSON 文件。",
      search: "搜索服务器",
      filter: "按状态筛选",
      all: "全部状态",
      noMatches: "没有符合筛选条件的服务器。",
      copy: "复制 {name}",
      advanced: "连接选项",
      requestTimeoutMs: "工具调用超时（毫秒）",
      initializeTimeoutMs: "握手超时（毫秒）",
      retryCount: "自动重试次数（0–10）",
      retryHint: "0 表示不自动重连。重试间隔逐次增加，最长 30 秒；手动重连会重置次数。",
      errNumber: "请输入 {min} 到 {max} 之间的整数。",
      logs: "近期活动",
      noLogs: "暂无连接活动。",
      nextRetry: "下次重试",
      protocol: "协议版本",
      enableTool: "启用工具 {name}",
      disableTool: "停用工具 {name}",
      configTransfer: "导入 / 导出配置",
      jsonConfig: "JSON 配置",
      importConfig: "导入为停用的服务器",
      exportConfig: "导出配置",
      includeSecrets: "包含环境变量和请求头",
      secretsHint: "勾选后，导出的文件会包含明文凭据，请妥善保存。",
      importHint: "粘贴服务器数组、导出的配置或 mcpServers 对象。名称重复时整批拒绝，导入后需手动启用。",
      importPreview: "文档包含 {count} 个服务器",
      jsonInvalid: "请输入有效的 JSON。",
      importDone: "已导入 {count} 个服务器，当前均已停用。",
      download: "下载 JSON",
      chooseFile: "读取 JSON 文件",
      storageProblem: "配置无法读取。为保留原文件，当前已锁定修改。",
      restoreBackup: "恢复上一次备份",
      resetStorage: "使用空配置重新开始",
      recoverConfirm: "确认继续？恢复前会先归档当前文件。",
      refreshStatus: "刷新状态",
      exportHint: "默认不导出环境变量和请求头；导入后请补全这些字段再启用。",

      nav: 'MCP 服务器',
      title: 'MCP 服务器',
      intro: '连接 Model Context Protocol 服务器，把它们的工具提供给智能体使用。改动立即生效。',
      add: '添加服务器',
      refresh: '刷新状态',
      refreshing: '刷新中…',
      loading: '正在加载服务器…',
      emptyTitle: '还没有配置 MCP 服务器',
      emptyHint: '添加本地命令或 HTTP 端点，即可把它的工具交给智能体使用。',
      emptyAction: '添加第一个服务器',
      retry: '重试',
      dismiss: '关闭提示',
      statusReady: '已就绪',
      statusConnecting: '连接中…',
      statusError: '连接失败',
      statusStopped: '已停止',
      statusDisabled: '已停用',
      toolCount: '工具 {count}',
      externalTitle: '通过 dsh-mcp-client 配置的服务器',
      externalHint:
        '这些服务器是 bundle 或 cordis.patch.yml 里独立的 @deepseek-ai/dsh-mcp-client 条目：可以在这里直接启用/停用，或点「迁到此页」搬到本页以便改配置。直接再加一份连接会和已有工具命名冲突。',
      externalActive: '运行中',
      takeover: '迁到此页',
      externalShadowed: '已在本页管理',
      externalShadowedHint:
        '「{name}」已由本页管理，不能再启用它的 dsh-mcp-client 条目，否则工具名会冲突。',
      takeoverBusy: '迁移中…',
      takeoverConfirm: '把「{name}」迁到本页，并停用它的 dsh-mcp-client 条目？',
      takeoverConfirmHint: '配置会复制到本页存储——包括环境变量和请求头，明文保存。',
      takeoverConfirmAction: '迁移',
      showTools: '查看工具',
      hideTools: '收起工具',
      toolsEmpty: '该服务器没有声明任何工具。',
      toolsHint: '工具以 {prefix}__<工具名> 注册给智能体。',
      instructions: '服务器说明',
      lastError: '最近错误',
      errorLine: '{label}：{message}',
      duplicateHint:
        '同一批工具名已被另一条 MCP 连接占用：先停用那条条目（或在下方只读列表里点「迁到此页」接管），再点重连。',
      labelCwd: '工作目录',
      labelConnected: '连接时间',
      enable: '启用 {name}',
      disable: '停用 {name}',
      reconnect: '重新连接 {name}',
      edit: '编辑 {name}',
      remove: '删除 {name}',
      cancel: '取消',
      confirmDelete: '删除',
      deleteConfirm: '删除“{name}”？',
      deleteConfirmHint: '它的工具会立即从智能体中移除，此操作无法撤销。',
      save: '保存',
      saving: '保存中…',
      addTitle: '添加 MCP 服务器',
      editTitle: '编辑 {name}',
      closeDialog: '关闭',
      fieldName: '名称',
      fieldNameHint: '工具命名空间：1–32 个字母、数字、下划线或短横线，且不可与其他服务器重名。',
      fieldTransport: '连接方式',
      fieldCommand: '命令',
      fieldCommandHint: '要启动的可执行文件，例如 npx。',
      fieldArgs: '参数',
      fieldArgsHint: '每行一个参数。',
      fieldEnv: '环境变量',
      fieldEnvHint: '每行一个 KEY=VALUE，会覆盖进程环境。',
      fieldCwd: '工作目录',
      fieldCwdHint: '可选。默认为应用进程所在目录。',
      fieldUrl: 'URL',
      fieldUrlHint: '完整的 http(s) 地址，例如 https://example.com/mcp。',
      fieldHeaders: '请求头',
      fieldHeadersHint: '每行一个 KEY=VALUE。',
      transportStdio: '本地命令（stdio）',
      transportHttp: 'HTTP 端点',
      shortStdio: 'stdio',
      shortHttp: 'http',
      labelUrl: 'URL',
      versionShort: 'v{version}',
      optional: '可选',
      errName: '请使用 1–32 个字母、数字、下划线或短横线。',
      errNameDuplicate: '已有其他服务器使用该名称。',
      errOverridden:
        '这条配置在 profile patch 里被声明了两次（一个禁用的覆盖行写在后面的 insert 之前），profile 层改不动它。删掉重复条目，或把禁用行挪到 insert 之后。',
      errCommand: '请填写要启动的命令。',
      errUrl: '请填写以 http:// 或 https:// 开头的完整地址。',
      errLineFormat: '第 {line} 行：应为 KEY=VALUE 格式。',
      errLineKey: '第 {line} 行：名称只能包含字母、数字和下划线。',
      errLineHeader: '第 {line} 行：请求头名称不能包含空格或分隔符。',
      errNetwork: '无法连接宿主服务。',
      errInternal: '宿主返回了错误。',
      errLoad: '无法读取服务器列表。',
      railLabel: '在左侧栏显示入口',
      railHint: '把本页作为面板加入左侧栏；关闭后仍保留“设置 → MCP 服务器”。',
    };

    // ── wire helpers ──────────────────────────────────────────────────────
    /** A route failure in the Host's documented error shape, or a transport failure. */
    class ApiError extends Error {
      /**
       * @param code - `invalid`/`duplicate-name`/`not-found`/`internal`, or `network`.
       * @param message - Host-authored detail when available.
       * @param field - form field the Host blames, when it names one.
       */
      constructor(code, message, field) {
        super(message);
        this.name = 'ApiError';
        this.code = code;
        this.field = field;
      }
    }

    /**
     * POST one JSON route and unwrap its `ok` envelope.
     * @param route - relative route path from {@link ROUTES}.
     * @param body - JSON request body.
     * @returns the parsed success payload.
     * @throws {ApiError} on transport failure, `ok: false`, or an unparsable body.
     */
    async function post(route, body, signal) {
      let response;
      try {
        response = await fetch(route, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          cache: 'no-store',
          credentials: 'same-origin',
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000),
        });
      } catch (error) {
        throw new ApiError('network', error && error.message ? String(error.message) : 'network error');
      }
      let payload = null;
      try {
        payload = await response.json();
      } catch (error) {
        payload = null;
      }
      if (payload && payload.ok === true) return payload;
      const failure = payload && payload.error;
      if (failure) throw new ApiError(failure.code || 'internal', failure.message || '', failure.field);
      throw new ApiError('internal', 'HTTP ' + response.status);
    }

    /**
     * Render one visible failure message for a route error.
     * @param error - anything a route call threw.
     * @param t - bound translator.
     * @returns the message the banner or notice shows.
     */
    function explain(error, t) {
      if (error instanceof ApiError) {
        if (error.code === 'network') return t('errNetwork');
        if (error.code === 'overridden') return t('errOverridden');
        if (error.message) return error.message;
        return t('errInternal');
      }
      return error && error.message ? String(error.message) : t('errInternal');
    }

    /** Fill `{name}` placeholders the way the Client locale runtime does. */
    function interpolate(template, params) {
      return template.replace(/\{(\w+)\}/g, (match, name) =>
        params && name in params ? String(params[name]) : match,
      );
    }

    /**
     * A local translator used when the slot passes no bound `t` (the contract's fallback).
     * @returns a `t(key, params)` reader over this page's own dictionaries.
     */
    function directTranslator() {
      let dictionary = en;
      try {
        const language = typeof navigator !== 'undefined' && navigator.language ? navigator.language : '';
        if (/^zh/i.test(language)) dictionary = zh;
      } catch (error) {
        dictionary = en;
      }
      const chosen = dictionary;
      return (key, params) => {
        const template = chosen[key] !== undefined ? chosen[key] : en[key] !== undefined ? en[key] : key;
        return params ? interpolate(template, params) : template;
      };
    }

    // ── model helpers ─────────────────────────────────────────────────────
    /** The status dot/voice of one server: its runtime phase, or `idle`. */
    function phaseOf(server) {
      if (!server.enabled) return 'disabled';
      if (server.status === 'ready') return 'ready';
      if (server.status === 'connecting') return 'connecting';
      if (server.status === 'error') return 'error';
      return 'stopped';
    }

    /** Dot colour bucket per phase (theme tokens pick the exact colour). */
    const DOT_STATE = {
      ready: 'ready',
      connecting: 'connecting',
      error: 'error',
      stopped: 'idle',
      disabled: 'idle',
    };

    /** Translation key of a phase's voice. */
    const PHASE_KEY = {
      ready: 'statusReady',
      connecting: 'statusConnecting',
      error: 'statusError',
      stopped: 'statusStopped',
      disabled: 'statusDisabled',
    };

    /** One-line transport summary: the command line, or the endpoint. */
    function transportSummary(server) {
      if (server.transport === 'http') return server.url || '';
      const parts = [];
      if (server.command) parts.push(server.command);
      const args = Array.isArray(server.args) ? server.args : [];
      for (const arg of args) parts.push(arg);
      return parts.join(' ');
    }

    /** True for an absolute http(s) URL, the Host's rule for `transport: "http"`. */
    function isHttpUrl(value) {
      if (typeof value !== 'string' || value === '') return false;
      if (!/^https?:\/\//i.test(value)) return false;
      try {
        const parsed = new URL(value);
        return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host !== '';
      } catch (error) {
        return false;
      }
    }

    /** Split a textarea into lines, dropping blank lines and trailing carriage returns. */
    function splitLines(text) {
      if (typeof text !== 'string' || text === '') return [];
      return text
        .split('\n')
        .map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
        .filter((line) => line.trim() !== '');
    }

    /** Render an env/headers record back into the textarea form. */
    function pairsToText(record) {
      if (!record || typeof record !== 'object') return '';
      return Object.keys(record)
        .map((key) => key + '=' + String(record[key]))
        .join('\n');
    }

    /**
     * Parse `KEY=VALUE` lines, reporting the first malformed line as a field error.
     * Duplicate keys follow object semantics (the last one wins), like the Host.
     * @param text - textarea contents.
     * @param keyPattern - the Host's key rule for this map (`env` or `headers`).
     * @param keyError - dictionary key naming that rule, for the inline error.
     * @param t - bound translator.
     * @returns the record, or `undefined` plus an error message on the field.
     */
    function parsePairs(text, keyPattern, keyError, t) {
      const lines = splitLines(text);
      const record = {};
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        const at = line.indexOf('=');
        if (at < 0) return { error: t('errLineFormat', { line: index + 1 }) };
        const key = line.slice(0, at).trim();
        const value = line.slice(at + 1);
        if (key === '') return { error: t('errLineFormat', { line: index + 1 }) };
        if (!keyPattern.test(key)) return { error: t(keyError, { line: index + 1 }) };
        record[key] = value;
      }
      return { value: Object.keys(record).length > 0 ? record : undefined };
    }

    /** A local, human-readable timestamp for the details panel. */
    function formatWhen(milliseconds) {
      try {
        return new Date(milliseconds).toLocaleString();
      } catch (error) {
        return '';
      }
    }

    /** The editable draft of one server, independent of what the Host persisted. */
    function draftOf(server) {
      return {
        name: server ? server.name : '',
        transport: server && server.transport === 'http' ? 'http' : 'stdio',
        enabled: server ? server.enabled !== false : true,
        command: server && server.command ? server.command : '',
        args: server && Array.isArray(server.args) ? server.args.join('\n') : '',
        env: server ? pairsToText(server.env) : '',
        cwd: server && server.cwd ? server.cwd : '',
        url: server && server.url ? server.url : '',
        headers: server ? pairsToText(server.headers) : '',
        ...Object.fromEntries(Object.entries(CONNECTION_OPTIONS).map(([key, rule]) => [key, String(server?.[key] ?? rule.default)])),
        disabledTools: server?.disabledTools ?? [],
      };
    }

    /**
     * Mirror the Host's validation rules before saving.
     * @param draft - the dialog's current values.
     * @param others - the other servers, for the name-uniqueness rule.
     * @param t - bound translator.
     * @returns `{ input }` when valid, else `{ errors }` keyed by field.
     */
    function validateDraft(draft, others, t) {
      const errors = {};
      const name = draft.name.trim();
      if (!NAME_RE.test(name)) errors.name = t('errName');
      else if (others.some((server) => server.name === name)) errors.name = t('errNameDuplicate');

      const input = { name, enabled: draft.enabled, transport: draft.transport };
      if (draft.transport === 'http') {
        const url = draft.url.trim();
        if (!isHttpUrl(url)) errors.url = t('errUrl');
        else input.url = url;
        const headers = parsePairs(draft.headers, HEADER_KEY_RE, 'errLineHeader', t);
        if (headers.error) errors.headers = headers.error;
        else if (headers.value) input.headers = headers.value;
      } else {
        const command = draft.command.trim();
        if (command === '') errors.command = t('errCommand');
        else input.command = command;
        input.args = splitLines(draft.args);
        const env = parsePairs(draft.env, ENV_KEY_RE, 'errLineKey', t);
        if (env.error) errors.env = env.error;
        else if (env.value) input.env = env.value;
        const cwd = draft.cwd.trim();
        if (cwd !== '') input.cwd = cwd;
      }
      for (const [field, { min, max }] of Object.entries(CONNECTION_OPTIONS)) {
        const value = Number(draft[field]);
        if (draft[field] === '' || !Number.isInteger(value) || value < min || value > max) errors[field] = t('errNumber', { min, max });
        else input[field] = value;
      }
      input.disabledTools = draft.disabledTools;
      const keys = Object.keys(errors);
      return keys.length === 0 ? { input, errors } : { input: null, errors };
    }

    // ── icons ─────────────────────────────────────────────────────────────
    /** Stroke icons on a 24px grid; `currentColor` keeps them theme-driven. */
    const ICONS = {
      plus: ['M12 5v14M5 12h14'],
      copy: ['M8 8h13v13H8Z', 'M16 8V3H3v13h5'],
      refresh: [
        'M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8',
        'M21 3v5h-5',
        'M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16',
        'M8 16H3v5',
      ],
      link: [
        'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71',
        'M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71',
      ],
      pencil: ['M12 20h9', 'M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z'],
      trash: [
        'M3 6h18',
        'M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2',
        'M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6',
        'M10 11v6M14 11v6',
      ],
      chevron: ['M6 9l6 6 6-6'],
      close: ['M18 6 6 18M6 6l12 12'],
      alert: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z', 'M12 8v4', 'M12 16h.01'],
      check: ['M20 6 9 17l-5-5'],
      server: [
        'M4 3h16a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z',
        'M4 14h16a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2Z',
        'M6 6.5h.01M6 17.5h.01',
      ],
    };

    /** One inline icon; decorative unless the caller names it. */
    function Icon(props) {
      const size = props.size || 16;
      const paths = ICONS[props.name] || [];
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
          className: 'dshmcp-icon',
        },
        paths.map((d, index) => h('path', { key: index, d })),
      );
    }

    // ── small presentational pieces ───────────────────────────────────────
    /** The status dot; the phase's text next to it carries the meaning. */
    function StatusDot(props) {
      return h('span', {
        className: 'dshmcp-dot',
        'data-state': DOT_STATE[props.phase] || 'idle',
        'aria-hidden': 'true',
      });
    }

    /**
     * A `role="switch"` toggle on a fixed 36x20 track. Its busy state draws the
     * spinner inside the track, so a pending write never resizes the row it sits in.
     * @param props - `checked`, `busy`/`disabled`, the accessible name (`label` or
     *   `labelledBy` + `describedBy`) and `onChange`.
     */
    function SwitchButton(props) {
      const naming = {};
      if (props.labelledBy) {
        naming['aria-labelledby'] = props.labelledBy;
        if (props.describedBy) naming['aria-describedby'] = props.describedBy;
      } else {
        naming['aria-label'] = props.label;
        naming.title = props.label;
      }
      return h(
        'button',
        Object.assign(
          {
            type: 'button',
            role: 'switch',
            'aria-checked': props.checked ? 'true' : 'false',
            'aria-busy': props.busy ? 'true' : undefined,
            className: 'dshmcp-switch',
            disabled: props.disabled,
            onClick: props.onChange,
          },
          naming,
        ),
      );
    }

    /** A row's enable control, named after the server it switches. */
    function EnableSwitch(props) {
      return h(SwitchButton, {
        checked: props.checked,
        busy: props.busy,
        disabled: props.disabled,
        label: props.t(props.checked ? 'disable' : 'enable', { name: props.name }),
        onChange: props.onChange,
      });
    }

    /** One labelled control: label, control, then its hint or its error (never both). */
    function Field(props) {
      return h(
        'div',
        { className: 'dshmcp-field' },
        h(
          'label',
          { className: 'dshmcp-label', htmlFor: props.id },
          props.label,
          props.optionalLabel ? h('span', { className: 'dshmcp-optional' }, props.optionalLabel) : null,
        ),
        props.children,
        props.error
          ? h('p', { className: 'dshmcp-field-error', id: props.id + '-error' }, props.error)
          : props.hint
            ? h('p', { className: 'dshmcp-field-hint', id: props.id + '-hint' }, props.hint)
            : null,
      );
    }

    /** The banner stack above the list: load failures and mutation outcomes. */
    function Banners(props) {
      const t = props.t;
      if (!props.loadError && !props.notice) return null;
      const nodes = [];
      if (props.loadError) {
        nodes.push(
          h(
            'div',
            { key: 'load', className: 'dshmcp-banner', 'data-tone': 'error', role: 'alert' },
            h(Icon, { name: 'alert', size: 16 }),
            h(
              'div',
              { className: 'dshmcp-banner-body' },
              h('p', { className: 'dshmcp-banner-text' }, props.loadError.text),
              props.loadError.detail
                ? h('p', { className: 'dshmcp-banner-detail' }, props.loadError.detail)
                : null,
            ),
            h(
              'button',
              { type: 'button', className: 'dshmcp-btn dshmcp-btn-small', onClick: props.onRetry },
              t('retry'),
            ),
          ),
        );
      }
      if (props.notice) {
        const tone = props.notice.tone === 'error' ? 'error' : 'ok';
        nodes.push(
          h(
            'div',
            {
              key: 'notice',
              className: 'dshmcp-banner',
              'data-tone': tone,
              role: tone === 'error' ? 'alert' : 'status',
            },
            h(Icon, { name: tone === 'error' ? 'alert' : 'check', size: 16 }),
            h('p', { className: 'dshmcp-banner-text' }, props.notice.text),
            tone === 'error'
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'dshmcp-btn dshmcp-btn-small',
                    onClick: props.onDismiss,
                  },
                  t('dismiss'),
                )
              : null,
          ),
        );
      }
      return h('div', { className: 'dshmcp-banners' }, nodes);
    }

    /** Placeholder rows while the first list call is in flight. */
    function SkeletonRows(props) {
      const rows = [0, 1, 2];
      return h(
        'div',
        { className: 'dshmcp-skeleton', role: 'status', 'aria-label': props.t('loading') },
        rows.map((row) =>
          h(
            'div',
            { key: row, className: 'dshmcp-skeleton-row' },
            h('span', { className: 'dshmcp-skeleton-dot' }),
            h(
              'span',
              { className: 'dshmcp-skeleton-lines' },
              h('span', { className: 'dshmcp-skeleton-line', style: { width: row === 1 ? '34%' : '26%' } }),
              h('span', {
                className: 'dshmcp-skeleton-line dshmcp-skeleton-line-soft',
                style: { width: row === 2 ? '58%' : '44%' },
              }),
            ),
          ),
        ),
      );
    }

    /** The first-run state: what this page does and the one action that starts it. */
    function EmptyState(props) {
      return h(
        'div',
        { className: 'dshmcp-empty' },
        h('span', { className: 'dshmcp-empty-icon' }, h(Icon, { name: 'server', size: 26 })),
        h('p', { className: 'dshmcp-empty-title' }, props.t('emptyTitle')),
        h('p', { className: 'dshmcp-empty-hint' }, props.t('emptyHint')),
        h(
          'button',
          { type: 'button', className: 'dshmcp-btn', 'data-variant': 'primary', onClick: props.onAdd },
          h(Icon, { name: 'plus' }),
          props.t('emptyAction'),
        ),
      );
    }

    /**
     * The page-level preference row: whether this page also gets a left-rail entry.
     * The switch keeps its fixed track while the write is in flight, so the row
     * never changes height (only a spinner appears inside the track).
     * @param props - `checked` (the Host's `ui.railEntry`), `busy` and `onChange`.
     */
    function RailPreferenceRow(props) {
      const t = props.t;
      const uid = React.useId().replace(/[^A-Za-z0-9_-]/g, '');
      const labelId = 'dshmcp-rail-label-' + uid;
      const hintId = 'dshmcp-rail-hint-' + uid;
      return h(
        'div',
        { className: 'dshmcp-pref' },
        h(
          'div',
          { className: 'dshmcp-pref-text' },
          h('span', { className: 'dshmcp-pref-label', id: labelId }, t('railLabel')),
          h('span', { className: 'dshmcp-pref-hint', id: hintId }, t('railHint')),
        ),
        h(SwitchButton, {
          checked: props.checked,
          busy: props.busy,
          disabled: props.busy,
          labelledBy: labelId,
          describedBy: hintId,
          onChange: props.onChange,
        }),
      );
    }

    /** Rows for MCP servers still owned by other `dsh-mcp-client` entries; each can be migrated here. */
    function ExternalList(props) {
      const t = props.t;
      const [confirmId, setConfirmId] = React.useState(null);
      return h(
        'div',
        { className: 'dshmcp-external' },
        h('h3', { className: 'dshmcp-subtitle' }, t('externalTitle')),
        h('p', { className: 'dshmcp-hint' }, t('externalHint')),
        h(
          'ul',
          { className: 'dshmcp-list' },
          props.items.map((item) => {
            const name = item.serverName || item.entryId || 'mcp-client';
            const http = item.transport === 'streamable-http';
            const summary = http
              ? item.url || ''
              : [item.command, ...(Array.isArray(item.args) ? item.args : [])].filter(Boolean).join(' ');
            const busy = props.busyIds.has(item.entryId);
            const confirming = confirmId === item.entryId;
            return h(
              'li',
              { key: item.entryId || name, className: 'dshmcp-row' },
              h(
                'div',
                { className: 'dshmcp-line' },
                h(
                  'div',
                  { className: 'dshmcp-main' },
                  h(
                    'div',
                    { className: 'dshmcp-name-row' },
                    h('span', { className: 'dshmcp-name' }, name),
                    h(
                      'span',
                      { className: 'dshmcp-state' },
                      item.enabled ? t('externalActive') : t('statusDisabled'),
                    ),
                  ),
                  summary ? h('span', { className: 'dshmcp-summary', title: summary }, summary) : null,
                  h(
                    'div',
                    { className: 'dshmcp-meta' },
                    h('span', { className: 'dshmcp-chip' }, t(http ? 'shortHttp' : 'shortStdio')),
                    h('span', null, t('toolCount', { count: item.toolCount || 0 })),
                    item.shadowed ? h('span', { className: 'dshmcp-chip' }, t('externalShadowed')) : null,
                    item.entryId ? h('span', { className: 'dshmcp-mono' }, item.entryId) : null,
                  ),
                ),
                h(
                  'div',
                  { className: 'dshmcp-actions dshmcp-actions-spaced' },
                  h(SwitchButton, {
                    checked: item.enabled !== false,
                    busy,
                    disabled: busy || item.shadowed === true,
                    label: item.shadowed === true
                      ? t('externalShadowedHint', { name })
                      : t(item.enabled !== false ? 'disable' : 'enable', { name }),
                    onChange: () => props.onToggle(item),
                  }),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dshmcp-btn dshmcp-btn-small',
                      disabled: busy || confirming,
                      'aria-busy': busy ? 'true' : undefined,
                      onClick: () => setConfirmId(item.entryId),
                    },
                    h(
                      'span',
                      { className: 'dshmcp-btn-stack' },
                      h('span', null, busy ? t('takeoverBusy') : t('takeover')),
                      h(
                        'span',
                        { className: 'dshmcp-btn-ghost', 'aria-hidden': 'true' },
                        busy ? t('takeover') : t('takeoverBusy'),
                      ),
                    ),
                  ),
                ),
              ),
              confirming
                ? h(
                    'div',
                    {
                      className: 'dshmcp-confirm',
                      role: 'group',
                      'aria-label': t('takeoverConfirm', { name }),
                      onKeyDown: (event) => {
                        if (event.key === 'Escape') {
                          event.preventDefault();
                          event.stopPropagation();
                          setConfirmId(null);
                        }
                      },
                    },
                    h(Icon, { name: 'alert', size: 16 }),
                    h(
                      'div',
                      { className: 'dshmcp-confirm-body' },
                      h('p', { className: 'dshmcp-confirm-text' }, t('takeoverConfirm', { name })),
                      h('p', { className: 'dshmcp-confirm-hint' }, t('takeoverConfirmHint')),
                    ),
                    h(
                      'div',
                      { className: 'dshmcp-confirm-actions' },
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'dshmcp-btn dshmcp-btn-small',
                          onClick: () => setConfirmId(null),
                        },
                        t('cancel'),
                      ),
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'dshmcp-btn dshmcp-btn-small',
                          'data-variant': 'primary',
                          disabled: busy,
                          onClick: () => {
                            setConfirmId(null);
                            props.onTakeover(item);
                          },
                        },
                        t('takeoverConfirmAction'),
                      ),
                    ),
                  )
                : null,
            );
          }),
        ),
      );
    }

    /** The inline delete confirmation, focused on its safe choice. */
    function ConfirmBar(props) {
      const t = props.t;
      const cancelRef = React.useRef(null);
      React.useEffect(() => {
        if (cancelRef.current) cancelRef.current.focus();
      }, []);
      return h(
        'div',
        {
          className: 'dshmcp-confirm',
          role: 'group',
          'aria-label': t('deleteConfirm', { name: props.name }),
          onKeyDown: (event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              props.onCancel();
            }
          },
        },
        h(Icon, { name: 'alert', size: 16 }),
        h(
          'div',
          { className: 'dshmcp-confirm-body' },
          h('p', { className: 'dshmcp-confirm-text' }, t('deleteConfirm', { name: props.name })),
          h('p', { className: 'dshmcp-confirm-hint' }, t('deleteConfirmHint')),
        ),
        h(
          'div',
          { className: 'dshmcp-confirm-actions' },
          h(
            'button',
            {
              type: 'button',
              ref: cancelRef,
              className: 'dshmcp-btn dshmcp-btn-small',
              onClick: props.onCancel,
            },
            t('cancel'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dshmcp-btn dshmcp-btn-small',
              'data-variant': 'danger',
              disabled: props.busy,
              onClick: props.onConfirm,
            },
            t('confirmDelete'),
          ),
        ),
      );
    }

    /** The expandable detail of one server: its tools, instructions and endpoints. */
    function ServerDetails(props) {
      const t = props.t;
      const server = props.server;
      const tools = Array.isArray(server.tools) ? server.tools : [];
      const rows = [];
      if (server.transport === 'stdio' && server.cwd) {
        rows.push([t('labelCwd'), server.cwd]);
      }
      if (server.transport === 'http' && server.url) {
        rows.push([t('labelUrl'), server.url]);
      }
      if (server.protocolVersion) rows.push([t('protocol'), server.protocolVersion]);
      if (server.nextRetryAt) rows.push([t('nextRetry'), formatWhen(server.nextRetryAt)]);
      if (server.connectedAt) {
        rows.push([t('labelConnected'), formatWhen(server.connectedAt)]);
      }
      return h(
        'div',
        { className: 'dshmcp-details', id: props.id },
        h('p', { className: 'dshmcp-hint' }, t('toolsHint', { prefix: TOOL_PREFIX + server.name })),
        tools.length === 0
          ? h('p', { className: 'dshmcp-hint' }, t('toolsEmpty'))
          : h(
              'ul',
              { className: 'dshmcp-tools' },
              tools.map((tool, index) =>
                h(
                  'li',
                  { key: (tool && tool.name ? tool.name : 'tool') + ':' + index, className: 'dshmcp-tool' },
                  h('code', { className: 'dshmcp-tool-name' }, tool.publicName || tool.name),
                  h(SwitchButton, { checked: tool.enabled !== false, busy: props.busy, label: t(tool.enabled !== false ? 'disableTool' : 'enableTool', { name: tool.name }), onChange: () => props.onToolToggle(tool) }),
                  tool && tool.description
                    ? h('span', { className: 'dshmcp-tool-desc' }, tool.description)
                    : null,
                ),
              ),
            ),
        h('details', { className: 'dshmcp-log' }, h('summary', null, t('logs')),
          (server.logs || []).length === 0 ? h('p', null, t('noLogs')) : h('ol', null,
            server.logs.map((entry, index) => h('li', { key: index, 'data-level': entry.level }, `${formatWhen(entry.time)} — ${entry.message}`)))),
        server.instructions
          ? h(
              'div',
              { className: 'dshmcp-detail-block' },
              h('h3', { className: 'dshmcp-subtitle' }, t('instructions')),
              h('p', { className: 'dshmcp-instructions' }, server.instructions),
            )
          : null,
        rows.length > 0
          ? h(
              'dl',
              { className: 'dshmcp-facts' },
              rows.map((row) =>
                h(
                  'div',
                  { key: row[0], className: 'dshmcp-fact' },
                  h('dt', null, row[0]),
                  h('dd', null, row[1]),
                ),
              ),
            )
          : null,
      );
    }

    /** One server row: status, identity, transport summary, actions and details. */
    function ServerRow(props) {
      const t = props.t;
      const server = props.server;
      const phase = phaseOf(server);
      const busyHere = props.busyIds.has(server.id);
      const summary = transportSummary(server);
      const toolCount = typeof server.toolCount === 'number' ? server.toolCount : (server.tools || []).length;
      const detailsId = 'dshmcp-details-' + server.id;
      const version =
        server.serverInfo && server.serverInfo.version
          ? t('versionShort', { version: server.serverInfo.version })
          : '';
      const meta = [];
      meta.push(
        h(
          'span',
          { key: 'transport', className: 'dshmcp-chip' },
          t(server.transport === 'http' ? 'shortHttp' : 'shortStdio'),
        ),
      );
      meta.push(h('span', { key: 'tools' }, t('toolCount', { count: toolCount })));
      if (version) {
        meta.push(h('span', { key: 'version', className: 'dshmcp-mono' }, version));
      }
      return h(
        'li',
        { className: 'dshmcp-row', 'data-state': DOT_STATE[phase] || 'idle' },
        h(
          'div',
          { className: 'dshmcp-line' },
          h(StatusDot, { phase }),
          h(
            'div',
            { className: 'dshmcp-main' },
            h(
              'div',
              { className: 'dshmcp-name-row' },
              h('span', { className: 'dshmcp-name' }, server.name),
              h('span', { className: 'dshmcp-state', 'data-state': DOT_STATE[phase] || 'idle' }, t(PHASE_KEY[phase])),
            ),
            h('span', { className: 'dshmcp-summary', title: summary }, summary),
            h(
              'div',
              { className: 'dshmcp-meta' },
              meta,
              h(
                'button',
                {
                  type: 'button',
                  className: 'dshmcp-expand',
                  'aria-expanded': props.expanded ? 'true' : 'false',
                  'aria-controls': props.expanded ? detailsId : undefined,
                  onClick: props.onToggleExpand,
                },
                h(Icon, { name: 'chevron', size: 14 }),
                props.expanded ? t('hideTools') : t('showTools'),
              ),
            ),
          ),
          h(
            'div',
            { className: 'dshmcp-actions' },
            h(EnableSwitch, {
              t,
              name: server.name,
              checked: server.enabled !== false,
              busy: busyHere,
              disabled: busyHere,
              onChange: props.onToggleEnabled,
            }),
            h(
              'button',
              {
                type: 'button',
                className: 'dshmcp-icon-btn',
                'aria-label': t('reconnect', { name: server.name }),
                title: t('reconnect', { name: server.name }),
                disabled: busyHere || !server.enabled || server.status === 'connecting',
                onClick: props.onReconnect,
              },
              h(Icon, { name: 'link' }),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dshmcp-icon-btn',
                'aria-label': t('edit', { name: server.name }),
                title: t('edit', { name: server.name }),
                disabled: busyHere,
                onClick: props.onEdit,
              },
              h(Icon, { name: 'pencil' }),
            ),
            h('button', { type: 'button', className: 'dshmcp-icon-btn', title: t('copy', { name: server.name }), 'aria-label': t('copy', { name: server.name }), disabled: busyHere, onClick: props.onCopy }, h(Icon, { name: 'copy' })),
            h(
              'button',
              {
                type: 'button',
                className: 'dshmcp-icon-btn',
                'aria-label': t('remove', { name: server.name }),
                title: t('remove', { name: server.name }),
                'data-danger': 'true',
                disabled: busyHere,
                ref: props.registerDelete,
                onClick: props.onRequestDelete,
              },
              h(Icon, { name: 'trash' }),
            ),
          ),
        ),
        server.status === 'error' && server.error
          ? h(
              React.Fragment,
              null,
              h(
                'p',
                { className: 'dshmcp-row-error' },
                h(Icon, { name: 'alert', size: 14 }),
                h('span', null, t('errorLine', { label: t('lastError'), message: server.error })),
              ),
              /already registered/i.test(String(server.error))
                ? h('p', { className: 'dshmcp-hint' }, t('duplicateHint'))
                : null,
            )
          : null,
        props.expanded ? h(ServerDetails, { t, server, id: detailsId, onToolToggle: props.onToolToggle, busy: busyHere }) : null,
        props.confirming
          ? h(ConfirmBar, {
              t,
              name: server.name,
              busy: busyHere,
              onCancel: props.onCancelDelete,
              onConfirm: props.onConfirmDelete,
            })
          : null,
      );
    }

    /** The add/edit dialog: transport-dependent fields, inline validation, Escape to close. */
    function ServerDialog(props) {
      const t = props.t;
      const editing = props.mode === 'edit';
      const uid = React.useId().replace(/[^A-Za-z0-9_-]/g, '');
      const id = (name) => 'dshmcp-' + name + '-' + uid;
      const dialogRef = React.useRef(null);
      const openerRef = React.useRef(null);
      const fieldRefs = {
        name: React.useRef(null),
        command: React.useRef(null),
        url: React.useRef(null),
        args: React.useRef(null),
        env: React.useRef(null),
        headers: React.useRef(null),
        cwd: React.useRef(null),
        requestTimeoutMs: React.useRef(null),
        initializeTimeoutMs: React.useRef(null),
        retryCount: React.useRef(null),
      };
      const aliveRef = React.useRef(true);
      const [draft, setDraft] = React.useState(() => draftOf(props.server));
      const [errors, setErrors] = React.useState({});
      const [failure, setFailure] = React.useState(null);
      const [saving, setSaving] = React.useState(false);

      React.useEffect(() => {
        aliveRef.current = true;
        return () => {
          aliveRef.current = false;
        };
      }, []);

      // Focus the first field, and hand focus back to the opener on close.
      React.useEffect(() => {
        openerRef.current = typeof document !== 'undefined' ? document.activeElement : null;
        if (fieldRefs.name.current) fieldRefs.name.current.focus();
        const opener = openerRef.current;
        return () => {
          if (opener && typeof opener.focus === 'function') {
            try {
              opener.focus();
            } catch (error) {
              /* the opener may be gone; nothing to restore */
            }
          }
        };
      }, []);

      const edit = (key) => (event) => {
        const value = event.target.value;
        setDraft((previous) => ({ ...previous, [key]: value }));
      };

      const submit = async (event) => {
        event.preventDefault();
        if (saving) return;
        const others = props.servers.filter((server) =>
          editing && props.server ? server.id !== props.server.id : true,
        );
        const result = validateDraft(draft, others, t);
        if (!result.input) {
          setErrors(result.errors);
          setFailure(null);
          const order = ['name', 'command', 'url', 'args', 'env', 'cwd', 'headers', 'requestTimeoutMs', 'initializeTimeoutMs', 'retryCount'];
          for (const key of order) {
            if (result.errors[key] && fieldRefs[key].current) {
              fieldRefs[key].current.focus();
              break;
            }
          }
          return;
        }
        setErrors({});
        setFailure(null);
        setSaving(true);
        try {
          await props.onSave(result.input);
        } catch (error) {
          if (!aliveRef.current) { props.onDetachedError(error); return; }
          const message = explain(error, t);
          const field = error instanceof ApiError ? error.field : undefined;
          if (field && fieldRefs[field] !== undefined) {
            // The Host named a field: show it there instead of a second, page-level copy.
            setErrors({ [field]: message });
            setFailure(null);
            if (fieldRefs[field].current) fieldRefs[field].current.focus();
          } else {
            setFailure(message);
          }
        } finally {
          if (aliveRef.current) setSaving(false);
        }
      };

      /** Keep Tab inside the dialog and let Escape close it. */
      const onKeyDown = (event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          props.onClose();
          return;
        }
        if (event.key !== 'Tab') return;
        const root = dialogRef.current;
        if (!root) return;
        const selectable = root.querySelectorAll(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        );
        const nodes = [];
        for (let index = 0; index < selectable.length; index += 1) {
          const node = selectable[index];
          if (node.offsetParent !== null || node === document.activeElement) nodes.push(node);
        }
        if (nodes.length === 0) return;
        const first = nodes[0];
        const last = nodes[nodes.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      };

      const field = (key, label, hint, control, optional) => {
        const error = errors[key];
        const fieldId = id(key);
        const describedBy = error ? fieldId + '-error' : hint ? fieldId + '-hint' : undefined;
        return h(
          Field,
          {
            key,
            id: fieldId,
            label,
            hint,
            error,
            optionalLabel: optional ? t('optional') : null,
          },
          control(fieldId, describedBy),
        );
      };

      const textarea = (key) => (fieldId, describedBy) =>
        h('textarea', {
          id: fieldId,
          ref: fieldRefs[key],
          className: 'dshmcp-textarea',
          value: draft[key],
          rows: 3,
          spellCheck: false,
          autoComplete: 'off',
          'aria-invalid': errors[key] ? 'true' : 'false',
          'aria-describedby': describedBy,
          onChange: edit(key),
        });

      const body = [];
      body.push(
        h(
          'div',
          { key: 'ident', className: 'dshmcp-grid' },
          field('name', t('fieldName'), t('fieldNameHint'), (fieldId, describedBy) =>
            h('input', {
              id: fieldId,
              ref: fieldRefs.name,
              className: 'dshmcp-input',
              type: 'text',
              value: draft.name,
              maxLength: 32,
              spellCheck: false,
              autoComplete: 'off',
              autoCapitalize: 'off',
              'aria-invalid': errors.name ? 'true' : 'false',
              'aria-describedby': describedBy,
              onChange: edit('name'),
            }),
          ),
          h(
            'div',
            { className: 'dshmcp-field' },
            h('label', { className: 'dshmcp-label', htmlFor: id('transport') }, t('fieldTransport')),
            h(
              'select',
              {
                id: id('transport'),
                className: 'dshmcp-select',
                value: draft.transport,
                onChange: edit('transport'),
              },
              h('option', { value: 'stdio' }, t('transportStdio')),
              h('option', { value: 'http' }, t('transportHttp')),
            ),
          ),
        ),
      );

      if (draft.transport === 'stdio') {
        body.push(
          field('command', t('fieldCommand'), t('fieldCommandHint'), (fieldId, describedBy) =>
            h('input', {
              id: fieldId,
              ref: fieldRefs.command,
              className: 'dshmcp-input',
              type: 'text',
              value: draft.command,
              spellCheck: false,
              autoComplete: 'off',
              'aria-invalid': errors.command ? 'true' : 'false',
              'aria-describedby': describedBy,
              onChange: edit('command'),
            }),
          ),
        );
        body.push(field('args', t('fieldArgs'), t('fieldArgsHint'), textarea('args'), true));
        body.push(field('env', t('fieldEnv'), t('fieldEnvHint'), textarea('env'), true));
        body.push(
          field('cwd', t('fieldCwd'), t('fieldCwdHint'), (fieldId, describedBy) =>
            h('input', {
              id: fieldId,
              ref: fieldRefs.cwd,
              className: 'dshmcp-input',
              type: 'text',
              value: draft.cwd,
              spellCheck: false,
              autoComplete: 'off',
              'aria-invalid': errors.cwd ? 'true' : 'false',
              'aria-describedby': describedBy,
              onChange: edit('cwd'),
            }),
          ),
          true,
        );
      } else {
        body.push(
          field('url', t('fieldUrl'), t('fieldUrlHint'), (fieldId, describedBy) =>
            h('input', {
              id: fieldId,
              ref: fieldRefs.url,
              className: 'dshmcp-input',
              type: 'text',
              inputMode: 'url',
              value: draft.url,
              spellCheck: false,
              autoComplete: 'off',
              autoCapitalize: 'off',
              'aria-invalid': errors.url ? 'true' : 'false',
              'aria-describedby': describedBy,
              onChange: edit('url'),
            }),
          ),
        );
        body.push(field('headers', t('fieldHeaders'), t('fieldHeadersHint'), textarea('headers'), true));
      }

      body.push(h('fieldset', { key: 'advanced', className: 'dshmcp-options' },
        h('legend', null, t('advanced')),
        Object.entries(CONNECTION_OPTIONS).map(([key, rule]) => field(key, t(key), null, (fieldId, describedBy) =>
          h('input', { id: fieldId, ref: fieldRefs[key], className: 'dshmcp-input', type: 'number', min: rule.min,
            max: rule.max, step: 1, value: draft[key], onChange: edit(key),
            'aria-invalid': !!errors[key], 'aria-describedby': describedBy }))),
        h('p', { className: 'dshmcp-hint' }, t('retryHint'))));

      const titleId = id('title');
      return h(
        'div',
        { className: 'dshmcp-scrim' },
        h(
          'div',
          {
            className: 'dshmcp-dialog',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-labelledby': titleId,
            ref: dialogRef,
            onKeyDown,
          },
          h(
            'form',
            { className: 'dshmcp-form', onSubmit: submit, noValidate: true },
            h(
              'div',
              { className: 'dshmcp-dialog-head' },
              h('h3', { className: 'dshmcp-dialog-title', id: titleId }, editing ? t('editTitle', { name: props.server.name }) : t('addTitle')),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dshmcp-icon-btn',
                  'aria-label': t('closeDialog'),
                  title: t('closeDialog'),
                  onClick: props.onClose,
                },
                h(Icon, { name: 'close' }),
              ),
            ),
            h(
              'div',
              { className: 'dshmcp-dialog-body' },
              failure
                ? h(
                    'p',
                    { className: 'dshmcp-banner', 'data-tone': 'error', role: 'alert' },
                    h(Icon, { name: 'alert', size: 16 }),
                    h('span', { className: 'dshmcp-banner-text' }, failure),
                  )
                : null,
              body,
            ),
            h(
              'div',
              { className: 'dshmcp-dialog-foot' },
              h(
                'button',
                { type: 'button', className: 'dshmcp-btn', onClick: props.onClose },
                t('cancel'),
              ),
              h(
                'button',
                { type: 'submit', className: 'dshmcp-btn', 'data-variant': 'primary', disabled: saving },
                saving ? t('saving') : t('save'),
              ),
            ),
          ),
        ),
      );
    }

    // ── rail surface ──────────────────────────────────────────────────────
    /** Slot id/key this bundle uses for its rail entry and its `main` page. */
    const RAIL_ID = 'mcp-manager';

    /**
     * The mounted fiber's rail surface. `apply` creates it, the page's preference
     * row drives it. A factory-scope holder keeps the `settings.section`
     * registration literal: the page itself is registered, not a wrapper.
     */
    let railSurface = null;

    /**
     * The rail entry's icon: this bundle's own server-stack glyph at the slot's size.
     * @param props - the slot props; `size` is the rail's icon size in pixels.
     */
    function RailIcon(props) {
      return h(Icon, { name: 'server', size: typeof props.size === 'number' ? props.size : 16 });
    }

    /**
     * The rail surface's page: the very same section inside a full-height
     * scrolling container, so both surfaces share one implementation.
     * @param props - the `main` slot props (a bound `t`, when the slot supplies one).
     */
    function PanelPage(props) {
      return h('div', { className: 'dshmcp-panel' }, h(McpManagerSection, { t: props.t }));
    }

    /**
     * Read the page-level preference out of any route response. A missing `ui`
     * means the contract's default: the rail entry is on.
     * @param payload - a success payload from any route.
     * @returns whether the rail surface should exist.
     */
    function readRailEntry(payload) {
      const ui = payload && payload.ui;
      return !ui || ui.railEntry !== false;
    }

    /**
     * The optional left-rail surface: this bundle's icon in `sidebar.panellist`
     * plus the same page in `main`, installed and removed as one unit. Both
     * `inject` disposers live in one array that the `ctx.effect` created in
     * {@link apply} owns, so a preference flip and a plugin unload both end in a
     * single, clean teardown, and the surface is never installed twice.
     * @param ctx - the browser plugin context.
     * @param t - the bound translator.
     * @returns the surface handle the page writes through.
     */
    function createRailSurface(ctx, t) {
      let open = true; // the contract's default until a response says otherwise
      let installed = false;
      let disposed = false;
      let touched = false; // a page read or a user write outranks the activation read
      let disposers = [];

      const uninstall = () => {
        while (disposers.length > 0) {
          const dispose = disposers.pop();
          if (typeof dispose !== 'function') continue;
          try {
            dispose();
          } catch (error) {
            /* the slot owner may already be gone; nothing left to release */
          }
        }
      };

      const install = () => {
        if (installed || disposed) return;
        installed = true;
        disposers = [
          ctx.slots.inject('sidebar.panellist', () =>
            ctx.slots.register(
              {
                name: 'sidebar.panellist',
                id: RAIL_ID,
                order: 60,
                label: () => t('nav'),
                locale: NS,
              },
              RailIcon,
            ),
          ),
          ctx.slots.inject('main', () =>
            ctx.slots.register({ name: 'main', key: RAIL_ID, locale: NS }, PanelPage),
          ),
        ].filter((dispose) => typeof dispose === 'function');
      };

      const sync = () => {
        if (disposed) return;
        if (open && !installed) install();
        else if (!open && installed) {
          installed = false;
          uninstall();
        }
      };

      const update = (value, source) => {
        if (disposed) return;
        if (source === 'boot' && touched) return;
        if (source !== 'boot') touched = true;
        const next = value !== false;
        if (next === open) return;
        open = next;
        sync();
      };

      install();

      return {
        /** Apply the preference carried by a page's list or mutation response. */
        observe: (value) => update(value, 'page'),
        /** Apply the one read taken at activation, unless a page already spoke. */
        reconcile: (value) => update(value, 'boot'),
        /** Apply a value the page just persisted through `api/mcp-manager.ui`. */
        apply: (value) => update(value, 'user'),
        /** Remove both registrations and stop accepting updates (plugin unload). */
        dispose() {
          disposed = true;
          installed = false;
          open = false;
          uninstall();
        },
      };
    }

    // Both mounted surfaces share mutation ordering and committed snapshots.
    const dataListeners = new Set();
    let dataGeneration = 0;
    let readSequence = 0;
    let appliedRead = 0;
    let pendingWrites = 0;
    let mutationTail = Promise.resolve();

    function publishData(payload) {
      for (const listener of dataListeners) listener(payload);
    }

    function mutateData(route, body) {
      dataGeneration += 1;
      pendingWrites += 1;
      const result = mutationTail.then(async () => {
        const payload = await post(route, body);
        publishData(payload);
        return payload;
      });
      mutationTail = result.catch(() => {}).finally(() => {
        pendingWrites -= 1;
        dataGeneration += 1;
      });
      return result;
    }

    /** Named application actions; components do not depend on wire route names. */
    const managerActions = {
      save: (body) => mutateData(ROUTES.save, body),
      remove: (id) => mutateData(ROUTES.remove, { id }),
      toggle: (id, enabled) => mutateData(ROUTES.toggle, { id, enabled }),
      reconnect: (id) => mutateData(ROUTES.reconnect, { id }),
      takeover: (entryId) => mutateData(ROUTES.takeover, { entryId }),
      toggleExternal: (entryId, enabled) => mutateData(ROUTES.toggleExternal, { entryId, enabled }),
      setRailEntry: (railEntry) => mutateData(ROUTES.ui, { railEntry }),
      setToolEnabled: (id, name, enabled) => mutateData(ROUTES.tool, { id, name, enabled }),
      importServers: (document) => mutateData(ROUTES.import, { document }),
      exportServers: (includeSecrets) => post(ROUTES.export, { includeSecrets }),
      recover: (mode) => mutateData(ROUTES.recover, { mode }),
    };

    /** Network lifetime and shared snapshots are kept outside page actions. */
    function useManagerData(t) {
      const [servers, setServers] = React.useState(null);
      const [external, setExternal] = React.useState([]);
      const [storage, setStorage] = React.useState({ readOnly: false, hasBackup: false });
      const [loadError, setLoadError] = React.useState(null);
      const [railEntry, setRailEntry] = React.useState(true);
      const alive = React.useRef(true);
      const activeRead = React.useRef(null);
      const receive = React.useCallback((payload) => {
        if (!alive.current) return;
        if (Array.isArray(payload.servers)) setServers(payload.servers);
        if (Array.isArray(payload.external)) setExternal(payload.external);
        if (payload.storage) setStorage(payload.storage);
        if (payload.ui) {
          const value = readRailEntry(payload);
          setRailEntry(value);
          railSurface?.observe(value);
        }
        setLoadError(null);
      }, []);
      const requestList = React.useCallback(async (manual) => {
        if (!alive.current || pendingWrites) return;
        if (activeRead.current && !manual) return;
        activeRead.current?.abort();
        const controller = new AbortController();
        activeRead.current = controller;
        const generation = dataGeneration;
        const sequence = ++readSequence;
        try {
          const payload = await post(ROUTES.list, {}, controller.signal);
          if (controller.signal.aborted || !alive.current || generation !== dataGeneration || sequence < appliedRead) return;
          appliedRead = sequence;
          publishData(payload);
        } catch (error) {
          if (controller.signal.aborted || !alive.current || generation !== dataGeneration || sequence < appliedRead) return;
          setLoadError({ text: t('errLoad'), detail: explain(error, t) });
        } finally {
          if (activeRead.current === controller) activeRead.current = null;
        }
      }, [t]);
      React.useEffect(() => {
        alive.current = true;
        dataListeners.add(receive);
        requestList(false);
        const timer = setInterval(() => requestList(false), POLL_MS);
        return () => {
          alive.current = false;
          activeRead.current?.abort();
          activeRead.current = null;
          dataListeners.delete(receive);
          clearInterval(timer);
        };
      }, [receive, requestList]);
      return { servers, external, storage, loadError, railEntry, alive, requestList, actions: managerActions };
    }

    function StorageRecovery({ t, storage, actions }) {
      const [mode, setMode] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState(null);
      if (!storage.readOnly) return storage.skippedRecords
        ? h('p', { className: 'dshmcp-hint', role: 'status' }, t('storageSkipped', { count: storage.skippedRecords })) : null;
      const recover = async () => {
        setBusy(true);
        setError(null);
        try { await actions.recover(mode); setMode(null); }
        catch (failure) { setError(explain(failure, t)); }
        finally { setBusy(false); }
      };
      return h('div', { className: 'dshmcp-recovery', role: 'alert' },
        h('p', null, t('storageProblem')),
        h('p', { className: 'dshmcp-hint' }, storage.error),
        error ? h('p', null, error) : null,
        mode ? h('div', null, h('p', null, t('recoverConfirm')),
          h('button', { type: 'button', className: 'dshmcp-btn', disabled: busy, onClick: () => setMode(null) }, t('cancel')),
          h('button', { type: 'button', className: 'dshmcp-btn', disabled: busy, onClick: recover }, t(mode === 'backup' ? 'restoreBackup' : 'resetStorage')))
          : h('div', { className: 'dshmcp-toolbar' },
            h('button', { type: 'button', className: 'dshmcp-btn', disabled: !storage.hasBackup, onClick: () => setMode('backup') }, t('restoreBackup')),
            h('button', { type: 'button', className: 'dshmcp-btn', onClick: () => setMode('reset') }, t('resetStorage'))));
    }

    function ConfigTransfer({ t, readOnly, actions }) {
      const uid = React.useId();
      const [text, setText] = React.useState('');
      const [includeSecrets, setIncludeSecrets] = React.useState(false);
      const [busy, setBusy] = React.useState(false);
      const [message, setMessage] = React.useState(null);
      let parsed;
      try { parsed = JSON.parse(text); } catch { /* inline validation below */ }
      const count = Array.isArray(parsed) ? parsed.length : Array.isArray(parsed?.servers) ? parsed.servers.length
        : parsed?.mcpServers ? Object.keys(parsed.mcpServers).length : 0;
      const run = async (task) => {
        setBusy(true);
        setMessage(null);
        try { await task(); }
        catch (error) { setMessage({ error: true, text: explain(error, t) }); }
        finally { setBusy(false); }
      };
      return h('details', { className: 'dshmcp-transfer' },
        h('summary', null, t('configTransfer')),
        h('p', { className: 'dshmcp-hint' }, t('importHint')),
        h('label', { htmlFor: uid + '-file', className: 'dshmcp-label' }, t('chooseFile')),
        h('input', { id: uid + '-file', type: 'file', accept: '.json,application/json', disabled: busy,
          onChange: (event) => { const file = event.target.files?.[0]; if (file) void run(async () => {
            if (file.size > 2 * 1024 * 1024) throw new ApiError('invalid', t('fileTooLarge'));
            setText(await file.text());
          }); } }),
        h('label', { htmlFor: uid + '-json', className: 'dshmcp-label' }, t('jsonConfig')),
        h('textarea', { id: uid + '-json', className: 'dshmcp-textarea', rows: 8, value: text, spellCheck: false,
          autoComplete: 'off', disabled: busy, 'aria-describedby': uid + '-preview', onChange: (event) => setText(event.target.value) }),
        h('p', { id: uid + '-preview', className: 'dshmcp-hint' }, text && !parsed ? t('jsonInvalid') : t('importPreview', { count })),
        h('label', { className: 'dshmcp-checkbox' }, h('input', { type: 'checkbox', checked: includeSecrets, disabled: busy,
          onChange: (event) => setIncludeSecrets(event.target.checked) }), t('includeSecrets')),
        h('p', { className: 'dshmcp-hint' }, t(includeSecrets ? 'secretsHint' : 'exportHint')),
        message ? h('p', { role: message.error ? 'alert' : 'status' }, message.text) : null,
        h('div', { className: 'dshmcp-toolbar' },
          h('button', { type: 'button', className: 'dshmcp-btn', disabled: busy || readOnly || !count,
            onClick: () => run(async () => { const result = await actions.importServers(parsed); setMessage({ text: t('importDone', { count: result.imported }) }); }) }, t('importConfig')),
          h('button', { type: 'button', className: 'dshmcp-btn', disabled: busy || readOnly,
            onClick: () => run(async () => { const result = await actions.exportServers(includeSecrets); setText(JSON.stringify(result.document, null, 2)); }) }, t('exportConfig')),
          h('button', { type: 'button', className: 'dshmcp-btn', disabled: busy || !parsed, onClick: () => {
            const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
            const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'mcp-servers.json'; anchor.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          } }, t('download'))));
    }

    // ── the section ───────────────────────────────────────────────────────
    /**
     * Render the MCP servers settings page.
     * @param props - slot props; `t` is bound to this plugin's namespace.
     * @returns the section, its styles and any open dialog.
     */
    function McpManagerSection(props) {
      const t = React.useMemo(
        () => (typeof props.t === 'function' ? props.t : directTranslator()),
        [props.t],
      );
      const { servers, external, storage, loadError, railEntry, alive, requestList, actions } = useManagerData(t);
      const [notice, setNotice] = React.useState(null);
      const [busyIds, setBusyIds] = React.useState(() => new Set());
      const activeActions = React.useRef(new Set());
      const [confirmId, setConfirmId] = React.useState(null);
      const [expanded, setExpanded] = React.useState({});
      const [editor, setEditor] = React.useState(null);
      const [railBusy, setRailBusy] = React.useState(false);
      const [query, setQuery] = React.useState('');
      const [filter, setFilter] = React.useState('all');
      const deleteRefs = React.useRef(new Map());
      const previousConfirm = React.useRef(null);
      const editorKey = React.useRef(0);

      // The confirmation's safe choice takes focus; cancelling hands it back to Delete.
      React.useEffect(() => {
        const previous = previousConfirm.current;
        if (confirmId === null && previous !== null) {
          const node = deleteRefs.current.get(previous);
          if (node) node.focus();
        }
        previousConfirm.current = confirmId;
      }, [confirmId]);

      const run = async (id, task) => {
        if (activeActions.current.has(id)) return;
        activeActions.current.add(id);
        setBusyIds(new Set(activeActions.current));
        try {
          await task();
        } catch (error) {
          if (!alive.current) return;
          setNotice({ tone: 'error', text: explain(error, t) });
          // The record the row pointed at is gone; resync so the list matches the Host.
          if (error instanceof ApiError && error.code === 'not-found') requestList(true);
        } finally {
          activeActions.current.delete(id);
          if (alive.current) setBusyIds(new Set(activeActions.current));
        }
      };

      const toggleServer = (server) =>
        run(server.id, async () => {
          await actions.toggle(server.id, !server.enabled);
        });

      const reconnectServer = (server) =>
        run(server.id, async () => {
          await actions.reconnect(server.id);
        });

      const takeoverServer = (item) =>
        run(item.entryId, async () => {
          await actions.takeover(item.entryId);
        });

      const toggleExternal = (item) =>
        run(item.entryId, async () => {
          await actions.toggleExternal(item.entryId, !item.enabled);
        });

      const setRailPreference = (next) => {
        if (railBusy) return;
        setRailBusy(true);
        void (async () => {
          try {
            await actions.setRailEntry(next);
          } catch (error) {
            if (!alive.current) return;
            setNotice({ tone: 'error', text: explain(error, t) });
          } finally {
            if (alive.current) setRailBusy(false);
          }
        })();
      };

      const deleteServer = (server) =>
        run(server.id, async () => {
          await actions.remove(server.id);
          if (!alive.current) return;
          setConfirmId(null);
          setExpanded((previous) => {
            if (!Object.prototype.hasOwnProperty.call(previous, server.id)) return previous;
            const next = { ...previous };
            delete next[server.id];
            return next;
          });
        });

      const openEditor = (mode, server) => {
        setConfirmId(null);
        editorKey.current += 1;
        setEditor({ mode, server: server || null, key: editorKey.current });
      };

      const saveServer = async (input) => {
        const editing = editor;
        if (!editing) return;
        const body = { server: input };
        if (editing.mode === 'edit' && editing.server) body.id = editing.server.id;
        await actions.save(body);
        if (!alive.current) return;
        setEditor((current) => current?.key === editing.key ? null : current);
      };

      const registerDelete = (serverId) => (element) => {
        if (element) deleteRefs.current.set(serverId, element);
        else deleteRefs.current.delete(serverId);
      };

      const toggleExpanded = (serverId) =>
        setExpanded((previous) => {
          const next = { ...previous };
          if (next[serverId]) delete next[serverId];
          else next[serverId] = true;
          return next;
        });

      const loading = servers === null && loadError === null;
      const allRows = servers || [];
      const matches = (server) => (filter === 'all' || phaseOf(server) === filter)
        && `${server.name ?? server.serverName ?? ''} ${transportSummary(server)}`.toLowerCase().includes(query.toLowerCase());
      const rows = allRows.filter(matches);
      const foreign = external.filter((item) => matches({ ...item, status: item.enabled ? 'ready' : 'stopped' }));
      const copyServer = (server) => {
        let suffix = 1;
        let name;
        do {
          const tail = `_copy${suffix++}`;
          name = server.name.slice(0, 32 - tail.length) + tail;
        } while (allRows.some((row) => row.name === name));
        openEditor('add', { ...server, id: undefined, name, enabled: false });
      };

      return h(
        'div',
        { className: 'dshmcp-section' },
        h('style', null, STYLE_TEXT),
        h(
          'div',
          { className: 'dshmcp-head' },
          h('h2', { className: 'dshmcp-title' }, t('title')),
          h('p', { className: 'dshmcp-intro' }, t('intro')),
        ),
        h(Banners, {
          t,
          loadError,
          notice,
          onRetry: () => requestList(true),
          onDismiss: () => setNotice(null),
        }),
        h(StorageRecovery, { t, storage, actions }),
        h('div', { className: 'dshmcp-toolbar' },
          h('input', { type: 'search', className: 'dshmcp-input', 'aria-label': t('search'), placeholder: t('search'), value: query, onChange: (event) => setQuery(event.target.value) }),
          h('div', { className: 'dshmcp-filter' },
            h('select', { className: 'dshmcp-select dshmcp-select-filter', 'aria-label': t('filter'), value: filter, onChange: (event) => setFilter(event.target.value) },
              h('option', { value: 'all' }, t('all')),
              ['ready', 'connecting', 'error', 'disabled', 'stopped'].map((value) => h('option', { key: value, value }, t(PHASE_KEY[value])))),
            h('span', { className: 'dshmcp-caret', 'aria-hidden': 'true' }, h(Icon, { name: 'chevron', size: 14 }))),
          h('button', { className: 'dshmcp-btn dshmcp-btn-square', type: 'button', 'aria-label': t('add'), title: t('add'), onClick: () => openEditor('add', null) }, h(Icon, { name: 'plus' })),
          h('button', { className: 'dshmcp-btn dshmcp-btn-square', type: 'button', 'aria-label': t('refreshStatus'), title: t('refreshStatus'), onClick: () => requestList(true) }, h(Icon, { name: 'refresh' }))),
        h('div', { inert: storage.readOnly ? '' : undefined },
        loading
          ? h(SkeletonRows, { t })
          : allRows.length === 0 && external.length === 0 && loadError === null
            ? h(EmptyState, { t, onAdd: () => openEditor('add', null) })
            : rows.length === 0
              ? (foreign.length === 0 && loadError === null ? h('p', { role: 'status', className: 'dshmcp-hint' }, t('noMatches')) : null)
              : h(
                  React.Fragment,
                  null,
                  h(
                    'ul',
                    { className: 'dshmcp-list', 'aria-label': t('title') },
                    rows.map((server) =>
                      h(ServerRow, {
                        key: server.id,
                        t,
                        server,
                        busyIds,
                        expanded: Boolean(expanded[server.id]),
                        confirming: confirmId === server.id,
                        onToggleExpand: () => toggleExpanded(server.id),
                        onToggleEnabled: () => toggleServer(server),
                        onReconnect: () => reconnectServer(server),
                        onEdit: () => openEditor('edit', server),
                        onCopy: () => copyServer(server),
                        onToolToggle: (tool) => run(server.id, () => actions.setToolEnabled(server.id, tool.name, !tool.enabled)),
                        onRequestDelete: () => setConfirmId(server.id),
                        onCancelDelete: () => setConfirmId(null),
                        onConfirmDelete: () => deleteServer(server),
                        registerDelete: registerDelete(server.id),
                      }),
                    ),
                  ),
                ),
        foreign.length === 0
          ? null
          : h(ExternalList, { t, items: foreign, busyIds, onTakeover: takeoverServer, onToggle: toggleExternal }),
        ),
        h(ConfigTransfer, { t, readOnly: storage.readOnly, actions }),
        h('div', { inert: storage.readOnly ? '' : undefined }, h(RailPreferenceRow, {
          t,
          checked: railEntry,
          busy: railBusy,
          onChange: () => setRailPreference(!railEntry),
        })),
        editor
          ? h(ServerDialog, {
              key: 'editor-' + editor.key,
              t,
              mode: editor.mode,
              server: editor.server,
              servers: allRows,
              onClose: () => setEditor(null),
              onSave: saveServer,
              onDetachedError: (error) => { if (alive.current) setNotice({ tone: 'error', text: explain(error, t) }); },
            })
          : null,
      );
    }

    // ── styles ────────────────────────────────────────────────────────────
    /**
     * The page's stylesheet, rendered as a React element inside the section.
     * Only the contracted `--dsw-alias-*` tokens carry colour; `color-mix`
     * derives tints and veils so the page follows light and dark themes.
     */
    const STYLE_TEXT = `
.dshmcp-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0}
.dshmcp-toolbar>.dshmcp-input{flex:1;min-width:160px}
.dshmcp-toolbar>.dshmcp-filter{position:relative;display:inline-flex;align-items:center;width:auto;max-width:100%}
.dshmcp-toolbar .dshmcp-select-filter{appearance:none;-webkit-appearance:none;width:auto;min-width:0;padding:0 34px 0 12px;background-image:none}
.dshmcp-caret{position:absolute;right:14px;top:50%;transform:translateY(-50%);display:flex;pointer-events:none;color:var(--dsw-alias-label-secondary)}
.dshmcp-transfer,.dshmcp-recovery{padding:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);min-width:0}
.dshmcp-transfer>summary,.dshmcp-log>summary{cursor:pointer;padding:4px 0}
.dshmcp-transfer>*{max-width:100%}
.dshmcp-transfer>label,.dshmcp-transfer>input{margin:8px 0}
.dshmcp-checkbox{display:flex;gap:8px;align-items:center}
.dshmcp-options{display:flex;flex-direction:column;gap:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);padding:12px;min-width:0}
.dshmcp-log ol{max-height:200px;overflow:auto;padding-left:20px;font-size:12px;overflow-wrap:anywhere}
.dshmcp-log [data-level=error]{color:var(--dsw-alias-state-error-primary)}
.dshmcp-recovery{border-color:var(--dsw-alias-state-warn-primary)}
@media(max-width:480px){.dshmcp-toolbar>*{max-width:100%}.dshmcp-toolbar>.dshmcp-input{flex-basis:100%}.dshmcp-panel{padding:12px}}
@media(prefers-reduced-motion:reduce){.dshmcp-section *{animation:none!important;transition:none!important}}

.dshmcp-section{box-sizing:border-box;max-width:760px;width:100%;min-width:0;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:12px;font-size:13px;line-height:20px}
.dshmcp-section *{box-sizing:border-box}
.dshmcp-panel{box-sizing:border-box;height:100%;overflow-y:auto;padding:24px}
.dshmcp-panel .dshmcp-section{margin:0 auto}
.dshmcp-pref{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-top:6px;padding:12px 14px;border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-module-platform)}
.dshmcp-pref-text{display:flex;flex-direction:column;gap:2px;min-width:0}
.dshmcp-pref-label{font-size:13px;line-height:20px;font-weight:500}
.dshmcp-pref-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dshmcp-head{display:flex;flex-direction:column;gap:4px}
.dshmcp-title{margin:0;font-size:18px;font-weight:600;line-height:26px}
.dshmcp-intro{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.dshmcp-btn{box-sizing:border-box;height:36px;padding:0 14px;border-radius:var(--dsw-radius-md);border:.5px solid var(--dsw-alias-border-l3);background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:14px;line-height:22px;display:inline-flex;align-items:center;justify-content:center;gap:6px;cursor:pointer;white-space:nowrap}
.dshmcp-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dshmcp-btn:focus-visible{box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline:none}
.dshmcp-btn:disabled{opacity:.4;cursor:default}
.dshmcp-btn[data-variant=primary]{border-color:transparent;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);font-weight:500}
.dshmcp-btn[data-variant=primary]:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.dshmcp-btn[data-variant=danger]{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 40%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent);color:var(--dsw-alias-state-error-primary)}
.dshmcp-btn[data-variant=danger]:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 16%,transparent)}
.dshmcp-btn-small{height:28px;padding:0 10px;font-size:12px;line-height:18px;border-radius:var(--dsw-radius-sm)}
.dshmcp-btn-stack{display:inline-grid;justify-items:center}
.dshmcp-btn-stack>*{grid-area:1/1;white-space:nowrap}
.dshmcp-btn-ghost{visibility:hidden}
.dshmcp-icon-btn{box-sizing:border-box;width:28px;height:28px;padding:0;border-radius:var(--dsw-radius-sm);border:0;background:transparent;color:var(--dsw-alias-label-secondary);display:inline-flex;align-items:center;justify-content:center;cursor:pointer;flex:none}
.dshmcp-icon-btn:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-label-primary) 7%,transparent);color:var(--dsw-alias-label-primary)}
.dshmcp-icon-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dshmcp-icon-btn:disabled{opacity:.45;cursor:default}
.dshmcp-icon-btn[data-danger=true]{color:var(--dsw-alias-state-error-primary)}
.dshmcp-icon-btn[data-danger=true]:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent);color:var(--dsw-alias-state-error-primary)}
.dshmcp-icon-btn[data-spinning=true] .dshmcp-icon{animation:dshmcp-spin 1s linear infinite}
.dshmcp-icon{display:block;flex:none}
.dshmcp-banners{display:flex;flex-direction:column;gap:8px}
.dshmcp-banner{display:flex;align-items:flex-start;gap:10px;margin:0;padding:10px 12px;border-radius:10px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}
.dshmcp-banner[data-tone=error]{border:.5px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 35%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent)}
.dshmcp-banner[data-tone=error]>.dshmcp-icon{color:var(--dsw-alias-state-error-primary)}
.dshmcp-banner[data-tone=ok]{border:.5px solid color-mix(in srgb,var(--dsw-alias-state-success-primary) 35%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 8%,transparent)}
.dshmcp-banner[data-tone=ok]>.dshmcp-icon{color:var(--dsw-alias-state-success-primary)}
.dshmcp-banner-body{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}
.dshmcp-banner-text{margin:0;flex:1;min-width:0;overflow-wrap:anywhere}
.dshmcp-banner-detail{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.dshmcp-banner .dshmcp-btn{flex:none;align-self:center}
.dshmcp-list{list-style:none;margin:4px 0 0;padding:0;display:flex;flex-direction:column;gap:10px}
.dshmcp-row{display:flex;flex-direction:column;gap:6px;padding:12px 14px;border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-module-platform);min-width:0}
.dshmcp-btn-square{width:36px;padding:0}
.dshmcp-external{display:flex;flex-direction:column;gap:8px;margin-top:20px}
.dshmcp-external .dshmcp-row{background:transparent;border:.5px dashed var(--dsw-alias-border-l2)}
.dshmcp-line{display:flex;align-items:center;gap:12px;min-width:0}
.dshmcp-dot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--dsw-alias-state-idle-primary)}
.dshmcp-dot[data-state=ready]{background:var(--dsw-alias-state-success-primary)}
.dshmcp-dot[data-state=connecting]{background:var(--dsw-alias-state-warn-primary);animation:dshmcp-pulse 1.4s ease-in-out infinite}
.dshmcp-dot[data-state=error]{background:var(--dsw-alias-state-error-primary)}
.dshmcp-main{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}
.dshmcp-name-row{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;min-width:0}
.dshmcp-name{font-size:14px;font-weight:500;line-height:20px;overflow-wrap:anywhere}
.dshmcp-row[data-state=idle] .dshmcp-name{color:var(--dsw-alias-label-secondary)}
.dshmcp-state{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dshmcp-state[data-state=ready]{color:var(--dsw-alias-state-success-primary)}
.dshmcp-state[data-state=connecting]{color:var(--dsw-alias-state-warn-primary)}
.dshmcp-state[data-state=error]{color:var(--dsw-alias-state-error-primary)}
.dshmcp-summary{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.dshmcp-meta{display:flex;align-items:center;flex-wrap:wrap;gap:4px 10px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);min-width:0}
.dshmcp-chip{border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);padding:0 5px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:16px;text-transform:lowercase}
.dshmcp-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px}
.dshmcp-actions{display:flex;align-items:center;gap:2px;flex:none}
.dshmcp-actions-spaced{gap:10px}
.dshmcp-switch{position:relative;box-sizing:border-box;width:36px;height:20px;padding:0;border-radius:999px;border:.5px solid var(--dsw-alias-border-l3);background:color-mix(in srgb,var(--dsw-alias-label-primary) 12%,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-label-secondary);cursor:pointer;flex:none;transition:background .15s ease,border-color .15s ease}
.dshmcp-switch::after{content:"";position:absolute;top:50%;left:2px;width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-bg-base);box-shadow:0 1px 2px color-mix(in srgb,var(--dsw-alias-label-primary) 30%,transparent);transform:translateY(-50%);transition:left .15s ease}
.dshmcp-switch[aria-checked=true]{background:var(--dsw-alias-brand-primary);border-color:transparent}
.dshmcp-switch[aria-checked=true]::after{left:18px}
.dshmcp-switch[aria-busy=true]{cursor:progress}
.dshmcp-switch[aria-busy=true]::after{opacity:.35}
.dshmcp-switch:disabled{cursor:default}
.dshmcp-switch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.dshmcp-expand{display:inline-flex;align-items:center;gap:3px;padding:0;border:0;border-radius:4px;background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:12px;line-height:18px;cursor:pointer}
.dshmcp-expand:hover{color:var(--dsw-alias-label-primary)}
.dshmcp-expand:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.dshmcp-expand[aria-expanded=true] .dshmcp-icon{transform:rotate(180deg)}
.dshmcp-expand .dshmcp-icon{transition:transform .16s ease}
.dshmcp-row-error{display:flex;align-items:flex-start;gap:6px;margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere}
.dshmcp-row-error .dshmcp-icon{margin-top:2px}
.dshmcp-details{display:flex;flex-direction:column;gap:10px;margin:2px 0 0;padding:10px 12px;border:.5px solid var(--dsw-alias-border-l1);border-radius:10px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 4%,transparent)}
.dshmcp-hint{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dshmcp-tools{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}
.dshmcp-tool{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:4px 8px;min-width:0}
.dshmcp-tool-name{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.dshmcp-tool-desc{grid-column:1/-1;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.dshmcp-detail-block{display:flex;flex-direction:column;gap:4px}
.dshmcp-subtitle{margin:0;font-size:12px;font-weight:600;line-height:18px}
.dshmcp-instructions{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere;white-space:pre-wrap;max-height:132px;overflow-y:auto}
.dshmcp-facts{display:flex;flex-direction:column;gap:2px;margin:0}
.dshmcp-fact{display:flex;gap:8px;font-size:12px;line-height:18px;min-width:0}
.dshmcp-fact dt{color:var(--dsw-alias-label-secondary);flex:none}
.dshmcp-fact dd{margin:0;min-width:0;overflow-wrap:anywhere;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--dsw-alias-label-primary)}
.dshmcp-confirm{display:flex;align-items:flex-start;gap:10px;padding:10px 12px;border-radius:10px;border:.5px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 35%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent)}
.dshmcp-confirm>.dshmcp-icon{color:var(--dsw-alias-state-error-primary);margin-top:2px}
.dshmcp-confirm-body{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}
.dshmcp-confirm-text{margin:0;font-size:13px;line-height:20px;overflow-wrap:anywhere}
.dshmcp-confirm-hint{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dshmcp-confirm-actions{display:flex;align-items:center;gap:6px;flex:none;align-self:center}
.dshmcp-empty{display:flex;flex-direction:column;align-items:center;gap:8px;text-align:center;padding:32px 20px;border:.5px dashed var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-module-platform)}
.dshmcp-empty-icon{display:inline-flex;color:var(--dsw-alias-label-secondary)}
.dshmcp-empty-title{margin:0;font-size:14px;font-weight:500;line-height:20px}
.dshmcp-empty-hint{margin:0;max-width:46ch;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.dshmcp-empty .dshmcp-btn{margin-top:6px}
.dshmcp-skeleton{display:flex;flex-direction:column;gap:14px;padding:8px 0;margin-top:4px}
.dshmcp-skeleton-row{display:flex;align-items:center;gap:12px}
.dshmcp-skeleton-dot{width:8px;height:8px;border-radius:50%;flex:none;background:color-mix(in srgb,var(--dsw-alias-label-primary) 10%,transparent)}
.dshmcp-skeleton-lines{display:flex;flex-direction:column;gap:6px;flex:1}
.dshmcp-skeleton-line{height:12px;border-radius:6px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 9%,transparent);animation:dshmcp-pulse 1.6s ease-in-out infinite}
.dshmcp-skeleton-line-soft{background:color-mix(in srgb,var(--dsw-alias-label-primary) 6%,transparent)}
.dshmcp-scrim{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:24px;background:var(--dsw-alias-bg-mask-1);backdrop-filter:var(--dsw-mask-blur)}
.dshmcp-dialog{box-sizing:border-box;width:min(560px,100%);max-height:min(86vh,760px);overflow:hidden;display:flex;flex-direction:column;border-radius:var(--dsw-radius-panel);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);box-shadow:var(--dsw-elevation-prominent)}
.dshmcp-form{display:flex;flex-direction:column;min-height:0;overflow:hidden}
.dshmcp-dialog-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:18px 20px 8px}
.dshmcp-dialog-title{margin:0;font-size:16px;font-weight:600;line-height:24px;overflow-wrap:anywhere}
.dshmcp-dialog-body{display:flex;flex-direction:column;gap:14px;padding:6px 20px 4px;overflow-y:auto;min-height:0}
.dshmcp-dialog-foot{display:flex;justify-content:flex-end;gap:8px;padding:14px 20px 18px;margin-top:12px;border-top:.5px solid var(--dsw-alias-border-l2)}
.dshmcp-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.dshmcp-field{display:flex;flex-direction:column;gap:6px;min-width:0}
.dshmcp-label{display:flex;align-items:baseline;gap:6px;font-size:13px;font-weight:500;line-height:20px;color:var(--dsw-alias-label-primary)}
.dshmcp-optional{font-size:12px;font-weight:400;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dshmcp-field-hint{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dshmcp-field-error{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary)}
.dshmcp-input,.dshmcp-select,.dshmcp-textarea{box-sizing:border-box;width:100%;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:14px;line-height:22px;padding:8px 12px;outline:none}
.dshmcp-input,.dshmcp-select{height:36px;padding:0 12px}
.dshmcp-select{cursor:pointer}
.dshmcp-textarea{min-height:76px;resize:vertical;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:18px}
.dshmcp-input:focus,.dshmcp-select:focus,.dshmcp-textarea:focus{border-color:var(--dsw-alias-brand-primary);box-shadow:inset 0 0 0 .5px var(--dsw-alias-brand-primary)}
.dshmcp-input[aria-invalid=true],.dshmcp-select[aria-invalid=true],.dshmcp-textarea[aria-invalid=true]{border-color:var(--dsw-alias-state-error-primary);box-shadow:none}
.dshmcp-input[aria-invalid=true]:focus,.dshmcp-select[aria-invalid=true]:focus,.dshmcp-textarea[aria-invalid=true]:focus{box-shadow:inset 0 0 0 .5px var(--dsw-alias-state-error-primary)}
@keyframes dshmcp-spin{to{transform:rotate(360deg)}}
@keyframes dshmcp-pulse{0%,100%{opacity:1}50%{opacity:.45}}
@media (max-width:560px){.dshmcp-grid{grid-template-columns:1fr}.dshmcp-line{flex-wrap:wrap}.dshmcp-actions{width:100%;justify-content:flex-end}.dshmcp-confirm{flex-wrap:wrap}}
@media (prefers-reduced-motion:reduce){.dshmcp-dot[data-state=connecting],.dshmcp-skeleton-line,.dshmcp-icon-btn[data-spinning=true] .dshmcp-icon{animation:none}.dshmcp-expand .dshmcp-icon,.dshmcp-switch,.dshmcp-switch::after{transition:none}}
`;

    // ── module surface ────────────────────────────────────────────────────
    /** Required services (cordis fiber inject). */
    const inject = ['slots', 'locale'];

    /**
     * Mount the MCP servers settings section.
     * @param ctx - the browser plugin context.
     */
    function apply(ctx) {
      const t = ctx.locale.bind(NS);
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'mcp-manager: section dictionaries');
      // Own one surface per activation: the local handle keeps this activation's
      // cleanup from disposing a later generation's surface.
      const surface = createRailSurface(ctx, t);
      railSurface = surface;
      ctx.effect(() => () => {
        surface.dispose();
        if (railSurface === surface) railSurface = null;
      }, 'mcp-manager: rail surface');
      // One activation read so the rail entry is right before any page opens.
      ctx.effect(() => {
        let cancelled = false;
        post(ROUTES.list, {})
          .then((payload) => {
            if (!cancelled) surface.reconcile(readRailEntry(payload));
          })
          .catch(() => {
            /* the default (visible) stays; the page corrects it on its first read */
          });
        return () => {
          cancelled = true;
        };
      }, 'mcp-manager: rail preference');
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'mcp-manager',
            order: 60,
            label: () => t('nav'),
            locale: NS,
          },
          McpManagerSection,
        ),
      );
    }

    return { NS, inject, apply };
  },
});
