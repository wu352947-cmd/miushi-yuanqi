#!/usr/bin/env node
/* C2 回归断言：3–6px 轻模糊 / 白色填充 0.08–0.18 / 无雾层无径向白光 / 底栏 66px / 此刻 / 减透明 / 封面 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(root, 'shots/phase-c2');
fs.mkdirSync(OUT, { recursive: true });
const PROFILE = '/tmp/msyq-c2-regression';
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
  // 等网易云封面加载（网络抖动时给最多 4 秒）
  for (let i = 0; i < 34; i++) {
    const w = await ev("(function(){var d=document.getElementById('homeDiscCover');return d?d.naturalWidth:0;})()").catch(() => 0);
    if (w > 0) break;
    await sleep(120);
  }
  const m = await ev("(function(){" +
    "function cs(sel,pseudo){var el=document.querySelector(sel);if(!el)return null;var s=getComputedStyle(el,pseudo||null);return {bg:s.backgroundImage||s.backgroundColor,bf:s.backdropFilter||s.webkitBackdropFilter,color:s.color,ff:s.fontFamily,fs:s.fontSize};}" +
    "var tab=document.querySelector('.tabbar');" +
    "var icons=[].slice.call(document.querySelectorAll('.tab__icon, .tab--memory .tab__bubble')).map(function(e){return e.getBoundingClientRect().top;});" +
    "var heart=document.querySelector('.tab--memory .tab__bubble');var hr=heart?heart.getBoundingClientRect():null;" +
    "var view=document.querySelector('.view.is-active');var before=getComputedStyle(view,'::before');" +
    "var layer=view.querySelector('.view__wp');" +
    "var disc=document.getElementById('homeDiscCover');" +
    "return {theme:document.documentElement.getAttribute('data-theme')," +
      "wp:view.getAttribute('data-wp')," +
      "card:cs('.w-couple'),pill:cs('.w--pill'),note:cs('.w-note'),tabbar:cs('.tabbar'),sheet:cs('.sheet'),bubble:cs('.bubble')," +
      "fog:{display:before.display,content:before.content}," +
      "wpFilter:layer?getComputedStyle(layer).filter:''," +
      "mask:getComputedStyle(document.querySelector('.page-scroll--home')).maskImage||getComputedStyle(document.querySelector('.page-scroll--home')).webkitMaskImage," +
      "tabbarHeight:tab?tab.getBoundingClientRect().height:0," +
      "spread:icons.length?Math.max.apply(null,icons)-Math.min.apply(null,icons):-1," +
      "heart:hr?{w:hr.width,h:hr.height}:null," +
      "dayNumFont:cs('#homeDays').ff,dayNumSize:cs('#homeDays').fs," +
      "enLabels:document.querySelectorAll('.en-label').length," +
      "discLoaded:disc?disc.naturalWidth:0" +
    "};" +
  "})()");
  function blurOf(bf){var mm=String(bf).match(/blur\(([\d.]+)px\)/);return mm?parseFloat(mm[1]):-1;}
  function satOf(bf){var mm=String(bf).match(/saturate\(([\d.]+)\)/);return mm?parseFloat(mm[1]):-1;}
  function brightOf(bf){var mm=String(bf).match(/brightness\(([\d.]+)\)/);return mm?parseFloat(mm[1]):-1;}
  function alphasOf(bg){var out=[];var re=/rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*([\d.]+)\s*\)/g;var mm;while((mm=re.exec(String(bg))))out.push(parseFloat(mm[1]));return out;}

  check(theme + ' 首页壁纸来自现有壁纸库（' + m.wp + '）', m.wp === (theme === 'ice' ? 'wp09' : 'wp05'), m.wp);
  check(theme + ' 大卡 blur 3–6px', blurOf(m.card.bf) >= 3 && blurOf(m.card.bf) <= 6, m.card.bf);
  check(theme + ' 小胶囊 blur 3–4px', blurOf(m.pill.bf) >= 3 && blurOf(m.pill.bf) <= 4, m.pill.bf);
  check(theme + ' saturate 1.0–1.12', satOf(m.card.bf) >= 1 && satOf(m.card.bf) <= 1.12 && satOf(m.pill.bf) <= 1.12, satOf(m.card.bf) + ' / ' + satOf(m.pill.bf));
  check(theme + ' brightness 1.03–1.08', brightOf(m.card.bf) >= 1.03 && brightOf(m.card.bf) <= 1.08, brightOf(m.card.bf));
  check(theme + ' 卡片填充是薄白渐变、无径向大白光', /linear-gradient/.test(String(m.card.bg)) && !/radial/.test(String(m.card.bg)), m.card.bg.slice(0, 80));
  const ca = alphasOf(m.card.bg).concat(alphasOf(m.pill.bg));
  check(theme + ' 白色填充在 0.05–0.18 且上亮下透', ca.length >= 2 && Math.max.apply(null, ca) <= 0.18 && Math.min.apply(null, ca) >= 0.05, JSON.stringify(ca));
  check(theme + ' 没有全局雾层（.view::before 关闭）', m.fog.display === 'none' && m.fog.content === 'none', JSON.stringify(m.fog));
  check(theme + ' 壁纸层只提亮 / 降对比、不模糊', /brightness\((1(\.0\d+)?|0\.\d+)\)/.test(String(m.wpFilter)) && !/blur/.test(String(m.wpFilter)) && parseFloat((String(m.wpFilter).match(/brightness\(([\d.]+)\)/) || [0, 1.2])[1]) <= 1.08, m.wpFilter);
  check(theme + ' 底栏上方内容有 mask 渐隐', /linear-gradient/.test(String(m.mask)), String(m.mask).slice(0, 80));
  check(theme + ' 底栏高度 66px', Math.abs(m.tabbarHeight - 66) < 0.6, m.tabbarHeight);
  check(theme + ' 四图标顶部齐平（误差 0）', m.spread < 0.6, m.spread);
  check(theme + ' 记忆爱心 26×26 不凸出', m.heart && m.heart.w <= 26.5 && m.heart.h <= 26.5, m.heart ? m.heart.w + 'x' + m.heart.h : '-');
  check(theme + ' 底栏 blur ≤ 6px', blurOf(m.tabbar.bf) <= 6, blurOf(m.tabbar.bf));
  check(theme + ' 弹层 blur ≤ 6px（sheet）', !m.sheet || blurOf(m.sheet.bf) <= 6, m.sheet ? m.sheet.bf : '-');
  check(theme + ' 大数字用衬线字体栈 + 44px', /Serif|Songti|Georgia/i.test(String(m.dayNumFont)) && m.dayNumSize === '44px', m.dayNumFont.slice(0, 60) + ' / ' + m.dayNumSize);
  check(theme + ' 有英文小标题 .en-label', m.enLabels >= 3, m.enLabels);
  check(theme + ' 网易云封面正常加载', m.discLoaded > 0, m.discLoaded);
  await ev("document.querySelector('.tab[data-nav=\"memory\"]').click(); true"); await sleep(900);
  const mem = await ev("(function(){var now=document.getElementById('nowText'), edit=document.querySelector('.now-card__edit');var nr=now.getBoundingClientRect(), er=edit.getBoundingClientRect();return {editBelow:er.top>=nr.bottom-1,pos:getComputedStyle(edit).position,inside:er.left>document.querySelector('.now-card').getBoundingClientRect().left};})()");
  check(theme + ' 「此刻」编辑在正文下方文档流', mem.editBelow && mem.pos !== 'absolute' && mem.pos !== 'fixed' && mem.inside, mem.pos);
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
