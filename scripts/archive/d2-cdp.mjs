#!/usr/bin/env node
/* 第 D2 轮截图 / 交互自测用的轻量 CDP 工具（不依赖 puppeteer）。
   只写 shots/phase-d2/，不碰 scripts/shoot.mjs。
   用法：
     const { serveStatic, startBackend, startChrome } = await import('./d2-cdp.mjs');
*/
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ROOT = root;
export const CHROME = process.env.CHROME_BIN || '/usr/bin/google-chrome';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 静态服务 dist/index.html（离线模式截图用） */
export async function serveStatic(html) {
  const server = http.createServer((req, res) => {
    const u = req.url.split('?')[0];
    if (u === '/' || u === '/index.html' || u === '/after') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    if (u === '/blank') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end('<!doctype html><title>seed</title>'); return; }
    res.writeHead(404); res.end('not found');
  });
  const port = 0;
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  return { base, close: () => new Promise((r) => server.close(r)) };
}

/* 起本机后端（默认演示模型模式），返回 base 地址；用于保存连通 / 聊天记录截图 */
export async function startBackend(opts = {}) {
  const port = opts.port || (18080 + Math.floor(Math.random() * 500));
  const dbPath = opts.dbPath || '/tmp/msyq-d2-shots-' + Date.now() + '.db';
  const env = {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    MSYQ_MOCK: '1',
    MSYQ_MOCK_400: '',
    MSYQ_SEED: '1',
    MSYQ_DB_PATH: dbPath,
    APP_SECRET: 'd2-shots-secret',
    LOG_LEVEL: 'warning',
    ...(opts.env || {})
  };
  delete env.APP_PASSWORD;
  const child = spawn(path.join(root, '.venv/bin/python'), ['-m', 'server.app'], { cwd: root, env, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  const base = 'http://127.0.0.1:' + port;
  for (let i = 0; i < 200; i++) {
    await sleep(120);
    try {
      const res = await fetch(base + '/api/auth/me');
      if (res.ok) return { base, dbPath, close: () => { child.kill('SIGTERM'); return sleep(200); }, getStderr: () => stderr };
    } catch (e) { /* 等待 */ }
  }
  child.kill('SIGKILL');
  throw new Error('后端没起来：' + stderr.slice(-500));
}

/* 启动 headless Chrome + CDP，返回一组小工具 */
export async function startChrome(opts = {}) {
  const outDir = opts.outDir || path.join(root, 'shots/phase-d2');
  fs.mkdirSync(outDir, { recursive: true });
  const profile = '/tmp/msyq-d2-chrome-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
  const width = opts.width || 390;
  const height = opts.height || 844;
  const args = [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--hide-scrollbars',
    '--force-color-profile=srgb', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'
  ];
  if (opts.hostResolverRules) args.push('--host-resolver-rules=' + opts.hostResolverRules);
  const chrome = spawn(CHROME, args, { stdio: 'ignore', env: { ...process.env } });
  let wsUrl = null;
  for (let i = 0; i < 240; i++) {
    await sleep(100);
    try {
      const f = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').trim().split('\n');
      const dbgPort = f[0];
      const list = await new Promise((resolve, reject) => {
        http.get('http://127.0.0.1:' + dbgPort + '/json/list', (res) => {
          let b = '';
          res.on('data', (c) => (b += c));
          res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
        }).on('error', reject);
      });
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) { wsUrl = page.webSocketDebuggerUrl; break; }
    } catch (e) { /* 等待 */ }
  }
  if (!wsUrl) { chrome.kill(); throw new Error('Chrome 未启动'); }
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
  let msgId = 0;
  const pending = new Map();
  const errors = [];
  const resourceErrors = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id) {
      const p = pending.get(m.id);
      if (p) { pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); }
      return;
    }
    if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'assert')) {
      const text = (m.params.args || []).map((a) => (a.value !== undefined ? String(a.value) : (a.description || a.type))).join(' ');
      errors.push('console.' + m.params.type + ': ' + text);
    }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      errors.push('exception: ' + ((d.exception && d.exception.description) || d.text));
    }
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
      const t = m.params.entry.text || '';
      if (/Failed to load resource/i.test(t)) resourceErrors.push(t); else errors.push('log: ' + t);
    }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const ev = async (expression) => {
    const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (res.exceptionDetails) throw new Error('evaluate 失败: ' + JSON.stringify((res.exceptionDetails.exception && res.exceptionDetails.exception.description) || res.exceptionDetails.text));
    return res.result.value;
  };
  const click = async (selector, wait = 450) => {
    const ok = await ev('(function(){var el=document.querySelector(' + JSON.stringify(selector) + '); if(!el) return false; el.click(); return true;})()');
    if (!ok) throw new Error('找不到可点击元素: ' + selector);
    await sleep(wait);
  };
  const waitFor = async (expr, timeout = 12000, step = 120) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const ok = await ev('(function(){try{return !!(' + expr + ');}catch(e){return false;}})()').catch(() => false);
      if (ok) return true;
      await sleep(step);
    }
    throw new Error('等待超时: ' + expr);
  };
  const shot = async (name, wait = 380) => {
    if (wait) await sleep(wait);
    const res = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    fs.writeFileSync(path.join(outDir, name + '.png'), Buffer.from(res.data, 'base64'));
    console.log('  📸 ' + name);
  };
  const close = async () => {
    try { ws.close(); } catch (e) { /* 忽略 */ }
    try { chrome.kill(); } catch (e) { /* 忽略 */ }
    await sleep(250);
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 2 }); } catch (e) { /* Chrome 退出时会自己清理 */ }
  };
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: true, screenWidth: width, screenHeight: height });
  return { send, ev, click, shot, waitFor, close, errors, resourceErrors };
}
