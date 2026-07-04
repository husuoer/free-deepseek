'use strict';
// DeepSeek 网页守护进程的瘦客户端（Node）。任意 Node 项目 require 本文件即可免费调用 DeepSeek 网页版。
// 非 Node 项目按 README.md 的 HTTP 规范直接发请求即可（就是几行 fetch/curl）。
//
// 配置（环境变量）：
//   DEEPSEEK_WEB_URL   守护进程地址，默认 http://127.0.0.1:39217
//   DEEPSEEK_WEB_TOKEN 可选 Bearer 令牌（与守护进程一致时才需要）
//
// ⚠ Node 的 http 默认不带 Origin 头，天然通过守护进程的 CSRF 防护，无需特殊处理。

const http = require('http');
const { URL } = require('url');

const BASE = process.env.DEEPSEEK_WEB_URL || 'http://127.0.0.1:39217';
const TOKEN = process.env.DEEPSEEK_WEB_TOKEN || '';

function request(method, path, body, { timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(path, BASE);
    const data = body != null ? JSON.stringify(body) : null;
    const headers = {};
    if (data) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(data); }
    if (TOKEN) headers['authorization'] = 'Bearer ' + TOKEN;
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers, timeout: timeoutMs || 0 },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          let j; try { j = JSON.parse(buf || '{}'); } catch { j = { error: '守护进程返回非 JSON', raw: buf }; }
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(j);
          else reject(new Error((j && j.error) || ('HTTP ' + res.statusCode)));
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('请求守护进程超时')));
    req.on('error', (e) => {
      if (e && /ECONNREFUSED/i.test(String(e.code || e.message))) {
        reject(new Error('连不上 DeepSeek 守护进程（' + BASE + '）。请先在守护进程目录运行 npm start 启动它。'));
      } else reject(e);
    });
    if (data) req.write(data);
    req.end();
  });
}

async function health() { return request('GET', '/health', null, { timeoutMs: 3000 }); }
async function status() { return request('GET', '/status', null, { timeoutMs: 5000 }); }

// 弹出 Chrome 让用户登录一次（有头）。客户端等待略长于服务端轮询窗。
async function login(timeoutMs = 300000) { return request('POST', '/login', { timeoutMs }, { timeoutMs: timeoutMs + 30000 }); }

// 发一条消息，拿完整结果对象：{ text, json?, ms, modes, conversationId, conversationUrl, reused }
// opts: { prompt, system?, json?, think?, search?, expert?, images?, conversationId?, newChat?, timeoutMs? }
async function chat(opts = {}) {
  const genTo = Number(opts.timeoutMs) || (opts.think ? 600000 : 240000);
  return request('POST', '/chat', opts, { timeoutMs: genTo + 30000 }); // 客户端超时留出富余，别提前掐断生成
}

// 便捷：要 JSON。返回已解析对象（内部自动 json:true）。
async function chatJSON(opts = {}) {
  const r = await chat({ ...opts, json: true });
  return r && r.json !== undefined ? r.json : r;
}

// 忘掉某个 conversationId 的对话映射（下次同 id 调用将开新对话）
async function reset(conversationId) { return request('POST', '/reset', { conversationId }); }

// 列出当前所有已绑定对话（conversationId → url / turns / 时间）
async function listConversations() { return request('GET', '/conversations', null, { timeoutMs: 5000 }); }

module.exports = { health, status, login, chat, chatJSON, reset, listConversations, BASE };
