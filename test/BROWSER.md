# 浏览器交互测试

测试通过真实 React 18 页面、真实 Host 路由和本地假 MCP 服务运行，不安装 Harness 插件。
配置放在 `.qa/browser-home-*` 的独立临时目录，退出时清理；截图位于 `.qa/width-*.png`。
浏览器、React 和 Playwright 仅用于开发验证，不增加插件运行时依赖。

在仓库根目录准备一次：

```sh
python3 -m venv .qa/venv
.qa/venv/bin/pip install -r test/browser-requirements.txt
.qa/venv/bin/python -m playwright install chromium
curl -fsSL https://unpkg.com/react@18.3.1/umd/react.development.js -o .qa/react.js
curl -fsSL https://unpkg.com/react-dom@18.3.1/umd/react-dom.development.js -o .qa/react-dom.js
```

运行（自动启动和关闭本地 4199 端口的测试服务）：

```sh
npm run test:browser
# 若使用已安装的 Google Chrome：
MCP_QA_BROWSER=chrome npm run test:browser
```

覆盖创建、编辑、复制、删除、连接选项、工具开关、导入导出、直接导入 MCP JSON、搜索筛选、侧栏偏好、
保存期间关闭弹窗、弹窗键盘焦点，以及 320 / 768 / 1024 / 1440 像素宽度下的水平溢出与 React 错误。

`npm run test:browser` 是独立入口，并由 CI 的 browser 作业执行。
`npm test` 不下载浏览器，使用内置 `node:test` 检查双入口同步、轮询响应乱序、取消与表单数据。
实际 Harness 插槽集成仍需在目标宿主版本中验收；该测试宿主只模拟所需的插槽接口。
