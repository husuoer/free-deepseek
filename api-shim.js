'use strict';
// DeepSeek 网页版 → OpenAI 兼容 API 适配层（纯新增·独立进程·不改动守护进程与客户端的任何现有逻辑）
//
// 作用：对外暴露一套「像官方 API」的 HTTP 端点（/v1/chat/completions、/v1/models），
//       内部把请求翻译后转发给本机的 DeepSeek 网页守护进程（默认 http://127.0.0.1:39217），
//       由守护进程驱动真实 Chrome 网页版出结果。于是任何吃 OpenAI/DeepSeek 官方 API 的库/工具
//       只需把 baseURL 指到本进程（默认 http://127.0.0.1:39218/v1），即可免费用上网页版能力。
//
// 独立性：本文件只依赖 Node 内置 http/crypto/url，自成一个进程（端口 DEEPSEEK_API_PORT，默认 39218）。
//         它不 require 守护进程/驱动/client.js，仅通过 HTTP 调用守护进程 → 与现有一切互不影响。
//
// 会话语义：默认「无状态」——每次调用守护进程都开新对话（OpenAI 客户端本就每次带全量 messages）。
//           可选「复用」——body.conversation_id 或请求头 X-DS-Conversation 传一个稳定 id，
//           则映射到守护进程同一对话线程（浏览器侧保留上下文，此时调用方只需发最新一轮即可）。
//
// 流式：body.stream=true → 真·逐字 SSE（转发守护进程 /chat/stream 的增量，重封装成 chat.completion.chunk）。
//
// 函数调用（工具）：请求带 tools（且 tool_choice!=='none'）时，把工具定义注入提示词、教网页版模型用括号标记
//           [function_calls]/[call:名]{...}[/call] 表达调用意图，响应侧再解析回 OpenAI 规范 tool_calls
//           （finish_reason='tool_calls'）。网页版无原生 tool-calling 通道，此为仿 chat2api 的提示词工程方案。
//           带工具时即便 stream=true 也先缓冲整段再判定（避免把正文推出后才发现其实是工具调用）。
//
// 模型映射：model 含 reasoner/r1/think → 开「深度思考」；response_format.type='json_object' → 要求 JSON。
//           扩展参数（非官方，可选）：search(联网搜索) / expert(专家模式) / conversation_id / new_chat。
//
// 环境变量：DEEPSEEK_API_PORT(默认 39218) / DEEPSEEK_API_HOST(默认 127.0.0.1) /
//           DEEPSEEK_API_KEY(设了才校验 Bearer；不设=本机自用任意 key 放行) /
//           DEEPSEEK_API_ALLOW_ORIGIN(设了才允许该跨域来源；不设=拒绝一切带 Origin 的请求) /
//           DEEPSEEK_WEB_URL(守护进程地址) / DEEPSEEK_WEB_TOKEN(守护进程令牌，与其一致时才需要)

const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.DEEPSEEK_API_PORT) || 39218;
const HOST = process.env.DEEPSEEK_API_HOST || '127.0.0.1';
const OWN_KEY = process.env.DEEPSEEK_API_KEY || '';                 // 设了就校验 Authorization: Bearer
const ALLOW_ORIGIN = process.env.DEEPSEEK_API_ALLOW_ORIGIN || '';  // 设了才放行该 Origin（否则拒绝带 Origin）
const DAEMON = process.env.DEEPSEEK_WEB_URL || 'http://127.0.0.1:39217';
const DAEMON_TOKEN = process.env.DEEPSEEK_WEB_TOKEN || '';
const MAX_BODY = Number(process.env.DEEPSEEK_API_MAX_BODY) || 64 * 1024 * 1024; // 识图截图以 base64 内联进正文，请求体会很大 → 给足冗余（可 env 覆盖）
// 识图（vision）：把消息里内联的截图（data:image;base64）落成本机临时文件，路径塞进 payload.images 交守护进程上传。
const IMG_DIR = path.join(__dirname, '.img-tmp');
const IMG_MAX_ATTACH = Math.max(1, Number(process.env.DEEPSEEK_API_IMG_MAX) || 6);            // 单轮最多上传几张（取最新的，避免长会话把历史图全传一遍）
const IMG_TTL_MS = Math.max(60000, Number(process.env.DEEPSEEK_API_IMG_TTL_MS) || 30 * 60 * 1000); // 临时图保留时长，过期即清
// 会话粘连（sticky）：默认开启。让「上游的一个对话」自动映射到「网页版同一条对话线程」（见文末 sticky 段）。
// 关掉：DEEPSEEK_API_STICKY=0（回到纯无状态：每轮开新对话）。
const STICKY = !/^(0|false|no|off)$/i.test(process.env.DEEPSEEK_API_STICKY || '');
const STICKY_TTL_MS = Math.max(60000, Number(process.env.DEEPSEEK_API_STICKY_TTL_MS) || 6 * 3600 * 1000); // 绑定过期（默认 6h 不活跃即回收）
const STICKY_MAX = Math.max(16, Number(process.env.DEEPSEEK_API_STICKY_MAX) || 500);                        // 最多同时记住多少个上游对话

// ——————————————————— 基础 HTTP 工具 ———————————————————
function send(res, code, obj, extraHeaders) {
  const body = JSON.stringify(obj == null ? {} : obj);
  res.writeHead(code, Object.assign(
    { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) },
    extraHeaders || {}
  ));
  res.end(body);
}

// OpenAI 风格错误体：{ error: { message, type, param, code } }
function sendErr(res, code, message, type) {
  send(res, code, { error: { message: String(message || 'error'), type: type || 'invalid_request_error', param: null, code: null } });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

function apiAuthed(req) {
  if (!OWN_KEY) return true; // 未设 key → 本机自用，不校验
  const h = req.headers['authorization'] || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return !!(m && m[1] === OWN_KEY);
}

// ——————————————————— OpenAI ↔ 守护进程 翻译 ———————————————————
// OpenAI 消息 content 可能是字符串，也可能是多模态数组（[{type:'text',text},{type:'image_url',...}]）
function normContent(c) {
  if (c == null) return '';
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c.map((p) => (p && typeof p === 'object' && typeof p.text === 'string') ? p.text
      : (typeof p === 'string' ? p : '')).filter(Boolean).join('\n');
  }
  if (typeof c === 'object' && typeof c.text === 'string') return c.text;
  return String(c);
}

// ——————————————————— 识图（vision）：截图 base64 → 本机临时文件 → 守护进程识图上传 ———————————————————
// computer use 是「截图→看→点」的视觉循环，截图以 data:image;base64 内联在消息里。normContent 只取文本、
// 会把图丢掉，模型就"瞎"了。这里把图抽出来落成临时文件，路径塞进 payload.images，由守护进程 setInputFiles 上传
// （上传即自动切识图模式）。三种来源都兼容：① {type:'image_url', image_url:{url}|字符串} ② {type:'input_image', …}
// ③ Anthropic {type:'image', source:{data}}；外加退化情况：data URL 直接混在文本里（正则捞）。
// 全流程 best-effort：任何异常都吞掉——识图是增强项，绝不能拖垮文本主链路。
function extForMime(mime) {
  const m = String(mime || '').toLowerCase();
  if (m.includes('jpeg') || m.includes('jpg')) return 'jpg';
  if (m.includes('webp')) return 'webp';
  if (m.includes('gif')) return 'gif';
  if (m.includes('bmp')) return 'bmp';
  return 'png';
}
function dataUrlToImg(u) {
  const m = /^data:(image\/[\w.+-]+);base64,([\s\S]+)$/.exec(String(u || '').trim());
  if (!m) return null;
  const b64 = m[2].replace(/\s+/g, '');
  return b64 ? { mime: m[1].toLowerCase(), b64 } : null;
}
// 从任意字符串里捞出内联的 data:image;base64（退化来源）。每次新建正则，避免 lastIndex 粘连。
function imgsFromText(s) {
  const out = [];
  const re = /data:(image\/[\w.+-]+);base64,([A-Za-z0-9+/=]+)/g;
  let m;
  while ((m = re.exec(String(s || ''))) !== null) { if (m[2]) out.push({ mime: m[1].toLowerCase(), b64: m[2] }); }
  return out;
}
// 抽出一条消息 content 里的所有图 → [{mime,b64}]
function extractImages(content) {
  const out = [];
  const one = (p) => {
    if (p == null) return;
    if (typeof p === 'string') { out.push(...imgsFromText(p)); return; }
    if (typeof p !== 'object') return;
    const type = p.type || '';
    if (type === 'image_url' || type === 'input_image' || type === 'image') {
      let raw = null;
      if (p.image_url != null) raw = (typeof p.image_url === 'object') ? p.image_url.url : p.image_url;
      else if (p.url != null) raw = p.url;
      else if (typeof p.image === 'string') raw = p.image;
      const img = raw != null ? dataUrlToImg(raw) : null;
      if (img) { out.push(img); return; }
      const src = p.source; // Anthropic 形态 source:{type:'base64', media_type, data}
      if (src && src.data) { out.push({ mime: String(src.media_type || 'image/png').toLowerCase(), b64: String(src.data).replace(/\s+/g, '') }); return; }
      try { out.push(...imgsFromText(JSON.stringify(p))); } catch { /* ignore */ } // 兜底：序列化后捞
      return;
    }
    if (typeof p.text === 'string') { out.push(...imgsFromText(p.text)); return; }
  };
  if (Array.isArray(content)) content.forEach(one);
  else one(content);
  return out;
}
// 遍历消息序列，按出现顺序收集所有图
function collectImages(msgs) {
  const out = [];
  for (const m of (Array.isArray(msgs) ? msgs : [])) { if (m && typeof m === 'object') out.push(...extractImages(m.content)); }
  return out;
}
// 把正文里内联的 data URL 换成占位符（图已单独上传，避免几 MB base64 撑爆 prompt）
function stripDataUrls(s) {
  return String(s == null ? '' : s).replace(/data:image\/[\w.+-]+;base64,[A-Za-z0-9+/=]+/g, '[图片已作为识图上传]');
}
// 清理临时图目录里过期文件（best-effort）
function sweepImgDir() {
  try {
    const now = Date.now();
    for (const f of fs.readdirSync(IMG_DIR)) {
      const fp = path.join(IMG_DIR, f);
      try { if (now - fs.statSync(fp).mtimeMs > IMG_TTL_MS) fs.unlinkSync(fp); } catch { /* ignore */ }
    }
  } catch { /* 目录不存在等 → 忽略 */ }
}
// 把 [{mime,b64}] 写成本机临时文件，返回绝对路径数组（内容寻址：同图不重复写，天然去重）
function dumpImages(imgs) {
  const out = [];
  if (!Array.isArray(imgs) || !imgs.length) return out;
  try { fs.mkdirSync(IMG_DIR, { recursive: true }); } catch { /* ignore */ }
  sweepImgDir();
  for (const im of imgs) {
    if (!im || !im.b64) continue;
    let buf; try { buf = Buffer.from(im.b64, 'base64'); } catch { continue; }
    if (!buf || !buf.length) continue;
    const fp = path.join(IMG_DIR, sha1hex(im.b64).slice(0, 16) + '.' + extForMime(im.mime));
    try { if (!fs.existsSync(fp)) fs.writeFileSync(fp, buf); out.push(fp); } catch { /* ignore */ }
  }
  return out;
}
// 给 payload 叠加识图：从「本轮真正贡献的消息」scopeMsgs 里抽图（取最新 IMG_MAX_ATTACH 张），落文件塞 payload.images，
// 并把 prompt 里的内联 base64 清成占位符。整段包 try/catch，任何异常都不影响文本主链路。
function finalizePayload(payload, scopeMsgs) {
  try {
    const imgs = collectImages(scopeMsgs);
    if (imgs.length) {
      const files = dumpImages(imgs.slice(-IMG_MAX_ATTACH));
      if (files.length) payload.images = files;
      if (typeof payload.prompt === 'string') payload.prompt = stripDataUrls(payload.prompt);
    }
  } catch { /* 识图失败绝不拖垮主链路 */ }
  return payload;
}

// 把 assistant 之前的 tool_calls 渲染成「我们教模型的同一种括号格式」，让历史转录保持一致的模式
function renderToolCalls(toolCalls) {
  const inner = (Array.isArray(toolCalls) ? toolCalls : []).map((tc) => {
    const f = (tc && tc.function) || {};
    const name = f.name || 'tool';
    let args = f.arguments;
    if (typeof args !== 'string') { try { args = JSON.stringify(args || {}); } catch { args = '{}'; } }
    return `[call:${name}]${args}[/call]`;
  }).filter(Boolean).join('\n');
  return inner ? `[function_calls]\n${inner}\n[/function_calls]` : '';
}

// 把 messages[] 折叠成 { system, prompt }：所有 system 合并；单条 user 直接当 prompt，多轮折叠成带角色标签的文本。
// 工具感知：assistant.tool_calls 渲染成括号格式并入正文；role:'tool' 的结果按其对应工具名标注回填，
//           使网页版模型能在纯文本转录里看到「它调了什么工具、拿回什么结果」，从而接着往下走（chat2api 的上下文管理思路）。
function foldMessages(messages) {
  if (!Array.isArray(messages)) return { system: '', prompt: '' };
  const systems = []; const convo = [];
  // 先建立 tool_call_id → 工具名 的映射（供 role:'tool' 结果标注用）
  const idName = {};
  for (const m of messages) {
    if (m && m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) { if (tc && tc.id) idName[tc.id] = (tc.function && tc.function.name) || ''; }
    }
  }
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    const role = m.role || 'user';
    if (role === 'system') { const t = normContent(m.content); if (t) systems.push(t); continue; }
    if (role === 'assistant') {
      const parts = [];
      const t = normContent(m.content); if (t) parts.push(t);
      if (Array.isArray(m.tool_calls) && m.tool_calls.length) { const r = renderToolCalls(m.tool_calls); if (r) parts.push(r); }
      const text = parts.join('\n'); if (!text) continue;
      convo.push({ tag: 'assistant', text });
      continue;
    }
    if (role === 'tool') {
      const t = normContent(m.content); if (!t && t !== '') continue;
      const nm = (m.tool_call_id && idName[m.tool_call_id]) ? idName[m.tool_call_id] : (m.name || '');
      convo.push({ tag: 'tool', text: nm ? `[${nm}] ${t}` : t });
      continue;
    }
    const t = normContent(m.content); if (!t) continue;
    convo.push({ tag: 'user', text: t });
  }
  const system = systems.join('\n\n').trim();
  let prompt;
  if (convo.length === 1 && convo[0].tag === 'user') prompt = convo[0].text;
  else prompt = convo.map((c) => (c.tag === 'assistant' ? 'Assistant: ' : c.tag === 'tool' ? 'Tool: ' : 'User: ') + c.text).join('\n\n');
  return { system, prompt: prompt || '' };
}

function wantThink(model) { return /reasoner|r1|think|reason/i.test(String(model || '')); }

// 依据「模型名」决定网页版模式档位。关键背景：Codex（wire_api="responses"）经 CC Switch 代理转发时，
// 只会发送标准 OpenAI chat 字段，无法携带 search/expert 这类自定义 body 字段；因此把「想要的模式组合」
// 编码进模型名，让不同「模型」映射到不同的网页开关组合：
//   含 pro / expert             → 专家模式 + 深度思考
//   含 flash                    → 快速模式 + 深度思考 + 智能搜索
//   含 reasoner/r1/think/reason  → 仅深度思考（兼容 deepseek-reasoner）
//   含 search/联网/websearch     → 开启智能搜索（可与上叠加；也是「带工具时按需开搜索」的模型名开关）
//   其它                         → 快速模式（全部关闭）
function modelWantsSearch(model) { return /search|联网|web[-_]?search/i.test(String(model || '')); }
function modelModes(model) {
  const s = String(model || '').toLowerCase();
  const wantSearch = modelWantsSearch(s);
  if (/pro\b|expert/.test(s)) return { think: true, search: wantSearch, expert: true };
  if (/flash/.test(s)) return { think: true, search: true, expert: false };
  if (/reasoner|r1|think|reason/.test(s)) return { think: true, search: wantSearch, expert: false };
  if (wantSearch) return { think: false, search: true, expert: false };
  return { think: false, search: false, expert: false };
}

// ——————————————————— 函数调用（工具）：提示词注入 + 输出解析 ———————————————————
// 背景：DeepSeek 网页版没有原生 tool-calling 通道，永远不会自己吐出结构化 tool_calls。
//       故仿 chat2api 的「通用工具调用」做法——把工具定义注入提示词、教模型用一段可解析的文本标记
//       表示「我要调用某工具」，再在响应侧把这段文本解析回 OpenAI 规范的 tool_calls。
//       用【方括号】标记而非 <XML> 标记：DeepSeek 网页的 Markdown 渲染会吞掉 <...> 类 HTML 标签，
//       但 [...] 原样保留，解析更稳。
function buildToolPrompt(tools, toolChoice) {
  const lines = tools.map((t, i) => {
    const f = (t && t.function) ? t.function : (t || {});
    const name = f.name || ('tool_' + i);
    const desc = f.description || '';
    let params;
    try { params = JSON.stringify(f.parameters || { type: 'object', properties: {} }); }
    catch { params = '{"type":"object","properties":{}}'; }
    return `${i + 1}. ${name}${desc ? ' — ' + desc : ''}\n   parameters(JSON Schema): ${params}`;
  }).join('\n');

  let mandate;
  if (toolChoice === 'required') mandate = 'For THIS turn you MUST call at least one tool.';
  else if (toolChoice && typeof toolChoice === 'object' && toolChoice.function && toolChoice.function.name) mandate = `For THIS turn you MUST call the tool named "${toolChoice.function.name}".`;
  else mandate = 'If any tool can fulfil the user\'s request, calling it is REQUIRED — not optional.';

  // 关键：host（如 Codex）里很多工具是「延迟加载」的——不在上面清单里，需先用 tool_search 按需加载。
  // 「操作本地应用/GUI」（发微信、点浏览器、截屏、桌面自动化）走的是 computer-use 技能，其真正的执行工具
  // （node_repl 等）默认不可见，必须先 tool_search 把它们调出来再用。网页版模型不懂这一层，看到清单里只有
  // shell/patch 就断定「做不到」而用散文拒绝（实测「用微信给斩龙人发你好」即如此）。故当 tool_search 在场时，
  // 显式告诉模型：先搜索能力、绝不在搜索前拒绝。
  const hasToolSearch = tools.some((t) => {
    const f = (t && t.function) ? t.function : (t || {});
    return (f && f.name || (t && t.name)) === 'tool_search';
  });
  const discovery = hasToolSearch ? [
    '',
    '# CAPABILITY DISCOVERY — the visible list is NOT all you have (critical)',
    'Many tools are DEFERRED and not shown above; the `tool_search` tool loads them on demand. In particular this host has a "computer-use" skill ("Control Windows apps from Codex") and a browser-control skill, whose actual executor tools become callable ONLY after you load them via tool_search.',
    '- If the user asks you to control a desktop application (微信/WeChat, a browser, an editor, any GUI app), click or type on the screen, take a screenshot, automate the desktop, or do anything the visible tools do not obviously cover, your FIRST action MUST be to call `tool_search` to load the right tools — for example [call:tool_search]{"query":"computer use control windows apps"} or [call:tool_search]{"query":"node_repl"} — and THEN use whatever tools it returns on the following turns.',
    '- NEVER reply that you "cannot control the app", "there is no CLI/command-line interface or API", "UI automation is unreliable", or otherwise refuse / offer a manual workaround for a desktop / GUI / app-control request BEFORE you have actually called `tool_search`. Refusing or deflecting without first searching for the capability is a HARD FAILURE. Assume the capability exists on this machine and go load it.',
    // 下面三条：把官方 GPT-5.5「靠读 SKILL.md 天然获得」的优势显式补给网页版 DeepSeek。
    // 实测缺这三点，网页版虽能发现能力、也加载出了 node_repl，却因（a）跳过 SKILL.md 凭记忆猜 bootstrap、
    // （b）路径写单反斜杠 → \26 八进制转义崩掉、（c）撞错就放弃回「你手动发吧」，导致 computer-use 一条都没真跑成。
    '- READ THE SKILL FILE FIRST: the skills list in the system prompt gives each skill a SKILL.md path (computer-use points at a real file path). Before you write ANY automation/bootstrap code for that skill, your FIRST tool call MUST read its SKILL.md in full using the shell tool shown above (e.g. [call:exec_command]{"command":"Get-Content -Raw -LiteralPath \'<the SKILL.md path from the skills list>\'"}), then COPY its bootstrap snippet verbatim. Do NOT invent the bootstrap from memory — the SKILL.md has the exact working import path and API surface, and guessing it wrong is the single biggest cause of failure here.',
    '- PATHS INSIDE CODE MUST USE FORWARD SLASHES: whenever a filesystem path appears INSIDE js/python code you execute (import()/require()/open/readFile, etc.), write it with "/" — e.g. await import("C:/Users/you/.codex/plugins/cache/openai-bundled/computer-use/<version>/scripts/computer-use-client.mjs"). NEVER use single backslashes in code: a sequence such as "\\26" is an octal escape that makes the node_repl `js` tool crash with "Octal escape sequences are not allowed in strict mode". (If you genuinely need a literal backslash in code, double it to "\\\\".)',
    '- ON ERROR, FIX AND RETRY — NEVER GIVE UP: if a code/tool call returns a syntax, escape, or runtime error, diagnose the cause and emit a CORRECTED call on the next turn. You must NOT abandon a tool-driven task, and must NOT fall back to telling the user to "do it manually", once you have started using tools. Keep iterating until the requested action actually completes.',
    // 下面三条：针对网页版 DeepSeek「能跑起 computer-use 但写代码质量差、反复空转」的实测病灶（见 .shim-debug.log）。
    // (1) code 里裸双引号破坏 JSON → 丢 code 字段/截断；(2) 无反引号却用 ${} → 语法错；(3) 持久 REPL 里重复 const → already declared。
    '- CODE STRINGS MUST USE SINGLE QUOTES: inside the js/python code you send to node_repl, write EVERY string literal with single quotes, never double quotes. Your whole code is carried inside a JSON string value, so a bare double-quote in the code ends that JSON string early and the tool loses your code (you then see errors like "missing field code" or "Unterminated string literal" — the single biggest time-waster observed here). Example: write nodeRepl.write(\'ok\') and throw new Error(\'bad\'), NOT the double-quote form. If you need a literal apostrophe inside a string, escape it as \\\'.',
    '- NO TEMPLATE LITERALS UNLESS YOU ACTUALLY TYPE THE BACKTICKS: writing ${x} inside an ordinary quoted string or a regex is a JavaScript syntax error. Build strings by concatenating with +, e.g. c.id + \' \' + (c.displayName || \'\').',
    '- THE node_repl CONTEXT PERSISTS BETWEEN CALLS: do NOT redeclare a variable with const/let across calls (you will get "Identifier X has already been declared"). Store anything you need later on globalThis (e.g. globalThis.win = ...) and read it back on the next call; use var for throwaway locals. A previous call may have FAILED, so before relying on such state, re-check it: if (!globalThis.win) { ...re-acquire it... } — never assume a variable survived when the call that set it errored out.',
  ] : [];

  return [
    '# TOOLS',
    'You are running as an autonomous agent inside a host application (such as a coding assistant). Use the following tools/functions to ACTUALLY perform the requested actions:',
    '',
    lines,
    '',
    '# HOW TO CALL A TOOL',
    'When you call tools, output a block in EXACTLY this bracket format (do NOT use XML tags, do NOT wrap it in code fences):',
    '[function_calls]',
    '[call:EXACT_TOOL_NAME]{"arg1":"value1","arg2":123}[/call]',
    '[/function_calls]',
    '',
    '# FORMAT RULES',
    '- Use the exact tool name from the list above (names are case-sensitive).',
    '- The text right after [call:NAME] MUST be one compact single-line JSON object matching that tool\'s parameters. No newlines inside it, no comments, no extra prose.',
    '- It MUST be strictly valid JSON. Escape special characters inside string values: write a backslash as \\\\ and a double-quote as \\". For a Windows path write "C:\\\\Users\\\\me\\\\file.txt" (double every backslash). Inside a shell command prefer SINGLE quotes so you don\'t nest double-quotes, e.g. [call:exec_command]{"command":"echo hi > \'C:\\\\Users\\\\me\\\\a.txt\'"}.',
    '- If a tool takes no arguments, use an empty object: [call:NAME]{}[/call].',
    '- To call several tools at once, put multiple [call:...]...[/call] entries inside one [function_calls]...[/function_calls] block.',
    '- Put the [function_calls] block at the very END of your reply, and write nothing after [/function_calls].',
    '- After emitting tool calls, STOP. Do NOT fabricate the results yourself — the real results will be given back to you in the next turn.',
    '',
    '# LARGE / MULTI-LINE TEXT → PUT IT IN A VERBATIM BLOCK (critical for writing files, patches & code)',
    'Cramming multi-line text (a file\'s contents, an apply_patch patch, or source code) into the single-line JSON above is the #1 cause of CORRUPTED writes — your \\n, \\\\ and \\" escaping gets mangled and the file ends up empty or broken. So for any BIG or MULTI-LINE string argument, DO NOT put the real text in the JSON. Instead:',
    '1. In the JSON, set that field to the exact placeholder string "@@VERBATIM:1@@" (use ids 1, 2, 3… if you have several such fields).',
    '2. AFTER the [/call], add the real text inside a block delimited by [verbatim:1] … [/verbatim:1] (id must match the placeholder). Put the opening and closing markers each on their OWN line.',
    '3. Inside the verbatim block write the text 100% RAW — real line breaks, real quotes, real backslashes. Do NOT escape anything, and do NOT wrap it in ``` code fences. The block is taken literally, character-for-character.',
    'This is the REQUIRED way to pass: write/create-file content, apply_patch input, and node_repl code. Small one-line string args stay inline in the JSON as normal.',
    'EXAMPLE (write a file — note content is a placeholder in the JSON, real code sits in the verbatim block):',
    '[function_calls]',
    '[call:write]{"path":"E:/proj/server.js","content":"@@VERBATIM:1@@"}[/call]',
    '[verbatim:1]',
    'const express = require(\'express\');',
    'const app = express();',
    'app.get(\'/\', (req, res) => res.send(\'ok\'));',
    'app.listen(3000);',
    '[/verbatim:1]',
    '[/function_calls]',
    ...discovery,
    '',
    '# ACT — DO NOT JUST TALK (very important)',
    '- When the user asks you to DO something a tool can accomplish (create/read/edit files, run commands, control a desktop app, automate the screen, browse the web, etc.), you MUST emit a tool call — calling `tool_search` FIRST if the needed capability is not already in the list above. Do NOT reply with prose describing what you would do, and never print the command / code / file content / patch as text or inside a Markdown code block.',
    '- Do NOT ask the user for permission or confirmation before calling a tool — never say things like "this path is outside the workspace, may I proceed?" or "shall I run this?". The host application enforces sandboxing/permissions and will ask the user for approval on its own. Your only job is to emit the tool call; let the host handle approvals, paths and sandboxing.',
    '- Reply in plain text ONLY when the user is merely chatting or asking a question that genuinely needs no tool.',
    '- ' + mandate,
    '',
    '# EXAMPLE OF CORRECT BEHAVIOUR',
    'User: "create newfile.txt on my desktop with the text 你好"',
    'WRONG (never do this): "The desktop is outside the workspace, shall I proceed? Here is the command: ```New-Item ...```"',
    'RIGHT (emit a real tool call and nothing else; pick the right tool and match ITS actual parameter schema shown above):',
    '[function_calls]',
    '[call:exec_command]{"command":"<the command that creates the file and writes 你好>"}[/call]',
    '[/function_calls]',
  ].join('\n');
}

// 从「类 JSON」文本里抽取并修复出首个合法 JSON 对象串。
// 网页版常把 Windows 路径（C:\Users → 非法 JSON 转义 \U）和内嵌双引号（echo 你好 > "C:\..."）
// 原样塞进字符串，导致 JSON.parse 直接失败。这里用小状态机走查：
//   · 只在「字符串外」计花括号深度 → 内嵌 { } 的 shell 命令不会把配平算歪；
//   · 字符串内把孤立反斜杠补成 \\、把「内容引号」转义成 \"（靠"收尾引号后必跟 : , } ] 或结尾"来区分收尾/内容引号）、把裸控制符补成 \n\r\t；
//   · 顶层对象配平（depth 归零）即截断，丢弃尾随噪声。
// codeMode=true（代码类工具，如 node_repl 的 js）：\/ \b \f \n \r \t 是合法 JSON 转义、原样保留，只把「非法转义」（Windows 路径 \Users \temp 等）当字面反斜杠双写——
//   因为模型此时写的是源代码，其中的 \n 是真换行转义，绝不能像路径那样双写成 \\n（会把代码语法打断）。
function extractRepairedObject(src, codeMode) {
  const s = String(src);
  const start = s.indexOf('{');
  if (start < 0) return null;
  let out = '';
  let inStr = false, role = null, lastStruct = '';
  const ctx = []; // 结构上下文栈：'{'（对象）或 '['（数组）
  for (let k = start; k < s.length; k++) {
    const ch = s[k];
    if (!inStr) {
      if (ch === '"') {
        const inArray = ctx.length && ctx[ctx.length - 1] === '[';
        role = inArray ? 'val' : (lastStruct === ':' ? 'val' : 'key');
        inStr = true; out += '"'; continue;
      }
      if (ch === '{' || ch === '[') { ctx.push(ch); out += ch; lastStruct = ch; continue; }
      if (ch === '}' || ch === ']') {
        ctx.pop(); out += ch; lastStruct = '';
        if (ch === '}' && ctx.length === 0) return out; // 顶层对象闭合 → 截断尾随噪声
        continue;
      }
      if (ch === ',' || ch === ':') { lastStruct = ch; out += ch; continue; }
      out += ch; // 空白 / 数字 / true|false|null 原样
      continue;
    }
    // —— 字符串内部 ——
    if (ch === '\\') {
      const nx = s[k + 1];
      if (nx === '"' || nx === '\\') { out += '\\' + nx; k++; } // 已转义的 " 或 \ 原样保留
      else if (nx === 'u' && /^[0-9a-fA-F]{4}$/.test(s.slice(k + 2, k + 6))) { out += '\\u' + s.slice(k + 2, k + 6); k += 5; } // \uXXXX 保留
      else if (codeMode && (nx === '/' || nx === 'n' || nx === 'r' || nx === 't')) { out += '\\' + nx; k++; } // 代码/补丁工具：\n \r \t \/ 是文件正文里真实的换行/制表/斜杠，原样保留、别当路径双写。刻意不含 \b \f——单反斜杠的 \b \f 几乎必是 Windows 路径段（\bin \boot \fonts）被误当退格/换页，落到下面双写还原成字面反斜杠（合法的正则 \b 由模型双写成 \\b、走上面 nx==='\\' 分支，不受影响）
      else out += '\\\\'; // 其余（含 Windows 路径 \Users \temp \Desktop 等非法转义）一律当字面反斜杠 → 双写
      continue;
    }
    if (ch === '"') {
      let t = k + 1;
      while (t < s.length && (s[t] === ' ' || s[t] === '\t' || s[t] === '\r' || s[t] === '\n')) t++;
      const nx = t < s.length ? s[t] : '';
      const closing = (role === 'key') ? (nx === ':') : (nx === ',' || nx === '}' || nx === ']' || nx === '');
      if (closing) { out += '"'; inStr = false; role = null; }
      else out += '\\"'; // 内容引号 → 转义
      continue;
    }
    if (ch === '\n') { out += '\\n'; continue; }
    if (ch === '\r') { out += '\\r'; continue; }
    if (ch === '\t') { out += '\\t'; continue; }
    out += ch;
  }
  // 走到 EOF 仍未配平：网页版模型极常把单字段对象写成 {"query":"x" 就直接接 [/call]，漏掉收尾的 }
  //（tool_search 调用几乎每次都这样）。这种串以前 JSON.parse 失败 → 落回 {} → query 整个丢失 →
  // Codex 端 tool_search 收到空参数 → 返回空工具列表 → node_repl/computer-use 永远加载不出来。
  // 这里按当前状态尽力补齐：先闭合未收尾的字符串，再按结构栈逆序补上缺失的 } / ]，
  // 让上层 parse 出模型真实意图（{"query":"x"} 而非 {}）。
  if (inStr) out += '"';
  for (let j = ctx.length - 1; j >= 0; j--) out += (ctx[j] === '[' ? ']' : '}');
  return out; // 尽力配平后的串，交上层试 parse
}

// 递归判断解析结果里是否含「裸退格(\b)/换页(\f)」控制符——它们几乎不可能是有意的参数内容，
// 出现基本可断定是 Windows 路径段 \bin \boot \fonts 被 JSON 当成了 \b \f 转义。据此把「看似解析成功
// 实则被转义带歪」的结果打回修复器重解。刻意不含 \t \n \r：制表/换行/回车在 write/apply_patch 的文件
// 正文里是合法内容，绝不能误改。
function hasBadCtrl(v) {
  if (typeof v === 'string') return v.indexOf('\b') >= 0 || v.indexOf('\f') >= 0;
  if (Array.isArray(v)) return v.some(hasBadCtrl);
  if (v && typeof v === 'object') return Object.values(v).some(hasBadCtrl);
  return false;
}

// 非破坏性地截出首个「配平的顶层 {..}」（字符串感知：跳过字符串内的转义与括号），失败返回 null。
// 仅用于「本是合法 JSON、只被尾随噪声（如 } 后多余的 \n、"好的我已调用工具"等）带歪」时救回，避免无谓地进有损修复。
function sliceTopObject(s) {
  const str = String(s || '');
  const start = str.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false;
  for (let k = start; k < str.length; k++) {
    const ch = str[k];
    if (inStr) {
      if (ch === '\\') { k++; continue; } // 跳过被转义的下一个字符
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') { depth--; if (depth === 0) return str.slice(start, k + 1); }
  }
  return null;
}

// 代码类工具：其 arguments 里带的是源代码（如 node_repl 的 js），其中 \n \t 等是合法 JSON 转义、必须原样保留，
// 绝不能像 Windows 路径那样把反斜杠双写（否则代码语法被打断）。名字以 js/py/python/code/eval/repl/node 结尾即判为代码工具。
function isCodeTool(name) {
  return /(?:^|[._])(?:js|py|python|code|eval|repl|node)$/i.test(String(name || ''));
}

// 补丁/写文件类工具：arguments 里带的是「文件正文 / 补丁全文」这类多行大文本，其中的 \n \t 是合法 JSON
// 转义、代表真实换行/制表，必须原样保留——绝不能像 Windows 路径那样把反斜杠双写，否则整段补丁被挤成一行 →
// apply_patch 解析失败 → 文件写不进去（实测网页版 v4-flash 生成的补丁里但凡带裸双引号[content-type/字符串量]
// 就令严格 JSON 解析失败、落到路径修复分支把 \n 双写，10 条抓包里 7 条因此损坏）。判定与 isCodeTool 同为
// 「结尾 token」式（$ 锚定），只认写/改文件工具名结尾，避免误伤 rewrite_query / credit_check 等无关名。
// 覆盖 Codex 的 apply_patch 及常见 write/edit/str_replace 系工具。
function isPatchTool(name) {
  return /(?:^|[._-])(?:apply_?patch|patch|write|write_?file|create_?file|edit|edit_?file|str_?replace|str_?replace_?editor|str_?replace_?based_?edit_?tool)$/i.test(String(name || ''));
}

// —— 代码类工具专用兜底（Fix B）——
// 网页版 DeepSeek 生成 JS 时极常在 code 字符串里写「裸双引号」（throw new Error("x")、{ app: "y" }、
// nodeRepl.write("done") 等），而整段 code 是塞在 JSON 的 "…" 值里的 → 一个裸 " 就把 JSON 串提前截断。
// 于是上面的三层修复要么把 code 整个丢掉（node_repl 报 "missing field code"），要么在第一个裸引号处截断
// code（报 "Unterminated string literal" / "Invalid token"）——因为 extractRepairedObject 的「引号后跟
// 逗号/花括号即判收尾」启发式，撞上代码里极常见的 Error("x", ...) / { app:"y" } 就误判 code 结束。
// 实测「用微信给斩龙人发你好」网页版几乎每轮栽在这里、空转到耗尽轮数。这里做「定位 code 值 → 贪婪取到
// 真正的收尾」的兜底：把裸双引号一律当字面量，还原完整源码，交回 JSON.stringify 时再由本程序正确转义。
const AsyncFn = Object.getPrototypeOf(async function () {}).constructor;
// 语法能否编译？仅用于判断「上面三层拿到的 code 是否被截断坏了」——被截断的代码基本编译不过。
function jsCompiles(code) { try { AsyncFn(String(code)); return true; } catch { return false; } }
// 宽松还原 JSON 字符串转义：\n\t\r\b\f→控制符、\"→"、\\→\、\/→/、\uXXXX→字符；其余（含模型漏转义的裸 "）原样留。
function jsonUnescapeLoose(s) {
  return String(s).replace(/\\(u[0-9a-fA-F]{4}|[\s\S])/g, (mm, g) => {
    if (g[0] === 'u') { const cp = parseInt(g.slice(1), 16); return Number.isFinite(cp) ? String.fromCharCode(cp) : mm; }
    switch (g) {
      case 'n': return '\n'; case 't': return '\t'; case 'r': return '\r';
      case 'b': return '\b'; case 'f': return '\f';
      case '"': return '"'; case '\\': return '\\'; case '/': return '/';
      default: return g; // \' 等非标准转义 → 去掉反斜杠留字面字符
    }
  });
}
// 从「含裸引号的坏 JSON 片段」里贪婪抽出 code 值的真实源码。终点判定：
//   ① code 后若跟着已知标量字段（"…","title":… / "…","timeout_ms":… 等）→ 以最后一个这样的锚点前的 " 收尾；
//   ② 否则（code 是唯一/末尾字段）→ 取「最后一个 } 之前的最后一个 "」收尾。
// 找不到 "code": 起点则返回 null（交回上层其它逻辑）。
function greedyCodeValue(seg) {
  try {
    const s = String(seg || '');
    const m = /"code"\s*:\s*"/.exec(s);
    if (!m) return null;
    const start = m.index + m[0].length;
    if (start >= s.length) return null;
    const rest = s.slice(start);
    let endRel = -1;
    const fieldRe = /"\s*,\s*"(?:title|timeout_ms|timeout|language|lang|node_id|reset|name|id)"\s*:/g;
    let fm;
    while ((fm = fieldRe.exec(rest)) !== null) endRel = fm.index; // 取最后一个已知字段锚点
    if (endRel < 0) {
      const lastBrace = rest.lastIndexOf('}');
      const searchEnd = lastBrace >= 0 ? lastBrace : rest.length;
      endRel = rest.lastIndexOf('"', searchEnd - 1);
    }
    if (endRel < 0) endRel = rest.length; // 连收尾引号都没有（模型漏了）→ 取到末尾
    return jsonUnescapeLoose(rest.slice(0, endRel));
  } catch { return null; }
}

// 尽力把一段文本解析成 JSON 对象。分三层，越靠前越无损：
//   1) 直接 parse 原串（代码工具不走 hasBadCtrl 改判——\b\f 在 JS 代码里是合法转义）；
//   2) 若只是被尾随噪声带歪，截出配平的顶层对象再 parse 一次即可救回，仍无损；
//   3) 都不行才进有损修复（extractRepairedObject：代码工具走「保留合法转义」的 codeMode，其余走 Windows 路径向）。
function coerceJsonObject(raw, codeMode) {
  const s = String(raw || '').trim();
  if (!s) return {};
  let primary = null, strictOK = false;
  try { const o = JSON.parse(s); strictOK = true; if (!(o && typeof o === 'object')) return { value: o }; if (codeMode || !hasBadCtrl(o)) primary = o; /* 含裸退格/换页 → 落修复器 */ } catch { /* 继续兜底 */ }
  if (!primary) {
    const sliced = sliceTopObject(s);
    if (sliced && sliced !== s) { try { const o = JSON.parse(sliced); if (o && typeof o === 'object' && (codeMode || !hasBadCtrl(o))) primary = o; } catch { /* 继续兜底 */ } }
  }
  if (!primary) {
    const rep = extractRepairedObject(s, codeMode);
    if (rep) { try { const o = JSON.parse(rep); if (o && typeof o === 'object') primary = o; } catch { /* ignore */ } }
  }
  // Fix B：代码类工具兜底。仅当严格 JSON 解析失败（说明 code 里多半有裸引号把 JSON 弄坏了），
  // 且上面拿到的 code 缺失/编译不过（被截断坏了）时，才用贪婪抽取还原完整源码。
  // 合法输入（strictOK）与「code 本就能编译」的情形一律不动 → 既有 46 项自测行为不变。
  if (codeMode && !strictOK) {
    const pc = (primary && typeof primary.code === 'string') ? primary.code : '';
    if (!pc || !jsCompiles(pc)) {
      const gc = greedyCodeValue(s);
      if (gc && gc.trim() && gc.length >= pc.length) {
        return Object.assign({}, (primary && typeof primary === 'object') ? primary : {}, { code: gc });
      }
    }
  }
  return primary || {};
}

// ——— 带外「原样块」（verbatim block）：根治大文本字段写不进去的转义地狱 ———
// 病灶：apply_patch.input / write.content / node_repl.code 这类「多行大文本」被硬塞进单行 JSON 字符串时，
//       网页版模型对 \n \\ \" 的转义十有八九写错（实测 apply_patch 的 \n 被当字面反斜杠双写、换行全丢 →
//       补丁解析失败 → 文件写不进去）。稳修：教模型把大文本放进 JSON *之外* 的「原样块」，JSON 里只放占位符；
//       解析侧把原样块按「字面」取出（完全不做 JSON 反转义）注回该字段 → 彻底绕开 JSON 转义。
//   形如：[call:write]{"path":"E:/a/b.js","content":"@@VERBATIM:1@@"}[/call]
//         [verbatim:1]
//         真·文件内容（任意多行/引号/反斜杠，一律原样、无需转义）
//         [/verbatim:1]
// 兼容：模型若没用原样块、仍把内容内联进 JSON → 走原有三层修复（行为不变），故本机制是纯增益。
const VERBATIM_BLOCK_RE = /\[verbatim:([A-Za-z0-9_.\-]+)\][ \t]*\r?\n?([\s\S]*?)\r?\n?[ \t]*\[\/verbatim:\1\]/gi;
const VERBATIM_REF_RE = /^@@VERBATIM:([A-Za-z0-9_.\-]+)@@$/i;
// 从整段文本里抽出所有原样块 → { map:id→内容, stripped:剥掉块后的文本 }。剥掉是为了块内容（可能含 [call: / { }）
// 不干扰后续按 [call:] 切分工具调用。
function extractVerbatimBlocks(text) {
  const map = new Map();
  const stripped = String(text || '').replace(VERBATIM_BLOCK_RE, (mm, id, body) => { map.set(String(id).toLowerCase(), body); return ''; });
  return { map, stripped };
}
// 把 args 对象里「整值恰为占位符」的字符串替换成对应原样块内容（递归 walk 对象/数组）。
// id 精确匹配（大小写不敏感）；占位符找不到对应块、但全局只有一个块 → 用那个块兜底（模型编号写错的常见笔误）。
function injectVerbatim(obj, map) {
  if (!map || !map.size) return obj;
  const only = map.size === 1 ? [...map.values()][0] : null;
  const walk = (v) => {
    if (typeof v === 'string') {
      const m = VERBATIM_REF_RE.exec(v.trim());
      if (m) { const key = m[1].toLowerCase(); return map.has(key) ? map.get(key) : (only != null ? only : v); }
      return v;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = walk(v[k]); return o; }
    return v;
  };
  return walk(obj);
}

// 从模型输出里解析出全部工具调用，转成 OpenAI 规范的 tool_calls 数组（arguments 为 JSON 字符串）。
// 关键容错（深度思考 R1 常把格式写乱，勿依赖闭合标记）：只认 [call:NAME] 起始标记，不强制要求 [/call]。
// 每个调用的 args 取「本标记之后 → 下一个 [call: 标记之前」的片段（若中间出现 [/call] 就截到它为止），
// 再交 coerceJsonObject 配平顶层对象、丢弃尾随噪声。于是 [call:a]{..}[call:b]{..}（无分隔、无闭合）也能解析，
// 老的 [call:a]{..}[/call] 闭合写法照样兼容。
// 去重 + 封顶：深度思考偶尔把同一调用刷屏几十上百次（实测单条 98KB）→ 丢弃完全重复项并限量，避免灌爆上游。
const MAX_TOOL_CALLS = Math.max(1, Number(process.env.DEEPSEEK_API_MAX_CALLS) || 32);
function parseToolCalls(text) {
  const { map: vmap, stripped } = extractVerbatimBlocks(text); // 先抽走带外原样块，避免其内容干扰 [call:] 切分
  const s = String(stripped || '');
  const markerRe = /\[call\s*:\s*([^\]\n]+?)\s*\]/gi;
  const marks = [];
  let m;
  while ((m = markerRe.exec(s)) !== null) {
    const name = String(m[1] || '').trim();
    if (!name) continue;
    marks.push({ name, markStart: m.index, bodyStart: markerRe.lastIndex });
  }
  const out = [];
  const seen = new Set();
  for (let i = 0; i < marks.length; i++) {
    const name = marks[i].name;
    const stop = (i + 1 < marks.length) ? marks[i + 1].markStart : s.length;
    let seg = s.slice(marks[i].bodyStart, stop);
    const endIdx = seg.search(/\[\/call\]/i);   // 有闭合标记则截到它为止（兼容老写法）
    if (endIdx >= 0) seg = seg.slice(0, endIdx);
    seg = seg.trim().replace(/^```[a-zA-Z0-9]*\s*/, '').replace(/```\s*$/, '').trim();
    let argsObj = coerceJsonObject(seg, isCodeTool(name) || isPatchTool(name)); // 代码工具(node_repl/js/py)或补丁写文件工具(apply_patch/write/edit)走保留合法转义的 codeMode，别把 \n\t 双写打断代码/补丁
    argsObj = injectVerbatim(argsObj, vmap);                // 占位符 → 带外原样块的字面内容（大文本字段绕开 JSON 转义）
    let argsStr; try { argsStr = JSON.stringify(argsObj); } catch { argsStr = '{}'; }
    const dedupKey = name + ' ' + argsStr;
    if (seen.has(dedupKey)) continue;           // 丢弃完全重复的刷屏调用
    seen.add(dedupKey);
    out.push({ id: 'call_' + crypto.randomBytes(10).toString('hex'), type: 'function', function: { name, arguments: argsStr } });
    if (out.length >= MAX_TOOL_CALLS) break;     // 封顶，避免深度思考刷屏灌爆上游
  }
  return out;
}

// 粗略 token 估算（仅供 usage 字段占位）：CJK≈1 token/字，其余≈4 字/token
function estTokens(s) {
  const str = String(s || '');
  if (!str) return 0;
  let cjk = 0;
  for (const ch of str) {
    const cp = ch.codePointAt(0);
    if ((cp >= 0x2E80 && cp <= 0x9FFF) || (cp >= 0xF900 && cp <= 0xFAFF) || (cp >= 0x3040 && cp <= 0x30FF)) cjk++;
  }
  const other = str.length - cjk;
  return Math.max(1, Math.round(cjk + other / 4));
}

function newId() { return 'chatcmpl-' + crypto.randomBytes(12).toString('hex'); }
function nowSec() { return Math.floor(Date.now() / 1000); }

function completionResponse({ id, model, content, toolCalls, promptTokens, completionTokens }) {
  const hasCalls = Array.isArray(toolCalls) && toolCalls.length > 0;
  const message = { role: 'assistant', content: hasCalls ? (content ? String(content) : null) : String(content || '') };
  if (hasCalls) message.tool_calls = toolCalls;
  return {
    id, object: 'chat.completion', created: nowSec(), model: model || 'deepseek-chat',
    choices: [{ index: 0, message, finish_reason: hasCalls ? 'tool_calls' : 'stop', logprobs: null }],
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
  };
}

function streamChunk({ id, model, delta, finish }) {
  return {
    id, object: 'chat.completion.chunk', created: nowSec(), model: model || 'deepseek-chat',
    choices: [{ index: 0, delta: delta || {}, finish_reason: finish || null, logprobs: null }],
  };
}

function modelsList() {
  const created = nowSec();
  return { object: 'list', data: ['deepseek-chat', 'deepseek-reasoner', 'deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-search'].map((id) => ({ id, object: 'model', created, owned_by: 'deepseek-web' })) };
}

function toDaemonPayload(body, req) {
  const { system, prompt } = foldMessages(body.messages);
  const json = !!(body.response_format && body.response_format.type === 'json_object');
  // 先按「模型名」推断模式档位；若调用方显式传了 think/search/expert（非官方扩展字段）则以显式为准
  const m = modelModes(body.model);

  // 函数调用（工具）：请求带 tools 且 tool_choice !== 'none' 时，把工具定义注入 system，
  // 教网页版模型用括号标记表达调用意图；响应侧再解析回 tool_calls。toolsActive 供上层决定回复形态。
  const tools = Array.isArray(body.tools) ? body.tools.filter((t) => t && (t.function || t.type === 'function' || t.name)) : [];
  const toolsActive = tools.length > 0 && body.tool_choice !== 'none';

  const think = body.think != null ? !!body.think : m.think;
  let search = body.search != null ? !!body.search : m.search;
  // 带工具时联网搜索「默认关、可显式开」：搜索模式会把模型推向「检索并解释」而非「调用工具执行」，
  // 是导致网页版只用散文解释、不吐 [call:] 标记的元凶之一 → computer-use 等工具链默认保持关闭以保可靠。
  // 但支持按需开启：调用方显式 body.search===true，或模型名带 search/联网标记（Codex 这类无法传自定义字段的客户端用它）。
  if (toolsActive) search = (body.search === true) || modelWantsSearch(body.model);
  const expert = body.expert != null ? !!body.expert : m.expert;
  const headerConv = req.headers['x-ds-conversation'];
  const conversationId = body.conversation_id != null ? body.conversation_id : (headerConv || undefined);

  let sys = system;
  if (toolsActive) { const tp = buildToolPrompt(tools, body.tool_choice); sys = sys ? (sys + '\n\n' + tp) : tp; }

  return {
    prompt, system: sys, json, think, search, expert,
    conversationId,
    newChat: !!body.new_chat,
    timeoutMs: Number(body.timeout_ms) || undefined,
    toolsActive,
  };
}

// ——————————————————— 会话粘连（sticky）：一个上游对话 ↔ 一条网页对话线程 ———————————————————
// 背景：Codex（经 CC Switch 代理）不会传 conversation_id，默认每轮都无状态 → 网页版每轮开新对话，
//       既脏（浏览器里堆一堆对话）又丢上下文。sticky 用「首条 user 消息的指纹」自动认出「同一个上游对话」，
//       绑定守护进程的同一条网页对话线程，之后每轮只把「新增消息」增量发过去（网页侧已保留上下文）。
// 识别：key = 'codex:' + sha1(首条 user 消息文本).slice(0,16)。首条 user 消息在一轮对话里稳定不变，
//       且刻意避开易变的 system 提示（含时间戳/cwd 等），故适合当稳定标识。
// 增量：以「非 system 消息」为准计数；delta = 已发条数之后的新消息，丢弃 assistant（网页侧自己的回复已在线程里），
//       保留 user 与 tool 结果（按工具名标注）。复用轮守护进程会跳过 system，故把工具提示词重新并入增量正文。
// 偏移/改写检测：若新请求「已发前缀」的指纹与上次不符（历史被编辑）、或条数变短、或指纹表被清（shim 重启）→
//       判为「偏移」，整段重发一次并开新网页对话（newChat）重新绑定。
const STICKY_MAP = new Map(); // key → { sentCount, sig, boundAt, lastUsed }

function sha1hex(s) { return crypto.createHash('sha1').update(String(s), 'utf8').digest('hex'); }

// 非 system 消息序列（sticky 的计数/指纹/增量都以它为准，规避 system 易变位）
function bodyMessages(messages) {
  return (Array.isArray(messages) ? messages : []).filter((m) => m && m.role !== 'system');
}

// 首条 user 消息文本（sticky key 之源）
function firstUserContent(messages) {
  for (const m of (Array.isArray(messages) ? messages : [])) {
    if (m && m.role === 'user') { const t = normContent(m.content); if (t) return t; }
  }
  return '';
}

// 一段消息序列的指纹（用于「已发前缀」比对，检测历史被改写）
function msgSig(msgs) {
  const parts = (Array.isArray(msgs) ? msgs : []).map((m) => {
    const role = (m && m.role) || '';
    const txt = normContent(m && m.content);
    const tc = (m && Array.isArray(m.tool_calls) && m.tool_calls.length) ? renderToolCalls(m.tool_calls) : '';
    const tid = (m && m.tool_call_id) || '';
    return role + '' + txt + '' + tc + '' + tid;
  });
  return sha1hex(parts.join(''));
}

// 只折叠「增量」消息为 prompt：用全量消息建 id→工具名 映射（增量里的 tool 结果可能引用更早的 assistant.tool_calls），
// 但只渲染 startIdx 起的非 system 消息，且丢弃 assistant（网页对话线程里已有它自己的回复）。
function foldDelta(bodyMsgs, startIdx, allMessages) {
  const idName = {};
  for (const m of (Array.isArray(allMessages) ? allMessages : [])) {
    if (m && m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) { if (tc && tc.id) idName[tc.id] = (tc.function && tc.function.name) || ''; }
    }
  }
  const convo = [];
  for (let i = Math.max(0, startIdx); i < bodyMsgs.length; i++) {
    const m = bodyMsgs[i];
    if (!m || typeof m !== 'object') continue;
    const role = m.role || 'user';
    if (role === 'assistant') continue; // 丢弃：网页对话线程里已有它自己的回复
    if (role === 'tool') {
      const t = normContent(m.content); if (!t && t !== '') continue;
      const nm = (m.tool_call_id && idName[m.tool_call_id]) ? idName[m.tool_call_id] : (m.name || '');
      convo.push({ tag: 'tool', text: nm ? `[${nm}] ${t}` : t });
      continue;
    }
    const t = normContent(m.content); if (!t) continue;
    convo.push({ tag: 'user', text: t });
  }
  if (!convo.length) return '';
  if (convo.length === 1 && convo[0].tag === 'user') return convo[0].text;
  return convo.map((c) => (c.tag === 'tool' ? 'Tool: ' : 'User: ') + c.text).join('\n\n');
}

function stickyEvict() {
  const now = Date.now();
  for (const [k, v] of STICKY_MAP) { if (now - (v.lastUsed || 0) > STICKY_TTL_MS) STICKY_MAP.delete(k); }
  if (STICKY_MAP.size > STICKY_MAX) {
    const arr = [...STICKY_MAP.entries()].sort((a, b) => (a[1].lastUsed || 0) - (b[1].lastUsed || 0));
    for (let i = 0, drop = STICKY_MAP.size - STICKY_MAX; i < drop; i++) STICKY_MAP.delete(arr[i][0]);
  }
}

function commitSticky(sticky) {
  if (!sticky || !sticky.key) return;
  const prev = STICKY_MAP.get(sticky.key);
  STICKY_MAP.set(sticky.key, { sentCount: sticky.sentCount, sig: sticky.sig, boundAt: (prev && prev.boundAt) || Date.now(), lastUsed: Date.now() });
}

// 在 toDaemonPayload 基础上叠加 sticky 决策：返回 { payload, sticky }。
// sticky 为 null 表示本轮不参与粘连（显式 conversation_id / 关闭 sticky / 无 user 消息）；
// 否则 sticky = { key, sentCount, sig }，待本轮成功后 commitSticky 落库推进「已发条数」。
function buildPayload(body, req) {
  const base = toDaemonPayload(body, req);
  // 显式 conversation_id / X-DS-Conversation → 调用方自管复用，sticky 不介入
  const headerConv = req.headers['x-ds-conversation'];
  const explicitConv = body.conversation_id != null || (headerConv != null && headerConv !== '');
  if (!STICKY || explicitConv) return { payload: finalizePayload(base, body.messages), sticky: null };

  const firstUser = firstUserContent(body.messages);
  if (!firstUser) return { payload: finalizePayload(base, body.messages), sticky: null }; // 无 user 消息 → 退回无状态

  const bodyMsgs = bodyMessages(body.messages);
  const key = 'codex:' + sha1hex(firstUser).slice(0, 16);
  stickyEvict();
  const entry = STICKY_MAP.get(key);
  const commit = { key, sentCount: bodyMsgs.length, sig: msgSig(bodyMsgs) };

  // 「延续」判定：已有绑定 + 未显式 new_chat + 新请求更长 + 已发前缀指纹一致
  const isContinuation = !!(entry && !body.new_chat && bodyMsgs.length > entry.sentCount
    && msgSig(bodyMsgs.slice(0, entry.sentCount)) === entry.sig);

  if (isContinuation) {
    let deltaPrompt = foldDelta(bodyMsgs, entry.sentCount, body.messages);
    if (deltaPrompt) {
      if (base.toolsActive) {
        const tools = Array.isArray(body.tools) ? body.tools.filter((t) => t && (t.function || t.type === 'function' || t.name)) : [];
        deltaPrompt = buildToolPrompt(tools, body.tool_choice) + '\n\n' + deltaPrompt; // 复用轮守护进程会跳过 system → 工具提示并入增量正文
      }
      const payload = Object.assign({}, base, { prompt: deltaPrompt, system: '', conversationId: key, newChat: false });
      return { payload: finalizePayload(payload, bodyMsgs.slice(entry.sentCount)), sticky: commit }; // 复用轮只上传增量里的新截图，不重发历史图
    }
    // 增量折不出正文（极少见）→ 落到下面整段重发
  }

  // 未命中 / 偏移 / 显式 new_chat / 空增量 → 整段重发 + 开新网页对话 + 重新绑定
  return { payload: finalizePayload(Object.assign({}, base, { conversationId: key, newChat: true }), bodyMsgs), sticky: commit };
}

// ——————————————————— 调用守护进程 ———————————————————
function daemonJSON(method, path, body, { timeoutMs, signal } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(path, DAEMON);
    const data = body != null ? JSON.stringify(body) : null;
    const headers = {};
    if (data) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(data); }
    if (DAEMON_TOKEN) headers['authorization'] = 'Bearer ' + DAEMON_TOKEN;
    const r = http.request(
      // signal：客户端（如 Codex 点停止）断开时上层 abort → Node 立即销毁这条到守护进程的请求并触发 error，释放串行闸门
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers, timeout: timeoutMs || 0, signal },
      (resp) => {
        let buf = ''; resp.on('data', (c) => (buf += c));
        resp.on('end', () => {
          let j; try { j = JSON.parse(buf || '{}'); } catch { j = { error: '守护进程返回非 JSON', raw: buf }; }
          if (resp.statusCode >= 200 && resp.statusCode < 300) resolve(j);
          else reject(Object.assign(new Error((j && j.error) || ('HTTP ' + resp.statusCode)), { statusCode: resp.statusCode }));
        });
      }
    );
    r.on('timeout', () => r.destroy(new Error('请求 DeepSeek 守护进程超时')));
    r.on('error', (e) => {
      if (e && /ECONNREFUSED/i.test(String(e.code || e.message))) {
        reject(new Error('连不上 DeepSeek 守护进程（' + DAEMON + '）：请先在其目录 npm start 启动。'));
      } else reject(e);
    });
    if (data) r.write(data);
    r.end();
  });
}

// 转发守护进程 /chat/stream 的 SSE：逐段回调 onDelta(片段)；结束 onFinish(meta)；出错 onError(err)
function daemonStream(payload, { onDelta, onFinish, onError, signal } = {}) {
  const u = new URL('/chat/stream', DAEMON);
  const data = JSON.stringify(payload);
  const headers = { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), accept: 'text/event-stream' };
  if (DAEMON_TOKEN) headers['authorization'] = 'Bearer ' + DAEMON_TOKEN;
  let settled = false;
  const finish = (meta) => { if (settled) return; settled = true; if (typeof onFinish === 'function') onFinish(meta); };
  const fail = (err) => { if (settled) return; settled = true; if (typeof onError === 'function') onError(err); };
  // signal：客户端断开时上层 abort → 销毁这条到守护进程的流式请求并触发 error → fail() → 上层释放串行闸门
  const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers, timeout: 0, signal }, (resp) => {
    if (resp.statusCode !== 200) {
      let buf = ''; resp.on('data', (c) => (buf += c));
      resp.on('end', () => { let j = null; try { j = JSON.parse(buf); } catch { /* ignore */ } fail(Object.assign(new Error((j && j.error) || ('守护进程 HTTP ' + resp.statusCode)), { statusCode: resp.statusCode })); });
      return;
    }
    resp.setEncoding('utf8');
    let buf = '';
    resp.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const rawEvent = buf.slice(0, idx); buf = buf.slice(idx + 2);
        const line = rawEvent.split(/\r?\n/).find((l) => l.startsWith('data:'));
        if (!line) continue;
        const payloadStr = line.slice(5).trim();
        if (!payloadStr || payloadStr === '[DONE]') continue;
        let evt; try { evt = JSON.parse(payloadStr); } catch { continue; }
        if (evt.error) { fail(new Error(evt.error)); continue; }
        if (evt.delta != null) { if (typeof onDelta === 'function') onDelta(String(evt.delta)); continue; }
        if (evt.done) { finish(evt); continue; }
      }
    });
    resp.on('end', () => finish(null)); // 兜底：正常应已在 done 事件里 finish
    resp.on('error', fail);
  });
  r.on('timeout', () => r.destroy(new Error('守护进程流式超时')));
  r.on('error', (e) => {
    if (e && /ECONNREFUSED/i.test(String(e.code || e.message))) fail(new Error('连不上 DeepSeek 守护进程（' + DAEMON + '）：请先在其目录 npm start 启动。'));
    else fail(e);
  });
  r.write(data); r.end();
  return r;
}

// ——————————————————— 串行闸门（会话级排队）———————————————————
// 网页版守护进程「一次只能一条对话」（内部 _busy 命中即硬抛「会话忙」）。真实病灶：Codex 等上游会在一条
// 请求还在跑时并发/指数退避重试，多条同时撞上 _busy → 报「stream disconnected before completion:
// DeepSeek 网页会话忙（一次只能一条）」。这里在 shim 侧做「串行队列」：把「真正驱动网页出结果」的调用串起来，
// 后来者排队等前一条结束，而不是直接撞 _busy 被拒；设最长等待与队列上限，超限才友好拒绝（429）。纯新增，
// 只包住 /chat 与 /chat/stream 两处；health 等其它守护进程调用不受影响。
const CHAT_MAX_WAIT_MS = Math.max(0, Number(process.env.DEEPSEEK_API_QUEUE_WAIT_MS) || 180000); // 排队最长等待（0=不限时，一直等）
const CHAT_QUEUE_MAX = Math.max(1, Number(process.env.DEEPSEEK_API_QUEUE_MAX) || 24);           // 等待队列最多堆多少个
let chatBusy = false;
const chatWaiters = [];
function pumpChatQueue() {
  if (chatBusy) return;
  const w = chatWaiters.shift();
  if (!w) return;
  if (w.timer) { clearTimeout(w.timer); w.timer = null; }
  chatBusy = true;
  Promise.resolve().then(() => w.fn()).then((v) => w.resolve(v), (e) => w.reject(e))
    .finally(() => { chatBusy = false; pumpChatQueue(); });
}
// 在串行闸门内执行 fn（返回 Promise）：前面有请求在跑就排队；排队超上限/超时 → 抛「会话忙」（上层转 429）。
function runExclusive(fn) {
  return new Promise((resolve, reject) => {
    if (chatWaiters.length >= CHAT_QUEUE_MAX) {
      return reject(Object.assign(new Error('DeepSeek 网页会话忙（排队已满），请稍后重试'), { statusCode: 429, busy: true }));
    }
    const w = { fn, resolve, reject, timer: null };
    if (CHAT_MAX_WAIT_MS > 0) {
      w.timer = setTimeout(() => {
        const i = chatWaiters.indexOf(w);
        if (i >= 0) { chatWaiters.splice(i, 1); reject(Object.assign(new Error('DeepSeek 网页会话忙（排队等待超时），请稍后重试'), { statusCode: 429, busy: true })); }
      }, CHAT_MAX_WAIT_MS);
    }
    chatWaiters.push(w);
    pumpChatQueue();
  });
}

// ——————————————————— HTTP 服务 ———————————————————
const server = http.createServer(async (req, res) => {
  const t0 = Date.now();
  let url; try { url = new URL(req.url, `http://${req.headers.host || HOST}`); } catch { return sendErr(res, 400, '无效请求 URL'); }
  const route = `${req.method} ${url.pathname}`;
  const log = (code) => console.log(`[${new Date().toISOString()}] ${route} → ${code} ${Date.now() - t0}ms`);

  // CORS / CSRF：默认拒绝带 Origin 的请求；配置 ALLOW_ORIGIN 才放行并回 CORS 头
  const origin = req.headers['origin'];
  if (origin) {
    if (!ALLOW_ORIGIN || (ALLOW_ORIGIN !== '*' && origin !== ALLOW_ORIGIN)) { sendErr(res, 403, '拒绝跨域请求（设置 DEEPSEEK_API_ALLOW_ORIGIN 放行）', 'forbidden'); return log(403); }
    res.setHeader('access-control-allow-origin', ALLOW_ORIGIN === '*' ? '*' : origin);
    res.setHeader('access-control-allow-headers', 'authorization, content-type, x-ds-conversation');
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  }
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return log(204); }

  try {
    if (route === 'GET /health') { send(res, 200, { ok: true, ts: Date.now(), daemon: DAEMON }); return log(200); }

    if (!apiAuthed(req)) { sendErr(res, 401, '未授权：需要 Authorization: Bearer <DEEPSEEK_API_KEY>', 'invalid_request_error'); return log(401); }

    if (route === 'GET /v1/models' || route === 'GET /models') { send(res, 200, modelsList()); return log(200); }

    if (route === 'POST /v1/chat/completions' || route === 'POST /chat/completions') {
      const body = await readBody(req);
      if (!body || !Array.isArray(body.messages) || !body.messages.length) { sendErr(res, 400, 'messages 不能为空', 'invalid_request_error'); return log(400); }
      const model = body.model || 'deepseek-chat';
      const { payload, sticky } = buildPayload(body, req);
      if (!payload.prompt && !payload.system) { sendErr(res, 400, 'messages 内没有可用文本', 'invalid_request_error'); return log(400); }
      const promptTokens = estTokens((payload.system || '') + '\n' + (payload.prompt || ''));

      const toolsActive = !!payload.toolsActive;

      // 客户端断开（如 Codex 点「停止」）联动中止：一旦「shim↔客户端」这段连接在我们 res.end() 之前被关闭，
      // 就 abort 掉「shim↔守护进程」那条在跑的 HTTP 请求 → daemonJSON/daemonStream 立即失败 → 释放串行闸门，
      // 不再干等到守护进程返回/超时（否则那条被放弃的请求会一直占着锁，后来的新请求只能排队甚至等满 180s）。
      // 局限（纯新增不改守护进程）：这只中止「shim→守护进程」的等待与占锁；守护进程那侧的网页生成本轮仍会自然
      // 跑完（无中止接口），故紧随其后的下一条请求可能短暂遇到守护进程「会话忙」，待该轮跑完即自动恢复。
      const ac = new AbortController();
      let clientGone = false;
      res.on('close', () => {
        if (clientGone || res.writableEnded) return; // 正常 res.end() 后也会触发 close；只在「未收尾即断开」时中止
        clientGone = true;
        try { ac.abort(); } catch { /* ignore */ }
        console.log(`  client-disconnect: abort in-flight daemon request (${route})`);
      });

      // 无工具的流式：真·逐字路径。经串行闸门排队（避免并发撞守护进程 _busy「会话忙」）。
      // 关键：writeHead 推迟到「抢到闸门、真要开跑」时再发 → 排队满/超时被拒时还能回一个干净的 429。
      if (body.stream && !toolsActive) {
        const id = newId();
        let headed = false;
        const sse = (obj) => { try { res.write('data: ' + JSON.stringify(obj) + '\n\n'); } catch { /* 客户端已断开 */ } };
        try {
          await runExclusive(() => new Promise((resolve) => {
            if (clientGone) { try { res.end(); } catch { /* ignore */ } log(499); return resolve(); } // 排队期间客户端已断开 → 不触发守护进程，直接释放闸门
            headed = true;
            res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
            sse(streamChunk({ id, model, delta: { role: 'assistant' } })); // 首块：角色
            daemonStream(payload, {
              signal: ac.signal,
              onDelta: (d) => sse(streamChunk({ id, model, delta: { content: d } })),
              onFinish: () => { commitSticky(sticky); sse(streamChunk({ id, model, delta: {}, finish: 'stop' })); try { res.write('data: [DONE]\n\n'); } catch { /* ignore */ } res.end(); log(200); resolve(); },
              onError: (err) => {
                if (clientGone) { try { res.end(); } catch { /* ignore */ } log(499); return resolve(); } // 客户端已断开：静默收尾，闸门已随 abort 释放
                const msg = String((err && err.message) || err);
                sse({ error: { message: msg, type: /忙|busy/i.test(msg) ? 'rate_limit_error' : 'api_error', param: null, code: null } });
                try { res.write('data: [DONE]\n\n'); } catch { /* ignore */ } res.end(); log(200); resolve();
              },
            });
          }));
        } catch (err) {
          // 排队满/超时被拒（此时通常尚未 writeHead）→ 干净 429；万一已开跑则用 SSE error 收尾
          const msg = String((err && err.message) || err);
          if (!headed) { sendErr(res, 429, msg, 'rate_limit_error'); return log(429); }
          sse({ error: { message: msg, type: /忙|busy/i.test(msg) ? 'rate_limit_error' : 'api_error', param: null, code: null } });
          try { res.write('data: [DONE]\n\n'); } catch { /* ignore */ } res.end(); return log(200);
        }
        return; // 交给回调收尾
      }

      // 其余情况（非流式，或「流式 + 工具」）：先向守护进程一次性取完整文本，再决定回复形态。
      // 「流式 + 工具」必须先缓冲：只有拿到完整输出才能判定这轮到底是普通回答还是工具调用，
      // 否则一旦已经把正文逐字推给客户端、末尾却发现其实是 tool_calls，就来不及收回了。
      let out;
      try {
        out = await runExclusive(() => {
          if (clientGone) return Promise.reject(Object.assign(new Error('客户端已断开'), { aborted: true })); // 排队期间客户端已断开 → 不触发守护进程
          return daemonJSON('POST', '/chat', payload, { timeoutMs: (payload.timeoutMs || (payload.think ? 600000 : 240000)) + 30000, signal: ac.signal });
        });
      } catch (err) {
        if (clientGone || (err && err.aborted)) { try { res.end(); } catch { /* ignore */ } return log(499); } // 客户端已断开：静默收尾，闸门已随 abort 释放
        const msg = String((err && err.message) || err);
        if (body.stream) {
          const id = newId();
          res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
          try { res.write('data: ' + JSON.stringify({ error: { message: msg, type: /忙|busy/i.test(msg) ? 'rate_limit_error' : 'api_error', param: null, code: null } }) + '\n\n'); res.write('data: [DONE]\n\n'); } catch { /* ignore */ }
          res.end(); return log(200);
        }
        if (/忙|busy/i.test(msg)) { sendErr(res, 429, msg, 'rate_limit_error'); return log(429); }
        sendErr(res, 502, msg, 'api_error'); return log(502);
      }

      // sticky 落库推进「已发条数」。安全网：本轮本想复用（newChat=false）但守护进程报 reused=false
      // （说明它那侧丢了线程、把增量当新对话了 → 上下文不全）→ 删除绑定，让下一轮整段重发重新绑定。
      if (sticky) {
        if (payload.newChat === false && out && out.reused === false) STICKY_MAP.delete(sticky.key);
        else commitSticky(sticky);
      }

      const rawText = (out && out.text) || '';
      if (out && out.modes) console.log(`  modes: ${JSON.stringify(out.modes)} (model=${model})`);
      const toolCalls = toolsActive ? parseToolCalls(rawText) : [];
      // 有工具调用时丢弃前置正文（网页版可能带一段思考/铺垫），让 tool_calls 这轮回复保持干净
      const content = toolCalls.length ? null : rawText;
      const completionTokens = estTokens(rawText);
      if (toolsActive) console.log(`  tools: ${toolCalls.length} call(s) parsed (model=${model})`);
      // 调试落盘（仅 DS_SHIM_DEBUG=1 时）：抓 Codex 实际下发的 tools + 注入后的提示词 + DeepSeek 原始输出，便于排查「解析不到工具调用」
      if (toolsActive && process.env.DS_SHIM_DEBUG === '1') {
        try {
          const rawTools = Array.isArray(body.tools) ? body.tools : [];
          const toolNames = rawTools.map((t) => (t && t.function && t.function.name) || (t && t.name) || (t && t.type) || '?');
          // 识图探针：记录每条消息 content 的形态 + 抽到几张图，用于确认截图究竟以什么形态到达（image_url part / 文本内联 / 根本没来）
          const imgProbe = (Array.isArray(body.messages) ? body.messages : []).map((mm, i) => {
            const c = mm && mm.content;
            let shape;
            if (typeof c === 'string') shape = 'str' + (/data:image\//.test(c) ? '+dataurl' : '');
            else if (Array.isArray(c)) shape = '[' + c.map((p) => (p && p.type) || (typeof p === 'string' ? 'str' : typeof p)).join(',') + ']';
            else if (c == null) shape = 'null';
            else shape = typeof c;
            const n = extractImages(c).length;
            return n ? { i, role: mm && mm.role, shape, imgs: n } : { i, role: mm && mm.role, shape };
          });
          const rec = { ts: new Date().toISOString(), model, stream: !!body.stream, tool_choice: body.tool_choice, tool_count: toolNames.length, tool_names: toolNames, system: payload.system, prompt: payload.prompt, raw_text: rawText, parsed_calls: toolCalls.length, images_attached: (payload.images || []).length, img_probe: imgProbe };
          fs.appendFileSync(path.join(__dirname, '.shim-debug.log'), JSON.stringify(rec) + '\n');
        } catch { /* ignore */ }
      }

      if (body.stream) {
        const id = newId();
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
        const sse = (obj) => { try { res.write('data: ' + JSON.stringify(obj) + '\n\n'); } catch { /* 客户端已断开 */ } };
        sse(streamChunk({ id, model, delta: { role: 'assistant' } }));
        if (toolCalls.length) {
          toolCalls.forEach((tc, i) => sse(streamChunk({ id, model, delta: { tool_calls: [{ index: i, id: tc.id, type: 'function', function: { name: tc.function.name, arguments: tc.function.arguments } }] } })));
          sse(streamChunk({ id, model, delta: {}, finish: 'tool_calls' }));
        } else {
          if (content) sse(streamChunk({ id, model, delta: { content } }));
          sse(streamChunk({ id, model, delta: {}, finish: 'stop' }));
        }
        try { res.write('data: [DONE]\n\n'); } catch { /* ignore */ }
        res.end(); return log(200);
      }

      // 非流式
      send(res, 200, completionResponse({ id: newId(), model, content, toolCalls, promptTokens, completionTokens }));
      return log(200);
    }

    sendErr(res, 404, '未知路由：' + route, 'invalid_request_error'); log(404);
  } catch (e) {
    sendErr(res, 500, String((e && e.message) || e), 'api_error'); log(500);
  }
});

// 生成可能长达数分钟（深度思考更久）：关掉会截断长请求的超时
server.requestTimeout = 0;
server.headersTimeout = 60000;
server.timeout = 0;

// 仅在「直接 node api-shim.js 运行」时监听端口；被 require（如单测）时不绑定端口、只导出纯函数
if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`DeepSeek OpenAI 兼容 API 已启动 → http://${HOST}:${PORT}`);
    console.log(`  转发到守护进程: ${DAEMON}`);
    console.log(`  鉴权: ${OWN_KEY ? '开（需 Bearer DEEPSEEK_API_KEY）' : '关（本机自用，任意 key 放行）'}`);
    console.log(`  跨域: ${ALLOW_ORIGIN ? ('允许 ' + ALLOW_ORIGIN) : '拒绝带 Origin 的请求（CSRF 防护）'}`);
    console.log(`  端点: POST /v1/chat/completions · GET /v1/models · GET /health`);
  });
}

// 供单测使用（不影响生产：生产是直接运行本文件，走上面的 listen 分支）
module.exports = {
  normContent, foldMessages, renderToolCalls, modelModes, modelWantsSearch,
  buildToolPrompt, coerceJsonObject, extractRepairedObject, sliceTopObject, isCodeTool, isPatchTool, parseToolCalls,
  extractVerbatimBlocks, injectVerbatim,
  toDaemonPayload, completionResponse, streamChunk, modelsList, estTokens,
  // 识图（vision）
  extractImages, collectImages, dumpImages, stripDataUrls, extForMime, finalizePayload,
  // sticky（会话粘连）
  buildPayload, commitSticky, foldDelta, msgSig, firstUserContent, bodyMessages, sha1hex,
  STICKY_MAP,
};
