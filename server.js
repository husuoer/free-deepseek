'use strict';
// DeepSeek 网页守护进程：独占一个「已登录」的真实 Chrome + 共享 profile，
// 供本机任意项目通过 HTTP 免费调用 DeepSeek 网页版（含深度思考/联网搜索/专家/识图）。
// 登录一次全机复用；因为浏览器只此一个持有者，不会有 Chrome profile 争锁问题。
//
// 只依赖 Node 内置 http + playwright（driver）。绑 127.0.0.1，不对外网暴露。
//
// 安全：
//  · 只监听回环地址 127.0.0.1（HOST 可覆盖，但默认回环）。
//  · CSRF 防护：拒绝任何带 Origin 头的请求——浏览器里的恶意网页 fetch 本机端口会自动带 Origin，
//    而正规的服务端到服务端调用不带；据此挡掉「拿用户浏览器当跳板打本地守护进程」。
//  · 可选 Bearer 令牌（DEEPSEEK_WEB_TOKEN）：设了就校验（/health 除外，便于探活）。
//
// 环境变量：DEEPSEEK_WEB_PORT(默认 39217) / DEEPSEEK_WEB_HOST(默认 127.0.0.1) /
//           DEEPSEEK_WEB_TOKEN(可选) / DEEPSEEK_PROFILE_DIR / DEEPSEEK_HEADLESS

const http = require('http');
const driver = require('./deepseek-driver');

const PORT = Number(process.env.DEEPSEEK_WEB_PORT) || 39217;
const HOST = process.env.DEEPSEEK_WEB_HOST || '127.0.0.1';
const TOKEN = process.env.DEEPSEEK_WEB_TOKEN || '';
const MAX_BODY = 8 * 1024 * 1024; // 8MB（images 传的是本机文件路径、正文很小，这里给足冗余）

function send(res, code, obj) {
  if (res.writableEnded || res.destroyed) return; // 客户端已断开：别再写（否则抛 ERR_STREAM_WRITE_AFTER_END）
  const body = JSON.stringify(obj == null ? {} : obj);
  try {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  } catch { /* socket 已关，忽略 */ }
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

function authed(req) {
  if (!TOKEN) return true; // 未设令牌 → 不校验（回环本机自用）
  const h = req.headers['authorization'] || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return !!(m && m[1] === TOKEN);
}

const server = http.createServer(async (req, res) => {
  const t0 = Date.now();
  const url = new URL(req.url, `http://${req.headers.host || HOST}`);
  const route = `${req.method} ${url.pathname}`;
  const done = (code) => console.log(`[${new Date().toISOString()}] ${route} → ${code} ${Date.now() - t0}ms`);

  try {
    // CSRF 防护：带 Origin 的一律拒（正规服务端客户端不带 Origin）
    if (req.headers['origin']) { send(res, 403, { error: '拒绝带 Origin 的请求（CSRF 防护）' }); return done(403); }

    // 探活公开；其余需令牌（若配置了）
    if (route === 'GET /health') { send(res, 200, { ok: true, ts: Date.now() }); return done(200); }
    if (!authed(req)) { send(res, 401, { error: '未授权：需要 Authorization: Bearer <DEEPSEEK_WEB_TOKEN>' }); return done(401); }

    if (route === 'GET /status') { send(res, 200, driver.status()); return done(200); }

    if (route === 'POST /login') {
      const body = await readBody(req);
      const out = await driver.login({ timeoutMs: Number(body.timeoutMs) || 300000 });
      send(res, 200, out); return done(200);
    }

    if (route === 'POST /chat') {
      const body = await readBody(req);
      const ctrl = new AbortController(); let finished = false;
      res.on('close', () => { if (!finished) ctrl.abort(); }); // 客户端断开 → 真终止（停生成 + 立即释放会话）
      try {
        const out = await driver.chat({
          prompt: body.prompt,
          system: body.system,
          json: !!body.json,
          think: !!body.think,
          search: !!body.search,
          expert: !!body.expert,
          images: body.images,
          timeoutMs: body.timeoutMs,
          conversationId: body.conversationId, // 传了就复用同一对话（上下文连续）；不传=每次新对话
          newChat: !!body.newChat,             // 强制为该 conversationId 开新对话并重绑
          signal: ctrl.signal,
        });
        finished = true;
        send(res, 200, out); return done(200);
      } catch (e) {
        finished = true;
        if (ctrl.signal.aborted) return done('abort'); // 客户端已走，无需回写
        throw e; // 真错误 → 交外层统一 500
      }
    }

    // 流式对话（SSE，纯新增，绝不改动上面的 /chat）：逐段下发生成增量。
    // 内部协议：每事件一行 data:{...}；增量段 {"delta":"片段"}；结束 {"done":true, text, ms, modes, conversationId, conversationUrl, reused[, json]}；最后 data:[DONE]。
    if (route === 'POST /chat/stream') {
      const body = await readBody(req);
      const ctrl = new AbortController(); let finished = false;
      res.on('close', () => { if (!finished) ctrl.abort(); }); // 客户端断开 → 真终止（停生成 + 立即释放会话）
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      const sse = (obj) => { try { res.write('data: ' + JSON.stringify(obj) + '\n\n'); } catch { /* 客户端已断开 */ } };
      try {
        const out = await driver.chatStream({
          prompt: body.prompt, system: body.system, json: !!body.json,
          think: !!body.think, search: !!body.search, expert: !!body.expert,
          images: body.images, timeoutMs: body.timeoutMs,
          conversationId: body.conversationId, newChat: !!body.newChat,
          signal: ctrl.signal,
        }, (delta) => sse({ delta }));
        sse({ done: true, text: out.text, ms: out.ms, modes: out.modes, conversationId: out.conversationId, conversationUrl: out.conversationUrl, reused: out.reused, json: out.json });
      } catch (e) { if (!ctrl.signal.aborted) sse({ error: String((e && e.message) || e) }); } // 断开则不必回写错误
      finished = true;
      try { res.write('data: [DONE]\n\n'); } catch { /* ignore */ }
      try { res.end(); } catch { /* ignore */ }
      return done(ctrl.signal.aborted ? 'abort' : 200);
    }

    if (route === 'GET /conversations') { send(res, 200, { conversations: driver.listConversations() }); return done(200); }

    // 诊断（只读）：dump 页面按钮真实 DOM，供实登调模式选择器用。?conversationId=world:8&newChat=0
    if (route === 'GET /inspect') {
      const out = await driver.inspect({
        conversationId: url.searchParams.get('conversationId') || '',
        newChat: /^(1|true|yes)$/i.test(url.searchParams.get('newChat') || ''),
      });
      send(res, 200, out); return done(200);
    }

    if (route === 'POST /reset') {
      const body = await readBody(req);
      send(res, 200, driver.resetConversation(body.conversationId)); return done(200);
    }

    send(res, 404, { error: '未知路由：' + route }); done(404);
  } catch (e) {
    const msg = String((e && e.message) || e);
    send(res, 500, { error: msg }); done(500);
  }
});

// 生成可能长达数分钟（深度思考更久）：关掉会截断长请求的超时
server.requestTimeout = 0;
server.headersTimeout = 60000;
server.timeout = 0;

server.listen(PORT, HOST, () => {
  const st = driver.status();
  console.log(`DeepSeek 网页守护进程已启动 → http://${HOST}:${PORT}`);
  console.log(`  playwright: ${st.installed ? '已安装' : '未安装'} · 登录: ${st.logged_in ? '已登录' : '未登录'} · profile: ${st.profile_dir}`);
  console.log(`  令牌校验: ${TOKEN ? '开（需 Bearer）' : '关'}`);
  if (!st.installed) console.log('  ⚠ 未装 playwright：在服务目录运行  npm i playwright');
  if (st.installed && !st.logged_in) console.log('  ⚠ 未登录：运行  npm run login  或  POST /login，在弹出的 Chrome 里登录一次');
});

// 退出时收尾浏览器
function shutdown() { driver.close().catch(() => {}).finally(() => process.exit(0)); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
