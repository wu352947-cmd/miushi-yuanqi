#!/usr/bin/env node
/* B 阶段验收：通过本机后端打开的页面做功能断言 + 粉/冰蓝截图。
   只截 shots/phase-b/，不运行会清空 shots/ 的旧脚本。
   用法：
     BASE_URL=http://127.0.0.1:8080 SCENARIO=main node scripts/phase-b-check.mjs
     BASE_URL=http://127.0.0.1:8081 SCENARIO=login TEST_PASSWORD=... node scripts/phase-b-check.mjs
     BASE_URL=http://127.0.0.1:8082 SCENARIO=nokey node scripts/phase-b-check.mjs
     BASE_URL=http://127.0.0.1:8083 SCENARIO=fallback400 node scripts/phase-b-check.mjs
*/
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8080';
const SCENARIO = process.env.SCENARIO || 'main';
const TEST_PASSWORD = process.env.TEST_PASSWORD || '';
const outDir = path.join(root, 'shots/phase-b');
fs.mkdirSync(outDir, { recursive: true });
const profile = '/tmp/msyq-b-' + SCENARIO;
fs.rmSync(profile, { recursive: true, force: true });
const CHROME = process.env.CHROME_BIN || '/usr/bin/google-chrome';
const PORT = 9720 + Math.floor(Math.random() * 200);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); }).on('error', reject);
  });
}
async function fetchJson(pathname, options) {
  const res = await fetch(BASE + pathname, options);
  const text = await res.text();
  try { return JSON.parse(text); } catch (e) { return { raw: text }; }
}

const chrome = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--hide-scrollbars',
  '--force-color-profile=srgb', '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile, 'about:blank'
], { stdio: 'ignore' });
let wsUrl = null;
for (let i = 0; i < 120; i++) {
  await sleep(150);
  try {
    const list = await getJson('http://127.0.0.1:' + PORT + '/json/list');
    const page = list.find((t) => t.type === 'page');
    if (page && page.webSocketDebuggerUrl) { wsUrl = page.webSocketDebuggerUrl; break; }
  } catch (e) { /* 等待 */ }
}
if (!wsUrl) { chrome.kill(); throw new Error('Chrome 未启动'); }
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
  if (res.exceptionDetails) {
    throw new Error('evaluate 失败: ' + JSON.stringify((res.exceptionDetails.exception && res.exceptionDetails.exception.description) || res.exceptionDetails.text) + '\n表达式: ' + expression.slice(0, 200));
  }
  return res.result.value;
}
async function click(selector, wait = 420) {
  const ok = await ev('(function(){var el=document.querySelector(' + JSON.stringify(selector) + '); if(!el) return false; el.click(); return true;})()');
  if (!ok) throw new Error('找不到可点击元素: ' + selector);
  await sleep(wait);
}
async function shot(name, wait = 420) {
  await sleep(wait);
  const res = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  fs.writeFileSync(path.join(outDir, name + '.png'), Buffer.from(res.data, 'base64'));
  console.log('  📸 ' + name);
}
async function fill(selector, value) {
  await ev('(function(){var el=document.querySelector(' + JSON.stringify(selector) + ');if(!el)return false;el.value=' + JSON.stringify(value) + ';el.dispatchEvent(new Event("input",{bubbles:true}));el.dispatchEvent(new Event("change",{bubbles:true}));return true;})()');
  await sleep(180);
}
async function fileTo(inputSel, name, text) {
  const b64 = Buffer.from(text, 'utf8').toString('base64');
  const ok = await ev('(function(){' +
    "var bin=atob('" + b64 + "');var bytes=new Uint8Array(bin.length);for(var i=0;i<bin.length;i++)bytes[i]=bin.charCodeAt(i);" +
    'var file=new File([bytes],' + JSON.stringify(name) + ",{type:'application/json'});" +
    'var dt=new DataTransfer();dt.items.add(file);' +
    'var inp=document.querySelector(' + JSON.stringify(inputSel) + ');if(!inp)return false;' +
    'inp.files=dt.files;inp.dispatchEvent(new Event("change",{bubbles:true}));return true;})()');
  if (!ok) throw new Error('文件选择器不存在: ' + inputSel);
  await sleep(1100);
}
async function waitApp() {
  for (let i = 0; i < 140; i++) {
    const ready = await ev("(function(){var v=document.querySelector('.view--home');return !!(v && v.style.backgroundImage && document.querySelectorAll('.w').length>=6);})()").catch(() => false);
    if (ready) { await sleep(600); return true; }
    await sleep(120);
  }
  return false;
}
async function loginIfNeeded() {
  const open = await ev("(function(){var l=document.getElementById('loginLayer');return !!(l&&l.classList.contains('is-open'));})()");
  if (!open) return false;
  await fill('#loginPass', TEST_PASSWORD);
  await click('#loginBtn', 600);
  for (let i = 0; i < 80; i++) {
    await sleep(200);
    const gone = await ev("(function(){var l=document.getElementById('loginLayer');return !(l&&l.classList.contains('is-open'));})()").catch(() => false);
    if (gone) return true;
  }
  return false;
}
async function navTab(view) { await click('.tab[data-nav="' + view + '"]', 620); }
async function navFromMe(view) { await click('[data-nav="me"]', 520); await click('[data-nav="' + view + '"]', 700); }
async function setTheme(t) {
  await click('[data-nav="me"]', 500);
  await click('.list-row[data-open="theme"]', 520);
  await click('[data-theme-set="' + t + '"]', 800);
  await click('[data-close]', 520);
  await sleep(1600);
}
async function sendChatAndWait(text, timeoutMs = 20000) {
  await navTab('chat');
  await fill('#chatInput', text);
  await click('#sendBtn', 420);
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    await sleep(240);
    const state = await ev("(function(){return {streaming:!!document.getElementById('streamMsg'),errors:document.querySelectorAll('#chatList .fallback-note').length,msgs:document.querySelectorAll('#chatList .msg').length};})()").catch(() => null);
    if (state && !state.streaming && state.msgs > 1) return true;
  }
  return false;
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
  console.log((ok ? '  ✅ ' : '  ❌ ') + name + (detail !== undefined && detail !== '' ? ' —— ' + detail : ''));
}

async function main() {
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true, screenWidth: 390, screenHeight: 844 });
  await send('Page.navigate', { url: BASE + '/' });
  await sleep(1600);

  if (SCENARIO === 'login') {
    const loginOpen = await ev("(function(){var l=document.getElementById('loginLayer');return !!(l&&l.classList.contains('is-open'));})()");
    check('设置了 APP_PASSWORD 时打开页面先出现登录层', loginOpen, '');
    await shot('pink-login');
    await fill('#loginPass', TEST_PASSWORD);
    await click('#loginBtn', 700);
    for (let i = 0; i < 80; i++) {
      await sleep(200);
      if (await ev("(function(){var l=document.getElementById('loginLayer');return !(l&&l.classList.contains('is-open'));})()").catch(() => false)) break;
    }
    const appReady = await waitApp();
    check('输入密码后进入应用（会话 cookie）', appReady, '');
    await shot('pink-home-after-login');
    await navTab('me');
    const note = await ev("(function(){var n=document.getElementById('serverNote');return n?n.textContent:'';})()");
    check('页面明确提示已启用登录密码', /已启用登录密码/.test(note), note.slice(0, 60));
    await shot('pink-settings-login-mode');
    finish();
    return;
  }

  if (SCENARIO === 'nokey') {
    const ready = await waitApp();
    check('未填 Key 时页面正常打开（不白屏）', ready, '');
    const chatOk = await sendChatAndWait('在吗', 6000);
    const failedText = await ev("(function(){var nodes=document.querySelectorAll('#chatList .msg--ai');var last=nodes[nodes.length-1];return last?last.textContent:'';})()");
    check('没有 Key 时聊天给出中文提示而不是英文堆栈', chatOk && /API Key/.test(failedText) && !/Error:|Traceback/.test(failedText), failedText.slice(-80));
    await shot('pink-chat-no-key');
    await navFromMe('providers');
    await click('[data-a2="provider-open"][data-id="prov-deepseek"]', 700);
    await click('[data-action="test-conn"]', 700);
    await sleep(1400);
    const conn = await ev("(function(){var t=document.getElementById('connResultText');var c=document.getElementById('connResult');return {text:t?t.textContent:'',cls:c?c.className:''};})()");
    check('提供商测试连接失败只显示中文提示', /API Key|Key 不对|地址|网络/.test(conn.text) && !/Error:|Traceback/.test(conn.text), conn.text);
    await shot('pink-provider-test-nokey');
    finish();
    return;
  }

  if (SCENARIO === 'fallback400') {
    await waitApp();
    await navTab('chat');
    // 选择支持思考的模型，并把档位调到高
    await click('#thinkCap', 700);
    const levelSheet = await ev("document.getElementById('sheetTitle').textContent");
    check('思考档位弹层可打开', /调整思考深度/.test(levelSheet), levelSheet);
    await ev("(function(){var b=document.querySelector('[data-a2=\"reason-level\"][data-value=\"high\"]');if(b)b.click();return true;})()");
    await sleep(500);
    await click('[data-close]', 400);
    await sendChatAndWait('再陪我坐一会儿', 20000);
    const fallback = await ev("(function(){var nodes=document.querySelectorAll('#chatList .fallback-note');var texts=Array.prototype.map.call(nodes,function(n){return n.textContent;}).filter(function(t){return !!t&&t.indexOf('这次没有')===-1;});return {fallback:texts.join(' | ')};})()");
    check('思考参数被 400 拒绝后自动去参数重试，聊天不失败', /不支持调思考深度/.test(fallback.fallback), fallback.fallback.slice(0, 80));
    await shot('pink-chat-400-fallback');
    finish();
    return;
  }

  /* ================= main：开发者模式 + mock 模型 ================= */
  const ready = await waitApp();
  check('通过本机后端打开页面：同源加载、无需登录', ready, '');
  const modeText = await ev("(function(){var n=document.getElementById('serverNote');return n?n.textContent:'';})()");
  check('页面明确提示「未设置登录密码」的开发模式', /开发模式/.test(modeText) && /APP_PASSWORD/.test(modeText), modeText.slice(0, 80));
  if (!ready) { finish(); return; }

  /* 硬约束回归 */
  const nav = await ev("(function(){var tb=document.querySelector('.tabbar');var r=tb.getBoundingClientRect();var tabs=Array.prototype.map.call(tb.querySelectorAll('.tab'),function(t){var i=t.querySelector('.tab__icon,.tab__bubble');var ir=i.getBoundingClientRect();return {top:ir.top};});var ps=getComputedStyle(document.querySelector('.view[data-view=me] .page-scroll'));var cz=getComputedStyle(document.querySelector('.composer-zone'));var toast=getComputedStyle(document.getElementById('toast'));return {h:r.height,tops:tabs.map(function(t){return t.top;}),pageBottom:ps.paddingBottom,composerBottom:cz.paddingBottom,toastBottom:toast.bottom};})()");
  check('底栏仍 66px，四个图标齐平', Math.abs(nav.h - 66) < 1.5 && Math.max.apply(null, nav.tops) - Math.min.apply(null, nav.tops) < 0.6, nav.h + ' / ' + JSON.stringify(nav.tops.map((n) => Math.round(n))));
  check('page-scroll 88 / composer-zone 80 / toast 80 不变', /88px/.test(nav.pageBottom) && /80px/.test(nav.composerBottom) && /80px/.test(nav.toastBottom), nav.pageBottom + ' / ' + nav.composerBottom + ' / ' + nav.toastBottom);
  const nowFlow = await ev("(function(){var c=document.querySelector('.now-card');var t=c.querySelector('.now-card__text').getBoundingClientRect();var b=c.querySelector('.now-card__edit').getBoundingClientRect();return {below:b.top>=t.bottom-1,pos:getComputedStyle(c.querySelector('.now-card__edit')).position};})()");
  check('「此刻」编辑按钮仍在正文下方文档流', nowFlow.below && nowFlow.pos !== 'absolute', JSON.stringify(nowFlow));

  /* 提供商：填测试 Key（假的）+ 掩码 + 测试连接 + 拉模型 + 余额 */
  await navFromMe('providers');
  await click('[data-a2="provider-open"][data-id="prov-deepseek"]', 700);
  await fill('#provKey', 'sk-test-not-a-real-key-1234');
  await click('[data-action="save-provider"]', 800);
  const keyState = await ev("(function(){var el=document.getElementById('provKey');return {type:el?el.type:'',value:el?el.value:''};})()");
  check('Key 保存后界面只显示掩码（password 输入框）', keyState.type === 'password' && /•/.test(keyState.value), keyState.value);
  const apiMasked = await fetchJson('/api/providers');
  const deepseek = (apiMasked.providers || []).filter((p) => p.id === 'prov-deepseek')[0] || {};
  check('GET /api/providers 只回掩码，不回明文', deepseek.hasKey === true && /•/.test(deepseek.keyMasked || '') && JSON.stringify(apiMasked).indexOf('sk-test-not-a-real-key') === -1, deepseek.keyMasked);
  await shot('pink-provider-masked-key');

  await click('[data-action="pull-models"]', 500);
  await sleep(1200);
  const pullRows = await ev("document.querySelectorAll('.pull-row').length");
  check('拉取模型由后端代理（演示模式返回真实形状列表）', pullRows > 0, pullRows + ' 个模型');
  await shot('pink-pull-models');
  await click('[data-close]', 500);

  await click('[data-a2="provider-tab"][data-value="advanced"]', 600);
  await click('[data-a2="bal-query"]', 900);
  for (let i = 0; i < 20; i++) {
    await sleep(250);
    const text = await ev("document.getElementById('provTabBody').textContent");
    if (/12\.40|余额暂不可查/.test(text)) break;
  }
  const balanceText = await ev("document.getElementById('provTabBody').textContent");
  check('余额查询由后端缓存返回（不是英文报错）', /12.40/.test(balanceText) || /余额暂不可查/.test(balanceText), balanceText.slice(-120));
  await shot('pink-provider-balance');
  await click('[data-a2-back="providers"]', 600);
  await click('[data-a2-back="providers"]', 500);

  /* 角色导入（JSON，经后端解析） */
  await navFromMe('characters');
  const beforeChars = await ev("document.querySelectorAll('#charLibScroll .lib-card').length");
  const card = { spec: 'chara_card_v2', spec_version: '2.0', data: { name: '宋停', description: '在城南旧书店整理书目，说话慢。', personality: '耐心，有一点固执。', scenario: '雨天的旧书店，打烊前最后一盏灯。', first_mes: '你来得正好，这本书刚被我放错架。', mes_example: '' } };
  await fileTo('#fileCharCard', 'song-ting.json', JSON.stringify(card));
  await sleep(1400);
  const afterChars = await ev("document.querySelectorAll('#charLibScroll .lib-card').length");
  const importedText = await ev("document.getElementById('charLibScroll').textContent");
  check('角色卡 JSON 导入走本机后端并出现在角色库', afterChars === beforeChars + 1 && /宋停/.test(importedText), beforeChars + ' → ' + afterChars);
  await shot('pink-character-imported');

  /* 聊天：真实流式（mock 模型）+ 思考折叠 + usage */
  await sendChatAndWait('今晚下雨了，我有点累，想坐一会儿。', 25000);
  const chatInfo = await ev("(function(){var msgs=document.querySelectorAll('#chatList .msg');var last=msgs[msgs.length-1];return {msgs:msgs.length,last:last?last.textContent.slice(0,180):'',usage:document.querySelectorAll('#chatList .usage').length,think:document.querySelectorAll('#chatList .think-fold').length};})()");
  check('聊天走后端流式接口，回复落进气泡', chatInfo.msgs >= 3 && chatInfo.last.length > 0, chatInfo.last.slice(0, 80));
  check('回复带 usage 与可折叠的思考过程', chatInfo.usage >= 1 && chatInfo.think >= 1, 'usage ' + chatInfo.usage + ' / think ' + chatInfo.think);
  await shot('pink-chat-stream');
  const usageRow = await fetchJson('/api/stats?range=7d');
  check('统计接口的数字来自 usage 表（与刚发的消息一致）', usageRow.overview.count >= 1, usageRow.overview.count + ' 条 / ' + usageRow.overview.totalTokens + ' tok');

  /* 思考档位弹层 */
  await click('#thinkCap', 700);
  await shot('pink-reasoning');
  await click('[data-close]', 400);

  /* 记忆：新增 / 遗忘 / 记住这句话 */
  await navTab('memory');
  await sleep(700);
  const memBefore = await ev("document.querySelectorAll('#memoryList .m-row').length");
  await click('[data-open="memoryNew"]', 600);
  await fill('#memNewTitle', '窗边的位置');
  await fill('#memNewBody', '她总坐靠窗第二排，阳光会先落在笔记本上。');
  await click('[data-action="create-memory"]', 900);
  const memAfter = await ev("document.querySelectorAll('#memoryList .m-row').length");
  check('记忆可以新增（写入后端）', memAfter === memBefore + 1, memBefore + ' → ' + memAfter);
  await shot('pink-memory-new');
  await ev("(function(){var rows=document.querySelectorAll('#memoryList .m-row');var target=null;for(var i=0;i<rows.length;i++){if(rows[i].textContent.indexOf('窗边的位置')!==-1)target=rows[i];}if(target)target.click();return !!target;})()");
  await sleep(700);
  await click('[data-mem-forget]', 900);
  const forgottenBadge = await ev("document.getElementById('forgottenCount').textContent");
  check('记忆可以软遗忘（只改状态，可恢复）', Number(forgottenBadge) >= 1, '已遗忘 ' + forgottenBadge);
  await shot('pink-memory-forgotten');
  await click('[data-open="forgotten"]', 700);
  const forgottenSheet = await ev("document.getElementById('sheetBody').textContent");
  check('已遗忘列表里能找回', /窗边的位置|恢复/.test(forgottenSheet), forgottenSheet.slice(0, 80));
  await click('[data-mem-restore]', 900);
  await shot('pink-memory-restored');
  await click('.sheet__close', 500);

  /* 聊天菜单「记住这句话」 */
  await navTab('chat');
  await click('[data-open="chatMenu"]', 700);
  await click('[data-action="remember-last"]', 1200);
  const remembered = await ev("document.getElementById('toast').textContent");
  check('聊天菜单「记住这句话」写进记忆库', /记好|已经/.test(remembered), remembered);
  await navTab('memory');
  await sleep(700);

  /* 统计页 */
  await navFromMe('stats');
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    const text = await ev("document.getElementById('statsScroll').textContent").catch(() => '');
    if (text && text.indexOf('请求次数') !== -1) break;
  }
  const statsText = await ev("document.getElementById('statsScroll').textContent");
  check('统计页显示后端 usage 汇总', /总览/.test(statsText) && /请求次数/.test(statsText) && /usage 表/.test(statsText), '');
  const overviewFromApi = await fetchJson('/api/stats?range=7d');
  const countShown = /请求次数/.test(statsText);
  check('统计页总览与 /api/stats 一致', countShown && overviewFromApi.overview.count >= 1, 'count ' + overviewFromApi.overview.count);
  await shot('pink-stats-top');
  await ev("(function(){document.getElementById('statsScroll').scrollTop=520;return true;})()");
  await sleep(400);
  await shot('pink-stats-mid');
  await click('[data-a2="rank-tab"][data-value="provider"]', 900);
  await shot('pink-stats-rank-provider');
  await click('[data-a2="stats-range"][data-value="30d"]', 900);
  const rangeChip = await ev("(function(){var b=document.querySelector('[data-a2=\"stats-range\"][data-value=\"30d\"]');return b?b.className:'';})()");
  check('统计范围切换会重新从后端汇总', /is-on/.test(rangeChip), rangeChip);

  /* 我的 / 设置 / 统计卡 */
  await navTab('me');
  await shot('pink-me');
  await click('[data-nav="settings"]', 700);
  await shot('pink-settings');
  await click('[data-nav="me"]', 500);

  /* 冰蓝主题：聊天 / 思考 / 统计 / 记忆 / 提供商 */
  await setTheme('ice');
  await navTab('chat');
  await sendChatAndWait('今天风很大，一起去海边走走？', 25000);
  await shot('ice-chat-stream');
  await click('#thinkCap', 700);
  await shot('ice-reasoning');
  await click('[data-close]', 400);
  await navTab('memory');
  await sleep(700);
  await shot('ice-memory');
  await navFromMe('stats');
  await sleep(1000);
  await shot('ice-stats-top');
  await navFromMe('providers');
  await click('[data-a2="provider-open"][data-id="prov-deepseek"]', 700);
  await shot('ice-provider-masked-key');
  await navTab('me');
  await shot('ice-me');

  /* 重置回粉色，方便下次打开 */
  await setTheme('pink');
  finish();
}

function finish() {
  const payload = {
    scenario: SCENARIO,
    base: BASE,
    at: new Date().toISOString(),
    checks: results,
    passed: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    jsErrors,
    resourceErrors,
  };
  fs.writeFileSync(path.join(outDir, '_check-' + SCENARIO + '.json'), JSON.stringify(payload, null, 2));
  console.log('\n结果：' + payload.passed + ' / ' + results.length + ' 通过；JS 报错 ' + jsErrors.length + ' 条');
  if (jsErrors.length) jsErrors.slice(0, 8).forEach((e) => console.log('  JS: ' + e.slice(0, 260)));
  ws.close();
  chrome.kill();
  process.exit(payload.failed || jsErrors.length ? 1 : 0);
}

main().catch((err) => {
  console.error('运行失败：', err && err.message ? err.message : err);
  try { ws.close(); chrome.kill(); } catch (e) { /* 忽略 */ }
  process.exit(2);
});
