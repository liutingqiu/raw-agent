# raw

[English](./README.md) | **中文**

**终端里的裸模型 + 工具循环。** 没有系统提示词，没有依赖，没有脚手架。

```bash
git clone https://github.com/liutingqiu/raw-agent && cd raw
npm install && npm run build && npm link  # 零依赖构建，把 raw 命令链到全局
raw setup                   # 选一个 provider，粘贴 key
raw                         # 开始用
```

发布到 npm 之后也可以 `npm i -g raw-agent` 或 `npx raw-agent`。

`raw` 只给模型三样东西：你说的话、一小组工具、以及到目前为止的对话记录。
别的什么都不注入 —— 没有人格设定，没有「你是一个乐于助人的编程助手」，没有隐藏指令。
模型收到的第一条消息就是你敲的那句话。

- **零运行时依赖**：产品代码只使用 Node 内置的 `fetch`、`WebSocket` 和 `readline`；TypeScript 仅用于开发阶段检查。
- **开箱可用**：`raw setup` 内置 17 个 provider，粘个 key 就能跑。
- **没有脚手架**：没有记忆文件，没有自动注入的上下文，没有强加的工作流。

---

## 为什么没有系统提示词

每个 agent 框架都会加一段指令。它们把模型往框架作者认为「好」的方向拽，同时挤占你真正关心的上下文。
`raw` 一条都不发。

正常对话中，模型额外收到的唯一文字是每个工具的 JSON Schema —— 那是 API 协议的一部分，不是提示词。
其余全是你的话、模型的话、工具输出。两个显式命令会添加 user 角色上下文：`/goal` 重复你输入的目标，
`/compact` 先单独请求摘要再替换旧轮次；两者都不使用 system 角色。

可以直接验证：

```bash
RAW_DEBUG=1 raw -p "say ok"
# [debug] {"model":"...","messages":[{"role":"user","content":"say ok"}],"stream":true,...}
```

载荷里没有 `system` 角色。你想给模型指令就直接打出来 —— 那是**你的**指令，在对话里，不是隐藏的启动前言。

---

## 安装

```bash
npm i -g raw-agent      # 提供 raw 命令
npx raw-agent --help    # 或者不安装直接跑
```

要求 **Node >= 22.21**（全局 `WebSocket`、开发模式内置 TS 支持，以及 `raw` 使用的启动代理参数）。
发布包是纯 JavaScript，用 Node 自带的类型剥离 API 构建，所以使用者不需要构建、也不需要打包器。

从源码：

```bash
git clone https://github.com/liutingqiu/raw-agent && cd raw
npm install
npm run typecheck
npm run build    # 零依赖构建
npm link
npm test
```

---

## 配置模型

```bash
raw setup                     # 交互式：选 provider → 粘 key → 选模型
raw setup deepseek            # 指定 provider
raw setup deepseek --key sk-… --model deepseek-chat    # 全非交互，可脚本化
raw providers                 # 已配置的（key 打码）
raw presets                   # 所有内置预设
```

配置时会先请求 provider 的 `/models` 接口验证 key 并发现当前模型。发现失败时，交互模式会提供
预设提示，也接受你输入任意模型 id；非交互模式必须显式传 `--model`。key 存在
`~/.raw/config.json`：POSIX 系统使用 `0600`，Windows 依靠用户目录 ACL 保护。

内置：`openai`（Responses API）、`anthropic`（原生 Messages API）、
`gemini` `deepseek` `kimi` `qwen` `grok` `glm` `doubao` `minimax` `mistral` `groq` `openrouter`
`siliconflow` `together`（OpenAI 兼容）、`ollama` `lmstudio`（本地，免 key）。

自定义：`raw setup <名字> --base-url <url> --api <kind>`，或向导里选 `custom`。

### 优先级

```
命令行参数 > RAW_* 环境变量 > ~/.raw/config.json > 内置预设
          > pi 的 models.json（如果你用 pi）> OPENAI_* 环境变量
```

你保存的配置**故意优先于**环境里的 `PI_PROVIDER`/`PI_MODEL`，这样配置好 `raw` 之后不会被别的工具悄悄改掉。

---

## 工具（10 个）

| 工具 | 只读 | 说明 |
| --- | --- | --- |
| `read` | ✅ | 读文件，带行号、`offset`/`limit`、二进制检测 |
| `ls` | ✅ | 列目录，可选递归深度 |
| `grep` | ✅ | ripgrep 搜索（没有 `rg` 时回退到 JS 遍历） |
| `web_search` | ✅ | 多后端联网搜索，自动降级 |
| `web_fetch` | ✅ | 抓 URL 并把 HTML 转成可读文本 |
| `browser` | | CDP 驱动真实 Chrome/Edge，模型写脚本 |
| `write` | | 创建/覆盖文件，自动建父目录 |
| `edit` | | 精确文本替换：必须唯一匹配、禁止重叠、返回 diff |
| `bash` | | 执行 shell 命令，返回合并输出和退出码 |
| `notes` | | 跨会话保留的持久笔记 |

连续的**只读**调用并行执行；`browser`/`write`/`edit`/`bash` 串行。
所有结果头尾截断（24 KB），避免一条话多的命令把上下文打爆。

### web_search

按顺序尝试，失败或 0 结果就换下一个：

`tavily`（`TAVILY_API_KEY`，质量最好，直接返回正文）、`exa`、`serper`、`searxng`（自建），
以及免密钥的 `bing`（抓 `cn.bing.com`）和 `360`。

免密钥抓取是一场必输的仗：DuckDuckGo 返回反爬页、Google 跳同意页、多数公开 SearXNG 已关闭 JSON 接口。
Bing 和 360 还能用，但**想稳定就该配 `TAVILY_API_KEY`**（有免费额度）。

### browser

只用 Node 内置的 `fetch` + `WebSocket` 讲 CDP，零依赖驱动本机 Chrome/Edge。
用独立 profile（`~/.raw/browser-profile`），登录态跨次保留，完全不碰你自己的浏览器窗口。

设计沿用 [ego-lite](https://github.com/citrolabs/ego-lite) 的核心洞见 —— **给模型 API 而不是命令** ——
所以它能把整个任务写进一个脚本一次跑完，而不是「调两次、看一眼、再调两次」。

```js
await page.goto("https://cn.bing.com/");
await page.fill("role=textbox", "白板");      // 定位器：css / xpath= / text= / role=
await page.press("Enter");
await page.waitForLoadState("networkidle");
console.log("结果数:", await page.count("#b_results .b_algo"));
await page.click("css=#b_results .b_algo h2 a");
const tab = await page.followPopup();         // 点击开了新标签
console.log(await (tab ?? page).url());
console.log(await page.screenshot());         // 图片会送给模型
```

**定位器**在所有地方通用：快照编号、原生 CSS、`css=`、`xpath=`、`text=登录`、
`:has-text("…")`、`role=button[name=保存]`。用 `page.find(sel)` / `page.findAll(sel)` 拿到
`{tag, text, value, href, visible, box}`，排查选择器为什么没匹配上。

| 分类 | API |
| --- | --- |
| 导航 | `goto` `reload` `back` `url` `title` |
| 读取 | `snapshot({scope:'full'\|'viewport', root, max})` `text` `html` `count` `find` `findAll` `eval` |
| 交互 | `click` `dblclick` `hover` `dragAndDrop` `fill` `type` `typeText` `press` `selectOption` `setInputFiles` `mouseMove` `scroll` |
| 输入保真 | 真实 CDP `Input.dispatchMouseEvent` / `dispatchKeyEvent`，对 canvas 和 JS 组件有效，不只是 `element.click()` |
| 等待 | `waitForSelector({state})` `waitForFunction` `waitForURL` `waitForLoadState` `sleep` |
| 标签 / 空间 | `newTab` `followPopup` `tabs` `space(name)` → 隔离的浏览器上下文 |
| 产物 | `screenshot`（同时作为图片附到工具结果）`fetch`（带 profile cookie）`waitForDownload` `downloads` `waitForFileChooser` |
| 逃生口 | `cdpSend(method, params)`、`setDialogPolicy`、`dialog()`、`handoff(message)` |

快照包含页面正文，并会进入同源 iframe。脚本抛错时，工具结果会保留它已经打印的日志和拍过的截图，
模型能看到自己进行到哪一步。

**隔离空间**：`space("name")` 返回一个独立的浏览器上下文，有自己的 cookie 和存储 ——
可以并行跑任务而互不污染，也不碰你的真实 profile。浏览器脚本在独立工作线程中运行，
到达超时后会被终止，CPU 死循环也能恢复。`page.fetch` 在页面内运行，因此遵循该页面的 CORS 策略。

示例：

```js
const jobs = await space("jobs");
const p = await jobs.newPage("https://example.com");
```

**人在回路**：有些事只有你能做 —— 登录、验证码、二次验证：

```js
await page.handoff("登录 staging 后台");
```

agent 会停下来告诉你要做什么，等你按回车继续。谁都不会被锁在自己的浏览器外面。

弹窗（`alert`/`confirm`/`beforeunload`）默认自动接受并记录，避免页面卡死。

| 环境变量 | 说明 |
| --- | --- |
| `RAW_BROWSER_HEADLESS=1` | 无窗口（默认有窗口，方便手动操作） |
| `RAW_BROWSER_PORT` | 调试端口，默认 9222；显式设置表示允许连接已有的调试浏览器 |
| `RAW_BROWSER_PROFILE` / `RAW_BROWSER_PATH` | profile 目录 / 指定可执行文件 |
| `RAW_DOWNLOAD_DIR` | 下载目录，默认 `~/.raw/downloads` |
| `RAW_NO_IMAGES=1` | 不把截图附给模型 |

### notes

agent 写给未来自己的持久文本 —— 某个站点的怪癖、某个项目的约定。
**不会**被自动注入（那就是换个名字的系统提示词），模型必须主动去读。文件在 `~/.raw/notes/`。

---

## 设计取舍

- **不隐藏任何东西**：工具输出原样返回，只做长度截断 —— 不套「成功/失败」包装，不做摘要，不重写。
- **不替模型做决定**：工具不自动重试（瞬时网络错误除外），不注入「你应该先…」，不加强制规划。
- **请求体只包含协议要求的状态**：除对话和工具外，provider 可能收到原生推理控制参数和不透明的
  推理状态，以保证工具轮次有效。不会添加隐藏指令或采样偏好。
- **上下文管理可预测**：预算为 `contextWindow * 0.6`，超了就从最旧的**用户消息边界**整轮丢弃，
  保证 `tool_calls` 和对应的 `tool` 结果永远不被拆散。图片只保留最近几轮；如果最新工具轮本身
  已经超限，只缩短其中的文本输出，调用 ID 和协议结构保持完整。
- **瞬时失败会重试**：`overloaded`/`429`/`5xx` 在尚未输出任何内容时重试两次。
  有些网关用 HTTP 200 包一个 `{"error": …}` 帧返回错误，这类错误会被正确抛出而不是被吞掉。
  如果模型完全不支持图片，会自动去掉图片重试而不是整轮失败。
- **Ctrl+C**：生成中中断请求回到提示符；空闲时退出。

---

## 安全

先把话说清楚：**这是一个能执行 shell 命令、并且能操作你已登录账号的浏览器的 agent。**
这正是它的价值，也是它的风险。

- `raw` 以你的身份和权限执行命令与浏览器脚本。
- 专用文件工具默认限制在工作区内，并拒绝用符号链接绕过边界；`RAW_ALLOW_OUTSIDE=1` 会移除该边界。
  shell 命令和浏览器脚本拥有与 `raw` 进程相同的访问权限。
- 浏览器用独立 profile，初始是空的；你登录过的东西存在 `~/.raw/browser-profile`，
  以你的身份运行的任何程序都能读到。
- 模型请求只发给你配置的 provider；联网工具会访问它被要求访问的 URL 和搜索服务。key 和笔记留在本地。
- `--permission ask`（或 `--confirm`）会在每个改变状态的工具调用前询问；
  `--permission readonly` 会拒绝这些调用。
- `raw` 执行的是模型写的代码。别在一台你不愿意给语言模型 shell 的机器上跑它。

---

## 命令行

| 参数 | 说明 |
| --- | --- |
| `-p, --print <text>` | 单次执行后退出 |
| `-m, --model <id>` | 模型 |
| `--provider <name>` | 已配置 provider 或内置预设 |
| `--base-url` `--api-key` `--api` | 覆盖连接信息（`openai-completions` / `openai-responses` / `anthropic-messages`） |
| `--effort <level>` | `minimal` / `low` / `medium` / `high` / `xhigh` / `max`（视 provider 支持） |
| `--context-window <tokens>` | 覆盖模型上下文长度（`128k`、`1m` 或整数） |
| `--show-reasoning` | 显示模型的思考过程（默认隐藏，会话里用 `/reasoning` 开关） |
| `--confirm` | 每个副作用前询问 |
| `--permission <mode>` | `auto` / `ask` / `readonly`（默认 `auto`） |
| `--readonly` | `--permission readonly` 的简写 |
| `-c, --continue` | 恢复当前工作区最近的会话 |
| `--session <file>` | 指定会话文件 |
| `--max-turns <n>` | 单条消息内最多工具轮数（默认 64） |

不带 `-p` 时，重定向的标准输入会作为一条提示词读取，并保留其中的换行：

```bash
printf '检查这个项目\n列出主要风险' | raw
```

会话内：`/help` `/goal` `/context` `/compact` `/model` `/provider` `/effort` `/reasoning`
`/permission` `/paste` `/image` `/tools` `/notes` `/session` `/new` `/exit`

`/context` 查看当前用量；`/context 256k` 修改当前会话的上下文长度。
使用 `raw setup <provider> --context-window 256k ...` 保存该 provider 的默认值。

用 `Ctrl+J` 或 `Shift+Enter` 输入换行，`Shift+Tab` 切换权限模式，`Esc` 或 `Ctrl+C`
中止正在执行的请求或工具。输入为空时，Backspace 会移除最后一张图片附件。

### 环境变量

| 变量 | 说明 |
| --- | --- |
| `RAW_PROXY` | 走代理（也读 `HTTPS_PROXY`/`ALL_PROXY`；设 `off` 关闭） |
| `RAW_NO_PROXY=1` | 关闭本地代理端口自动探测 |
| `RAW_HOME` | 更换数据目录 |
| `RAW_MODEL` `RAW_API_KEY` `RAW_BASE_URL` `RAW_API` `RAW_PROVIDER` | 单次覆盖 |
| `RAW_CONTEXT_WINDOW` | 覆盖模型上下文长度（`128k`、`1m` 或整数） |
| `RAW_ALLOW_OUTSIDE=1` | 允许访问工作区外路径 |
| `RAW_DEBUG=1` | 打印发出的请求体 |
| `RAW_REASONING_EFFORT` | 覆盖推理强度 |
| `RAW_API_TIMEOUT_MS` | 单次模型请求最长毫秒数（默认 300000） |
| `RAW_MAX_API_RESPONSE_BYTES` | 单次模型响应体最大字节数（默认 64 MiB） |
| `RAW_PERMISSION` | 初始权限模式：`auto`、`ask` 或 `readonly` |
| `RAW_SHOW_REASONING=1` | 初始显示推理输出 |
| `RAW_NO_IMAGES=1` | 不把图片附给模型 |
| `RAW_MAX_IMAGE_BYTES` | 单张本地或剪贴板图片的最大字节数（默认 20 MiB） |
| `RAW_MAX_FILE_BYTES` | 内存内 read/edit 操作接受的最大文件大小（默认 16 MiB） |
| `NO_COLOR=1` | 纯文本输出 |

---

## 代理

Node 内置 `fetch` 在启动时带 `--use-env-proxy` 后会遵循 `HTTP(S)_PROXY`。`raw` 会检查代理设置
（只有在交互式终端里，才会额外探测 7890/7897/10809/10808 这些本地 HTTP 代理端口），
命中就用正确的标志重新 exec 自己。banner 会显示当前是否走了代理。
脚本和 CI 环境永远不会被端口探测。

---

## 目录结构

```
src/cli.ts          参数、交互循环、流式输出、会话和工具调度
src/api.ts          provider 解析、三种协议适配和 SSE 解析
src/context.ts      上下文预算、目标注入、图片裁剪和压缩边界
src/clipboard.ts    剪贴板与本地图片读取
src/tools.ts        十个工具的 schema 与实现
src/browser.ts      CDP 客户端、页面 API、标签页、隔离空间和下载
src/page-helpers.js 页面内定位器和快照逻辑
src/tui/            终端编辑器、命令、渲染和主题
test/               node:test 测试，无框架
scripts/build.mjs   零依赖构建（node:module 剥离类型）
dist/               构建产物（发布包入口）
```

## 扩展

- **加工具**：在 `src/tools.ts` 的 `toolSpecs` 加 schema，在 `runTool` 加分支；标 `readOnly: true` 即可参与并行。
- **加 provider**：往 `src/presets.ts` 加一条。
- **加协议**：在 `src/api.ts` 写 `streamXxx`，在 `streamTurn` 里分发。

## 常见问题

**PowerShell 报「无法加载文件 raw.ps1，因为在此系统上禁止运行脚本」**

npm 会装三个启动器：`raw`（sh）、`raw.cmd`（cmd）、`raw.ps1`（PowerShell）。
Windows 默认的执行策略会拦掉 `.ps1` 那个。要么直接用 `raw.cmd`，要么为当前用户放开本地脚本：

```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

**框线显示成 `?` 或方块**

控制台字体缺字形。换成 Consolas / Cascadia Mono，或者强制纯 ASCII：

```bash
RAW_ASCII=1 raw
```

**颜色不对 / 屏幕闪烁**

`raw` 会自动识别 16 色 / 256 色 / 真彩色并降级。`NO_COLOR=1` 可完全关掉颜色。
改变窗口尺寸时输入块会重绘；在旧版 Windows 控制台上 resize 处理是尽力而为。

**Windows 上状态栏右侧看不见**

有些 Windows 控制台的**屏幕缓冲区比窗口宽**。`raw` 会直接问终端它的真实文本区宽度（`CSI 18 t` 查询），
取它和 `process.stdout.columns` 里较小的那个，保证内容留在可见窗口内。如果终端不回应这个查询，
`raw` 在 Windows 上最多按 100 列处理。

**启动时自动走了代理**

`raw` 只会在**交互式终端**里探测本机常用 HTTP 代理端口（7890/7897/10809/10808），并把结果打印出来。
用 `RAW_PROXY=off` 或 `RAW_NO_PROXY=1` 关掉。

**模型不支持截图**

有些模型没有视觉能力。`raw` 会识别出来、丢掉图片并自动重试本轮。想一开始就跳过就设 `RAW_NO_IMAGES=1`。

## 许可

MIT
