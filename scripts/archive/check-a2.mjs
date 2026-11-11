#!/usr/bin/env node
/* A2 阶段自查：功能断言 + 粉/冰蓝双主题截图（390×844）
   只检查 dist/index.html，不改任何数据；截图写到 shots/phase-a2/。
   独立于 scripts/shoot.mjs，不清理 shots/ 其他目录。 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';

const root = '/workspace/miushi-yuanqi';
const outDir = root + '/shots/phase-a2';
const CHROME = process.env.CHROME_BIN || '/usr/bin/google-chrome';
const PORT = 9533;
const profile = '/tmp/msyq-a2-check';
fs.rmSync(profile, { recursive: true, force: true });
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}
const chrome = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
  '--hide-scrollbars', '--allow-file-access-from-files', '--force-color-profile=srgb',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile, 'about:blank'
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
    const text = (m.params.args || []).map((a) => a.value !== undefined ? String(a.value) : (a.description || a.type)).join(' ');
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
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function ev(expression) {
  const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
  if (res.exceptionDetails) {
    throw new Error('evaluate 失败: ' + JSON.stringify((res.exceptionDetails.exception && res.exceptionDetails.exception.description) || res.exceptionDetails.text) + '\n' + expression.slice(0, 180));
  }
  return res.result.value;
}
async function click(selector, wait = 380) {
  const ok = await ev('(function(){var el=document.querySelector(' + JSON.stringify(selector) + '); if(!el) return false; el.click(); return true;})()');
  if (!ok) throw new Error('找不到可点击元素: ' + selector);
  await sleep(wait);
}
async function shot(name, wait = 480) {
  await sleep(wait);
  const res = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  fs.writeFileSync(outDir + '/' + name + '.png', Buffer.from(res.data, 'base64'));
  console.log('  📸 ' + name);
}
async function shotNav(name) {
  await sleep(420);
  const rect = await ev("(function(){var t=document.querySelector('.tabbar').getBoundingClientRect();return {top:t.top};})()");
  const y = Math.max(0, rect.top - 34);
  const res = await send('Page.captureScreenshot', { format: 'png', fromSurface: true, clip: { x: 0, y, width: 390, height: 844 - y, scale: 1 } });
  fs.writeFileSync(outDir + '/' + name + '.png', Buffer.from(res.data, 'base64'));
  console.log('  📸 ' + name + '（底栏特写）');
}
async function scrollTo(sel, top) {
  await ev('(function(){var el=document.querySelector(' + JSON.stringify(sel) + '); if(el) el.scrollTop=' + top + '; return true;})()');
  await sleep(320);
}
async function fileTo(inputSel, name, obj) {
  const b64 = Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');
  const ok = await ev('(function(){' +
    "var text=decodeURIComponent(escape(atob('" + b64 + "')));" +
    "var file=new File([text]," + JSON.stringify(name) + ",{type:'application/json'});" +
    'var dt=new DataTransfer();dt.items.add(file);' +
    'var inp=document.querySelector(' + JSON.stringify(inputSel) + ');if(!inp)return false;' +
    'inp.files=dt.files;inp.dispatchEvent(new Event("change",{bubbles:true}));return true;})()');
  if (!ok) throw new Error('文件选择器不存在: ' + inputSel);
  await sleep(800);
}
async function waitReady() {
  for (let i = 0; i < 120; i++) {
    const ok = await ev("(function(){var v=document.querySelector('.view--home');return !!(v && v.style.backgroundImage && document.querySelectorAll('.w').length>=6);})()").catch(() => false);
    if (ok) { await sleep(500); return; }
    await sleep(100);
  }
  throw new Error('页面未就绪');
}
async function navTab(view) { await click('.tab[data-nav="' + view + '"]', 520); }
async function navFromMe(view) { await click('[data-nav="me"]', 420); await click('[data-nav="' + view + '"]', 560); }
async function setTheme(t) {
  await click('[data-nav="me"]', 420);
  await click('.list-row[data-open="theme"]', 450);
  await click('[data-theme-set="' + t + '"]', 650);
  await click('[data-close]', 450);
  await sleep(2300);
}
async function openModelPicker() { await click('#modelChip', 620); }
async function pickSearchModel(search, id) {
  await ev("(function(){var i=document.getElementById('mpSearch');i.value=" + JSON.stringify(search) + ";i.dispatchEvent(new Event('input',{bubbles:true}));return true;})()");
  await sleep(350);
  await click('[data-a2="model-pick"][data-id="' + id + '"]', 900);
}
async function clearModelSearch() {
  await ev("(function(){var i=document.getElementById('mpSearch');i.value='';i.dispatchEvent(new Event('input',{bubbles:true}));return true;})()");
  await sleep(300);
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
  await send('Page.navigate', { url: 'file://' + root + '/dist/index.html' });
  await waitReady();
  await ev('localStorage.clear();sessionStorage.clear();location.reload();true;');
  await waitReady();
  check('页面启动、首页 6+ 小组件', true, '');

  /* ============ A 阶段回归与硬约束 ============ */
  console.log('· A 阶段回归 / 硬约束');
  const nav = await ev("(function(){var tb=document.querySelector('.tabbar');var r=tb.getBoundingClientRect();" +
    "var tabs=Array.prototype.map.call(tb.querySelectorAll('.tab'),function(t){var i=t.querySelector('.tab__icon,.tab__bubble');var ir=i.getBoundingClientRect();return {top:ir.top,h:ir.height};});" +
    "var ps=getComputedStyle(document.querySelector('.view[data-view=me] .page-scroll'));" +
    "var cz=getComputedStyle(document.querySelector('.composer-zone'));var toast=getComputedStyle(document.getElementById('toast'));" +
    "var edit=document.querySelector('.now-card__edit');" +
    "return {h:r.height,left:r.left,right:r.right,tops:tabs.map(function(t){return t.top;}),heights:tabs.map(function(t){return t.h;}),pageBottom:ps.paddingBottom,composerBottom:cz.paddingBottom,toastBottom:toast.bottom};})()");
  check('底栏高度仍 66px', Math.abs(nav.h - 66) < 1.5, nav.h);
  check('四个图标顶部齐平', Math.max.apply(null, nav.tops) - Math.min.apply(null, nav.tops) < 0.6, JSON.stringify(nav.tops.map((n) => Math.round(n * 10) / 10)));
  check('page-scroll 88px / composer-zone 80px / toast 80px', /88px/.test(nav.pageBottom) && /80px/.test(nav.composerBottom) && /80px/.test(nav.toastBottom), nav.pageBottom + ' / ' + nav.composerBottom + ' / ' + nav.toastBottom);
  const nowFlow = await ev("(function(){var c=document.querySelector('.now-card');var t=c.querySelector('.now-card__text').getBoundingClientRect();var b=c.querySelector('.now-card__edit').getBoundingClientRect();var cs=getComputedStyle(c.querySelector('.now-card__edit'));return {below:b.top>=t.bottom-1,pos:cs.position};})()");
  check('「此刻」编辑仍在正文下方普通文档流', nowFlow.below && nowFlow.pos !== 'absolute' && nowFlow.pos !== 'fixed', JSON.stringify(nowFlow));

  // 爱心选中只变色
  await navTab('chat');
  const heartBefore = await ev("(function(){var el=document.querySelector('.tab--memory .tab__bubble');var r=el.getBoundingClientRect();var cs=getComputedStyle(el);return {w:r.width,h:r.height,top:r.top,color:cs.color,transform:cs.transform};})()");
  await navTab('memory');
  const heartAfter = await ev("(function(){var el=document.querySelector('.tab--memory .tab__bubble');var r=el.getBoundingClientRect();var cs=getComputedStyle(el);return {w:r.width,h:r.height,top:r.top,color:cs.color,transform:cs.transform,current:el.parentNode.getAttribute('aria-current')};})()");
  check('爱心选中不跳不凸不放大', heartAfter.current === 'true' && Math.abs(heartBefore.w - heartAfter.w) < 0.6 && Math.abs(heartBefore.h - heartAfter.h) < 0.6 && Math.abs(heartBefore.top - heartAfter.top) < 0.6 && heartAfter.transform === 'none', 'w ' + heartBefore.w + '→' + heartAfter.w + ' color ' + heartBefore.color + '→' + heartAfter.color);

  // 三个库仍可用
  await navTab('chat');
  await click('[data-open="characterSwitch"]', 520);
  const charSwitch = await ev("(function(){var s=document.getElementById('sheetBody');return {title:document.getElementById('sheetTitle').textContent,text:s.textContent};})()");
  check('A 阶段：角色切换层可用', /和谁说话/.test(charSwitch.title) && charSwitch.text.indexOf('这场聊天里的我') !== -1, charSwitch.title);
  await click('.sheet__close', 350);
  await click('[data-open="personaSwitch"]', 500);
  const personaSwitch = await ev("document.getElementById('sheetTitle').textContent");
  check('A 阶段：用户设定切换层可用', /这场聊天里的我/.test(personaSwitch), personaSwitch);
  await click('.sheet__close', 350);
  await click('[data-open="chatBook"]', 500);
  const bookSheet = await ev("document.getElementById('sheetBody').textContent");
  check('A 阶段：这场世界书切换层可用', /全局书/.test(bookSheet) && /主书/.test(bookSheet), '');
  await click('.sheet__close', 350);
  await navTab('me');
  await shot('pink-me-entry');
  await navFromMe('characters');
  const charsCount = await ev("document.querySelectorAll('#charLibScroll .lib-card').length");
  check('A 阶段：角色库列表仍渲染', charsCount >= 3, charsCount + ' 张卡');
  await click('[data-char-open]', 500);
  const charDetail = await ev("document.getElementById('charLibScroll').textContent");
  check('A 阶段：角色详情仍渲染', /她是谁/.test(charDetail) && /开场白/.test(charDetail), '');
  await click('[data-lib-back="characters"]', 400);
  await click('[data-lib-back="characters"]', 400);

  /* ============ 提供商 ============ */
  console.log('· 模型与提供商');
  await navFromMe('providers');
  const provList = await ev("(function(){var cards=document.querySelectorAll('#provListBox .prov-card');var off=document.querySelectorAll('#provListBox .prov-card.is-off');var svgs=document.querySelectorAll('#provListBox .prov-card .p-icon svg');return {count:cards.length,off:off.length,svgs:svgs.length,text:document.getElementById('providerScroll').textContent.slice(0,120)};})()");
  check('提供商列表 7 家、含禁用浅红卡', provList.count === 7 && provList.off >= 1, provList.count + ' 家 / 禁用 ' + provList.off);
  check('提供商官方图标已内联（SVG）', provList.svgs >= 5, provList.svgs + ' 个 svg');
  const offBg = await ev("(function(){var el=document.querySelector('#provListBox .prov-card.is-off');var cs=getComputedStyle(el);return {bg:cs.backgroundImage,bc:cs.borderColor};})()");
  check('禁用提供商为浅红底', /rgba\(2[0-9][0-9], 1[0-9][0-9], 1[0-9][0-9]/.test(offBg.bg) || /206, 132, 132/.test(offBg.bg), offBg.bg.slice(0, 48));
  await shot('pink-providers-list');
  await ev("(function(){var i=document.getElementById('providerSearch');i.value='claude';i.dispatchEvent(new Event('input',{bubbles:true}));return true;})()");
  await sleep(350);
  const searchCount = await ev("document.querySelectorAll('#provListBox .prov-card').length");
  check('提供商搜索按名字/模型过滤', searchCount === 1, searchCount + ' 家');
  await ev("(function(){var i=document.getElementById('providerSearch');i.value='';i.dispatchEvent(new Event('input',{bubbles:true}));return true;})()");
  await sleep(300);

  await click('[data-a2="provider-open"][data-id="prov-deepseek"]', 560);
  const tabs = await ev("Array.prototype.map.call(document.querySelectorAll('.a2-tab'),function(t){return t.textContent;})");
  check('提供商详情三个标签页', tabs.join('/') === '配置/模型/高级设置', tabs.join('/'));
  await shot('pink-provider-config');
  await click('[data-a2="provider-tab"][data-value="models"]', 450);
  const modelsTab = await ev("document.getElementById('provTabBody').textContent");
  check('模型页显示能力标签与添加新模型', /工具/.test(modelsTab) && /添加新模型/.test(modelsTab), '');
  await shot('pink-provider-models');
  await click('[data-a2="provider-tab"][data-value="advanced"]', 450);
  const advTab = await ev("document.getElementById('provTabBody').textContent");
  check('高级设置有余额/思考回传/演示 400', /余额/.test(advTab) && /回传历史思考过程/.test(advTab) && /演示 400 兜底/.test(advTab), '');
  await shot('pink-provider-advanced');
  await click('[data-a2-back="providers"]', 480);

  // 新建提供商（OpenAI 兼容中转站）
  await click('[data-action="new-provider"]', 520);
  const tplCount = await ev("document.querySelectorAll('[data-a2=template-pick]').length");
  check('预置 7 种提供商模板', tplCount === 7, tplCount + ' 个');
  await click('[data-a2="template-pick"][data-id="relay"]', 650);
  await ev("(function(){document.getElementById('provName').value='测试中转';document.getElementById('provBase').value='https://relay.test.example/v1';document.getElementById('provPath').value='/chat/completions';document.getElementById('provKey').value='sk-test-0000';return true;})()");
  await click('[data-action="save-provider"]', 650);
  const created = await ev("(function(){var st=__a2.getState();var p=st.providers.filter(function(x){return x.name==='测试中转';})[0];return p?{id:p.id,enabled:p.enabled,base:p.baseUrl,key:p.apiKey}:null;})()");
  check('新建 OpenAI 兼容中转站成功', !!created && created.base === 'https://relay.test.example/v1' && created.key === 'sk-test-0000', JSON.stringify(created));
  check('API Key 在界面上是掩码', await ev("(function(){var el=document.getElementById('provKey');return el&&el.type==='password'&&/•/.test(el.value);})()"), '');
  const shownKey = await ev("(function(){var b=document.querySelector('[data-a2=key-eye]');b.click();var el=document.getElementById('provKey');var v=el.value;var t=el.type;b.click();return t+':'+v;})()");
  check('显示按钮可临时查看 Key', shownKey === 'text:sk-test-0000', shownKey);

  // 手动添加模型
  await click('[data-a2="provider-tab"][data-value="models"]', 450);
  await click('[data-action="new-model"]', 520);
  await ev("(function(){document.getElementById('mName').value='测试模型';document.getElementById('mModelId').value='relay-test-1';return true;})()");
  await click('[data-action="save-model"]', 650);
  const manualModel = await ev("(function(){var st=__a2.getState();var p=st.providers.filter(function(x){return x.name==='测试中转';})[0];return {models:p.models.length,mode:(function(){var m=st.models.filter(function(x){return x.modelId==='relay-test-1';})[0];return m?m.reasoning.mode:'';})()};})()");
  check('手动添加模型并默认支持思考档位', manualModel.models >= 1 && manualModel.mode === 'openai_effort', JSON.stringify(manualModel));
  await shot('pink-provider-new-models');

  // 拉取模型（真实请求失败 → 示例列表）
  await click('[data-action="pull-models"]', 400);
  await sleep(1800);
  const pull = await ev("(function(){return {rows:document.querySelectorAll('.pull-row').length,title:document.getElementById('sheetTitle').textContent,text:document.getElementById('sheetBody').textContent.slice(0,120),last:window.__a2lastPull};})()");
  check('拉取模型失败给中文原因并出示例勾选列表', pull.rows > 0 && /浏览器不能直接连这家|网络不通|地址或路径|Key 不对/.test(pull.text), (pull.last && pull.last.kind) + ' / ' + pull.rows + ' 行');
  await shot('pink-pull-models');
  await click('[data-a2="pull-all"][data-value="1"]', 380);
  await click('[data-action="pull-add"]', 650);
  const afterPull = await ev("(function(){var st=__a2.getState();var p=st.providers.filter(function(x){return x.name==='测试中转';})[0];return p.models.length;})()");
  check('勾选后可加入模型', afterPull >= 4, afterPull + ' 个模型');

  // 测试连接
  await click('[data-a2="provider-tab"][data-value="config"]', 420);
  await click('[data-action="test-conn"]', 400);
  await sleep(1800);
  const conn = await ev("(function(){return {last:window.__a2lastTest,text:document.getElementById('connResultText').textContent};})()");
  check('测试连接失败显示中文分类提示', !!conn.last && ['cors', 'network', 'notfound', 'auth', 'badrequest', 'timeout'].indexOf(conn.last.kind) !== -1 && !/Error:|TypeError/.test(conn.text), JSON.stringify(conn.last));
  await shot('pink-test-connection');
  await click('.sheet__close', 350);

  // 高级设置打开 400 演示
  await click('[data-a2="provider-tab"][data-value="advanced"]', 420);
  await click('[data-a2="toggle-switch"]#provSwitchDemo400', 350);
  await click('[data-action="save-provider"]', 600);
  const demo400 = await ev("(function(){var st=__a2.getState();var p=st.providers.filter(function(x){return x.name==='测试中转';})[0];return p.advanced.demo400;})()");
  check('高级设置可打开 400 兜底演示', demo400 === true, String(demo400));

  // 启用/禁用
  await click('[data-a2="provider-tab"][data-value="config"]', 420);
  await click('[data-a2="toggle-switch"]#provSwitchEnabled', 320);
  await click('[data-action="save-provider"]', 600);
  const disabled = await ev("(function(){var st=__a2.getState();return st.providers.filter(function(x){return x.name==='测试中转';})[0].enabled;})()");
  check('提供商可停用', disabled === false, String(disabled));
  await navTab('chat');
  await openModelPicker();
  const pickerNoDisabled = await ev("document.getElementById('mpList').textContent.indexOf('测试中转')===-1");
  check('停用的提供商不出现在模型弹层', pickerNoDisabled, '');
  await click('.sheet__close', 320);
  await navFromMe('providers');
  await click('[data-a2="provider-open"][data-id]', 500);
  // 重新启用刚建的那家（按名字找）
  const targetProv = await ev("(function(){var st=__a2.getState();var p=st.providers.filter(function(x){return x.name==='测试中转';})[0];return p.id;})()");
  await click('[data-a2-back="providers"]', 400);
  await click('[data-a2="provider-open"][data-id="' + targetProv + '"]', 500);
  await click('[data-a2="toggle-switch"]#provSwitchEnabled', 300);
  await click('[data-action="save-provider"]', 600);
  check('提供商可重新启用', (await ev("(function(){var st=__a2.getState();return st.providers.filter(function(x){return x.name==='测试中转';})[0].enabled;})()")) === true, '');

  /* ============ 模型选择弹层 ============ */
  console.log('· 模型选择弹层重做');
  await navTab('chat');
  await openModelPicker();
  const picker = await ev("(function(){return {groups:document.querySelectorAll('#mpList .mp-group').length,fav:document.querySelectorAll('#mpList .mp-group__name').length>0,balanceText:document.getElementById('mpList').textContent,pills:document.querySelectorAll('#mpPills .mp-pill').length,sheet:document.querySelector('.sheet').className,height:document.querySelector('.sheet').getBoundingClientRect().height};})()");
  check('模型弹层按提供商分组 + 收藏', picker.groups >= 5 && picker.balanceText.indexOf('收藏') !== -1, picker.groups + ' 组');
  check('组头显示余额或「余额暂不可查」', /¥12\.40|余额暂不可查/.test(picker.balanceText), '');
  check('底部提供商快捷胶囊', picker.pills >= 5, picker.pills + ' 个');
  check('弹层高度 ≤ 80% 屏', picker.height <= 844 * 0.801, Math.round(picker.height));
  await shot('pink-model-picker-open');
  await click('[data-a2="mp-group"][data-id="prov-anthropic"]', 400);
  const collapsed = await ev("!document.getElementById('mpGroup-prov-anthropic').classList.contains('is-open')");
  check('点组头可折叠', collapsed, '');
  await shot('pink-model-picker-collapsed');
  await click('[data-a2="mp-group"][data-id="prov-anthropic"]', 380);
  await ev("(function(){var i=document.getElementById('mpSearch');i.value='claude';i.dispatchEvent(new Event('input',{bubbles:true}));return true;})()");
  await sleep(400);
  const searchPicker = await ev("document.getElementById('mpList').textContent");
  check('模型弹层搜索可用', /Claude/.test(searchPicker) && /DeepSeek/.test(searchPicker) === false, searchPicker.slice(0, 30));
  await shot('pink-model-picker-search');
  // 收藏心形
  await ev("(function(){var i=document.getElementById('mpSearch');i.value='kimi';i.dispatchEvent(new Event('input',{bubbles:true}));return true;})()");
  await sleep(350);
  const favBefore = await ev("(function(){var st=__a2.getState();var m=st.models.filter(function(x){return x.modelId==='moonshotai/kimi-k2';})[0];return m.favorite;})()");
  await click('[data-a2="mp-fav"]', 420);
  const favAfter = await ev("(function(){var st=__a2.getState();var m=st.models.filter(function(x){return x.modelId==='moonshotai/kimi-k2';})[0];return m.favorite;})()");
  check('收藏心形可切换', favBefore !== favAfter, favBefore + ' → ' + favAfter);
  const beforeJump = await ev("document.getElementById('sheetBody').scrollTop");
  await click('[data-a2="mp-pill"][data-id="prov-gemini"]', 600);
  const afterJump = await ev("document.getElementById('sheetBody').scrollTop");
  check('底部胶囊跳转到对应分组', afterJump !== beforeJump, beforeJump + ' → ' + afterJump);
  await clearModelSearch();
  await click('[data-a2="model-pick"][data-id="model-claude-sonnet"]', 2300);
  const chip = await ev("(function(){return {name:document.getElementById('modelChipName').textContent,icon:!!document.querySelector('#modelChipIcon svg'),aria:document.getElementById('modelChip').getAttribute('aria-label')};})()");
  check('右上角模型胶囊显示官方小图标 + 短名', /Claude/.test(chip.name) && chip.icon, JSON.stringify(chip));
  await shot('pink-chat-bulb');

  /* ============ 思考档位 ============ */
  console.log('· 思考档位');
  const modes = await ev("(function(){var st=__a2.getState();var out={};['model-deepseek-chat','model-claude-sonnet','model-gemini-pro','model-openrouter-kimi','model-bailu-slow','model-qwen3'].forEach(function(id){var m=__a2.findModel(id);out[id]=__a2.buildReasoningParams(m, m.reasoning.mode==='deepseek'?'on':(m.reasoning.levels.indexOf('high')!==-1?'high':m.reasoning.levels[1]));});return out;})()");
  check('buildReasoningParams 覆盖 OpenAI/Anthropic/Gemini/DeepSeek/OpenRouter/中转/不支持',
    !!modes['model-deepseek-chat'].params.thinking &&
    !!modes['model-claude-sonnet'].params.thinking.budget_tokens &&
    !!modes['model-gemini-pro'].params.generationConfig.thinkingConfig.thinkingBudget &&
    !!modes['model-openrouter-kimi'].params.reasoning.effort &&
    !!modes['model-bailu-slow'].params.model &&
    modes['model-qwen3'].supported === false && modes['model-qwen3'].params === null,
    JSON.stringify(Object.keys(modes).reduce(function (o, k) { o[k] = modes[k].mode; return o; }, {})));
  await click('#thinkCap', 620);
  const reasonSheet = await ev("(function(){return {title:document.querySelector('.sheet__title').textContent,cur:document.querySelector('.sheet .reason-current').textContent,segs:document.querySelectorAll('.seg-slider__btn').length,big:!!document.querySelector('.reason-bulb'),note:document.querySelector('.sheet').textContent};})()");
  check('思考深度弹层：标题/大字/说明/分段滑杆/灯泡', reasonSheet.title === '调整思考深度' && reasonSheet.segs === 5 && reasonSheet.big && /并非所有模型都支持深度调整/.test(reasonSheet.note), reasonSheet.cur + ' / ' + reasonSheet.segs + ' 档');
  await click('[data-a2="reason-level"][data-value="high"]', 500);
  const askReason = await ev("!!document.querySelector('.ask-card') && document.querySelector('.ask-card').textContent");
  check('改档位后询问是否设为默认', !!askReason && /只改这场|默认/.test(askReason), String(askReason).slice(0, 40));
  await shot('pink-reasoning-ask');
  await click('[data-a2="reason-default"]', 550);
  const claudeDefault = await ev("__a2.findModel('model-claude-sonnet').reasoning.defaultLevel");
  check('可同时设为模型默认档位', claudeDefault === 'high', claudeDefault);
  await click('#thinkCap', 500);
  await shot('pink-reasoning');
  await click('.sheet__close', 320);

  // 思考过程折叠
  await ev("(function(){var i=document.getElementById('chatInput');i.value='今天法学院的风很大。';document.getElementById('sendBtn').click();return true;})()");
  await sleep(1800);
  const fold = await ev("(function(){var folds=document.querySelectorAll('.think-fold');var f=folds[folds.length-1];return {count:folds.length,summary:f?f.querySelector('summary').textContent:'',open:f?f.hasAttribute('open'):null,fallback:document.querySelectorAll('.fallback-note').length};})()");
  check('回复里的思考过程默认折叠（想了 N 秒）', fold.count > 0 && /想了/.test(fold.summary) && fold.open === false, fold.summary);
  await shot('pink-chat-thinking-fold');

  // 400 兜底
  await openModelPicker();
  await pickSearchModel('bailu', 'model-bailu-slow');
  await sleep(1200);
  await click('#thinkCap', 500);
  await click('[data-a2="reason-level"][data-value="high"]', 450);
  await click('[data-a2="reason-dismiss"]', 400);
  await click('.sheet__close', 300);
  await ev("(function(){var i=document.getElementById('chatInput');i.value='再说一句就好。';document.getElementById('sendBtn').click();return true;})()");
  await sleep(1900);
  const fb = await ev("(function(){var notes=document.querySelectorAll('.fallback-note');var last=notes[notes.length-1];return {count:notes.length,text:last?last.textContent:'',lastReasoning:window.__a2lastReasoning};})()");
  check('400 兜底自动去掉思考参数并有小字提示', !!fb.lastReasoning && fb.lastReasoning.retried === true && /已按默认回复/.test(fb.text), fb.text);
  check('400 兜底后聊天没有失败（消息仍追加）', fb.count > 0, fb.count + ' 条提示');
  await shot('pink-400-fallback');

  // 不支持思考的模型
  await openModelPicker();
  await pickSearchModel('bailu', 'model-bailu-lite');
  await sleep(1000);
  const greyCap = await ev("(function(){var c=document.getElementById('thinkCap');return {off:c.classList.contains('is-off'),label:document.getElementById('thinkCapLevel').textContent,aria:c.getAttribute('aria-label')};})()");
  check('不支持思考的模型灯泡置灰', greyCap.off === true && /不能调/.test(greyCap.aria), JSON.stringify(greyCap));
  await click('#thinkCap', 520);
  const unsupportedSheet = await ev("document.querySelector('.sheet').textContent");
  check('不支持时写明「这个模型不能调思考深度」', /不能调思考深度/.test(unsupportedSheet) && /不发送任何思考参数|不会带任何思考参数/.test(unsupportedSheet), '');
  await shot('pink-reasoning-unsupported');
  await click('.sheet__close', 320);

  /* ============ 提示词预设 ============ */
  console.log('· 提示词预设');
  await navFromMe('presets');
  const presetList = await ev("document.querySelectorAll('#presetScroll .preset-card').length");
  check('提示词预设列表（3 个预置）', presetList === 3, presetList + ' 个');
  await shot('pink-presets-list');
  await fileTo('#filePreset', 'tavern-test.json', {
    name: '酒馆测试预设',
    temperature: 0.9,
    top_p: 0.75,
    max_tokens: 600,
    frequency_penalty: 0.2,
    custom_flag: 1,
    prompts: [
      { identifier: 'main', name: '主提示', role: 'system', content: '用简短的句子回应，像平时发消息一样。' },
      { identifier: 'style', name: '文风', role: 'system', content: '保持成年人之间自然、克制的语气。', injection_position: 0, injection_depth: 2 }
    ],
    prompt_order: [{ character_id: 100000, order: [{ identifier: 'main', enabled: true }, { identifier: 'style', enabled: true }] }]
  });
  await sleep(600);
  const imported = await ev("(function(){var st=__a2.getState();var p=st.promptPresets.filter(function(x){return x.name==='酒馆测试预设';})[0];return p?{frags:p.fragments.length,source:p.source,temp:p.sampling.temperature,extras:!!p.extras.custom_flag}:null;})()");
  check('导入酒馆预设 JSON 成功（prompts / prompt_order / 采样 / 额外资料）', !!imported && imported.frags === 2 && imported.source === 'tavern' && imported.temp === 0.9 && imported.extras, JSON.stringify(imported));
  const presetCount = await ev("__a2.getState().promptPresets.length");
  check('预设数量变为 4', presetCount === 4, String(presetCount));

  // 编辑细腻散文
  await click('[data-a2="preset-open"][data-id="preset-prose"]', 560);
  await shot('pink-preset-detail');
  const sampling = await ev("(function(){return {temp:document.getElementById('spTemp').value,top:document.getElementById('spTopP').value,max:document.getElementById('spMax').value,ctx:document.getElementById('spCtx').value};})()");
  check('预设详情显示采样参数', sampling.temp === '0.85' && sampling.top === '0.95' && sampling.max === '1200' && sampling.ctx === '24', JSON.stringify(sampling));
  await ev("(function(){document.getElementById('spTemp').value='0.9';return true;})()");
  await click('[data-action="save-preset"]', 560);
  const savedTemp = await ev("__a2.getState().promptPresets.filter(function(p){return p.id==='preset-prose';})[0].sampling.temperature");
  check('可保存采样参数', savedTemp === 0.9, String(savedTemp));
  await click('[data-a2="frag-open"]', 500);
  await shot('pink-frag-edit');
  await click('.sheet__close', 350);
  await click('[data-a2-back="presets"]', 450);

  // 绑定这场聊天
  await navTab('chat');
  await click('[data-open="presetSwitch"]', 560);
  await click('[data-a2="preset-pick"][data-id="preset-daily"]', 480);
  const presetAsk = await ev("!!document.querySelector('.ask-card') && document.querySelector('.ask-card').textContent");
  check('换文风时询问是否设为角色默认', !!presetAsk && /只改这场/.test(presetAsk), String(presetAsk).slice(0, 40));
  await click('[data-a2="preset-apply"][data-value="chat"]', 520);
  const chatPreset = await ev("(function(){var st=__a2.getState();var c=st.chats[st.currentCharacterId];return {chip:document.getElementById('chatPresetName').textContent,presetId:c.presetId};})()");
  check('聊天顶栏出现「文风 · 日常短句」胶囊', chatPreset.chip === '日常短句' && chatPreset.presetId === 'preset-daily', JSON.stringify(chatPreset));
  await shot('pink-chat-preset-chip');

  // assemblePrompt 与预览
  const assembled = await ev("(function(){var out=__a2.assemblePrompt({});return {kinds:out.blocks.map(function(b){return b.kind;}),labels:out.blocks.map(function(b){return b.label;}),tokens:out.tokens,text:out.text.length};})()");
  const kindSeq = assembled.kinds;
  check('assemblePrompt 顺序：预设前置 → 角色 → 世界书 → 用户 → 聊天',
    kindSeq[0] === 'preset' && kindSeq[1] === 'char' && kindSeq.indexOf('book') !== -1 && kindSeq.indexOf('user') !== -1 && kindSeq.indexOf('chat') !== -1 && kindSeq.lastIndexOf('chat') > kindSeq.indexOf('user'),
    kindSeq.slice(0, 8).join(' > '));
  check('assemblePrompt 含深度注入片段', assembled.labels.some(function (l) { return /深度注入/.test(l); }), assembled.labels.length + ' 段 / ' + assembled.tokens + ' tok');
  await click('[data-open="chatMenu"]', 450);
  await click('[data-a2="preview-open"]', 560);
  const preview = await ev("(function(){return {title:document.querySelector('.sheet__title').textContent,blocks:document.querySelectorAll('.preview-block').length,chats:document.querySelectorAll('.preview-chat').length,text:document.getElementById('sheetBody').textContent};})()");
  check('「查看这次发给模型的内容」预览面板可打开', /这次发给模型的内容/.test(preview.title) && preview.blocks >= 4 && preview.chats > 0 && /深度注入/.test(preview.text), preview.blocks + ' 段 + ' + preview.chats + ' 条聊天');
  await shot('pink-prompt-preview');
  await click('.sheet__close', 320);

  /* ============ 统计页 ============ */
  console.log('· 统计页');
  await navFromMe('stats');
  const statsInfo = await ev("(function(){return {heat:document.querySelectorAll('.heat-cell').length,rank:document.querySelectorAll('.rank-row').length,cells:document.querySelectorAll('.stat-cell').length,range:document.querySelectorAll('.stats-range button').length,hero:document.querySelector('.view--stats .reason-current').textContent,text:document.getElementById('statsScroll').textContent};})()");
  check('统计页：范围切换 + 7 项总览 + 热力图 + 排行', statsInfo.range === 5 && statsInfo.cells === 7 && statsInfo.heat === 371 && statsInfo.rank > 0, statsInfo.heat + ' 格热力图 / ' + statsInfo.rank + ' 行排行');
  check('统计页没有「未知模型」', statsInfo.text.indexOf('未知模型') === -1, '');
  await shot('pink-stats-top');
  const expected = {};
  for (const range of ['today', '7d', '30d', '90d', 'all']) {
    await click('[data-a2="stats-range"][data-value="' + range + '"]', 520);
    const data = await ev("(function(){var recs=__a2.rangeRecords('" + range + "');var a=__a2.aggregateUsage(recs);return {tok:__a2.fmtTok(a.prompt+a.output),cost:__a2.fmtCost(a.cost),count:a.count,cols:document.querySelectorAll('.chart-col').length,hero:document.querySelector('.view--stats .reason-current').textContent};})()");
    expected[range] = data;
    const ok = data.hero.indexOf(data.tok) === 0 && data.count > 0;
    check('范围「' + ({ today: '今天', '7d': '7 天', '30d': '30 天', '90d': '90 天', all: '全部' }[range]) + '」数字与 usage 汇总一致', ok, data.hero + ' / ' + data.count + ' 次 / ' + data.cols + ' 柱');
  }
  check('不同范围数字确实变化', expected['7d'].tok !== expected['all'].tok && expected['30d'].count !== expected['7d'].count, '7d ' + expected['7d'].count + ' 次 / 30d ' + expected['30d'].count + ' 次 / all ' + expected['all'].count + ' 次');
  await click('[data-a2="stats-range"][data-value="7d"]', 520);
  await scrollTo('#statsScroll', 640);
  await shot('pink-stats-mid');
  await click('[data-a2="stats-metric"][data-value="cost"]', 500);
  const costChart = await ev("(function(){return {costSeg:document.querySelectorAll('.chart-seg--cost').length,hero:document.querySelector('.view--stats .reason-current').textContent,legend:document.querySelector('.chart-sum').textContent};})()");
  check('柱状图可切换按 Token / 按花费', costChart.costSeg > 0 && costChart.hero.charAt(0) === '¥', costChart.hero);
  await shot('pink-stats-cost');
  await click('[data-a2="stats-metric"][data-value="token"]', 420);
  await click('[data-a2="rank-tab"][data-value="char"]', 450);
  const rankChar = await ev("document.querySelector('.rank-list').textContent");
  check('排行可按角色切换', /缪诗|阿杞|林雾/.test(rankChar), '');
  await click('[data-a2="rank-tab"][data-value="provider"]', 420);
  const rankProv = await ev("document.querySelector('.rank-list').textContent");
  check('排行可按提供商切换', /DeepSeek|Anthropic|Gemini|OpenRouter|白露|硅基/.test(rankProv), '');
  await click('[data-a2="rank-tab"][data-value="model"]', 420);
  await scrollTo('#statsScroll', 2600);
  await shot('pink-stats-bottom');

  // 余额查询失败
  const balFail = await ev("(function(){var st=__a2.getState();var p=st.providers.filter(function(x){return x.id==='prov-openrouter';})[0];p.apiKey='sk-test-0000';__a2.save();__a2.queryBalance('prov-openrouter', true);return true;})()");
  await sleep(1700);
  const balState = await ev("(function(){var st=__a2.getState();var p=st.providers.filter(function(x){return x.id==='prov-openrouter';})[0];return {amount:p.balance.amount,text:document.getElementById('statsScroll').textContent};})()");
  check('余额查询失败只显示「余额暂不可查」', balState.amount === null && /余额暂不可查/.test(balState.text), JSON.stringify(balState.amount));
  await scrollTo('#statsScroll', 2000);
  await shot('pink-balance-fail');

  /* ============ 导入 / 导出 ============ */
  console.log('· 提供商导入导出');
  await navFromMe('providers');
  await click('[data-action="export-providers"]', 500);
  const exportSheet = await ev("document.getElementById('sheetBody').textContent");
  check('导出默认不带 Key，并有勾选风险提示', /默认不带/.test(exportSheet) && /包含 API Key/.test(exportSheet), '');
  await click('[data-a2="toggle-switch"]#exportKeySwitch', 520);
  const exportWarn = await ev("document.getElementById('sheetBody').textContent");
  check('勾选带 Key 时出现风险提示', /带着 Key|注意别发给别人/.test(exportWarn), '');
  await shot('pink-provider-export');
  await click('.sheet__close', 350);
  const beforeImport = await ev('__a2.getState().providers.length');
  await fileTo('#fileProvider', 'providers-test.json', {
    app: 'miushi-yuanqi', kind: 'providers', version: 1,
    providers: [{ id: 'prv-import-test', name: '导入的中转', icon: 'generic', protocol: 'openai', baseUrl: 'https://import.example.com/v1', apiPath: '/chat/completions', apiKey: 'sk-should-not-carry', enabled: true, models: ['model-import-test'], balance: { supported: false, amount: 0, currency: '¥', at: '' }, advanced: { responseApi: false, returnThinking: true, fetchBalance: false, demo400: false, timeout: 45 }, extras: {} }],
    models: [{ id: 'model-import-test', providerId: 'prv-import-test', name: 'GPT-5', modelId: 'gpt-5', icon: 'openai', caps: { vision: true, tools: true, reasoning: true }, context: 400000, favorite: false, source: 'imported', price: null, reasoning: { mode: 'openai_effort', levels: ['off', 'auto', 'low', 'high'], defaultLevel: 'auto', note: '' } }]
  });
  const afterImport = await ev('__a2.getState().providers.length');
  const importKey = await ev("(function(){var p=__a2.getState().providers.filter(function(x){return x.name==='导入的中转';})[0];return p?p.apiKey:'missing';})()");
  check('可导入提供商 JSON，且不接收文件里的 Key', afterImport === beforeImport + 1 && importKey === '', afterImport + ' 家 / key=' + JSON.stringify(importKey));

  // 刷新持久化
  await ev('location.reload();true;');
  await waitReady();
  const persisted = await ev("(function(){var st=__a2.getState();return {theme:document.documentElement.getAttribute('data-theme'),providers:st.providers.length,models:st.models.length,presets:st.promptPresets.length,model:st.modelId,chatPreset:st.chats[st.currentCharacterId].presetId};})()");
  check('刷新后提供商 / 模型 / 预设 / 当前模型仍在', persisted.providers === afterImport && persisted.models > 10 && persisted.presets === 4 && !!persisted.model && persisted.theme === 'pink', JSON.stringify(persisted));

  await navTab('chat');
  await shotNav('pink-nav-closeup');

  /* ============ 冰蓝主题截图 ============ */
  console.log('· 冰蓝主题');
  await setTheme('ice');
  await navTab('chat');
  await shot('ice-chat');
  await shotNav('ice-nav-closeup');
  await openModelPicker();
  await shot('ice-model-picker');
  await clearModelSearch();
  await click('[data-a2="model-pick"][data-id="model-claude-sonnet"]', 1600);
  await click('#thinkCap', 600);
  await shot('ice-reasoning');
  await click('.sheet__close', 320);
  await ev("(function(){var i=document.getElementById('chatInput');i.value='今晚早点睡。';document.getElementById('sendBtn').click();return true;})()");
  await sleep(1800);
  await shot('ice-chat-thinking-fold');
  await navFromMe('providers');
  await shot('ice-providers-list');
  await click('[data-a2="provider-open"][data-id="prov-anthropic"]', 550);
  await shot('ice-provider-config');
  await click('[data-a2="provider-tab"][data-value="advanced"]', 450);
  await shot('ice-provider-advanced');
  await click('[data-a2-back="providers"]', 420);
  await navFromMe('presets');
  await shot('ice-presets-list');
  await click('[data-a2="preset-open"][data-id="preset-prose"]', 500);
  await shot('ice-preset-detail');
  await click('[data-a2-back="presets"]', 400);
  await navTab('chat');
  await click('[data-open="chatMenu"]', 450);
  await click('[data-a2="preview-open"]', 550);
  await shot('ice-prompt-preview');
  await click('.sheet__close', 320);
  await navFromMe('stats');
  await shot('ice-stats-top');
  await scrollTo('#statsScroll', 2500);
  await shot('ice-stats-bottom');
  await navFromMe('providers');
  await shot('ice-me-entry', 200);
  await navTab('chat');
  await shotNav('ice-nav-closeup2');

  /* ============ 控制台 ============ */
  check('控制台无 JS 报错', jsErrors.length === 0, jsErrors.length ? jsErrors.slice(0, 3).join(' | ') : '0 条（网络资源错误 ' + resourceErrors.length + ' 条已忽略）');
  const overflow = await ev("({docW:document.documentElement.scrollWidth,innerW:window.innerWidth})");
  check('390 宽无横向溢出', overflow.docW <= 390, JSON.stringify(overflow));

  const failed = results.filter((r) => !r.ok);
  console.log('\n截图目录：' + outDir);
  console.log('断言：' + (results.length - failed.length) + '/' + results.length + ' 通过');
  if (failed.length) {
    console.log('失败项：');
    failed.forEach((f) => console.log('  ❌ ' + f.name + ' —— ' + f.detail));
  }
  fs.writeFileSync(outDir + '/_check-result.json', JSON.stringify({ results, jsErrors, resourceErrors }, null, 2));
  ws.close();
  chrome.kill();
  await sleep(300);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error('❌ 自查脚本失败：', err);
  try { chrome.kill(); } catch (e) { /* 忽略 */ }
  process.exit(1);
});
