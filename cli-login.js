'use strict';
// 命令行登录助手：npm run login
// ⚠ Chrome profile 同一时刻只能被一个进程占用。若守护进程正在跑（已占用 profile），
//   本脚本必须让「正在跑的守护进程」去弹浏览器，而不是自己再开一个（否则争锁失败）。
// 策略：先探活守护进程 → 活着就走它的 POST /login；探活失败才自己直接驱动登录。

const http = require('http');

const PORT = Number(process.env.DEEPSEEK_WEB_PORT) || 39217;
const HOST = process.env.DEEPSEEK_WEB_HOST || '127.0.0.1';
const TOKEN = process.env.DEEPSEEK_WEB_TOKEN || '';

function req(method, path, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'content-type': 'application/json' };
    if (TOKEN) headers['authorization'] = 'Bearer ' + TOKEN;
    if (data) headers['content-length'] = Buffer.byteLength(data);
    const r = http.request({ host: HOST, port: PORT, method, path, headers, timeout: timeoutMs || 0 }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(buf || '{}') }); } catch { resolve({ status: res.statusCode, body: buf }); } });
    });
    r.on('timeout', () => { r.destroy(new Error('timeout')); });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  let daemonUp = false;
  try { const h = await req('GET', '/health', null, 1500); daemonUp = h.status === 200; } catch { /* 守护进程没跑 */ }

  if (daemonUp) {
    console.log('检测到守护进程在运行 → 通过它弹出 Chrome 登录（最多等 5 分钟）…');
    try {
      const r = await req('POST', '/login', { timeoutMs: 300000 });
      console.log(r.body && r.body.logged_in ? '✅ 登录成功，凭据已保存到共享 profile。' : ('❌ 未检测到登录：' + JSON.stringify(r.body)));
    } catch (e) { console.log('通过守护进程登录失败：' + (e && e.message || e)); process.exit(1); }
    process.exit(0);
  }

  // 守护进程没跑 → 自己直接驱动登录（不会与谁争锁）
  console.log('守护进程未运行 → 本进程直接弹出 Chrome 登录（最多等 5 分钟）…');
  const driver = require('./deepseek-driver');
  try {
    const r = await driver.login({ timeoutMs: 300000 });
    console.log(r.logged_in ? '✅ 登录成功，凭据已保存到共享 profile。现在可以启动守护进程：npm start' : ('❌ 未检测到登录：' + (r.error || '请重试')));
  } catch (e) { console.log('登录失败：' + (e && e.message || e)); process.exit(1); }
  finally { try { await driver.close(); } catch { /* ignore */ } }
  process.exit(0);
})();
