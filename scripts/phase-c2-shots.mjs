#!/usr/bin/env node
/* C2 阶段截图：轻玻璃（3–6px 模糊）+ 景物透出 + 网易云真实封面。
   通过本机临时静态服务 + headless Chrome 打开 dist/index.html，
   只写 shots/phase-c2/，不运行会清空 shots/ 的 scripts/shoot.mjs。
   用法：node scripts/phase-c2-shots.mjs [--only=home|cand]
*/
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(root, 'shots/phase-c2');
fs.mkdirSync(OUT, { recursive: true });
const CHROME = process.env.CHROME_BIN || '/usr/bin/google-chrome';
const PORT = 9880 + Math.floor(Math.random() * 100);
const PROFILE = '/tmp/msyq-c2-shots';
fs.rmSync(PROFILE, { recursive: true, force: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const AFTER_HTML = path.join(root, 'dist/index.html');
const afterHtml = fs.readFileSync(AFTER_HTML, 'utf8');

const server = http.createServer((req, res) => {
  const u = req.url.split('?')[0];
  if (u === '/' || u === '/after') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(afterHtml); return; }
  if (u === '/blank') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end('<!doctype html><title>seed</title>'); return; }
  res.writeHead(404); res.end('not found');
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
const BASE = 'http://127.0.0.1:' + PORT;

const chrome = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--hide-scrollbars',
  '--force-color-profile=srgb', '--remote-debugging-port=0', '--user-data-dir=' + PROFILE, 'about:blank'
], { stdio: 'ignore', env: { ...process.env } });

// 等待 DevTools 端口（--remote-debugging-port=0 会写到 DevToolsActivePort）
let wsUrl = null;
for (let i = 0; i < 200; i++) {
  await sleep(100);
  try {
    const f = fs.readFileSync(path.join(PROFILE, 'DevToolsActivePort'), 'utf8').trim().split('\n');
    const port = f[0], p = f[1];
    const list = await new Promise((resolve, reject) => {
      http.get('http://127.0.0.1:' + port + '/json/list', (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); }).on('error', reject);
    });
    const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (page) { wsUrl = page.webSocketDebuggerUrl; break; }
  } catch (e) { /* 等待 */ }
}
if (!wsUrl) { chrome.kill(); server.close(); throw new Error('Chrome 未启动'); }
const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
let msgId = 0;
const pending = new Map();
const jsErrors = [];
const resourceErrors = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id) {
    const p = pending.get(m.id);
    if (p) { pending.delete(m.id); m.error ? p.reject(new Error(m.method + ': ' + JSON.stringify(m.error))) : p.resolve(m.result); }
    return;
  }
  if (m.method === 'Runtime.consoleAPICalled') {
    const text = (m.params.args || []).map((a) => (a.value !== undefined ? String(a.value) : (a.description || a.type))).join(' ');
    if (m.params.type === 'error' || m.params.type === 'assert') jsErrors.push('console.' + m.params.type + ': ' + text);
  }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    jsErrors.push('exception: ' + ((d.exception && d.exception.description) || d.text));
  }
  if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
    const t = m.params.entry.text || '';
    if (/Failed to load resource/i.test(t)) resourceErrors.push(t);
    else jsErrors.push('log: ' + t);
  }
});
function send(method, params = {}) {
  return new Promise((resolve, reject) => { const id = ++msgId; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
}
async function ev(expression) {
  const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
  if (res.exceptionDetails) throw new Error('evaluate 失败: ' + JSON.stringify((res.exceptionDetails.exception && res.exceptionDetails.exception.description) || res.exceptionDetails.text));
  return res.result.value;
}
async function click(selector, wait = 520) {
  const ok = await ev('(function(){var el=document.querySelector(' + JSON.stringify(selector) + '); if(!el) return false; el.click(); return true;})()');
  if (!ok) throw new Error('找不到可点击元素: ' + selector);
  await sleep(wait);
}
async function shot(name, wait = 420) {
  await sleep(wait);
  /* 截图用：隐藏只在「没有后端」时出现的离线提示（不是设计的一部分） */
  await ev('(function(){var sn=document.getElementById("serverNote");if(sn)sn.style.display="none";[].forEach.call(document.querySelectorAll(".a2-banner"),function(e){var t=e.textContent||"";if(t.indexOf("离线模式")>=0||t.indexOf("连不上本机后端")>=0)e.style.display="none";});var t=document.getElementById("toast");if(t){t.classList.remove("is-show");t.style.display="none";}return true;})()').catch(function(){});
  const res = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(res.data, 'base64'));
  console.log('  📸 ' + name);
}
async function seed(theme, opts = {}) {
  const overrides = {};
  overrides[theme] = {};
  if (opts.wp) overrides[theme].home = opts.wp;
  const state = { theme, overrides, settings: { splashAlways: true } };
  await send('Page.navigate', { url: BASE + '/blank' });
  await sleep(260);
  await ev('localStorage.setItem("msyq.v2", ' + JSON.stringify(JSON.stringify(state)) + '); localStorage.setItem("msyq.migrated","1"); true');
}
async function load(route) {
  await send('Page.navigate', { url: BASE + route });
  for (let i = 0; i < 160; i++) {
    const ready = await ev("(function(){var v=document.querySelector('.view.is-active');return !!(v && document.querySelectorAll('.w').length>=6 && document.getElementById('homeTrack'));})()").catch(() => false);
    if (ready) { await sleep(1400); await ev('(function(){var t=document.getElementById("toast"); if(t){t.classList.remove("is-show");t.style.display="none";} var sn=document.getElementById("serverNote"); if(sn) sn.style.display="none"; [].forEach.call(document.querySelectorAll(".view--stats .a2-banner"), function(e){e.style.display="none";}); return true;})()'); return true; }
    await sleep(110);
  }
  throw new Error('页面未就绪: ' + route);
}
async function fresh() { await load('/after'); }
async function gotoView(view) {
  if (view === 'home') { await fresh(); return; }
  if (['chat', 'memory', 'listen', 'me'].indexOf(view) >= 0) { await fresh(); await click('.tab[data-nav="' + view + '"]', 780); return; }
  await fresh();
  await click('.tab[data-nav="me"]', 620);
  await click('[data-nav="' + view + '"]', 820);
}

async function themeShots(theme) {
  console.log('== 主题 ' + theme + ' ==');
  await seed(theme);
  await fresh();
  await shot(theme + '-home');
  for (const view of ['chat', 'memory', 'listen', 'me', 'stats', 'characters', 'settings']) {
    await gotoView(view);
    await shot(theme + '-' + view);
  }
  await gotoView('listen');
  await click('[data-open="playlist"]', 1600);
  await shot(theme + '-sheet-playlist');
  await click('[data-close]', 620);
}

async function candidateShots() {
  const cands = { pink: ["wp05","wp01","wp13","wp03"], ice: ["wp09"] };
  const out = {};
  for (const theme of ["pink","ice"]) {
    out[theme] = {};
    for (const wp of cands[theme]) {
      await seed(theme, { wp });
      await load("/after");
      const rects = await ev("(function(){function r(sel){var el=document.querySelector(sel);if(!el)return null;var b=el.getBoundingClientRect();return {x:Math.round(b.x),y:Math.round(b.y),w:Math.round(b.width),h:Math.round(b.height)};}return {couple:r('.w-couple'),clock:r('.w--clock'),pill:r('.w--pill'),note:r('.w-note'),player:r('.w-player')};})()");
      out[theme][wp] = rects;
      await shot("_cand-" + theme + "-" + wp);
    }
  }
  fs.writeFileSync(path.join(OUT, "_cand-rects.json"), JSON.stringify(out, null, 2));
}

async function collectMetrics() {
  const out = {};
  for (const theme of ['ice', 'pink']) {
    await seed(theme);
    await load('/after');
    const m = await ev("(function(){" +
      "function cs(sel, pseudo){var el=document.querySelector(sel);if(!el)return null;var s=getComputedStyle(el,pseudo||null);return {bg:s.backgroundImage||s.backgroundColor,bf:s.backdropFilter||s.webkitBackdropFilter,border:s.borderTopColor,shadow:s.boxShadow,color:s.color,ts:s.textShadow,radius:s.borderRadius,ff:s.fontFamily,fs:s.fontSize,fw:s.fontWeight};}" +
      "function rect(sel){var el=document.querySelector(sel);if(!el)return null;var b=el.getBoundingClientRect();return {x:b.x,y:b.y,w:b.width,h:b.height};}" +
      "var tab=document.querySelector('.tabbar');" +
      "var icons=[].slice.call(document.querySelectorAll('.tab__icon, .tab--memory .tab__bubble')).map(function(e){return e.getBoundingClientRect().top;});" +
      "var heart=document.querySelector('.tab--memory .tab__bubble');var hr=heart?heart.getBoundingClientRect():null;" +
      "var view=document.querySelector('.view.is-active');" +
      "var before=getComputedStyle(view,'::before');" +
      "var layer=document.querySelector('.view.is-active .view__wp');" +
      "var boxes=[];" +
      "['#homeDays','.w-couple .label','.w-couple .poem','.days-en','.clock__date','.clock__en','.w--pill .label','.w--pill .pill-text__main','.w-note .note-text','.w-note .label','.w-note .en-label','.appbar__capsule','.player-title','.player-artist','.w--mem .label','.w--quote .quote-text','.tab__label'].forEach(function(sel){var el=document.querySelector(sel);if(!el)return;var b=el.getBoundingClientRect();var st=getComputedStyle(el);boxes.push({sel:sel,text:(el.textContent||'').trim().slice(0,26),x:b.x,y:b.y,w:b.width,h:b.height,color:st.color,fs:st.fontSize,fw:st.fontWeight,ff:st.fontFamily});});" +
      "return {" +
        "theme:document.documentElement.getAttribute('data-theme')," +
        "card:cs('.w-couple'),pill:cs('.w--pill'),clock:cs('.w--clock'),note:cs('.w-note'),tabbar:cs('.tabbar'),sheet:null," +
        "fogBefore:{display:before.display,content:before.content,background:before.backgroundImage}," +
        "wallpaperFilter:layer?getComputedStyle(layer).filter:''," +
        "wallpaperAttr:view?view.getAttribute('data-wp'):''," +
        "homeMask:getComputedStyle(document.querySelector('.page-scroll--home')).maskImage||getComputedStyle(document.querySelector('.page-scroll--home')).webkitMaskImage," +
        "tabbarHeight:tab?tab.getBoundingClientRect().height:0," +
        "iconSpread:icons.length?Math.max.apply(null,icons)-Math.min.apply(null,icons):-1," +
        "heart:hr?{w:hr.width,h:hr.height}:null," +
        "dayNumFont:cs('#homeDays').ff,dayNumSize:cs('#homeDays').fs," +
        "cards:{couple:rect('.w-couple'),clock:rect('.w--clock'),pill:rect('.w--pill'),note:rect('.w-note'),player:rect('.w-player')}," +
        "textBoxes:boxes," +
        "coverImgs:[].slice.call(document.querySelectorAll('.record__art, .mini-disc__art, .track__cover, .song-row__cover img')).map(function(im){return {cls:im.className,src:(im.getAttribute('src')||'').slice(0,60),w:im.naturalWidth,missing:im.classList.contains('is-missing')};})," +
        "homeTrack:document.getElementById('homeTrack').textContent" +
      "};" +
    "})()");
    // 其它页面的代表性文字框（用于实测对比度 + 简版景物检查）
    const pages = ['home','chat','memory','listen','me','stats','characters','settings'];
    m.pageBoxes = {};
    for (const page of pages) {
      if (page === 'home') {
        m.pageBoxes[page] = m.textBoxes.map(function (b) { return { text: b.text, x: b.x, y: b.y, w: b.w, h: b.h, color: b.color, fs: b.fs }; });
        continue;
      }
      await gotoView(page);
      m.pageBoxes[page] = await ev("(function(){" +
        "var v=document.querySelector('.view.is-active'); if(!v) return [];" +
        "var out=[]; var nodes=v.querySelectorAll('h1,h2,h3,h4,p,span,b,strong');" +
        "for (var i=0;i<nodes.length;i++){var el=nodes[i]; if(el.childElementCount>0) continue; var t=(el.textContent||'').trim(); if(!t||t.length>60) continue; var r=el.getBoundingClientRect(); if(r.width<8||r.height<6) continue; if(r.top<32||r.bottom>760) continue; var st=getComputedStyle(el); out.push({text:t.slice(0,32),x:r.x,y:r.y,w:r.width,h:r.height,color:st.color,fs:st.fontSize}); if(out.length>=8) break;}" +
        "return out;" +
      "})()");
    }
    out[theme] = m;
  }
  fs.writeFileSync(path.join(OUT, '_metrics.json'), JSON.stringify({ themes: out, jsErrors, resourceErrors }, null, 2));
  console.log('metrics saved for ice/pink');
}

async function main() {
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true, screenWidth: 390, screenHeight: 844 });
  const only = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7);
  if (only === 'cand') {
    await candidateShots();
  } else if (only === 'home') {
    for (const theme of ['pink', 'ice']) { await seed(theme); await fresh(); await shot(theme + '-home'); }
    await collectMetrics();
  } else {
    await themeShots('pink');
    await themeShots('ice');
    await collectMetrics();
  }
  console.log('JS errors:', jsErrors.length, jsErrors.slice(0, 5));
  console.log('resource errors:', resourceErrors.length, resourceErrors.slice(0, 5));
  try { ws.close(); } catch (e) {}
  chrome.kill();
  server.close();
}
await main();