<!-- Language: **English** | [简体中文](README.zh-CN.md) -->

# deepseek-web

**English** · [简体中文](README.zh-CN.md)

> Use **DeepSeek web** (chat.deepseek.com) for free from any OpenAI-compatible tool — no API key, no per-token billing.

`deepseek-web` is a small **local** service that drives one **already-logged-in** real Chrome page of `chat.deepseek.com` via Playwright, and exposes it two ways:

1. A tiny **HTTP daemon** (`server.js`, port `39217`) that any language can call.
2. An **OpenAI-compatible API shim** (`api-shim.js`, port `39218`) — point any tool's `baseURL` at it and you get DeepSeek web, including **deep-thinking (R1)**, **web-search**, **expert mode**, **vision**, **streaming**, and **tool/function calling**.

Because the page's own JavaScript computes the anti-bot proof-of-work, this project never reimplements any private HTTP or PoW — it only switches modes, types the prompt (or uploads images), and reads the reply back. Log in **once**; every project on the machine reuses that session over local HTTP, and since there is a single browser holder there is **no Chrome-profile lock contention**.

---

## ⚠️ Disclaimer

- This is an **unofficial** tool. It is **not** affiliated with, endorsed by, or supported by DeepSeek.
- It automates a normal logged-in browser session. **You are responsible** for complying with DeepSeek's Terms of Service and for how you use it. Automating a web service may violate its ToS — **use at your own risk**.
- It only works on a machine that can run a **real desktop Chrome** (a headless/GUI-less server cannot run it).
- No credentials, cookies, or tokens are hardcoded anywhere; login state lives only in a local `profile/` folder that is git-ignored. **Never commit `profile/`.**

---

## Architecture

```
Your app  (OpenAI SDK / LangChain / Codex / curl ...)
     │  POST /v1/chat/completions        (OpenAI protocol)
     ▼
api-shim.js        :39218   ← OpenAI-compatible layer, Node built-ins only, standalone process
     │  translated + forwarded to the daemon protocol
     ▼
server.js (daemon) :39217   ← thin HTTP API over the driver
     │  Playwright drives the page
     ▼
deepseek-driver.js          ← switches modes / types prompt / uploads images / reads reply
     ▼
real Chrome + logged-in chat.deepseek.com
```

- **Stateless by default** — OpenAI clients always send the full `messages`, so the shim opens a fresh web chat each call.
- **Optional reuse** — pass `conversation_id` (or rely on *sticky*, below) to map an upstream conversation to the same web thread.
- **Single browser → serial** — only one Chrome session exists, so requests run one at a time; concurrent callers get `429` (busy), retry shortly.

---

## Requirements

- **Node.js ≥ 18** (uses global `AbortController`/`fetch`-free built-ins only).
- A desktop OS with **Google Chrome** installed *or* let Playwright download its bundled Chromium. The driver tries system Chrome first (`channel: 'chrome'`) and falls back to Chromium.
- A **DeepSeek account** you can log into once in a real browser window.

---

## Install

```bash
git clone https://github.com/husuoer/free-deepseek.git
cd free-deepseek
npm install
```

To skip Playwright's large Chromium download and use your existing system Chrome:

```bash
# macOS / Linux
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install
# Windows PowerShell
$env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1; npm install
```

## Log in once

```bash
npm run login       # opens a real Chrome window — log into DeepSeek by hand
```

Credentials are stored in the local shared `profile/` folder. If the daemon is already running, `npm run login` automatically drives **its** browser to pop the login window (so it never fights over the Chrome profile).

## Start the services

```bash
npm start           # daemon  → http://127.0.0.1:39217   (server.js)
npm run api         # shim     → http://127.0.0.1:39218  (api-shim.js, in a second terminal)
```

You need `npm start` (the daemon) for everything. Add `npm run api` only if you want the OpenAI-compatible endpoints.

Health checks:

```bash
curl http://127.0.0.1:39217/health         # {"ok":true,"ts":...}
curl http://127.0.0.1:39218/health         # {"ok":true,"ts":...,"daemon":"http://127.0.0.1:39217"}
```

---

## Usage — OpenAI-compatible API (`:39218`)

### curl

```bash
curl http://127.0.0.1:39218/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
        "model": "deepseek-chat",
        "messages": [
          {"role": "system", "content": "You are a concise assistant."},
          {"role": "user", "content": "Explain relativity in one sentence."}
        ]
      }'
```

> On Windows, `curl` mangles non-ASCII arguments easily — for Chinese/UTF-8 prompts prefer a Node/Python script or PowerShell's `Invoke-RestMethod`.

### OpenAI Python SDK

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:39218/v1",
    api_key="sk-anything",            # any value works unless DEEPSEEK_API_KEY is set
)

resp = client.chat.completions.create(
    model="deepseek-reasoner",         # → deep-thinking (R1)
    messages=[{"role": "user", "content": "Write a short poem about the sea."}],
)
print(resp.choices[0].message.content)

# streaming
stream = client.chat.completions.create(
    model="deepseek-chat",
    messages=[{"role": "user", "content": "Count from 1 to 10."}],
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
  messages: [{ role: 'user', content: 'Hello!' }],
  // non-standard extensions (optional):
  search: true,                       // enable web search
  conversation_id: 'my-app:session-1' // reuse the same web thread
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
print(llm.invoke("Explain quantum entanglement.").content)
```

### Codex / CC Switch (or any tool with a custom OpenAI base URL)

Point the tool at the shim as if it were the OpenAI/DeepSeek API:

| Setting | Value |
|---|---|
| Base URL | `http://127.0.0.1:39218/v1` |
| API Key | any non-empty string (e.g. `sk-local`) unless you set `DEEPSEEK_API_KEY` |
| Model | `deepseek-chat` (normal) or `deepseek-reasoner` (deep-thinking) |

Agents that support tools (Codex, Cline, etc.) work through the shim's prompt-engineered tool-calling (see below), including multi-step file edits and desktop automation.

---

## OpenAI API reference (shim, `:39218`)

| Method & path | Description |
|---|---|
| `POST /v1/chat/completions` (alias `POST /chat/completions`) | Chat completion, OpenAI-compatible. `stream: true` gives true token-by-token SSE. |
| `GET /v1/models` (alias `GET /models`) | Lists `deepseek-chat` and `deepseek-reasoner`. |
| `GET /health` | Liveness (public, no auth). |

### Model mapping

| `model` you send | Behavior |
|---|---|
| `deepseek-chat` (or any name **without** reasoner/r1/think/reason) | Normal chat |
| `deepseek-reasoner` (or name containing `reasoner`/`r1`/`think`/`reason`) | **Deep-thinking (R1)**; timeout auto-extended to 10 minutes |

### Standard fields

- `response_format: { type: "json_object" }` → asks DeepSeek to output JSON (returned as text as usual).
- `temperature` / `top_p` / `max_tokens` etc. — **accepted but ignored** (the web UI exposes no such knobs).
- `usage` token counts are **rough estimates** (CJK ≈ 1 token/char, otherwise ≈ 4 chars/token); placeholders only, not real billing.

### Extension fields (non-standard, optional)

| Field | Effect |
|---|---|
| `search: true` | Enable **web search** |
| `expert: true` | Enable **expert mode** |
| `conversation_id: "<stable string>"` | Reuse the same web thread (context kept browser-side). Can also be passed via header `X-DS-Conversation`. |
| `new_chat: true` | Force a **new** web chat for that `conversation_id` and rebind |
| `timeout_ms: 300000` | Custom single-generation timeout (ms) |

### Vision (images)

The shim **does** support images. Standard OpenAI multimodal parts are accepted and forwarded to the web UI (which auto-switches to vision mode):

- `{"type": "image_url", "image_url": {"url": "data:image/png;base64,..."}}` (or a bare data-URL string)
- `{"type": "input_image", ...}` (Responses style)
- `{"type": "image", "source": {"type": "base64", "media_type": "...", "data": "..."}}` (Anthropic style)
- inline `data:image/...;base64,...` found anywhere in the text (fallback)

Images are decoded to local temp files (content-addressed, auto-deduped, swept after `DEEPSEEK_API_IMG_TTL_MS`) and uploaded via the daemon. At most `DEEPSEEK_API_IMG_MAX` (default 6) of the **most recent** images per turn are sent. *Note:* the URL must be a **base64 data-URL**; remote `http(s)://` image URLs are not fetched.

### Tool / function calling

The web UI has **no native tool-calling channel**, so the shim adds it via prompt engineering: when a request carries `tools`, their definitions are injected into the prompt, the model is taught to emit a parseable bracket marker, and the reply is parsed back into a standard OpenAI `tool_calls` array (`finish_reason: "tool_calls"`).

- Request `tools` accepts both Chat shape (`{type:"function", function:{name,description,parameters}}`) and Responses top-level shape (`{type:"function", name, ...}`).
- `tool_choice`: `"auto"` (default) / `"none"` / `"required"` / `{type:"function", function:{name}}`.
- **Multi-turn**: put the assistant's `tool_calls` and the `role:"tool"` results (with `tool_call_id`) back into `messages` and send again — the shim folds them into the plain-text transcript so the model can continue.
- **Streaming + tools**: when `tools` are present, the shim buffers the whole reply before deciding (so it never leaks partial prose that turns out to be a tool call). Tool-free streaming stays truly token-by-token.
- It is prompt-driven, so it is highly reliable but not 100%: if a model ignores the format, that turn degrades to a plain text answer (`finish_reason: "stop"`) — just retry.

### Sticky conversations (default on)

Some clients (e.g. Codex via CC Switch) **don't** send a `conversation_id`. Without help, each turn would open a brand-new web chat and resend the whole history. **Sticky** fixes this: the shim fingerprints the **first user message** (`key = codex:sha1(first user text).slice(0,16)`) to recognize "the same conversation", maps it to one web thread, and thereafter sends only the **new** messages incrementally.

- **Priority**: an explicit `conversation_id`/`X-DS-Conversation` header wins over sticky; `new_chat:true` forces a new window (still bound); nothing set → sticky takes over; `DEEPSEEK_API_STICKY=0` disables it (pure stateless).
- **Self-healing**: if the "already-sent prefix" no longer matches (edited history / restart), the shim resends the whole thing in a fresh window and rebinds.
- Bindings live in shim memory only (with TTL and a max count); a restart forgets them and self-heals.

### Errors & concurrency

- Error bodies are **OpenAI-style**: `{ "error": { "message", "type", "param", "code" } }`.
- Busy (concurrent contention) → HTTP `429` + `type: rate_limit_error`.
- Daemon unreachable / not logged in / generation failed → `502` + `type: api_error`.

---

## Daemon HTTP API (`:39217`) — for direct / any-language use

The shim is optional. Any language can call the daemon directly (JSON in/out, `Content-Type: application/json`). If `DEEPSEEK_WEB_TOKEN` is set, send `Authorization: Bearer <token>` on everything except `/health`. **Do not send an `Origin` header** — the daemon rejects requests carrying one (CSRF guard).

| Method & path | Description |
|---|---|
| `GET /health` | `{ ok, ts }` |
| `GET /status` | `{ installed, logged_in, alive, headless, profile_dir, conversations, modes_supported, note }` |
| `POST /login` | Pop a headed Chrome to log in. Body `{ timeoutMs }` (default 300000) → `{ ok, logged_in }` |
| `POST /chat` | **Core.** See fields below → `{ text, json?, ms, modes, conversationId, conversationUrl, reused }` |
| `POST /chat/stream` | SSE streaming. Chunks `data:{"delta":"..."}`, then `data:{"done":true, text, ms, modes, ...}`, then `data:[DONE]` |
| `GET /conversations` | `{ conversations: [{ conversationId, url, turns, boundAt, lastUsed }] }` |
| `POST /reset` | Body `{ conversationId }` → forget that mapping (next call opens a new chat) |

**`POST /chat` body fields:**

| Field | Type | Meaning |
|---|---|---|
| `prompt` | string | User message (may be empty when only sending images) |
| `system` | string? | System persona; folded into the body. **On reuse, injected only on the first turn.** |
| `json` | bool? | Ask for JSON only; response gains a parsed `json` field |
| `think` | bool? | Deep-thinking (R1); slower, timeout auto-extended to 10 min |
| `search` | bool? | Web search; **locked at conversation creation** (see below) |
| `expert` | bool? | Expert mode; **locked at conversation creation** |
| `images` | string[]? | **Vision**: array of absolute local image paths to upload |
| `conversationId` | string? | Reuse key — same id ⇒ same web thread, continuous context |
| `newChat` | bool? | Force a new chat for this `conversationId` and rebind |
| `timeoutMs` | number? | Single-generation timeout (ms) |

### Node thin client

Installed as a dependency (`require('deepseek-web')`) or by requiring `client.js` directly, you get a zero-dependency client:

```js
const ds = require('deepseek-web');            // === client.js
await ds.health();                              // { ok, ts }
await ds.status();                              // login / alive / conversations / supported modes
const r = await ds.chat({ prompt: 'Introduce yourself in one line' });
console.log(r.text);
const obj = await ds.chatJSON({ prompt: 'Give me a {name, age} example' });   // auto json:true, parsed
// continuous context: same business entity → same web thread
await ds.chat({ conversationId: 'app:8', system: 'You are a historian', prompt: 'The hero enters the city.' });
await ds.chat({ conversationId: 'app:8', prompt: 'Who did he meet?' });        // remembers the previous turn
// web-mode capabilities
await ds.chat({ prompt: 'Summarize recent Ethereum progress', think: true, search: true });
await ds.chat({ prompt: 'What is in this image?', images: ['/tmp/chart.png'] });
// others: ds.login(timeoutMs), ds.reset(conversationId), ds.listConversations()
```

---

## Web-mode capabilities & the "locked at creation" caveat

| Mode | Field | Scope |
|---|---|---|
| Deep-thinking | `think` | **Per message** — toggle on any turn; slower & stronger, timeout auto-extended |
| Web search | `search` | **Locked at conversation creation** (see below) |
| Expert mode | `expert` | **Locked at conversation creation** |
| Vision | `images` | Upload local images, auto-switches to vision mode |

**⚠ "Locked at creation" (verified):** in the DeepSeek web UI, the *web-search* toggle and the *fast/expert/vision* model-type selector only appear on a **new chat**; once a chat has started they disappear, leaving only *deep-thinking* per-turn. So `search`/`expert` are effectively **creation-time settings** for a thread — to change them, open a new chat (`newChat:true` / `new_chat:true`). `think` is not restricted. All mode switches are **best-effort**: a missing button never fails the call, it's just reported in the response's `modes` field (e.g. `modes.expert = {applied:false, reason:"not-found"}`).

---

## Environment variables

### Daemon (`server.js`)

| Variable | Default | Meaning |
|---|---|---|
| `DEEPSEEK_WEB_PORT` | `39217` | Daemon port |
| `DEEPSEEK_WEB_HOST` | `127.0.0.1` | Bind address (loopback only — do **not** change to `0.0.0.0`) |
| `DEEPSEEK_WEB_TOKEN` | *(empty)* | If set, require `Bearer` token on everything except `/health` |
| `DEEPSEEK_PROFILE_DIR` | `./profile` | Shared login profile directory |
| `DEEPSEEK_HEADLESS` | *(empty → headed)* | `1`/`true` runs headless (login is always forced headed) |
| `DS_DRIVER_DEBUG` | *(off)* | `1`/`true` appends a DOM-vs-SSE diff to `.driver-debug.log` (diagnostics) |

### API shim (`api-shim.js`)

| Variable | Default | Meaning |
|---|---|---|
| `DEEPSEEK_API_PORT` | `39218` | Shim port |
| `DEEPSEEK_API_HOST` | `127.0.0.1` | Bind address (loopback only) |
| `DEEPSEEK_API_KEY` | *(empty)* | If set, verify `Authorization: Bearer <key>`; unset = accept any key (local use) |
| `DEEPSEEK_API_ALLOW_ORIGIN` | *(empty)* | If set, allow that CORS origin (or `*`); unset = **reject any request with an `Origin` header** |
| `DEEPSEEK_WEB_URL` | `http://127.0.0.1:39217` | Daemon address |
| `DEEPSEEK_WEB_TOKEN` | *(empty)* | Must match the daemon's token if it enabled one |
| `DEEPSEEK_API_STICKY` | *(on)* | Sticky conversations; `0`/`false`/`off` disables |
| `DEEPSEEK_API_STICKY_TTL_MS` | `21600000` (6h) | How long an idle upstream binding is kept |
| `DEEPSEEK_API_STICKY_MAX` | `500` | Max simultaneously remembered upstream conversations |
| `DEEPSEEK_API_IMG_MAX` | `6` | Max images uploaded per turn (most recent kept) |
| `DEEPSEEK_API_IMG_TTL_MS` | `1800000` (30m) | How long temp image files are kept before sweeping |
| `DEEPSEEK_API_MAX_BODY` | `67108864` (64MB) | Max request body size (base64 images can be large) |

---

## Security

- Both processes bind **loopback `127.0.0.1`** only — never exposed to the network.
- **CSRF guard**: the daemon rejects any request carrying an `Origin` header (a malicious web page's `fetch` to a local port always sends one; genuine server-to-server calls do not). The shim does the same unless `DEEPSEEK_API_ALLOW_ORIGIN` is set.
- **Optional Bearer tokens** for further isolation (`DEEPSEEK_WEB_TOKEN`, `DEEPSEEK_API_KEY`).
- `profile/` (login cookies) and `conversations.json` are **local private runtime state** — they are git-ignored and **must never be committed**.
- **Client disconnect = true abort**: if a caller disconnects mid-generation, the daemon stops the in-progress web generation and releases the session promptly, so the next request isn't blocked by "session busy".

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Cannot connect to the DeepSeek daemon` | Start it: `npm start`. Check `curl http://127.0.0.1:39217/health`. |
| `/status` shows `logged_in: false` | Run `npm run login` and complete login in the Chrome window. |
| `429` / `rate_limit_error` from the shim | Single browser = serial. Retry shortly; don't fire concurrent requests. |
| `502` / `api_error` from the shim | Daemon down or not logged in — check the daemon and its `/status`. |
| `search`/`expert` didn't apply on a reused chat | They lock at creation — start a new chat with `new_chat:true`. |
| Playwright can't find a browser | Install Google Chrome, or reinstall without `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD` so Chromium downloads. |
| Chrome profile lock error | Only one process may hold the profile. Make sure you're not running two daemons; let the running daemon drive login. |

---

## Project layout

```
deepseek-web/
├── server.js            # daemon: HTTP API over the driver (:39217)
├── api-shim.js          # OpenAI-compatible API layer (:39218)
├── deepseek-driver.js   # Playwright driver (modes / prompt / vision / read)
├── client.js            # zero-dependency Node thin client
├── cli-login.js         # `npm run login` helper
├── package.json
└── profile/             # (git-ignored) real login cookies + conversation map
```

---

## License

[MIT](LICENSE). This license covers this project's own code only; it grants no rights to DeepSeek's service, trademarks, or content. See the disclaimer above.
