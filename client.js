/**
 * `@kuhufu/dsh-mcp-manager` — browser half.
 *
 * One Settings section ("MCP servers") over the Host's `api/mcp-manager.*`
 * Fetch routes: list, add/edit, enable, reconnect and delete servers, and show
 * each one's runtime status and the MCP tools it currently bridges.
 *
 * The factory is side-effect free and requires only `react`; the one stylesheet
 * is injected when the plugin activates and removed when it unloads.
 */
window.__ModuleLoader__.load({
  id: '@kuhufu/dsh-mcp-manager',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Dictionary namespace owned by this plugin. */
    const NS = 'settings.mcp-manager';
    /** How often a still-settling server list refreshes (idle lists do not poll). */
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
      session: 'api/mcp-manager.session',
      sessionSet: 'api/mcp-manager.session-set',
      externalDefault: 'api/mcp-manager.external-default',
      import: 'api/mcp-manager.import',
      importJson: 'api/mcp-manager.import-json',
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
      importHint: "Paste this page's own export or a servers array. For a Claude Desktop, Cursor or VS Code config use “Import MCP JSON” instead: it normalizes names and connects at once. Existing names are rejected here, and imported servers stay disabled.",
      importPreview: "{count} server(s) in this document",
      jsonInvalid: "Enter valid JSON.",
      importDone: "Imported {count} disabled server(s).",
      download: "Download JSON",
      chooseFile: "Load JSON file",
      noFileChosen: "No file selected — you can also drop one here.",
      storageProblem: "Configuration could not be loaded. Changes are locked to preserve the original file.",
      restoreBackup: "Restore previous backup",
      resetStorage: "Start with an empty configuration",
      recoverConfirm: "Continue? The current file will be archived before recovery.",
      refreshStatus: "Refresh status",
      exportHint: "Environment variables and headers are omitted by default. Refill them before enabling imported servers.",
      importMcpTitle: "Import MCP JSON",
      importMcpHint: "Paste the MCP configuration of Claude Desktop, Claude Code, Cursor or VS Code. Comments and trailing commas are allowed; every server imports in one batch and the switch below decides whether they connect right away.",
      importMcpReadOnly: "The configuration is locked until it is recovered, so importing is disabled.",
      importMcpParseError: "This is not valid JSON or JSONC.",
      importMcpEmpty: "No MCP servers recognized yet.",
      importMcpCount: "{count} server(s) recognized",
      importMcpMore: "{count} more…",
      importMcpEnable: "Enable and connect immediately",
      importMcpActionOn: "Import and enable",
      importMcpActionOff: "Import as disabled",
      importMcpWorking: "Importing…",
      importMcpDone: "Imported {count} server(s); {enabled} enabled.",
      importMcpDoneAction: "Done",
      importUnknownShort: "?",
      importRenamed: "Renamed “{from}” → “{to}”",
      importSkipped: "Skipped “{name}”: {reason}",
      importNote: "“{name}”: {reason}",
      importReasonSse: "the legacy SSE transport is not supported; use Streamable HTTP",
      importReasonCommand: "no command was given",
      importReasonUrl: "no URL was given",
      importReasonInvalidUrl: "the URL must start with http:// or https://",
      importReasonTransport: "neither a command nor a URL was given",
      importReasonEntry: "the entry is not a server object",
      importReasonUnknownTransport: "unrecognized transport; inferred from the fields",
      importReasonSourceDisabled: "marked disabled in the source configuration",
      importReasonEnvFile: "envFile is not read; refill those environment values manually",
      importReasonPlaceholder: "contains a ${input:…} placeholder that must be filled in",
      importReasonDropped: "some args/environment/header values were dropped",
      importReasonUnknown: "an unrecognized problem",

      nav: 'MCP servers',
      title: 'MCP servers',
      intro:
        'Connect Model Context Protocol servers so their tools become available to the agent. Changes take effect immediately.',
      add: 'Add server',
      refresh: 'Refresh status',
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
      reconnectOff: 'Enable {name} for a session from /mcp before reconnecting',
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
      fieldAutoInject: 'Inject into every session by default',
      fieldAutoInjectShort: 'Inject by default',
      fieldAutoInjectHint: 'Turn off for servers with many tools: they stay disconnected until a session enables them from /mcp.',
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
      errConflict:
        'Another process changed the saved configuration. The page followed the stored state — retry the change.',
      errHttp: 'The host returned HTTP {status}.',
      errInternal: 'The host reported an error.',
      errLoad: 'Could not load the server list.',
      railLabel: 'Show in the sidebar',
      railHint: 'Adds this page as a panel in the left rail; turning it off keeps Settings → MCP servers.',
      viewTab: 'MCP',
      sessionTitle: 'MCP servers for this session',
      sessionHint: 'Only this session is affected; the saved configuration is unchanged.',
      sessionReset: 'Reset to the global configuration',
      sessionEmpty: 'No MCP servers yet.',
      sessionLoading: 'Loading servers…',
      sessionToggle: 'Toggle {name} for this session',
      sessionHidden: 'Hidden here',
      sessionExternalTitle: 'Provided by dsh-mcp-client entries',
      sessionExternalHint: 'Another plugin registers these tools globally; the switches here only hide them from this session.',
      sessionGlobal: 'Global',
      sessionHideExternal: 'Hide {name} from this session',
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
      importHint: "粘贴本页导出的配置或服务器数组。Claude Desktop、Cursor、VS Code 的配置请改用“导入 MCP JSON”：会自动规范名称并立即连接。这里名称重复时整批拒绝，导入后需手动启用。",
      importPreview: "文档包含 {count} 个服务器",
      jsonInvalid: "请输入有效的 JSON。",
      importDone: "已导入 {count} 个服务器，当前均已停用。",
      download: "下载 JSON",
      chooseFile: "读取 JSON 文件",
      noFileChosen: "未选择文件，也可以直接把文件拖到这里。",
      storageProblem: "配置无法读取。为保留原文件，当前已锁定修改。",
      restoreBackup: "恢复上一次备份",
      resetStorage: "使用空配置重新开始",
      recoverConfirm: "确认继续？恢复前会先归档当前文件。",
      refreshStatus: "刷新状态",
      exportHint: "默认不导出环境变量和请求头；导入后请补全这些字段再启用。",
      importMcpTitle: "导入 MCP JSON",
      importMcpHint: "粘贴 Claude Desktop、Claude Code、Cursor 或 VS Code 的 MCP 配置，支持注释和尾随逗号；整批导入，下方开关决定是否立即连接。",
      importMcpReadOnly: "配置已锁定，恢复后才能导入。",
      importMcpParseError: "这不是有效的 JSON / JSONC。",
      importMcpEmpty: "还没有识别到 MCP 服务器。",
      importMcpCount: "识别到 {count} 个服务器",
      importMcpMore: "还有 {count} 个…",
      importMcpEnable: "导入后立即启用并连接",
      importMcpActionOn: "导入并启用",
      importMcpActionOff: "导入为停用",
      importMcpWorking: "导入中…",
      importMcpDone: "已导入 {count} 个服务器，其中 {enabled} 个已启用。",
      importMcpDoneAction: "完成",
      importUnknownShort: "?",
      importRenamed: "已重命名“{from}” → “{to}”",
      importSkipped: "已跳过“{name}”：{reason}",
      importNote: "“{name}”：{reason}",
      importReasonSse: "不支持旧版 SSE 传输，请改用 Streamable HTTP",
      importReasonCommand: "缺少命令",
      importReasonUrl: "缺少 URL",
      importReasonInvalidUrl: "URL 需以 http:// 或 https:// 开头",
      importReasonTransport: "既没有命令也没有 URL",
      importReasonEntry: "该条目不是服务器对象",
      importReasonUnknownTransport: "无法识别传输方式，已按字段推断",
      importReasonSourceDisabled: "源配置里标记为停用",
      importReasonEnvFile: "未读取 envFile，请手动补全环境变量",
      importReasonPlaceholder: "含 ${input:…} 占位符，需要手动填写",
      importReasonDropped: "部分参数、环境变量或请求头已丢弃",
      importReasonUnknown: "未知原因",

      nav: 'MCP 服务器',
      title: 'MCP 服务器',
      intro: '连接 Model Context Protocol 服务器，把它们的工具提供给智能体使用。改动立即生效。',
      add: '添加服务器',
      refresh: '刷新状态',
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
      reconnectOff: '请先在 /mcp 中为本会话启用 {name}，再重新连接',
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
      fieldAutoInject: '默认注入到每个会话',
      fieldAutoInjectShort: '默认注入',
      fieldAutoInjectHint: '工具很多的服务器建议关闭：默认不连接，直到某个会话在 /mcp 里按需开启。',
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
      errConflict: '另一个进程修改了已保存的配置。页面已同步到磁盘上的状态，请重试本次修改。',
      errHttp: '宿主返回了 HTTP {status}。',
      errInternal: '宿主返回了错误。',
      errLoad: '无法读取服务器列表。',
      railLabel: '在左侧栏显示入口',
      railHint: '把本页作为面板加入左侧栏；关闭后仍保留“设置 → MCP 服务器”。',
      viewTab: 'MCP',
      sessionTitle: '本会话的 MCP 服务器',
      sessionHint: '只影响当前会话，不会改动已保存的配置。',
      sessionReset: '恢复全局配置',
      sessionEmpty: '还没有 MCP 服务器。',
      sessionLoading: '正在加载服务器…',
      sessionToggle: '为当前会话开关 {name}',
      sessionHidden: '本会话已隐藏',
      sessionExternalTitle: '由 dsh-mcp-client 条目提供',
      sessionExternalHint: '这些服务器由其他插件全局注册；这里的开关只对当前会话隐藏它们的工具。',
      sessionGlobal: '全局',
      sessionHideExternal: '为当前会话隐藏 {name}',
    };

    // ── wire helpers ──────────────────────────────────────────────────────
    /** A route failure in the Host's documented error shape, or a transport failure. */
    class ApiError extends Error {
      /**
       * @param code - a stable Host failure code, `network`, `http`, or `internal`.
       * @param message - Host-authored detail when available.
       * @param field - form field the Host blames, when it names one.
       * @param status - HTTP status for the `http` fallback.
       */
      constructor(code, message, field, status) {
        super(message);
        this.name = 'ApiError';
        this.code = code;
        this.field = field;
        this.status = status;
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
      throw new ApiError('http', '', undefined, response.status);
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
        if (error.code === 'conflict') return t('errConflict');
        if (error.code === 'http') return t('errHttp', { status: error.status ?? '' });
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
      if (server.status === 'connecting' || server.status === 'starting') return 'connecting';
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

    /**
     * Phase shown by the `/mcp` surfaces. A server this Session shows is not
     * "disabled" even when the deployment-wide switch is off: it is connected
     * for this Session, which is what the panel is about.
     * @param server - one `SessionServerView` row.
     * @returns the phase key used by the dot and its voice.
     */
    function sessionPhaseOf(server) {
      if (server.visible !== true) return 'disabled';
      if (server.status === 'ready') return 'ready';
      if (server.status === 'connecting' || server.status === 'starting') return 'connecting';
      if (server.status === 'error') return 'error';
      return 'stopped';
    }

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

    /**
     * Define one own enumerable property, even for keys such as `__proto__` that
     * a plain assignment would route through the prototype setter and drop.
     * @param target - destination object.
     * @param key - property name.
     * @param value - property value.
     * @returns the same object.
     */
    function setOwn(target, key, value) {
      Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
      return target;
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
        setOwn(record, key, value);
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
        autoInject: server ? server.autoInject !== false : true,
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
      input.autoInject = draft.autoInject !== false;
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
      download: [
        'M12 3v12',
        'm7 10 5 5 5-5',
        'M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2',
      ],
      folder: ['M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z'],
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

    /**
     * A ref that reports whether the component is still mounted, for callbacks
     * that settle after its surface moved on.
     * @returns {{ current: boolean }} liveness ref.
     */
    function useMountedRef() {
      const alive = React.useRef(true);
      React.useEffect(() => {
        alive.current = true;
        return () => {
          alive.current = false;
        };
      }, []);
      return alive;
    }

    /**
     * Modal behavior shared by the add/edit and import dialogs: focus moves to
     * the first field, Tab stays inside the dialog, Escape closes it, and focus
     * returns to the control that opened it.
     * @param onClose - close callback (the latest render's is always used).
     * @param initialFocus - ref of the control to focus on mount.
     * @returns the dialog root ref and its key handler.
     */
    function useDialogModal(onClose, initialFocus) {
      const dialogRef = React.useRef(null);
      const closeRef = React.useRef(onClose);
      closeRef.current = onClose;
      React.useEffect(() => {
        const opener = typeof document !== 'undefined' ? document.activeElement : null;
        const first = initialFocus?.current;
        if (first) first.focus();
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
      const onKeyDown = (event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          closeRef.current();
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
      return { dialogRef, onKeyDown };
    }

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
          'div',
          { className: 'dshmcp-empty-actions' },
          h(
            'button',
            { type: 'button', className: 'dshmcp-btn', 'data-variant': 'primary', onClick: props.onAdd },
            h(Icon, { name: 'plus' }),
            props.t('emptyAction'),
          ),
          h(
            'button',
            { type: 'button', className: 'dshmcp-btn', disabled: props.readOnly, onClick: props.onImport },
            h(Icon, { name: 'download' }),
            props.t('importMcpTitle'),
          ),
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

    /**
     * Rows for MCP servers still owned by other `dsh-mcp-client` entries; each
     * can be migrated here. Memoized: the page hands it a `useMemo` list whose
     * entries already carry their own `busy` flag, so unrelated page state does
     * not rebuild these rows.
     */
    const ExternalList = React.memo(function ExternalList(props) {
      const t = props.t;
      const [confirmId, setConfirmId] = React.useState(null);
      const [openId, setOpenId] = React.useState(null);
      return h(
        'div',
        { className: 'dshmcp-external' },
        h('h3', { className: 'dshmcp-subtitle dshmcp-external-title' }, t('externalTitle')),
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
            const busy = item.busy === true;
            const open = openId === item.entryId;
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
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'dshmcp-disclosure',
                        'aria-expanded': open ? 'true' : 'false',
                        onClick: () => setOpenId(open ? null : item.entryId),
                      },
                      h(
                        'svg',
                        {
                          className: 'dshmcp-chevron',
                          viewBox: '0 0 16 16',
                          width: 12,
                          height: 12,
                          'aria-hidden': 'true',
                          style: { transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .15s ease' },
                        },
                        h('path', {
                          d: 'M6 3.5 10.5 8 6 12.5',
                          fill: 'none',
                          stroke: 'currentColor',
                          strokeWidth: 1.6,
                          strokeLinecap: 'round',
                          strokeLinejoin: 'round',
                        }),
                      ),
                      h('span', { className: 'dshmcp-name' }, name),
                    ),
                    h(
                      'span',
                      { className: 'dshmcp-state' },
                      item.enabled ? t('externalActive') : t('statusDisabled'),
                    ),
                  ),
                  summary
                    ? h('span', { className: 'dshmcp-summary', style: open ? undefined : { display: 'none' }, title: summary }, summary)
                    : null,
                  h(
                    'div',
                    { className: 'dshmcp-meta', style: open ? undefined : { display: 'none' } },
                    h('span', { className: 'dshmcp-chip' }, t(http ? 'shortHttp' : 'shortStdio')),
                    h('span', null, t('toolCount', { count: item.toolCount || 0 })),
                    item.shadowed ? h('span', { className: 'dshmcp-chip' }, t('externalShadowed')) : null,
                    item.entryId ? h('span', { className: 'dshmcp-mono' }, item.entryId) : null,
                    h(
                      'div',
                      { className: 'dshmcp-detail-row' },
                    h(
                      'label',
                      { className: 'dshmcp-meta-toggle', title: t('fieldAutoInjectHint') },
                      h(SwitchButton, {
                        checked: item.autoInject !== false,
                        disabled: busy,
                        label: t('fieldAutoInjectShort'),
                        onChange: () => props.onDefaultInject(item, item.autoInject === false),
                      }),
                      h('span', null, t('fieldAutoInjectShort')),
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'dshmcp-btn dshmcp-btn-small',
                        style: { marginLeft: 'auto' },
                        disabled: busy || confirming,
                        onClick: () => setConfirmId(item.entryId),
                      },
                      t(busy ? 'takeoverBusy' : 'takeover'),
                    ),
                    ),
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
    });

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
      const busyHere = props.busy === true;
      const summary = transportSummary(server);
      const toolCount = typeof server.toolCount === 'number' ? server.toolCount : (server.tools || []).length;
      const detailsId = 'dshmcp-details-' + server.id;
      // A default-off server only connects while a Session shows it; a manual
      // reconnect with nothing demanding it would be a no-op, so the control
      // stays disabled until /mcp (or the default switch) asks for it.
      const reconnectable = !(server.enabled !== false && server.autoInject === false && (server.status === undefined || server.status === 'stopped'));
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
                'aria-label': reconnectable ? t('reconnect', { name: server.name }) : t('reconnectOff', { name: server.name }),
                title: reconnectable ? t('reconnect', { name: server.name }) : t('reconnectOff', { name: server.name }),
                disabled: busyHere || !server.enabled || server.status === 'connecting' || !reconnectable,
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
      const aliveRef = useMountedRef();
      const { dialogRef, onKeyDown } = useDialogModal(props.onClose, fieldRefs.name);
      const [draft, setDraft] = React.useState(() => draftOf(props.server));
      const [errors, setErrors] = React.useState({});
      const [failure, setFailure] = React.useState(null);
      const [saving, setSaving] = React.useState(false);

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
          h(
            'div',
            { className: 'dshmcp-field' },
            h(
              'label',
              { className: 'dshmcp-checkbox', htmlFor: id('autoInject') },
              h('input', {
                id: id('autoInject'),
                type: 'checkbox',
                checked: draft.autoInject !== false,
                onChange: (event) => setDraft((previous) => ({ ...previous, autoInject: event.target.checked })),
              }),
              h('span', null, t('fieldAutoInject')),
            ),
            h('p', { className: 'dshmcp-field-hint' }, t('fieldAutoInjectHint')),
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

    // ── shared page store ──────────────────────────────────────────────────
    // Every mounted surface (the Settings section and the rail page) reads one
    // snapshot and subscribes through `dataListeners`. Polling belongs to the
    // store, not to a component, so the process keeps at most one timer and one
    // copy of state no matter how many surfaces are mounted.
    const dataListeners = new Set();
    /** Committed page snapshot shared by every surface. */
    const managerData = {
      servers: null,
      external: [],
      storage: { readOnly: false, hasBackup: false },
      loadError: null,
      railEntry: true,
    };
    /** Newest list read; a later read supersedes it. */
    let activeRead = null;
    /** One timer while any server can still settle on its own. */
    let pollTimer = null;
    let dataGeneration = 0;
    let readSequence = 0;
    let appliedRead = 0;
    let pendingWrites = 0;
    let mutationTail = Promise.resolve();

    /**
     * Whether the Host may still move this server to another phase by itself.
     * @param server - one row from the list payload.
     * @returns whether a poll could observe a change.
     */
    function isSettling(server) {
      return server.status === 'connecting' || server.status === 'starting'
        || (server.status === 'error' && typeof server.nextRetryAt === 'number');
    }

    /** Publish one committed snapshot to every mounted surface. */
    function notifyData() {
      for (const listener of [...dataListeners]) listener();
    }

    /**
     * Whether any row can still settle without a local write.
     * @returns whether a poll could observe a phase change.
     */
    function hasSettlingServers() {
      return Array.isArray(managerData.servers) && managerData.servers.some(isSettling);
    }

    /**
     * Start the store's single poll timer. It spans the subscribed lifetime so
     * its phase stays stable, but each tick reads only while a row is settling:
     * an idle list costs no request.
     */
    function startPolling() {
      if (pollTimer !== null) return;
      pollTimer = setInterval(() => {
        if (hasSettlingServers()) pollData();
      }, POLL_MS);
    }

    /** Stop the store's poll timer. */
    function stopPolling() {
      if (pollTimer === null) return;
      clearInterval(pollTimer);
      pollTimer = null;
    }

    /**
     * Apply one route payload to the shared snapshot.
     * @param payload - a success payload from any route.
     */
    function publishData(payload) {
      if (Array.isArray(payload.servers)) managerData.servers = payload.servers;
      if (Array.isArray(payload.external)) managerData.external = payload.external;
      if (payload.storage) managerData.storage = payload.storage;
      if (payload.ui) {
        const value = readRailEntry(payload);
        managerData.railEntry = value;
        railSurface?.observe(value);
      }
      managerData.loadError = null;
      notifyData();
    }

    /**
     * Read the list once. A newer read supersedes the previous one, and a
     * response that loses to a mutation or to another read is dropped.
     * @param force - read even while a mutation is in flight (a manual refresh).
     */
    function readData(force = false) {
      if (!force && pendingWrites > 0) return;
      activeRead?.abort();
      const controller = new AbortController();
      activeRead = controller;
      const generation = dataGeneration;
      const sequence = ++readSequence;
      post(ROUTES.list, {}, controller.signal)
        .then((payload) => {
          if (controller.signal.aborted || generation !== dataGeneration || sequence < appliedRead) return;
          appliedRead = sequence;
          publishData(payload);
        })
        .catch((error) => {
          if (controller.signal.aborted || generation !== dataGeneration || sequence < appliedRead) return;
          managerData.loadError = error;
          notifyData();
        })
        .finally(() => {
          if (activeRead === controller) activeRead = null;
        });
    }

    /** The timer's read never stacks on top of one already in flight. */
    function pollData() {
      if (activeRead === null) readData();
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
      setExternalDefault: (entryId, autoInject) => mutateData(ROUTES.externalDefault, { entryId, autoInject }),
      setRailEntry: (railEntry) => mutateData(ROUTES.ui, { railEntry }),
      setToolEnabled: (id, name, enabled) => mutateData(ROUTES.tool, { id, name, enabled }),
      importServers: (document) => mutateData(ROUTES.import, { document }),
      importMcpJson: (document, enable) => mutateData(ROUTES.importJson, { document, enable }),
      exportServers: (includeSecrets) => post(ROUTES.export, { includeSecrets }),
      recover: (mode) => mutateData(ROUTES.recover, { mode }),
    };

    /**
     * Subscribe one surface to the shared page store.
     * @param t - bound translator, used for the load-error voice.
     * @returns the committed snapshot and the shared actions.
     */
    function useManagerData(t) {
      const [, rerender] = React.useReducer((value) => value + 1, 0);
      const alive = React.useRef(true);
      React.useEffect(() => {
        alive.current = true;
        const listener = () => rerender();
        dataListeners.add(listener);
        startPolling();
        readData();
        return () => {
          alive.current = false;
          dataListeners.delete(listener);
          if (dataListeners.size > 0) return;
          stopPolling();
          activeRead?.abort();
          activeRead = null;
        };
      }, []);
      return {
        servers: managerData.servers,
        external: managerData.external,
        storage: managerData.storage,
        loadError: managerData.loadError === null
          ? null
          : { text: t('errLoad'), detail: explain(managerData.loadError, t) },
        railEntry: managerData.railEntry,
        alive,
        requestList: readData,
        actions: managerActions,
      };
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

    /**
     * A themed file picker: the native file control cannot follow the page's
     * tokens (its button renders in the platform's own colours), so a normal
     * button opens a visually hidden input and the chosen name is shown beside
     * it. A dragged file works too.
     * @param props - `t`, `accept`, `disabled` and `onFile(file)`.
     */
    function FileChoice(props) {
      const t = props.t;
      const inputRef = React.useRef(null);
      const [name, setName] = React.useState('');
      const [dragging, setDragging] = React.useState(false);
      const choose = (file) => {
        if (!file) return;
        setName(file.name);
        props.onFile(file);
      };
      return h(
        'div',
        {
          className: 'dshmcp-file',
          'data-dragging': dragging ? 'true' : undefined,
          onDragOver: (event) => {
            if (!event.dataTransfer) return;
            event.preventDefault();
            if (props.disabled) return;
            setDragging(true);
          },
          onDragLeave: () => setDragging(false),
          onDrop: (event) => {
            if (!event.dataTransfer) return;
            event.preventDefault();
            setDragging(false);
            if (props.disabled) return;
            choose(event.dataTransfer.files?.[0]);
          },
        },
        h(
          'button',
          {
            type: 'button',
            className: 'dshmcp-btn dshmcp-btn-small',
            disabled: props.disabled,
            onClick: () => {
              if (inputRef.current) inputRef.current.click();
            },
          },
          h(Icon, { name: 'folder' }),
          t('chooseFile'),
        ),
        h(
          'span',
          { className: 'dshmcp-file-name', 'data-empty': name === '' ? 'true' : undefined, title: name || undefined },
          name === '' ? t('noFileChosen') : name,
        ),
        h('input', {
          ref: inputRef,
          type: 'file',
          className: 'dshmcp-file-input',
          accept: props.accept,
          tabIndex: -1,
          'aria-hidden': 'true',
          disabled: props.disabled,
          onChange: (event) => {
            const file = event.target.files?.[0];
            // Clear so choosing the same file again still fires a change event.
            event.target.value = '';
            choose(file);
          },
        }),
      );
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
        h(FileChoice, {
          key: 'file',
          t,
          accept: '.json,.jsonc,application/json',
          disabled: busy || readOnly,
          onFile: (file) => void run(async () => {
            if (file.size > 2 * 1024 * 1024) throw new ApiError('invalid', t('fileTooLarge'));
            setText(await file.text());
          }),
        }),
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

    // ── direct MCP JSON import ────────────────────────────────────────────
    /** Host import-warning reasons → this page's copy. */
    const IMPORT_REASON_KEY = {
      'sse-unsupported': 'importReasonSse',
      'missing-command': 'importReasonCommand',
      'missing-url': 'importReasonUrl',
      'invalid-url': 'importReasonInvalidUrl',
      'missing-transport': 'importReasonTransport',
      'invalid-entry': 'importReasonEntry',
      'unknown-transport': 'importReasonUnknownTransport',
      'source-disabled': 'importReasonSourceDisabled',
      'env-file-ignored': 'importReasonEnvFile',
      'input-placeholder': 'importReasonPlaceholder',
      'dropped-fields': 'importReasonDropped',
    };

    /** Whether a parsed value is a plain JSON object. */
    function isPlainObject(value) {
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    }

    /** Whether a config object carries a transport or endpoint field. */
    function looksLikeServerConfig(value) {
      return isPlainObject(value) && ['command', 'url', 'transport', 'type'].some((field) => value[field] !== undefined);
    }

    /**
     * Strip the JSONC conveniences third-party MCP configs use — `//` and
     * block comments plus trailing commas — leaving a strict JSON document.
     * String contents (URLs, for example) are never touched.
     * @param text - raw pasted text.
     * @returns the text with comments and trailing commas removed.
     */
    function stripJsonConveniences(text) {
      let stripped = '';
      let inString = false;
      let escaped = false;
      for (let index = 0; index < text.length; index += 1) {
        const char = text[index];
        if (inString) {
          stripped += char;
          if (escaped) escaped = false;
          else if (char === '\\') escaped = true;
          else if (char === '"') inString = false;
          continue;
        }
        if (char === '"') {
          inString = true;
          stripped += char;
          continue;
        }
        if (char === '/' && text[index + 1] === '/') {
          while (index < text.length && text[index] !== '\n') index += 1;
          if (index < text.length) stripped += '\n';
          continue;
        }
        if (char === '/' && text[index + 1] === '*') {
          index += 2;
          while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) index += 1;
          if (index >= text.length) break;
          index += 1;
          stripped += ' ';
          continue;
        }
        stripped += char;
      }
      // Drop only the commas that directly precede a closing brace or bracket.
      let output = '';
      inString = false;
      escaped = false;
      for (let index = 0; index < stripped.length; index += 1) {
        const char = stripped[index];
        if (inString) {
          output += char;
          if (escaped) escaped = false;
          else if (char === '\\') escaped = true;
          else if (char === '"') inString = false;
          continue;
        }
        if (char === '"') {
          inString = true;
          output += char;
          continue;
        }
        if (char === ',') {
          let next = index + 1;
          while (next < stripped.length && /\s/.test(stripped[next])) next += 1;
          if (stripped[next] === '}' || stripped[next] === ']') continue;
        }
        output += char;
      }
      return output;
    }

    /**
     * Parse pasted JSON or JSONC into a document.
     * @param text - pasted configuration.
     * @returns the parsed document, or undefined when the text is not JSON.
     */
    function parseConfigText(text) {
      if (typeof text !== 'string') return undefined;
      const source = text.replace(/^\uFEFF/, '').trim();
      if (source === '') return undefined;
      try {
        return JSON.parse(stripJsonConveniences(source));
      } catch (error) {
        return undefined;
      }
    }

    /**
     * Read the server entries a pasted document declares, mirroring the Host's
     * shape order for the preview list. The Host re-reads and validates the
     * document authoritatively; this only decides what to show before import.
     * @param document - parsed pasted document.
     * @returns {{ name: string, config: unknown }[]} entries in document order.
     */
    function previewEntries(document) {
      /** @type {{ name: string, config: unknown }[]} */
      const entries = [];
      const add = (name, config) => entries.push({ name: typeof name === 'string' ? name : '', config });
      if (Array.isArray(document)) {
        for (const item of document) add(isPlainObject(item) ? item.name : '', item);
        return entries;
      }
      if (!isPlainObject(document)) return entries;
      if (isPlainObject(document.mcpServers)) {
        for (const [name, config] of Object.entries(document.mcpServers)) add(name, config);
        return entries;
      }
      if (Array.isArray(document.servers)) {
        for (const item of document.servers) add(isPlainObject(item) ? item.name : '', item);
        return entries;
      }
      if (isPlainObject(document.servers)) {
        for (const [name, config] of Object.entries(document.servers)) add(name, config);
        return entries;
      }
      if (looksLikeServerConfig(document)) {
        add(document.name, document);
        return entries;
      }
      const values = Object.entries(document).filter(
        ([key]) => !['inputs', '$schema', 'version', 'name', 'description'].includes(key),
      );
      if (values.length > 0 && values.every(([, config]) => isPlainObject(config)) && values.some(([, config]) => looksLikeServerConfig(config))) {
        for (const [name, config] of values) add(name, config);
      }
      return entries;
    }

    /**
     * One preview transport chip.
     * @param config - previewed entry config.
     * @returns 'stdio', 'http', 'sse' or 'invalid'.
     */
    function previewTransport(config) {
      if (!isPlainObject(config)) return 'invalid';
      const type = String(config.type ?? config.transport ?? '').trim().toLowerCase();
      if (type === 'sse' || type === 'sse-http' || type === 'server-sent-events') return 'sse';
      const url = typeof config.url === 'string' && config.url.trim() !== '';
      const command = typeof config.command === 'string'
        ? config.command.trim() !== ''
        : Array.isArray(config.command) && config.command.length > 0;
      if (type === 'http' || type === 'streamable-http' || type === 'streamablehttp' || type === 'streamable_http' || type === 'http-streamable') {
        return url ? 'http' : 'invalid';
      }
      if (type === 'stdio' || type === 'command' || type === 'process') return command ? 'stdio' : 'invalid';
      if (url) return 'http';
      if (command) return 'stdio';
      return 'invalid';
    }

    /**
     * The one-line endpoint preview for a recognized entry.
     * @param config - previewed entry config.
     * @returns the URL, or the command line.
     */
    function previewTarget(config) {
      if (!isPlainObject(config)) return '';
      const url = typeof config.url === 'string' ? config.url.trim() : '';
      if (url !== '') return url;
      const parts = [];
      if (Array.isArray(config.command)) parts.push(...config.command.map(String));
      else if (typeof config.command === 'string') parts.push(config.command.trim());
      if (Array.isArray(config.args)) {
        for (const item of config.args) {
          if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') parts.push(String(item));
        }
      }
      return parts.join(' ');
    }

    /**
     * Localize one Host import-report row.
     * @param warning - `{ kind: 'renamed'|'skipped'|'note', … }` from `import-json`.
     * @param t - bound translator.
     * @returns the sentence to show.
     */
    function importWarningText(warning, t) {
      const reasonKey = IMPORT_REASON_KEY[warning.reason];
      const reason = t(reasonKey !== undefined ? reasonKey : 'importReasonUnknown');
      if (warning.kind === 'renamed') return t('importRenamed', { from: warning.from, to: warning.to });
      if (warning.kind === 'skipped') return t('importSkipped', { name: warning.name, reason });
      return t('importNote', { name: warning.name, reason });
    }

    /**
     * Direct import of another client's MCP JSON: paste (or load) the document,
     * preview what was recognized, then import it — by default enabled and
     * connected at once. The Host normalizes names and reports what changed.
     */
    function ImportJsonDialog(props) {
      const t = props.t;
      const uid = React.useId().replace(/[^A-Za-z0-9_-]/g, '');
      const id = (name) => 'dshmcp-import-' + name + '-' + uid;
      const textRef = React.useRef(null);
      const doneRef = React.useRef(null);
      const aliveRef = useMountedRef();
      const { dialogRef, onKeyDown } = useDialogModal(props.onClose, textRef);
      const [text, setText] = React.useState('');
      const [enable, setEnable] = React.useState(true);
      const [busy, setBusy] = React.useState(false);
      const [failure, setFailure] = React.useState(null);
      const [result, setResult] = React.useState(null);

      const parsed = parseConfigText(text);
      const preview = parsed === undefined ? [] : previewEntries(parsed);
      const ready = parsed !== undefined && preview.length > 0 && !props.readOnly;

      // The submit control disappears when the summary replaces the form; keep
      // focus inside the dialog so Escape and the Tab loop still work.
      React.useEffect(() => {
        if (result !== null && doneRef.current && typeof doneRef.current.focus === 'function') {
          doneRef.current.focus();
        }
      }, [result]);

      const submit = async (event) => {
        event.preventDefault();
        if (busy || !ready) return;
        setBusy(true);
        setFailure(null);
        try {
          const outcome = await props.onImport(parsed, enable);
          if (aliveRef.current) setResult(outcome);
        } catch (error) {
          if (aliveRef.current) setFailure(explain(error, t));
        } finally {
          if (aliveRef.current) setBusy(false);
        }
      };

      const textId = id('json');
      const previewId = id('preview');
      const titleId = id('title');

      const body = result === null
        ? [
            h('p', { key: 'hint', className: 'dshmcp-hint' }, t('importMcpHint')),
            props.readOnly
              ? h('p', { key: 'locked', className: 'dshmcp-hint', role: 'status' }, t('importMcpReadOnly'))
              : null,
            h(FileChoice, {
              key: 'file',
              t,
              accept: '.json,.jsonc,application/json',
              disabled: busy || props.readOnly,
              onFile: (file) => {
                if (file.size > 2 * 1024 * 1024) {
                  setFailure(t('fileTooLarge'));
                  return;
                }
                void file.text().then((value) => {
                  if (aliveRef.current) {
                    setFailure(null);
                    setText(value);
                  }
                }).catch(() => {
                  if (aliveRef.current) setFailure(t('errInternal'));
                });
              },
            }),
            h('label', { key: 'json-label', htmlFor: textId, className: 'dshmcp-label' }, t('jsonConfig')),
            h('textarea', {
              key: 'json',
              id: textId,
              ref: textRef,
              className: 'dshmcp-textarea',
              rows: 10,
              value: text,
              spellCheck: false,
              autoComplete: 'off',
              disabled: busy || props.readOnly,
              'aria-describedby': previewId,
              placeholder: '{\n  "mcpServers": {\n    "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] }\n  }\n}',
              onChange: (event) => setText(event.target.value),
            }),
            h(
              'p',
              { key: 'preview', id: previewId, className: 'dshmcp-hint' },
              text.trim() === ''
                ? t('importMcpEmpty')
                : parsed === undefined
                  ? t('importMcpParseError')
                  : preview.length === 0
                    ? t('importMcpEmpty')
                    : t('importMcpCount', { count: preview.length }),
            ),
            preview.length === 0
              ? null
              : h(
                  'ul',
                  { key: 'list', className: 'dshmcp-import-list', 'aria-label': t('importMcpCount', { count: preview.length }) },
                  preview.slice(0, 8).map((entry, index) => {
                    const kind = previewTransport(entry.config);
                    const target = previewTarget(entry.config);
                    return h(
                      'li',
                      { key: index, className: 'dshmcp-import-row' },
                      h('span', { className: 'dshmcp-import-name' }, entry.name || t('importUnknownShort')),
                      h('span', {
                        className: 'dshmcp-chip',
                        'data-bad': kind === 'invalid' || kind === 'sse' ? 'true' : undefined,
                      }, kind === 'invalid' ? t('importUnknownShort') : kind),
                      target ? h('span', { className: 'dshmcp-import-target', title: target }, target) : null,
                    );
                  }),
                  preview.length > 8
                    ? h('li', { key: 'more', className: 'dshmcp-import-row dshmcp-hint' }, t('importMcpMore', { count: preview.length - 8 }))
                    : null,
                ),
            h(
              'label',
              { key: 'enable', className: 'dshmcp-checkbox' },
              h('input', {
                type: 'checkbox',
                checked: enable,
                disabled: busy || props.readOnly,
                onChange: (event) => setEnable(event.target.checked),
              }),
              t('importMcpEnable'),
            ),
          ].filter(Boolean)
        : [
            h('p', { key: 'done', className: 'dshmcp-import-summary', role: 'status' },
              t('importMcpDone', { count: result.imported, enabled: result.enabled })),
            result.warnings && result.warnings.length > 0
              ? h('ul', { key: 'notes', className: 'dshmcp-import-notes', 'aria-label': t('importMcpTitle') },
                  result.warnings.slice(0, 20).map((warning, index) => h('li', { key: index }, importWarningText(warning, t))))
              : null,
          ].filter(Boolean);

      return h(
        'div',
        { className: 'dshmcp-scrim' },
        h(
          'div',
          {
            className: 'dshmcp-dialog dshmcp-dialog-import',
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
              h('h3', { className: 'dshmcp-dialog-title', id: titleId }, t('importMcpTitle')),
              h('button', {
                type: 'button',
                className: 'dshmcp-icon-btn',
                'aria-label': t('closeDialog'),
                title: t('closeDialog'),
                onClick: props.onClose,
              }, h(Icon, { name: 'close' })),
            ),
            h(
              'div',
              { className: 'dshmcp-dialog-body' },
              failure
                ? h('p', { className: 'dshmcp-banner', 'data-tone': 'error', role: 'alert' },
                    h(Icon, { name: 'alert', size: 16 }),
                    h('span', { className: 'dshmcp-banner-text' }, failure))
                : null,
              body,
            ),
            h(
              'div',
              { className: 'dshmcp-dialog-foot' },
              result !== null
                ? h('button', { ref: doneRef, type: 'button', className: 'dshmcp-btn', 'data-variant': 'primary', onClick: props.onClose }, t('importMcpDoneAction'))
                : [
                    h('button', { key: 'cancel', type: 'button', className: 'dshmcp-btn', onClick: props.onClose }, t('cancel')),
                    h('button', {
                      key: 'submit',
                      type: 'submit',
                      className: 'dshmcp-btn',
                      'data-variant': 'primary',
                      disabled: busy || !ready,
                    }, busy ? t('importMcpWorking') : t(enable ? 'importMcpActionOn' : 'importMcpActionOff')),
                  ],
            ),
          ),
        ),
      );
    }


    // ── per-session `/mcp` panel ──────────────────────────────────────────
    /** Session whose panel is open, if any. */
    let panelSessionId = null;
    /** Components observing the open/closed state. */
    const panelSubscribers = new Set();

    /**
     * Open the panel for one Session.
     * @param sessionId - the Session that invoked `/mcp`.
     */
    function openSessionPanel(sessionId) {
      panelSessionId = sessionId;
      for (const notify of [...panelSubscribers]) notify();
    }

    /** Close the panel and return focus to the composer. */
    function closeSessionPanel() {
      panelSessionId = null;
      for (const notify of [...panelSubscribers]) notify();
    }

    /**
     * Subscribe one component to the panel's open/closed state.
     * @param sessionId - the Session this component renders for.
     * @returns whether the panel is open for that Session.
     */
    function usePanelOpen(sessionId) {
      const [, tick] = React.useReducer((value) => value + 1, 0);
      React.useEffect(() => {
        panelSubscribers.add(tick);
        return () => {
          panelSubscribers.delete(tick);
        };
      }, []);
      return panelSessionId === sessionId;
    }

    /** Panel and View styles, shipped in the activation stylesheet (see {@link injectStyles}). */
    const PANEL_STYLE = `
.dshmcp-session-panel{position:absolute;left:0;right:0;bottom:calc(100% + 8px);z-index:100;pointer-events:auto;box-sizing:border-box;max-height:60vh;overflow-y:auto;border-radius:var(--dsw-radius-lg);border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-prominent);padding:12px;display:flex;flex-direction:column;gap:8px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}
.dshmcp-session-head{display:flex;align-items:flex-start;gap:8px}
.dshmcp-session-titles{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}
.dshmcp-session-title{margin:0;font-size:14px;font-weight:600;line-height:20px}
.dshmcp-session-hint{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dshmcp-session-empty{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-quaternary)}
.dshmcp-session-error{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary)}
.dshmcp-session-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;max-height:40vh;overflow-y:auto;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2)}
.dshmcp-session-row{display:flex;align-items:center;gap:8px;min-height:40px;padding:0 10px;border-top:.5px solid var(--dsw-alias-border-l1)}
.dshmcp-session-row:first-child{border-top:0}
.dshmcp-session-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshmcp-session-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshmcp-session-status{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dshmcp-session-section{display:flex;flex-direction:column;gap:4px;padding-top:8px;border-top:.5px solid var(--dsw-alias-border-l2)}
.dshmcp-session-subtitle{margin:0;font-size:12px;font-weight:600;line-height:18px}
.dshmcp-session-badge{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);border:.5px solid var(--dsw-alias-border-l2);border-radius:999px;padding:0 8px;white-space:nowrap}
.dshmcp-session-foot{display:flex;justify-content:flex-end;padding-top:4px}
.dshmcp-session-panel .dshmcp-switch:disabled{opacity:.5}
.dshmcp-session-page{box-sizing:border-box;width:100%;height:100%;min-height:0;overflow-y:auto;padding:24px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}
.dshmcp-session-wrap{display:flex;flex-direction:column;gap:12px;max-width:760px;margin:0 auto}
.dshmcp-session-page .dshmcp-session-head{align-items:flex-start;gap:0}
.dshmcp-session-page .dshmcp-session-title{font-size:14px;line-height:20px;font-weight:600}
.dshmcp-session-page .dshmcp-session-list{max-height:none;overflow:hidden;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1)}
.dshmcp-session-page .dshmcp-session-row{min-height:48px;padding:0 14px;border:0;border-top:.5px solid var(--dsw-alias-border-l1);border-radius:0;background:transparent;gap:10px}
.dshmcp-session-page .dshmcp-session-row:first-child{border-top:0}
.dshmcp-session-page .dshmcp-session-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshmcp-session-page .dshmcp-session-name{font-size:14px;line-height:22px}
.dshmcp-session-page .dshmcp-session-subtitle{font-size:13px;line-height:20px;margin-top:4px}
.dshmcp-session-page .dshmcp-session-section{border-top:0;padding-top:24px;margin-top:0;gap:6px}
.dshmcp-session-page .dshmcp-session-badge{border:0;padding:0;color:var(--dsw-alias-label-tertiary)}
.dshmcp-session-page .dshmcp-session-foot{padding-top:12px}
`;

    /**
     * Fetch and mutate one Session's MCP visibility for either surface.
     *
     * The effect is keyed by visibility and identity only: hiding the surface or
     * switching Sessions invalidates the previous read through the effect
     * cleanup, so no separate generation term is needed.
     * @param sessionId - the Session to read, or undefined without one.
     * @param active - whether the owning surface is visible.
     * @param t - translator for failure copy.
     * @returns the committed payload, its failure, the pending control id and writes.
     */
    function useSessionData(sessionId, active, t) {
      const [snapshot, setSnapshot] = React.useState(null);
      const [failure, setFailure] = React.useState(null);
      const [busy, setBusy] = React.useState(null);
      const requestGeneration = React.useRef(0);
      const pendingMutation = React.useRef(null);
      const pollInFlight = React.useRef(false);
      const alive = React.useRef(true);
      // Slots may hand a fresh `t` each render; keeping it in a ref stops that
      // from re-running the fetch effect (a request per parent render).
      const translate = React.useRef(t);
      translate.current = t;
      React.useEffect(() => {
        alive.current = true;
        return () => {
          alive.current = false;
          requestGeneration.current += 1;
        };
      }, []);
      React.useEffect(() => {
        const request = ++requestGeneration.current;
        pendingMutation.current = null;
        setSnapshot(null);
        setBusy(null);
        setFailure(null);
        if (active && typeof sessionId === 'string') {
          post(ROUTES.session, { sessionId })
            .then((payload) => {
              if (alive.current && requestGeneration.current === request) setSnapshot(payload);
            })
            .catch((error) => {
              if (alive.current && requestGeneration.current === request) setFailure(explain(error, translate.current));
            });
        }
        return () => {
          requestGeneration.current += 1;
        };
      }, [active, sessionId]);

      const state = snapshot !== null && snapshot.sessionId === sessionId ? snapshot : null;
      const settling = state !== null && Array.isArray(state.servers)
        && state.servers.some((server) => server.status === 'connecting' || server.status === 'starting'
          || (server.status === 'error' && typeof server.nextRetryAt === 'number'));
      React.useEffect(() => {
        if (!active || typeof sessionId !== 'string' || !settling) return undefined;
        const timer = setInterval(() => {
          if (pollInFlight.current || pendingMutation.current !== null) return;
          pollInFlight.current = true;
          const request = ++requestGeneration.current;
          post(ROUTES.session, { sessionId })
            .then((payload) => {
              if (alive.current && requestGeneration.current === request) setSnapshot(payload);
            })
            .catch((error) => {
              if (alive.current && requestGeneration.current === request) setFailure(explain(error, translate.current));
            })
            .finally(() => {
              pollInFlight.current = false;
            });
        }, POLL_MS);
        return () => clearInterval(timer);
      }, [active, sessionId, settling]);
      const mutate = (key, body) => {
        if (pendingMutation.current !== null || state === null || !active) return;
        const request = ++requestGeneration.current;
        pendingMutation.current = request;
        setBusy(key);
        post(ROUTES.sessionSet, { sessionId, ...body })
          .then((payload) => {
            if (!alive.current || requestGeneration.current !== request) return;
            setSnapshot(payload);
            setFailure(null);
          })
          .catch((error) => {
            if (!alive.current || requestGeneration.current !== request) return;
            setFailure(explain(error, translate.current));
          })
          .finally(() => {
            if (!alive.current || requestGeneration.current !== request) return;
            pendingMutation.current = null;
            setBusy(null);
          });
      };

      return {
        state,
        failure,
        busy,
        toggle: (server) => mutate(server.id, { serverId: server.id, enabled: !server.visible }),
        toggleExternal: (item) => mutate(item.entryId, { entryId: item.entryId, enabled: !item.visible }),
        reset: () => mutate('reset', { reset: true }),
      };
    }

    /**
     * Rows shared by the overlay panel and the View: managed servers, external
     * entries and the reset action all read the same session payload. This is a
     * plain tree builder rather than a component, so both surfaces keep the
     * controls at their own level (one tree, two wraps).
     * @param props - `t`, the payload, its failure, the pending control and writes.
     */
    function sessionBody(props) {
      const t = props.t;
      const state = props.state;
      const busy = props.busy;
      return h(
        React.Fragment,
        null,
        props.failure === null ? null : h('p', { className: 'dshmcp-session-error', role: 'alert' }, props.failure),
        state === null
          ? h('p', { className: 'dshmcp-session-hint' }, t('sessionLoading'))
          : state.servers.length === 0
            ? h('p', { className: 'dshmcp-session-empty' }, t('sessionEmpty'))
            : h(
                'ul',
                { className: 'dshmcp-session-list' },
                state.servers.map((server) => {
                  const phase = sessionPhaseOf(server);
                  return h(
                    'li',
                    { key: server.id, className: 'dshmcp-session-row' },
                    h(StatusDot, { phase }),
                    h('span', { className: 'dshmcp-session-name' }, server.name),
                    h('span', { className: 'dshmcp-session-status' }, server.visible ? t(PHASE_KEY[phase]) : t('sessionHidden')),
                    h(SwitchButton, {
                      checked: server.visible,
                      busy: busy === server.id,
                      disabled: busy !== null && busy !== server.id,
                      label: t('sessionToggle', { name: server.name }),
                      onChange: () => props.onToggle(server),
                    }),
                  );
                }),
              ),
        state !== null && Array.isArray(state.external) && state.external.length > 0
          ? h(
              'div',
              { className: 'dshmcp-session-section' },
              h('p', { className: 'dshmcp-session-subtitle' }, t('sessionExternalTitle')),
              h('p', { className: 'dshmcp-session-hint' }, t('sessionExternalHint')),
              h(
                'ul',
                { className: 'dshmcp-session-list' },
                state.external.map((item) =>
                  h(
                    'li',
                    { key: item.entryId, className: 'dshmcp-session-row' },
                    h(StatusDot, { phase: item.enabled ? 'ready' : 'disabled' }),
                    h('span', { className: 'dshmcp-session-name' }, item.serverName || item.entryId),
                    item.enabled
                      ? h('span', { className: 'dshmcp-session-status' }, item.visible ? t('sessionGlobal') : t('sessionHidden'))
                      : h('span', { className: 'dshmcp-session-badge' }, t('statusDisabled')),
                    h(SwitchButton, {
                      checked: item.visible,
                      busy: busy === item.entryId,
                      disabled: busy !== null,
                      label: t('sessionHideExternal', { name: item.serverName || item.entryId }),
                      onChange: () => props.onToggleExternal(item),
                    }),
                  ),
                ),
              ),
            )
          : null,
        h(
          'div',
          { className: 'dshmcp-session-foot' },
          h(
            'button',
            {
              type: 'button',
              className: 'dshmcp-btn dshmcp-btn-small',
              onClick: props.onReset,
              disabled: busy !== null || state === null,
            },
            t('sessionReset'),
          ),
        ),
      );
    }

    /**
     * The `/mcp` overlay: the same session body in a floating card above the
     * composer. The header entry and the bare `/mcp` command open it.
     * @param props - slot props; `sessionId` comes from the slot's `inject` hook.
     * @returns the panel, or null while closed.
     */
    function McpSessionPanel(props) {
      const t = React.useMemo(
        () => (typeof props.t === 'function' ? props.t : directTranslator()),
        [props.t],
      );
      // Some shells do not pass `inject:` props to slot entries; the action that
      // opened the panel already recorded the Session, so fall back to it.
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : panelSessionId;
      const open = usePanelOpen(sessionId);
      const { state, failure, busy, toggle, toggleExternal, reset } = useSessionData(sessionId, open, t);

      React.useEffect(() => {
        if (!open) return undefined;
        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          event.stopPropagation();
          closeSessionPanel();
        };
        window.addEventListener('keydown', onKeyDown, true);
        return () => window.removeEventListener('keydown', onKeyDown, true);
      }, [open]);

      if (!open || typeof sessionId !== 'string') return null;

      return h(
        'div',
        { className: 'dshmcp-session-panel', role: 'dialog', 'aria-label': t('sessionTitle') },
        h(
          'div',
          { className: 'dshmcp-session-head' },
          h(
            'div',
            { className: 'dshmcp-session-titles' },
            h('h3', { className: 'dshmcp-session-title' }, t('sessionTitle')),
            h('p', { className: 'dshmcp-session-hint' }, t('sessionHint')),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dshmcp-icon-btn',
              'aria-label': t('closeDialog'),
              title: t('closeDialog'),
              onClick: closeSessionPanel,
            },
            h(Icon, { name: 'close' }),
          ),
        ),
        sessionBody({ t, state, failure, busy, onToggle: toggle, onToggleExternal: toggleExternal, onReset: reset }),
      );
    }

    /**
     * The whole-page Conversation View: the same session body laid out as a
     * first-class page beside Chat and Trajectory.
     * @param props - View slot props; `sessionId` comes from the slot's `inject` hook.
     * @returns the page, or null without a Session.
     */
    function McpSessionView(props) {
      const t = React.useMemo(
        () => (typeof props.t === 'function' ? props.t : directTranslator()),
        [props.t],
      );
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : undefined;
      const { state, failure, busy, toggle, toggleExternal, reset } = useSessionData(
        sessionId,
        typeof sessionId === 'string',
        t,
      );
      if (typeof sessionId !== 'string') return null;
      return h(
        'div',
        { className: 'dshmcp-session-page', role: 'region', 'aria-label': t('sessionTitle') },
        h(
          'div',
          { className: 'dshmcp-session-wrap' },
          h(
            'div',
            { className: 'dshmcp-session-head' },
            h(
              'div',
              { className: 'dshmcp-session-titles' },
              h('h2', { className: 'dshmcp-session-title' }, t('sessionTitle')),
              h('p', { className: 'dshmcp-session-hint' }, t('sessionHint')),
            ),
          ),
          sessionBody({ t, state, failure, busy, onToggle: toggle, onToggleExternal: toggleExternal, onReset: reset }),
        ),
      );
    }

    // ── the section ───────────────────────────────────────────────────────
    /**
     * Render the MCP servers settings page.
     * @param props - slot props; `t` is bound to this plugin's namespace.
     * @returns the section and any open dialog.
     */
    function McpManagerSection(props) {
      const t = React.useMemo(
        () => (typeof props.t === 'function' ? props.t : directTranslator()),
        [props.t],
      );
      const { servers, external, storage, loadError, railEntry, alive, requestList, actions } = useManagerData(t);
      const [notice, setNotice] = React.useState(null);
      const [busyVersion, setBusyVersion] = React.useState(0);
      const activeActions = React.useRef(new Set());
      const [confirmId, setConfirmId] = React.useState(null);
      const [expanded, setExpanded] = React.useState({});
      const [editor, setEditor] = React.useState(null);
      const [importOpen, setImportOpen] = React.useState(false);
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

      // Busy ids live in a ref; the counter re-renders the rows that read it.
      const bumpBusy = () => setBusyVersion((value) => value + 1);
      const run = React.useCallback(async (id, task) => {
        if (activeActions.current.has(id)) return;
        activeActions.current.add(id);
        bumpBusy();
        try {
          await task();
        } catch (error) {
          if (!alive.current) return;
          setNotice({ tone: 'error', text: explain(error, t) });
          // The record the row pointed at is gone, or another process replaced
          // the document; resync so the list matches the Host.
          if (error instanceof ApiError && (error.code === 'not-found' || error.code === 'conflict')) requestList(true);
        } finally {
          activeActions.current.delete(id);
          if (alive.current) bumpBusy();
        }
      }, [t]);

      const toggleServer = (server) =>
        run(server.id, async () => {
          await actions.toggle(server.id, !server.enabled);
        });

      const reconnectServer = (server) =>
        run(server.id, async () => {
          await actions.reconnect(server.id);
        });

      // Stable identities: `ExternalList` is memoized and must skip a page
      // render that only changed unrelated state.
      const takeoverServer = React.useCallback((item) =>
        run(item.entryId, async () => {
          await actions.takeover(item.entryId);
        }), [run]);

      const setExternalDefault = React.useCallback((item, autoInject) =>
        run(item.entryId, async () => {
          await actions.setExternalDefault(item.entryId, autoInject);
        }), [run]);

      const toggleExternal = React.useCallback((item) =>
        run(item.entryId, async () => {
          await actions.toggleExternal(item.entryId, !item.enabled);
        }), [run]);

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
      const needle = query.toLowerCase();
      const matchesServer = (server) => (filter === 'all' || phaseOf(server) === filter)
        && `${server.name ?? server.serverName ?? ''} ${transportSummary(server)}`.toLowerCase().includes(needle);
      const rows = allRows.filter(matchesServer);
      // One stable array for the memoized `ExternalList`: each entry carries its
      // own busy flag, so it only changes when the rows, the filters or a pending
      // write change — not on every page render.
      const foreign = React.useMemo(
        () => external
          .filter((item) => (filter === 'all' || (item.enabled ? 'ready' : 'disabled') === filter)
            && `${item.serverName ?? ''} ${transportSummary(item)}`.toLowerCase().includes(needle))
          .map((item) => ({ ...item, busy: activeActions.current.has(item.entryId) })),
        [external, filter, needle, busyVersion],
      );
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
          h('button', { className: 'dshmcp-btn', type: 'button', 'aria-label': t('importMcpTitle'), title: t('importMcpTitle'), disabled: storage.readOnly, onClick: () => setImportOpen(true) }, h(Icon, { name: 'download' }), t('importMcpTitle')),
          h('button', { className: 'dshmcp-btn dshmcp-btn-square', type: 'button', 'aria-label': t('add'), title: t('add'), onClick: () => openEditor('add', null) }, h(Icon, { name: 'plus' })),
          h('button', { className: 'dshmcp-btn dshmcp-btn-square', type: 'button', 'aria-label': t('refreshStatus'), title: t('refreshStatus'), onClick: () => requestList(true) }, h(Icon, { name: 'refresh' }))),
        h('div', { inert: storage.readOnly ? '' : undefined },
        loading
          ? h(SkeletonRows, { t })
          : allRows.length === 0 && external.length === 0 && loadError === null
            ? h(EmptyState, { t, readOnly: storage.readOnly, onAdd: () => openEditor('add', null), onImport: () => setImportOpen(true) })
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
                        busy: activeActions.current.has(server.id),
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
          : h(ExternalList, { t, items: foreign, onTakeover: takeoverServer, onToggle: toggleExternal, onDefaultInject: setExternalDefault }),
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
        importOpen
          ? h(ImportJsonDialog, {
              t,
              readOnly: storage.readOnly,
              onClose: () => setImportOpen(false),
              onImport: (document, enable) => actions.importMcpJson(document, enable),
            })
          : null,
      );
    }

    // ── styles ────────────────────────────────────────────────────────────
    /**
     * The page's stylesheet, injected once by the activation effect (see
     * {@link injectStyles}). Only the contracted `--dsw-alias-*` tokens carry
     * colour; `color-mix` derives tints and veils so the page follows light and
     * dark themes.
     */
    const STYLE_TEXT = `
.dshmcp-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0}
.dshmcp-toolbar>.dshmcp-input{flex:1;min-width:160px}
.dshmcp-toolbar>.dshmcp-filter{position:relative;display:inline-flex;align-items:center;width:auto;max-width:100%}
.dshmcp-toolbar .dshmcp-select-filter{appearance:none;-webkit-appearance:none;width:auto;min-width:0;padding:0 34px 0 12px;background-image:none}
.dshmcp-caret{position:absolute;right:14px;top:50%;transform:translateY(-50%);display:flex;pointer-events:none;color:var(--dsw-alias-label-secondary)}
.dshmcp-transfer,.dshmcp-recovery{padding:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);min-width:0}
.dshmcp-transfer{position:relative;margin-top:24px}
.dshmcp-transfer::before{content:"";position:absolute;left:0;right:0;top:-16px;height:0;border-top:.5px solid var(--dsw-alias-border-l2)}
.dshmcp-transfer>summary,.dshmcp-log>summary{cursor:pointer;padding:4px 0}
.dshmcp-transfer>*{max-width:100%}
.dshmcp-transfer>label,.dshmcp-transfer>input{margin:8px 0}
.dshmcp-checkbox{display:flex;gap:8px;align-items:center}
.dshmcp-file{display:flex;align-items:center;gap:10px;padding:5px 8px;border:.5px dashed var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:color-mix(in srgb,var(--dsw-alias-label-primary) 3%,transparent);min-width:0;transition:border-color .15s ease,background .15s ease}
.dshmcp-file[data-dragging=true]{border-color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 8%,transparent)}
.dshmcp-file-name{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1}
.dshmcp-file-name[data-empty=true]{color:var(--dsw-alias-label-tertiary)}
.dshmcp-file-input{position:absolute;width:1px;height:1px;margin:-1px;padding:0;border:0;clip:rect(0 0 0 0);clip-path:inset(50%);overflow:hidden;white-space:nowrap;pointer-events:none}
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
.dshmcp-icon-btn{box-sizing:border-box;width:28px;height:28px;padding:0;border-radius:var(--dsw-radius-sm);border:0;background:transparent;color:var(--dsw-alias-label-secondary);display:inline-flex;align-items:center;justify-content:center;cursor:pointer;flex:none}
.dshmcp-icon-btn:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-label-primary) 7%,transparent);color:var(--dsw-alias-label-primary)}
.dshmcp-icon-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dshmcp-icon-btn:disabled{opacity:.45;cursor:default}
.dshmcp-icon-btn[data-danger=true]{color:var(--dsw-alias-state-error-primary)}
.dshmcp-icon-btn[data-danger=true]:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent);color:var(--dsw-alias-state-error-primary)}
.dshmcp-icon{display:block;flex:none}
.dshmcp-banners{display:flex;flex-direction:column;gap:8px}
.dshmcp-banner{display:flex;align-items:flex-start;gap:10px;margin:0;padding:10px 12px;border-radius:var(--dsw-radius-md);font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}
.dshmcp-banner[data-tone=error]{border:.5px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 35%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent)}
.dshmcp-banner[data-tone=error]>.dshmcp-icon{color:var(--dsw-alias-state-error-primary)}
.dshmcp-banner[data-tone=ok]{border:.5px solid color-mix(in srgb,var(--dsw-alias-state-success-primary) 35%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 8%,transparent)}
.dshmcp-banner[data-tone=ok]>.dshmcp-icon{color:var(--dsw-alias-state-success-primary)}
.dshmcp-banner-body{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}
.dshmcp-banner-text{margin:0;flex:1;min-width:0;overflow-wrap:anywhere}
.dshmcp-banner-detail{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.dshmcp-banner .dshmcp-btn{flex:none;align-self:center}
.dshmcp-list{list-style:none;margin:4px 0 0;padding:0;display:flex;flex-direction:column;gap:10px}
.dshmcp-row{display:flex;flex-direction:column;gap:10px;padding:18px 18px;border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-module-platform);min-width:0}
.dshmcp-btn-square{width:36px;padding:0}
.dshmcp-external{display:flex;flex-direction:column;gap:8px;margin-top:20px;padding-top:16px;border-top:.5px solid var(--dsw-alias-border-l2)}
.dshmcp-external .dshmcp-row{background:transparent;border:.5px dashed var(--dsw-alias-border-l2)}
.dshmcp-line{display:flex;align-items:flex-start;gap:12px;min-width:0}
.dshmcp-dot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--dsw-alias-state-idle-primary)}
.dshmcp-dot[data-state=ready]{background:var(--dsw-alias-state-success-primary)}
.dshmcp-dot[data-state=connecting]{background:var(--dsw-alias-state-warn-primary);animation:dshmcp-pulse 1.4s ease-in-out infinite}
.dshmcp-dot[data-state=error]{background:var(--dsw-alias-state-error-primary)}
.dshmcp-main{display:flex;flex-direction:column;gap:6px;min-width:0;flex:1}
.dshmcp-name-row{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;min-width:0}
.dshmcp-name{font-size:14px;font-weight:500;line-height:20px;overflow-wrap:anywhere}
.dshmcp-row[data-state=idle] .dshmcp-name{color:var(--dsw-alias-label-secondary)}
.dshmcp-state{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dshmcp-state[data-state=ready]{color:var(--dsw-alias-state-success-primary)}
.dshmcp-state[data-state=connecting]{color:var(--dsw-alias-state-warn-primary)}
.dshmcp-state[data-state=error]{color:var(--dsw-alias-state-error-primary)}
.dshmcp-summary{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.dshmcp-chevron{font-size:11px;line-height:1;color:var(--dsw-alias-label-tertiary);transition:color .15s ease}
.dshmcp-disclosure:hover .dshmcp-chevron{color:var(--dsw-alias-brand-primary)}
.dshmcp-disclosure{display:flex;align-items:center;gap:4px;padding:0;border:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer;min-width:0}
.dshmcp-disclosure:hover{color:var(--dsw-alias-brand-primary)}
.dshmcp-detail-row{display:flex;align-items:center;gap:12px;margin-top:2px}
.dshmcp-meta-toggle{display:flex;align-items:center;gap:8px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dshmcp-meta{display:flex;align-items:center;flex-wrap:wrap;gap:6px 12px;margin-top:4px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);min-width:0}
.dshmcp-chip{border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);padding:0 5px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:16px;text-transform:lowercase}
.dshmcp-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px}
.dshmcp-actions{display:flex;align-items:center;gap:2px;flex:none;padding-top:1px}
.dshmcp-actions-spaced{gap:10px}
.dshmcp-switch{position:relative;box-sizing:border-box;width:36px;height:20px;padding:0;border-radius:999px;border:.5px solid var(--dsw-alias-border-l3);background:color-mix(in srgb,var(--dsw-alias-label-primary) 12%,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-label-secondary);cursor:pointer;flex:none;transition:background .15s ease,border-color .15s ease}
.dshmcp-switch::after{content:"";position:absolute;top:50%;left:2px;width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-bg-base);box-shadow:0 1px 2px color-mix(in srgb,var(--dsw-alias-label-primary) 30%,transparent);transform:translateY(-50%);transition:left .15s ease}
.dshmcp-switch[aria-checked=true]{background:var(--dsw-alias-brand-primary);border-color:transparent}
.dshmcp-switch[aria-checked=true]::after{left:18px}
.dshmcp-switch[aria-busy=true]{cursor:progress}
.dshmcp-switch[aria-busy=true]::after{opacity:.35}
.dshmcp-switch:disabled{cursor:default}
.dshmcp-switch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.dshmcp-expand{display:inline-flex;align-items:center;gap:3px;padding:0;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:12px;line-height:18px;cursor:pointer}
.dshmcp-expand:hover{color:var(--dsw-alias-label-primary)}
.dshmcp-expand:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.dshmcp-expand[aria-expanded=true] .dshmcp-icon{transform:rotate(180deg)}
.dshmcp-expand .dshmcp-icon{transition:transform .16s ease}
.dshmcp-row-error{display:flex;align-items:flex-start;gap:6px;margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere}
.dshmcp-row-error .dshmcp-icon{margin-top:2px}
.dshmcp-details{display:flex;flex-direction:column;gap:10px;margin:2px 0 0;padding:10px 12px;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);background:color-mix(in srgb,var(--dsw-alias-label-primary) 4%,transparent)}
.dshmcp-hint{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dshmcp-tools{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}
.dshmcp-tool{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:4px 8px;min-width:0}
.dshmcp-tool-name{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.dshmcp-tool-desc{grid-column:1/-1;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.dshmcp-detail-block{display:flex;flex-direction:column;gap:4px}
.dshmcp-subtitle{margin:0;font-size:12px;font-weight:600;line-height:18px}
.dshmcp-external-title{font-size:15px;line-height:22px}
.dshmcp-instructions{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere;white-space:pre-wrap;max-height:132px;overflow-y:auto}
.dshmcp-facts{display:flex;flex-direction:column;gap:2px;margin:0}
.dshmcp-fact{display:flex;gap:8px;font-size:12px;line-height:18px;min-width:0}
.dshmcp-fact dt{color:var(--dsw-alias-label-secondary);flex:none}
.dshmcp-fact dd{margin:0;min-width:0;overflow-wrap:anywhere;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--dsw-alias-label-primary)}
.dshmcp-confirm{display:flex;align-items:flex-start;gap:10px;padding:10px 12px;border-radius:var(--dsw-radius-md);border:.5px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 35%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent)}
.dshmcp-confirm>.dshmcp-icon{color:var(--dsw-alias-state-error-primary);margin-top:2px}
.dshmcp-confirm-body{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}
.dshmcp-confirm-text{margin:0;font-size:13px;line-height:20px;overflow-wrap:anywhere}
.dshmcp-confirm-hint{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dshmcp-confirm-actions{display:flex;align-items:center;gap:6px;flex:none;align-self:center}
.dshmcp-empty{display:flex;flex-direction:column;align-items:center;gap:8px;text-align:center;padding:32px 20px;border:.5px dashed var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-module-platform)}
.dshmcp-empty-icon{display:inline-flex;color:var(--dsw-alias-label-secondary)}
.dshmcp-empty-title{margin:0;font-size:14px;font-weight:500;line-height:20px}
.dshmcp-empty-hint{margin:0;max-width:46ch;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.dshmcp-empty-actions{display:flex;flex-wrap:wrap;justify-content:center;gap:8px;margin-top:6px;max-width:100%}
.dshmcp-empty-actions .dshmcp-btn{margin-top:0}
.dshmcp-dialog-import{width:min(680px,100%)}
.dshmcp-import-list{list-style:none;margin:0;padding:8px 10px;display:flex;flex-direction:column;gap:6px;max-height:174px;overflow-y:auto;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);background:color-mix(in srgb,var(--dsw-alias-label-primary) 4%,transparent)}
.dshmcp-import-row{display:flex;align-items:baseline;gap:8px;font-size:12px;line-height:18px;min-width:0}
.dshmcp-import-name{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere;flex:none;max-width:40%}
.dshmcp-import-target{color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1}
.dshmcp-chip[data-bad=true]{border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 45%,transparent);color:var(--dsw-alias-state-warn-primary);text-transform:none}
.dshmcp-import-summary{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.dshmcp-import-notes{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.dshmcp-skeleton{display:flex;flex-direction:column;gap:14px;padding:8px 0;margin-top:4px}
.dshmcp-skeleton-row{display:flex;align-items:center;gap:12px}
.dshmcp-skeleton-dot{width:8px;height:8px;border-radius:50%;flex:none;background:color-mix(in srgb,var(--dsw-alias-label-primary) 10%,transparent)}
.dshmcp-skeleton-lines{display:flex;flex-direction:column;gap:6px;flex:1}
.dshmcp-skeleton-line{height:12px;border-radius:var(--dsw-radius-sm);background:color-mix(in srgb,var(--dsw-alias-label-primary) 9%,transparent);animation:dshmcp-pulse 1.6s ease-in-out infinite}
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
@keyframes dshmcp-pulse{0%,100%{opacity:1}50%{opacity:.45}}
@media (max-width:560px){.dshmcp-grid{grid-template-columns:1fr}.dshmcp-line{flex-wrap:wrap}.dshmcp-actions{width:100%;justify-content:flex-end}.dshmcp-confirm{flex-wrap:wrap}}
@media (prefers-reduced-motion:reduce){.dshmcp-dot[data-state=connecting],.dshmcp-skeleton-line{animation:none}.dshmcp-expand .dshmcp-icon,.dshmcp-switch,.dshmcp-switch::after{transition:none}}
`;

    // ── module surface ────────────────────────────────────────────────────
    /** Required services (cordis fiber inject). */
    const inject = ['slots', 'locale'];

    /**
     * Inject this plugin's single stylesheet. Activation owns it through
     * `ctx.effect`, so opening and closing the panel never inserts or removes a
     * `<style>` element — each such change forced a whole-document restyle.
     * @returns the disposer that removes the injected element.
     */
    function injectStyles() {
      if (typeof document === 'undefined' || !document.head) return undefined;
      const style = document.createElement('style');
      style.setAttribute('data-dshmcp', '');
      style.textContent = STYLE_TEXT + PANEL_STYLE;
      document.head.appendChild(style);
      return () => {
        style.remove();
      };
    }

    /**
     * Mount the MCP servers settings section.
     * @param ctx - the browser plugin context.
     */
    function apply(ctx) {
      const t = ctx.locale.bind(NS);
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'mcp-manager: section dictionaries');
      ctx.effect(() => injectStyles(), 'mcp-manager: stylesheet');
      // `/mcp`: the host command carries the argument form; this decoration adds
      // the bare-invocation panel, which is client-owned and never submitted.
      // `ctx.inject` callbacks may run again when dependencies change; the
      // decoration must be registered exactly once or the catalog refresh loops.
      let decorated = false;
      const decorateCommand = (commandUi) => {
        if (decorated) return;
        decorated = true;
        try {
          commandUi.decorate({
            name: 'mcp',
            available: () => true,
            ui: {
              kind: 'action',
              run: (session) => {
                if (typeof session?.sessionId === 'string') openSessionPanel(session.sessionId);
              },
            },
          });
        } catch (error) {
          /* the host row may not be in the catalog yet; the command still runs server-side */
        }
      };
      if (typeof ctx.inject === 'function') ctx.inject(['commandUi'], (scope) => decorateCommand(scope.commandUi));
      // `MCP` is a first-class Session View beside Chat and Trajectory. The View
      // contract carries id/label/order for the tab (tab labels are text-only, so
      // the server glyph lives in the page header) and needs no target snapshot
      // here: MCP has no Conversation event stream, and its data comes from
      // `POST api/mcp-manager.session`. A shell without the injectable View slot
      // never runs this callback; a More-menu row is not a substitute, because
      // that menu only selects Views that are already registered.
      ctx.slots.inject('conversation.view', () => ctx.slots.register({
        name: 'conversation.view',
        id: 'mcp',
        order: 20,
        locale: NS,
        label: () => t('viewTab'),
        inject: (sessionId) => ({ sessionId }),
      }, McpSessionView));
      // The panel lives in the composer overlay so it tracks the active Session.
      ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
        name: 'conversation.input.overlay',
        id: 'mcp-session-panel',
        order: 50,
        locale: NS,
        inject: (sessionId) => ({ sessionId }),
      }, McpSessionPanel));
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
