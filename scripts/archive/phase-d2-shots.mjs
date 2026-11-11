#!/usr/bin/env node
/* 第 D2 轮截图：三块 × 两主题，只写 shots/phase-d2/，不碰 scripts/shoot.mjs。
   需要后端能力的界面（保存连通 / 聊天记录）用 MSYQ_MOCK=1 的本机后端 + headless Chrome。
   用法：node scripts/phase-d2-shots.mjs [--only=theme|block1|block3]
*/
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { ROOT, startBackend, startChrome, sleep } from './d2-cdp.mjs';

const OUT = path.join(ROOT, 'shots/phase-d2');
const THEMES = ['pink', 'ice'];
const only = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7);

async function api(base, method, p, body) {
  const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  try { return JSON.parse(text); } catch (e) { return { raw: text }; }
}

async function seedChats(base) {
  const chars = (await api(base, 'GET', '/api/characters')).characters;
  const miao = chars.find((c) => c.id === 'miao') || chars[0];
  const other = chars.find((c) => c.id !== miao.id) || miao;
  async function send(chatId, charId, text) {
    const res = await fetch(base + '/api/chats/' + charId + '/messages', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, chatId })
    });
    await res.text();
  }
  const miaoPlan = [
    { title: '雨天与旧信', pinned: true, lines: ['今天雨下得很大，我有点想你。', '伞在门边，进来先擦擦头发。', '我把旧信翻出来了，纸有点潮。'] },
    { title: '便利店门口', pinned: false, lines: ['便利店门口的灯还亮着。', '那家的热牛奶还有吗？', '有，我给你留了一杯。'] },
    { title: '海边的约定', pinned: false, lines: ['等天晴了，我们去看海吧。', '好啊，风很大的话就躲我后面。'] }
  ];
  for (const plan of miaoPlan) {
    const chat = (await api(base, 'POST', '/api/chats', { characterId: miao.id })).chat;
    for (const line of plan.lines) await send(chat.id, miao.id, line);
    await api(base, 'PATCH', '/api/chats/id/' + chat.id, { title: plan.title, pinned: plan.pinned });
  }
  const otherChat = (await api(base, 'POST', '/api/chats', { characterId: other.id })).chat;
  await send(otherChat.id, other.id, '今晚图书馆开到十点。');
  await send(otherChat.id, other.id, '那我等你到十点。');
  await api(base, 'PATCH', '/api/chats/id/' + otherChat.id, { title: '夜里的图书馆' });
  return { miao, other };
}

async function hideNoise(page, opts = {}) {
  await page.ev(`(function(){
    function hide(el){ if(el){ el.style.visibility='hidden'; } }
    hide(document.getElementById('serverNote'));
    [].forEach.call(document.querySelectorAll('.a2-banner'), function(e){ if((e.textContent||'').indexOf('离线模式')>=0||(e.textContent||'').indexOf('连不上本机后端')>=0) hide(e); });
    var toast = document.getElementById('toast');
    if (toast) {
      if (${opts.keepToast ? 'true' : 'false'}) { toast.style.visibility='visible'; }
      else { toast.classList.remove('is-show'); toast.style.visibility='hidden'; }
    }
    return true;
  })()`).catch(() => {});
}

async function appReady(page) {
  await page.waitFor("document.querySelector('.view.is-active') && document.querySelectorAll('.w').length>=6", 20000);
  await sleep(750);
  await page.ev("localStorage.setItem('msyq.migrated','1'); true").catch(() => {});
}
async function closeSheets(page) {
  for (let i = 0; i < 3; i++) {
    await page.ev("(function(){var b=document.querySelector('#sheetLayer.is-open [data-close]'); if(b){b.click();return true;} return false;})()").catch(() => false);
    await sleep(280);
  }
}
async function openChat(page) {
  await closeSheets(page);
  await page.click('.tab[data-nav="chat"]', 700);
  await page.waitFor("document.querySelectorAll('#chatList .msg').length>0", 8000);
}
async function snap(page, name, opts = {}) {
  await hideNoise(page, opts);
  await page.shot(name, opts.wait === undefined ? 380 : opts.wait);
  await page.ev("(function(){var t=document.getElementById('toast'); if(t){t.style.visibility='visible';} return true;})()").catch(() => {});
}

async function themeShots(theme, reopenBackend) {
  const backend = await startBackend({ port: 18940 + (theme === 'ice' ? 1 : 0) });
  const page = await startChrome({ outDir: OUT });
  try {
    /* 先通过接口把数据种好，再打开页面（避免首屏 ensure 先建一段空对话） */
    await api(backend.base, 'PUT', '/api/settings', { settings: { theme } });
    await seedChats(backend.base);
    await api(backend.base, 'POST', '/api/providers/prov-deepseek/key', { apiKey: 'demo-placeholder-not-a-real-key' });
    await page.send('Page.navigate', { url: backend.base + '/' });
    await appReady(page);

    /* ---------- 第一块：提供商 ---------- */
    await page.click('.tab[data-nav="me"]', 600);
    await page.click('[data-nav="providers"]', 700);
    await page.waitFor("document.querySelectorAll('.prov-card').length>0", 8000);
    /* 明确打开 DeepSeek 这一家，避免点到别的提供商 */
    await page.ev("(function(){var cards=[].slice.call(document.querySelectorAll('.prov-card')); var target=cards.filter(function(c){return c.textContent.indexOf('DeepSeek')>=0;})[0]||cards[0]; if(target){target.click();return true;} return false;})()");
    await page.waitFor("document.getElementById('provBase')", 8000);
    /* 模拟把完整地址粘进 Base URL：应自动拆成 Base URL + API 路径，并在输入框下给「已自动改为 …」 */
    await page.ev("(function(){var el=document.getElementById('provBase'); el.value='https://api.deepseek.com/v1/chat/completions'; el.dispatchEvent(new Event('focusout',{bubbles:true})); return true;})()");
    await sleep(700);
    const autofillCheck = await page.ev("(function(){var el=document.getElementById('provBase'); var hint=document.getElementById('d2UrlHint'); return {base: el?el.value:'', baseVisible: el?el.getBoundingClientRect().height:0, hint: hint?hint.textContent:''};})()");
    console.log('  autofill:', JSON.stringify(autofillCheck));
    await page.ev("(function(){var s=document.getElementById('providerScroll'); var row=document.getElementById('provBase'); if(s&&row) s.scrollTop = Math.max(0, row.getBoundingClientRect().top - s.getBoundingClientRect().top - 180); return true;})()");
    await sleep(300);
    await snap(page, theme + '-provider-autofill');
    await page.ev("var s=document.getElementById('providerScroll'); if(s) s.scrollTop=0; true");
    await page.click('[data-action="save-provider"]', 2000);
    await snap(page, theme + '-provider-connected');
    await closeSheets(page);
    await page.click('[data-action="test-conn"]', 700);
    await snap(page, theme + '-provider-test-cost');
    await page.ev("(function(){var b=document.querySelector('[data-d2-test-start]'); if(b){b.click();return true;} return false;})()");
    await sleep(1500);
    await snap(page, theme + '-provider-test-result');
    await closeSheets(page);

    /* ---------- 第三块：聊天记录 ---------- */
    await openChat(page);
    await page.click('[data-open="chatMenu"]', 700);
    await snap(page, theme + '-chat-menu');
    await page.ev("(function(){var b=document.querySelector('[data-d2a=\"manage-chats\"]'); if(b){b.click();return true;} return false;})()");
    await sleep(1000);
    await snap(page, theme + '-chat-list');
    /* 改名 */
    await page.ev("(function(){var m=document.querySelector('[data-d2chat-more]'); if(m){m.click();return true;} return false;})()");
    await sleep(600);
    await page.ev("(function(){var b=document.querySelector('[data-d2row-rename]'); if(b){b.click();return true;} return false;})()");
    await sleep(600);
    await page.ev("(function(){var i=document.getElementById('d2RenameInput'); if(i){i.value='雨天与旧信（改过名）';return true;}return false;})()");
    await snap(page, theme + '-chat-rename');
    await closeSheets(page);
    /* 单条消息操作 */
    await openChat(page);
    await page.ev("(function(){var ms=document.querySelectorAll('#chatList .msg'); var m=ms[Math.min(2, ms.length-1)]; if(m){m.click();return true;} return false;})()");
    await sleep(700);
    await snap(page, theme + '-message-actions');
    await closeSheets(page);
    /* 人设三层 */
    await openChat(page);
    await page.ev("(function(){var b=document.querySelector('[data-open=\"personaSwitch\"]'); if(b){b.click();return true;} return false;})()");
    await sleep(700);
    await snap(page, theme + '-persona-layers');
    await closeSheets(page);
    /* 分支：从一条消息另开，然后在对话列表里能看到「… · 分支」 */
    await openChat(page);
    await page.ev("(function(){var ms=document.querySelectorAll('#chatList .msg'); var m=ms[Math.min(1, ms.length-1)]; if(m){m.click();return true;} return false;})()");
    await sleep(600);
    await page.ev("(function(){var b=document.querySelector('[data-d2a-msg-branch]'); if(b){b.click();return true;} return false;})()");
    await sleep(1300);
    await page.click('[data-open="chatMenu"]', 600);
    await page.ev("(function(){var b=document.querySelector('[data-d2a=\"manage-chats\"]'); if(b){b.click();return true;} return false;})()");
    await sleep(1000);
    await snap(page, theme + '-branch', { keepToast: true });
    /* 最近的聊天：入口 + 列表 + 搜索 */
    await closeSheets(page);
    await page.click('.tab[data-nav="me"]', 700);
    await sleep(500);
    await snap(page, theme + '-recent-entry');
    await page.ev("(function(){var r=document.getElementById('d2RecentChatsRow'); if(r){r.click();return true;} return false;})()");
    await sleep(1000);
    await snap(page, theme + '-recent-chats');
    await page.ev("(function(){var i=document.getElementById('d2RecentSearch'); if(i){i.value='看海'; i.dispatchEvent(new Event('input',{bubbles:true})); return true;} return false;})()");
    await sleep(1000);
    await snap(page, theme + '-chat-search');
    await closeSheets(page);
    /* 设置页的三个开关（人设三层相关） */
    await page.click('.tab[data-nav="me"]', 600);
    await page.click('[data-nav="settings"]', 800);
    await sleep(500);
    await page.ev("(function(){var v=document.querySelector('.view--settings .page-scroll'); if(v){v.scrollTop=v.scrollHeight;} return true;})()");
    await snap(page, theme + '-settings-chat');
    console.log('== 主题 ' + theme + ' 截图完成，JS errors:', page.errors.slice(0, 4));
  } finally {
    await page.close();
    await backend.close();
  }
}

/* 离线演示回复（file:// / 后端断线）的「演示思维链」：两主题各一张 */
async function offlineDemoCot() {
  const html = fs.readFileSync(path.join(ROOT, 'dist/index.html'), 'utf8');
  const server = http.createServer((req, res) => {
    const u = req.url.split('?')[0];
    if (u === '/' || u === '/index.html') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html); return; }
    if (u === '/blank') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end('<!doctype html><title>seed</title>'); return; }
    res.writeHead(404); res.end('not found');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const page = await startChrome({ outDir: OUT });
  try {
    for (const theme of THEMES) {
      await page.send('Page.navigate', { url: base + '/blank' });
      await sleep(250);
      await page.ev('localStorage.setItem("msyq.v2", ' + JSON.stringify(JSON.stringify({ theme, overrides: {}, settings: {} })) + '); localStorage.setItem("msyq.migrated","1"); true');
      await page.send('Page.navigate', { url: base + '/' });
      await page.waitFor("document.querySelector('.view.is-active') && document.querySelectorAll('.w').length>=6", 20000);
      await sleep(800);
      await page.click('.tab[data-nav="chat"]', 800);
      await page.waitFor("document.querySelector('#chatList .msg')", 8000);
      await page.ev("(function(){var i=document.getElementById('chatInput'); if(i){i.value='今天有点累，陪我说说话。'; i.dispatchEvent(new Event('input',{bubbles:true})); return true;} return false;})()");
      await page.click('#sendBtn', 2200);
      await sleep(1400);
      await page.ev("(function(){var s=document.getElementById('chatScroll'); if(s) s.scrollTop=s.scrollHeight; return true;})()");
      await hideNoise(page);
      await page.shot(theme + '-offline-demo-cot', 350);
      console.log('  📸 ' + theme + '-offline-demo-cot（离线演示思维链）');
    }
  } finally {
    await page.close();
    await new Promise((r) => server.close(r));
  }
}

if (!only || only === 'theme') {
  for (const theme of THEMES) {
    if (only === 'theme' || THEMES.indexOf(theme) >= 0) await themeShots(theme);
  }
  await offlineDemoCot();
}
console.log('截图目录：' + OUT);
