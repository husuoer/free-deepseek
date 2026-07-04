'use strict';
// DeepSeek 网页驱动（独立守护进程内核）。
// 思路（封号风险最低）：用 Playwright 驱动一个「已登录」的真实 Chrome 页面，
// 让 chat.deepseek.com 自己的 JS 去算反爬工作量证明（X-Ds-Pow-Response），
// 我们只做三件事：切网页版模式（深度思考/联网搜索/专家/识图）→ 填 prompt（或传图）→ 读回复。
// 不复刻任何 HTTP、不碰 PoW。
//
// 设计：这是「独占浏览器 + 共享 profile」的单一持有者——
// 本机所有项目都通过守护进程的 HTTP 接口调它，故登录一次全机复用，且不会有 Chrome profile 争锁问题。
//
// ⚠️ 选择器集中在 CONFIG.sel / CONFIG.modes，网站改版或首次实登调优只改这一处。

const path = require('path');
const fs = require('fs');

// 诊断开关（默认关，不影响生产）：DS_DRIVER_DEBUG=1 时把「同一轮 DOM 抓取 vs SSE 原文」的取文对比追加到日志，
// 用来核实「改用 SSE 无损源」是否忠实、是否泄漏思维链。仅在设了环境变量时写文件，平时零开销。
const DBG = /^(1|true|yes)$/i.test(process.env.DS_DRIVER_DEBUG || '');
const DBG_FILE = path.join(__dirname, '.driver-debug.log');
function dbgDump(obj) { try { fs.appendFileSync(DBG_FILE, JSON.stringify({ ts: new Date().toISOString(), ...obj }) + '\n'); } catch { /* ignore */ } }

// —— 真终止（客户端断开即停生成）——
// 调用方（server.js）在客户端断开时 abort 一个 AbortSignal；驱动据此立即结束等待、并 best-effort 停掉网页生成。
class AbortError extends Error { constructor(m) { super(m || '已终止（客户端断开）'); this.name = 'AbortError'; this.isAbort = true; } }
function isAbortErr(e) { return !!(e && (e.isAbort || e.name === 'AbortError')); }
// 把 AbortSignal 变成「一旦 abort 就 reject」的 Promise，用于和「等生成完成」竞速；cancel() 摘掉监听避免竞速已决后的悬空 reject。
function makeAbortRace(signal) {
  let cancel = () => {};
  const promise = new Promise((_resolve, reject) => {
    if (!signal) return;                          // 无 signal：永不 reject（等价旧行为）
    if (signal.aborted) return reject(new AbortError());
    const on = () => reject(new AbortError());
    signal.addEventListener('abort', on, { once: true });
    cancel = () => { try { signal.removeEventListener('abort', on); } catch { /* ignore */ } };
  });
  return { promise, cancel };
}

const CONFIG = {
  homeUrl: 'https://chat.deepseek.com/',
  // 共享 profile：默认落在服务目录下的 profile/，可用 DEEPSEEK_PROFILE_DIR 覆盖到别处（例如放到一个全机共享位置）
  profileDir: process.env.DEEPSEEK_PROFILE_DIR || path.join(__dirname, 'profile'),
  headless: /^(1|true|yes)$/i.test(process.env.DEEPSEEK_HEADLESS || ''),
  sel: {
    // 输入框 / 发送按钮 / 文件上传 / 消息容器候选（按顺序试，网站改版在此加即可）
    composer: ['textarea#chat-input', 'textarea[placeholder]', 'div[contenteditable="true"]'],
    sendBtn: ['div[role="button"][aria-disabled]', 'button[type="submit"]'],
    fileInput: ['input[type="file"]'],
    messageContainers: ['div[class*="ds-markdown"]', 'div[class*="markdown"]'],
    loginHint: ['text=登录', 'text=Log in', 'input[type="password"]'],
    // 完成信号：命中对话完成接口的响应即代表「生成完毕」
    completionUrl: /completion|chat\/completion|\/chat\//i,
    // 生成中的「停止」按钮（真终止用，best-effort）：按可访问性标签匹配较稳；找不到就靠下次导航兜底。
    stopBtn: ['div[role="button"][aria-label*="停止"]', 'button[aria-label*="停止"]', 'div[role="button"][aria-label*="Stop"]', 'button[aria-label*="Stop"]'],
  },
  // 四模式：网页版可切换的按钮 / 文件上传。全部 best-effort：找不到就跳过、绝不因此中断发送。
  //  think  深度思考(R1)  ·  search 智能搜索  ·  expert 专家模式  ·  识图=传 images 走文件上传
  // 真实 DOM（2026-07 实登确认）：
  //  · 深度思考/智能搜索：外层 <div class="… ds-toggle-button …" aria-pressed="true|false">，是独立开关(toggle)。
  //    选择器必须锁定外层 toggle，否则会命中内层无 aria-pressed 的 <span class="_6dbc175">、状态读不出而盲点误关。
  //  · 专家模式：属于「模型类型」单选组 <div role="radiogroup">，三个 <div data-model-type="default|expert|vision"
  //    role="radio" aria-checked="true|false">（快速模式/专家模式/识图）。单选互斥——开专家=选 expert 那项，
  //    关专家=改选 default(快速) 那项，不能像 toggle 那样反点自身。故 kind='radio' + offSelectors 指向「快速」。
  modes: {
    think:  { kind: 'toggle', label: '深度思考', selectors: ['.ds-toggle-button:has-text("深度思考")', 'div[aria-pressed]:has-text("深度思考")'] },
    search: { kind: 'toggle', label: '智能搜索', selectors: ['.ds-toggle-button:has-text("智能搜索")', 'div[aria-pressed]:has-text("智能搜索")', '.ds-toggle-button:has-text("联网搜索")'] },
    expert: { kind: 'radio',  label: '专家模式', selectors: ['div[data-model-type="expert"]', 'div[role="radio"]:has-text("专家模式")'], offSelectors: ['div[data-model-type="default"]', 'div[role="radio"]:has-text("快速模式")'] },
  },
};

const LOGIN_MARKER = path.join(CONFIG.profileDir, '.ds-logged-in');

let _pw = null;      // playwright 模块（懒加载）
let _ctx = null;     // 持久化浏览器上下文（跨调用复用）
let _busy = false;   // 串行互斥（一次一条，更像真人、也避免同页并发）

// —— 会话（对话线程）复用 ——
// 一个「世界」应始终复用同一个 DeepSeek 对话，上下文才连续。
// 调用方传 conversationId（如 'world:8'）→ 守护进程把它映射到 DeepSeek 的对话 URL，
// 后续同 id 的调用导航回该 URL、在同一对话里追问；传 newChat:true 强制开新对话并重绑该 id。
// 不传 conversationId → 每次开新对话（无状态，等价 API 语义）。
// 映射持久化到 profile 下 conversations.json，守护进程重启后仍复用同一对话（仅存 URL/计数，无密钥）。
const CONV = new Map();
const CONV_FILE = path.join(CONFIG.profileDir, 'conversations.json');
function loadConv() {
  try { const j = JSON.parse(fs.readFileSync(CONV_FILE, 'utf8')); for (const k of Object.keys(j)) CONV.set(k, j[k]); } catch { /* 无则忽略 */ }
}
function saveConv() {
  try {
    if (!fs.existsSync(CONFIG.profileDir)) fs.mkdirSync(CONFIG.profileDir, { recursive: true });
    const o = {}; for (const [k, v] of CONV) o[k] = v;
    fs.writeFileSync(CONV_FILE, JSON.stringify(o, null, 2));
  } catch { /* ignore */ }
}
loadConv();

// 判断一个 URL 是否是「具体对话」而非首页（首页 path 为 '/'，对话带较长的 id 段）
function isConversationUrl(u) {
  try { const url = new URL(u); return !!url.pathname && url.pathname !== '/' && /[a-z0-9-]{6,}/i.test(url.pathname); }
  catch { return false; }
}
function resetConversation(conversationId) {
  const k = String(conversationId == null ? '' : conversationId);
  const had = CONV.delete(k);
  if (had) saveConv();
  return { ok: true, removed: had };
}
function listConversations() {
  const out = [];
  for (const [k, v] of CONV) out.push({ conversationId: k, url: v.url, turns: v.turns || 0, boundAt: v.boundAt, lastUsed: v.lastUsed });
  return out;
}

function loadPlaywright() {
  if (_pw) return _pw;
  try { _pw = require('playwright'); }
  catch { throw new Error('未安装 playwright，运行：npm i playwright（并确保本机已装 Chrome）'); }
  return _pw;
}

function markLoggedIn(v) {
  try {
    if (v) { if (!fs.existsSync(CONFIG.profileDir)) fs.mkdirSync(CONFIG.profileDir, { recursive: true }); fs.writeFileSync(LOGIN_MARKER, String(Date.now())); }
    else if (fs.existsSync(LOGIN_MARKER)) fs.unlinkSync(LOGIN_MARKER);
  } catch { /* ignore */ }
}
function hasLoginMarker() { try { return fs.existsSync(LOGIN_MARKER); } catch { return false; } }

// —— 只读状态：廉价、不启动浏览器 ——
function status() {
  let installed = true;
  try { require.resolve('playwright'); } catch { installed = false; }
  const loggedIn = hasLoginMarker(); // 只在确认登录成功时才有；chat/login 会按真实检测自愈
  return {
    installed,
    logged_in: loggedIn,
    alive: !!_ctx,
    headless: CONFIG.headless,
    profile_dir: CONFIG.profileDir,
    conversations: CONV.size,
    modes_supported: ['think', 'search', 'expert', 'vision'],
    note: installed
      ? (loggedIn ? '已登录，凭据保存在本地共享 profile，可直接使用' : '尚未登录：先调 POST /login，在弹出的 Chrome 里登录一次')
      : '未安装 playwright，在服务目录运行：npm i playwright',
  };
}

async function ensureContext({ headless } = {}) {
  if (_ctx) return _ctx;
  const pw = loadPlaywright();
  if (!fs.existsSync(CONFIG.profileDir)) fs.mkdirSync(CONFIG.profileDir, { recursive: true });
  const opts = {
    headless: headless === undefined ? CONFIG.headless : headless,
    viewport: { width: 1280, height: 900 },
  };
  try {
    // 优先系统 Chrome（真实指纹、免下载大 Chromium）
    _ctx = await pw.chromium.launchPersistentContext(CONFIG.profileDir, { ...opts, channel: 'chrome' });
  } catch {
    _ctx = await pw.chromium.launchPersistentContext(CONFIG.profileDir, opts); // 回落自带 chromium
  }
  _ctx.on('close', () => { _ctx = null; });
  return _ctx;
}

async function getPage() {
  const ctx = await ensureContext();
  const pages = ctx.pages();
  return pages.length ? pages[0] : await ctx.newPage();
}

async function firstVisible(page, selectors, timeout) {
  const per = Math.max(800, Math.floor((timeout || 6000) / selectors.length));
  for (const s of selectors) {
    try {
      const loc = page.locator(s).first();
      await loc.waitFor({ state: 'visible', timeout: per });
      return loc;
    } catch { /* 试下一个 */ }
  }
  return null;
}

// 能找到输入框即视为已登录
async function detectLoggedIn(page) {
  const box = await firstVisible(page, CONFIG.sel.composer, 6000);
  return !!box;
}

// best-effort 终止网页版正在进行的生成：先点「停止」按钮，兜底按 Escape。绝不抛错。
// 注：即便这里一个都没点到，下一次调用的 ensureLoggedIn 会 page.goto 目标页、天然中断遗留的生成流——
// 所以「及时释放 _busy」才是根本（避免下一条命中「会话忙」），主动停止是锦上添花（省 DeepSeek 端额度、页面更干净）。
async function stopGeneration(page) {
  if (!page) return false;
  for (const sel of (CONFIG.sel.stopBtn || [])) {
    try {
      const loc = page.locator(sel).first();
      if ((await loc.count()) && (await loc.isVisible())) { await loc.click({ timeout: 1500 }); return true; }
    } catch { /* 试下一个 */ }
  }
  try { await page.keyboard.press('Escape'); } catch { /* ignore */ }
  return false;
}

// 打开有头浏览器让用户手动登录一次；轮询直到检测到已登录或超时
async function login({ timeoutMs = 300000 } = {}) {
  if (_ctx && CONFIG.headless) { try { await _ctx.close(); } catch { /* ignore */ } _ctx = null; }
  await ensureContext({ headless: false }); // 登录必须有头
  const page = await getPage();
  await page.goto(CONFIG.homeUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await detectLoggedIn(page)) { markLoggedIn(true); return { ok: true, logged_in: true }; }
    await page.waitForTimeout(1500);
  }
  return { ok: false, logged_in: false, error: '登录等待超时（未检测到输入框）。请确认已在弹出的 Chrome 里登录成功。' };
}

// 确保浏览器在跑且已登录；未登录抛错引导去登录。
// targetUrl：登录检查落在哪个页面（复用对话时直接落到该对话页，省一次导航）。
async function ensureLoggedIn(targetUrl) {
  const page = await getPage();
  await page.goto(targetUrl || CONFIG.homeUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
  const ok = await detectLoggedIn(page);
  markLoggedIn(ok); // 真实检测自愈：会话过期则清、恢复则补
  if (!ok) throw new Error('DeepSeek 网页未登录：请先调 POST /login，在弹出的 Chrome 里登录一次后再试。');
  return page;
}

// —— 模式开关（best-effort）——
// 新对话每次从首页起，模式一般回到默认（关）。策略：想开就点一下；读得到状态就按状态精确设置。
async function readToggleOn(loc) {
  try {
    const aria = await loc.getAttribute('aria-pressed');   // toggle：深度思考/智能搜索
    if (aria != null) return /^true$/i.test(aria);
    const ariaC = await loc.getAttribute('aria-checked');  // radio：专家模式（模型类型单选组）
    if (ariaC != null) return /^true$/i.test(ariaC);
    const cls = (await loc.getAttribute('class')) || '';
    if (/(?:^|[\s_-])(active|selected|checked|on)(?:$|[\s_-])/i.test(cls)) return true;
    const dc = await loc.getAttribute('data-checked');
    if (dc != null) return /^(1|true|yes)$/i.test(dc);
  } catch { /* ignore */ }
  return null; // 无法判定
}

async function applyMode(page, key, want, { reuse } = {}) {
  const spec = CONFIG.modes[key];
  if (!spec) return { key, applied: false, reason: 'no-spec' };
  const loc = await firstVisible(page, spec.selectors, 3000);
  if (!loc) return { key, applied: false, reason: 'not-found' }; // 按钮不存在（网页版未提供 / 选择器待实登调优）→ 跳过
  try {
    const cur = await readToggleOn(loc);
    if (cur === want) return { key, applied: true, changed: false };   // 状态已知且已符合 → 不动
    // 单选组（专家模式）关闭：不能反点自身，要改选「关」态那一项（快速模式）。仅当当前确为开启才切换，
    // 避免把处于「识图(vision)」态的模型类型误拨回快速（识图靠传图自动切，与此处互不干扰）。
    if (spec.kind === 'radio' && cur === true && want === false) {
      const off = await firstVisible(page, spec.offSelectors || [], 2000);
      if (!off) return { key, applied: false, reason: 'radio-off-target-not-found' };
      await off.click({ timeout: 2500 });
      await page.waitForTimeout(200);
      return { key, applied: true, changed: true, reason: 'radio-select-default' };
    }
    if (cur !== null) {                                                 // 状态已知且不符 → 点一下（toggle 反转 / radio 选中该项）
      await loc.click({ timeout: 2500 });
      await page.waitForTimeout(200);
      return { key, applied: true, changed: true };
    }
    // —— cur === null：读不出当前状态（选择器/属性尚未按真实 DOM 调优）——
    // 复用对话时模式是「粘性」的（DeepSeek 记住上次选择）：绝不盲点，否则会把已开着的模式误关（修 bug）。
    if (reuse) return { key, applied: false, reason: 'unknown-state-reuse-trust-sticky' };
    // 新对话默认从「关」态起：想关本就是关（不动）；只有想开才点一下（此时点开是安全的）。
    if (!want) return { key, applied: false, reason: 'unknown-state-newchat-skip-off' };
    await loc.click({ timeout: 2500 });
    await page.waitForTimeout(200);
    return { key, applied: true, changed: true, reason: 'blind-on-newchat' };
  } catch (e) {
    return { key, applied: false, reason: String((e && e.message) || e) };
  }
}

// —— 诊断（只读）：dump 页面上所有可见按钮的文字/class/aria，供首次实登调选择器用。——
// 建议：先在浏览器里把想要的模式（深度思考/联网搜索/专家）手动开着，再调本接口，
// 便于对比「开」与「关」两态，看清选中态在 DOM 上的标志（class 变化 / aria-pressed 等）。
async function inspect({ conversationId, newChat, nav } = {}) {
  const convKey = conversationId != null && conversationId !== '' ? String(conversationId) : '';
  const rec = convKey ? CONV.get(convKey) : null;
  const reuse = !!(rec && rec.url && !newChat);
  const target = reuse ? rec.url : CONFIG.homeUrl;
  const page = await getPage();
  // 默认：若已在 DeepSeek 页面就用「当前页」（便于先手动设好模式再诊断，看清开/关两态）；否则导航到 target。nav=1 强制刷新到 target。
  const onDeepseek = /chat\.deepseek\.com/i.test(page.url());
  const navigated = !!nav || !onDeepseek;
  if (navigated) await page.goto(target, { waitUntil: 'domcontentloaded' }).catch(() => {});
  const okLogin = await detectLoggedIn(page);
  markLoggedIn(okLogin);
  if (!okLogin) throw new Error('DeepSeek 网页未登录：请先 POST /login，在弹出的 Chrome 里登录一次后再试。');
  await page.waitForTimeout(800);
  const buttons = await page.evaluate(() => {
    const KW = /(深度思考|联网|搜索|专家|思考|DeepThink|R1|Think|Search)/i;
    const raw = [];
    for (const el of document.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;              // 跳过不可见
      // 元素「自身直接文本」（不含子元素文本）：大容器为空，真正承载文字的小控件才有值
      let ownText = '';
      for (const n of el.childNodes) if (n.nodeType === 3) ownText += n.textContent;
      ownText = ownText.replace(/\s+/g, ' ').trim();
      const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
      const cls = el.getAttribute('class') || '';
      const btnish = el.tagName === 'BUTTON' || el.getAttribute('role') === 'button' ||
        /(?:^|[\s_-])(button|btn|toggle|switch|chip|tag)(?:$|[\s_-])/i.test(cls);
      const hit = (KW.test(ownText) && ownText.length <= 20) || (btnish && t && t.length <= 16);
      if (!hit) continue;
      raw.push({
        tag: el.tagName.toLowerCase(),
        text: t.slice(0, 40),
        role: el.getAttribute('role'),
        ariaPressed: el.getAttribute('aria-pressed'),
        dataState: el.getAttribute('data-state') || el.getAttribute('data-checked'),
        cls: cls.slice(0, 220),
        html: el.outerHTML.replace(/\s+/g, ' ').slice(0, 320),
      });
    }
    const seen = new Set(); const uniq = [];
    for (const b of raw) { if (seen.has(b.html)) continue; seen.add(b.html); uniq.push(b); }
    return uniq.slice(0, 60); // 上限防爆
  });
  // 输入框工具栏整块 HTML：定位 composer，向上走若干层祖先，dump 那一整块（含深度思考/搜索/专家等入口），
  // 供一次看清「专家模式」到底是 toggle 还是下拉选项 + 它的真实 class/结构。
  const toolbar = await page.evaluate(() => {
    const sels = ['textarea#chat-input', 'textarea[placeholder]', 'div[contenteditable="true"]'];
    let node = null;
    for (const s of sels) { node = document.querySelector(s); if (node) break; }
    if (!node) return { found: false };
    // 向上走：找到「同时包含深度思考/搜索类按钮」的最近祖先块
    let cur = node, best = null;
    for (let i = 0; i < 8 && cur; i++) {
      const txt = (cur.innerText || '');
      if (/(深度思考|搜索|专家)/.test(txt)) best = cur;
      cur = cur.parentElement;
    }
    const box = best || node.parentElement || node;
    return { found: true, tag: box.tagName.toLowerCase(), cls: box.getAttribute('class') || '', html: box.outerHTML.replace(/\s+/g, ' ').slice(0, 8000) };
  });
  // 精确探针：直接枚举选择器目标，确认 think/search 的 toggle 与 expert 的 radio 各自可命中、状态可读。
  const probe = await page.evaluate(() => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const toggles = [...document.querySelectorAll('.ds-toggle-button')].map((el) => ({
      text: clean(el.innerText).slice(0, 24), ariaPressed: el.getAttribute('aria-pressed'), cls: (el.getAttribute('class') || '').slice(0, 160),
    }));
    const radios = [...document.querySelectorAll('[data-model-type],[role="radio"]')].map((el) => ({
      type: el.getAttribute('data-model-type'), text: clean(el.innerText).slice(0, 24), role: el.getAttribute('role'), ariaChecked: el.getAttribute('aria-checked'),
    }));
    return { toggles, radios };
  });
  return { target, reuse, navigated, url: page.url(), count: buttons.length, buttons, toolbar, probe };
}

// —— 识图：上传图片文件到隐藏的 file input ——
async function attachImages(page, images) {
  const files = (Array.isArray(images) ? images : [images]).filter(Boolean);
  if (!files.length) return { attached: 0, reason: 'empty' };
  for (const f of files) { if (!fs.existsSync(f)) throw new Error('识图文件不存在：' + f); }
  // file input 常隐藏，用候选选择器直接 setInputFiles（不必可见）
  let input = null;
  for (const s of CONFIG.sel.fileInput) {
    const loc = page.locator(s).first();
    try { if (await loc.count()) { input = loc; break; } } catch { /* 试下一个 */ }
  }
  if (!input) throw new Error('未找到文件上传入口（识图模式），需更新 fileInput 选择器');
  await input.setInputFiles(files);
  await page.waitForTimeout(1200); // 等上传/预览渲染
  return { attached: files.length };
}

// —— 统一发送：识图轮等图片真正上传完成再发，避免过早 Enter 被撰写区吞掉 ——
// 文本轮保持与旧逻辑完全一致（click→fill→Enter，立即返回）；
// 识图轮用「完成接口已响应」(isSent) 或「输入框已清空」确认发送，未发则重试 Enter，
// 直到上传完成、发送真正生效（DeepSeek 在图片上传期间会禁用发送，此时 Enter 是空操作）。
async function submitMessage(page, box, full, { hasImage, isSent } = {}) {
  await box.click();
  if (full) await box.fill(full);
  await page.keyboard.press('Enter');
  if (!hasImage) return { sent: true, via: 'enter', tries: 0 }; // 文本轮：行为不变
  const sent = typeof isSent === 'function' ? isSent : () => false;
  // 有文本时可用「输入框清空」作旁证；图片轮（无文本）只认 isSent（完成接口已响应）
  const clearedIfTextSent = async () => {
    if (!full) return false;
    let v = ''; try { v = ((await box.inputValue()) || '').trim(); } catch { try { v = ((await box.innerText()) || '').trim(); } catch { v = full; } }
    return v === '';
  };
  const deadline = Date.now() + 45000; // 上传通常几秒，给足冗余
  let tries = 0;
  while (Date.now() < deadline) {
    await page.waitForTimeout(500);
    if (sent()) return { sent: true, via: tries ? 'retry-enter' : 'enter', tries };
    if (await clearedIfTextSent()) return { sent: true, via: 'cleared', tries };
    // 仍未发出（多半图片还在上传、发送被禁用）：补回文本后重试 Enter
    tries++;
    try { if (full) { let v = ''; try { v = (await box.inputValue()) || ''; } catch {} if (v !== full) await box.fill(full); } } catch {}
    try { await box.click(); } catch {}
    await page.keyboard.press('Enter');
  }
  return { sent: false, via: 'timeout', tries };
}

// 解析「对话完成接口」的 SSE 全文 → 还原答案正文（无损，保留 Markdown 源码；取代渲染后 DOM 的有损文本）。
// DeepSeek 网页版用「片段(fragment)增量」协议流式下发（2026-07 实测确认，见下例）：
//   · 首帧一个完整对象 {v:{response:{fragments:[{id,type,content}]}}}，type∈THINK/RESPONSE/…，content 为初值；
//   · {"p":"response/fragments","o":"APPEND","v":[{…新片段…}]} 追加一个新片段（如从 THINK 切到 RESPONSE）；
//   · {"p":"response/fragments/-1/content",("o":"APPEND"?),"v":"字"} 往「最后一个片段」的 content 追加；
//   · 其后不带 p 的 {"v":"字"} 是上一条 content 路径的延续，续到「最后一个片段」；
//   · 其余带 p 的 op（response/status=FINISHED、accumulated_token_usage、…/elapsed_secs、BATCH）与
//     event:title 的 {content:"标题"} 都不是正文——旧版把它们误当正文拼进去（泄漏思维链+FINISHED+标题），这里根治。
// 最终只拼「答案类」片段，剔除思维链/搜索类（type 含 THINK/REASON/SEARCH）——与网页只在 .ds-markdown 显示答案一致。
function parseSSE(raw) {
  const frags = []; // 按出现序：{ type, content }
  const lastFrag = () => (frags.length ? frags[frags.length - 1] : null);
  const ensureFrag = () => { let f = lastFrag(); if (!f) { f = { type: 'RESPONSE', content: '' }; frags.push(f); } return f; };
  const pushFrag = (fr) => frags.push({ type: String((fr && fr.type) || 'RESPONSE').toUpperCase(), content: typeof (fr && fr.content) === 'string' ? fr.content : '' });
  let contentActive = false; // 「最近一条 op 是否指向某片段 content」——决定后续 bare {v} 是否算正文续写

  for (const line of String(raw || '').split(/\r?\n/)) {
    const m = line.match(/^data:\s*(.*)$/);
    if (!m) continue;                       // 跳过 event: 行与空行
    const payload = m[1].trim();
    if (!payload || payload === '[DONE]') continue;
    let j; try { j = JSON.parse(payload); } catch { continue; }

    // 首帧完整对象：吃下初始 fragments
    if (j && j.v && typeof j.v === 'object' && !Array.isArray(j.v) && j.v.response && Array.isArray(j.v.response.fragments)) {
      for (const fr of j.v.response.fragments) pushFrag(fr);
      contentActive = frags.length > 0;
      continue;
    }

    const p = typeof j.p === 'string' ? j.p : '';

    // 新增片段：p 恰为 response/fragments，v 为片段对象或其数组
    if (p === 'response/fragments') {
      const arr = Array.isArray(j.v) ? j.v : (j.v && typeof j.v === 'object' ? [j.v] : []);
      for (const fr of arr) pushFrag(fr);
      contentActive = true;
      continue;
    }

    // 往某片段 content 追加：p 命中 fragments/<idx>/content（含 -1=最后一个）
    const cm = p.match(/^response\/fragments\/(-?\d+)\/content$/);
    if (cm && typeof j.v === 'string') {
      const idx = Number(cm[1]);
      ((idx >= 0 && idx < frags.length) ? frags[idx] : ensureFrag()).content += j.v;
      contentActive = true;
      continue;
    }

    // 其它带 p 的 op（status/usage/elapsed_secs/BATCH…）都不是正文
    if (p) { contentActive = false; continue; }

    // 不带 p 的 {v:"字"}：仅当处于正文续写态才续到最后一个片段（避免误吞非正文）
    if (contentActive && typeof j.v === 'string') { ensureFrag().content += j.v; continue; }
    // event:title 的 {content:"标题"} 等：无 p、非 v-string → 丢弃
  }

  return frags.filter((f) => !/THINK|REASON|SEARCH/i.test(f.type)).map((f) => f.content).join('').trim();
}

// 抓最后一条助手消息的最终渲染文本（内容干净、不含思维链）
async function scrapeLastMessage(page, containers) {
  try {
    return await page.evaluate((sels) => {
      const cands = [];
      for (const s of sels) cands.push(...document.querySelectorAll(s));
      if (cands.length) {
        const el = cands[cands.length - 1];
        return (el.innerText || '').trim();
      }
      return '';
    }, containers);
  } catch { return ''; }
}

// 去掉 ```json … ``` 代码围栏（网页模型爱包围栏），拿到里面的裸内容
function unfence(s) {
  const str = String(s || '').trim();
  const m = str.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return m ? m[1].trim() : str;
}

// 模型偶尔把 JSON 裹在文本里 —— 先直解，失败再抠出第一个 {…} 或 […]
function safeJSON(s) {
  if (s == null) return null;
  try { return JSON.parse(s); } catch { /* fall through */ }
  const m = String(s).match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (m) { try { return JSON.parse(m[0]); } catch { /* fall through */ } }
  throw new Error('无法解析模型返回的 JSON：' + String(s).slice(0, 200));
}

// 网页聊天无 system 角色：把 system 折进正文；json 追加「只输出 JSON」强约束。
// includeSystem=false（复用对话的后续轮）→ 不重复注入 system，避免每轮污染上下文。
function buildPrompt({ prompt, system, json, includeSystem }) {
  const parts = [];
  if (system && includeSystem !== false) parts.push(String(system).trim());
  parts.push(String(prompt));
  if (json) parts.push('【输出格式 · 强制】只输出一个合法 JSON，不要任何解释、前言、Markdown 代码块围栏或多余文字。');
  return parts.join('\n\n');
}

// 发一条 prompt（可切模式 / 传图 / 复用对话）、等完成、取回复
// signal：可选 AbortSignal，客户端断开时 abort → 立即结束等待 + best-effort 停生成 + 释放 _busy（真终止）。
async function chat({ prompt, system, json, think, search, expert, images, timeoutMs, conversationId, newChat, signal } = {}) {
  if (!prompt && !(images && images.length)) throw new Error('chat 需要 prompt（或至少一张 images 用于识图）');
  if (_busy) throw new Error('DeepSeek 网页会话忙（一次只能一条），请稍后重试');
  _busy = true;
  const started = Date.now();
  const modeReport = {};
  try {
    // 深度思考耗时更长：未显式给超时则放宽
    const to = Number(timeoutMs) || (think ? 600000 : 240000);

    // 决定目标页：复用已绑定的对话 URL，还是开新对话（首页）
    const convKey = conversationId != null && conversationId !== '' ? String(conversationId) : '';
    const rec = convKey ? CONV.get(convKey) : null;
    const reuse = !!(rec && rec.url && !newChat); // 有映射且不强制新开 → 复用同一对话线程
    const target = reuse ? rec.url : CONFIG.homeUrl;

    // 真终止（Task D）：把「登录→找输入框→切模式→发送→等生成」整段与「客户端断开」竞速。
    // 断开即刻跳出（不必等这段 Playwright 操作自然跑完，那会拖到 9s+ 才释放 _busy → 下一条撞「会话忙」），
    // best-effort 停生成并抛终止。step 之间插 throwIfAborted() 让 orphan 不再推进到「发送」这类改动页面的动作；
    // 残留 orphan 由下一次调用的 ensureLoggedIn→page.goto 天然清理（本项目既有安全网）。
    const ab = makeAbortRace(signal);
    const throwIfAborted = () => { if (signal && signal.aborted) throw new AbortError(); };
    let page = null;
    let sseText = null;
    let responded = false;                 // 完成接口是否已响应（= 发送真正生效的信号）
    let aborted = false;

    const runFlow = async () => {
      page = await ensureLoggedIn(target);  // 在目标页做登录检查（复用则直接落到该对话页）
      throwIfAborted();
      const box = await firstVisible(page, CONFIG.sel.composer, 15000);
      if (!box) throw new Error('未找到 DeepSeek 输入框（页面结构可能已变，需更新 composer 选择器）');
      throwIfAborted();
      // 识图：先传图（放在切模式/填字之前，等预览就绪）
      if (images && images.length) modeReport.vision = await attachImages(page, images);
      throwIfAborted();
      // 模式开关（best-effort，不因失败中断）。复用对话时按钮状态可能已随对话保留。
      modeReport.think = await applyMode(page, 'think', !!think, { reuse });
      throwIfAborted();
      modeReport.search = await applyMode(page, 'search', !!search, { reuse });
      throwIfAborted();
      modeReport.expert = await applyMode(page, 'expert', !!expert, { reuse });
      throwIfAborted();
      // 复用对话时不重复注入 system（首轮已注入），避免每轮污染上下文
      const full = buildPrompt({ prompt: prompt || '', system, json, includeSystem: !reuse });
      // 完成信号：捕获对话完成接口的响应（结束即代表生成完毕）
      const waitResp = page
        .waitForResponse((r) => CONFIG.sel.completionUrl.test(r.url()) && r.request().method() === 'POST', { timeout: to })
        .then(async (r) => { responded = true; try { sseText = await r.text(); } catch { /* ignore */ } })
        .catch(() => {});
      // 发送：识图轮等图片上传完成再发（撰写区禁用发送时 Enter 会被吞）；文本轮保持原行为
      await submitMessage(page, box, full, { hasImage: !!(images && images.length), isSent: () => responded });
      throwIfAborted();
      await waitResp;                      // 等 SSE 结束（= 生成完成）
    };

    const flow = runFlow();
    flow.catch(() => {});                   // 竞速判负后 flow 迟到 reject 不触发 unhandledRejection
    try { await Promise.race([flow, ab.promise]); }
    catch (e) { if (isAbortErr(e)) aborted = true; else { ab.cancel(); throw e; } }
    ab.cancel();
    if (aborted || (signal && signal.aborted)) { if (page) await stopGeneration(page).catch(() => {}); throw new AbortError(); }

    await page.waitForTimeout(600);        // 让 DOM 收尾渲染

    // 取回复正文：优先用「对话完成接口的 SSE 原文」——那是模型输出的 Markdown 源码（__x__ / `code` /
    // **粗体** / 表格管道 全部原样保留），无损；而 scrapeLastMessage 读的是渲染后 DOM 的 innerText，
    // 浏览器已把 __name__ 渲染成粗体“name”、把 `x` 渲染成行内代码吃掉反引号——对「写代码/补丁」是致命污染
    // （apply_patch 里 __main__ 变 main、反引号消失，补丁写不进文件）。故 SSE 优先、DOM 兜底：
    // 仅当 SSE 为空（未捕获/网络异常）或明显偏短（疑似匹配到无关响应）时才回落 DOM，保证绝不比现状差。
    const domText = await scrapeLastMessage(page, CONFIG.sel.messageContainers);
    const sseTxt = parseSSE(sseText);
    let text = (sseTxt && (!domText || sseTxt.length >= domText.length * 0.5)) ? sseTxt : (domText || sseTxt);
    if (DBG) dbgDump({ where: 'chat', picked: text === sseTxt ? 'sse' : 'dom', dom_len: domText.length, sse_len: sseTxt.length, dom_head: domText.slice(0, 160), sse_head: sseTxt.slice(0, 160) });
    if (!text) throw new Error('未能从 DeepSeek 网页取到回复（DOM 与 SSE 均为空）');

    // 绑定 / 刷新对话映射（供下次复用；持久化到磁盘扛守护进程重启）
    const finalUrl = page.url();
    const boundUrl = isConversationUrl(finalUrl) ? finalUrl : (rec && rec.url) || null;
    if (convKey) {
      CONV.set(convKey, {
        url: boundUrl,
        boundAt: (rec && rec.boundAt) || Date.now(),
        lastUsed: Date.now(),
        turns: ((rec && rec.turns) || 0) + 1,
      });
      saveConv();
    }

    const ms = Date.now() - started;
    const res = {
      text: String(text).trim(), ms, modes: modeReport,
      conversationId: convKey || null, conversationUrl: boundUrl, reused: reuse,
    };
    if (json) res.json = safeJSON(unfence(text));
    return res;
  } finally {
    _busy = false;
  }
}

// —— 流式版 chat（纯新增，绝不改动上面的 chat()）——
// 边生成边轮询网页 DOM 的最后一条助手消息，把新增的文字片段通过 onDelta(片段) 逐段回调；
// 生成结束后返回与 chat() 同形的结果对象。供 server.js 的 /chat/stream(SSE) 与 OpenAI 兼容 shim 的 stream:true 使用。
async function chatStream({ prompt, system, json, think, search, expert, images, timeoutMs, conversationId, newChat, signal } = {}, onDelta) {
  if (!prompt && !(images && images.length)) throw new Error('chatStream 需要 prompt（或至少一张 images 用于识图）');
  if (_busy) throw new Error('DeepSeek 网页会话忙（一次只能一条），请稍后重试');
  _busy = true;
  const started = Date.now();
  const emit = typeof onDelta === 'function' ? onDelta : () => {};
  const modeReport = {};
  try {
    const to = Number(timeoutMs) || (think ? 600000 : 240000);
    const convKey = conversationId != null && conversationId !== '' ? String(conversationId) : '';
    const rec = convKey ? CONV.get(convKey) : null;
    const reuse = !!(rec && rec.url && !newChat);
    const target = reuse ? rec.url : CONFIG.homeUrl;
    // 真终止（Task D）：把「登录→找输入框→切模式→发送」这段无法被 signal 中断的 Playwright 操作，
    // 与「客户端断开」竞速——断开即刻跳出并释放 _busy（否则要等这段跑完 9s+ 才释放 → 下一条撞「会话忙」）。
    // 生成阶段的轮询循环本就每拍查 signal.aborted，故只需给这段 setup 补上竞速。
    const ab = makeAbortRace(signal);
    const throwIfAborted = () => { if (signal && signal.aborted) throw new AbortError(); };
    let page = null; let box = null; let baseCount = 0;
    let sseText = null; let done = false; let responded = false;
    let waitResp = null;
    let aborted = false;

    const setup = async () => {
      page = await ensureLoggedIn(target);
      throwIfAborted();
      box = await firstVisible(page, CONFIG.sel.composer, 15000);
      if (!box) throw new Error('未找到 DeepSeek 输入框（页面结构可能已变，需更新 composer 选择器）');
      throwIfAborted();
      if (images && images.length) modeReport.vision = await attachImages(page, images);
      throwIfAborted();
      modeReport.think = await applyMode(page, 'think', !!think, { reuse });
      throwIfAborted();
      modeReport.search = await applyMode(page, 'search', !!search, { reuse });
      throwIfAborted();
      modeReport.expert = await applyMode(page, 'expert', !!expert, { reuse });
      throwIfAborted();
      const full = buildPrompt({ prompt: prompt || '', system, json, includeSystem: !reuse });
      // 发送前先数一下已有消息容器数，避免把上一轮的旧消息当成本轮增量
      baseCount = await page.evaluate((sels) => {
        let n = 0; for (const s of sels) { const c = document.querySelectorAll(s).length; if (c > n) n = c; } return n;
      }, CONFIG.sel.messageContainers);
      // 完成信号：捕获对话完成接口的响应（结束即代表生成完毕）
      waitResp = page
        .waitForResponse((r) => CONFIG.sel.completionUrl.test(r.url()) && r.request().method() === 'POST', { timeout: to })
        .then(async (r) => { responded = true; try { sseText = await r.text(); } catch { /* ignore */ } })
        .catch(() => {})
        .finally(() => { done = true; });
      // 发送：识图轮等图片上传完成再发（撰写区禁用发送时 Enter 会被吞）；文本轮保持原行为
      await submitMessage(page, box, full, { hasImage: !!(images && images.length), isSent: () => responded });
      throwIfAborted();
    };

    const setupP = setup();
    setupP.catch(() => {});                 // 竞速判负后迟到 reject 不触发 unhandledRejection
    try { await Promise.race([setupP, ab.promise]); }
    catch (e) { if (isAbortErr(e)) aborted = true; else { ab.cancel(); throw e; } }
    ab.cancel();
    if (aborted || (signal && signal.aborted)) { if (page) await stopGeneration(page).catch(() => {}); throw new AbortError(); }

    // 只读「本轮新出现的最后一个容器」的纯文本；base 之前的都是历史消息
    const readCur = () => page.evaluate((arg) => {
      let all = [];
      for (const s of arg.sels) { const nodes = document.querySelectorAll(s); if (nodes.length > all.length) all = Array.prototype.slice.call(nodes); }
      if (all.length <= arg.base) return '';
      const el = all[all.length - 1];
      return (el.innerText || '').trim();
    }, { sels: CONFIG.sel.messageContainers, base: baseCount });

    // 边生成边轮询 DOM：前缀增长即为新增片段，逐段回调；客户端断开（signal.aborted）则跳出（真终止）
    let emitted = '';
    const deadline = Date.now() + to;
    while (!done && Date.now() < deadline) {
      if (signal && signal.aborted) { aborted = true; break; }
      let cur = '';
      try { cur = await readCur(); } catch { /* SPA 路由切换瞬间 evaluate 可能抛，忽略 */ }
      if (cur && cur.length > emitted.length && cur.startsWith(emitted)) {
        const delta = cur.slice(emitted.length); emitted = cur; emit(delta);
      }
      await page.waitForTimeout(160);
    }
    if (aborted) { await stopGeneration(page); throw new AbortError(); }

    await waitResp;
    await page.waitForTimeout(600); // 让 DOM 收尾渲染

    // 最终以「完整抓取」为准（DOM 优先，回退 SSE，再回退已发增量），并把与已发增量的差异补发出去
    let text = await scrapeLastMessage(page, CONFIG.sel.messageContainers);
    if (!text) text = parseSSE(sseText);
    if (!text) text = emitted;
    text = String(text || '').trim();
    if (text) {
      if (text.startsWith(emitted)) { const tail = text.slice(emitted.length); if (tail) { emit(tail); emitted = text; } }
      else { let i = 0; const n = Math.min(text.length, emitted.length); while (i < n && text[i] === emitted[i]) i++; const tail = text.slice(i); if (tail) emit(tail); emitted = text; }
    }
    if (!emitted && !text) throw new Error('未能从 DeepSeek 网页取到回复（DOM 与 SSE 均为空）');

    const finalUrl = page.url();
    const boundUrl = isConversationUrl(finalUrl) ? finalUrl : (rec && rec.url) || null;
    if (convKey) {
      CONV.set(convKey, {
        url: boundUrl,
        boundAt: (rec && rec.boundAt) || Date.now(),
        lastUsed: Date.now(),
        turns: ((rec && rec.turns) || 0) + 1,
      });
      saveConv();
    }

    const ms = Date.now() - started;
    // 返回给调用方的「权威文本」同样优先用无损 SSE（渲染 DOM 会吃掉 __ / 反引号 / 表格管道，写代码/补丁致命）；
    // 逐字增量仍来自上面 DOM 轮询的 emit（保持已发片段自洽、绝不重复补发），此处只切换「最终返回文本」的来源。
    const sseFinal = parseSSE(sseText);
    const domFinal = String(text || '');
    const lossless = (sseFinal && (!domFinal || sseFinal.length >= domFinal.length * 0.5)) ? sseFinal : (domFinal || emitted);
    const finalText = String(lossless || emitted || '').trim();
    if (DBG) dbgDump({ where: 'chatStream', picked: lossless === sseFinal ? 'sse' : 'dom', dom_len: domFinal.length, sse_len: sseFinal.length });
    const res = {
      text: finalText, ms, modes: modeReport,
      conversationId: convKey || null, conversationUrl: boundUrl, reused: reuse,
    };
    if (json) res.json = safeJSON(unfence(finalText));
    return res;
  } finally {
    _busy = false;
  }
}

async function close() {
  if (_ctx) { try { await _ctx.close(); } catch { /* ignore */ } _ctx = null; }
}

module.exports = {
  status, login, ensureLoggedIn, chat, chatStream, close, inspect,
  resetConversation, listConversations,
  // 供测试 / 复用的纯函数与配置
  parseSSE, unfence, safeJSON, buildPrompt, isConversationUrl, makeAbortRace, isAbortErr, AbortError, CONFIG, PROFILE_DIR: CONFIG.profileDir,
};
