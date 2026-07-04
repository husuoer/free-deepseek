<!-- 语言：[English](README.md) | **简体中文** -->

# deepseek-web

[English](README.md) · **简体中文**

> 让任意「OpenAI 风格」**或**「Anthropic 风格」的工具**免费**用上 **DeepSeek 网页版**（chat.deepseek.com）——无需 API Key，不按 token 计费。

`deepseek-web` 是一个常驻本机的小服务：用 Playwright 驱动一个**已登录**的真实 Chrome 页面（`chat.deepseek.com`），并以两种方式对外暴露：

1. 一个瘦身的 **HTTP 守护进程**（`server.js`，端口 `39217`），任意语言可直接调；
2. 一层 **OpenAI 与 Anthropic 双协议兼容适配器**（`api-shim.js`，端口 `39218`）——把任意工具的 `baseURL` 指过来即可用上网页版能力，包括**深度思考(R1)**、**联网搜索**、**专家模式**、**识图**、**流式**、**工具/函数调用**。它同时讲 OpenAI 协议（`POST /v1/chat/completions`）**和** Anthropic Messages 协议（`POST /v1/messages`），所以 **Claude Code**、**Anthropic SDK**、CC Switch 的 Anthropic 供应商也能接。

反爬工作量证明由页面自身的 JS 计算，本项目**不复刻任何私有 HTTP、不碰 PoW**——只做三件事：切模式 → 填 prompt（或传图）→ 读回复。登录**一次**，全机所有项目都能通过本地 HTTP 复用；因为浏览器只有这一个持有者，**多个项目并发调用也不会有 Chrome profile 争锁问题**。

---

## ⚠️ 免责声明

- 这是**非官方**工具，与 DeepSeek **无任何隶属、背书或支持关系**。
- 它自动化的是一个正常的已登录浏览器会话。**你需自行**遵守 DeepSeek 的服务条款并对使用后果负责；自动化网页服务可能违反其 ToS——**风险自负**。
- 只能在能运行**真实桌面版 Chrome** 的机器上跑（无头/无 GUI 服务器无法使用）。
- 代码中**不含任何硬编码的凭据 / cookie / 令牌**；登录态仅存在于本地 `profile/` 目录（已被 git 忽略）。**切勿提交 `profile/`。**

---

## 架构

```
你的程序 (OpenAI SDK / LangChain / Codex / Claude Code / Anthropic SDK / curl ...)
     │  POST /v1/chat/completions   （OpenAI 协议）
     │  POST /v1/messages           （Anthropic 协议）
     ▼
api-shim.js        :39218   ← OpenAI & Anthropic 兼容层，只依赖 Node 内置模块，独立进程
     │  两套协议都翻译成同一内部形态并转发给守护进程
     ▼
server.js (守护进程) :39217   ← 驱动之上的瘦 HTTP API
     │  Playwright 驱动页面
     ▼
deepseek-driver.js          ← 切模式 / 填 prompt / 传图 / 读回复
     ▼
真实 Chrome + 已登录的 chat.deepseek.com
```

- **默认无状态**：OpenAI 客户端本就每次带全量 `messages`，故适配层默认每次开一个新网页对话，互不串扰。
- **可选复用**：传 `conversation_id`（或用下文的 *sticky 粘连*）把一个上游对话映射到同一条网页对话线程。
- **单浏览器 → 串行**：底层只有一个 Chrome 会话，一次只能跑一条；并发时后到的会收到 `429`（忙），稍后重试即可。

---

## 环境要求

- **Node.js ≥ 18**（仅用全局 `AbortController` 等内置能力）。
- 桌面系统，已装 **Google Chrome**，*或*让 Playwright 下载自带 Chromium。驱动优先用系统 Chrome（`channel: 'chrome'`），失败回落 Chromium。
- 一个能在真实浏览器窗口里登录一次的 **DeepSeek 账号**。

---

## 安装

```bash
git clone https://github.com/husuoer/free-deepseek.git
cd free-deepseek
npm install
```

想跳过 Playwright 自带 Chromium 的大文件下载、直接用系统 Chrome：

```bash
# macOS / Linux
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install
# Windows PowerShell
$env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1; npm install
```

## 登录一次

```bash
npm run login       # 弹出真实 Chrome 窗口，手动登录 DeepSeek
```

凭据存在本地共享 `profile/` 目录。若守护进程已在跑，`npm run login` 会自动**通过正在跑的守护进程**弹登录窗（从而不与它争用 Chrome profile）。

## 启动服务

```bash
npm start           # 守护进程 → http://127.0.0.1:39217   (server.js)
npm run api         # 适配层    → http://127.0.0.1:39218  (api-shim.js，另开一个终端)
```

一切都依赖 `npm start`（守护进程）。只有当你想用 OpenAI 兼容端点时，才需要再跑 `npm run api`。

探活：

```bash
curl http://127.0.0.1:39217/health         # {"ok":true,"ts":...}
curl http://127.0.0.1:39218/health         # {"ok":true,"ts":...,"daemon":"http://127.0.0.1:39217"}
```

---

## 用法 —— OpenAI 兼容 API（`:39218`）

### curl

```bash
curl http://127.0.0.1:39218/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
        "model": "deepseek-chat",
        "messages": [
          {"role": "system", "content": "你是简洁的助手"},
          {"role": "user", "content": "用一句话解释相对论"}
        ]
      }'
```

> Windows 的 `curl` 传中文参数易乱码，测中文建议用 Node/Python 脚本或 PowerShell 的 `Invoke-RestMethod`。

### OpenAI Python SDK

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:39218/v1",
    api_key="sk-anything",            # 未设 DEEPSEEK_API_KEY 时随便填
)

resp = client.chat.completions.create(
    model="deepseek-reasoner",         # → 深度思考(R1)
    messages=[{"role": "user", "content": "写一首关于海的短诗"}],
)
print(resp.choices[0].message.content)

# 流式
stream = client.chat.completions.create(
    model="deepseek-chat",
    messages=[{"role": "user", "content": "从1数到10"}],
    stream=True,
)
for chunk in stream:
    print(chunk.choices[0].delta.content or "", end="", flush=True)
```

### OpenAI Node SDK

```js
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'http://127.0.0.1:39218/v1',
  apiKey: 'sk-anything',
});

const r = await client.chat.completions.create({
  model: 'deepseek-chat',
  messages: [{ role: 'user', content: '你好' }],
  // 非标准扩展（可选）：
  search: true,                       // 开联网搜索
  conversation_id: 'my-app:session-1' // 复用同一网页对话线程
});
console.log(r.choices[0].message.content);
```

### LangChain

```python
from langchain_openai import ChatOpenAI

llm = ChatOpenAI(
    base_url="http://127.0.0.1:39218/v1",
    api_key="sk-anything",
    model="deepseek-reasoner",
)
print(llm.invoke("解释一下量子纠缠").content)
```

### Codex / CC Switch（或任意可自定义 OpenAI Base URL 的工具）

把工具指向适配层，就像它是 OpenAI / DeepSeek 官方 API：

| 配置项 | 值 |
|---|---|
| Base URL | `http://127.0.0.1:39218/v1` |
| API Key | 任意非空字符串（如 `sk-local`），除非你设了 `DEEPSEEK_API_KEY` |
| 模型 | `deepseek-chat`（普通）或 `deepseek-reasoner`（深度思考）|

支持工具的 Agent（Codex、Cline 等）可经适配层的「提示词工程」工具调用真正操作本地工具，包括多步文件编辑与桌面自动化（见下文）。

### Claude Code / Anthropic 客户端（用 Anthropic Base URL）

讲 **Anthropic Messages 协议**的工具——[Claude Code](https://docs.claude.com/en/docs/claude-code)、`@anthropic-ai/sdk`、或 CC Switch 的 *Anthropic* 供应商——改指到适配层的 `POST /v1/messages` 端点：

| 配置项 | 值 |
|---|---|
| Base URL | `http://127.0.0.1:39218`（客户端自己会拼上 `/v1/messages`）|
| API Key（以 `x-api-key` 头发送）| 任意非空字符串，除非你设了 `DEEPSEEK_API_KEY` |
| 模型 | `deepseek-chat`（普通）或 `deepseek-reasoner`（深度思考）|

**Claude Code** 从环境变量读取：

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:39218
export ANTHROPIC_API_KEY=sk-local          # 任意非空字符串（或与 DEEPSEEK_API_KEY 一致）
export ANTHROPIC_MODEL=deepseek-chat        # 可选：适配层映射到哪个模型
claude
```

**Anthropic Node SDK：**

```js
import Anthropic from '@anthropic-ai/sdk';
const client = new Anthropic({ baseURL: 'http://127.0.0.1:39218', apiKey: 'sk-local' });
const msg = await client.messages.create({
  model: 'deepseek-chat',
  max_tokens: 1024,
  messages: [{ role: 'user', content: '你好，DeepSeek 网页版' }],
});
console.log(msg.content);
```

**curl：**

```bash
curl http://127.0.0.1:39218/v1/messages \
  -H 'content-type: application/json' \
  -H 'x-api-key: sk-local' \
  -H 'anthropic-version: 2023-06-01' \
  -d '{"model":"deepseek-chat","max_tokens":1024,"messages":[{"role":"user","content":"你好"}]}'
```

> **实话提醒。** 这只是让「讲 Anthropic 协议」的客户端**能连上**；底层模型仍是 DeepSeek 网页版，带着它固有的约束——工具调用是提示词工程实现的（可靠但非 100%）、同一时刻只能跑一个请求（并发会 `429`）、`max_tokens`/`temperature` 被忽略。重度 Agent 循环（大量快速工具调用）会比真正的 Anthropic 模型更慢、更不稳。

---

## API 参考（适配层，`:39218`）

| 方法 & 路径 | 说明 |
|---|---|
| `POST /v1/chat/completions`（别名 `POST /chat/completions`）| 对话补全，兼容 OpenAI。`stream: true` 为真·逐字 SSE |
| `POST /v1/messages`（别名 `POST /messages`）| **Anthropic Messages API。** `stream: true` 为 Anthropic SSE 事件流。复用同一内核（sticky、识图、工具调用）|
| `POST /v1/messages/count_tokens`（别名 `POST /messages/count_tokens`）| 对 Anthropic 请求做输入 token 粗估（不触发生成）|
| `GET /v1/models`（别名 `GET /models`）| 列出 `deepseek-chat`、`deepseek-reasoner` |
| `GET /health` | 探活（公开，不需鉴权）|

### 模型映射

| 传入 `model` | 行为 |
|---|---|
| `deepseek-chat`（或任意**不含** reasoner/r1/think/reason 的名字）| 普通对话 |
| `deepseek-reasoner`（或名字含 `reasoner`/`r1`/`think`/`reason`）| **深度思考(R1)**，超时自动放宽到 10 分钟 |

### 标准字段

- `response_format: { type: "json_object" }` → 要求 DeepSeek 输出 JSON（适配层照常以文本返回）。
- `temperature` / `top_p` / `max_tokens` 等：**接受但忽略**（网页版不暴露这些旋钮）。
- `usage` 里的 token 数是**粗略估算**（CJK≈1 token/字，其余≈4 字/token），仅供占位，不代表真实计费。

### 扩展字段（非官方，可选）

| 字段 | 作用 |
|---|---|
| `search: true` | 开启**联网搜索** |
| `expert: true` | 开启**专家模式** |
| `conversation_id: "<稳定字符串>"` | 复用同一网页对话线程（上下文由浏览器侧保留）。也可用请求头 `X-DS-Conversation` |
| `new_chat: true` | 为该 `conversation_id` **强制开新对话**并重新绑定 |
| `timeout_ms: 300000` | 自定义单次生成超时（毫秒）|

### 识图（图片）

适配层**支持**图片。标准 OpenAI 多模态片段会被接收并转发给网页版（自动切识图模式）：

- `{"type": "image_url", "image_url": {"url": "data:image/png;base64,..."}}`（或裸 data-URL 字符串）
- `{"type": "input_image", ...}`（Responses 形态）
- `{"type": "image", "source": {"type": "base64", "media_type": "...", "data": "..."}}`（Anthropic 形态）
- 正文里任意位置内联的 `data:image/...;base64,...`（兜底来源）

图片会被解码成本机临时文件（内容寻址、自动去重、超过 `DEEPSEEK_API_IMG_TTL_MS` 自动清理），经守护进程上传。单轮最多上传 `DEEPSEEK_API_IMG_MAX`（默认 6）张**最新**图片。*注意*：URL 必须是 **base64 data-URL**，远程 `http(s)://` 图片链接**不会**被抓取。

### 工具 / 函数调用

网页版**没有原生的工具调用通道**，本适配层用「提示词工程」补齐：请求带 `tools` 时，把工具定义注入提示词、教模型用一段可解析的方括号标记表达调用意图，响应侧再解析回**标准 OpenAI `tool_calls`**（`finish_reason: "tool_calls"`）。

- `tools` 兼容 Chat 形（`{type:"function", function:{name,description,parameters}}`）与 Responses 顶层形（`{type:"function", name, ...}`）。
- `tool_choice`：`"auto"`（默认）/ `"none"` / `"required"` / `{type:"function", function:{name}}`。
- **多轮回填**：把 assistant 的 `tool_calls` 与 `role:"tool"` 结果（带 `tool_call_id`）一起放回 `messages` 再发一次——适配层会把它们折叠进给网页版的纯文本转录里，模型据此接着往下走。
- **流式 + 工具**：带 `tools` 时会**先缓冲整段再判定**（否则正文已逐字推出、末尾才发现是工具调用就来不及收回）。无工具的流式仍是真·逐字。
- 本质是提示词驱动，绝大多数情况稳定但非 100%：极少数模型不守格式时该轮退化为普通文本（`finish_reason: "stop"`），重试即可。

### Anthropic Messages API（`/v1/messages`）

面向 Anthropic 协议的客户端，适配层做**双向翻译**并复用**完全相同的内核**（sticky、识图、提示词工程工具调用）：

- **请求 → 内部形态**：顶层 `system`（字符串或 `[{type:"text"}]` 块）折叠进转录；`messages` 的内容块（`text` / `image` / `tool_use` / `tool_result`）逐一映射；`tools`（`{name, description, input_schema}`）与 `tool_choice`（`auto` / `any` / `tool` / `none`）转成适配层的工具调用。鉴权从 **`x-api-key`** 头读取（也接受 Bearer）。
- **响应 → Anthropic 形态**：`{type:"message", role:"assistant", content:[{type:"text"} | {type:"tool_use", id, name, input}], stop_reason:"end_turn" | "tool_use", usage}`。流式吐标准事件序列：`message_start` → `content_block_start` → `content_block_delta`（`text_delta`，工具调用则 `input_json_delta`）→ `content_block_stop` → `message_delta` → `message_stop`。
- **扩展字段**（`search`、`expert`、`conversation_id`、`new_chat`、`timeout_ms`）放在请求体顶层同样生效。
- **错误体是 Anthropic 风格**：`{ "type": "error", "error": { "type", "message" } }`（忙 → `429` `overloaded_error`；守护进程连不上 / 未登录 / 失败 → `502` `api_error`）。
- `POST /v1/messages/count_tokens` 返回 `{ "input_tokens": N }`（粗估，不触发生成）。

### 会话粘连 sticky（默认开启）

某些客户端（如经 CC Switch 的 Codex）**不传** `conversation_id`。若不处理，每轮都会新开一个网页对话并重发全量历史。**sticky** 解决它：适配层用**首条 user 消息**的指纹（`key = codex:sha1(首条 user 文本).slice(0,16)`）认出「同一个对话」，映射到一条网页线程，之后只把**新增**消息增量发过去。

- **优先级**：显式 `conversation_id` / `X-DS-Conversation` 头 > sticky；`new_chat:true` 强制开新窗口（仍会绑定）；什么都不传 → sticky 自动接管；`DEEPSEEK_API_STICKY=0` 关闭（纯无状态）。
- **偏移自愈**：若「已发前缀」的指纹对不上（历史被编辑 / 进程重启）→ 整段重发一次并开新窗口重新绑定。
- 绑定信息仅存适配层内存（有 TTL 与条数上限），重启即忘、靠自愈重新绑定。

### 错误与并发

- OpenAI 端点的错误体是 **OpenAI 风格**：`{ "error": { "message", "type", "param", "code" } }`（`/v1/messages` 端点改回 **Anthropic 风格**错误——见上）。
- 忙（并发争用）→ HTTP `429`（OpenAI 为 `rate_limit_error`，Anthropic 为 `overloaded_error`）。
- 守护进程连不上 / 未登录 / 生成失败 → `502` + `api_error`。

---

## 守护进程 HTTP API（`:39217`）—— 直连 / 任意语言

适配层是可选的。任意语言都能直接调守护进程（JSON 收发，`Content-Type: application/json`）。若设了 `DEEPSEEK_WEB_TOKEN`，除 `/health` 外都要带 `Authorization: Bearer <token>`。**不要带 `Origin` 头**——守护进程会拒绝带 Origin 的请求（CSRF 防护）。

| 方法 & 路径 | 说明 |
|---|---|
| `GET /health` | `{ ok, ts }` |
| `GET /status` | `{ installed, logged_in, alive, headless, profile_dir, conversations, modes_supported, note }` |
| `POST /login` | 弹出有头 Chrome 登录。请求 `{ timeoutMs }`（默认 300000）→ `{ ok, logged_in }` |
| `POST /chat` | **核心**。字段见下 → `{ text, json?, ms, modes, conversationId, conversationUrl, reused }` |
| `POST /chat/stream` | SSE 流式。增量 `data:{"delta":"..."}`，结束 `data:{"done":true, text, ms, modes, ...}`，最后 `data:[DONE]` |
| `GET /conversations` | `{ conversations: [{ conversationId, url, turns, boundAt, lastUsed }] }` |
| `POST /reset` | 请求 `{ conversationId }` → 忘掉该映射（下次同 id 开新对话）|

**`POST /chat` 请求体字段：**

| 字段 | 类型 | 说明 |
|---|---|---|
| `prompt` | string | 用户消息（识图时可空，只传图）|
| `system` | string? | 系统人设，折进正文。**复用对话时只在首轮注入**，后续轮自动跳过 |
| `json` | bool? | 要求只输出 JSON；响应会多带已解析的 `json` 字段 |
| `think` | bool? | 深度思考(R1)；更慢，超时自动放宽到 10 分钟 |
| `search` | bool? | 联网搜索；**建对话时锁定**（见下）|
| `expert` | bool? | 专家模式；**建对话时锁定**（见下）|
| `images` | string[]? | **识图**：本机图片文件的绝对路径数组，上传给网页版 |
| `conversationId` | string? | 复用键——同 id ⇒ 同一网页对话线程，上下文连续 |
| `newChat` | bool? | 为该 `conversationId` 强制开新对话并重绑 |
| `timeoutMs` | number? | 单次生成超时（毫秒）|

### Node 瘦客户端

装成依赖后 `require('deepseek-web')`，或直接 `require` 现成的 `client.js`，都能拿到一个零依赖客户端：

```js
const ds = require('deepseek-web');            // === client.js
await ds.health();                              // { ok, ts }
await ds.status();                              // 登录 / 存活 / 会话数 / 支持的模式
const r = await ds.chat({ prompt: '用一句话介绍你自己' });
console.log(r.text);
const obj = await ds.chatJSON({ prompt: '给我一个 {name, age} 的示例' });   // 内部自动 json:true，返回已解析对象
// 上下文连续：同一业务实体复用同一条网页线程
await ds.chat({ conversationId: 'app:8', system: '你是史官', prompt: '主角进城。' });
await ds.chat({ conversationId: 'app:8', prompt: '他遇到了谁？' });          // 记得上一句
// 网页版能力
await ds.chat({ prompt: '总结最近以太坊的进展', think: true, search: true });
await ds.chat({ prompt: '这张图讲了什么？', images: ['/tmp/chart.png'] });
// 其它：ds.login(timeoutMs)、ds.reset(conversationId)、ds.listConversations()
```

---

## 网页版能力 & 「建对话时锁定」注意

| 模式 | 字段 | 生效范围 |
|---|---|---|
| 深度思考 | `think` | **每条消息**可单独开关；更慢更强，超时自动放宽 |
| 联网搜索 | `search` | **建对话时锁定**（见下）|
| 专家模式 | `expert` | **建对话时锁定**（见下）|
| 识图 | `images` | 传本机图片，自动切识图模式 |

**⚠ 「建对话时锁定」（实测确认）**：DeepSeek 网页版里，*联网搜索* 开关与 *快速/专家/识图* 模型类型单选组**只在新对话出现**；一旦对话已开始，这两处控件就消失了，只剩 *深度思考* 可逐条切换。因此 `search`/`expert` 实际是整条对话的**创建期设置**——要换必须开新对话（`newChat:true` / `new_chat:true`）。`think` 不受此限。所有模式开关都是 **best-effort**：找不到按钮不会让整次调用失败，只在响应的 `modes` 字段里说明（如 `modes.expert = {applied:false, reason:"not-found"}`）。

---

## 环境变量

### 守护进程（`server.js`）

| 变量 | 默认 | 说明 |
|---|---|---|
| `DEEPSEEK_WEB_PORT` | `39217` | 守护进程端口 |
| `DEEPSEEK_WEB_HOST` | `127.0.0.1` | 监听地址（默认只回环，**勿**改成 `0.0.0.0`）|
| `DEEPSEEK_WEB_TOKEN` | *(空)* | 设了则除 `/health` 外需 `Bearer` 令牌 |
| `DEEPSEEK_PROFILE_DIR` | `./profile` | 共享登录 profile 目录 |
| `DEEPSEEK_HEADLESS` | *(空→有头)* | `1`/`true` 用无头（登录时仍强制有头）|
| `DS_DRIVER_DEBUG` | *(关)* | `1`/`true` 把「DOM vs SSE 原文」对比追加到 `.driver-debug.log`（诊断用）|

### API 适配层（`api-shim.js`）

| 变量 | 默认 | 说明 |
|---|---|---|
| `DEEPSEEK_API_PORT` | `39218` | 适配层端口 |
| `DEEPSEEK_API_HOST` | `127.0.0.1` | 监听地址（默认只回环）|
| `DEEPSEEK_API_KEY` | *(空)* | 设了就校验 `Authorization: Bearer <key>`；不设=本机自用，任意 key 放行 |
| `DEEPSEEK_API_ALLOW_ORIGIN` | *(空)* | 设了才允许该跨域来源（或 `*`）；不设=**拒绝一切带 `Origin` 的请求** |
| `DEEPSEEK_WEB_URL` | `http://127.0.0.1:39217` | 守护进程地址 |
| `DEEPSEEK_WEB_TOKEN` | *(空)* | 守护进程若开了令牌校验，这里要与之一致 |
| `DEEPSEEK_API_STICKY` | *(开)* | 会话粘连；设 `0`/`false`/`off` 关闭 |
| `DEEPSEEK_API_STICKY_TTL_MS` | `21600000`（6h）| 一个上游对话绑定多久不活跃就回收 |
| `DEEPSEEK_API_STICKY_MAX` | `500` | 最多同时记住多少个上游对话 |
| `DEEPSEEK_API_IMG_MAX` | `6` | 单轮最多上传几张图（取最新的）|
| `DEEPSEEK_API_IMG_TTL_MS` | `1800000`（30m）| 临时图片文件保留多久后清理 |
| `DEEPSEEK_API_MAX_BODY` | `67108864`（64MB）| 请求体大小上限（base64 图片可能很大）|

---

## 安全

- 两个进程都只监听**回环 `127.0.0.1`**，绝不对外网暴露。
- **CSRF 防护**：守护进程拒绝任何带 `Origin` 头的请求（浏览器里恶意网页 `fetch` 本机端口会自动带 Origin，正规服务端到服务端调用不带）。适配层同理，除非设了 `DEEPSEEK_API_ALLOW_ORIGIN`。
- **可选 Bearer 令牌**做进一步隔离（`DEEPSEEK_WEB_TOKEN`、`DEEPSEEK_API_KEY`）。
- `profile/`（登录 cookie）与 `conversations.json` 属**本机隐私运行态**——已被 git 忽略，**切勿提交**。
- **客户端断开 = 真终止**：调用方在生成中途断开时，守护进程会停掉正在进行的网页生成并立即释放会话，避免下一条请求被「会话忙」卡住。

---

## 常见问题

| 现象 | 处理 |
|---|---|
| `连不上 DeepSeek 守护进程` | 先启动：`npm start`。用 `curl http://127.0.0.1:39217/health` 探活。 |
| `/status` 显示 `logged_in: false` | 运行 `npm run login`，在 Chrome 窗口里完成登录。 |
| 适配层返回 `429` / `rate_limit_error` | 单浏览器=串行。稍后重试，别并发。 |
| 适配层返回 `502` / `api_error` | 守护进程未启动或未登录——检查守护进程及其 `/status`。 |
| 复用对话时 `search`/`expert` 没生效 | 它们建对话时锁定——用 `new_chat:true` 开新对话。 |
| Playwright 找不到浏览器 | 装 Google Chrome，或不带 `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD` 重装以下载 Chromium。 |
| Chrome profile 锁冲突 | 同一 profile 只能被一个进程持有。确认没跑两个守护进程，让正在跑的那个去弹登录。 |

---

## 目录结构

```
deepseek-web/
├── server.js            # 守护进程：驱动之上的 HTTP API（:39217）
├── api-shim.js          # OpenAI & Anthropic 兼容 API 层（:39218）
├── deepseek-driver.js   # Playwright 驱动（模式 / prompt / 识图 / 读回复）
├── client.js            # 零依赖 Node 瘦客户端
├── cli-login.js         # `npm run login` 助手
├── package.json
└── profile/             # （git 忽略）真实登录 cookie + 对话映射
```

---

## 许可证

[MIT](LICENSE)。该许可证仅覆盖本项目自身代码，不授予 DeepSeek 服务、商标或内容的任何权利。详见上文免责声明。
