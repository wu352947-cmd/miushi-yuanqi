/* 缪诗鸳杞 · 交互脚本（原生 JS，无框架、无外链、无网络请求） */
(function () {
  'use strict';

  /* ===== 第 D2 轮功能模块：构建时由 scripts/build.mjs 注入 src/modules/*.js ===== */
  /* SHEETS：sheet 内容注册表。modules/*.js 在下方注入点就会挂方法，必须先有对象 */
  var SHEETS = {};
  /*@MODULES@*/

  /* ---------------- 常量 & 状态 ---------------- */
  var STORE_KEY = 'msyq.v2';
  var OLD_STORE_KEY = 'msyq.v1';
  var rawLocalSnapshot = null; /* 迁移用：file:// 或旧浏览器里的原始存档 */
  var SESSION_KEY = 'msyq.entered';
  var THEME_ORDER = ['pink', 'ice'];
  var NO_TAB_VIEWS = ['characters', 'personas', 'books', 'providers', 'presets', 'stats'];

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* 转义后再把中文引号段落包成强调色（不引入 HTML 片段风险） */
  function rich(s) {
    return esc(s).replace(/「[^」]*」/g, function (m) { return '<span class="q">' + m + '</span>'; });
  }

  function fmtNum(n) {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  /* 按 OpenAI 兼容 usage 结构渲染统计：prompt_tokens / completion_tokens / total_tokens */
  function renderUsage(usage, ms) {
    if (!usage) return '';
    var p = usage.prompt_tokens || 0;
    var c = usage.completion_tokens || 0;
    var t = usage.total_tokens || (p + c);
    var parts = ['↑ 输入 ' + fmtNum(p), '↓ 输出 ' + fmtNum(c), '本轮 ' + fmtNum(t) + ' tok'];
    if (ms) parts.push((ms / 1000).toFixed(1) + 's');
    return parts.join(' · ');
  }

  /* 只有离线演示回复用得到：按字数估一个像样的 usage 与耗时，别假装是真实数据。 */
  function estimateUsage(text) {
    var prompt = 1120 + text.length * 21;
    var completion = 160 + text.length * 7;
    return {
      usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion },
      ms: 900 + Math.round((text.length % 7) * 130)
    };
  }

  var WEEK_CN = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
  function homeWeekdayText(d) {
    return '周' + WEEK_CN[d.getDay()].slice(2) + ' · ' + (d.getMonth() + 1) + '月' + d.getDate() + '日';
  }
  function greetingText(d) {
    var h = d.getHours();
    var rp = resolvedPersona(chatOf(state.currentCharacterId), currentChar());
    var name = rp.persona ? rp.persona.name : DATA.user;
    if (h < 6) return '夜里好，' + name;
    if (h < 11) return '早上好，' + name;
    if (h < 14) return '中午好，' + name;
    if (h < 19) return '下午好，' + name;
    return '晚上好，' + name;
  }
  function sinceTextDots(str) {
    var d = parseDay(str);
    if (!d) return '';
    return '自 ' + d.getFullYear() + '.' + pad2(d.getMonth() + 1) + '.' + pad2(d.getDate());
  }
  var sessionUsage = { total: 0, prompt: 0, completion: 0 };

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function hm(d) { return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }
  function monthDay(d) { return (d.getMonth() + 1) + '月' + d.getDate() + '日'; }

  var CN_DIGITS = ['〇', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
  function cnYear(y) {
    return String(y).split('').map(function (d) { return CN_DIGITS[+d]; }).join('');
  }
  function cnNum(n) {
    if (n <= 10) return n === 10 ? '十' : CN_DIGITS[n];
    if (n < 20) return '十' + CN_DIGITS[n - 10];
    if (n % 10 === 0) return CN_DIGITS[Math.floor(n / 10)] + '十';
    return CN_DIGITS[Math.floor(n / 10)] + '十' + CN_DIGITS[n % 10];
  }
  var WEEK = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
  function longDate(d) {
    return cnYear(d.getFullYear()) + '年' + cnNum(d.getMonth() + 1) + '月' + cnNum(d.getDate()) + '日 · ' + WEEK[d.getDay()];
  }

  function parseDay(str) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str || '');
    if (!m) return null;
    return new Date(+m[1], +m[2] - 1, +m[3]);
  }
  function daysTogether(str) {
    var start = parseDay(str);
    if (!start) return 1;
    var now = new Date();
    var a = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    var b = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return Math.max(1, Math.round((b - a) / 86400000) + 1);
  }
  function sinceText(str) {
    var d = parseDay(str);
    if (!d) return '';
    return '自 ' + d.getFullYear() + ' 年 ' + (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日';
  }
  function formatBackup(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '尚未备份';
    return monthDay(d) + ' ' + hm(d);
  }
  function formatDur(sec) {
    sec = Math.max(0, Math.round(sec));
    return pad2(Math.floor(sec / 60)) + ':' + pad2(sec % 60);
  }
  function reducedMotion() {
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  /* ---------------- 本地存档 ---------------- */
  function defaultBackup() {
    var d = new Date();
    d.setDate(d.getDate() - 1);
    d.setHours(23, 12, 0, 0);
    return d.toISOString();
  }

  function newId(prefix) {
    return prefix + '-' + Math.random().toString(36).slice(2, 7) + Date.now().toString(36).slice(-4);
  }
  function clone(obj) { return JSON.parse(JSON.stringify(obj)); }
  function byId(list, id) {
    for (var i = 0; i < (list || []).length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  var RETIRED_PRESET_MODELS = {
    'model-deepseek-chat': 'model-deepseek-flash',
    'model-claude-sonnet': 'model-claude-sonnet-5-5',
    'model-claude-sonnet-4-5': 'model-claude-sonnet-5-5',
    'model-gpt5': 'model-gpt6-sol',
    'model-gpt-5': 'model-gpt6-sol',
    'model-gpt5-mini': 'model-gpt6-luna',
    'model-o4-mini': 'model-gpt6-luna',
    'model-gemini-pro': 'model-gemini4',
    'model-gemini-flash': 'model-gemini38',
    'model-qwen25': 'model-glm52'
  };

  function mergePresetCatalog(st) {
    if (!st) return st;
    var catalog = clone(DATA.modelRegistry) || [];
    var freshById = {};
    catalog.forEach(function (m) { freshById[m.id] = m; });
    var kept = [];
    var seen = {};
    (st.models || []).forEach(function (m) {
      if (!m || !m.id) return;
      if (RETIRED_PRESET_MODELS[m.id]) return;
      if (freshById[m.id]) {
        var next = clone(freshById[m.id]);
        if (typeof m.favorite === 'boolean') next.favorite = m.favorite;
        kept.push(next);
        seen[m.id] = true;
      } else if (m.source !== 'preset') {
        kept.push(m);
      }
    });
    catalog.forEach(function (m) {
      if (!seen[m.id]) kept.push(clone(m));
    });
    st.models = kept;

    var idsByProv = {};
    kept.forEach(function (m) {
      if (!idsByProv[m.providerId]) idsByProv[m.providerId] = [];
      idsByProv[m.providerId].push(m.id);
    });
    (st.providers || []).forEach(function (p) {
      var catalogIds = idsByProv[p.id] || [];
      var userIds = (p.models || []).filter(function (id) {
        return kept.some(function (m) { return m.id === id && m.source !== 'preset'; });
      });
      var out = catalogIds.slice();
      userIds.forEach(function (id) { if (out.indexOf(id) === -1) out.push(id); });
      p.models = out;
    });

    function remap(id) { return RETIRED_PRESET_MODELS[id] || id; }
    st.modelId = remap(st.modelId);
    if (!byId(st.models, st.modelId)) st.modelId = 'model-deepseek-flash';
    Object.keys(st.chats || {}).forEach(function (cid) {
      var chat = st.chats[cid];
      if (chat && chat.modelId) {
        chat.modelId = remap(chat.modelId);
        if (!byId(st.models, chat.modelId)) chat.modelId = st.modelId;
      }
    });
    return st;
  }

  function baseState() {
    return {
      theme: 'pink',
      overrides: { pink: {}, ice: {} },
      settings: {
        notify: DATA.settings.notify,
        splashAlways: DATA.settings.splashAlways,
        startDate: DATA.settings.startDate,
        chatFont: DATA.settings.chatFont || 'md',
        globalBookId: '',
        defaultPresetId: 'preset-default'
      },
      nowText: DATA.nowText,
      memories: DATA.memories.map(function (m) {
        var c = {};
        Object.keys(m).forEach(function (k) { c[k] = m[k]; });
        c.forgotten = false;
        c.pinned = !!m.pinned;
        c.protected = !!m.protected;
        return c;
      }),
      backupAt: defaultBackup(),
      model: { model: DATA.models[0].name },
      modelId: 'model-deepseek-flash',
      providers: clone(DATA.providers),
      models: clone(DATA.modelRegistry),
      promptPresets: clone(DATA.promptPresets),
      listen: { playlist: 0, song: 0 },
      characters: clone(DATA.characters),
      userPersonas: clone(DATA.userPersonas),
      worldBooks: clone(DATA.worldBooks),
      chats: {},
      currentCharacterId: DATA.characters[0].id
    };
  }

  /* 读本地存档；v1 旧键里的主题 / 记忆等偏好仍接过来（人设、用户卡由三个库取代） */
  function loadState() {
    var base = baseState();
    var saved = null;
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (raw) saved = JSON.parse(raw);
      if (!saved) {
        var oldRaw = localStorage.getItem(OLD_STORE_KEY);
        if (oldRaw) saved = JSON.parse(oldRaw);
      }
    } catch (e) { saved = null; }
    if (!saved || typeof saved !== 'object') return base;
    try { rawLocalSnapshot = clone(saved); } catch (e) { rawLocalSnapshot = null; }

    if (saved.theme === 'pink' || saved.theme === 'ice') base.theme = saved.theme;
    if (saved.overrides) {
      ['pink', 'ice'].forEach(function (t) {
        if (saved.overrides[t] && typeof saved.overrides[t] === 'object') {
          base.overrides[t] = saved.overrides[t];
        }
      });
    }
    if (saved.settings && typeof saved.settings === 'object') {
      if (typeof saved.settings.notify === 'boolean') base.settings.notify = saved.settings.notify;
      if (typeof saved.settings.splashAlways === 'boolean') base.settings.splashAlways = saved.settings.splashAlways;
      if (parseDay(saved.settings.startDate)) base.settings.startDate = saved.settings.startDate;
      if (saved.settings.chatFont === 'sm' || saved.settings.chatFont === 'md' || saved.settings.chatFont === 'lg') {
        base.settings.chatFont = saved.settings.chatFont;
      }
      if (typeof saved.settings.globalBookId === 'string') base.settings.globalBookId = saved.settings.globalBookId;
    }
    if (typeof saved.nowText === 'string' && saved.nowText) base.nowText = saved.nowText;
    if (Array.isArray(saved.memories)) {
      var map = {};
      base.memories.forEach(function (m) { map[m.id] = m; });
      saved.memories.forEach(function (s) {
        if (map[s.id]) Object.assign(map[s.id], s);
      });
    }
    if (saved.backupAt) base.backupAt = saved.backupAt;
    if (saved.model && DATA.models.some(function (m) { return m.name === saved.model.model; })) {
      base.model.model = saved.model.model;
    }
    if (saved.listen) {
      if (typeof saved.listen.playlist === 'number' && DATA.playlists[saved.listen.playlist]) base.listen.playlist = saved.listen.playlist;
      if (typeof saved.listen.song === 'number') base.listen.song = saved.listen.song;
    }
    /* 三个库：本地存档优先 */
    if (Array.isArray(saved.characters) && saved.characters.length) base.characters = saved.characters;
    if (Array.isArray(saved.userPersonas) && saved.userPersonas.length) base.userPersonas = saved.userPersonas;
    if (Array.isArray(saved.worldBooks)) base.worldBooks = saved.worldBooks;
    if (saved.chats && typeof saved.chats === 'object' && !Array.isArray(saved.chats)) base.chats = saved.chats;
    if (saved.currentCharacterId && byId(base.characters, saved.currentCharacterId)) {
      base.currentCharacterId = saved.currentCharacterId;
    }
    /* A2：提供商 / 模型库 / 提示词预设 / 当前模型 */
    if (Array.isArray(saved.providers) && saved.providers.length) base.providers = saved.providers;
    if (Array.isArray(saved.models) && saved.models.length) base.models = saved.models;
    if (Array.isArray(saved.promptPresets) && saved.promptPresets.length) base.promptPresets = saved.promptPresets;
    if (saved.settings && typeof saved.settings.defaultPresetId === 'string' && byId(base.promptPresets, saved.settings.defaultPresetId)) {
      base.settings.defaultPresetId = saved.settings.defaultPresetId;
    }
    if (typeof saved.modelId === 'string' && byId(base.models, saved.modelId)) {
      base.modelId = saved.modelId;
    } else if (saved.model && saved.model.model) {
      /* 旧存档迁移：把 A 阶段的三个假模型名对到真实一点的模型上 */
      var legacyModelMap = { 'DeepSeek': 'model-deepseek-flash', '白露 · 慢': 'model-bailu-slow', '云雀 · 轻': 'model-bailu-lite' };
      if (legacyModelMap[saved.model.model]) base.modelId = legacyModelMap[saved.model.model];
    }

    /* 至少要有一套全局默认用户设定 */
    var hasDefault = base.userPersonas.some(function (p) { return p.is_default; });
    if (!hasDefault && base.userPersonas.length) base.userPersonas[0].is_default = true;

    mergePresetCatalog(base);
    return base;
  }

  var state = loadState();

  /* ================================================================
     B 阶段：同源后端（server/）接入
     通过 http(s) 打开页面时以后端为权威；file:// 打开时保留本地降级，
     方便离线看样稿。浏览器不再持有明文 API Key。
     ================================================================ */
  var API_BASE = '/api';
  var SERVER_MODE = location.protocol === 'http:' || location.protocol === 'https:';
  var serverOnline = false;
  var serverInfo = { mockModel: false, version: '', authRequired: false, devMode: true };
  var authRequired = false;
  var devMode = true;
  var usageSummary = null;
  var pendingProviderKey = null;
  var syncTimer = null;
  var syncFailedNotified = false;
  var loginBusy = false;

  function serverFetch(path, options) {
    var opts = options || {};
    var headers = opts.headers || {};
    var body = opts.body;
    if (body !== undefined && !(body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(body);
    }
    return fetch(API_BASE + path, {
      method: opts.method || 'GET',
      credentials: 'same-origin',
      headers: headers,
      body: body
    }).then(function (res) {
      var ct = res.headers.get('content-type') || '';
      var parsing = ct.indexOf('application/json') !== -1
        ? res.json().catch(function () { return {}; })
        : res.text().then(function (text) { return { text: text }; });
      return parsing.then(function (data) {
        if (!res.ok) {
          var err = (data && data.error) || {};
          var e = new Error(err.message || ('请求没成功（' + res.status + '）。'));
          e.kind = err.kind || 'http';
          e.status = res.status;
          e.detail = err.detail || '';
          throw e;
        }
        return data;
      });
    }).catch(function (err) {
      if (err && err.kind) throw err;
      var e = new Error('连不上服务器：检查后端是否在运行。');
      e.kind = 'network';
      throw e;
    });
  }

  function serverDownload(path) {
    return fetch(API_BASE + path, { credentials: 'same-origin' }).then(function (res) {
      if (!res.ok) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          var err = (data && data.error) || {};
          var e = new Error(err.message || '导出没成功，稍后再试。');
          e.kind = err.kind || 'http';
          throw e;
        });
      }
      return res.blob();
    });
  }

  function downloadBlob(filename, blob) {
    try {
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      window.setTimeout(function () {
        if (a.parentNode) a.parentNode.removeChild(a);
        URL.revokeObjectURL(url);
      }, 700);
      return true;
    } catch (e) { return false; }
  }

  function apiToast(err) {
    toast((err && err.message) || '请求没成功，稍后再试。');
  }

  function serverUpload(path, file, mode) {
    var form = new FormData();
    form.append('file', file, file.name || 'upload');
    if (mode) form.append('mode', mode);
    return serverFetch(path, { method: 'POST', body: form });
  }

  /* ---------- 用后端快照覆盖本地状态 ---------- */
  function applyServerState(snapshot) {
    if (!snapshot) return;
    ['characters', 'userPersonas', 'worldBooks', 'providers', 'models', 'promptPresets', 'memories'].forEach(function (key) {
      if (Array.isArray(snapshot[key])) state[key] = snapshot[key];
    });
    if (snapshot.chats && typeof snapshot.chats === 'object' && !Array.isArray(snapshot.chats)) {
      state.chats = snapshot.chats;
    }
    if (snapshot.theme === 'pink' || snapshot.theme === 'ice') state.theme = snapshot.theme;
    if (snapshot.overrides && typeof snapshot.overrides === 'object') {
      ['pink', 'ice'].forEach(function (t) {
        if (snapshot.overrides[t] && typeof snapshot.overrides[t] === 'object') state.overrides[t] = snapshot.overrides[t];
      });
    }
    if (snapshot.settings && typeof snapshot.settings === 'object') {
      state.settings = Object.assign({}, baseState().settings, snapshot.settings);
    }
    if (snapshot.listen && typeof snapshot.listen === 'object') state.listen = snapshot.listen;
    if (typeof snapshot.nowText === 'string') state.nowText = snapshot.nowText;
    if (typeof snapshot.backupAt === 'string') state.backupAt = snapshot.backupAt || '';
    if (typeof snapshot.modelId === 'string') state.modelId = snapshot.modelId;
    if (typeof snapshot.currentCharacterId === 'string') state.currentCharacterId = snapshot.currentCharacterId;
    normalizeCollections();
  }

  function normalizeCollections() {
    if (!Array.isArray(state.characters)) state.characters = [];
    if (!Array.isArray(state.userPersonas)) state.userPersonas = [];
    if (!Array.isArray(state.worldBooks)) state.worldBooks = [];
    if (!Array.isArray(state.providers)) state.providers = [];
    if (!Array.isArray(state.models)) state.models = [];
    if (!Array.isArray(state.promptPresets)) state.promptPresets = [];
    if (!Array.isArray(state.memories)) state.memories = [];
    if (!state.chats || typeof state.chats !== 'object' || Array.isArray(state.chats)) state.chats = {};
    if (!findChar(state.currentCharacterId)) {
      state.currentCharacterId = state.characters.length ? state.characters[0].id : '';
    }
    if (!findModel(state.modelId)) state.modelId = state.models.length ? state.models[0].id : '';
    if (!state.userPersonas.some(function (p) { return p.is_default; }) && state.userPersonas.length) {
      state.userPersonas[0].is_default = true;
    }
    if (!state.settings) state.settings = baseState().settings;
    if (!state.settings.defaultPresetId) state.settings.defaultPresetId = 'preset-default';
    if (!state.overrides) state.overrides = { pink: {}, ice: {} };
    if (!state.listen) state.listen = { playlist: 0, song: 0 };
  }

  /* ---------- 整体同步：后端为权威，浏览器只发编辑后的集合 ---------- */
  function serverSnapshot() {
    var chats = {};
    Object.keys(state.chats || {}).forEach(function (cid) {
      var chat = state.chats[cid] || {};
      chats[cid] = {
        id: chat.id || '',
        personaId: chat.personaId || '',
        worldBookId: chat.worldBookId || '',
        presetId: chat.presetId || '',
        modelId: chat.modelId || '',
        reasoningLevel: chat.reasoningLevel || '',
        title: chat.title || '',
        lastAt: chat.lastAt || ''
      };
    });
    var providers = state.providers.map(function (p) {
      var copy = clone(p);
      /* 明文 Key 永远不经过整体同步；新 Key 走 /providers/{id}/key */
      delete copy.apiKey;
      delete copy.hasKey;
      delete copy.keyMasked;
      return copy;
    });
    return {
      theme: state.theme,
      overrides: state.overrides,
      settings: state.settings,
      listen: state.listen,
      backupAt: state.backupAt,
      modelId: state.modelId,
      currentCharacterId: state.currentCharacterId,
      characters: state.characters,
      userPersonas: state.userPersonas,
      worldBooks: state.worldBooks,
      providers: providers,
      models: state.models,
      promptPresets: state.promptPresets,
      chats: chats
    };
  }

  function pushServerState() {
    syncTimer = null;
    if (!serverOnline) return;
    serverFetch('/state', { method: 'PUT', body: { state: serverSnapshot() } }).catch(function (err) {
      if (!syncFailedNotified) {
        syncFailedNotified = true;
        toast('同步到服务器失败：' + err.message);
      }
    });
  }

  function scheduleServerSync() {
    if (!serverOnline || !SERVER_MODE) return;
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(pushServerState, 350);
  }

  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) { /* 忽略 */ }
    scheduleServerSync();
  }

  function refreshFromServer(opts) {
    if (!serverOnline) return Promise.resolve(false);
    /* 以服务器快照为准：取消尚未发出的本地整体同步，避免旧快照覆盖刚写入的数据 */
    if (syncTimer) { clearTimeout(syncTimer); syncTimer = null; }
    return serverFetch('/bootstrap').then(function (boot) {
      serverInfo = boot.server || serverInfo;
      usageSummary = boot.usage || usageSummary;
      applyServerState(boot.state);
      if (opts && opts.chat) {
        var chat = ensureChat(state.currentCharacterId, true);
        chatMessages = chat ? chat.messages : [];
      }
      renderAfterServerRefresh();
      return true;
    }).catch(function (err) {
      toast('刷新失败：' + err.message);
      return false;
    });
  }

  function renderAfterServerRefresh() {
    applyTheme(state.theme);
    renderHome();
    renderMemories();
    renderMe();
    renderSettings();
    renderLibraries();
    renderChatContext();
    paintAllAvatars();
    if (currentView === 'providers') renderProviders();
    if (currentView === 'presets') renderPresets();
    if (currentView === 'stats') renderStats();
    if (currentView === 'chat') { renderChat(); updateChatHeader(); }
    // 记忆属于「某段关系」，所以换角色/换用户设定之后要按新关系重新取，
    // 否则首页的「今日记住」可能还挂着上一段关系的内容。
    if (serverOnline) { refreshBondsQuiet(); refreshMemoriesQuiet(); }
  }

  function refreshUsageSummary() {
    if (!serverOnline) return Promise.resolve();
    return serverFetch('/usage/summary').then(function (data) {
      usageSummary = data;
      renderMe();
      renderHome();
    }).catch(function () { /* 忽略 */ });
  }

  /* ---------- 登录 ---------- */
  function showLogin(message) {
    var layer = $('#loginLayer');
    if (!layer) { toast(message || '需要登录。'); return; }
    layer.classList.add('is-open');
    layer.setAttribute('aria-hidden', 'false');
    var sub = $('#loginSub');
    if (sub) sub.textContent = message || '这台服务设置了登录密码，先输入再进去。';
    var note = $('#loginNote');
    if (note) note.textContent = '密码设置在后端的 APP_PASSWORD 里；浏览器只保存一个 HttpOnly 的会话 cookie。';
    setTimeout(function () {
      var input = $('#loginPass');
      if (input) { try { input.focus({ preventScroll: true }); } catch (e) { /* 忽略 */ } }
    }, 80);
  }

  function hideLogin() {
    var layer = $('#loginLayer');
    if (!layer) return;
    layer.classList.remove('is-open');
    layer.setAttribute('aria-hidden', 'true');
  }

  function submitLogin() {
    if (!SERVER_MODE) return;
    var input = $('#loginPass');
    var btn = $('#loginBtn');
    var password = input ? input.value : '';
    if (!password) { showLogin('先输入密码。'); return; }
    if (loginBusy) return;
    loginBusy = true;
    if (btn) btn.textContent = '正在进入…';
    serverFetch('/auth/login', { method: 'POST', body: { password: password } }).then(function () {
      if (input) input.value = '';
      hideLogin();
      return loadServerApp();
    }).catch(function (err) {
      showLogin(err.message || '密码不对，再试一次。');
    }).then(function () {
      loginBusy = false;
      if (btn) btn.textContent = '进入';
    });
  }

  /* ---------- 从浏览器迁移（可重复、幂等） ---------- */
  function offerMigration() {
    if (!serverOnline || !rawLocalSnapshot) return;
    try { if (localStorage.getItem('msyq.migrated') === '1') return; } catch (e) { return; }
    if (!rawLocalSnapshot || (!rawLocalSnapshot.characters && !rawLocalSnapshot.chats && !rawLocalSnapshot.memories)) return;
    openSheet('migrateOffer');
  }

  function runMigration(includeKeys) {
    if (!serverOnline || !rawLocalSnapshot) return;
    var payload = clone(rawLocalSnapshot);
    if (!includeKeys) {
      (payload.providers || []).forEach(function (p) { p.apiKey = ''; });
    }
    serverFetch('/migrate/local', { method: 'POST', body: { state: payload, includeApiKeys: !!includeKeys } }).then(function (result) {
      try { localStorage.setItem('msyq.migrated', '1'); } catch (e) { /* 忽略 */ }
      /* 迁移后清空浏览器里的明文 Key */
      try {
        var stored = localStorage.getItem(STORE_KEY);
        if (stored) {
          var parsed = JSON.parse(stored);
          (parsed.providers || []).forEach(function (p) { p.apiKey = ''; });
          localStorage.setItem(STORE_KEY, JSON.stringify(parsed));
        }
      } catch (e) { /* 忽略 */ }
      closeSheet();
      var imported = result.imported || {};
      toast('迁移完成：角色 ' + (imported.characters || 0) + ' 位、聊天 ' + (imported.chats || 0) + ' 场、记忆 ' + (imported.memories || 0) + ' 条。');
      refreshFromServer({ chat: true });
    }).catch(apiToast);
  }

  /* ================================================================
     A 阶段：角色库 / 用户设定 / 世界书（纯本地关系）
     一场聊天 = 一个角色 + 一套用户设定；世界书：全局一本 + 角色一本 + 这场一本
     ================================================================ */
  var libCharId = '';
  var libPersonaId = '';
  var libBookId = '';
  var personaPending = null;
  var pendingCharImport = null;
  var pendingBookImport = null;
  var charDraft = null;
  var avatarPickTarget = '';
  var avatarPickId = '';

  var LIB_CHEV = '<svg class="row-chev" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M8 5.6 12.4 10 8 14.4"/></svg>';
  var LIB_FOLD_CHEV = '<svg class="fold__chev" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M6.4 8 10 11.6 13.6 8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var LIB_BOOK_ICON = '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M4.4 4.4h5.1c.7 0 1.2.5 1.2 1.2v10H5.6c-.7 0-1.2-.5-1.2-1.2V4.4z"/><path d="M15.6 4.4h-5.1c-.7 0-1.2.5-1.2 1.2v10h5.1c.7 0 1.2-.5 1.2-1.2V4.4z"/></svg>';

  function findChar(id) { return byId(state.characters, id); }
  function findPersona(id) { return byId(state.userPersonas, id); }
  function findBook(id) { return byId(state.worldBooks, id); }
  function findEntry(bookId, entryId) {
    var b = findBook(bookId);
    return b ? byId(b.entries, entryId) : null;
  }
  function currentChar() { return findChar(state.currentCharacterId) || state.characters[0] || null; }
  function chatOf(charId) { return state.chats[charId] || null; }

  function defaultPersona() {
    for (var i = 0; i < state.userPersonas.length; i++) {
      if (state.userPersonas[i].is_default) return state.userPersonas[i];
    }
    return state.userPersonas[0] || null;
  }
  function resolvedPersona(chat, char) {
    if (chat && chat.personaId) {
      var p = findPersona(chat.personaId);
      if (p) return { persona: p, source: 'chat' };
    }
    if (char && char.defaultPersonaId) {
      var q = findPersona(char.defaultPersonaId);
      if (q) return { persona: q, source: 'char' };
    }
    return { persona: defaultPersona(), source: 'global' };
  }
  // 记忆的归属单位是「一段关系」= 当前角色 × 当前用户设定，不是单个角色。
  function currentBond() {
    var char = currentChar();
    var chat = char ? chatOf(char.id) : null;
    var r = resolvedPersona(chat, char);
    return { characterId: char ? char.id : '', personaId: (r.persona && r.persona.id) || '' };
  }
  function memoryScope() {
    if (memoryScopeOverride) return memoryScopeOverride;
    var b = currentBond();
    return { characterId: b.characterId, personaId: b.personaId, scope: '' };
  }
  /* 「在一起多少天」按每段关系自己的开始日期算；没设过就退回全局设置 */
  function bondStartDate() {
    var b = currentBond();
    var hit = null;
    (state.bonds || []).forEach(function (x) {
      if (x.characterId === b.characterId && x.personaId === b.personaId) hit = x;
    });
    return (hit && hit.startedAt) || state.settings.startDate;
  }
  /* 这条记忆属不属于「当前查看的那段关系」。
     渲染层再判一次，这样即使请求失败、state.memories 里还是别人的数据，
     也不会出现「标签是阿杞、内容是缪诗」的情况。 */
  function memoryVisible(m) {
    var sc = memoryScope();
    var scope = m.scope || 'pair';
    if (sc.scope === 'world') return scope === 'world';
    if (scope === 'world') return true;
    if (!sc.characterId) return true;
    if (scope === 'character') return m.characterId === sc.characterId;
    if (!m.characterId || !m.personaId) return false;   // 未归属的不显示
    return m.characterId === sc.characterId && m.personaId === sc.personaId;
  }
  function bondQuery() {
    var b = memoryScope();
    if (b.scope === 'world') return '&scope=world';
    var qs = '';
    if (b.characterId) {
      qs = '&characterId=' + encodeURIComponent(b.characterId) + '&personaId=' + encodeURIComponent(b.personaId);
    }
    return qs;
  }
  function personaSourceLabel(source, char) {
    if (source === 'chat') return '这场指定';
    if (source === 'char') return (char ? char.name : '角色') + '的默认';
    return '全局默认';
  }

  function resolvedBooksFor(chat, char) {
    var out = [];
    function add(id) {
      if (!id) return;
      var b = findBook(id);
      if (b && out.indexOf(b) === -1) out.push(b);
    }
    add(state.settings.globalBookId);
    if (char) add(char.worldBookId);
    if (chat) add(chat.worldBookId);
    return out;
  }
  function bookSummary(chat, char) {
    var list = resolvedBooksFor(chat, char);
    if (!list.length) return '未挂';
    if (list.length === 1) return list[0].name;
    return list[0].name + ' 等 ' + list.length + ' 本';
  }
  function bookUsage(bookId) {
    var out = [];
    if (state.settings.globalBookId === bookId) out.push('全局');
    state.characters.forEach(function (c) {
      if (c.worldBookId === bookId) out.push(c.name);
    });
    Object.keys(state.chats).forEach(function (cid) {
      var ch = state.chats[cid];
      if (ch && ch.worldBookId === bookId) {
        var c = findChar(cid);
        out.push((c ? c.name : '某场') + '的聊天');
      }
    });
    return out;
  }

  /* ---------- 头像（支持导入的图片头像） ---------- */
  function initialOf(person) {
    return person && person.name ? String(person.name).charAt(0) : '·';
  }
  function avatarHTML(person, cls) {
    if (person && person.avatar) {
      return '<span class="' + cls + ' avatar--img"><img src="' + esc(person.avatar) + '" alt=""></span>';
    }
    return '<span class="' + cls + '">' + esc(initialOf(person)) + '</span>';
  }
  function paintAvatar(el, person) {
    if (!el) return;
    if (person && person.avatar) {
      el.classList.add('avatar--img');
      el.innerHTML = '<img src="' + esc(person.avatar) + '" alt="">';
    } else {
      el.classList.remove('avatar--img');
      el.textContent = initialOf(person);
    }
  }
  function paintAllAvatars() {
    var c = currentChar();
    var rp = resolvedPersona(chatOf(state.currentCharacterId), c).persona;
    $$('[data-av="char"]').forEach(function (el) { paintAvatar(el, c); });
    $$('[data-av="persona"]').forEach(function (el) { paintAvatar(el, rp); });
    $$('[data-nm="char"]').forEach(function (el) { el.textContent = c ? c.name : ''; });
    $$('[data-nm="persona"]').forEach(function (el) { el.textContent = rp ? rp.name : ''; });
  }

  /* ---------- 聊天：每个角色一场（最近一场） ---------- */
  function chatInitMessages(char) {
    /* 接后端时消息由服务器维护（开场白会在 ensure 时写入），
       不再把 A 阶段的假对话塞进真实聊天里。离线模式保留演示对话。 */
    if (serverOnline) return [];
    if (char.id === 'miao') return clone(DATA.chat);
    if (char.first_mes) return [{ role: 'ai', text: char.first_mes, time: hm(new Date()) }];
    return [];
  }
  function ensureChat(charId) {
    var c = findChar(charId);
    if (!c) return null;
    if (!state.chats[charId]) {
      var msgs = chatInitMessages(c);
      state.chats[charId] = {
        characterId: charId,
        personaId: '',
        worldBookId: '',
        presetId: '',
        modelId: '',
        reasoningLevel: '',
        messages: msgs,
        lastAt: msgs.length ? new Date().toISOString() : ''
      };
      if (serverOnline) {
        serverFetch('/chats/' + encodeURIComponent(charId) + '/ensure', { method: 'POST' }).then(function (data) {
          var chat = state.chats[charId];
          if (!chat || !data || !data.chat) return;
          if (!chat.messages || !chat.messages.length) {
            chat.messages = data.chat.messages || [];
            chat.lastAt = data.chat.lastAt || chat.lastAt;
            if (state.currentCharacterId === charId) {
              chatMessages = chat.messages;
              renderChat();
            }
          }
        }).catch(function () { /* 下次发消息时后端会再建 */ });
      }
      save();
    }
    return state.chats[charId];
  }
  function hasChat(charId) {
    var c = state.chats[charId];
    return !!(c && c.messages && c.messages.length);
  }
  function lastChatLabel(charId) {
    var c = state.chats[charId];
    if (!c || !c.lastAt) return '';
    var d = new Date(c.lastAt);
    if (isNaN(d.getTime())) return '';
    return monthDay(d) + ' ' + hm(d);
  }
  function statusLine(char) {
    if (hasChat(char.id)) {
      var t = lastChatLabel(char.id);
      return t ? '最近聊过 · ' + t : '最近聊过';
    }
    return '还没有聊天';
  }
  function openChat(charId) {
    var c = findChar(charId);
    if (!c) return;
    state.currentCharacterId = charId;
    var chat = ensureChat(charId);
    chatMessages = chat.messages;
    save();
    renderChat();
    updateChatHeader();
    renderChatContext();
    renderMe();
    paintAllAvatars();
  }
  function persistChat() {
    var chat = state.chats[state.currentCharacterId];
    if (!chat) return;
    if (typeof d2EnsureMessageIds === 'function') d2EnsureMessageIds(chatMessages);
    chat.messages = chatMessages;
    chat.lastAt = new Date().toISOString();
    save();
  }
  function renderChatContext() {
    var char = currentChar();
    var chat = chatOf(state.currentCharacterId);
    var rp = resolvedPersona(chat, char);
    var pn = $('#chatPersonaName');
    if (pn) pn.textContent = rp.persona ? rp.persona.name : '未设置';
    var bn = $('#chatBookName');
    if (bn) bn.textContent = bookSummary(chat, char);
    var prn = $('#chatPresetName');
    if (prn) {
      var rp2 = resolvedPreset(chat, char);
      prn.textContent = rp2.preset ? rp2.preset.name : '默认';
    }
  }

  /* ---------- 绑定操作 ---------- */
  function setGlobalPersona(personaId) {
    state.userPersonas.forEach(function (p) { p.is_default = p.id === personaId; });
    save();
    paintAllAvatars();
    renderChatContext();
    renderMe();
    if (!libPersonaId) renderPersonaLibrary();
  }
  function setCharWorldBook(charId, bookId) {
    var c = findChar(charId);
    if (!c) return;
    c.worldBookId = bookId || '';
    save();
    renderCharLibrary();
    renderBookLibrary();
    renderChatContext();
    renderMe();
    toast(bookId ? '已挂上《' + (findBook(bookId) || {}).name + '》。' : '已经取下来了。');
  }
  function setCharDefaultPersona(charId, personaId) {
    var c = findChar(charId);
    if (!c) return;
    c.defaultPersonaId = personaId || '';
    save();
    renderCharLibrary();
    renderPersonaLibrary();
    renderChatContext();
    renderMe();
    paintAllAvatars();
    toast(personaId ? c.name + ' 以后默认用「' + (findPersona(personaId) || {}).name + '」。' : c.name + ' 改为跟全局默认。');
  }
  function setChatWorldBook(bookId) {
    var chat = ensureChat(state.currentCharacterId);
    if (!chat) return;
    chat.worldBookId = bookId || '';
    save();
    renderChatContext();
    renderBookLibrary();
    toast(bookId ? '这场聊天挂上了《' + (findBook(bookId) || {}).name + '》。' : '这场聊天不单独挂书了。');
  }
  function applyChatPersona(mode) {
    var char = currentChar();
    if (!char) return;
    var chat = ensureChat(char.id);
    var p = personaPending ? findPersona(personaPending) : null;
    if (mode === 'chat') {
      chat.personaId = personaPending || '';
      save();
      closeSheet();
      personaPending = null;
      renderChatContext();
      renderMe();
      paintAllAvatars();
      toast(p ? '这场聊天里的我是「' + p.name + '」。' : '这场聊天跟随默认。');
    } else {
      if (!p) return;
      chat.personaId = p.id;
      char.defaultPersonaId = p.id;
      save();
      closeSheet();
      personaPending = null;
      renderChatContext();
      renderMe();
      renderCharLibrary();
      renderPersonaLibrary();
      paintAllAvatars();
      toast('这场用「' + p.name + '」，' + char.name + ' 以后的聊天也默认用「' + p.name + '」。');
    }
  }

  /* ---------- 库列表 / 详情渲染 ---------- */
  function firstSentence(text) {
    var s = String(text || '').replace(/\s+/g, ' ').trim();
    if (!s) return '';
    var m = /^(.{0,38}?[。！？!?])/.exec(s);
    return m ? m[1] : s.slice(0, 38);
  }
  function extraCount(c) {
    var ex = c.extras || {};
    var n = 0;
    ['top', 'data'].forEach(function (k) { if (ex[k]) n += Object.keys(ex[k]).length; });
    if (ex.extensions) n += Object.keys(ex.extensions).length;
    return n;
  }
  function fieldBlockHtml(label, text) {
    return '<article class="field-block"><p class="field-block__label">' + esc(label) + '</p>' +
      (text ? '<p class="field-block__text serif">' + esc(text) + '</p>'
        : '<p class="field-block__text field-block__text--muted">还没有写。</p>') + '</article>';
  }
  function foldBlockHtml(label, text) {
    return '<details class="fold field-block"><summary><span class="field-block__label">' + esc(label) + '</span>' + LIB_FOLD_CHEV + '</summary>' +
      (text ? '<p class="field-block__text serif">' + esc(text) + '</p>'
        : '<p class="field-block__text field-block__text--muted">还没有写。</p>') + '</details>';
  }
  function libAction(label, action, icon, primary) {
    return '<button class="lib-action' + (primary ? ' lib-action--primary' : '') + '" type="button" data-action="' + action + '">' +
      icon + esc(label) + '</button>';
  }
  var IC_IMPORT = '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M10 3.6v7.2M6.8 7.6l3.2 3.2 3.2-3.2M4.4 13.4v2.2c0 .6.5 1.1 1.1 1.1h9c.6 0 1.1-.5 1.1-1.1v-2.2"/></svg>';
  var IC_PLUS = '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M10 4.6v10.8M4.6 10h10.8"/></svg>';

  /* 角色库 */
  function renderCharLibrary() {
    var box = $('#charLibScroll');
    if (!box) return;
    var title = $('#charLibTitle');
    if (libCharId) { renderCharDetail(); return; }
    if (title) title.textContent = '角色库';
    var cards = state.characters.map(function (c) {
      var badge = c.source && c.source !== 'preset' ? '<span class="lib-card__badge">导入</span>' : '';
      return '<button class="lib-card" type="button" data-char-open="' + esc(c.id) + '" aria-label="打开 ' + esc(c.name) + '">' +
        avatarHTML(c, 'avatar avatar--ai lib-card__avatar') +
        '<span class="lib-card__main">' +
          '<span class="lib-card__title">' + esc(c.name) + badge + '</span>' +
          '<span class="lib-card__desc">' + esc(c.desc || '还没有一句简介') + '</span>' +
          '<span class="lib-card__meta">' + esc(statusLine(c)) + '</span>' +
        '</span>' + LIB_CHEV + '</button>';
    }).join('');
    box.innerHTML = '<div class="lib-actions">' +
        libAction('导入角色卡', 'import-char', IC_IMPORT) +
        libAction('新建角色', 'new-char', IC_PLUS, true) +
      '</div>' +
      '<p class="lib-count">共 ' + state.characters.length + ' 位 · 都在这台手机里</p>' +
      (cards ? '<div class="lib-list">' + cards + '</div>' : '<p class="empty-note">角色库还空着。导入一张卡，或者新建一位。</p>') +
      '<p class="lib-hint">角色只管「和谁说话」。模型在聊天页右上角单独选。</p>';
  }
  function renderCharDetail() {
    var box = $('#charLibScroll');
    var c = findChar(libCharId);
    if (!box) return;
    if (!c) { libCharId = ''; renderCharLibrary(); return; }
    var title = $('#charLibTitle');
    if (title) title.textContent = c.name;
    var personaLabel = c.defaultPersonaId && findPersona(c.defaultPersonaId)
      ? findPersona(c.defaultPersonaId).name
      : '跟全局默认（' + (defaultPersona() ? defaultPersona().name : '无') + '）';
    var bookLabel = c.worldBookId && findBook(c.worldBookId) ? findBook(c.worldBookId).name : '未挂';
    var exists = hasChat(c.id);
    var extras = extraCount(c);
    var html = '<article class="entity-hero">' +
        avatarHTML(c, 'avatar avatar--ai entity-hero__avatar') +
        '<h2 class="entity-hero__name serif">' + esc(c.name) + '</h2>' +
        '<p class="entity-hero__desc">' + esc(c.desc || '') + '</p>' +
        '<div class="entity-hero__actions">' +
          '<button class="mini-btn" type="button" data-char-edit="' + esc(c.id) + '">编辑</button>' +
          '<button class="mini-btn" type="button" data-d2char-chats="' + esc(c.id) + '">对话列表</button>' +
          '<button class="mini-btn" type="button" data-char-export="' + esc(c.id) + '">导出 JSON</button>' +
          '<button class="mini-btn" type="button" data-char-export-png="' + esc(c.id) + '">导出 PNG</button>' +
          '<button class="mini-btn mini-btn--danger" type="button" data-char-del="' + esc(c.id) + '">删除</button>' +
        '</div></article>' +
      fieldBlockHtml('她是谁', c.description) +
      fieldBlockHtml('性格', c.personality) +
      fieldBlockHtml('情景', c.scenario) +
      foldBlockHtml('开场白', c.first_mes) +
      foldBlockHtml('示例对话', c.mes_example) +
      '<article class="field-block">' +
        '<div class="bind-row"><span class="bind-row__label">挂了哪本世界书</span>' +
          '<button class="bind-row__value" type="button" data-char-book="' + esc(c.id) + '"><span>' + esc(bookLabel) + '</span></button></div>' +
        '<div class="bind-row"><span class="bind-row__label">默认用户设定</span>' +
          '<button class="bind-row__value" type="button" data-char-persona="' + esc(c.id) + '"><span>' + esc(personaLabel) + '</span></button></div>' +
        '<p class="bind-row__note">一场聊天 = 一个角色 + 一套用户设定；世界书可全局一本、她一本、这场一本。</p>' +
      '</article>';
    if (extras) html += '<p class="lib-hint">额外资料 ' + extras + ' 项已原样收好，v1 不展开。</p>';
    html += '<p class="lib-hint">JSON / PNG 角色卡都由后端解析与写出，PNG 用 tEXt 的 chara 块（和酒馆一致）。</p>';
    html += '<div class="lib-foot"><button class="wide-btn" type="button" data-char-start="' + esc(c.id) + '">' +
      (exists ? '回到和她的最近一场' : '用她开始聊') + '</button></div>';
    box.innerHTML = html;
  }

  /* 用户设定库 */
  function personaUsageNames(id) {
    var out = [];
    state.characters.forEach(function (c) { if (c.defaultPersonaId === id) out.push(c.name); });
    return out;
  }
  function renderPersonaLibrary() {
    var box = $('#personaLibScroll');
    if (!box) return;
    var title = $('#personaLibTitle');
    if (libPersonaId) { renderPersonaDetail(); return; }
    if (title) title.textContent = '用户设定';
    var cards = state.userPersonas.map(function (p) {
      var badge = p.is_default ? '<span class="lib-card__badge">默认</span>' : '';
      var used = personaUsageNames(p.id);
      var meta = (p.is_default ? '全局默认' : '') + (used.length ? (p.is_default ? ' · ' : '') + '默认用于 ' + used.join('、') : (p.is_default ? '' : '还没有角色把它设为默认'));
      return '<button class="lib-card" type="button" data-persona-open="' + esc(p.id) + '" aria-label="打开 ' + esc(p.name) + '">' +
        avatarHTML(p, 'avatar avatar--me lib-card__avatar') +
        '<span class="lib-card__main">' +
          '<span class="lib-card__title">' + esc(p.name) + badge + '</span>' +
          '<span class="lib-card__desc">' + esc(firstSentence(p.description) || '还没有说明') + '</span>' +
          '<span class="lib-card__meta">' + esc(meta) + '</span>' +
        '</span>' + LIB_CHEV + '</button>';
    }).join('');
    box.innerHTML = '<div class="lib-actions">' +
        libAction('新建一套', 'new-persona', IC_PLUS) +
        libAction('导入全部', 'import-personas', IC_IMPORT) +
      '</div>' +
      '<p class="lib-count">共 ' + state.userPersonas.length + ' 套 · 默认 ' + (defaultPersona() ? defaultPersona().name : '未设置') + '</p>' +
      (cards ? '<div class="lib-list">' + cards + '</div>' : '<p class="empty-note">还没有用户设定。</p>') +
      '<div class="lib-foot"><button class="wide-btn" type="button" data-action="export-personas">导出全部用户设定（JSON）</button></div>' +
      '<p class="lib-hint">用户设定没有通行的单卡 PNG；这里是一整包 JSON，和酒馆备份的思路一致。</p>';
  }
  function renderPersonaDetail() {
    var box = $('#personaLibScroll');
    var p = findPersona(libPersonaId);
    if (!box) return;
    if (!p) { libPersonaId = ''; renderPersonaLibrary(); return; }
    var title = $('#personaLibTitle');
    if (title) title.textContent = p.name;
    var used = personaUsageNames(p.id);
    var usage = '';
    if (p.is_default) usage += '<li>全局默认 · 所有聊天都会用到</li>';
    used.forEach(function (name) { usage += '<li>' + esc(name) + ' · 她的默认用户设定</li>'; });
    if (!p.is_default && !used.length) usage = '<li class="is-empty">还没有角色把它设为默认。</li>';
    box.innerHTML = '<article class="entity-hero">' +
        avatarHTML(p, 'avatar avatar--me entity-hero__avatar') +
        '<h2 class="entity-hero__name serif">' + esc(p.name) + '</h2>' +
        '<p class="entity-hero__desc">这是给角色看的「我是谁」，只留在这台手机里。</p>' +
        '<div class="entity-hero__actions"><button class="mini-btn" type="button" data-persona-avatar="' + esc(p.id) + '">换头像</button></div>' +
      '</article>' +
      '<article class="field-block">' +
        '<label class="field-label" for="personaNameInput">称呼</label>' +
        '<input class="field field--title" id="personaNameInput" type="text" value="' + esc(p.name) + '">' +
        '<label class="field-label" for="personaDescInput">一段说明</label>' +
        '<textarea class="field" id="personaDescInput" style="min-height:150px">' + esc(p.description) + '</textarea>' +
      '</article>' +
      '<article class="field-block">' +
        '<div class="bind-row"><span class="bind-row__label">设为全局默认</span>' +
          '<button class="switch" type="button" role="switch" aria-checked="' + String(!!p.is_default) + '" data-persona-default="' + esc(p.id) + '"><span></span></button></div>' +
        '<p class="bind-row__note">打开一场聊天时：这场指定 &gt; 角色默认 &gt; 全局默认。</p>' +
      '</article>' +
      '<article class="field-block">' +
        '<p class="field-block__label">默认用在哪些角色上</p>' +
        '<ul class="plain-list">' + usage + '</ul>' +
      '</article>' +
      '<div class="lib-foot"><button class="wide-btn" type="button" data-persona-save="' + esc(p.id) + '">保存</button></div>' +
      '<div class="entity-hero__actions" style="margin-top:10px">' +
        '<button class="mini-btn" type="button" data-persona-copy="' + esc(p.id) + '">复制这套</button>' +
        '<button class="mini-btn mini-btn--danger" type="button" data-persona-del="' + esc(p.id) + '">删除</button>' +
      '</div>';
  }

  /* 世界书库 */
  function bookEntryCount(book) { return book.entries ? book.entries.length : 0; }
  function bookConstantCount(book) {
    return (book.entries || []).filter(function (e) { return e.constant && e.enabled; }).length;
  }
  function entryMeta(e) {
    if (!e.enabled) return '已停用 · 不会带入';
    if (e.constant) return '常开';
    return e.keys && e.keys.length ? '关键词：' + e.keys.join(' · ') : '没有关键词';
  }
  function renderBookLibrary() {
    var box = $('#bookLibScroll');
    if (!box) return;
    var title = $('#bookLibTitle');
    if (libBookId) { renderBookDetail(); return; }
    if (title) title.textContent = '世界书';
    var total = state.worldBooks.reduce(function (n, b) { return n + bookEntryCount(b); }, 0);
    var globalName = state.settings.globalBookId && findBook(state.settings.globalBookId)
      ? findBook(state.settings.globalBookId).name : '未设置';
    var cards = state.worldBooks.map(function (b) {
      var used = bookUsage(b.id);
      var badge = state.settings.globalBookId === b.id ? '<span class="lib-card__badge">全局</span>' : '';
      return '<button class="lib-card" type="button" data-book-open="' + esc(b.id) + '" aria-label="打开 ' + esc(b.name) + '">' +
        '<span class="lib-book__icon">' + LIB_BOOK_ICON + '</span>' +
        '<span class="lib-card__main">' +
          '<span class="lib-card__title">' + esc(b.name) + badge + '</span>' +
          '<span class="lib-card__desc">' + bookEntryCount(b) + ' 个条目 · 常开 ' + bookConstantCount(b) + '</span>' +
          '<span class="lib-card__meta">' + (used.length ? '挂在：' + esc(used.join(' · ')) : '还没有挂在任何地方') + '</span>' +
        '</span>' + LIB_CHEV + '</button>';
    }).join('');
    box.innerHTML = '<div class="lib-actions">' +
        libAction('导入世界书', 'import-book', IC_IMPORT) +
        libAction('新建世界书', 'new-book', IC_PLUS, true) +
      '</div>' +
      '<p class="lib-count">共 ' + state.worldBooks.length + ' 本 · ' + total + ' 个条目 · 全局 ' + esc(globalName) + '</p>' +
      (cards ? '<div class="lib-list">' + cards + '</div>' : '<p class="empty-note">还没有世界书。</p>') +
      '<p class="lib-hint">只做常开 / 关键词两层；生成时全局 + 角色 + 这场合并去重。</p>';
  }
  function renderBookDetail() {
    var box = $('#bookLibScroll');
    var b = findBook(libBookId);
    if (!box) return;
    if (!b) { libBookId = ''; renderBookLibrary(); return; }
    var title = $('#bookLibTitle');
    if (title) title.textContent = b.name;
    var isGlobal = state.settings.globalBookId === b.id;
    var rows = (b.entries || []).slice().sort(function (x, y) { return (x.order || 0) - (y.order || 0); }).map(function (e) {
      var tag = !e.enabled ? '<span class="entry-row__tag entry-row__tag--off">停用</span>'
        : e.constant ? '<span class="entry-row__tag">常开</span>' : '';
      return '<button class="entry-row' + (e.enabled ? '' : ' is-off') + '" type="button" data-entry-open="' + esc(b.id + ':' + e.id) + '" aria-label="编辑条目 ' + esc(e.title) + '">' +
        '<span class="entry-row__main"><span class="entry-row__title">' + esc(e.title) + '</span>' +
        '<span class="entry-row__meta">' + esc(entryMeta(e)) + '</span></span>' + tag + LIB_CHEV + '</button>';
    }).join('');
    box.innerHTML = '<article class="entity-hero">' +
        '<span class="lib-book__icon" style="width:66px;height:66px;border-radius:22px">' + LIB_BOOK_ICON + '</span>' +
        '<h2 class="entity-hero__name serif">' + esc(b.name) + '</h2>' +
        '<p class="entity-hero__desc">' + bookEntryCount(b) + ' 个条目 · 常开 ' + bookConstantCount(b) + ' · ' + (bookUsage(b.id).length ? '挂在 ' + esc(bookUsage(b.id).join(' · ')) : '还没有挂在任何地方') + '</p>' +
        '<div class="entity-hero__actions">' +
          '<button class="mini-btn" type="button" data-book-export="' + esc(b.id) + '">导出 JSON</button>' +
          '<button class="mini-btn" type="button" data-book-rename="' + esc(b.id) + '">改名</button>' +
          '<button class="mini-btn mini-btn--danger" type="button" data-book-del="' + esc(b.id) + '">删除</button>' +
        '</div></article>' +
      '<article class="field-block">' +
        '<div class="bind-row"><span class="bind-row__label">设为全局书</span>' +
          '<button class="switch" type="button" role="switch" aria-checked="' + String(isGlobal) + '" data-book-global="' + esc(b.id) + '"><span></span></button></div>' +
        '<p class="bind-row__note">全局书对所有聊天生效；生成时和「她的主书」「这场聊天」合并，同一本只算一次。</p>' +
      '</article>' +
      '<article class="field-block">' +
        '<div class="card-head"><span class="field-block__label" style="margin:0">条目</span>' +
          '<button class="text-btn" type="button" data-entry-new="' + esc(b.id) + '">新建条目</button></div>' +
        '<div class="entry-list">' + (rows || '<p class="empty-note">这本还没有条目。</p>') + '</div>' +
      '</article>' +
      '<p class="lib-hint">手机上一次只编辑一条。常开条目每次都会带上；关键词条目命中才带。</p>';
  }

  function renderLibraries() {
    renderCharLibrary();
    renderPersonaLibrary();
    renderBookLibrary();
  }

  /* ---------------- 小图标 ---------------- */
  var IC = {
    pin: '<svg viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M7.3 1.5 10.5 4.7 9.1 6.1l.4 2.1-2.5.6-2.8 2.8-1.2-1.2 2.8-2.8.6-2.5 2.1.4.8-1.4z" stroke="currentColor" stroke-width="1" stroke-linejoin="round"/></svg>',
    lock: '<svg viewBox="0 0 12 12" fill="none" aria-hidden="true"><rect x="2.4" y="5.2" width="7.2" height="5.2" rx="1.4" stroke="currentColor" stroke-width="1"/><path d="M4.2 5.2V4a1.8 1.8 0 0 1 3.6 0v1.2" stroke="currentColor" stroke-width="1"/></svg>',
    check: '<svg viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="m2.7 6.2 2.2 2.2 4.5-4.9" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    chevRight: '<svg class="wp-page__chev" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M4.5 3 7.5 6 4.5 9" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    book: '<svg viewBox="0 0 12 12" fill="none" aria-hidden="true"><rect x="1.6" y="2.2" width="8.8" height="7.6" rx="1.8" stroke="currentColor" stroke-width="1"/><path d="M3.6 4.8h4.8M3.6 6.8h3" stroke="currentColor" stroke-width="1" stroke-linecap="round"/></svg>',
    chevDown: '<svg class="tool__chev" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M3 4.5 6 7.5 9 4.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    cloud: '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M6 14.4a3.2 3.2 0 0 1-.4-6.4 4.8 4.8 0 0 1 9.2-1 3 3 0 0 1-.6 5.9" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    image: '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><rect x="3" y="4" width="14" height="12" rx="2.6" stroke="currentColor" stroke-width="1.2"/><circle cx="7.6" cy="8.4" r="1.4" stroke="currentColor" stroke-width="1.1"/><path d="m4.4 14 4-3.8 2.6 2.4 2.4-2.2 2.2 2.2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    camera: '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M4 6.8h2.2l1.2-1.8h5.2l1.2 1.8H16a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><circle cx="10" cy="10.8" r="2.6" stroke="currentColor" stroke-width="1.2"/></svg>',
    file: '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M5.4 3.6h6l3.4 3.4v9a1 1 0 0 1-1 1H5.4a1 1 0 0 1-1-1V4.6a1 1 0 0 1 1-1z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M11.2 3.8v3.6h3.4" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>',
    place: '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M10 17.2s5.4-4.4 5.4-8.4A5.4 5.4 0 0 0 4.6 8.8c0 4 5.4 8.4 5.4 8.4z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><circle cx="10" cy="8.6" r="1.8" stroke="currentColor" stroke-width="1.1"/></svg>'
  };

  /* ---------------- 主题与壁纸 ---------------- */
  function currentWp(pageKey) {
    var ov = state.overrides[state.theme] || {};
    return ov[pageKey] || DATA.themes[state.theme].pages[pageKey];
  }
  function overrideCount() {
    return Object.keys(state.overrides[state.theme] || {}).length;
  }
  function themeLabel(t) { return DATA.themes[t].label; }

  function wallUrl(key) { return 'url(' + WALLPAPERS[currentWp(key)] + ')'; }

  /* 壁纸单独一层：这一层可以加饱和 / 主题色罩，让壁纸的颜色和形状透出来；
     玻璃卡片的 backdrop-filter 采样的就是这一层，文字和布局不受影响。 */
  function wallpaperLayer(el) {
    var layer = el.querySelector('.view__wp');
    if (!layer) {
      layer = document.createElement('div');
      layer.className = 'view__wp';
      layer.setAttribute('aria-hidden', 'true');
      el.insertBefore(layer, el.firstChild);
    }
    return layer;
  }

  /* 只给当前页挂壁纸；其余页只记 data-wp，避免一次解码多张大图 */
  function activateViewWallpaper(view) {
    DATA.pages.forEach(function (p) {
      var el = $('.view[data-view="' + p.key + '"]');
      if (!el) return;
      var wp = currentWp(p.key);
      el.setAttribute('data-wp', wp);
      var layer = wallpaperLayer(el);
      if (p.key === view) {
        /* C2：壁纸保持原样清晰（不叠雾、不模糊），只让 CSS 层做轻提亮 / 轻降对比 */
        layer.style.backgroundImage = wallUrl(p.key);
      } else {
        layer.style.backgroundImage = '';
      }
      el.style.backgroundImage = '';
    });
  }

  /* 切页时预加载左右相邻页的壁纸 */
  function prefetchAdjacentWallpapers(view) {
    var order = ['home', 'chat', 'memory', 'listen', 'me', 'settings'];
    var i = order.indexOf(view);
    if (i < 0) return;
    var targets = [order[(i + 1) % order.length], order[(i + order.length - 1) % order.length]];
    window.setTimeout(function () {
      targets.forEach(function (k) {
        var el = $('.view[data-view="' + k + '"]');
        if (el && !el.style.backgroundImage) el.style.backgroundImage = wallUrl(k);
      });
    }, 120);
  }

  function applyWallpapers() {
    activateViewWallpaper(currentView || 'home');
  }

  var CHAT_FONT_LABEL = { sm: '小', md: '标准', lg: '大' };

  function normalizeChatFont(size) {
    return (size === 'sm' || size === 'md' || size === 'lg') ? size : 'md';
  }

  function applyChatFont(size, opts) {
    var v = normalizeChatFont(size);
    if (!state.settings) state.settings = {};
    state.settings.chatFont = v;
    document.documentElement.setAttribute('data-chat-font', v);
    document.querySelectorAll('[data-chat-font-set]').forEach(function (el) {
      var on = el.getAttribute('data-chat-font-set') === v;
      el.classList.toggle('is-on', on);
      el.setAttribute('aria-pressed', String(on));
    });
    if (!opts || opts.save !== false) save();
    if (opts && opts.toast) toast('聊天字号已换成「' + CHAT_FONT_LABEL[v] + '」。');
  }

  function applyTheme(theme, opts) {
    state.theme = theme;
    document.documentElement.setAttribute('data-theme', theme);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'pink' ? '#F4ECEE' : '#E9F1F6');
    applyWallpapers();
    prefetchAdjacentWallpapers(currentView || 'home');
    var sub = $('#themeEntrySub');
    if (sub) sub.textContent = themeLabel(theme) + ' · 已更换 ' + overrideCount() + ' 张';
    var sv = $('#settingsThemeValue');
    if (sv) sv.textContent = themeLabel(theme);
    document.querySelectorAll('.theme-swatch').forEach(function (el) {
      var on = el.getAttribute('data-theme-set') === theme;
      el.classList.toggle('is-on', on);
      el.setAttribute('aria-pressed', String(on));
    });
    renderHome();
    save();
    if (opts && opts.toast) toast('已换成' + themeLabel(theme) + '。');
  }

  /* ---------------- 路由 ---------------- */
  var currentView = 'home';

  function navTo(view) {
    closeSheet();
    if (view === 'characters') libCharId = '';
    if (view === 'personas') libPersonaId = '';
    if (view === 'books') libBookId = '';
    if (view === 'providers') { providerDetailId = ''; providerTab = 'config'; providerQuery = ''; }
    if (view === 'presets') { presetDetailId = ''; }
    if (view === 'chat') {
      try { sessionStorage.setItem(SESSION_KEY, '1'); } catch (e) { /* 忽略 */ }
    }
    go(view);
  }

  function go(view) {
    if (!DATA.pages.some(function (p) { return p.key === view; })) view = 'chat';
    currentView = view;
    $$('.view').forEach(function (el) {
      el.classList.toggle('is-active', el.getAttribute('data-view') === view);
    });
    $('#app').classList.toggle('app--no-tabs', NO_TAB_VIEWS.indexOf(view) !== -1);
    $$('.tab').forEach(function (t) {
      t.setAttribute('aria-current', String(t.getAttribute('data-nav') === view));
    });
    activateViewWallpaper(view);
    prefetchAdjacentWallpapers(view);
    if (view === 'home') startHomeClock(); else stopHomeClock();
    if (view === 'home') renderHome();
    if (view === 'chat') scrollChatBottom(false);
    if (view === 'memory') { renderMemories(); refreshMemoriesQuiet(); }
    if (view === 'me') renderMe();
    if (view === 'listen') renderListen();
    if (view === 'settings') renderSettings();
    if (view === 'characters') renderCharLibrary();
    if (view === 'personas') renderPersonaLibrary();
    if (view === 'books') renderBookLibrary();
    if (view === 'providers') renderProviders();
    if (view === 'presets') renderPresets();
    if (view === 'stats') renderStats();
    var scroller = $('.view[data-view="' + view + '"] .page-scroll');
    if (scroller) scroller.scrollTop = 0;
  }

  /* ---------------- 聊天 ---------------- */
  var chatMessages = [];
  var cannedIndex = 0;
  var replyTimer = null;
  DATA.chat.forEach(function (m) {
    if (m.role === 'ai' && m.usage) {
      sessionUsage.prompt += m.usage.prompt_tokens;
      sessionUsage.completion += m.usage.completion_tokens;
      sessionUsage.total += m.usage.total_tokens;
    }
  });

  function charName() {
    var c = currentChar();
    return c ? c.name : '缪诗';
  }
  function charInitial() { return charName().charAt(0); }

  var IC_WRENCH = '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M12.6 3.4a4 4 0 0 0-4.9 5L3.8 12.3a1.7 1.7 0 0 0 2.4 2.4l3.9-3.9a4 4 0 0 0 5-4.9l-2.6 2.6-2-2z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>';
  var IC_CHEV_DOWN = '<svg class="tool-capsule__chev" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M6.4 8 10 11.6 13.6 8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function renderTool(tool) {
    var items = tool.items.map(function (t) {
      return '<li>' + rich(t) + '</li>';
    }).join('');
    return '<div class="tool">' +
      '<button class="tool-capsule" type="button" data-tool-toggle aria-expanded="false">' +
        IC_WRENCH + '<span>' + esc(tool.label) + '</span>' + IC_CHEV_DOWN +
      '</button>' +
      '<div class="tool-panel"><div class="tool-panel__inner"><ul>' + items + '</ul></div></div>' +
    '</div>';
  }

  function paragraphs(text) {
    return String(text).split(/\n{2,}/).map(function (p) {
      return '<p>' + rich(p.replace(/\n/g, ' ')) + '</p>';
    }).join('');
  }

  function renderMessage(m) {
    var msgIdAttr = m.id !== undefined && m.id !== null && m.id !== '' ? ' data-msg-id="' + esc(String(m.id)) + '"' : '';
    var editedTag = m.edited ? '<span class="d2-edited" aria-label="已编辑">已编辑</span>' : '';
    if (m.role === 'ai') {
      var annotation = m.aside ? '<div class="bubble__annotation">' + esc(m.aside) + '</div>' : '';
      return '<div class="msg msg--ai"' + msgIdAttr + '>' +
        avatarHTML(currentChar(), 'avatar avatar--ai msg__avatar') +
        '<div class="msg__body">' +
          '<p class="msg__name"><span>' + esc(charName()) + '</span><span class="msg__time">' + esc(m.time) + editedTag + '</span></p>' +
          (m.thinking ? thinkFoldHTML(m.thinking) : '') +
          (m.tool ? renderTool(m.tool) : '') +
          '<div class="bubble bubble--ai">' + paragraphs(m.text) + annotation + '</div>' +
          (m.fallback ? '<p class="fallback-note">' + esc(m.fallback) + '</p>' : '') +
          (m.usage ? '<p class="usage">' + renderUsage(m.usage, m.ms) + '</p>' : '') +
        '</div>' +
      '</div>';
    }
    return '<div class="msg msg--me"' + msgIdAttr + '>' +
      '<div class="msg__body">' +
        '<p class="msg__name"><span class="msg__time">' + esc(m.time) + editedTag + '</span></p>' +
        '<div class="bubble bubble--me">' + paragraphs(m.text) + '</div>' +
      '</div>' +
    '</div>';
  }

  function renderChat() {
    var list = $('#chatList');
    if (typeof d2EnsureMessageIds === 'function') d2EnsureMessageIds(chatMessages);
    list.innerHTML = chatMessages.map(renderMessage).join('');
    if (typeof d2DecorateChat === 'function') d2DecorateChat();
    scrollChatBottom(false);
  }

  function appendChat(m, smooth) {
    chatMessages.push(m);
    persistChat();
    $('#chatList').insertAdjacentHTML('beforeend', renderMessage(m));
    scrollChatBottom(smooth !== false);
  }

  function scrollChatBottom(smooth) {
    var scroller = $('#chatScroll');
    if (!scroller) return;
    var top = scroller.scrollHeight;
    if (smooth && !reducedMotion()) {
      scroller.scrollTo({ top: top, behavior: 'smooth' });
    } else {
      scroller.scrollTop = top;
    }
  }

  function updateChatHeader() {
    var c = currentChar();
    var nameEl = $('#chatName');
    if (nameEl) nameEl.textContent = charName();
    paintAvatar($('#chatAvatar'), c);
    var chip = $('#modelChip');
    var chipName = $('#modelChipName');
    var m = currentModel();
    var mName = m ? m.name : '未选模型';
    if (chipName) chipName.textContent = mName;
    if (chip) chip.setAttribute('aria-label', '模型：' + mName);
    var chipIcon = $('#modelChipIcon');
    if (chipIcon) {
      var svg = m ? modelIconSvg(m) : '';
      chipIcon.innerHTML = svg || esc(m ? String(m.name).charAt(0) : '·');
    }
    var input = $('#chatInput');
    if (input) input.placeholder = '和' + charName() + '说点什么…';
    updateThinkCap();
    renderChatContext();
  }

  var chatBusy = false;

  /* ---------- 流式回复：读 SSE，逐段更新气泡 ---------- */
  function consumeSse(response, handlers) {
    var reader = response.body.getReader();
    var decoder = new TextDecoder('utf-8');
    var buffer = '';
    function dispatch(block) {
      var lines = block.split('\n');
      var event = 'message';
      var data = '';
      lines.forEach(function (line) {
        if (line.indexOf('event:') === 0) event = line.slice(6).trim();
        else if (line.indexOf('data:') === 0) data += line.slice(5).trim();
      });
      if (!data) return;
      var payload;
      try { payload = JSON.parse(data); } catch (e) { return; }
      if (handlers[event]) handlers[event](payload);
    }
    function pump() {
      return reader.read().then(function (result) {
        if (result.done) {
          if (buffer.trim()) dispatch(buffer);
          return;
        }
        buffer += decoder.decode(result.value, { stream: true });
        var index;
        while ((index = buffer.indexOf('\n\n')) !== -1) {
          var block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          dispatch(block);
        }
        return pump();
      });
    }
    return pump();
  }

  function beginStreamBubble() {
    var typing = '<div class="msg msg--ai" id="streamMsg">' +
      avatarHTML(currentChar(), 'avatar avatar--ai msg__avatar') +
      '<div class="msg__body"><p class="msg__name"><span>' + esc(charName()) + '</span><span class="msg__time">' + hm(new Date()) + '</span></p>' +
      '<div class="bubble bubble--ai" id="streamBubble"><span class="think-pill" aria-label="思考中">思考中<i></i><i></i><i></i></span></div>' +
      '<p class="fallback-note" id="streamFallback" hidden></p>' +
      '<p class="usage" id="streamUsage" hidden></p>' +
      '</div></div>';
    $('#chatList').insertAdjacentHTML('beforeend', typing);
    scrollChatBottom(true);
  }

  function updateStreamBubble(text) {
    var box = $('#streamBubble');
    if (!box) return;
    box.innerHTML = paragraphs(text);
    scrollChatBottom(false);
  }

  function setStreamFallback(note) {
    var el = $('#streamFallback');
    if (!el || !note) return;
    el.textContent = note;
    el.removeAttribute('hidden');
  }

  function setStreamUsage(usage, ms) {
    var el = $('#streamUsage');
    if (!el || !usage) return;
    el.textContent = renderUsage(usage, ms);
    el.removeAttribute('hidden');
  }

  function appendErrorBubble(text) {
    var msg = { role: 'ai', text: text, time: hm(new Date()), error: true, uiOnly: true };
    chatMessages.push(msg);
    var html = '<div class="msg msg--ai">' +
      avatarHTML(currentChar(), 'avatar avatar--ai msg__avatar') +
      '<div class="msg__body"><p class="msg__name"><span>' + esc(charName()) + '</span><span class="msg__time">' + esc(msg.time) + '</span></p>' +
      '<div class="bubble bubble--ai"><p>' + esc(text) + '</p></div>' +
      '<p class="fallback-note">这次没有回复成功；上面是中文原因，不是原始报错。</p></div></div>';
    $('#chatList').insertAdjacentHTML('beforeend', html);
    scrollChatBottom(true);
  }

  function finishStream(done, streamText, errInfo) {
    var holder = $('#streamMsg');
    var failed = errInfo || (done && done.error);
    if (failed) {
      if (holder) holder.remove();
      var message = (errInfo && errInfo.message) || (done.error && done.error.message) || '这次没成功，稍后再试。';
      appendErrorBubble(message);
      toast(message);
      return;
    }
    var finalMsg = done && done.message;
    if (!finalMsg) {
      finalMsg = {
        role: 'ai',
        text: streamText,
        time: hm(new Date()),
        usage: done && done.usage,
        ms: done && done.durationMs
      };
      if (done && done.fallback) finalMsg.fallback = done.fallback;
    }
    if (holder) holder.remove();
    chatMessages.push(finalMsg);
    $('#chatList').insertAdjacentHTML('beforeend', renderMessage(finalMsg));
    scrollChatBottom(true);
    persistChat();
    if (done && done.remembered) toast('记好了：' + done.remembered.title);
    if (done && done.fallback) toast(done.fallback);
    window.setTimeout(function () { refreshMemoriesQuiet(); }, 900);
  }

  /* file:// 或后端断线时的离线演示回复：正文来自本地 cannedReplies，界面上会明确标成演示。 */
  function offlineDemoReply() {
    var typing = '<div class="msg msg--ai" id="typingMsg">' +
      avatarHTML(currentChar(), 'avatar avatar--ai msg__avatar') +
      '<div class="msg__body"><p class="msg__name"><span>' + esc(charName()) + '</span></p>' +
      '<div class="bubble bubble--ai bubble--typing"><span class="think-pill" aria-label="思考中">思考中<i></i><i></i><i></i></span></div></div></div>';
    $('#chatList').insertAdjacentHTML('beforeend', typing);
    scrollChatBottom(true);
    if (replyTimer) clearTimeout(replyTimer);
    replyTimer = setTimeout(function () {
      var old = $('#typingMsg');
      if (old) old.remove();
      var reply = DATA.cannedReplies[cannedIndex % DATA.cannedReplies.length];
      cannedIndex += 1;
      var fake = estimateUsage(reply);
      sessionUsage.prompt += fake.usage.prompt_tokens;
      sessionUsage.completion += fake.usage.completion_tokens;
      sessionUsage.total += fake.usage.total_tokens;
      var msg = { role: 'ai', text: reply, time: hm(new Date()), usage: fake.usage, ms: fake.ms, fallback: '离线演示回复：没有连上后端，这条不是真实模型生成的。' };
      var demoLevel = (typeof chatReasoningLevel === 'function') ? chatReasoningLevel() : 'off';
      if (demoLevel && demoLevel !== 'off') {
        msg.thinking = {
          sec: 3,
          demo: true,
          text: '（演示）这不是真实模型的思维链，只是离线样稿里示意「思考档位开着的回复」会长什么样：\n先接住你刚才那句话的情绪，再留一个轻轻的话题，不要追问太紧。'
        };
      }
      appendChat(msg);
    }, 900);
  }

  function providerNeedsKeyMessage() {
    return '先到「我的 → 模型与提供商」里填写 API Key，再发消息。';
  }

  function sendChat(opts) {
    opts = opts || {};
    var mode = opts.mode || 'normal';
    var input = $('#chatInput');
    var text = opts.text !== undefined ? String(opts.text).trim() : (input ? input.value.trim() : '');
    if (mode === 'normal' && !text) { if (input) input.focus(); return; }
    if (chatBusy) return;
    if (input) input.value = '';
    if (mode === 'normal') appendChat({ role: 'me', text: text, time: hm(new Date()) });

    if (!SERVER_MODE || !serverOnline) { offlineDemoReply(); return; }

    var char = currentChar();
    if (!char) { appendErrorBubble('还没有角色：先到角色库新建或导入一位。'); return; }
    var model = currentModel();
    var provider = model ? providerOf(model) : null;
    if (!model) {
      appendErrorBubble('还没有可用的模型：先在「模型与提供商」里添加一家并选一个模型。');
      return;
    }
    if (!serverInfo.mockModel && provider && !providerHasKey(provider)) {
      appendErrorBubble(providerNeedsKeyMessage());
      toast('还没有填 API Key。');
      return;
    }
    var chat = ensureChat(char.id);
    if (chat) {
      chat.modelId = state.modelId || chat.modelId;
      chat.reasoningLevel = chatReasoningLevel();
      save();
    }
    chatBusy = true;
    beginStreamBubble();
    var streamText = '';
    var errInfo = null;
    var doneHandled = false;
    fetch(API_BASE + '/chats/' + encodeURIComponent(char.id) + '/messages', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text, modelId: ((state.chats[char.id] && state.chats[char.id].modelId) || state.modelId), reasoningLevel: chatReasoningLevel(), chatId: (state.chats[char.id] && state.chats[char.id].id) || '', mode: mode })
    }).then(function (res) {
      if (!res.ok) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          var e = (data && data.error) || {};
          var err = new Error(e.message || '这次没成功，稍后再试。');
          err.kind = e.kind || 'http';
          throw err;
        });
      }
      if (!res.body || !res.body.getReader) {
        throw new Error('这个浏览器不支持流式读取，换一个浏览器再试。');
      }
      return consumeSse(res, {
        fallback: function (data) {
          setStreamFallback(data.message || '');
          toast(data.message || '');
        },
        delta: function (data) {
          streamText += (data.text || '');
          updateStreamBubble(streamText);
        },
        thinking: function () { /* 思考增量在 done 后折叠显示 */ },
        usage: function (data) {
          setStreamUsage(data.usage, 0);
        },
        error: function (data) { errInfo = data; },
        done: function (data) {
          doneHandled = true;
          if (typeof d2OnServerFallback === 'function' && data && data.fallbackRemoved && data.fallbackRemoved.length) {
            d2OnServerFallback(data.fallbackRemoved, chatReasoningLevel());
          }
          finishStream(data, streamText, errInfo);
        }
      });
    }).catch(function (err) {
      if (!doneHandled) {
        var holder = $('#streamMsg');
        if (holder) holder.remove();
        appendErrorBubble(err.message || '这次没成功，稍后再试。');
        toast(err.message || '这次没成功，稍后再试。');
      }
    }).then(function () {
      chatBusy = false;
      refreshUsageSummary();
    });
  }

  /* ---------------- 记忆 ---------------- */
  var memoryFilter = '全部';
  var memoryQuery = '';
  /* 记忆页可以临时翻看别的某段关系，但不改变当前聊天对象 */
  var memoryScopeOverride = null;

  function dotsHtml(n) {
    var html = '';
    for (var i = 0; i < 10; i++) {
      html += '<i class="' + (i < n ? 'on' : '') + '"></i>';
    }
    return '<span class="mem-card__dots" role="img" aria-label="重要度 ' + n + ' / 10">' + html + '</span>';
  }

  var IC_PIN = '<svg class="pin" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M7.3 1.5 10.5 4.7 9.1 6.1l.4 2.1-2.5.6-2.8 2.8-1.2-1.2 2.8-2.8.6-2.5 2.1.4.8-1.4z" stroke="currentColor" stroke-width="1" stroke-linejoin="round"/></svg>';
  var IC_LOCK = '<svg viewBox="0 0 12 12" fill="none" aria-hidden="true"><rect x="2.4" y="5.2" width="7.2" height="5.2" rx="1.4" stroke="currentColor" stroke-width="1"/><path d="M4.2 5.2V4a1.8 1.8 0 0 1 3.6 0v1.2" stroke="currentColor" stroke-width="1"/></svg>';
  var IC_DOC = '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M5.6 3.6h6l3.4 3.4v9a1 1 0 0 1-1 1H5.6a1 1 0 0 1-1-1V4.6a1 1 0 0 1 1-1z"/><path d="M11.4 3.8v3.4h3.2M7.8 10h4.4M7.8 12.6h3"/></svg>';
  var IC_ROW_CHEV = '<svg class="row-chev" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M8 5.6 12.4 10 8 14.4"/></svg>';

  function renderMemRow(m) {
    var dots = '';
    for (var i = 0; i < 10; i++) dots += '<i class="' + (i < m.importance ? 'on' : '') + '"></i>';
    var flags = '';
    if (m.pinned) flags += '<span class="m-flag">' + IC_PIN + '已钉住</span>';
    if (m.protected) flags += '<span class="m-flag">' + IC_LOCK + '受保护</span>';
    return '<button class="m-row" type="button" data-memory="' + esc(m.id) + '" aria-haspopup="dialog" aria-label="记忆：' + esc(m.title) + '">' +
      '<span class="m-icon">' + IC_DOC + '</span>' +
      '<span class="m-main">' +
        '<span class="m-title serif">' + rich(m.title) + (m.pinned ? IC_PIN : '') + '</span>' +
        '<span class="m-excerpt">' + rich(m.body) + '</span>' +
        '<span class="m-meta"><span class="m-dots" role="img" aria-label="重要度 ' + m.importance + ' / 10">' + dots + '</span><span>' + esc(m.cat) + '</span>' + flags + '<span>' + esc(m.source) + '</span></span>' +
      '</span>' + IC_ROW_CHEV +
    '</button>';
  }

  function renderMemories() {
    var list = $('#memoryList');
    if (!list) return;
    var q = memoryQuery;
    var items = state.memories.filter(function (m) { return !m.forgotten && memoryVisible(m); });
    if (memoryFilter !== '全部') {
      items = items.filter(function (m) { return m.cat === memoryFilter; });
    }
    if (q) {
      items = items.filter(function (m) {
        return (m.title + m.body).toLowerCase().indexOf(q.toLowerCase()) !== -1;
      });
    }
    /* 钉住的排在前面，其余保持原来的时间顺序 */
    items.sort(function (a, b) { return (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0); });
    list.innerHTML = items.length
      ? items.map(renderMemRow).join('')
      : '<p class="empty-note">这里还空着。换个关键词试试。</p>';
    var forgotten = state.memories.filter(function (m) { return m.forgotten && memoryVisible(m); }).length;
    $('#forgottenCount').textContent = forgotten;
    var nowText = $('#nowText');
    if (nowText) nowText.textContent = state.nowText;
    renderBondChips();
    $$('#memoryFilters .chip-filter').forEach(function (c) {
      var on = c.getAttribute('data-cat') === memoryFilter;
      c.classList.toggle('is-on', on);
      c.setAttribute('aria-pressed', String(on));
    });
  }

  function setFilter(cat) {
    memoryFilter = cat;
    renderMemories();
  }

  /* ---------------- 一起听 ---------------- */
  var listen = {
    playlist: state.listen.playlist || 0,
    song: state.listen.song || 0,
    progress: 72,
    playing: false,
    timer: null
  };
  if (!DATA.playlists[listen.playlist]) listen.playlist = 0;
  if (!DATA.playlists[listen.playlist].songs[listen.song]) listen.song = 0;

  function currentPlaylist() { return DATA.playlists[listen.playlist]; }
  function currentSong() { return currentPlaylist().songs[listen.song]; }

  /* 网易云专辑封面：coverUrl 是 picUrl 原地址，显示时按尺寸加 ?param=WxH，
     由手机直接从网易云图片服务器加载；失败时退回主题同色素面唱片。 */
  function coverUrl(song, size) {
    if (!song || !song.coverUrl) return '';
    if (typeof d2CoverSongUrl === 'function') return d2CoverSongUrl(song, size, 0);
    var px = size || 300;
    return song.coverUrl + '?param=' + px + 'y' + px;
  }
  function setCoverImg(el, song, size) {
    if (typeof d2CoverSetImg === 'function') { d2CoverSetImg(el, song, size); return; }
    if (!el) return;
    var url = coverUrl(song, size);
    if (!url) { el.classList.add('is-missing'); el.removeAttribute('src'); return; }
    el.classList.remove('is-missing');
    if (el.getAttribute('src') !== url) el.src = url;
  }
  function coverThumb(song, size) {
    var url = coverUrl(song, size || 120);
    if (!url) return '<span class="song-row__cover" aria-hidden="true"></span>';
    /* 列表封面：失败时按 p1 → p2 → p3 → p4 换域名重试，四个都失败才露出素色小方块 */
    var base = song && song.coverUrl ? song.coverUrl + '?param=' + (size || 120) + 'y' + (size || 120) : '';
    if (url.indexOf('data:') === 0) base = '';
    return '<span class="song-row__cover" aria-hidden="true"><img src="' + url + '" alt="" decoding="async" referrerpolicy="no-referrer"' +
      ' data-cover-base="' + esc(base) + '" data-cover-attempt="0"' +
      ' onerror="window.d2CoverError&&window.d2CoverError(this)"></span>';
  }

  function renderListen() {
    var song = currentSong();
    if (!song) return;
    $('#trackTitle').textContent = song.title;
    $('#trackArtist').textContent = song.artist;
    $('#listenNote').textContent = song.note || '';
    var pn = $('#playlistName');
    if (pn) pn.textContent = currentPlaylist().name;
    var trackEl = $('#homeTrack');
    if (trackEl) trackEl.textContent = song.title;
    var artistEl = $('#homeArtist');
    if (artistEl) artistEl.textContent = song.artist;
    setCoverImg($('#recordCover'), song, 300);
    setCoverImg($('#homeDiscCover'), song, 120);
    setCoverImg($('#trackCover'), song, 300);
    renderInlinePlaylist();
    updateProgressUi();
    updatePlayUi();
    if (sheetName === 'playlist') openSheet('playlist');
  }

  function renderInlinePlaylist() {
    var box = $('#listenPlaylist');
    if (!box) return;
    var pl = currentPlaylist();
    box.innerHTML = pl.songs.map(function (s, si) {
      var current = si === listen.song;
      return '<button class="song-row' + (current ? ' is-current' : '') + '" type="button" data-song="' + listen.playlist + ':' + si + '"' + (current ? ' aria-current="true"' : '') + '>' +
        '<span class="song-row__no">' + (si + 1) + '</span>' +
        coverThumb(s, 120) +
        '<span class="song-row__main"><span class="song-row__title">' + esc(s.title) + '</span><span class="song-row__artist">' + esc(s.artist) + '</span></span>' +
        (current ? '<span class="song-row__playing" aria-hidden="true"><i></i><i></i><i></i></span>' : '') +
        '<span class="song-row__dur">' + formatDur(s.dur) + '</span>' +
      '</button>';
    }).join('');
  }

  function updateProgressUi() {
    var song = currentSong();
    if (!song) return;
    var dur = song.dur || 1;
    var ratio = Math.min(1, Math.max(0, listen.progress / dur));
    var pct = (ratio * 100).toFixed(2) + '%';
    $('#progressFill').style.width = pct;
    $('#progressKnob').style.left = pct;
    $('#timeNow').textContent = formatDur(listen.progress);
    $('#timeDur').textContent = formatDur(dur);
    var track = $('#progressTrack');
    track.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
    track.setAttribute('aria-valuetext', formatDur(listen.progress) + ' / ' + formatDur(dur));
    var hp = $('#homeProgress');
    if (hp) hp.style.width = Math.min(100, ratio * 100).toFixed(1) + '%';
  }

  function updatePlayUi() {
    var btn = $('#playBtn');
    btn.classList.toggle('is-playing', listen.playing);
    btn.setAttribute('aria-label', listen.playing ? '暂停' : '播放');
    var disc = $('#record');
    disc.classList.toggle('is-spinning', listen.playing);
    var hpBtn = document.querySelector('.player-btn');
    if (hpBtn) {
      hpBtn.classList.toggle('is-playing', listen.playing);
      hpBtn.setAttribute('aria-label', listen.playing ? '暂停' : '播放');
    }
  }

  function stopTimer() {
    if (listen.timer) { clearInterval(listen.timer); listen.timer = null; }
  }

  function setPlaying(play) {
    listen.playing = !!play;
    stopTimer();
    if (listen.playing) {
      listen.timer = setInterval(function () {
        listen.progress += 1;
        if (listen.progress >= currentSong().dur) {
          nextSong(true);
          return;
        }
        updateProgressUi();
      }, 1000);
    }
    updatePlayUi();
  }

  function selectSong(pi, si) {
    listen.playlist = pi;
    listen.song = si;
    listen.progress = 0;
    state.listen = { playlist: pi, song: si };
    save();
    renderListen();
    setPlaying(true);
    updateCurrentInPlaylistSheet();
  }

  function nextSong(auto) {
    var pl = currentPlaylist();
    var si = listen.song + 1;
    if (si >= pl.songs.length) { si = 0; }
    listen.song = si;
    listen.progress = 0;
    state.listen = { playlist: listen.playlist, song: si };
    save();
    renderListen();
    if (auto) setPlaying(true);
  }

  function prevSong() {
    var pl = currentPlaylist();
    var si = listen.song - 1;
    if (si < 0) si = pl.songs.length - 1;
    listen.song = si;
    listen.progress = 0;
    state.listen = { playlist: listen.playlist, song: si };
    save();
    renderListen();
  }

  function seekRatio(ratio) {
    ratio = Math.min(1, Math.max(0, ratio));
    listen.progress = Math.round(ratio * currentSong().dur);
    updateProgressUi();
  }

  /* ---------------- 首页小组件 ---------------- */
  function tickHomeClock(now) {
    now = now || new Date();
    var sec = now.getSeconds();
    var min = now.getMinutes() + sec / 60;
    var hr = (now.getHours() % 12) + min / 60;
    var h = $('#clockHour'), m = $('#clockMin'), s = $('#clockSec');
    if (h) h.setAttribute('transform', 'rotate(' + (hr * 30) + ' 50 50)');
    if (m) m.setAttribute('transform', 'rotate(' + (min * 6) + ' 50 50)');
    if (s) s.setAttribute('transform', 'rotate(' + (sec * 6) + ' 50 50)');
  }

  function renderTokenBars() {
    var box = $('#tokenBars');
    if (!box) return;
    var bars = (serverOnline && usageSummary && usageSummary.bars && usageSummary.bars.length) ? usageSummary.bars : DATA.tokens.bars;
    var labels = (serverOnline && usageSummary && usageSummary.barLabels && usageSummary.barLabels.length) ? usageSummary.barLabels : DATA.tokens.barLabels;
    var max = Math.max.apply(null, bars) || 1;
    box.innerHTML = bars.map(function (v, i) {
      return '<span class="bar"><i style="height:' + Math.round(v / max * 100) + '%"></i><span>' + esc(labels[i] || '') + '</span></span>';
    }).join('');
  }

  function renderHome() {
    var now = new Date();
    paintAllAvatars();
    var d = $('#homeDays');
    if (d) d.textContent = daysTogether(bondStartDate());
    var since = $('#homeSince');
    if (since) since.textContent = sinceTextDots(bondStartDate());
    var poem = $('#homePoem');
    if (poem) poem.textContent = DATA.themes[state.theme].quote;
    var greet = $('#homeGreeting');
    if (greet) greet.textContent = greetingText(now);
    var wd = $('#homeWeekday');
    if (wd) wd.textContent = homeWeekdayText(now);
    var wcity = $('#homeWeatherCity');
    if (wcity) wcity.textContent = DATA.home.weather.city + ' · ' + DATA.home.weather.text;
    var wtemp = $('#homeTemp');
    if (wtemp) wtemp.textContent = DATA.home.weather.temp;
    var note = $('#homeNoteText');
    if (note) note.textContent = DATA.home.note;
    var noteTime = $('#homeNoteTime');
    if (noteTime) noteTime.textContent = DATA.home.noteTime;
    var memTitle = $('#homeMemTitle');
    if (memTitle) memTitle.textContent = DATA.home.memoryTitle;
    var memText = $('#homeMemText');
    if (memText) memText.textContent = DATA.home.memoryText;
    var idx = now.getFullYear() * 372 + now.getMonth() * 31 + now.getDate();
    var quote = $('#homeQuote');
    if (quote) quote.textContent = DATA.home.quotes[idx % DATA.home.quotes.length];
    var quoteFrom = $('#homeQuoteFrom');
    if (quoteFrom) quoteFrom.textContent = '— ' + charName();
    var rpNow = resolvedPersona(chatOf(state.currentCharacterId), currentChar());
    var signText = $('#homeSignText');
    if (signText) signText.textContent = charName() + ' & ' + (rpNow.persona ? rpNow.persona.name : '') + ' · 把日子过成两个人的';
    var song = currentSong();
    if (song) {
      var t = $('#homeTrack');
      if (t) t.textContent = song.title;
      var ar = $('#homeArtist');
      if (ar) ar.textContent = song.artist;
      var hp = $('#homeProgress');
      if (hp) hp.style.width = Math.min(100, (listen.progress / song.dur) * 100).toFixed(1) + '%';
    }
    var hpBtn = document.querySelector('.player-btn');
    if (hpBtn) hpBtn.classList.toggle('is-playing', listen.playing);
    var photo = document.getElementById('homePhoto');
    if (photo) photo.src = WALLPAPERS[currentWp('listen')];
    var photoDate = document.getElementById('homePhotoDate');
    if (photoDate) photoDate.textContent = monthDay(now);
    var countdown = document.getElementById('homeCountdown');
    if (countdown) countdown.textContent = '12';
    tickHomeClock(now);
  }

  /* ---------------- 我的 / 设置 ---------------- */
  function renderMe() {
    paintAllAvatars();
    var daysEl = $('#daysTogether');
    if (daysEl) daysEl.textContent = daysTogether(bondStartDate());
    var sinceEl = $('#togetherSince');
    if (sinceEl) sinceEl.textContent = sinceText(bondStartDate());
    var backupEl = $('#backupTime');
    if (backupEl) backupEl.textContent = state.backupAt ? '上次备份 · ' + formatBackup(state.backupAt) : '还没有备份 · 点一下试试';
    var sub = $('#themeEntrySub');
    if (sub) sub.textContent = themeLabel(state.theme) + ' · 已更换 ' + overrideCount() + ' 张';
    var charSub = $('#meCharSub');
    if (charSub) charSub.textContent = state.characters.length + ' 位 · 正在和 ' + charName() + ' 聊';
    var personaSub = $('#mePersonaSub');
    if (personaSub) personaSub.textContent = state.userPersonas.length + ' 套 · 默认 ' + (defaultPersona() ? defaultPersona().name : '未设置');
    var bookSub = $('#meBookSub');
    if (bookSub) {
      var totalEntries = state.worldBooks.reduce(function (n, b) { return n + bookEntryCount(b); }, 0);
      bookSub.textContent = state.worldBooks.length + ' 本 · ' + totalEntries + ' 个条目';
    }
    var presetSub = $('#mePresetSub');
    if (presetSub) {
      var dp = defaultPreset();
      presetSub.textContent = state.promptPresets.length + ' 个 · 默认「' + (dp ? dp.name : '未设置') + '」';
    }
    var provSub = $('#meProviderSub');
    if (provSub) {
      var cm = currentModel();
      provSub.textContent = state.providers.length + ' 个提供商 · 当前 ' + (cm ? cm.name : '未选择');
    }
    var tt = $('#tokenToday');
    var tm = $('#tokenMonth');
    if (serverOnline && usageSummary) {
      if (tt) tt.textContent = fmtNum(usageSummary.today || 0);
      if (tm) tm.textContent = fmtNum(usageSummary.month || 0);
    } else {
      if (tt) tt.textContent = fmtNum(DATA.tokens.today);
      if (tm) tm.textContent = fmtNum(DATA.tokens.month);
    }
    renderTokenBars();
    updateServerNote();
    if (typeof d2RenderRecentChatsEntry === 'function') d2RenderRecentChatsEntry();
  }

  function updateServerNote() {
    var modeNote = $('#serverNote');
    if (!modeNote) return;
    var lines = [];
    if (!SERVER_MODE) {
      lines.push('离线模式：用 file:// 直接打开，数据只在这台浏览器里，回复是演示内容。');
    } else if (!serverOnline) {
      lines.push('连不上本机后端：暂时用浏览器缓存，改动不会保存到服务器。');
    } else {
      lines.push(devMode ? '开发模式：未设置登录密码（APP_PASSWORD）。只应在自己的电脑上这样用。' : '已启用登录密码（APP_PASSWORD）。');
      if (serverInfo.mockModel) lines.push('演示模型模式（MSYQ_MOCK=1）：回复由本机生成，不会请求外部接口。');
      if (serverInfo.version) lines.push('后端 v' + serverInfo.version + ' · 同源托管，浏览器不直接拿 API Key。');
    }
    modeNote.textContent = lines.join(' ');
    var existingLogout = $('#logoutBtn');
    if (SERVER_MODE && serverOnline && authRequired) {
      if (!existingLogout) {
        var logout = document.createElement('button');
        logout.id = 'logoutBtn';
        logout.type = 'button';
        logout.className = 'text-btn';
        logout.textContent = '退出登录';
        logout.style.marginTop = '8px';
        logout.addEventListener('click', function () {
          serverFetch('/auth/logout', { method: 'POST' }).then(function () { location.reload(); }).catch(apiToast);
        });
        if (modeNote.parentNode) modeNote.parentNode.insertBefore(logout, modeNote.nextSibling);
      }
    } else if (existingLogout) {
      existingLogout.remove();
    }
  }

  function renderSettings() {
    var n = $('#notifySwitch');
    var s = $('#splashSwitch');
    n.setAttribute('aria-checked', String(!!state.settings.notify));
    s.setAttribute('aria-checked', String(!!state.settings.splashAlways));
    $('#startDate').value = state.settings.startDate;
    $('#settingsThemeValue').textContent = themeLabel(state.theme);
    var font = normalizeChatFont(state.settings.chatFont);
    document.querySelectorAll('[data-chat-font-set]').forEach(function (el) {
      var on = el.getAttribute('data-chat-font-set') === font;
      el.classList.toggle('is-on', on);
      el.setAttribute('aria-pressed', String(on));
    });
    updateServerNote();
    if (typeof d2RenderChatSettings === 'function') d2RenderChatSettings();
  }

  function backupNow() {
    state.backupAt = new Date().toISOString();
    save();
    renderMe();
    if (sheetName === 'backup') openSheet('backup');
    toast('备份时间记下了 · ' + formatBackup(state.backupAt));
  }

  /* ---------------- Sheet 管理 ---------------- */
  var sheetLayer = $('#sheetLayer');
  var sheetEl = $('#sheet');
  var sheetTitle = $('#sheetTitle');
  var sheetBody = $('#sheetBody');
  var sheetFoot = $('#sheetFoot');
  var sheetName = null;
  var sheetPayload = null;
  var pickerPage = 'chat';

  function openSheet(name, payload) {
    var def = SHEETS[name];
    if (!def) return;
    var content = typeof def === 'function' ? def(payload) : def;
    if (!content) return;
    var wasOpen = sheetLayer.classList.contains('is-open');
    sheetName = name;
    sheetPayload = payload;
    sheetEl.className = 'sheet' + (name === 'modelPicker' ? ' sheet--picker' : '') + (name === 'reasoning' ? ' sheet--reason' : '');
    sheetTitle.textContent = content.title || '';
    sheetBody.innerHTML = content.body || '';
    sheetFoot.innerHTML = content.foot || '';
    sheetBody.scrollTop = 0;
    if (!wasOpen) {
      sheetLayer.classList.add('is-open');
      sheetLayer.setAttribute('aria-hidden', 'false');
      $('#app').classList.add('sheet-open');
      try { sheetEl.setAttribute('tabindex', '-1'); sheetEl.style.outline = 'none'; sheetEl.focus({ preventScroll: true }); } catch (e) { /* 忽略 */ }
      $$('.page-scroll, .chat-scroll').forEach(function (el) { el.setAttribute('data-lock', '1'); });
    }
    window.setTimeout(function () {
      if (!wasOpen) sheetBody.scrollTop = 0;
    }, 0);
  }

  function closeSheet() {
    if (!sheetLayer.classList.contains('is-open')) return;
    sheetLayer.classList.remove('is-open');
    sheetLayer.setAttribute('aria-hidden', 'true');
    $('#app').classList.remove('sheet-open');
    sheetName = null;
    sheetPayload = null;
    $$('.page-scroll, .chat-scroll').forEach(function (el) { el.removeAttribute('data-lock'); });
  }

  /* SHEETS 已提前到 IIFE 开头声明：modules/*.js 在 IIFE 最前面就会给它挂方法 */

  function modelOptionsHtml() {
    return DATA.models.map(function (m) {
      return '<button class="option' + (state.model.model === m.name ? ' is-selected' : '') + '" type="button" data-model="' + esc(m.name) + '">' +
        '<span class="option__mark" aria-hidden="true">' + esc(m.name.charAt(0)) + '</span>' +
        '<span class="option__main"><span class="option__title">' + esc(m.name) + '</span><span class="option__desc">' + esc(m.desc) + '</span></span>' +
        '<span class="option__radio" aria-hidden="true"></span>' +
      '</button>';
    }).join('');
  }

  /* 模型胶囊只选模型；角色走顶栏左侧的角色切换层 */
  SHEETS.model = function () {
    return {
      title: '模型',
      body: '<p class="sheet-label">只换模型</p><div class="option-list">' + modelOptionsHtml() + '</div>' +
        '<p class="sheet-note">模型是聊天时的小选择。角色在顶栏左上角的名字里换；额度在「我的 → 模型与额度」。</p>'
    };
  };

  SHEETS.menu = function () {
    function row(nav, icon, title, sub) {
      return '<button class="menu-row" type="button" data-nav="' + nav + '">' +
        '<span class="menu-row__icon">' + icon + '</span>' +
        '<span class="menu-row__main"><span class="menu-row__title">' + title + '</span><span class="menu-row__sub">' + sub + '</span></span>' +
        '<svg class="row-chev" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M8 5.6 12.4 10 8 14.4"/></svg>' +
      '</button>';
    }
    return {
      title: '菜单',
      body: '<div class="menu-list">' +
        row('home', '<svg viewBox="0 0 20 20" fill="none"><path d="M3.4 9.4 10 3.6l6.6 5.8"/><path d="M5.6 8.4v7.6h8.8V8.4"/></svg>', '首页', '在一起的第几天、留言与歌') +
        row('chat', '<svg viewBox="0 0 20 20" fill="none"><path d="M3.6 5.4c0-.9.7-1.6 1.6-1.6h9.6c.9 0 1.6.7 1.6 1.6v6c0 .9-.7 1.6-1.6 1.6H9l-3.6 2.8V13h-.2c-.9 0-1.6-.7-1.6-1.6v-6z"/></svg>', '聊天', '和缪诗说一会儿话') +
        row('memory', '<svg viewBox="0 0 20 20" fill="none"><path d="M4 4.6h12v9.8H9.6L6 17.4v-3H4z"/></svg>', '记忆', '收好的十二段时光') +
        row('listen', '<svg viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="6.8"/><circle cx="10" cy="10" r="2"/></svg>', '一起听', '歌单、进度与 TA 的评论') +
        row('me', '<svg viewBox="0 0 20 20" fill="none"><circle cx="10" cy="7" r="3.1"/><path d="M4.4 16.2c.8-3 3-4.6 5.6-4.6s4.8 1.6 5.6 4.6"/></svg>', '我的', '三个库、用量与设置') +
        row('characters', '<svg viewBox="0 0 20 20" fill="none"><circle cx="10" cy="7" r="3.1"/><path d="M4.4 16.2c.8-3 3-4.6 5.6-4.6s4.8 1.6 5.6 4.6"/></svg>', '角色库', '和谁说话') +
        row('personas', '<svg viewBox="0 0 20 20" fill="none"><rect x="3" y="4.6" width="14" height="10.8" rx="2.6"/><circle cx="7.4" cy="9.4" r="1.6"/><path d="M4.8 13.4c.5-1.6 1.5-2.4 2.6-2.4s2.1.8 2.6 2.4"/></svg>', '用户设定', '这场聊天里的「我」') +
        row('books', '<svg viewBox="0 0 20 20" fill="none"><path d="M4.4 4.6h5.2c.7 0 1.2.5 1.2 1.2v9.6H5.6c-.7 0-1.2-.5-1.2-1.2V4.6z"/><path d="M15.6 4.6h-5.2c-.7 0-1.2.5-1.2 1.2v9.6h5.2c.7 0 1.2-.5 1.2-1.2V4.6z"/></svg>', '世界书', '常开与关键词') +
        row('settings', '<svg viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="2.6"/><path d="M10 3.4v1.6M10 15v1.6M3.4 10h1.6M15 10h1.6M5.3 5.3l1.1 1.1M13.6 13.6l1.1 1.1M14.7 5.3l-1.1 1.1M6.4 13.6l-1.1 1.1"/></svg>', '设置', '通知、起始日、启动页') +
        '</div>'
    };
  };

  SHEETS.attach = function () {
    function item(icon, label, key) {
      return '<button class="attach-item" type="button" data-attach="' + key + '"><span>' + icon + '</span>' + label + '</button>';
    }
    return {
      title: '添加',
      body: '<div class="attach-grid">' +
        item(IC.image, '相册', 'album') + item(IC.camera, '拍照', 'camera') +
        item(IC.file, '文件', 'file') + item(IC.place, '位置', 'place') +
        '</div><p class="sheet-note">样稿模式：附件菜单只是示意，不会真的上传。</p>'
    };
  };

  SHEETS.nowEdit = function () {
    return {
      title: '编辑此刻',
      body: '<label class="field-label" for="nowInput">现在在做什么</label>' +
        '<textarea class="field" id="nowInput" style="min-height:120px">' + esc(state.nowText) + '</textarea>' +
        '<p class="sheet-note">这句话会保存到服务器，下次打开还在；它每次都会进入提示词。</p>',
      foot: '<button class="btn" type="button" data-close>取消</button><button class="btn btn--primary" type="button" data-save-now>保存</button>'
    };
  };

  SHEETS.memory = function (id) {
    var m = state.memories.filter(function (x) { return x.id === id; })[0];
    if (!m) return null;
    var flagText = [];
    if (m.pinned) flagText.push('已钉住');
    if (m.protected) flagText.push('受保护');
    return {
      title: '记忆',
      body: '<p class="sheet-label">' + esc(m.cat) + ' · 重要度 ' + m.importance + ' / 10</p>' +
        '<label class="field-label" for="memTitleInput">标题</label>' +
        '<input class="field field--title" id="memTitleInput" type="text" value="' + esc(m.title) + '">' +
        '<label class="field-label" for="memBodyInput">正文</label>' +
        '<textarea class="field" id="memBodyInput">' + esc(m.body) + '</textarea>' +
        '<p class="sheet-meta"><span>' + esc(m.source) + '</span><span>' + (flagText.join(' · ') || '普通记忆') + '</span></p>' +
        '<p class="sheet-note">轻轻遗忘不会删掉它，只会收进抽屉。</p>',
      foot: '<button class="btn btn--soft" type="button" data-mem-save="' + esc(m.id) + '">保存</button>' +
        '<button class="btn" type="button" data-mem-pin="' + esc(m.id) + '">' + (m.pinned ? '取消钉住' : '钉住') + '</button>' +
        '<button class="btn btn--danger" type="button" data-mem-forget="' + esc(m.id) + '">轻轻遗忘</button>'
    };
  };

  SHEETS.forgotten = function () {
    var items = state.memories.filter(function (m) { return m.forgotten; });
    var body;
    if (items.length) {
      body = '<p class="sheet-note">它们都还在，只是暂时不在光里。</p><div class="forgotten-list">' +
        items.map(function (m) {
          return '<div class="forgotten-item"><div class="forgotten-item__main">' +
            '<p class="forgotten-item__title">' + esc(m.title) + '</p>' +
            '<p class="forgotten-item__src">' + esc(m.cat) + ' · ' + esc(m.source) + '</p></div>' +
            '<button class="restore-btn" type="button" data-mem-restore="' + esc(m.id) + '">恢复</button></div>';
        }).join('') + '</div>';
    } else {
      body = '<p class="empty-note">这里还是空的。</p>';
    }
    return { title: '已遗忘', body: body };
  };

  SHEETS.memoryNew = function () {
    var cats = (DATA.memoryCats || ['全部', '关于我', '我们', '喜好', '日常', '约定']).filter(function (c) { return c !== '全部'; });
    return {
      title: '新增一条记忆',
      body: '<label class="field-label" for="memNewTitle">标题</label>' +
        '<input class="field field--title" id="memNewTitle" type="text" placeholder="例如：睡前半杯温水">' +
        '<label class="field-label" for="memNewBody">正文</label>' +
        '<textarea class="field" id="memNewBody" style="min-height:110px" placeholder="只写需要长期记住的那件事"></textarea>' +
        '<label class="field-label" for="memNewCat">分类</label>' +
        '<select class="field" id="memNewCat">' + cats.map(function (c) { return '<option value="' + esc(c) + '">' + esc(c) + '</option>'; }).join('') + '</select>' +
        '<label class="field-label" for="memNewImportance">重要度（1–10）</label>' +
        '<input class="field" id="memNewImportance" type="number" inputmode="numeric" min="1" max="10" value="6">' +
        '<p class="sheet-note">写进「记忆」页的笔记；钉住或者重要度高时会更常进入提示词。</p>',
      foot: '<button class="btn" type="button" data-close>取消</button>' +
        '<button class="btn btn--primary" type="button" data-action="create-memory">记下来</button>'
    };
  };

  SHEETS.migrateOffer = function () {
    var snap = rawLocalSnapshot || {};
    var providerCount = (snap.providers || []).filter(function (p) { return p.apiKey; }).length;
    return {
      title: '把浏览器里的数据交给服务器？',
      body: '<p class="sheet-note" style="text-align:left;font-size:11.5px">这台浏览器里还留着 A / A2 阶段的本地存档（角色 ' + ((snap.characters || []).length) + ' 位、聊天 ' + Object.keys(snap.chats || {}).length + ' 场、记忆 ' + ((snap.memories || []).length) + ' 条）。可以一次性迁移到本机后端，之后以服务器为准。</p>' +
        '<div class="toggle-row" style="margin-top:6px"><div class="toggle-row__main"><span class="toggle-row__label">连 API Key 一起上传</span><span class="toggle-row__sub">服务器会加密保存；不上传也可以，之后手动填</span></div>' +
        '<button class="switch" id="migrateKeySwitch" type="button" role="switch" aria-checked="false"><span></span></button></div>' +
        '<p class="sheet-note">迁移可以重复执行：按 id 去重，不会重复写入。完成后浏览器里的明文 Key 会被清空。</p>' +
        (providerCount ? '<div class="a2-banner a2-banner--warn"><span>浏览器里有 ' + providerCount + ' 个提供商的 Key，建议勾选一起上传后清掉本地明文。</span></div>' : ''),
      foot: '<button class="btn" type="button" data-migrate="skip">以后再说</button>' +
        '<button class="btn" type="button" data-migrate="plain">只迁移数据</button>' +
        '<button class="btn btn--primary" type="button" data-migrate="keys">连 Key 一起迁移</button>'
    };
  };

  SHEETS.playlist = function () {
    var body = DATA.playlists.map(function (pl, pi) {
      var songs = pl.songs.map(function (s, si) {
        var current = pi === listen.playlist && si === listen.song;
        return '<button class="song-row' + (current ? ' is-current' : '') + '" type="button" data-song="' + pi + ':' + si + '"' + (current ? ' aria-current="true"' : '') + '>' +
          '<span class="song-row__no">' + (si + 1) + '</span>' +
          coverThumb(s, 120) +
          '<span class="song-row__main"><span class="song-row__title">' + esc(s.title) + '</span><span class="song-row__artist">' + esc(s.artist) + '</span></span>' +
          (current ? '<span class="song-row__playing" aria-hidden="true"><i></i><i></i><i></i></span>' : '') +
          '<span class="song-row__dur">' + formatDur(s.dur) + '</span>' +
        '</button>';
      }).join('');
      return '<div class="pl-group"><div class="pl-group__head"><span class="pl-group__name">' + esc(pl.name) + '</span>' +
        '<span class="pl-group__desc">' + esc(pl.desc) + '</span><span class="pl-group__count">' + pl.songs.length + ' 首</span></div>' + songs + '</div>';
    }).join('');
    return {
      title: '网易云歌单',
      body: body + '<p class="sheet-note">封面来自网易云，按歌曲 id 直接加载；这一轮还不播放声音。</p>'
    };
  };

  function swatches(theme) {
    var pal = theme === 'pink' ? ['#e4a4b2', '#f7e0e6', '#fdf8fa', '#554b5a'] : ['#a9c8e6', '#e3eef8', '#f6fafd', '#4a5566'];
    return pal.map(function (c) { return '<i style="background:' + c + '"></i>'; }).join('');
  }

  SHEETS.theme = function () {
    var themes = THEME_ORDER.map(function (t) {
      return '<button class="theme-opt' + (state.theme === t ? ' is-selected' : '') + '" type="button" data-theme-set="' + t + '" aria-pressed="' + (state.theme === t) + '">' +
        '<span class="theme-opt__name">' + themeLabel(t) + '</span>' +
        (state.theme === t ? '<span class="theme-opt__use">正在使用</span>' : '<span class="theme-opt__use">点按切换</span>') +
        '<span class="theme-opt__pal" aria-hidden="true">' + swatches(t) + '</span>' +
      '</button>';
    }).join('');
    var rows = DATA.pages.map(function (p) {
      var wp = currentWp(p.key);
      var isOv = !!(state.overrides[state.theme] || {})[p.key];
      return '<button class="wp-page" type="button" data-wp-open="' + p.key + '">' +
        '<img class="wp-page__thumb" src="' + WALLPAPERS[wp] + '" alt="" loading="lazy">' +
        '<span class="wp-page__main"><span class="wp-page__name">' + p.name + '</span>' +
        '<span class="wp-page__state">' + wp + ' · ' + (isOv ? '已更换' : '默认') + '</span></span>' +
        IC.chevRight +
      '</button>';
    }).join('');
    return {
      title: '主题与壁纸',
      body: '<p class="sheet-label">主题</p><div class="theme-grid">' + themes + '</div>' +
        '<p class="sheet-label">按页面更换壁纸</p><div class="wp-pages">' + rows + '</div>' +
        '<p class="sheet-note">换过的壁纸会按「页面 + 主题」记住，随时可以恢复默认。</p>',
      foot: '<button class="btn" type="button" data-wp-reset="all">恢复全部默认</button>'
    };
  };

  SHEETS.wallpaper = function (pageKey) {
    pickerPage = pageKey || pickerPage || 'chat';
    var page = DATA.pages.filter(function (p) { return p.key === pickerPage; })[0] || { name: '聊天' };
    var current = currentWp(pickerPage);
    var items = DATA.wallpaperList.map(function (wp) {
      var note = DATA.wallpaperNote[wp] || wp;
      var selected = wp === current;
      return '<button class="wp-item' + (selected ? ' is-selected' : '') + '" type="button" data-wp-set="' + wp + '" aria-pressed="' + selected + '" aria-label="使用 ' + wp + '：' + esc(note) + '">' +
        '<img src="' + WALLPAPERS[wp] + '" alt="" loading="lazy" decoding="async">' +
        '<span class="wp-item__check" aria-hidden="true">' + IC.check + '</span>' +
        '<span class="wp-item__note">' + wp.replace('wp', '') + ' · ' + esc(note) + '</span>' +
      '</button>';
    }).join('');
    return {
      title: '更换壁纸 · ' + page.name,
      body: '<p class="sheet-note" style="margin-top:2px">当前主题：' + themeLabel(state.theme) + ' · 点一张就换上，会一直记住。</p>' +
        '<div class="wp-grid">' + items + '</div>',
      foot: '<button class="btn" type="button" data-wp-reset="' + pickerPage + '">恢复本页默认</button>' +
        '<button class="btn btn--primary" type="button" data-close>完成</button>'
    };
  };

  SHEETS.quota = function () {
    var q = DATA.quota;
    var pct = Math.min(100, Math.round(q.used / q.total * 100));
    var rows = q.breakdown.map(function (b) {
      return '<div class="quota-row"><span>' + esc(b.label) + '</span><span>¥' + b.value.toFixed(2) + '</span></div>';
    }).join('');
    return {
      title: '模型与额度',
      body: '<p class="sheet-label">当前模型</p><div class="option-list">' + modelOptionsHtml() + '</div>' +
        '<p class="sheet-label">本月用量</p>' +
        '<div class="quota-head"><span class="quota-num">¥' + q.used.toFixed(2) + '</span><span class="quota-total">/ ¥' + q.total + '</span></div>' +
        '<div class="quota-bar"><div class="quota-bar__fill" style="width:' + pct + '%"></div></div>' +
        '<p class="quota-reset">' + esc(q.reset) + '</p>' +
        '<div class="quota-list">' + rows + '</div>' +
        '<p class="sheet-note">额度是假数据，不会产生任何费用。</p>'
    };
  };

  /* ---------------- A 阶段：聊天里的切换与绑定 sheet ---------------- */
  SHEETS.characterSwitch = function () {
    var cur = currentChar();
    if (!cur) return null;
    var chat = chatOf(cur.id);
    var rp = resolvedPersona(chat, cur);
    var others = state.characters.filter(function (c) { return c.id !== cur.id; });
    var otherHtml = others.length ? others.map(function (c) {
      return '<button class="option" type="button" data-switch-char="' + esc(c.id) + '">' +
        avatarHTML(c, 'avatar avatar--ai option__avatar') +
        '<span class="option__main"><span class="option__title">' + esc(c.name) + '</span><span class="option__desc">' + esc(c.desc || '') + '</span></span>' +
        '<span class="option__source">' + esc(hasChat(c.id) ? '继续上次' : '还没有聊天') + '</span></button>';
    }).join('') : '<p class="empty-note">还没有其他角色。</p>';
    return {
      title: '和谁说话',
      body: '<p class="sheet-label">当前角色</p>' +
        '<div class="option is-selected">' +
          avatarHTML(cur, 'avatar avatar--ai option__avatar') +
          '<span class="option__main"><span class="option__title">' + esc(cur.name) + '</span><span class="option__desc">' + esc(cur.desc || '') + '</span></span>' +
          '<span class="option__source">在线</span>' +
        '</div>' +
        '<p class="sheet-label">换一位</p><div class="option-list">' + otherHtml + '</div>' +
        '<div class="sheet-divider"></div>' +
        '<button class="bind-mini" type="button" data-nav="characters" style="width:100%">' +
          '<span class="row-icon"><svg viewBox="0 0 20 20" fill="none"><circle cx="10" cy="7" r="3.1"/><path d="M4.4 16.2c.8-3 3-4.6 5.6-4.6s4.8 1.6 5.6 4.6"/></svg></span>' +
          '<span class="bind-mini__main"><span class="bind-mini__value">管理角色</span><span class="bind-mini__label">新建、编辑、导入角色卡</span></span>' + LIB_CHEV +
        '</button>' +
        '<div class="sheet-divider"></div>' +
        '<button class="bind-mini" type="button" data-open="personaSwitch" style="width:100%">' +
          avatarHTML(rp.persona, 'avatar avatar--me av-xs') +
          '<span class="bind-mini__main"><span class="bind-mini__label">这场聊天里的我 · ' + esc(personaSourceLabel(rp.source, cur)) + '</span>' +
          '<span class="bind-mini__value">' + esc(rp.persona ? rp.persona.name : '未设置') + '</span></span>' +
          '<span class="mini-btn" style="height:26px;padding:0 10px">换</span>' +
        '</button>' +
        '<p class="sheet-note">换角色 = 离开这场聊天，进入她的聊天；换「我」只改这一场。</p>'
    };
  };

  SHEETS.personaSwitch = function () {
    var char = currentChar();
    if (!char) return null;
    var chat = ensureChat(char.id);
    var fallback = resolvedPersona(null, char);
    var list = '<button class="option' + (!chat.personaId ? ' is-selected' : '') + '" type="button" data-persona-pick="">' +
      '<span class="option__mark" aria-hidden="true">默</span>' +
      '<span class="option__main"><span class="option__title">跟随默认（' + esc(fallback.persona ? fallback.persona.name : '') + '）</span>' +
      '<span class="option__desc">这场不单独指定</span></span>' +
      '<span class="option__source">' + esc(personaSourceLabel(fallback.source === 'chat' ? 'global' : fallback.source, char)) + '</span></button>';
    state.userPersonas.forEach(function (p) {
      var src = '';
      if (char.defaultPersonaId === p.id) src = '角色默认';
      else if (p.is_default) src = '全局默认';
      list += '<button class="option' + (chat.personaId === p.id ? ' is-selected' : '') + '" type="button" data-persona-pick="' + esc(p.id) + '">' +
        avatarHTML(p, 'avatar avatar--me option__avatar') +
        '<span class="option__main"><span class="option__title">' + esc(p.name) + '</span><span class="option__desc">' + esc(firstSentence(p.description)) + '</span></span>' +
        (src ? '<span class="option__source">' + esc(src) + '</span>' : '') + '</button>';
    });
    var ask = '';
    if (personaPending) {
      var pp = findPersona(personaPending);
      if (pp) {
        ask = '<div class="ask-card" style="margin-top:12px">' +
          '<p class="ask-card__text">「' + esc(pp.name) + '」只改这场聊天，还是同时设为 ' + esc(char.name) + ' 以后的默认？</p>' +
          '<div class="ask-actions">' +
            '<button class="btn btn--soft" type="button" data-persona-apply="chat">只改这场</button>' +
            '<button class="btn btn--primary" type="button" data-persona-apply="default">同时设为默认</button>' +
          '</div>' +
          '<p class="ask-card__text" style="margin-top:8px;font-size:10px">不会出现「临时设定、一刷新就回去」。</p></div>';
      }
    }
    return {
      title: '这场聊天里的我',
      body: '<p class="sheet-label">' + esc(char.name) + ' 的聊天用哪套用户设定</p>' +
        '<div class="option-list">' + list + '</div>' + ask
    };
  };

  SHEETS.charBook = function (charId) {
    var c = findChar(charId);
    if (!c) return null;
    var list = '<button class="option' + (!c.worldBookId ? ' is-selected' : '') + '" type="button" data-set-char-book="' + esc(c.id) + ':">' +
      '<span class="option__mark" aria-hidden="true">无</span>' +
      '<span class="option__main"><span class="option__title">不挂</span><span class="option__desc">只用全局书或这场聊天的书</span></span>' +
      '<span class="option__radio" aria-hidden="true"></span></button>';
    state.worldBooks.forEach(function (b) {
      list += '<button class="option' + (c.worldBookId === b.id ? ' is-selected' : '') + '" type="button" data-set-char-book="' + esc(c.id + ':' + b.id) + '">' +
        '<span class="option__mark" aria-hidden="true">书</span>' +
        '<span class="option__main"><span class="option__title">' + esc(b.name) + '</span><span class="option__desc">' + bookEntryCount(b) + ' 个条目</span></span>' +
        '<span class="option__radio" aria-hidden="true"></span></button>';
    });
    return {
      title: c.name + ' 的世界书',
      body: '<p class="sheet-label">她的主书（0 或 1 本）</p><div class="option-list">' + list + '</div>' +
        '<p class="sheet-note">角色只挂一本主书。这场聊天的书在聊天页的「书」里单独选。</p>'
    };
  };

  SHEETS.charPersona = function (charId) {
    var c = findChar(charId);
    if (!c) return null;
    var globalP = defaultPersona();
    var list = '<button class="option' + (!c.defaultPersonaId ? ' is-selected' : '') + '" type="button" data-set-char-persona="' + esc(c.id) + ':">' +
      '<span class="option__mark" aria-hidden="true">默</span>' +
      '<span class="option__main"><span class="option__title">跟全局默认</span><span class="option__desc">' + esc(globalP ? globalP.name : '未设置') + '</span></span>' +
      '<span class="option__radio" aria-hidden="true"></span></button>';
    state.userPersonas.forEach(function (p) {
      list += '<button class="option' + (c.defaultPersonaId === p.id ? ' is-selected' : '') + '" type="button" data-set-char-persona="' + esc(c.id + ':' + p.id) + '">' +
        avatarHTML(p, 'avatar avatar--me option__avatar') +
        '<span class="option__main"><span class="option__title">' + esc(p.name) + '</span><span class="option__desc">' + esc(firstSentence(p.description)) + '</span></span>' +
        '<span class="option__radio" aria-hidden="true"></span></button>';
    });
    return {
      title: c.name + ' 的默认用户设定',
      body: '<p class="sheet-label">她以后的聊天默认用哪套</p><div class="option-list">' + list + '</div>' +
        '<p class="sheet-note">聊天里临时换「我」时，可以另选「只改这场」。</p>'
    };
  };

  SHEETS.chatBook = function () {
    var char = currentChar();
    if (!char) return null;
    var chat = ensureChat(char.id);
    var globalBook = findBook(state.settings.globalBookId);
    var charBook = char.worldBookId ? findBook(char.worldBookId) : null;
    var list = '<button class="option' + (!chat.worldBookId ? ' is-selected' : '') + '" type="button" data-set-chat-book="">' +
      '<span class="option__mark" aria-hidden="true">无</span>' +
      '<span class="option__main"><span class="option__title">这场不单独挂</span><span class="option__desc">仍会用全局书和她的主书</span></span>' +
      '<span class="option__radio" aria-hidden="true"></span></button>';
    state.worldBooks.forEach(function (b) {
      list += '<button class="option' + (chat.worldBookId === b.id ? ' is-selected' : '') + '" type="button" data-set-chat-book="' + esc(b.id) + '">' +
        '<span class="option__mark" aria-hidden="true">书</span>' +
        '<span class="option__main"><span class="option__title">' + esc(b.name) + '</span><span class="option__desc">' + bookEntryCount(b) + ' 个条目</span></span>' +
        '<span class="option__radio" aria-hidden="true"></span></button>';
    });
    return {
      title: '这场聊天的世界书',
      body: '<p class="sheet-label">现在生效的</p>' +
        '<div class="bind-mini"><span class="bind-mini__main"><span class="bind-mini__label">全局书</span><span class="bind-mini__value">' + esc(globalBook ? globalBook.name : '未设置') + '</span></span></div>' +
        '<div class="bind-mini"><span class="bind-mini__main"><span class="bind-mini__label">' + esc(char.name) + ' 的主书</span><span class="bind-mini__value">' + esc(charBook ? charBook.name : '未挂') + '</span></span></div>' +
        '<p class="sheet-label">这场再挂一本</p><div class="option-list">' + list + '</div>' +
        '<p class="sheet-note">生成时三处合并、同一本只算一次。样稿不真的注入提示词。</p>'
    };
  };

  SHEETS.entryEdit = function (payload) {
    var parts = String(payload || '').split(':');
    var bookId = parts[0];
    var entryId = parts[1] || '';
    var b = findBook(bookId);
    if (!b) return null;
    var e = entryId ? findEntry(bookId, entryId) : null;
    return {
      title: e ? '编辑条目' : '新建条目',
      body: '<p class="sheet-note" style="text-align:left;margin-top:0">《' + esc(b.name) + '》 · 手机上一次只编辑这一条。</p>' +
        '<label class="field-label" for="entryTitleInput">标题</label>' +
        '<input class="field field--title" id="entryTitleInput" type="text" value="' + esc(e ? e.title : '') + '" placeholder="例如：门边的伞">' +
        '<label class="field-label" for="entryContentInput">正文</label>' +
        '<textarea class="field" id="entryContentInput" style="min-height:130px" placeholder="这条世界书要记住的事">' + esc(e ? e.content : '') + '</textarea>' +
        '<label class="field-label" for="entryKeysInput">关键词（用逗号隔开）</label>' +
        '<input class="field" id="entryKeysInput" type="text" value="' + esc(e && e.keys ? e.keys.join('、') : '') + '" placeholder="雨、伞、出门">' +
        '<div class="toggle-row" style="margin-top:6px"><div class="toggle-row__main"><span class="toggle-row__label">常开</span><span class="toggle-row__sub">不用关键词也每次带上</span></div>' +
          '<button class="switch" type="button" role="switch" aria-checked="' + String(e ? !!e.constant : false) + '" data-entry-switch="constant"><span></span></button></div>' +
        '<div class="toggle-row"><div class="toggle-row__main"><span class="toggle-row__label">启用</span><span class="toggle-row__sub">关掉后不会带入</span></div>' +
          '<button class="switch" type="button" role="switch" aria-checked="' + String(e ? e.enabled !== false : true) + '" data-entry-switch="enabled"><span></span></button></div>' +
        '<label class="field-label" for="entryOrderInput">顺序</label>' +
        '<input class="field" id="entryOrderInput" type="number" inputmode="numeric" value="' + (e ? (e.order || 0) : 10) + '">',
      foot: (e ? '<button class="btn btn--danger" type="button" data-entry-del="' + esc(bookId + ':' + entryId) + '">删除</button>' : '') +
        '<button class="btn btn--primary" type="button" data-entry-save="' + esc(bookId + ':' + (entryId || '')) + '">保存</button>'
    };
  };

  SHEETS.bookEdit = function (bookId) {
    var b = bookId ? findBook(bookId) : null;
    return {
      title: b ? '给世界书改名' : '新建世界书',
      body: '<label class="field-label" for="bookNameInput">书名</label>' +
        '<input class="field field--title" id="bookNameInput" type="text" value="' + esc(b ? b.name : '') + '" placeholder="例如：旧城雨事">' +
        '<p class="sheet-note">一本世界书里再放条目；之后可以挂到全局、角色或某场聊天。</p>',
      foot: '<button class="btn" type="button" data-close>取消</button>' +
        '<button class="btn btn--primary" type="button" data-book-save="' + esc(bookId || '') + '">' + (b ? '改名' : '创建') + '</button>'
    };
  };

  SHEETS.charEdit = function (charId) {
    var c = charId ? findChar(charId) : null;
    charDraft = c ? clone(c) : {
      id: newId('char'), name: '', desc: '', description: '', personality: '', scenario: '',
      first_mes: '', mes_example: '', avatar: '', worldBookId: '', defaultPersonaId: '',
      extras: {}, source: 'created'
    };
    return {
      title: c ? '编辑 ' + c.name : '新建角色',
      body: '<div class="bind-mini">' +
          '<span id="charEditAvatar">' + avatarHTML(charDraft, 'avatar avatar--ai av-sm') + '</span>' +
          '<span class="bind-mini__main"><span class="bind-mini__label">头像</span>' +
            '<span class="bind-mini__value" style="font-family:var(--sans);font-size:11px;color:var(--text-2)">选一张图片，或留空用首字</span></span>' +
          '<button class="mini-btn" type="button" data-avatar-pick="char">换头像</button>' +
        '</div>' +
        '<label class="field-label" for="charNameInput">名字</label>' +
        '<input class="field field--title" id="charNameInput" type="text" value="' + esc(charDraft.name) + '" placeholder="她叫什么">' +
        '<label class="field-label" for="charDescInput">一句话简介</label>' +
        '<input class="field" id="charDescInput" type="text" value="' + esc(charDraft.desc) + '" placeholder="列表里显示的那一行">' +
        '<label class="field-label" for="charDescriptionInput">她是谁（描述）</label>' +
        '<textarea class="field" id="charDescriptionInput" style="min-height:110px">' + esc(charDraft.description) + '</textarea>' +
        '<label class="field-label" for="charPersonalityInput">性格</label>' +
        '<textarea class="field" id="charPersonalityInput" style="min-height:80px">' + esc(charDraft.personality) + '</textarea>' +
        '<label class="field-label" for="charScenarioInput">情景</label>' +
        '<textarea class="field" id="charScenarioInput" style="min-height:80px">' + esc(charDraft.scenario) + '</textarea>' +
        '<label class="field-label" for="charFirstInput">开场白</label>' +
        '<textarea class="field" id="charFirstInput" style="min-height:80px">' + esc(charDraft.first_mes) + '</textarea>' +
        '<label class="field-label" for="charExampleInput">示例对话</label>' +
        '<textarea class="field" id="charExampleInput" style="min-height:100px" placeholder="{{user}}：… / {{char}}：…">' + esc(charDraft.mes_example) + '</textarea>',
      foot: '<button class="btn" type="button" data-close>取消</button>' +
        '<button class="btn btn--primary" type="button" data-char-save="' + esc(charId || '') + '">保存</button>'
    };
  };

  SHEETS.bookConflict = function () {
    var book = pendingBookImport && pendingBookImport.book;
    if (!book) return null;
    return {
      title: '书名重复了',
      body: '<p class="sheet-note" style="text-align:left;font-size:11.5px">已经有一本叫《' + esc(book.name) + '》的世界书。替换它，还是保留两本？</p>' +
        '<p class="sheet-note">保留两本时，新导入的会改一个名字。</p>',
      foot: '<button class="btn" type="button" data-book-conflict="keep">保留两本</button>' +
        '<button class="btn btn--primary" type="button" data-book-conflict="replace">替换</button>'
    };
  };

  SHEETS.confirm = function (payload) {
    if (!payload) return null;
    return {
      title: payload.title || '确认',
      body: '<p class="sheet-note" style="text-align:left;font-size:11.5px">' + (payload.text || '') + '</p>',
      foot: '<button class="btn" type="button" data-close>取消</button>' +
        '<button class="btn btn--danger" type="button" data-confirm-run="' + esc(payload.run + ':' + (payload.id || '')) + '">' + esc(payload.label || '删除') + '</button>'
    };
  };

  SHEETS.backup = function () {
    return {
      title: '备份',
      body: '<p class="sheet-label">这台手机里的东西</p>' +
        '<p class="sheet-note" style="text-align:left;font-size:11.5px">角色 ' + state.characters.length + ' 位、用户设定 ' + state.userPersonas.length + ' 套、世界书 ' + state.worldBooks.length + ' 本、聊天 ' + Object.keys(state.chats).length + ' 场。</p>' +
        '<p class="sheet-meta"><span>上次备份</span><span>' + esc(state.backupAt ? formatBackup(state.backupAt) : '还没有') + '</span></p>' +
        '<p class="sheet-note">样稿不连网盘。这里的「备份」只是把本地数据导出成一份 JSON。</p>',
      foot: '<button class="btn" type="button" data-backup-now>记一下备份时间</button>' +
        '<button class="btn btn--primary" type="button" data-backup-export>导出全部数据</button>'
    };
  };

  /* ================================================================
     A 阶段：导入 / 导出（全部在浏览器本地完成）
     ================================================================ */
  function tryParseJson(text) {
    try { return JSON.parse(text); } catch (e) { return null; }
  }
  function pickStr() {
    for (var i = 0; i < arguments.length; i++) {
      var v = arguments[i];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return '';
  }
  function normalizeKeys(value) {
    if (Array.isArray(value)) {
      return value.map(function (k) { return String(k).trim(); }).filter(Boolean);
    }
    if (typeof value === 'string') {
      return value.split(/[,，、]/).map(function (k) { return k.trim(); }).filter(Boolean);
    }
    return [];
  }
  function readFileText(file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(String(r.result)); };
      r.onerror = function () { reject(r.error); };
      r.readAsText(file);
    });
  }
  function readFileDataUrl(file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(String(r.result)); };
      r.onerror = function () { reject(r.error); };
      r.readAsDataURL(file);
    });
  }
  function downloadText(filename, text) {
    try {
      var blob = new Blob([text], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      setTimeout(function () {
        if (a.parentNode) a.parentNode.removeChild(a);
        URL.revokeObjectURL(url);
      }, 700);
      return true;
    } catch (e) { return false; }
  }
  function fileBaseName(name) { return String(name || '').replace(/\.[^.]+$/, ''); }

  /* PNG：读 tEXt 里的 ccv3 / chara，先 ccv3 再 chara */
  /* JSON 角色卡：v2 / v3（spec + data）、v1 扁平（name）、Pygmalion（char_name 等） */
  /* 酒馆世界书条目 + 角色卡自带 character_book 条目，统一成内部条目 */
  function convertBookEntries(src) {
    var arr = [];
    if (Array.isArray(src)) arr = src;
    else if (src && typeof src === 'object') arr = Object.keys(src).map(function (k) { return src[k]; });
    var out = [];
    arr.forEach(function (e, i) {
      if (!e || typeof e !== 'object') return;
      var content = pickStr(e.content, e.entry, e.text);
      var title = pickStr(e.comment, e.name, e.title) || ('条目 ' + (i + 1));
      if (!content && !title) return;
      var keys = normalizeKeys(e.keys || e.key || e.keywords);
      var order = typeof e.insertion_order === 'number' ? e.insertion_order
        : (typeof e.order === 'number' ? e.order : (i + 1) * 10);
      out.push({
        id: newId('e'),
        title: title,
        content: content,
        keys: keys,
        constant: !!e.constant,
        enabled: e.enabled !== false && e.disable !== true,
        order: order
      });
    });
    return out;
  }

  function uniqueBookName(base) {
    var name = base;
    var n = 1;
    while (state.worldBooks.some(function (b) { return b.name === name; })) {
      n += 1;
      name = base + '（' + n + '）';
    }
    return name;
  }
  /* 角色卡导入：一律交给后端解析（server/cards.py 是唯一实现）。
     file:// 或服务端离线时不再支持导入——前端那份 PNG / JSON 解析已经删掉，
     免得两套卡格式逻辑各自漂移。 */
  function handleCharFile(file) {
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) { toast('文件打不开，换一份再试试。'); return; }
    if (!SERVER_MODE || !serverOnline) {
      toast('导入角色卡要连上服务端：用 http 地址打开，并确认后端在跑。');
      return;
    }
    serverUpload('/characters/import', file, 'auto').then(function (data) {
      toast((data && data.note) || '角色卡已导入。');
      return refreshFromServer();
    }).catch(apiToast);
  }
  /* 世界书 JSON（酒馆格式有 entries；角色卡拆出的 character_book 也认） */
  function handleBookFile(file) {
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) { toast('文件打不开，换一份再试试。'); return; }
    if (SERVER_MODE && serverOnline) {
      readFileText(file).then(function (text) {
        var raw = tryParseJson(text);
        if (!raw) { toast('这不是一份能读的世界书文件。'); return; }
        serverFetch('/worldbooks/import', { method: 'POST', body: { payload: raw } }).then(function (data) {
          toast((data && data.note) || '世界书已导入。');
          return refreshFromServer();
        }).catch(apiToast);
      }).catch(function () { toast('文件打不开，换一份再试试。'); });
      return;
    }
    readFileText(file).then(function (text) {
      var raw = tryParseJson(text);
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { toast('这不是一份能读的世界书文件。'); return; }
      if (!raw.entries) {
        if (raw.lorebookVersion || raw.kind === 'memory' || raw.type === 'risu' || raw.naidata) {
          toast('目前只能导入酒馆格式的世界书 JSON。');
        } else {
          toast('这份文件里没有世界书条目。');
        }
        return;
      }
      var entries = convertBookEntries(raw.entries);
      if (!entries.length) { toast('这份文件里没有世界书条目。'); return; }
      var name = pickStr(raw.name, raw.title, fileBaseName(file.name)) || '导入的世界书';
      var book = { id: newId('wb'), name: uniqueBookName(name), entries: entries };
      var existing = null;
      state.worldBooks.forEach(function (b) { if (b.name === name) existing = b; });
      if (existing) {
        pendingBookImport = { book: book, existingId: existing.id };
        openSheet('bookConflict');
        return;
      }
      state.worldBooks.push(book);
      save();
      libBookId = book.id;
      renderLibraries(); renderMe(); renderChatContext();
      toast('已导入《' + book.name + '》，共 ' + entries.length + ' 条。');
    }).catch(function () { toast('文件打不开，换一份再试试。'); });
  }
  function applyBookConflict(mode) {
    if (!pendingBookImport) return;
    var book = pendingBookImport.book;
    var existingId = pendingBookImport.existingId;
    pendingBookImport = null;
    if (mode === 'replace' && existingId) {
      var target = findBook(existingId);
      if (target) {
        target.entries = book.entries;
        libBookId = target.id;
        save(); closeSheet(); renderLibraries(); renderMe(); renderChatContext();
        toast('已替换《' + target.name + '》的条目。');
        return;
      }
    }
    book.name = uniqueBookName(book.name);
    state.worldBooks.push(book);
    libBookId = book.id;
    save(); closeSheet(); renderLibraries(); renderMe(); renderChatContext();
    toast('已导入《' + book.name + '》，保留为另一本。');
  }

  /* 用户设定整包 JSON（也认酒馆备份的 personas / persona_descriptions） */
  function handlePersonaFile(file) {
    if (!file) return;
    if (SERVER_MODE && serverOnline) {
      readFileText(file).then(function (text) {
        var raw = tryParseJson(text);
        if (!raw || typeof raw !== 'object') { toast('这不是一份能读的用户设定文件。'); return; }
        serverFetch('/personas/import', { method: 'POST', body: { payload: raw } }).then(function (data) {
          toast((data && data.message) || '用户设定已导入。');
          return refreshFromServer();
        }).catch(apiToast);
      }).catch(function () { toast('文件打不开，换一份再试试。'); });
      return;
    }
    readFileText(file).then(function (text) {
      var raw = tryParseJson(text);
      if (!raw || typeof raw !== 'object') { toast('这不是一份能读的用户设定文件。'); return; }
      var incoming = [];
      if (Array.isArray(raw.personas)) {
        incoming = raw.personas.map(function (p) {
          return { name: pickStr(p && p.name, p && p.title), description: pickStr(p && p.description, p && p.persona, p && p.text), avatar: pickStr(p && p.avatar) };
        });
      } else if (raw.personas && typeof raw.personas === 'object') {
        var descs = raw.persona_descriptions || {};
        incoming = Object.keys(raw.personas).map(function (k) {
          var d = descs[k] || {};
          return { name: pickStr(raw.personas[k], k), description: pickStr(d.description), avatar: '' };
        });
      } else if (raw.persona_descriptions && typeof raw.persona_descriptions === 'object') {
        incoming = Object.keys(raw.persona_descriptions).map(function (k) {
          var d = raw.persona_descriptions[k] || {};
          return { name: k, description: pickStr(d.description), avatar: '' };
        });
      }
      incoming = incoming.filter(function (p) { return p.name; });
      if (!incoming.length) { toast('这不是一份能读的用户设定文件。'); return; }
      var added = 0;
      var withAvatar = 0;
      incoming.forEach(function (p) {
        if (state.userPersonas.some(function (x) { return x.name === p.name; })) return;
        if (p.avatar) withAvatar += 1;
        state.userPersonas.push({ id: newId('persona'), name: p.name, description: p.description || '', avatar: p.avatar || '', is_default: false });
        added += 1;
      });
      if (!added) { toast('没有新的用户设定可导入。'); return; }
      save();
      renderLibraries(); renderMe(); paintAllAvatars();
      toast(withAvatar ? '已导入 ' + added + ' 套用户设定。' : '文字已导入，头像请再选一张。');
    }).catch(function () { toast('文件打不开，换一份再试试。'); });
  }

  /* ---------- 导出 ---------- */
  function bookToCharacterBook(book) {
    return {
      name: book.name,
      entries: (book.entries || []).map(function (e, i) {
        return {
          keys: e.keys || [],
          secondary_keys: [],
          comment: e.title || '',
          content: e.content || '',
          constant: !!e.constant,
          selective: true,
          insertion_order: typeof e.order === 'number' ? e.order : (i + 1) * 10,
          enabled: e.enabled !== false,
          position: 'after_char'
        };
      })
    };
  }
  function buildV2Character(c) {
    var book = c.worldBookId ? findBook(c.worldBookId) : null;
    var extras = c.extras || {};
    var extensions = {};
    if (extras.extensions) Object.keys(extras.extensions).forEach(function (k) { extensions[k] = extras.extensions[k]; });
    extensions.world = book ? book.name : '';
    extensions.msyq_extras = { top: extras.top || {}, data: extras.data || {} };
    var data = {
      name: c.name,
      description: c.description || '',
      personality: c.personality || '',
      scenario: c.scenario || '',
      first_mes: c.first_mes || '',
      mes_example: c.mes_example || '',
      creator_notes: '',
      system_prompt: '',
      post_history_instructions: '',
      alternate_greetings: [],
      tags: [],
      creator: '',
      character_version: '',
      extensions: extensions
    };
    if (book) data.character_book = bookToCharacterBook(book);
    var card = { spec: 'chara_card_v2', spec_version: '2.0', data: data };
    ['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example'].forEach(function (k) { card[k] = data[k]; });
    card.creatorcomment = '';
    card.tags = [];
    return card;
  }
  function exportCharacter(id, format) {
    var c = findChar(id);
    if (!c) return;
    format = format || 'json';
    if (SERVER_MODE && serverOnline) {
      serverDownload('/characters/' + encodeURIComponent(id) + '/export?format=' + format).then(function (blob) {
        var filename = c.name + (format === 'png' ? '.png' : '.json');
        toast(downloadBlob(filename, blob) ? ('已导出「' + c.name + '」的 ' + format.toUpperCase() + '。') : '导出没成功，稍后再试。');
      }).catch(apiToast);
      return;
    }
    var ok = downloadText(c.name + '.json', JSON.stringify(buildV2Character(c), null, 2));
    toast(ok ? '已导出「' + c.name + '」的 JSON（v2）。PNG 导出需要连上服务器。' : '导出没成功，稍后再试。');
  }
  function exportBook(id) {
    var b = findBook(id);
    if (!b) return;
    if (SERVER_MODE && serverOnline) {
      serverDownload('/worldbooks/' + encodeURIComponent(id) + '/export').then(function (blob) {
        toast(downloadBlob(b.name + '.json', blob) ? '已导出《' + b.name + '》。' : '导出没成功，稍后再试。');
      }).catch(apiToast);
      return;
    }
    var tavern = { name: b.name, entries: {}, extensions: {} };
    (b.entries || []).forEach(function (e, i) {
      tavern.entries[String(i)] = {
        uid: i,
        key: e.keys || [],
        keysecondary: [],
        comment: e.title || '',
        content: e.content || '',
        constant: !!e.constant,
        selective: true,
        order: typeof e.order === 'number' ? e.order : (i + 1) * 10,
        position: 0,
        disable: e.enabled === false
      };
    });
    toast(downloadText(b.name + '.json', JSON.stringify(tavern, null, 2)) ? '已导出《' + b.name + '》。' : '导出没成功，稍后再试。');
  }
  function exportPersonas() {
    if (SERVER_MODE && serverOnline) {
      serverDownload('/personas/export').then(function (blob) {
        toast(downloadBlob('缪诗鸳杞-用户设定.json', blob) ? '已导出全部用户设定。' : '导出没成功，稍后再试。');
      }).catch(apiToast);
      return;
    }
    var personas = {};
    var descs = {};
    state.userPersonas.forEach(function (p) {
      personas[p.name] = p.name;
      descs[p.name] = { description: p.description || '' };
    });
    var payload = {
      app: '缪诗鸳杞',
      kind: 'user_personas',
      version: 1,
      exportedAt: new Date().toISOString(),
      personas: state.userPersonas.map(function (p) {
        return { name: p.name, description: p.description || '', avatar: p.avatar || '', is_default: !!p.is_default };
      }),
      persona_descriptions: descs,
      default_persona: defaultPersona() ? defaultPersona().name : ''
    };
    toast(downloadText('缪诗鸳杞-用户设定.json', JSON.stringify(payload, null, 2)) ? '已导出全部用户设定。' : '导出没成功，稍后再试。');
  }
  function exportBackup() {
    var payload = {
      app: '缪诗鸳杞',
      kind: 'backup',
      version: 1,
      exportedAt: new Date().toISOString(),
      theme: state.theme,
      overrides: state.overrides,
      settings: state.settings,
      nowText: state.nowText,
      memories: state.memories,
      model: state.model,
      listen: state.listen,
      characters: state.characters,
      userPersonas: state.userPersonas,
      worldBooks: state.worldBooks,
      chats: state.chats
    };
    toast(downloadText('缪诗鸳杞-备份.json', JSON.stringify(payload, null, 2)) ? '已导出全部数据。' : '导出没成功，稍后再试。');
  }

  /* ---------- 保存 / 删除 ---------- */
  function saveEntry(ref) {
    var parts = String(ref).split(':');
    var bookId = parts[0];
    var entryId = parts[1] || '';
    var b = findBook(bookId);
    if (!b) return;
    var titleEl = $('#entryTitleInput');
    var contentEl = $('#entryContentInput');
    var keysEl = $('#entryKeysInput');
    var orderEl = $('#entryOrderInput');
    var constantEl = document.querySelector('[data-entry-switch="constant"]');
    var enabledEl = document.querySelector('[data-entry-switch="enabled"]');
    var title = (titleEl ? titleEl.value : '').trim() || '未命名条目';
    var content = contentEl ? contentEl.value : '';
    var keys = normalizeKeys(keysEl ? keysEl.value : '');
    var constant = constantEl ? constantEl.getAttribute('aria-checked') === 'true' : false;
    var enabled = enabledEl ? enabledEl.getAttribute('aria-checked') === 'true' : true;
    var order = orderEl ? parseInt(orderEl.value, 10) : 10;
    if (isNaN(order)) order = 10;
    if (entryId) {
      var e = findEntry(bookId, entryId);
      if (e) { e.title = title; e.content = content; e.keys = keys; e.constant = constant; e.enabled = enabled; e.order = order; }
    } else {
      b.entries.push({ id: newId('e'), title: title, content: content, keys: keys, constant: constant, enabled: enabled, order: order });
    }
    save();
    closeSheet();
    renderBookLibrary();
    toast('条目已保存。');
  }
  function saveBook(bookId) {
    var el = $('#bookNameInput');
    var name = (el ? el.value : '').trim();
    if (!name) { toast('给世界书起个名字吧。'); return; }
    if (bookId) {
      var b = findBook(bookId);
      if (!b) return;
      var clash = state.worldBooks.some(function (x) { return x.id !== bookId && x.name === name; });
      b.name = clash ? uniqueBookName(name) : name;
    } else {
      var nb = { id: newId('wb'), name: uniqueBookName(name), entries: [] };
      state.worldBooks.push(nb);
      libBookId = nb.id;
    }
    save();
    closeSheet();
    renderBookLibrary();
    renderMe();
    renderChatContext();
    toast(bookId ? '书名改好了。' : '世界书建好了。');
  }
  function saveCharEdit(charId) {
    if (!charDraft) return;
    var nameEl = $('#charNameInput');
    var name = (nameEl ? nameEl.value : '').trim();
    if (!name) { toast('给她起个名字吧。'); return; }
    var fields = {
      name: name,
      desc: (($('#charDescInput') || {}).value || '').trim(),
      description: ($('#charDescriptionInput') || {}).value || '',
      personality: ($('#charPersonalityInput') || {}).value || '',
      scenario: ($('#charScenarioInput') || {}).value || '',
      first_mes: ($('#charFirstInput') || {}).value || '',
      mes_example: ($('#charExampleInput') || {}).value || '',
      avatar: charDraft.avatar || ''
    };
    if (charId) {
      var target = findChar(charId);
      if (!target) { charDraft = null; closeSheet(); return; }
      Object.keys(fields).forEach(function (k) { target[k] = fields[k]; });
      libCharId = target.id;
    } else {
      Object.keys(fields).forEach(function (k) { charDraft[k] = fields[k]; });
      charDraft.source = 'created';
      state.characters.push(charDraft);
      libCharId = charDraft.id;
    }
    charDraft = null;
    save();
    closeSheet();
    renderCharLibrary();
    renderMe();
    renderChatContext();
    paintAllAvatars();
    toast('角色已保存。');
  }
  function runConfirm(kind, id) {
    if (typeof runConfirmA2 === 'function' && runConfirmA2(kind, id) === true) return;
    if (kind === 'delete-char') {
      if (state.characters.length <= 1) { closeSheet(); toast('至少留一位角色。'); return; }
      state.characters = state.characters.filter(function (c) { return c.id !== id; });
      delete state.chats[id];
      if (state.currentCharacterId === id) {
        state.currentCharacterId = state.characters[0].id;
        chatMessages = [];
      }
      if (libCharId === id) libCharId = '';
      save();
      if (!chatMessages.length) openChat(state.currentCharacterId);
      renderLibraries(); renderMe(); renderChatContext(); paintAllAvatars();
      closeSheet();
      toast('已经删掉这位角色。');
      return;
    }
    if (kind === 'delete-persona') {
      if (state.userPersonas.length <= 1) { closeSheet(); toast('至少留一套用户设定。'); return; }
      var removed = findPersona(id);
      state.userPersonas = state.userPersonas.filter(function (p) { return p.id !== id; });
      state.characters.forEach(function (c) { if (c.defaultPersonaId === id) c.defaultPersonaId = ''; });
      Object.keys(state.chats).forEach(function (cid) { if (state.chats[cid].personaId === id) state.chats[cid].personaId = ''; });
      if (removed && removed.is_default && state.userPersonas.length) state.userPersonas[0].is_default = true;
      if (libPersonaId === id) libPersonaId = '';
      save();
      renderLibraries(); renderMe(); renderChatContext(); paintAllAvatars();
      closeSheet();
      toast('已经删掉这套用户设定。');
      return;
    }
    if (kind === 'delete-book') {
      state.worldBooks = state.worldBooks.filter(function (b) { return b.id !== id; });
      if (state.settings.globalBookId === id) state.settings.globalBookId = '';
      state.characters.forEach(function (c) { if (c.worldBookId === id) c.worldBookId = ''; });
      Object.keys(state.chats).forEach(function (cid) { if (state.chats[cid].worldBookId === id) state.chats[cid].worldBookId = ''; });
      if (libBookId === id) libBookId = '';
      save();
      renderLibraries(); renderMe(); renderChatContext();
      closeSheet();
      toast('已经删掉这本世界书。');
      return;
    }
    if (kind === 'delete-entry') {
      var idx = String(id).indexOf(':');
      var bookId = idx === -1 ? '' : String(id).slice(0, idx);
      var entryId = idx === -1 ? String(id) : String(id).slice(idx + 1);
      var b = findBook(bookId);
      if (b) b.entries = b.entries.filter(function (e) { return e.id !== entryId; });
      save();
      renderBookLibrary();
      closeSheet();
      toast('条目已经删掉。');
    }
  }

  function handleAvatarFile(file) {
    if (!file) return;
    readFileDataUrl(file).then(function (url) {
      if (avatarPickTarget === 'char' && charDraft) {
        charDraft.avatar = url;
        var holder = $('#charEditAvatar');
        if (holder) holder.innerHTML = avatarHTML(charDraft, 'avatar avatar--ai av-sm');
        toast('头像换好了，保存后生效。');
      } else if (avatarPickTarget === 'persona' && avatarPickId) {
        var p = findPersona(avatarPickId);
        if (p) {
          p.avatar = url;
          save();
          renderPersonaLibrary();
          paintAllAvatars();
          renderMe();
          toast('头像换好了。');
        }
      }
    }).catch(function () { toast('文件打不开，换一份再试试。'); });
  }

  /* ---------------- 记忆操作 ---------------- */
  function refreshBondsQuiet() {
    if (!serverOnline) return Promise.resolve(false);
    return serverFetch('/bonds').then(function (data) {
      state.bonds = Array.isArray(data.bonds) ? data.bonds : [];
      state.worldMemoryCount = data.worldCount || 0;
      renderBondChips();
      renderHome();
      renderMe();
      return true;
    }).catch(function () { return false; });
  }

  function renderBondChips() {
    var box = $('#bondChips');
    if (!box) return;
    var cur = memoryScope();
    var html = '';
    (state.bonds || []).forEach(function (b) {
      var on = cur.scope !== 'world' && cur.characterId === b.characterId && cur.personaId === b.personaId;
      html += '<button class="chip-filter' + (on ? ' is-on' : '') + '" type="button"'
        + ' data-bond-char="' + esc(b.characterId) + '" data-bond-persona="' + esc(b.personaId) + '"'
        + ' aria-pressed="' + (on ? 'true' : 'false') + '">'
        + esc(b.characterName) + ' × ' + esc(b.personaName) + ' · ' + (b.memoryCount || 0) + '</button>';
    });
    if (state.worldMemoryCount) {
      var won = cur.scope === 'world';
      html += '<button class="chip-filter' + (won ? ' is-on' : '') + '" type="button"'
        + ' data-bond-char="" data-bond-persona="" aria-pressed="' + (won ? 'true' : 'false') + '">共享 · '
        + state.worldMemoryCount + '</button>';
    }
    box.innerHTML = html;
  }
  function refreshMemoriesQuiet() {
    if (!serverOnline) return Promise.resolve(false);
    return serverFetch('/memories?includeForgotten=1' + bondQuery()).then(function (data) {
      if (Array.isArray(data.memories)) state.memories = data.memories;
      if (data.now && typeof data.now.body === 'string') state.nowText = data.now.body;
      renderMemories();
      return true;
    }).catch(function (err) {
      renderMemories();
      toast('记忆没取回来：' + (err && err.message ? err.message : '连接断了') + '，再点一次试试。');
      return false;
    });
  }

  function createMemoryFromForm() {
    var title = (($('#memNewTitle') || {}).value || '').trim();
    var body = (($('#memNewBody') || {}).value || '').trim();
    var category = ($('#memNewCat') || {}).value || '日常';
    var importance = parseInt((($('#memNewImportance') || {}).value || '6'), 10);
    if (!body) { toast('写一句要记住的话吧。'); return; }
    if (!serverOnline) { toast('离线模式下先不新增记忆，连上后端再试。'); return; }
    var bond = currentBond();
    serverFetch('/memories', {
      method: 'POST',
      body: {
        title: title || body.slice(0, 20),
        body: body,
        category: category,
        importance: isNaN(importance) ? 6 : importance,
        source: '手动新建',
        scope: 'pair',
        characterId: bond.characterId,
        personaId: bond.personaId
      }
    }).then(function (data) {
      if (data.memory) state.memories.unshift(data.memory);
      closeSheet();
      renderMemories();
      toast('记好了。');
    }).catch(apiToast);
  }

  function rememberLastReply() {
    if (!serverOnline) { toast('离线模式下先不写记忆。'); return; }
    var last = '';
    for (var i = chatMessages.length - 1; i >= 0; i--) {
      if (chatMessages[i].role === 'ai' && chatMessages[i].text && !chatMessages[i].uiOnly) { last = chatMessages[i].text; break; }
    }
    if (!last) { toast('还没有可以记住的回复。'); return; }
    var char = currentChar();
    var chat = char ? chatOf(char.id) : null;
    var bond = currentBond();
    serverFetch('/memories/remember', {
      method: 'POST',
      body: {
        text: last,
        title: last.split('。')[0].slice(0, 20),
        source: '聊天里点「记住」',
        chatId: chat ? chat.id : '',
        scope: 'pair',
        characterId: bond.characterId,
        personaId: bond.personaId
      }
    }).then(function (data) {
      closeSheet();
      if (data.memory) {
        state.memories.unshift(data.memory);
        toast('记好了：' + data.memory.title);
        renderMemories();
      } else {
        toast(data.message || '这句话已经在记忆里了。');
      }
    }).catch(apiToast);
  }

  function saveMemory(id) {
    var m = state.memories.filter(function (x) { return x.id === id; })[0];
    if (!m) return;
    var t = $('#memTitleInput');
    var b = $('#memBodyInput');
    if (t) m.title = t.value.trim() || m.title;
    if (b) m.body = b.value.trim() || m.body;
    if (serverOnline) {
      serverFetch('/memories/' + encodeURIComponent(id), { method: 'PUT', body: { title: m.title, body: m.body } }).catch(apiToast);
    }
    save();
    renderMemories();
    closeSheet();
    toast('记好了。');
  }

  function togglePin(id) {
    var m = state.memories.filter(function (x) { return x.id === id; })[0];
    if (!m) return;
    m.pinned = !m.pinned;
    if (m.pinned) m.status = 'pinned';
    if (serverOnline) {
      serverFetch('/memories/' + encodeURIComponent(id) + '/pin', { method: 'POST', body: { pinned: m.pinned } }).catch(apiToast);
    }
    save();
    renderMemories();
    openSheet('memory', id);
    toast(m.pinned ? '钉在最上面了。' : '已经取消钉住。');
  }

  function forgetMemory(id) {
    var m = state.memories.filter(function (x) { return x.id === id; })[0];
    if (!m) return;
    m.forgotten = true;
    if (serverOnline) {
      serverFetch('/memories/' + encodeURIComponent(id) + '/forget', { method: 'POST' }).catch(apiToast);
    }
    save();
    renderMemories();
    closeSheet();
    toast('已放进「已遗忘」，随时可以捡回来。');
  }

  function restoreMemory(id) {
    var m = state.memories.filter(function (x) { return x.id === id; })[0];
    if (!m) return;
    m.forgotten = false;
    if (serverOnline) {
      serverFetch('/memories/' + encodeURIComponent(id) + '/restore', { method: 'POST' }).catch(apiToast);
    }
    save();
    renderMemories();
    openSheet('forgotten');
    toast('捡回来了。');
  }

  /* ---------------- 壁纸操作 ---------------- */
  function setWallpaper(wp) {
    var def = DATA.themes[state.theme].pages[pickerPage];
    if (wp === def) {
      delete state.overrides[state.theme][pickerPage];
    } else {
      state.overrides[state.theme][pickerPage] = wp;
    }
    save();
    applyWallpapers();
    renderMe();
    $$('.wp-item').forEach(function (el) {
      var on = el.getAttribute('data-wp-set') === wp;
      el.classList.toggle('is-selected', on);
      el.setAttribute('aria-pressed', String(on));
    });
    toast('已换上 ' + wp + '。');
  }

  function resetWallpapers(which) {
    if (which === 'all') {
      state.overrides[state.theme] = {};
      save();
      applyWallpapers();
      renderMe();
      openSheet('theme');
      toast('全部页面都回到默认壁纸了。');
    } else {
      delete state.overrides[state.theme][which];
      save();
      applyWallpapers();
      renderMe();
      pickerPage = which;
      openSheet('wallpaper', which);
      toast('已恢复这一页的默认壁纸。');
    }
  }

  /* ---------------- 其它操作 ---------------- */
  function selectModel(name) {
    var m = DATA.models.filter(function (x) { return x.name === name; })[0];
    if (!m) return;
    state.model.model = m.name;
    save();
    updateChatHeader();
    $$('.option[data-model]').forEach(function (el) {
      el.classList.toggle('is-selected', el.getAttribute('data-model') === m.name);
    });
    toast('模型换成 ' + m.name + '。');
  }

  function saveNowText() {
    var el = $('#nowInput');
    if (!el) return;
    state.nowText = el.value.trim() || DATA.nowText;
    if (serverOnline) {
      var bond = currentBond();
      serverFetch('/memories/now', {
        method: 'PUT',
        body: { body: state.nowText, characterId: bond.characterId, personaId: bond.personaId }
      }).catch(apiToast);
    }
    save();
    renderMemories();
    closeSheet();
    toast('此刻已经改好了。');
  }

  function toggleCap(btn) {
    var on = !btn.classList.contains('is-on');
    btn.classList.toggle('is-on', on);
    btn.setAttribute('aria-pressed', String(on));
  }

  function updateCurrentInPlaylistSheet() {
    $$('.song').forEach(function (el) {
      var parts = (el.getAttribute('data-song') || '').split(':');
      var on = +parts[0] === listen.playlist && +parts[1] === listen.song;
      el.classList.toggle('is-current', on);
      el.setAttribute('aria-current', on ? 'true' : 'false');
      var eq = el.querySelector('.song__eq');
      if (on && !eq) {
        var dur = el.querySelector('.song__dur');
        if (dur) dur.insertAdjacentHTML('beforebegin', '<span class="song__eq" aria-hidden="true"><i></i><i></i><i></i></span>');
      } else if (!on && eq) {
        eq.remove();
      }
    });
  }

  /* ---------------- A 阶段：库操作小函数 ---------------- */
  function switchCharacter(id) {
    var c = findChar(id);
    if (!c) return;
    closeSheet();
    openChat(id);
    renderMe();
    toast('现在和你说话的是' + c.name + '。');
  }
  function startChatWith(id) {
    var c = findChar(id);
    if (!c) return;
    var existed = hasChat(id);
    closeSheet();
    openChat(id);
    renderMe();
    navTo('chat');
    toast(existed ? '回到和' + c.name + '的最近一场。' : '和' + c.name + '开始聊。');
  }
  function handleLibBack(view) {
    if (view === 'characters') {
      if (libCharId) { libCharId = ''; renderCharLibrary(); } else navTo('me');
      return;
    }
    if (view === 'personas') {
      if (libPersonaId) { libPersonaId = ''; renderPersonaLibrary(); } else navTo('me');
      return;
    }
    if (view === 'books') {
      if (libBookId) { libBookId = ''; renderBookLibrary(); } else navTo('me');
    }
  }
  function createPersonaDraft() {
    var p = { id: newId('persona'), name: '新的设定', description: '', avatar: '', is_default: false };
    state.userPersonas.push(p);
    save();
    libPersonaId = p.id;
    renderPersonaLibrary();
    renderMe();
    paintAllAvatars();
    toast('先填称呼和一段说明，再点保存。');
  }
  function savePersonaInline(id) {
    var p = findPersona(id);
    if (!p) return;
    var n = $('#personaNameInput');
    var d = $('#personaDescInput');
    if (n && n.value.trim()) p.name = n.value.trim();
    if (d) p.description = d.value;
    save();
    renderPersonaLibrary();
    renderMe();
    renderChatContext();
    paintAllAvatars();
    toast('用户设定已保存。');
  }
  function toggleGlobalPersona(id) {
    var p = findPersona(id);
    if (!p) return;
    if (p.is_default) { toast('至少要有一套全局默认；换一套再设。'); return; }
    setGlobalPersona(id);
    var btn = document.querySelector('[data-persona-default="' + id + '"]');
    if (btn) btn.setAttribute('aria-checked', 'true');
    toast('「' + p.name + '」现在是全局默认。');
  }
  function uniquePersonaName(base) {
    var name = base;
    var n = 1;
    while (state.userPersonas.some(function (p) { return p.name === name; })) {
      n += 1;
      name = base + '（' + n + '）';
    }
    return name;
  }
  function copyPersona(id) {
    var p = findPersona(id);
    if (!p) return;
    var copy = {
      id: newId('persona'),
      name: uniquePersonaName(p.name + '（副本）'),
      description: p.description,
      avatar: p.avatar,
      is_default: false
    };
    state.userPersonas.push(copy);
    save();
    libPersonaId = copy.id;
    renderLibraries();
    renderMe();
    paintAllAvatars();
    toast('复制好了。');
  }
  function toggleGlobalBook(id) {
    var b = findBook(id);
    if (!b) return;
    if (state.settings.globalBookId === id) {
      state.settings.globalBookId = '';
      save();
      renderLibraries(); renderChatContext(); renderMe();
      toast('已经取消全局书。');
    } else {
      state.settings.globalBookId = id;
      save();
      renderLibraries(); renderChatContext(); renderMe();
      toast('《' + b.name + '》现在是全局书。');
    }
  }

  /* ---------------- Toast ---------------- */
  var toastTimer = null;
  function toast(msg) {
    var el = $('#toast');
    el.textContent = msg;
    el.classList.add('is-show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('is-show'); }, 2200);
  }

  /* ---------------- 交互入口 ---------------- */
  function handleAction(action, el) {
    if (typeof handleA2Action === 'function' && handleA2Action(action, el) === true) return;
    if (action === 'import-char') { var fc = $('#fileCharCard'); if (fc) fc.click(); return; }
    if (action === 'import-book') { var fb = $('#fileWorldBook'); if (fb) fb.click(); return; }
    if (action === 'import-personas') { var fp = $('#filePersonas'); if (fp) fp.click(); return; }
    if (action === 'new-char') return openSheet('charEdit');
    if (action === 'new-book') return openSheet('bookEdit');
    if (action === 'new-persona') return createPersonaDraft();
    if (action === 'create-memory') return createMemoryFromForm();
    if (action === 'remember-last') return rememberLastReply();
    if (action === 'export-personas') return exportPersonas();
    if (action === 'backup') return backupNow();
    if (action === 'mic') return toast('语音输入是样稿示意，先替你收好。');
    if (action === 'call') return toast('通话是样稿示意，缪诗在文字里等你。');
    if (action === 'play') return setPlaying(!listen.playing);
    if (action === 'home-play') return setPlaying(!listen.playing);
    if (action === 'next') return nextSong(false);
    if (action === 'prev') return prevSong();
    if (action === 'note-like' || action === 'note-save') {
      if (el) {
        var btn = el.closest('.note-btn');
        if (btn) btn.classList.toggle('is-on');
      }
      return toast(action === 'note-like' ? '喜欢已经收好了。' : '收藏到「我们」了。');
    }
    if (action === 'note-reply') {
      navTo('chat');
      window.setTimeout(function () { var i = $('#chatInput'); if (i) i.focus(); }, 320);
      return;
    }
    if (action === 'func') {
      return toast('「' + ((el && el.getAttribute('data-func')) || '小组件') + '」是样稿占位，先替你记着。');
    }
  }

  function onAppClick(e) {
    var target = e.target;
    if (!target || !target.closest) return;
    var hit;

    if ((hit = target.closest('[data-close]'))) { closeSheet(); return; }

    /* A2：提供商 / 思考档位 / 提示词预设 / 统计 */
    if ((hit = target.closest('[data-a2-back]'))) { handleA2Back(hit.getAttribute('data-a2-back')); return; }
    if ((hit = target.closest('[data-a2]'))) { handleA2Click(hit.getAttribute('data-a2'), hit); return; }

    if ((hit = target.closest('[data-tool-toggle]'))) {
      var tool = hit.closest('.tool');
      if (!tool) return;
      var open = !tool.classList.contains('is-open');
      tool.classList.toggle('is-open', open);
      hit.setAttribute('aria-expanded', String(open));
      return;
    }

    if ((hit = target.closest('[data-action]'))) { handleAction(hit.getAttribute('data-action'), hit); return; }
    if ((hit = target.closest('[data-nav]'))) { navTo(hit.getAttribute('data-nav')); return; }
    if ((hit = target.closest('[data-cap]'))) { toggleCap(hit); return; }
    if ((hit = target.closest('[data-bond-char]'))) {
      var bchar = hit.getAttribute('data-bond-char') || '';
      var bpersona = hit.getAttribute('data-bond-persona') || '';
      var here = currentBond();
      var isHere = bchar && bchar === here.characterId && bpersona === here.personaId;
      memoryScopeOverride = bchar
        ? (isHere ? null : { characterId: bchar, personaId: bpersona, scope: '' })
        : { characterId: '', personaId: '', scope: 'world' };
      renderBondChips();
      /* 先按新范围重画一次：即使请求失败，也不会停留在上一段关系的列表上 */
      state.nowText = '';
      renderMemories();
      refreshMemoriesQuiet();
      return;
    }
    if ((hit = target.closest('[data-cat]'))) { setFilter(hit.getAttribute('data-cat')); return; }
    if ((hit = target.closest('[data-memory]'))) { openSheet('memory', hit.getAttribute('data-memory')); return; }

    /* A 阶段：三个库与聊天绑定 */
    if ((hit = target.closest('[data-lib-back]'))) { handleLibBack(hit.getAttribute('data-lib-back')); return; }
    if ((hit = target.closest('[data-switch-char]'))) { switchCharacter(hit.getAttribute('data-switch-char')); return; }
    if ((hit = target.closest('[data-char-open]'))) { libCharId = hit.getAttribute('data-char-open'); renderCharLibrary(); return; }
    if ((hit = target.closest('[data-char-edit]'))) { openSheet('charEdit', hit.getAttribute('data-char-edit')); return; }
    if ((hit = target.closest('[data-char-export]'))) { exportCharacter(hit.getAttribute('data-char-export'), 'json'); return; }
    if ((hit = target.closest('[data-char-export-png]'))) { exportCharacter(hit.getAttribute('data-char-export-png'), 'png'); return; }
    if ((hit = target.closest('[data-char-del]'))) {
      openSheet('confirm', { title: '删除角色？', text: '她的聊天记录也会一起删掉，删掉就找不回来了。', label: '删除', run: 'delete-char', id: hit.getAttribute('data-char-del') });
      return;
    }
    if ((hit = target.closest('[data-char-start]'))) { startChatWith(hit.getAttribute('data-char-start')); return; }
    if ((hit = target.closest('[data-char-book]'))) { openSheet('charBook', hit.getAttribute('data-char-book')); return; }
    if ((hit = target.closest('[data-char-persona]'))) { openSheet('charPersona', hit.getAttribute('data-char-persona')); return; }
    if ((hit = target.closest('[data-set-char-book]'))) {
      var scb = hit.getAttribute('data-set-char-book').split(':');
      setCharWorldBook(scb[0], scb[1] || '');
      closeSheet();
      return;
    }
    if ((hit = target.closest('[data-set-char-persona]'))) {
      var scp = hit.getAttribute('data-set-char-persona').split(':');
      setCharDefaultPersona(scp[0], scp[1] || '');
      closeSheet();
      return;
    }
    if ((hit = target.closest('[data-set-chat-book]'))) {
      setChatWorldBook(hit.getAttribute('data-set-chat-book'));
      closeSheet();
      return;
    }
    if ((hit = target.closest('[data-persona-pick]'))) {
      var pid = hit.getAttribute('data-persona-pick');
      if (!pid) { personaPending = null; applyChatPersona('chat'); }
      else { personaPending = pid; openSheet('personaSwitch'); }
      return;
    }
    if ((hit = target.closest('[data-persona-apply]'))) { applyChatPersona(hit.getAttribute('data-persona-apply')); return; }
    if ((hit = target.closest('[data-persona-open]'))) { libPersonaId = hit.getAttribute('data-persona-open'); renderPersonaLibrary(); return; }
    if ((hit = target.closest('[data-persona-save]'))) { savePersonaInline(hit.getAttribute('data-persona-save')); return; }
    if ((hit = target.closest('[data-persona-default]'))) { toggleGlobalPersona(hit.getAttribute('data-persona-default')); return; }
    if ((hit = target.closest('[data-persona-avatar]'))) {
      avatarPickTarget = 'persona';
      avatarPickId = hit.getAttribute('data-persona-avatar');
      var pa = $('#fileAvatar'); if (pa) pa.click();
      return;
    }
    if ((hit = target.closest('[data-persona-copy]'))) { copyPersona(hit.getAttribute('data-persona-copy')); return; }
    if ((hit = target.closest('[data-persona-del]'))) {
      openSheet('confirm', { title: '删除用户设定？', text: '用过她的角色和这场聊天会回到默认设定。', label: '删除', run: 'delete-persona', id: hit.getAttribute('data-persona-del') });
      return;
    }
    if ((hit = target.closest('[data-book-open]'))) { libBookId = hit.getAttribute('data-book-open'); renderBookLibrary(); return; }
    if ((hit = target.closest('[data-book-export]'))) { exportBook(hit.getAttribute('data-book-export')); return; }
    if ((hit = target.closest('[data-book-rename]'))) { openSheet('bookEdit', hit.getAttribute('data-book-rename')); return; }
    if ((hit = target.closest('[data-book-del]'))) {
      openSheet('confirm', { title: '删除世界书？', text: '挂过它的角色和聊天会自动取下来。', label: '删除', run: 'delete-book', id: hit.getAttribute('data-book-del') });
      return;
    }
    if ((hit = target.closest('[data-book-global]'))) { toggleGlobalBook(hit.getAttribute('data-book-global')); return; }
    if ((hit = target.closest('[data-entry-open]'))) { openSheet('entryEdit', hit.getAttribute('data-entry-open')); return; }
    if ((hit = target.closest('[data-entry-new]'))) { openSheet('entryEdit', hit.getAttribute('data-entry-new') + ':'); return; }
    if ((hit = target.closest('[data-entry-save]'))) { saveEntry(hit.getAttribute('data-entry-save')); return; }
    if ((hit = target.closest('[data-entry-del]'))) {
      openSheet('confirm', { title: '删除这条？', text: '删掉后这条世界书就不再带入。', label: '删除', run: 'delete-entry', id: hit.getAttribute('data-entry-del') });
      return;
    }
    if ((hit = target.closest('[data-entry-switch]'))) {
      var on = hit.getAttribute('aria-checked') !== 'true';
      hit.setAttribute('aria-checked', String(on));
      return;
    }
    if ((hit = target.closest('[data-book-save]'))) { saveBook(hit.getAttribute('data-book-save')); return; }
    if ((hit = target.closest('[data-char-save]'))) { saveCharEdit(hit.getAttribute('data-char-save')); return; }
    if ((hit = target.closest('[data-book-conflict]'))) { applyBookConflict(hit.getAttribute('data-book-conflict')); return; }
    if ((hit = target.closest('[data-confirm-run]'))) {
      var cref = hit.getAttribute('data-confirm-run');
      var ci = cref.indexOf(':');
      runConfirm(ci === -1 ? cref : cref.slice(0, ci), ci === -1 ? '' : cref.slice(ci + 1));
      return;
    }
    if ((hit = target.closest('[data-backup-now]'))) { backupNow(); return; }
    if ((hit = target.closest('[data-backup-export]'))) { exportBackup(); return; }
    if ((hit = target.closest('[data-avatar-pick]'))) {
      avatarPickTarget = 'char';
      avatarPickId = '';
      var fa = $('#fileAvatar'); if (fa) fa.click();
      return;
    }
    if ((hit = target.closest('[data-open]'))) {
      var openName = hit.getAttribute('data-open');
      if (openName === 'personaSwitch') personaPending = null;
      openSheet(openName);
      return;
    }
    if ((hit = target.closest('[data-model]'))) { selectModel(hit.getAttribute('data-model')); return; }
    if ((hit = target.closest('[data-chat-font-set]'))) {
      applyChatFont(hit.getAttribute('data-chat-font-set'), { toast: true });
      return;
    }
    if ((hit = target.closest('[data-theme-set]'))) {
      applyTheme(hit.getAttribute('data-theme-set'), { toast: true });
      if (!hit.classList.contains('theme-swatch')) openSheet('theme');
      return;
    }
    if ((hit = target.closest('[data-wp-open]'))) { openSheet('wallpaper', hit.getAttribute('data-wp-open')); return; }
    if ((hit = target.closest('[data-wp-set]'))) { setWallpaper(hit.getAttribute('data-wp-set')); return; }
    if ((hit = target.closest('[data-wp-reset]'))) { resetWallpapers(hit.getAttribute('data-wp-reset')); return; }
    if ((hit = target.closest('[data-mem-save]'))) { saveMemory(hit.getAttribute('data-mem-save')); return; }
    if ((hit = target.closest('[data-mem-pin]'))) { togglePin(hit.getAttribute('data-mem-pin')); return; }
    if ((hit = target.closest('[data-mem-forget]'))) { forgetMemory(hit.getAttribute('data-mem-forget')); return; }
    if ((hit = target.closest('[data-mem-restore]'))) { restoreMemory(hit.getAttribute('data-mem-restore')); return; }
    if ((hit = target.closest('[data-migrate]'))) {
      var mode = hit.getAttribute('data-migrate');
      if (mode === 'skip') { try { localStorage.setItem('msyq.migrated', '1'); } catch (e) { /* 忽略 */ } closeSheet(); toast('先不迁移，随时可以在设置里再来。'); return; }
      runMigration(mode === 'keys');
      return;
    }
    if ((hit = target.closest('[data-song]'))) {
      var parts = hit.getAttribute('data-song').split(':');
      selectSong(+parts[0], +parts[1]);
      return;
    }
    if ((hit = target.closest('[data-save-now]'))) { saveNowText(); return; }
    if ((hit = target.closest('[data-attach]'))) {
      closeSheet();
      toast('样稿模式：附件入口只是示意。');
      return;
    }
  }

  function bindEvents() {
    $('#app').addEventListener('click', onAppClick);

    $('#sendBtn').addEventListener('click', sendChat);
    $('#chatInput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); sendChat(); }
    });

    $('#memorySearch').addEventListener('input', function (e) {
      memoryQuery = e.target.value.trim();
      renderMemories();
    });

    $('#notifySwitch').addEventListener('click', function () {
      state.settings.notify = !state.settings.notify;
      save();
      renderSettings();
    });
    $('#splashSwitch').addEventListener('click', function () {
      state.settings.splashAlways = !state.settings.splashAlways;
      save();
      renderSettings();
      toast(state.settings.splashAlways ? '以后每次进来都会先看到首页。' : '本次会话只显示一次首页。');
    });
    $('#startDate').addEventListener('change', function (e) {
      var v = e.target.value;
      if (!parseDay(v)) { e.target.value = state.settings.startDate; return; }
      state.settings.startDate = v;
      /* 「在一起」的开始日期属于每一段关系，改了要同步过去，不然首页天数不会变 */
      var here = currentBond();
      (state.bonds || []).forEach(function (b) {
        if (b.characterId === here.characterId && b.personaId === here.personaId) {
          b.startedAt = v;
          if (serverOnline) {
            serverFetch('/bonds/' + encodeURIComponent(b.id), {
              method: 'PUT',
              body: { startedAt: v }
            }).catch(apiToast);
          }
        }
      });
      save();
      renderMe();
      renderHome();
      toast('起始日改成 ' + sinceText(v) + '。');
    });

    var fileCharCard = $('#fileCharCard');
    if (fileCharCard) fileCharCard.addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0];
      e.target.value = '';
      if (f) handleCharFile(f);
    });
    var fileWorldBook = $('#fileWorldBook');
    if (fileWorldBook) fileWorldBook.addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0];
      e.target.value = '';
      if (f) handleBookFile(f);
    });
    var filePersonas = $('#filePersonas');
    if (filePersonas) filePersonas.addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0];
      e.target.value = '';
      if (f) handlePersonaFile(f);
    });
    var fileAvatar = $('#fileAvatar');
    if (fileAvatar) fileAvatar.addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0];
      e.target.value = '';
      if (f) handleAvatarFile(f);
    });

    $('#progressTrack').addEventListener('click', function (e) {
      var rect = this.getBoundingClientRect();
      seekRatio((e.clientX - rect.left) / rect.width);
    });
    $('#progressTrack').addEventListener('keydown', function (e) {
      if (e.key === 'ArrowRight') { e.preventDefault(); seekRatio((listen.progress + 5) / currentSong().dur); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); seekRatio((listen.progress - 5) / currentSong().dur); }
    });

    /* A2：提供商 / 预设导入文件选择器 */
    ['fileProvider', 'filePreset'].forEach(function (id) {
      var el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('change', function (ev) {
        var f = ev.target.files && ev.target.files[0];
        ev.target.value = '';
        if (!f) return;
        if (id === 'fileProvider') handleProviderFile(f);
        else handlePresetFile(f);
      });
    });

    /* A2：搜索框输入（每次只重绘列表，不打断输入） */
    document.addEventListener('input', function (ev) {
      var t = ev.target;
      if (!t || !t.getAttribute) return;
      var kind = t.getAttribute('data-search');
      if (!kind) return;
      if (kind === 'provider') { providerQuery = t.value.trim(); renderProviderListInner(); }
      if (kind === 'modelPicker') { renderModelPickerList(t.value.trim()); }
    });

    /* A2：协议类型变化时自动补路径 */
    document.addEventListener('change', function (ev) {
      var t = ev.target;
      if (!t || !t.id) return;
      if (t.id === 'provProtocol') applyProtocolDefaults(t.value);
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeSheet();
    });
  }

  /* ================================================================
     A2 阶段：模型与提供商 / 思考档位 / 提示词预设 / 统计页
     全部为本地样稿状态；不连接任何模型接口（测试连接/拉取模型只做一次真实尝试）
     ================================================================ */

  var providerDetailId = '';
  var providerTab = 'config';
  var providerQuery = '';
  var mpCollapsed = {};
  var mpQuery = '';
  var pullState = null;
  var reasonPending = null;
  var exportIncludeKey = false;
  var exportTarget = '';
  var fragRef = '';

  var IC_PLUS_A2 = '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M10 4.6v10.8M4.6 10h10.8"/></svg>';
  var IC_IMPORT_A2 = '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M10 3.6v7.2M6.8 7.6l3.2 3.2 3.2-3.2M4.4 13.4v2.2c0 .6.5 1.1 1.1 1.1h9c.6 0 1.1-.5 1.1-1.1v-2.2"/></svg>';
  var IC_REFRESH_A2 = '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M15.6 7.4A6 6 0 0 0 4.6 9M4.4 12.6A6 6 0 0 0 15.4 11"/><path d="M15.8 4.2v3.4h-3.4M4.2 15.8v-3.4h3.4"/></svg>';
  var IC_INFO_A2 = '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="10" cy="10" r="6.8"/><path d="M10 9.2v4M10 6.6v.1"/></svg>';
  var IC_HEART = '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M10 16.2S3.8 12.3 3.8 8.4A3.7 3.7 0 0 1 10 6a3.7 3.7 0 0 1 6.2 2.4c0 3.9-6.2 7.8-6.2 7.8z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>';
  var IC_BULB = '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M10 2.8a4.4 4.4 0 0 1 2.6 8c-.4.3-.6.7-.6 1.2v.6H8v-.6c0-.5-.2-.9-.6-1.2A4.4 4.4 0 0 1 10 2.8z"/><path d="M8.2 14.8h3.6M8.8 17h2.4"/></svg>';
  var IC_EYE = '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M2.8 10s2.6-4.4 7.2-4.4S17.2 10 17.2 10s-2.6 4.4-7.2 4.4S2.8 10 2.8 10z"/><circle cx="10" cy="10" r="2.1"/></svg>';
  var IC_TRASH = '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M4.4 6.2h11.2M7.8 3.8h4.4M6 6.2l.7 10h6.6l.7-10"/></svg>';
  var IC_COPY = '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><rect x="6.4" y="6.4" width="9.4" height="9.4" rx="2"/><path d="M12.2 6.4V5.2c0-.6-.4-1-1-1H5.2c-.6 0-1 .4-1 1v6c0 .6.4 1 1 1h1.2"/></svg>';

  function findProvider(id) { return byId(state.providers, id); }
  function findModel(id) { return byId(state.models, id); }
  function findPreset(id) { return byId(state.promptPresets, id); }
  function providerOf(model) { return model ? findProvider(model.providerId) : null; }
  function providerHasKey(provider) {
    if (!provider) return false;
    if (SERVER_MODE && serverOnline) return !!provider.hasKey;
    return !!provider.apiKey;
  }
  function providerKeyMask(provider) {
    if (!provider) return '';
    if (SERVER_MODE && serverOnline) return provider.keyMasked || '';
    return provider.apiKey ? maskKey(provider.apiKey) : '';
  }
  function protocolOf(provider) {
    var list = DATA.protocols || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === (provider && provider.protocol)) return list[i];
    return list[0] || { id: 'openai', name: 'OpenAI 兼容', path: '/chat/completions', modelsPath: '/models', balance: false };
  }
  function protocolName(id) {
    var list = DATA.protocols || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i].name;
    return id || 'OpenAI 兼容';
  }
  function providerModels(provider) {
    if (!provider) return [];
    return (provider.models || []).map(findModel).filter(Boolean);
  }
  function currentModel() { return findModel(state.modelId) || state.models[0] || null; }
  function enabledProviders() {
    return state.providers.filter(function (p) { return p.enabled; });
  }
  function hostOf(url) {
    return String(url || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '') || '未填地址';
  }
  function shortContext(n) {
    if (!n) return '';
    if (n >= 1000000) return Math.round(n / 100000) / 10 + 'M';
    if (n >= 1000) return Math.round(n / 1000) + 'K';
    return String(n);
  }

  /* ---------- 官方图标：按模型 ID 关键词自动匹配 ---------- */
  var ICON_RULES = [
    ['deepseek', 'deepseek'], ['claude', 'claude'], ['anthropic', 'anthropic'], ['gemini', 'gemini'],
    ['google', 'google'], ['openrouter', 'openrouter'], ['silicon', 'siliconcloud'],
    ['qwen', 'qwen'], ['tongyi', 'qwen'], ['kimi', 'kimi'], ['moonshot', 'kimi'],
    ['glm', 'zhipu'], ['zhipu', 'zhipu'], ['doubao', 'doubao'], ['volc', 'doubao'],
    ['grok', 'grok'], ['xai', 'grok'], ['mistral', 'mistral'], ['llama', 'meta'], ['meta', 'meta'],
    ['gpt', 'openai'], ['o1', 'openai'], ['o3', 'openai'], ['o4', 'openai'], ['openai', 'openai']
  ];
  function matchIconKey(text) {
    var s = String(text || '').toLowerCase();
    for (var i = 0; i < ICON_RULES.length; i++) {
      if (s.indexOf(ICON_RULES[i][0]) !== -1) return ICON_RULES[i][1];
    }
    return '';
  }
  function iconKeySvg(key) { return (key && PROVIDER_ICONS[key]) ? PROVIDER_ICONS[key] : ''; }
  function providerIconKey(provider) {
    if (!provider) return '';
    if (provider.icon && PROVIDER_ICONS[provider.icon]) return provider.icon;
    return matchIconKey(provider.name);
  }
  function iconHTMLByKey(key, name, cls) {
    var cls2 = (cls || '').trim();
    if (key && PROVIDER_ICONS[key]) {
      return '<span class="p-icon ' + cls2 + '" aria-hidden="true">' + PROVIDER_ICONS[key] + '</span>';
    }
    return '<span class="p-icon ' + cls2 + ' p-icon--letter" aria-hidden="true">' + esc(String(name || '·').charAt(0)) + '</span>';
  }
  function providerIconHTML(provider, cls) {
    return iconHTMLByKey(providerIconKey(provider), provider ? provider.name : '', cls);
  }
  function modelIconKey(model) {
    if (!model) return '';
    if (model.icon && PROVIDER_ICONS[model.icon]) return model.icon;
    var k = matchIconKey(model.modelId) || matchIconKey(model.name);
    if (k) return k;
    var p = providerOf(model);
    return p ? providerIconKey(p) : '';
  }
  function modelIconSvg(model) {
    if (!model) return '';
    var key = modelIconKey(model);
    return PROVIDER_ICONS[key] || '';
  }
  function modelIconHTML(model, cls) {
    var key = modelIconKey(model);
    var cls2 = (cls || '').trim();
    if (key && PROVIDER_ICONS[key]) return '<span class="p-icon ' + cls2 + '" aria-hidden="true">' + PROVIDER_ICONS[key] + '</span>';
    return '<span class="p-icon ' + cls2 + ' p-icon--letter" aria-hidden="true">' + esc(model ? String(model.name).charAt(0) : '·') + '</span>';
  }

  /* ---------- 思考档位：档位 -> 请求参数（独立函数，后端可复用） ---------- */
  var REASON_TEXT = { off: '关闭', auto: '自动', low: '低', medium: '中', high: '高', xhigh: '很高', max: '最高', on: '开启', minimal: '几乎不思考' };
  var REASON_SHORT = { off: '关', auto: '自动', low: '低', medium: '中', high: '高', xhigh: '很高', max: '最高', on: '开' };
  var REASON_MODES = [
    { id: 'none', label: '不能调（不发送任何思考参数）' },
    { id: 'deepseek', label: 'DeepSeek thinking + reasoning_effort' },
    { id: 'openai_effort', label: 'OpenAI reasoning.effort / reasoning_effort' },
    { id: 'anthropic_effort', label: 'Anthropic output_config.effort（5.x）' },
    { id: 'anthropic_budget', label: 'Anthropic thinking.budget_tokens（只留给 4.5 及更早）' },
    { id: 'gemini_level', label: 'Gemini thinkingLevel（3.x / 4.x）' },
    { id: 'gemini_budget', label: 'Gemini thinkingBudget（只给 2.5）' },
    { id: 'openrouter', label: 'OpenRouter reasoning.effort' },
    { id: 'xai', label: 'xAI grok reasoning_effort' },
    { id: 'qwen_thinking', label: '通义千问 enable_thinking' },
    { id: 'kimi', label: 'Kimi reasoning_effort' },
    { id: 'zhipu', label: '智谱 GLM thinking + reasoning_effort' },
    { id: 'ark', label: '火山方舟（豆包）thinking / reasoning_effort' },
    { id: 'siliconflow_thinking', label: '硅基流动 enable_thinking' },
    { id: 'relay_suffix', label: '中转站用模型名区分档位' }
  ];
  function reasonModeLabel(mode) {
    var map = {
      openai_effort: 'reasoning effort', anthropic_effort: 'output effort', anthropic_budget: 'thinking budget',
      gemini_level: 'thinking level', gemini_budget: 'thinking budget', deepseek: 'thinking + effort',
      openrouter: 'reasoning', xai: 'reasoning effort', qwen_thinking: 'enable thinking', kimi: 'reasoning effort',
      zhipu: 'thinking + effort', ark: 'thinking / effort', siliconflow_thinking: 'enable thinking',
      relay_suffix: '模型名区分', none: '不支持'
    };
    return map[mode] || '思考';
  }
  function reasoningLevels(model) {
    if (!model || !model.reasoning || model.reasoning.mode === 'none') return [];
    return (model.reasoning.levels || []).slice();
  }
  function reasoningSupported(model) { return reasoningLevels(model).length > 0; }
  function reasoningDefaultLevel(model) {
    var levels = reasoningLevels(model);
    if (!levels.length) return 'off';
    var d = model.reasoning.defaultLevel;
    return levels.indexOf(d) === -1 ? levels[0] : d;
  }
  function chatReasoningLevel() {
    var model = currentModel();
    var levels = reasoningLevels(model);
    if (!levels.length) return 'off';
    var chat = chatOf(state.currentCharacterId);
    if (chat && chat.reasoningLevel && levels.indexOf(chat.reasoningLevel) !== -1) return chat.reasoningLevel;
    return reasoningDefaultLevel(model);
  }
  function effortClamp(lv, order) {
    order = order || ['low', 'medium', 'high', 'xhigh', 'max'];
    if (lv === 'max' && order.indexOf('max') === -1) lv = order.indexOf('xhigh') !== -1 ? 'xhigh' : 'high';
    if (lv === 'xhigh' && order.indexOf('xhigh') === -1) lv = 'high';
    if (order.indexOf(lv) === -1) lv = order[order.length - 1] || 'high';
    return lv;
  }
  /*
   * 思考参数只由后端算（server/reasoning.py），前端仅展示，避免两边映射漂移。
   * 预览走 GET /api/models/{id}/reasoning-preview，结果按「模型|档位」缓存。
   */
  var reasonPreviewCache = {};
  var reasonPreviewBusy = {};
  function reasoningParamsPreview(model, level) {
    if (!model || !model.id) return '还没有选模型';
    var key = String(model.id) + '|' + String(level || '');
    if (Object.prototype.hasOwnProperty.call(reasonPreviewCache, key)) return reasonPreviewCache[key];
    if (!SERVER_MODE || !serverOnline) return '服务端没连上，参数以服务端实际请求为准';
    if (!reasonPreviewBusy[key]) {
      reasonPreviewBusy[key] = true;
      serverFetch('/models/' + encodeURIComponent(model.id) + '/reasoning-preview?level=' + encodeURIComponent(level || ''))
        .then(function (data) {
          reasonPreviewCache[key] = (data && data.text) ? String(data.text) : '没读到参数';
        })
        .catch(function (err) {
          reasonPreviewCache[key] = '读取失败：' + ((err && err.message) || '未知错误');
        })
        .then(function () {
          delete reasonPreviewBusy[key];
          if (sheetName === 'reasoning') {
            var keep = sheetBody.scrollTop;
            openSheet('reasoning');
            sheetBody.scrollTop = keep;
          }
        });
    }
    return '正在读取…';
  }
  function updateThinkCap() {
    var cap = document.getElementById('thinkCap');
    if (!cap) return;
    var model = currentModel();
    var supported = reasoningSupported(model);
    var level = chatReasoningLevel();
    cap.classList.toggle('is-off', !supported);
    cap.classList.toggle('is-on', supported && level !== 'off');
    cap.setAttribute('aria-pressed', String(supported && level !== 'off'));
    cap.setAttribute('aria-label', supported ? ('思考深度：' + (REASON_TEXT[level] || '关')) : '这个模型不能调思考深度');
    var lab = document.getElementById('thinkCapLevel');
    if (lab) lab.textContent = supported ? (REASON_SHORT[level] || '关') : '—';
  }
  function thinkFoldHTML(t) {
    if (!t) return '';
    var label = (t.demo ? '演示 · ' : '') + '想了 ' + esc(t.sec || 3) + ' 秒';
    return '<details class="think-fold' + (t.demo ? ' think-fold--demo' : '') + '"><summary>' + IC_BULB + label + '</summary>' +
      '<div class="think-fold__body">' + esc(t.text || '') + '</div></details>';
  }

  /* ---------- 错误分类：中文短提示，后端复用 ---------- */
  function classifyApiError(err, status) {
    if (status) {
      if (status === 401 || status === 403) return { kind: 'auth', message: 'Key 不对：这家拒绝了这次请求，检查 API Key 有没有填错。' };
      if (status === 402) return { kind: 'quota', message: '额度用完了：这家账户没有余额，充值或换一家再试。' };
      if (status === 404) return { kind: 'notfound', message: '地址或路径不对：Base URL / API 路径和这家的接口对不上。' };
      if (status === 429) return { kind: 'ratelimit', message: '请求太频繁：等一会儿再试，或换一家。' };
      if (status === 400 || status === 422) return { kind: 'badrequest', message: '请求参数不对：这家的接口不认这个模型或这些参数。' };
      if (status >= 500) return { kind: 'server', message: '服务器错误：这家暂时不稳定，过一会儿再试。' };
      return { kind: 'http', message: '连接失败：这家返回了 ' + status + '，换个地址再试。' };
    }
    if (!navigator.onLine) return { kind: 'network', message: '网络不通：这台手机现在没有连上网络。' };
    if (err && (err.name === 'AbortError' || err.code === 'timeout')) {
      return { kind: 'timeout', message: '超时了：8 秒内没连上，可能是网络慢或地址不对。' };
    }
    if (err && (err.name === 'TypeError' || err.name === 'NetworkError')) {
      return { kind: 'cors', message: '浏览器不能直接连这家，接上服务器后就能用。' };
    }
    return { kind: 'network', message: '网络不通：这台手机现在连不上这家服务器。' };
  }
  function errorKindLabel(kind) {
    var map = {
      auth: 'Key 不对', notfound: '地址或路径不对', quota: '额度用完',
      ratelimit: '请求太频繁', server: '服务器错误', timeout: '超时',
      cors: '跨域被拦', network: '网络不通', badrequest: '参数不支持', http: '连接失败'
    };
    return map[kind] || '连接失败';
  }
  function fetchWithTimeout(url, options, ms) {
    return new Promise(function (resolve, reject) {
      var ctrl = window.AbortController ? new AbortController() : null;
      var done = false;
      var timer = window.setTimeout(function () {
        if (done) return;
        done = true;
        if (ctrl) { try { ctrl.abort(); } catch (e) { /* 忽略 */ } }
        var e = new Error('timeout');
        e.name = 'AbortError';
        reject(e);
      }, ms || 8000);
      var opts = {};
      Object.keys(options || {}).forEach(function (k) { opts[k] = options[k]; });
      if (ctrl) opts.signal = ctrl.signal;
      fetch(url, opts).then(function (res) {
        if (done) return;
        done = true;
        window.clearTimeout(timer);
        resolve(res);
      }).catch(function (err) {
        if (done) return;
        done = true;
        window.clearTimeout(timer);
        reject(err);
      });
    });
  }
  function authHeaders(provider) {
    var h = {};
    var proto = protocolOf(provider);
    if (provider && provider.apiKey) {
      if (proto.id === 'anthropic') {
        h['x-api-key'] = provider.apiKey;
        h['anthropic-version'] = '2023-06-01';
        h['anthropic-dangerous-direct-browser-access'] = 'true';
      } else {
        h['Authorization'] = 'Bearer ' + provider.apiKey;
      }
    }
    return h;
  }
  function apiUrl(provider, kind) {
    var base = String(provider.baseUrl || '').replace(/\/+$/, '');
    var proto = protocolOf(provider);
    if (kind === 'models') {
      if (proto.id === 'gemini') {
        return base + '/v1beta/models' + (provider.apiKey ? '?key=' + encodeURIComponent(provider.apiKey) : '');
      }
      return base + (proto.modelsPath || '/models');
    }
    var path = provider.apiPath || proto.path || '/chat/completions';
    if (proto.id === 'gemini') {
      var modelId = (currentModel() && currentModel().modelId) || '{model}';
      path = path.split('{model}').join(modelId);
    }
    return base + path;
  }
  function maskKey(k) {
    if (!k) return '';
    if (k.length <= 8) return 'sk-••••••••';
    return k.slice(0, 3) + '••••••••' + k.slice(-4);
  }
  function nowLabel() {
    var d = new Date();
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + hm(d);
  }
  function toastA2(msg) { toast(msg); }

  /* ---------------- 聊天菜单 / 思考深度弹层 ---------------- */
  SHEETS.chatMenu = function () {
    function row(attr, icon, title, sub) {
      return '<button class="menu-row" type="button" ' + attr + '>' +
        '<span class="menu-row__icon">' + icon + '</span>' +
        '<span class="menu-row__main"><span class="menu-row__title">' + title + '</span><span class="menu-row__sub">' + sub + '</span></span>' +
        '<svg class="row-chev" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M8 5.6 12.4 10 8 14.4"/></svg></button>';
    }
    return {
      title: '聊天菜单',
      body: '<div class="menu-list">' +
        row('data-a2="preview-open"', '<svg viewBox="0 0 20 20" fill="none"><path d="M4 4.6h12v9.8H9.6L6 17.4v-3H4z"/><path d="M7 8h6M7 10.6h3.6"/></svg>', '查看这次发给模型的内容', '按真实顺序拼好的提示词预览') +
        row('data-action="remember-last"', '<svg viewBox="0 0 20 20" fill="none"><path d="M4 4.6h12v9.8H9.6L6 17.4v-3H4z"/><path d="M7 8h6M7 10.6h3.6"/></svg>', '记住这句话', '把最后一条回复收进记忆库') +
        row('data-open="presetSwitch"', '<svg viewBox="0 0 20 20" fill="none"><path d="M5.4 3.6h9.2c.8 0 1.4.6 1.4 1.4v10c0 .8-.6 1.4-1.4 1.4H5.4c-.8 0-1.4-.6-1.4-1.4V5c0-.8.6-1.4 1.4-1.4z"/><path d="M7.2 7h5.6M7.2 10h5.6M7.2 13h3.4"/></svg>', '提示词预设 · 这场文风', '换文风，或设为角色默认') +
        row('data-open="chatBook"', '<svg viewBox="0 0 20 20" fill="none"><path d="M4.4 4.6h5.2c.7 0 1.2.5 1.2 1.2v9.6H5.6c-.7 0-1.2-.5-1.2-1.2V4.6z"/><path d="M15.6 4.6h-5.2c-.7 0-1.2.5-1.2 1.2v9.6h5.2c-.7 0-1.2-.5-1.2-1.2V4.6z"/></svg>', '这场聊天的世界书', '常开与关键词') +
        row('data-open="characterSwitch"', '<svg viewBox="0 0 20 20" fill="none"><circle cx="10" cy="7" r="3.1"/><path d="M4.4 16.2c.8-3 3-4.6 5.6-4.6s4.8 1.6 5.6 4.6"/></svg>', '换个角色', '去和另一个人说话') +
        row('data-action="call"', '<svg viewBox="0 0 20 20" fill="none"><path d="M6.2 3.8 8 4.4l.8 2.6-1.5 1.4c.6 1.8 2 3.2 3.8 3.8l1.4-1.5 2.6.8.6 1.8c.2.7-.3 1.4-1 1.5-6 1-10.4-3.4-9.5-9.5.1-.7.8-1.2 1.5-1z"/></svg>', '通话', '样稿示意图，没有真的语音') +
        row('data-nav="providers"', '<svg viewBox="0 0 20 20" fill="none"><rect x="3.2" y="4.2" width="5" height="5" rx="1.4"/><rect x="11.8" y="4.2" width="5" height="5" rx="1.4"/><rect x="7.5" y="11.6" width="5" height="5" rx="1.4"/></svg>', '模型与提供商', '管理 API Key、模型与余额') +
        '</div>'
    };
  };

  SHEETS.reasoning = function () {
    var m = currentModel();
    var levels = reasoningLevels(m);
    var supported = levels.length > 0;
    var cur = chatReasoningLevel();
    var body = '<div class="reason-head"><div class="reason-head__main">' +
        '<p class="label">当前档位</p>' +
        '<p class="reason-current">' + (supported ? esc(REASON_TEXT[cur] || '关') : '不可调') + '</p>' +
        '<p class="reason-desc">并非所有模型都支持深度调整。这里改的只影响这场聊天。</p>' +
      '</div><span class="reason-bulb' + (supported ? '' : ' is-off') + '">' + IC_BULB + '</span></div>';
    if (!supported) {
      body += '<div class="test-state is-fail"><span class="test-state__dot"></span><span>这个模型不能调思考深度，请求里不会带任何思考参数。</span></div>' +
        '<p class="a2-note">换一个支持思考的模型，或者去「模型与提供商」里给这个模型改「思考方式」。</p>';
      return { title: '调整思考深度', body: body, foot: '<button class="btn" type="button" data-close>知道了</button>' };
    }
    body += '<div class="seg-slider" role="group" aria-label="思考档位">' +
      levels.map(function (lv) {
        return '<button class="seg-slider__btn' + (lv === cur ? ' is-on' : '') + '" type="button" data-a2="reason-level" data-value="' + esc(lv) + '" aria-pressed="' + (lv === cur ? 'true' : 'false') + '">' + esc(REASON_TEXT[lv]) + '</button>';
      }).join('') + '</div>';
    body += '<div class="reason-ticks"><span>更省</span><span>更稳</span><span>更深</span></div>';
    body += '<div class="reason-meta"><span class="a2-tag">' + esc(m.name) + '</span>' +
      '<span class="a2-tag">' + esc(reasonModeLabel(m.reasoning.mode)) + '</span>' +
      '<span class="a2-tag a2-tag--muted">默认 ' + esc(REASON_TEXT[reasoningDefaultLevel(m)] || '关') + '</span></div>';
    body += '<p class="sheet-label">这次请求里会带</p><div class="reason-params">' + esc(reasoningParamsPreview(m, cur)) + '</div>';
    body += '<p class="a2-note">' + esc((m.reasoning && m.reasoning.note) || '') + '</p>';
    if (reasonPending) {
      var same = reasonPending === reasoningDefaultLevel(m);
      body += '<div class="ask-card" style="margin-top:12px">' +
        '<p class="ask-card__text">' + (same
          ? '「' + esc(REASON_TEXT[reasonPending]) + '」已经是「' + esc(m.name) + '」的默认档位了。'
          : '「' + esc(REASON_TEXT[reasonPending]) + '」只改这场聊天，还是同时设为「' + esc(m.name) + '」的默认？') + '</p>' +
        '<div class="ask-actions">' +
          '<button class="btn btn--soft" type="button" data-a2="reason-dismiss">只改这场</button>' +
          '<button class="btn btn--primary" type="button" data-a2="reason-default">同时设为默认</button>' +
        '</div></div>';
    }
    return {
      title: '调整思考深度',
      body: body,
      foot: '<button class="btn" type="button" data-close>完成</button>'
    };
  };
  function selectReasoningLevel(level) {
    var m = currentModel();
    if (!reasoningSupported(m)) return;
    var chat = ensureChat(state.currentCharacterId);
    if (!chat) return;
    chat.reasoningLevel = level;
    reasonPending = level;
    save();
    updateThinkCap();
    openSheet('reasoning');
  }
  function setReasoningAsDefault() {
    var m = currentModel();
    if (!m || !reasonPending || !m.reasoning) return;
    m.reasoning.defaultLevel = reasonPending;
    save();
    var label = REASON_TEXT[reasonPending];
    reasonPending = null;
    openSheet('reasoning');
    toast('以后用「' + m.name + '」默认就是「' + label + '」。');
  }
  function dismissReasonAsk() {
    var m = currentModel();
    var label = REASON_TEXT[reasonPending] || '';
    reasonPending = null;
    openSheet('reasoning');
    toast('这场聊天用「' + label + '」，' + (m ? m.name : '模型') + ' 的默认没改。');
  }

  /* ---------------- A2 交互分发 ---------------- */
  function handleA2Action(action, el) {
    if (action === 'new-provider') { openSheet('providerTemplates'); return true; }
    if (action === 'import-provider') { var fp = document.getElementById('fileProvider'); if (fp) fp.click(); return true; }
    if (action === 'export-providers') { exportTarget = ''; openSheet('providerExport'); return true; }
    if (action === 'test-conn') { testConnection(); return true; }
    if (action === 'save-provider') { saveProvider(false); return true; }
    if (action === 'delete-provider') { deleteProvider(); return true; }
    if (action === 'copy-provider') { copyProvider(); return true; }
    if (action === 'pull-models') { startPullModels(); return true; }
    if (action === 'pull-add') { addPulledModels(); return true; }
    if (action === 'new-model') { openModelEditor('new'); return true; }
    if (action === 'save-model') { saveModelEdit(); return true; }
    if (action === 'export-run') { exportProviders(); return true; }
    if (action === 'new-preset') { createPresetDraft(); return true; }
    if (action === 'import-preset') { var fq = document.getElementById('filePreset'); if (fq) fq.click(); return true; }
    if (action === 'export-presets') { exportAllPresets(); return true; }
    if (action === 'save-preset') { savePresetDetail(); return true; }
    if (action === 'copy-preset') { copyPreset(presetDetailId); return true; }
    if (action === 'delete-preset') { deletePreset(); return true; }
    if (action === 'save-frag') { saveFrag(); return true; }
    return false;
  }

  function toggleSwitchVisual(btn) {
    var on = btn.getAttribute('aria-checked') !== 'true';
    btn.setAttribute('aria-checked', String(on));
    return on;
  }

  function handleA2Click(kind, el) {
    var id = el.getAttribute('data-id') || '';
    var value = el.getAttribute('data-value') || '';
    if (kind === 'provider-open') {
      providerDetailId = id;
      providerTab = 'config';
      var box = document.getElementById('providerScroll');
      if (box) box.scrollTop = 0;
      renderProviders();
      return;
    }
    if (kind === 'provider-tab') {
      providerTab = value;
      renderProviderDetail();
      var sc = document.getElementById('providerScroll');
      if (sc) sc.scrollTop = 0;
      return;
    }
    if (kind === 'template-pick') { createProviderFromTemplate(id); return; }
    if (kind === 'icon-pick') {
      var p = findProvider(providerDetailId);
      if (!p) return;
      p.icon = value;
      save();
      renderProviderDetail();
      return;
    }
    if (kind === 'toggle-switch') {
      var on = toggleSwitchVisual(el);
      if (el.id === 'exportKeySwitch') {
        exportIncludeKey = on;
        openSheet('providerExport');
      }
      return;
    }
    if (kind === 'key-eye') {
      if (SERVER_MODE && serverOnline) {
        toast('Key 加密保存在服务器，界面只能看到掩码；要换就在输入框里直接输入新的。');
        return;
      }
      var keyEl = document.getElementById('provKey');
      var prov = findProvider(providerDetailId);
      if (!keyEl || !prov) return;
      if (keyEl.type === 'password') {
        keyEl.type = 'text';
        keyEl.value = prov.apiKey || '';
        el.innerHTML = IC_EYE + '隐藏';
      } else {
        keyEl.type = 'password';
        keyEl.value = maskKey(prov.apiKey || '');
        el.innerHTML = IC_EYE + '显示';
      }
      return;
    }
    if (kind === 'model-edit') { openModelEditor(id); return; }
    if (kind === 'model-fav' || kind === 'mp-fav') { toggleModelFavorite(id); return; }
    if (kind === 'mp-group') {
      if (id === 'fav') mpCollapsed.fav = !mpCollapsed.fav;
      else mpCollapsed[id] = !mpCollapsed[id];
      var out = renderModelPickerHtml(mpQuery);
      var listBox = document.getElementById('mpList');
      if (listBox) listBox.innerHTML = out.html;
      var pillBox = document.getElementById('mpPills');
      if (pillBox) pillBox.innerHTML = out.pills;
      return;
    }
    if (kind === 'mp-pill') { jumpToMpGroup(id); return; }
    if (kind === 'model-pick') { selectModelA2(id); return; }
    if (kind === 'reason-level') { selectReasoningLevel(value); return; }
    if (kind === 'reason-default') { setReasoningAsDefault(); return; }
    if (kind === 'reason-dismiss') { dismissReasonAsk(); return; }
    if (kind === 'preview-open') { openPromptPreview(); return; }
    if (kind === 'bal-query') { queryBalance(id); return; }
    if (kind === 'export-provider') {
      exportTarget = id;
      openSheet('providerExport', id);
      return;
    }
    if (kind === 'pull-toggle') { togglePull(id); return; }
    if (kind === 'pull-all') { pullSelectAll(value === '1'); return; }
    if (kind === 'preset-open') {
      presetDetailId = id;
      var ps = document.getElementById('presetScroll');
      if (ps) ps.scrollTop = 0;
      renderPresets();
      return;
    }
    if (kind === 'preset-pick') { pickPresetForChat(id); return; }
    if (kind === 'preset-apply') { applyPresetBinding(value); return; }
    if (kind === 'preset-default') { setGlobalPreset(id); return; }
    if (kind === 'preset-export') { exportPreset(id); return; }
    if (kind === 'frag-open') { openFragEditor(id); return; }
    if (kind === 'frag-toggle') { toggleFrag(id); return; }
    if (kind === 'frag-new') { openFragEditor(id + ':'); return; }
    if (kind === 'frag-del') {
      openSheet('confirm', { title: '删除这条片段？', text: '删掉后它就不再参与提示词拼装。', label: '删除', run: 'delete-frag', id: id });
      return;
    }
    if (kind === 'stats-range') { setStatsRange(value); return; }
    if (kind === 'stats-metric') { setStatsMetric(value); return; }
    if (kind === 'rank-tab') { setRankTab(value); return; }
  }

  function handleA2Back(view) {
    if (view === 'providers') {
      if (providerDetailId) { providerDetailId = ''; providerTab = 'config'; renderProviders(); }
      else navTo('me');
      return;
    }
    if (view === 'presets') {
      if (presetDetailId) { presetDetailId = ''; renderPresets(); }
      else navTo('me');
    }
  }

  /* 确认弹层里的 A2 删除动作 */
  function runConfirmA2(kind, id) {
    if (kind === 'delete-provider') {
      var p = findProvider(id);
      if (!p) return true;
      var removedModels = (p.models || []).slice();
      state.providers = state.providers.filter(function (x) { return x.id !== id; });
      state.models = state.models.filter(function (m) { return m.providerId !== id; });
      if (removedModels.indexOf(state.modelId) !== -1) {
        var first = state.models[0];
        state.modelId = first ? first.id : '';
      }
      if (providerDetailId === id) providerDetailId = '';
      save();
      renderProviders();
      renderMe();
      updateChatHeader();
      closeSheet();
      toast('已经删掉这家提供商。');
      return true;
    }
    if (kind === 'delete-preset') {
      var pr = findPreset(id);
      if (!pr) return true;
      state.promptPresets = state.promptPresets.filter(function (x) { return x.id !== id; });
      state.characters.forEach(function (c) { if (c.defaultPresetId === id) c.defaultPresetId = ''; });
      Object.keys(state.chats).forEach(function (cid) { if (state.chats[cid].presetId === id) state.chats[cid].presetId = ''; });
      if (state.settings.defaultPresetId === id && state.promptPresets.length) {
        state.settings.defaultPresetId = state.promptPresets[0].id;
      }
      if (presetDetailId === id) presetDetailId = '';
      save();
      renderPresets();
      renderChatContext();
      renderMe();
      closeSheet();
      toast('已经删掉这个预设。');
      return true;
    }
    if (kind === 'delete-frag') {
      deleteFrag(id);
      return true;
    }
    return false;
  }

  /* ---------------- 启动 ---------------- */
  var clockTimer = null;
  function tickClock() {
    var now = new Date();
    var st = $('#statusTime');
    if (st) st.textContent = hm(now);
    var nowDate = $('#nowDate');
    if (nowDate) nowDate.textContent = monthDay(now) + ' ' + hm(now);
    tickHomeClock(now);
    var greet = $('#homeGreeting');
    if (greet) greet.textContent = greetingText(now);
  }

  /* 时钟用 rAF，离开首页或页面隐藏时立即停 */
  var homeClockRaf = null;
  var lastSecond = -1;
  function homeClockLoop() {
    homeClockRaf = null;
    if (currentView !== 'home' || document.hidden) return;
    var now = new Date();
    if (now.getSeconds() !== lastSecond) {
      lastSecond = now.getSeconds();
      tickHomeClock(now);
    }
    homeClockRaf = requestAnimationFrame(homeClockLoop);
  }
  function startHomeClock() {
    if (!homeClockRaf && currentView === 'home' && !document.hidden) {
      homeClockRaf = requestAnimationFrame(homeClockLoop);
    }
  }
  function stopHomeClock() {
    if (homeClockRaf) { cancelAnimationFrame(homeClockRaf); homeClockRaf = null; }
  }

  function detectPerfLite() {
    var lite = false;
    try {
      var mem = navigator.deviceMemory || 8;
      var cores = navigator.hardwareConcurrency || 8;
      lite = mem <= 4 || cores <= 4;
      if (window.matchMedia && window.matchMedia('(prefers-reduced-transparency: reduce)').matches) lite = true;
    } catch (e) { /* 忽略 */ }
    document.documentElement.classList.toggle('perf-lite', lite);
  }

  var appStarted = false;

  function startApplication() {
    if (appStarted) { renderAfterServerRefresh(); return; }
    appStarted = true;
    applyChatFont(state.settings.chatFont, { save: false });
    applyTheme(state.theme);
    tickClock();
    var entered = false;
    try { entered = sessionStorage.getItem(SESSION_KEY) === '1'; } catch (e) { entered = false; }
    var start = 'home';
    if (!state.settings.splashAlways && entered) start = 'chat';
    go(start);
    startHomeClock();

    /* 先出壳，再在下一帧填数据，避免首屏阻塞 */
    requestAnimationFrame(function () {
      var chat = ensureChat(state.currentCharacterId);
      chatMessages = chat ? chat.messages : [];
      renderChat();
      updateChatHeader();
      renderMemories();
      renderListen();
      renderMe();
      renderHome();
      renderSettings();
      renderLibraries();
      paintAllAvatars();
      if (start === 'chat') scrollChatBottom(false);
    });

    if (state.settings.splashAlways) {
      try { sessionStorage.removeItem(SESSION_KEY); } catch (e) { /* 忽略 */ }
    }
  }

  function bootLocalFallback(reason) {
    serverOnline = false;
    normalizeCollections();
    startApplication();
    if (reason) toast(reason);
  }

  function bindServerUi() {
    var input = $('#loginPass');
    if (input) input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); submitLogin(); }
    });
    var btn = $('#loginBtn');
    if (btn) btn.addEventListener('click', submitLogin);
  }

  function loadServerApp() {
    return serverFetch('/bootstrap').then(function (boot) {
      serverInfo = boot.server || {};
      authRequired = !!serverInfo.authRequired;
      devMode = !!serverInfo.devMode;
      usageSummary = boot.usage || null;
      serverOnline = true;
      applyServerState(boot.state);
      hideLogin();
      startApplication();
      if (appStarted) renderAfterServerRefresh();
      if (devMode) {
        console.warn('开发模式：没有设置 APP_PASSWORD，本机任何程序都能访问这个服务。仅限本地开发使用。');
      }
      if (serverInfo.mockModel) toast('后端在演示模型模式（MSYQ_MOCK=1）：回复由本机生成，不请求外部接口。');
      offerMigration();
      return true;
    });
  }

  function bootServer() {
    serverFetch('/auth/me').then(function (me) {
      authRequired = !!me.authRequired;
      devMode = !!me.devMode;
      if (authRequired && !me.authenticated) {
        serverOnline = false;
        showLogin();
        return null;
      }
      return loadServerApp();
    }).catch(function (err) {
      bootLocalFallback('连不上本机后端，先用这台浏览器里的缓存：' + (err.message || ''));
    });
  }

  function boot() {
    detectPerfLite();
    tickClock();
    clockTimer = setInterval(tickClock, 30000);
    bindEvents();
    bindServerUi();

    if (SERVER_MODE) {
      bootServer();
    } else {
      serverOnline = false;
      startApplication();
    }

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { stopHomeClock(); tickClock(); }
      else { tickClock(); startHomeClock(); }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
