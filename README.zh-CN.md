# raw-agent (raw)

专为大模型与自动化 Agent 设计的轻量级浏览器自动化运行时与 CLI 工具，支持通过 Chrome DevTools Protocol (CDP) 及原生扩展桥深度调度 Chrome 与 Microsoft Edge。

[![Node.js: >=22.21.0](https://img.shields.io/badge/Node.js-%3E%3D22.21.0-brightgreen.svg)]()
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Tests: 41 Passed](https://img.shields.io/badge/Tests-41%20Passed-success.svg)]()

---

## 1. 什么是 raw-agent？

`raw-agent` (`raw`) 是一个极简、高性能的浏览器自动化核心引擎。它在自动化 Agent 与真实用户浏览器（Chrome / Edge）之间建立低延迟通道，提供细粒度的 DOM 元素操作、无障碍可访问性快照（Accessibility Snapshot）、Cookie 与本地存储读写、网络代理调度以及真实的鼠标键盘硬件事件模拟。

## 2. 定位与支持范围

- **专注浏览器自动化**：本项目完全聚焦于浏览器驱动与控制。历史版本中的终端 TUI、模型提供商配置及通用对话循环已彻底从本仓库剥离，保持纯粹的自动化内核。
- **双模桥接架构**：
  - **原生 Chrome/Edge CDP 模式**：直连通过 `--remote-debugging-port` 启动的 Chromium 实例（默认端口 `9333`）。
  - **Edge 扩展桥模式 (`edge-bridge/`)**：通过 Native Messaging 主机与专用扩展驱动用户本机的真实 Edge 浏览器会话，免去空白 Profile 无法复用登录态的痛点。

---

## 3. 架构与桥接工作机制

### Edge 原生扩展桥工作流程

```text
Node.js (raw CLI / Agent)
       │
       ▼ (CDP / WebSocket :9333)
Native Host (edge-bridge/host/Program.cs - 标准 I/O)
       │
       ▼ (Native Messaging 原生消息协议)
Edge MV3 扩展 (edge-bridge/extension/)
       │
       ▼ (chrome.debugger + chrome.cookies + chrome.tabs APIs)
用户原生浏览器 Profile (Microsoft Edge)
```

1. **Native Host 宿主进程**：C# 编写的高性能宿主程序 (`RawEdgeBridge.exe`)，通过标准输入输出与浏览器进行原生消息通信。
2. **Edge 浏览器扩展**：基于 `chrome.debugger` API 动态挂载到目标标签页，桥接 CDP 方法并调用完整的扩展能力（标签页、Cookie、代理、下载拦截、脚本注入）。
3. **本地回环服务**：Native Host 在本地回环地址 `127.0.0.1:9333` 暴露 WebSocket 调试端口，供 `raw` 运行时免配置直连并进行令牌校验。

---

## 4. 权限与信任模型

- **本地回环安全边界**：所有 WebSocket、CDP 及 Bridge 监听器均强制绑定至 `127.0.0.1`，默认拒绝任何公网或外部局域网连接。
- **完全浏览器控制权限**：扩展桥拥有系统级浏览器权限（`<all_urls>`、`debugger`、`proxy`、`downloads`、`cookies` 等），具备读取和操作所有已打开页面的能力。
- **网页内容不可信**：从目标网页中提取的 DOM 文本、网络响应及页面结构均属于**外部不可信数据**。调用方切勿直接将未校验的网页输出拼装入系统命令执行。

---

## 5. 安全限制与防护设计

- **智能输入适配**：`setValue` 内置对 Monaco Editor、CodeMirror 5/6 及 React 受控组件的原生 Setter 检测与驱动，防止直接执行危险脚本注入。
- **上下文隔离 (`space`)**：支持命名空间隔离（`--space <name>`），为并发任务提供独立的 Cookie、缓存与本地存储环境。
- **凭据与敏感信息隔离**：桥接连接令牌、调试配置及临时目录保存在用户本地目录（`~/.raw/`），严格排除在代码版本库之外。

---

## 6. 安装与构建

### 环境要求
- Node.js >= 22.21.0
- .NET 9.0 SDK（仅当重新编译 `edge-bridge/host/` 源码时需要）
- Google Chrome 或 Microsoft Edge

### 构建步骤
```bash
git clone https://github.com/liutingqiu/raw-agent.git
cd raw-agent

npm install
npm run typecheck
npm run build
```

---

## 7. CLI 使用指南

### 检查运行时与桥接状态
```bash
node dist/browser-cli.js status
# 或使用全局别名
raw status
```

### 执行浏览器脚本
执行单行 JavaScript 表达式：
```bash
raw run -e "console.log(await page.title())"
```

通过管道执行复杂任务脚本：
```powershell
@'
await page.goto('https://example.com');
const snapshot = await page.snapshot({ scope: 'viewport' });
console.log(snapshot);
'@ | raw run
```

### 常用选项参数
- `--headless`：以无界面模式启动。
- `--space <name>`：在隔离的上下文会话中运行。
- `--port <N>`：CDP 监听端口（默认 `9333`）。
- `--profile <path>`：指定持久化浏览器 Profile 目录。
- `--timeout-ms <N>`：脚本执行超时时间（毫秒）。
- `--downloads <path>`：指定下载文件保存目录。

---

## 8. 测试命令

运行完整测试流水线（类型检查、单元测试、构建验证及浏览器冒烟测试）：
```bash
# 1. TypeScript 类型检查
npm run typecheck

# 2. 运行 41 项单元测试
npm test

# 3. 编译发布包
npm run build

# 4. 浏览器端冒烟集成测试
node scripts/smoke-browser.mjs

# 或一键完整校验
npm run check
```

---

## 9. 已知限制

1. **扩展桥安装自动化**：标准 CDP 模式支持跨平台（Windows / macOS / Linux），但原生消息扩展桥的自动注册安装脚本目前主要面向 Windows PowerShell (`scripts/install-edge-bridge.ps1`)。
2. **单调试器互斥**：Chromium 内核规定同一个标签页同一时刻仅允许挂载一个调试客户端。若与其他外部调试工具并发挂载，将触发 Detach 事件。
3. **浏览器主版本升级**：Chromium 大版本升级偶尔会导致内部私有调试签名或权限提示变动，需重启浏览器重新激活桥接。

---

## 开源许可

本项目采用 [MIT License](LICENSE) 开源协议。
