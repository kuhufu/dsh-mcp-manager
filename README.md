# dsh-mcp-manager

<img src="icon.svg" width="64" height="64" alt="dsh-mcp-manager icon">

[![CI](https://github.com/kuhufu/dsh-mcp-manager/actions/workflows/ci.yml/badge.svg)](https://github.com/kuhufu/dsh-mcp-manager/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 用的 **MCP 服务器管理器**。
在 Web 界面里添加、编辑、启停、重连 **Model Context Protocol** 服务器；保存后它们的工具会以
原生工具 `mcp__<服务器>__<工具>` 出现在 Agent 里。不需要手改 `cordis.patch.yml`，也不需要重启
Harness。

[English](README.en.md) | 中文

## 特性

- **一个页面，两个入口。** **设置 → MCP 服务器** 始终存在；可选的左侧栏入口用本插件自己的图标，
  打开同一个页面的独立面板。页面底部的「在左侧栏显示入口」开关控制它（默认开启）。
- **完整生命周期。** 添加、编辑、启用/停用、重连、删除。保存即连接；停用会结束子进程并移除工具；
  重连重新握手并原子替换整批工具。
- **stdio 与 Streamable HTTP。** stdio 支持命令、参数、环境变量和工作目录；HTTP 支持 URL 和请求头。
- **实时状态与诊断。** 已连接 / 连接中 / 失败（带服务器报错原文）、工具数、服务器版本、
  instructions、可展开的工具清单，以及最近 50 条连接、工具刷新和调用结果。
- **按会话开关 `/mcp`。** 在输入框输入 `/mcp` 打开面板，只对当前会话隐藏或显示服务器；
  `/mcp on|off|list|reset` 提供命令形式。覆盖项按会话持久化，不修改已保存的配置。
  「MCP」标签页与面板同源，出现在对话/轨迹旁边。
- **默认注入。** 关闭某台服务器的「默认注入到每个会话」后，它默认不连接，直到某个会话在
  `/mcp` 里按需开启。适合工具很多的服务器；`dsh-mcp-client` 条目有同名开关。
- **兼容已有 `dsh-mcp-client` 条目。** 外部条目会列出入口 id、传输方式和实时工具数，可以直接
  启用/停用；「迁到此页」会先停用原条目、等待工具释放，再复制配置并连接，避免两条连接抢同名工具。
- **一键导入其他客户端的 MCP JSON。** 工具栏的「导入 MCP JSON」（空状态里也有）接受 Claude
  Desktop、Claude Code、Cursor 的 `mcpServers`，VS Code 的 `servers` 对象或裸映射，支持 JSONC
  注释；自动识别传输、修正名称，默认导入后立即启用并连接。
- **配置管理。** 搜索、状态筛选、复制为新草稿、JSON 批量导入/导出、损坏文件恢复、
  逐工具启停与自动刷新工具目录。
- **零依赖。** 自带小型 MCP 客户端（stdio JSON-RPC + Streamable HTTP）、原子 JSON 存储和精确
  Fetch 路由；无构建步骤、无运行时依赖。

## 截图

设置 → MCP 服务器：在线服务器的状态、端点、工具数与版本，底部的虚线添加行，以及控制第二个
入口的「在左侧栏显示入口」开关。

<img src="docs/screenshots/settings.png" width="760" alt="设置里的 MCP 服务器页面">

同一个页面从左栏打开——左栏图标是本插件自己的，两处渲染一致。

<img src="docs/screenshots/rail-panel.png" width="880" alt="左侧栏面板里的 MCP 服务器页面">

添加服务器时可选命令行（stdio）或 URL（HTTP）；两个弹窗都会校验工具命名空间，避免两台服务器在
`mcp__<名称>__<工具>` 上撞名。

| 添加服务器（stdio） | 编辑服务器（HTTP） |
| --- | --- |
| <img src="docs/screenshots/dialog-stdio.png" width="360" alt="添加 MCP 服务器弹窗（stdio 字段）"> | <img src="docs/screenshots/dialog-http.png" width="420" alt="编辑 MCP 服务器弹窗（URL 与请求头）"> |

## 安装

需要提供 Cordis Fetch 路由与插槽 API 的 Harness 构建；开发与验证基于 `0.2.1-rc.5`。
从源码运行或开发时还需要 Node 22+。

### Web UI（桌面端或 `dsh web`）

1. 打开 **设置 → 插件 → 添加插件**。
2. 填入 `@kuhufu/dsh-mcp-manager`，点 **安装**。
3. 在插件列表里确认 bundle 已 **启用**。安装和启用是两步；装好但没启用的 bundle 不会加载。

从 Git 检出安装请用下面的命令行：它会把目录作为 link 装进去，本地改动在重新加载后生效。

### `dsh` 命令行

```sh
# 安装到命令行 profile（web、tui 或你自己的 profile 名）
dsh plugin --profile web add @kuhufu/dsh-mcp-manager

# 升级到已发布的最新版本
dsh plugin --profile web update @kuhufu/dsh-mcp-manager@latest

# 卸载
dsh plugin --profile web remove @kuhufu/dsh-mcp-manager
```

装好后启动 UI（`dsh web`）；如果 bundle 还没启用，到 **设置 → 插件** 里打开。从源码安装同理：

```sh
git clone https://github.com/kuhufu/dsh-mcp-manager.git
dsh plugin --profile web add ./dsh-mcp-manager   # 相对路径按 shell 当前目录解析
```

### 桌面端 profile

桌面应用独占 `desktop` profile。先打开一次应用让 profile 初始化，**完全退出**后执行：

```sh
dsh plugin --profile desktop add @kuhufu/dsh-mcp-manager
```

再重新打开应用。应用运行期间执行插件命令可能和它的 profile 锁竞争。

> npm 上的 `dsh-mcp-manager` 属于另一个无关项目，所以本插件发布在 `@kuhufu` scope 下。
> 在它发布到 npm 之前，请按上面的方式从 Git 检出安装。

## 使用

### 添加与管理

| 操作 | 效果 |
| --- | --- |
| 添加服务器 | 选择传输方式、填写参数并保存；保存即连接。 |
| 启用 / 停用 | 停用会结束子进程并移除该服务器的工具，配置保留。 |
| 重连 | 重新握手并重建工具集；修改环境变量或服务器升级后使用。 |
| 编辑 | 保存后按连接相关字段决定是否重启；改名称会更换工具命名空间。 |
| 删除 | 断连、移除工具并删除记录（行内二次确认）。 |
| 在左侧栏显示入口 | 安装或移除左栏入口；设置页不受影响。 |
| 外部条目开关 | 直接启用/停用某条 `dsh-mcp-client` 配置，等同「设置 → 插件」里的开关。同名记录已在本页管理时，开关会锁住。 |

### 工具命名

工具注册为 `mcp__<服务器名>__<原始工具名>`，名称中 `[A-Za-z0-9_-]` 以外的字符替换为 `_`
（例如 `mix.content` → `mcp__mix_content`）。MCP 返回 `isError` 时调用失败并带出服务器文本；
重连或重启会原子替换整批工具。跨服务器的工具名冲突（例如服务器 `a__b` + 工具 `c` 与服务器
`a` + 工具 `b__c`）会让该服务器注册失败并显示错误态，而不是静默改名。

### 传输

- **stdio**：`command` + `args` + `env`（可选 `cwd`）。例如
  `command: npx`、`args: -y @modelcontextprotocol/server-filesystem /tmp`。
- **HTTP**（Streamable HTTP）：`url` + 可选 `headers`，例如 `Authorization: Bearer …`。

连接选项：

- 握手超时默认 30 秒，工具调用超时默认 60 秒，可分别设置。
- 自动重连默认关闭，最多 0–10 次，间隔按指数增长并封顶 30 秒。
- 展开服务器可查看实际公开工具名、逐个启停，并查看最近 50 条活动（不含调用参数和结果正文）。

### 按会话开关（`/mcp`）

- 在输入框输入 `/mcp` 打开当前会话的面板；也可以点对话/轨迹旁的 **MCP** 标签页。
- `/mcp on <服务器>`、`/mcp off <服务器>`、`/mcp list`、`/mcp reset` 是等价的命令形式。
- 覆盖项保存在 Session 自己的文档里，不修改全局配置；某个 Session 打开一台全局停用的服务器时，
  该服务器会按需连接，但不会因此对其它 Session 启用。
- 隐藏 `dsh-mcp-client` 条目会对该 Agent 应用 `ctx.tools.restrict({ deny: [...] })` 掩码，
  全局注册的工具只对当前会话消失。

### 外部条目与迁移

已经在 `@deepseek-ai/dsh-mcp-client` 条目里配置的服务器会以只读行出现在本页：

- **启用/停用**：直接写 profile 的启用状态，不修改条目配置。
- **迁到此页**：先停用源条目并等待其工具和子进程释放，再把配置复制成本页记录并连接。
  如果本页已有同名记录，会原地替换并保留 id，也可以用来修复卡在冲突报错里的记录。
- 迁移会带来明文的环境变量和请求头；`!!js process.env.X` 会变成求值后的真实值。

### 直接导入其他客户端的 MCP JSON

工具栏的「导入 MCP JSON」按钮（空状态里也有一个）打开直达导入弹窗：

- 粘贴 Claude Desktop / Claude Code / Cursor 的 `{ "mcpServers": … }`、VS Code 的
  `{ "servers": … }`（同级的 `inputs` 会忽略）、单个服务器对象或裸映射都可以，也可以直接读取文件。
- 支持 JSONC 注释和尾随逗号：带注释的 `mcp.json` 可以原样粘贴。
- 自动识别 stdio / HTTP 传输，把名称里的空格、点号等非法字符规范成短横线；与已有记录重名时
  追加 `-2`、`-3`。弹窗先预览识别到的服务器，导入后列出重命名、跳过和提示。
- 默认「导入后立即启用并连接」；取消勾选则保存为停用。源配置里标了 `"disabled": true` 的条目
  保持停用。
- 不支持旧版 SSE 传输的条目会被跳过并说明原因，不会存成连不上的服务器。

### 导入、导出与复制

在页面末尾「在左侧栏显示入口」上方展开导入/导出区域（本页自己的备份格式）：

- 支持服务器数组和 `{ "version": 1, "servers": [...] }` 导出文档；其他客户端的配置请用上面的
  直达导入。
- 每批 1–200 条；整批校验通过才写入。名称冲突会拒绝整批。
- 导入的服务器一律保持停用，补全凭据后再手动启用。
- 导出默认省略环境变量和请求头；显式勾选后才会写入这些明文值。命令参数和 URL 始终保留，
  其中若包含凭据也会进入导出文件。
- 复制服务器会打开一个名称唯一、默认停用的草稿，确认保存后才创建新记录。

## 数据与安全

| 文件（位于 `$DSH_HOME/storages/`，默认 `~/.dsh`） | 内容 |
| --- | --- |
| `mcp-manager.json` | 服务器记录和 `ui.railEntry` 偏好 |
| `mcp-manager-sessions.json` | 按会话的 `/mcp` 覆盖项 |
| `mcp-manager-external.json` | 外部条目的默认注入偏好（只记录被关闭的条目） |
| `mcp-manager.json.bak` | 上一次有效配置 |

- 写入串行且原子（临时文件 + `rename`），内存只在持久化成功后更新，文件权限为 `0600`。
- 文件损坏、无法读取或版本不支持时进入只读恢复状态，阻止覆盖原文件；恢复或重置前会先把原字节
  归档为 `.recovery-<时间戳>-<uuid>`。旧版缺少 `version` 或 `ui` 的文档仍可读取并在下次写入时升级。
- 单条无效或重复记录会跳过并提示，其余服务器继续可用；下次保存前会归档原文件。
- 环境变量和请求头以 **明文** 保存。MCP 服务器是以你的用户身份启动的普通进程，本插件不额外加
  沙箱；只添加可信的服务器。

## 结构

| 部分 | 文件 | 职责 |
| --- | --- | --- |
| Host | `index.js` + `host/` | 记录、MCP 连接、工具注册、会话可见性、外部条目迁移和 Fetch 路由 |
| Client | `client.js` | 一个 React 页面，注册进 `settings.section`；可选的 `sidebar.panellist` + `main` 入口；`conversation.view` 的 MCP 标签页和输入框 overlay |

Host 侧模块：

| 文件 | 职责 |
| --- | --- |
| `host/manager.js` | 串行化配置操作，持有 store、runtime、session 与外部条目状态 |
| `host/runtime.js` | 连接生命周期、重试、工具定义与活动记录 |
| `host/agents.js` | 按 Agent 注册工具，应用 `/mcp` 可见性 |
| `host/session-state.js` | 持久化会话级覆盖项 |
| `host/external.js` / `external-defaults.js` | `dsh-mcp-client` 条目的启停、迁移和默认注入 |
| `host/profile-patch.js` / `patch-repair.js` | profile patch 的重复声明修复与跨层修复 |
| `host/mcp.js` | 零依赖 MCP 客户端（stdio + Streamable HTTP）与工具桥接 |
| `host/store.js` | 校验、原子持久化与恢复 |
| `host/routes.js` | Fetch 路由与响应整形 |

页面通信全部走 Harness Fetch 桥上的精确 `POST` 路由（相对路径 `api/mcp-manager.*`，由浏览器
会话鉴权，`cache-control: no-store`）：

| 路由 | 用途 |
| --- | --- |
| `list` | 本页管理的服务器 + 只读 `external` 行 + `ui` |
| `save` / `remove` / `toggle` / `reconnect` | 服务器增删改与连接控制 |
| `takeover` | 停用 `dsh-mcp-client` 条目并重建为本页记录 |
| `toggle-external` | 启用/停用 `dsh-mcp-client` 条目 |
| `external-default` | 外部条目的默认注入偏好 |
| `ui` | `railEntry` 偏好 |
| `session` / `session-set` | 会话级可见性与重置 |
| `import` / `export` | 批量导入、导出配置 |
| `import-json` | 直接导入其他客户端的 MCP JSON，可选立即启用 |
| `recover` | 归档原文件并恢复备份或重置 |
| `tool` | 按原始工具名启停 |
| `repair-patch` | 把 home patch 中重复声明的条目移入 profile patch |

请求/响应结构、校验规则和工具桥接契约见 [CONTRACT.md](CONTRACT.md)。

## 开发

纯 ESM，无构建步骤、无运行时依赖，Node 22+。Node 测试只使用内置模块；浏览器测试需要额外的
开发依赖。

```sh
npm run check           # 检查所有源码、脚本和测试的语法
npm test                # 四套 smoke + Node 回归/前端状态测试
npm run test:regression # 只跑 node:test 回归与前端状态
npm run test:browser    # 按 test/BROWSER.md 准备环境后运行
```

- smoke：`mcp` 29 项、`external` 93 项、`takeover-race` 8 项、`patch-repair` 23 项。
- Node：35 项 `regression` + 21 项 `client` 测试，共 56 项，覆盖双入口同步、轮询乱序、取消、
  持久化失败、恢复、动态工具、页面竞态和直接导入的归一化。
- 浏览器套件通过真实 React 18 页面、真实 Host 路由和本地假 MCP 服务运行，覆盖创建/编辑/复制/
  删除、连接选项、工具开关、导入导出、直接导入 MCP JSON、搜索筛选、侧栏偏好、弹窗焦点和
  320–1440 像素宽度。准备方式见 [test/BROWSER.md](test/BROWSER.md)。
- CI 在 Ubuntu/macOS × Node 22/24 上跑 `check` 和 `test`，另有独立的浏览器作业。

## 常见问题

**`连接失败 — tool "mcp__X__y" is already registered`**

同名工具已被另一条 MCP 连接占用，通常是同 `serverName` 的 `@deepseek-ai/dsh-mcp-client`
条目。不要手动再加一份：在只读的「通过 dsh-mcp-client 配置的服务器」里点 **迁到此页**，
它会先停用源条目并等待旧工具释放。如果本页已有同名记录（例如卡在报错中的那条），迁移会原地
替换并保留 id，再点一次即可修复。如果冲突条目不在列表里，先到 **设置 → 插件** 停用它，再回来重连。

**装完看不到页面**

安装和启用是两步：先在 **设置 → 插件** 启用 bundle，再刷新窗口。

**外部条目的开关没反应 / 一直显示启用**

profile patch 把同一条目声明了两次：一个 `disabled: true` 的覆盖行写在同 id 的 `insert`
之前。Plugin Manager 只会原地改覆盖行，后面的 insert 仍然生效。插件会自修复：删掉只含
`id`/`disabled` 的过期覆盖行，保留带配置的声明，并在末尾补一条决定性的 `disabled` 行；
写回前会备份为 `cordis.patch.yml.bak-<时间戳>`，且只在完全识别该形态时动手。其它重复形态
仍返回 `overridden`。

**启动时报 `patches ... must be a top-level YAML array`**

`cordis.patch.yml` 必须以顶层 YAML 数组开头（即使只有注释，也要保留 `[]`）。插件的
`repair-patch` 在写回前会校验这一点；如果文件已经被外部工具改坏，先恢复同一目录下的
`.bak-*` 备份，或补一个 `[]` 再启动。

**设置导航里是齿轮图标**

Harness 按 section id 映射设置导航图标，第三方设置页只能拿到回退的齿轮图标。本插件自己的图标
体现在左侧栏入口上，由页面底部的开关控制。

## 已知边界

- 不持久化 MCP 图片/音频结果；非文本块以文字说明呈现。
- 不支持 MCP prompts 与 resources（与官方 `dsh-mcp-client` 的限制一致）。
- 跨服务器的工具名冲突会使该服务器注册失败并显示错误态，而不是自动改名。

## License

[MIT](LICENSE)
