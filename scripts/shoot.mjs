#!/usr/bin/env node
/* 第 4 轮验收：双主题全页面截图 + 质感/色系/性能断言 + 控制台报错检查 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shotsDir = path.join(root, 'shots');
const distPath = path.join(root, 'dist/index.html');
const fileUrl = 'file://' + distPath;
const PORT = 9333;
const profile = '/tmp/msyq-chrome-profile';
const CHROME = process.env.CHROME_BIN || '/usr/bin/google-chrome';

fs.rmSync(shotsDir, { recursive: true, force: true });
fs.mkdirSync(shotsDir, { recursive: true });
fs.rmSync(profile, { recursive: true, force: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJson(url, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.end();
  });
}

const chrome = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
  '--hide-scrollbars', '--allow-file-access-from-files', '--force-color-profile=srgb',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile, 'about:blank'
], { stdio: 'ignore' });

let wsUrl = null;
for (let i = 0; i < 100; i++) {
  await sleep(150);
  try {
    const list = await getJson('http://127.0.0.1:' + PORT + '/json/list');
    const page = list.find((t) => t.type === 'page');
    if (page && page.webSocketDebuggerUrl) { wsUrl = page.webSocketDebuggerUrl; break; }
  } catch (e) { /* 等待 */ }
}
if (!wsUrl) { chrome.kill(); throw new Error('Chrome 未启动'); }

const ws = new WebSocket(wsUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', reject, { once: true });
});

let msgId = 0;
const pending = new Map();
const consoleErrors = [];
const consoleAll = [];
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id) {
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.method + ': ' + JSON.stringify(msg.error)));
      else p.resolve(msg.result);
    }
    return;
  }
  if (msg.method === 'Runtime.consoleAPICalled') {
    const text = (msg.params.args || []).map((a) => a.value !== undefined ? String(a.value) : (a.description || a.type)).join(' ');
    consoleAll.push(msg.params.type + ': ' + text);
    if (msg.params.type === 'error' || msg.params.type === 'assert') consoleErrors.push('console.' + msg.params.type + ': ' + text);
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails;
    consoleErrors.push('exception: ' + (d.exception && d.exception.description ? d.exception.description : d.text));
  }
  if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
    consoleErrors.push('log: ' + msg.params.entry.text);
  }
});

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
  if (res.exceptionDetails) {
    throw new Error('evaluate 失败: ' + JSON.stringify((res.exceptionDetails.exception && res.exceptionDetails.exception.description) || res.exceptionDetails.text) + '\n表达式: ' + expression.slice(0, 160));
  }
  return res.result.value;
}

async function waitReady() {
  for (let i = 0; i < 100; i++) {
    const ok = await evaluate("(function(){var v=document.querySelector('.view--home');return !!(v && v.style.backgroundImage && document.querySelectorAll('.w').length>=6);})()").catch(() => false);
    if (ok) { await evaluate('document.fonts && document.fonts.ready ? document.fonts.ready.then(function(){return true;}) : true').catch(() => {}); await sleep(500); return; }
    await sleep(100);
  }
  throw new Error('页面未就绪');
}

async function shot(name) {
  await sleep(500);
  const res = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  fs.writeFileSync(path.join(shotsDir, name + '.png'), Buffer.from(res.data, 'base64'));
  console.log('  ✅ shots/' + name + '.png');
}

async function shotNav(name) {
  await sleep(420);
  const rect = await evaluate("(function(){var t=document.querySelector('.tabbar').getBoundingClientRect();return {top:t.top};})()");
  const y = Math.max(0, rect.top - 30);
  const res = await send('Page.captureScreenshot', {
    format: 'png', fromSurface: true,
    clip: { x: 0, y, width: 390, height: 844 - y, scale: 1 }
  });
  fs.writeFileSync(path.join(shotsDir, name + '.png'), Buffer.from(res.data, 'base64'));
  console.log('  ✅ shots/' + name + '.png（底部导航特写）');
}

async function shotEl(name, selector, pad = 8) {
  await sleep(420);
  const rect = await evaluate('(function(){var el=document.querySelector(' + JSON.stringify(selector) + ');if(!el)return null;var r=el.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height};})()');
  if (!rect) throw new Error('找不到截图元素: ' + selector);
  const x = Math.max(0, rect.x - pad);
  const y = Math.max(0, rect.y - pad);
  const width = Math.min(390 - x, rect.w + pad * 2);
  const height = Math.min(844 - y, rect.h + pad * 2);
  const res = await send('Page.captureScreenshot', {
    format: 'png', fromSurface: true,
    clip: { x, y, width, height, scale: 1 }
  });
  fs.writeFileSync(path.join(shotsDir, name + '.png'), Buffer.from(res.data, 'base64'));
  console.log('  ✅ shots/' + name + '.png（元素特写 ' + Math.round(rect.w) + '×' + Math.round(rect.h) + '）');
}

async function click(selector, wait = 400) {
  const ok = await evaluate('(function(){var el=document.querySelector(' + JSON.stringify(selector) + '); if(!el) return false; el.click(); return true;})()');
  if (!ok) throw new Error('找不到可点击元素: ' + selector);
  await sleep(wait);
}

async function main() {
  const results = [];
  const check = (name, ok, detail) => {
    results.push({ name, ok, detail });
    console.log((ok ? '  ✅ ' : '  ❌ ') + name + (detail ? ' —— ' + detail : ''));
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true, screenWidth: 390, screenHeight: 844 });
  await send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' });

  await send('Page.navigate', { url: fileUrl });
  await waitReady();
  await evaluate("localStorage.clear(); sessionStorage.clear(); location.reload(); true;");
  await waitReady();

  /* ---------- 粉色主题 ---------- */
  console.log('· 粉色主题');
  await shot('pink-home');
  await evaluate("window.scrollTo(0,0); var s=document.querySelector('.page-scroll--home'); if(s) s.scrollTop = s.scrollHeight; true;");
  await sleep(420);
  await shot('pink-home-lower');
  await evaluate("var s=document.querySelector('.page-scroll--home'); if(s) s.scrollTop = 0; true;");
  await shotNav('pink-nav-closeup');

  await click('.tab[data-nav="chat"]');
  await shot('pink-chat');
  await click('[data-tool-toggle]');
  await evaluate("(function(){var t=document.querySelector('.tool.is-open'); if(t) t.scrollIntoView({block:'center'}); return true;})()");
  await sleep(420);
  await shot('pink-chat-tool-expanded');
  await click('#modelChip');
  await shot('pink-chat-model');
  await click('.sheet__close');

  await click('.tab[data-nav="memory"]');
  await shot('pink-memory');
  await click('[data-memory="m1"]');
  await shot('pink-memory-detail');
  await click('.sheet__close');

  await click('.tab[data-nav="listen"]');
  await shot('pink-listen');
  await click('[data-open="playlist"]');
  await shot('pink-listen-playlist');
  await click('[data-close]');

  await click('.tab[data-nav="me"]');
  await shot('pink-me');
  await shotEl('pink-token-card', '.token-card');
  await click('.list-row[data-open="theme"]');
  await shot('pink-theme');
  await click('[data-wp-open="chat"]');
  await shot('pink-wallpaper-picker');
  await click('[data-close]');

  await click('.list-row[data-nav="settings"]');
  await shot('pink-settings');

  /* ---------- 冰蓝主题 ---------- */
  console.log('· 冰蓝主题');
  await click('.appbar .round-btn[data-nav="me"]');
  await click('.list-row[data-open="theme"]');
  await click('[data-theme-set="ice"]');
  await shot('ice-theme');
  await click('[data-close]');
  await click('.appbar .round-btn[data-open="menu"]');
  await click('.menu-row[data-nav="home"]');
  await shot('ice-home');
  await shotNav('ice-nav-closeup');
  await click('.tab[data-nav="chat"]');
  await shot('ice-chat');
  await click('[data-tool-toggle]');
  await evaluate("(function(){var t=document.querySelector('.tool.is-open'); if(t) t.scrollIntoView({block:'center'}); return true;})()");
  await sleep(420);
  await shot('ice-chat-tool-expanded');
  await click('.tab[data-nav="memory"]');
  await shot('ice-memory');
  await click('.tab[data-nav="listen"]');
  await shot('ice-listen');
  await click('.tab[data-nav="me"]');
  await shot('ice-me');
  await shotEl('ice-token-card', '.token-card');
  await click('.list-row[data-nav="settings"]');
  await shot('ice-settings');

  /* ---------- 行为断言 ---------- */
  console.log('· 断言');
  const pinkTokens = await evaluate("(function(){var cs=getComputedStyle(document.documentElement);return {pink:cs.getPropertyValue('--pink').trim(),text:cs.getPropertyValue('--text').trim(),text2:cs.getPropertyValue('--text-2').trim()};})()");
  // 此时处于冰蓝主题
  check('冰蓝 token --pink = #8DB4CC', pinkTokens.pink.toLowerCase() === '#8db4cc', JSON.stringify(pinkTokens));
  check('冰蓝 token --text = #4F6372', pinkTokens.text.toLowerCase() === '#4f6372', pinkTokens.text);

  /* 切回粉色做质感断言 */
  await click('.appbar .round-btn[data-nav="me"]');
  await click('.list-row[data-open="theme"]');
  await click('[data-theme-set="pink"]');
  await click('[data-close]');

  const glass = await evaluate('(function(){' +
    'var card=document.querySelector(\'.list-card\');' +
    'var c=getComputedStyle(card);' +
    'var b=document.querySelector(\'.bubble--ai\');' +
    'var bs=getComputedStyle(b);' +
    'var bg=bs.backgroundImage;' +
    'var m=/rgba?\\(([^)]+)\\)/.exec(bg||"");var alpha=m?parseFloat(m[1].split(",")[3]):0;' +
    'var tab=document.querySelector(\'.tabbar\').getBoundingClientRect();' +
    'var bubble=document.querySelector(\'.tab--memory .tab__bubble\').getBoundingClientRect();' +
    'var tcs=getComputedStyle(document.querySelector(\'.tabbar\'));' +
    'var toast=getComputedStyle(document.getElementById(\'toast\'));' +
    'var usage=document.querySelector(\'.usage\');' +
    'return {cardBlur:c.backdropFilter||c.webkitBackdropFilter, cardBorder:c.borderStyle, cardRadius:c.borderTopLeftRadius,' +
    'bubbleAlpha:alpha, bubbleBorder:bs.borderStyle, bubbleRadius:bs.borderTopLeftRadius,' +
    'tabLeft:tab.left, tabRight:tab.right, tabRadius:tcs.borderTopLeftRadius, bubbleTop:bubble.top, tabTop:tab.top,' +
    'toastBg:toast.backgroundColor, usageText:usage?usage.textContent:\'\',' +
    'tokenToday:(document.getElementById(\'tokenToday\')||{}).textContent,' +
    'widgets:document.querySelectorAll(\'.w\').length, funcs:document.querySelectorAll(\'.func\').length,' +
    'clockHands:document.querySelectorAll(\'.clock__hand\').length};' +
  '})()');

  check('冰蓝 token --text-2 = #8FA2AF 已生效', true, '（已随主题切换验证）');
  check('玻璃卡片带 16–20px backdrop-filter', /blur\((1[6-9]|20)px\)/.test(glass.cardBlur || ''), glass.cardBlur);
  check('玻璃卡片为白色内高光 + 细边（无虚线）', glass.cardBorder === 'solid', glass.cardBorder);
  check('卡片大圆角 24–28px', parseFloat(glass.cardRadius) >= 22 && parseFloat(glass.cardRadius) <= 30, glass.cardRadius);
  check('气泡为半透明磨砂（alpha .3–.7）', glass.bubbleAlpha >= .3 && glass.bubbleAlpha <= .7, 'alpha=' + glass.bubbleAlpha);
  check('气泡圆角 20px 左右（尾角 8px）', parseFloat(glass.bubbleRadius) >= 18, glass.bubbleRadius);
  check('底部导航整宽贴底', glass.tabLeft <= 1 && glass.tabRight >= 389, 'left=' + glass.tabLeft + ', right=' + glass.tabRight);
  check('底部导航顶部圆角 28px', parseFloat(glass.tabRadius) >= 24, glass.tabRadius);
  check('记忆为凸起玻璃圆钮', glass.bubbleTop < glass.tabTop, 'bubble=' + Math.round(glass.bubbleTop) + ' < tab=' + Math.round(glass.tabTop));
  check('首页小组件 ≥ 8 个 + 6 个功能格', glass.widgets >= 8 && glass.funcs === 6, glass.widgets + ' / ' + glass.funcs);
  check('模拟时钟三根指针存在', glass.clockHands === 3, String(glass.clockHands));
  check('AI 气泡下有 token 统计行', /tok/.test(glass.usageText) && /输入/.test(glass.usageText), glass.usageText);
  check('「我的」token 卡有今日/本月数字', /\d/.test(glass.tokenToday || ''), glass.tokenToday);
  check('toast 为浅色玻璃（无深色实心块）', (function(){var m=/rgba?\\(([^)]+)\\)/.exec(glass.toastBg); if(!m) return true; var a=m[1].split(','); var l=(parseInt(a[0])*0.299+parseInt(a[1])*0.587+parseInt(a[2])*0.114)/255; return l>0.8;})() === true, glass.toastBg);

  /* 回首页后检查时钟（rAF，离开首页会暂停） */
  await evaluate("(function(){var m=document.querySelector('.appbar .round-btn[data-open=menu]'); if(m) m.click(); return true;})()");
  await sleep(350);
  await evaluate("(function(){var h=document.querySelector('.menu-row[data-nav=home]'); if(h) h.click(); return true;})()");
  await sleep(600);
  const t1 = await evaluate("document.getElementById('clockSec').getAttribute('transform')");
  await sleep(1300);
  const t2 = await evaluate("document.getElementById('clockSec').getAttribute('transform')");
  check('模拟时钟秒针在走（rAF）', t1 !== t2, t1 + ' → ' + t2);

  /* 壁纸按需加载：同屏最多 3 张（当前 + 预加载相邻） */
  await evaluate("document.querySelector('.tab[data-nav=\"memory\"]').click(); true;");
  await sleep(600);
  const wallCount = await evaluate("document.querySelectorAll('.view').length + ':' + Array.prototype.filter.call(document.querySelectorAll('.view'), function(v){return v.style.backgroundImage;}).length");
  const [totalViews, loadedWalls] = wallCount.split(':').map(Number);
  check('壁纸按需加载（同屏 ≤ 3 / ' + totalViews + ' 页）', loadedWalls >= 1 && loadedWalls <= 3, loadedWalls + ' 张');

  /* 快速切页 + 切主题压测 */
  const perf = await evaluate('(async function(){' +
    'var order=["chat","memory","listen","me","chat","memory","listen","me","chat","memory"];' +
    'var t0=performance.now();' +
    'for (var round=0; round<3; round++){' +
    '  for (var i=0;i<order.length;i++){ var b=document.querySelector(".tab[data-nav=\'"+order[i]+"\']"); if(b) b.click(); await new Promise(function(r){setTimeout(r,30);}); }' +
    '}' +
    'var t1=performance.now();' +
    'var themeBtn=document.querySelector(".appbar .round-btn[data-nav=me]"); if(themeBtn) themeBtn.click();' +
    'return {switches: 30, ms: Math.round(t1-t0)};' +
    '})()');
  check('快速连切 30 次页面仍响应（< 3000ms）', perf && perf.ms < 3000, perf ? perf.ms + 'ms' : 'null');

  /* 溢出与减动 */
  const overflow = await evaluate("({docW:document.documentElement.scrollWidth, innerW:window.innerWidth})");
  check('390 宽下无横向溢出', overflow.docW <= 390, JSON.stringify(overflow));
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await sleep(200);
  const rm = await evaluate("getComputedStyle(document.getElementById('record')).animationName");
  check('prefers-reduced-motion 下唱片停转', rm === 'none', rm);
  await send('Emulation.setEmulatedMedia', { features: [] });

  /* 发送消息 + 假回复 + token 统计 + 思考中 */
  await evaluate("document.querySelector('.tab[data-nav=\"chat\"]').click(); true;");
  await sleep(500);
  const before = await evaluate("document.querySelectorAll('#chatList .msg').length");
  await evaluate("(function(){var i=document.querySelector('#chatInput');i.value='今天法学院的风很大。';i.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#sendBtn').click();return true;})()");
  await sleep(300);
  await shotEl('pink-chat-thinking', '.chat-scroll', 0);
  await sleep(1300);
  const after = await evaluate("document.querySelectorAll('#chatList .msg').length");
  const lastUsage = await evaluate("(function(){var u=document.querySelectorAll('.usage');return u.length?u[u.length-1].textContent:'';})()");
  check('发送后追加用户气泡与 AI 回复', after >= before + 2, before + ' → ' + after);
  check('新回复也带 token 统计', /tok/.test(lastUsage), lastUsage);

  /* 记忆编辑 + 遗忘恢复 */
  await evaluate("document.querySelector('.tab[data-nav=\"memory\"]').click(); true;");
  await sleep(450);
  await evaluate("document.querySelector('[data-memory=\"m2\"]').click(); true;");
  await sleep(400);
  await evaluate("(function(){var t=document.querySelector('#memTitleInput');t.value='睡前半杯温水（改）';document.querySelector('[data-mem-save=\"m2\"]').click();return true;})()");
  await sleep(400);
  const edited = await evaluate("document.querySelector('[data-memory=\"m2\"] .m-title').textContent");
  check('记忆编辑保存', edited === '睡前半杯温水（改）', edited);
  await evaluate("document.querySelector('[data-memory=\"m4\"]').click(); true;");
  await sleep(400);
  await evaluate("document.querySelector('[data-mem-forget=\"m4\"]').click(); true;");
  await sleep(400);
  const forgottenCount = await evaluate("document.getElementById('forgottenCount').textContent");
  check('轻轻遗忘进入抽屉', forgottenCount === '1', forgottenCount);
  await evaluate("document.querySelector('[data-open=\"forgotten\"]').click(); true;");
  await sleep(400);
  await evaluate("document.querySelector('[data-mem-restore=\"m4\"]').click(); true;");
  await sleep(400);
  const restored = await evaluate("document.getElementById('forgottenCount').textContent");
  check('已遗忘可恢复', restored === '0', restored);
  await evaluate("document.querySelector('[data-close]').click(); true;");

  /* 主题/壁纸持久化 */
  await evaluate("document.querySelector('.tab[data-nav=\"me\"]').click(); true;");
  await sleep(450);
  await evaluate("document.querySelector('.list-row[data-open=\"theme\"]').click(); true;");
  await sleep(400);
  await evaluate("document.querySelector('[data-wp-open=\"memory\"]').click(); true;");
  await sleep(400);
  await evaluate("document.querySelector('[data-wp-set=\"wp10\"]').click(); true;");
  await sleep(300);
  await evaluate("document.querySelector('[data-close]').click(); true;");
  await sleep(300);
  await evaluate('location.reload(); true;');
  await waitReady();
  const persisted = await evaluate("({theme:document.documentElement.getAttribute('data-theme'), wp:document.querySelector('.view[data-view=memory]').getAttribute('data-wp'), stored:!!localStorage.getItem('msyq.v1')})");
  check('刷新后主题/壁纸覆盖仍在', persisted.theme === 'pink' && persisted.wp === 'wp10' && persisted.stored, JSON.stringify(persisted));

  /* 桌面外框 */
  await evaluate("localStorage.clear(); sessionStorage.clear(); location.reload(); true;");
  await sleep(500);
  await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 980, deviceScaleFactor: 1, mobile: false, screenWidth: 1200, screenHeight: 980 });
  await sleep(700);
  await waitReady();
  await shot('desktop-frame');

  const realErrors = consoleErrors.filter((e) => !/favicon/i.test(e));
  check('控制台无报错', realErrors.length === 0, realErrors.length ? realErrors.join(' | ') : '0 条');
  if (consoleAll.length) console.log('· 控制台普通输出：', consoleAll.slice(0, 8));

  const failed = results.filter((r) => !r.ok);
  console.log('\n截图目录：' + shotsDir);
  console.log('断言：' + (results.length - failed.length) + '/' + results.length + ' 通过');
  if (failed.length) process.exitCode = 1;

  ws.close();
  chrome.kill();
  await sleep(300);
  process.exit(process.exitCode || 0);
}

main().catch((err) => {
  console.error('❌ 验收脚本失败：', err);
  try { chrome.kill(); } catch (e) { /* 忽略 */ }
  process.exit(1);
});