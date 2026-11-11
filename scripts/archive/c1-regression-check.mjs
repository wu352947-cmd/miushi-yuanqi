#!/usr/bin/env node
/* C1 回归断言：底栏 66px / 四图标齐平 / 爱心不凸出 / 此刻编辑在正文下方 / 减透明降级 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(root, 'shots/phase-c1');
fs.mkdirSync(OUT, { recursive: true });
const PROFILE = '/tmp/msyq-c1-regression';
fs.rmSync(PROFILE, { recursive: true, force: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const html = fs.readFileSync(path.join(root, 'dist/index.html'), 'utf8');
const server = http.createServer((req, res) => {
  const u = req.url.split('?')[0];
  if (u === '/blank') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>seed</title>'); return; }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const chrome = spawn('/usr/bin/google-chrome', ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--hide-scrollbars', '--force-color-profile=srgb', '--remote-debugging-port=0', '--user-data-dir=' + PROFILE, 'about:blank'], { stdio: 'ignore' });
let wsUrl = null;
for (let i = 0; i < 200; i++) {
  await sleep(100);
  try {
    const f = fs.readFileSync(path.join(PROFILE, 'DevToolsActivePort'), 'utf8').trim().split('\n');
    const list = await new Promise((resolve, reject) => { http.get('http://127.0.0.1:' + f[0] + '/json/list', (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve(JSON.parse(b))); }).on('error', reject); });
    const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (page) { wsUrl = page.webSocketDebuggerUrl; break; }
  } catch (e) {}
}
const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
let id = 0; const pending = new Map();
ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id) { const p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } } });
const send = (method, params = {}) => new Promise((resolve, reject) => { const i = ++id; pending.set(i, { resolve, reject }); ws.send(JSON.stringify({ id: i, method, params })); });
async function ev(expression) { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result.value; }
const results = [];
function check(name, ok, detail) { results.push({ name, ok: !!ok, detail: String(detail === undefined ? '' : detail) }); console.log((ok ? '  OK  ' : '  FAIL ') + name + (detail ? '  ' + detail : '')); }
async function seed(theme) {
  const overrides = {}; overrides[theme] = {};
  await send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/blank' }); await sleep(250);
  await ev('localStorage.setItem("msyq.v2",' + JSON.stringify(JSON.stringify({ theme, overrides, settings: { splashAlways: true } })) + ');localStorage.setItem("msyq.migrated","1");true');
  await send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/' });
  for (let i = 0; i < 140; i++) { await sleep(150); const ok = await ev("!!(document.querySelector('.view.is-active') && document.getElementById('homeTrack'))").catch(() => false); if (ok) { await sleep(1000); return; } }
  throw new Error('not ready');
}
await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true, screenWidth: 390, screenHeight: 844 });
for (const theme of ['pink', 'ice']) {
  await seed(theme);
  const m = await ev("(function(){var tab=document.querySelector('.tabbar');var icons=[].slice.call(document.querySelectorAll('.tab__icon, .tab--memory .tab__bubble')).map(function(e){return e.getBoundingClientRect().top;});var heart=document.querySelector('.tab--memory .tab__bubble').getBoundingClientRect();var heartSvg=document.querySelector('.tab--memory .tab__bubble svg').getBoundingClientRect();return {tabbarHeight:tab.getBoundingClientRect().height,tabbarBg:getComputedStyle(tab).backgroundImage,tabbarBf:getComputedStyle(tab).backdropFilter||getComputedStyle(tab).webkitBackdropFilter,icons:icons,spread:Math.max.apply(null,icons)-Math.min.apply(null,icons),heartW:heart.width,heartH:heart.height,heartSvgW:heartSvg.width,heartTop:heart.top};})()");
  check(theme + ' 底栏高度 66px', Math.abs(m.tabbarHeight - 66) < 0.6, m.tabbarHeight);
  check(theme + ' 四图标顶部齐平（误差 0）', m.spread < 0.6, m.spread);
  check(theme + ' 记忆爱心不放大（26px 内）', m.heartW <= 26.5 && m.heartH <= 26.5, m.heartW + 'x' + m.heartH);
  check(theme + ' 底栏背景是低透明玻璃 token', /gradient/.test(String(m.tabbarBg)) && /blur/.test(String(m.tabbarBf)), String(m.tabbarBf));
  await ev("document.querySelector('.tab[data-nav=\"memory\"]').click(); true"); await sleep(900);
  const mem = await ev("(function(){var now=document.getElementById('nowText'), edit=document.querySelector('.now-card__edit');var nr=now.getBoundingClientRect(), er=edit.getBoundingClientRect();return {editBelow:er.top>=nr.bottom-1,pos:getComputedStyle(edit).position,cardBg:getComputedStyle(document.querySelector('.now-card')).backgroundImage};})()");
  check(theme + ' 「此刻」编辑在正文下方文档流', mem.editBelow && mem.pos !== 'absolute' && mem.pos !== 'fixed', mem.pos);
  const mem2 = await ev("(function(){var edit=document.querySelector('.now-card__edit');var r=edit.getBoundingClientRect();var card=document.querySelector('.now-card').getBoundingClientRect();return {inside:r.left>card.left && r.right<card.right && r.bottom<=card.bottom+1, editW:r.width, editH:r.height};})()");
  check(theme + ' 「此刻」编辑按钮在卡内且尺寸正常', mem2.inside && mem2.editH >= 20, mem2.editW + 'x' + mem2.editH);
  // 卡片 token 生效（读 computed background-image 是否含 gradient 且非纯白）
  const card = await ev("(function(){var el=document.querySelector('.now-card');var s=getComputedStyle(el);return {bg:s.backgroundImage,bf:s.backdropFilter||s.webkitBackdropFilter,border:s.borderTopColor,shadow:s.boxShadow};})()");
  check(theme + ' 卡片填充走 token（两层渐变，含顶部高光）', (String(card.bg).match(/gradient/g) || []).length >= 2, card.bg.slice(0, 90));
  check(theme + ' 卡片模糊 10–18px 且带 saturate', /blur\((1[0-8]|10)px\)/.test(String(card.bf)) && /saturate/.test(String(card.bf)), card.bf);
  // 减透明降级
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }] });
  await seed(theme);
  const rt = await ev("(function(){var s=getComputedStyle(document.querySelector('.w-couple'));return {bg:s.backgroundColor,bf:s.backdropFilter||s.webkitBackdropFilter};})()");
  check(theme + ' 减透明时改半透明实底并去 blur', /rgba\(252, 250, 251, 0\.8/.test(rt.bg) && (rt.bf === 'none' || !rt.bf), rt.bg + ' / ' + rt.bf);
  await send('Emulation.setEmulatedMedia', { features: [] });
}

  // 封面加载失败：屏蔽网易云图片域名时退回素色唱片 / 素色小方块，不出现破图标
  try {
    await send('Network.enable');
    await send('Network.setBlockedURLs', { urls: ['*music.126.net*'] });
    await seed('ice');
    const fb = await ev("(function(){var art=document.getElementById('recordCover');var mini=document.getElementById('homeDiscCover');var f=document.querySelector('.record__fallback');return {recordMissing:art.classList.contains('is-missing'), miniMissing:mini.classList.contains('is-missing'), fallbackVisible:!!f&&getComputedStyle(f).display!=='none', artDisplay:getComputedStyle(art).display, miniDisplay:getComputedStyle(mini).display};})()");
    check('ice 封面加载失败时退素色唱片（不出现破图标）', fb.recordMissing && fb.miniMissing && fb.fallbackVisible && fb.artDisplay==='none' && fb.miniDisplay==='none', JSON.stringify(fb));
    await send('Network.setBlockedURLs', { urls: [] });
  } catch (e) { check('ice 封面加载失败时退素色唱片（不出现破图标）', false, String(e).slice(0,120)); }
  fs.writeFileSync(path.join(OUT, '_regression.json'), JSON.stringify({ results }, null, 2));
const failed = results.filter((r) => !r.ok).length;
console.log('\n' + (results.length - failed) + ' / ' + results.length + ' passed');
ws.close(); chrome.kill(); server.close();
process.exitCode = failed ? 1 : 0;
