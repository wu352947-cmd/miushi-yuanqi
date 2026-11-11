/* 提供商：模板 / 拉取模型 / 测试连接 / 余额 / 模型编辑 / 导入导出 / 模型选择弹层。
 *
 * 从 src/app.js 的五个分节整块拆出。块内的 PULL_DEMO / modelDraft / LEVEL_PRESETS
 * 都是字面量或 null 初始化，无函数调用、块外零引用，所以搬到这里（IIFE 最前面）
 * 不影响任何行为。六个 SHEETS.xxx 赋值依赖 app.js 顶部先声明 var SHEETS = {}。
 */

  /* ---------------- 模板 / 拉取模型 ---------------- */
  SHEETS.providerTemplates = function () {
    var rows = (DATA.providerTemplates || []).map(function (t) {
      return '<button class="option" type="button" data-a2="template-pick" data-id="' + esc(t.key) + '">' +
        iconHTMLByKey(t.icon, t.name, 'p-icon--sm') +
        '<span class="option__main"><span class="option__title">' + esc(t.name) + '</span>' +
          '<span class="option__desc">' + esc(t.baseUrl) + ' · ' + esc(t.note || '') + '</span></span>' +
        '<span class="option__source">' + esc(protocolName(t.protocol)) + '</span></button>';
    }).join('');
    return {
      title: '添加提供商',
      body: '<p class="sheet-label">选一个模板，会自动填好 Base URL 和路径</p>' +
        '<div class="option-list">' + rows + '</div>' +
        '<p class="sheet-note">模板只是起点，建好后可以改协议、路径、图标和模型。</p>'
    };
  };

  var PULL_DEMO = {
    deepseek: ['deepseek-flash', 'deepseek-v4-pro'],
    openai: ['gpt-6.1-sol', 'gpt-6-luna', 'gpt-6-astra', 'gpt-6.1-terra'],
    openai_responses: ['gpt-6.1-sol', 'gpt-6-luna', 'gpt-6-astra'],
    anthropic: ['claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-5', 'claude-opus-5-5'],
    gemini: ['gemini-3.8-flash', 'gemini-4-argon', 'gemini-3.5-flash-lite'],
    openrouter: ['openai/gpt-6.1-sol', 'anthropic/claude-sonnet-5.5', 'moonshotai/kimi-k3', 'x-ai/grok-4.7'],
    siliconcloud: ['deepseek-ai/DeepSeek-V4', 'Qwen/Qwen3-235B-A22B', 'zai-org/GLM-5.2']
  };
  function demoModelIds(protocolId) {
    return (PULL_DEMO[protocolId] || PULL_DEMO.openai).slice();
  }
  function parseModelIds(json) {
    var out = [];
    function push(v) {
      if (!v) return;
      var s = String(v).replace(/^models\//, '');
      if (s && out.indexOf(s) === -1) out.push(s);
    }
    if (Array.isArray(json)) json.forEach(function (it) { push(typeof it === 'string' ? it : (it.id || it.name)); });
    if (json && Array.isArray(json.data)) json.data.forEach(function (it) { push(typeof it === 'string' ? it : (it.id || it.name)); });
    if (json && Array.isArray(json.models)) json.models.forEach(function (it) { push(typeof it === 'string' ? it : (it.name || it.id)); });
    return out.slice(0, 200);
  }
  function modelIdExists(providerId, modelId) {
    return state.models.some(function (m) { return m.providerId === providerId && m.modelId === modelId; });
  }
  function startPullModels() {
    var p = findProvider(providerDetailId);
    if (!p) return;
    collectProviderForm(p);
    var guessedUrl = String(p.baseUrl || '').replace(/\/+$/, '') + (protocolOf(p).modelsPath || '/models');
    pullState = { providerId: p.id, url: guessedUrl, loading: true, items: [], selected: {}, error: '', demo: false };
    openSheet('pullModels');
    pullState.startedAt = Date.now();
    if (SERVER_MODE && serverOnline) {
      var saved = pendingProviderKey;
      var chain = Promise.resolve();
      if (saved) {
        pendingProviderKey = null;
        chain = serverFetch('/providers/' + encodeURIComponent(p.id) + '/key', { method: 'POST', body: { apiKey: saved } }).then(function () {
          p.hasKey = true;
        });
      }
      chain.then(function () {
        save();
        return serverFetch('/providers/' + encodeURIComponent(p.id) + '/pull-models', { method: 'POST' });
      }).then(function (data) {
        pullState.loading = false;
        pullState.url = data.url || pullState.url;
        if (!data.ok) {
          pullState.error = data.message || '拉取失败，检查地址与 Key。';
          pullState.items = [];
        } else {
          pullState.ids = data.ids || [];
          pullState.items = pullState.ids;
          pullState.items.forEach(function (id) { if (!modelIdExists(p.id, id)) pullState.selected[id] = true; });
        }
        refreshPullSheet();
      }).catch(function (err) {
        pullState.loading = false;
        pullState.error = err.message || '拉取失败，检查地址与 Key。';
        pullState.items = [];
        refreshPullSheet();
      });
      return;
    }
    fetchWithTimeout(guessedUrl, { method: 'GET', headers: authHeaders(p) }, 8000).then(function (res) {
      if (!res.ok) { var e = new Error('http'); e.status = res.status; throw e; }
      return res.json();
    }).then(function (json) {
      var ids = parseModelIds(json);
      if (!ids.length) { var e2 = new Error('empty'); e2.name = 'EmptyList'; throw e2; }
      pullState.loading = false;
      pullState.items = ids;
      ids.forEach(function (id) { if (!modelIdExists(p.id, id)) pullState.selected[id] = true; });
      refreshPullSheet();
    }).catch(function (err) {
      var c = err && err.name === 'EmptyList'
        ? { kind: 'empty', message: '这家没有返回模型列表：地址或 Key 可能不对。' }
        : classifyApiError(err, err && err.status);
      pullState.loading = false;
      pullState.demo = true;
      pullState.error = c.message;
      pullState.items = demoModelIds(protocolOf(p).id);
      pullState.items.forEach(function (id) { if (!modelIdExists(p.id, id)) pullState.selected[id] = true; });
      refreshPullSheet();
    });
  }
  function refreshPullSheet() {
    if (sheetName !== 'pullModels') return;
    var top = sheetBody ? sheetBody.scrollTop : 0;
    openSheet('pullModels');
    if (sheetBody) sheetBody.scrollTop = top;
  }
  SHEETS.pullModels = function () {
    if (!pullState) return null;
    var body;
    if (pullState.loading) {
      body = '<div class="test-state is-wait"><span class="test-state__dot"></span><span>正在拉取模型…最多等 8 秒</span></div>' +
        '<p class="test-detail">GET ' + esc(pullState.url) + '</p>';
    } else {
      body = '';
      if (pullState.error) {
        body += '<div class="a2-banner a2-banner--warn">' + IC_INFO_A2 +
          '<span>' + esc(pullState.error) + (pullState.demo ? ' 下面先放一份示例列表给你勾选。' : '') + '</span></div>';
      } else {
        body += '<div class="test-state is-ok"><span class="test-state__dot"></span><span>拉回了 ' + pullState.items.length + ' 个模型，勾选要加入的。</span></div>';
      }
      var count = 0;
      Object.keys(pullState.selected).forEach(function (k) { if (pullState.selected[k]) count += 1; });
      var rows = pullState.items.map(function (id) {
        var on = !!pullState.selected[id];
        var exist = modelIdExists(pullState.providerId, id);
        return '<button class="pull-row' + (on ? ' is-on' : '') + '" type="button" data-a2="pull-toggle" data-id="' + esc(id) + '" aria-pressed="' + (on ? 'true' : 'false') + '">' +
          '<span class="pull-row__box"><svg viewBox="0 0 12 12" fill="none"><path d="m2.4 6.1 2.1 2.1 4.9-5.2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>' +
          iconHTMLByKey(matchIconKey(id) || '', id, 'p-icon--sm') +
          '<span class="pull-row__main"><span class="pull-row__name">' + esc(prettyModelName(id)) + '</span>' +
            '<span class="pull-row__id">' + esc(id) + (exist ? ' · 已在列表' : '') + '</span></span>' +
        '</button>';
      }).join('');
      body += '<div class="pull-all"><span class="label">共 ' + pullState.items.length + ' 个 · 已选 ' + count + '</span>' +
        '<span><button class="text-btn" type="button" data-a2="pull-all" data-value="1">全选</button> ' +
        '<button class="text-btn" type="button" data-a2="pull-all" data-value="0">清空</button></span></div>' +
        '<div class="model-list">' + rows + '</div>';
    }
    return {
      title: pullState.loading ? '拉取模型' : (pullState.demo ? '拉取模型 · 示例' : '拉取模型'),
      body: body + '<p class="a2-note">' + (SERVER_MODE && serverOnline ? '请求由本机后端发出，浏览器不拿 Key；失败时只给中文原因。' : '离线模式：浏览器直连中转站多半会被跨域拦，拉不到时会放一份示例列表。') + '</p>',
      foot: pullState.loading
        ? '<button class="btn" type="button" data-close>取消</button>'
        : '<button class="btn" type="button" data-close>取消</button>' +
          '<button class="btn btn--primary" type="button" data-action="pull-add">加入所选</button>'
    };
  };
  function togglePull(id) {
    if (!pullState) return;
    pullState.selected[id] = !pullState.selected[id];
    refreshPullSheet();
  }
  function pullSelectAll(on) {
    if (!pullState) return;
    pullState.items.forEach(function (id) { pullState.selected[id] = !!on; });
    refreshPullSheet();
  }
  function addPulledModels() {
    if (!pullState) return;
    var p = findProvider(pullState.providerId);
    if (!p) return;
    if (!p.models) p.models = [];
    var added = 0;
    pullState.items.forEach(function (id) {
      if (!pullState.selected[id]) return;
      if (modelIdExists(p.id, id)) return;
      var m = newModelFromId(p.id, id);
      state.models.push(m);
      p.models.push(m.id);
      added += 1;
    });
    save();
    closeSheet();
    if (providerDetailId) { providerTab = 'models'; renderProviderDetail(); }
    renderMe();
    toast(added ? ('加入了 ' + added + ' 个模型。') : '没有新的模型要加入。');
  }

  function prettyModelName(modelId) {
    var s = String(modelId || '未命名').replace(/^models\//, '');
    var last = s.split('/').pop();
    var brand = '';
    if (/^gpt/i.test(last)) {
      brand = 'GPT-' + last.replace(/^gpt[-_]?/i, '');
    } else if (/^o[134]/i.test(last)) {
      brand = last.replace(/_/g, '-');
    } else if (/^claude/i.test(last)) {
      brand = 'Claude ' + last.replace(/^claude[-_]?/i, '').split('-').map(function (w) { return w.charAt(0).toUpperCase() + w.slice(1); }).join(' ');
    } else if (/^gemini/i.test(last)) {
      brand = 'Gemini ' + last.replace(/^gemini[-_]?/i, '').replace(/-/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
    } else if (/^deepseek/i.test(last)) {
      brand = 'DeepSeek ' + last.replace(/^deepseek[-_]?/i, '').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
    } else if (/^qwen/i.test(last) || /^qwq/i.test(last)) {
      brand = 'Qwen ' + last.replace(/^qwen[-_]?/i, '').replace(/-/g, ' ').toUpperCase();
    } else if (/^kimi/i.test(last)) {
      brand = 'Kimi ' + last.replace(/^kimi[-_]?/i, '').replace(/-/g, ' ').toUpperCase();
    } else {
      brand = last.replace(/[-_]/g, ' ');
    }
    brand = brand.replace(/\s+/g, ' ').trim();
    if (brand === 'GPT-') brand = 'GPT';
    return brand;
  }
  function defaultReasoningFor(modelId) {
    var s = String(modelId || '').toLowerCase();
    if (s.indexOf('claude') !== -1) {
      return { mode: 'anthropic_effort', levels: ['off', 'auto', 'low', 'medium', 'high', 'xhigh', 'max'], defaultLevel: 'high', offMode: 'disabled', note: 'Anthropic output_config.effort（5.x）' };
    }
    if (s.indexOf('gemini-2.5') !== -1) {
      return { mode: 'gemini_budget', levels: ['off', 'auto', 'low', 'medium', 'high'], defaultLevel: 'auto', note: '2.5 用 thinkingBudget' };
    }
    if (s.indexOf('gemini') !== -1) {
      return { mode: 'gemini_level', levels: ['auto', 'low', 'medium', 'high'], defaultLevel: 'auto', supportsMinimal: /flash-lite|3\.6|3\.5-flash/.test(s), note: 'Gemini 3+ 用 thinkingLevel' };
    }
    if (s.indexOf('deepseek') !== -1) {
      return { mode: 'deepseek', levels: ['off', 'low', 'high', 'max'], defaultLevel: 'high', note: 'DeepSeek thinking + reasoning_effort' };
    }
    if (s.indexOf('grok') !== -1) {
      return { mode: 'xai', levels: /4\.5/.test(s) ? ['auto', 'low', 'medium', 'high'] : ['auto', 'low', 'medium', 'high', 'xhigh'], defaultLevel: 'high', note: 'grok 推理模型用 reasoning_effort，不能关闭' };
    }
    if (s.indexOf('kimi') !== -1) {
      return s.indexOf('k2') !== -1
        ? { mode: 'kimi', levels: ['off', 'on'], defaultLevel: 'on', note: 'K2 系用 thinking 开关' }
        : { mode: 'kimi', levels: ['auto', 'low', 'high', 'max'], defaultLevel: 'max', note: 'Kimi K3 reasoning_effort，不能关闭' };
    }
    if (s.indexOf('glm') !== -1) {
      return { mode: 'zhipu', levels: ['low', 'high', 'max'], defaultLevel: 'max', note: 'GLM 默认 max，不能关闭' };
    }
    if (s.indexOf('qwen') !== -1 || s.indexOf('qwq') !== -1) {
      return { mode: 'qwen_thinking', levels: ['off', 'auto', 'low', 'medium', 'high'], defaultLevel: 'auto', note: '通义千问 enable_thinking' };
    }
    if (s.indexOf('doubao') !== -1 || s.indexOf('seed') !== -1) {
      return { mode: 'ark', levels: ['off', 'auto', 'low', 'medium', 'high'], defaultLevel: 'auto', note: '豆包 thinking / reasoning_effort' };
    }
    if (/^gpt-6/.test(s) || s.indexOf('gpt-6') !== -1) {
      var noOff = /astra|sol/.test(s);
      return { mode: 'openai_effort', levels: noOff ? ['low', 'medium', 'high', 'xhigh', 'max'] : ['off', 'auto', 'low', 'medium', 'high', 'xhigh', 'max'], defaultLevel: 'medium', note: 'OpenAI reasoning effort' };
    }
    if (/^gpt-5/.test(s)) {
      return { mode: 'openai_effort', levels: ['off', 'auto', 'low', 'medium', 'high'], defaultLevel: 'auto', note: 'gpt-5：off 映射 minimal' };
    }
    return { mode: 'none', levels: [], defaultLevel: 'off', note: '未识别的模型：默认不带思考参数（只保留自动）' };
  }
  function newModelFromId(providerId, modelId) {
    var reasoning = defaultReasoningFor(modelId);
    return {
      id: newId('model'), providerId: providerId, name: prettyModelName(modelId), modelId: modelId,
      icon: matchIconKey(modelId), caps: {
        vision: /(vision|vl-|4o|gemini|claude)/i.test(modelId),
        tools: true,
        reasoning: reasoning.mode !== 'none'
      },
      context: 128000, favorite: false, source: 'pulled', price: null, reasoning: reasoning
    };
  }

  /* ---------------- 测试连接 / 余额 ---------------- */
  SHEETS.connTest = function () {
    return {
      title: '测试连接',
      body: '<div class="test-state is-wait" id="connResult"><span class="test-state__dot"></span>' +
          '<span id="connResultText">正在连接…最多等 8 秒</span></div>' +
        '<p class="test-detail" id="connResultDetail"></p>' +
        '<p class="a2-note">先真的发一次请求。失败时按原因给短中文提示，不会弹英文原始报错，也不会卡住。</p>',
      foot: '<button class="btn" type="button" data-close>关闭</button>'
    };
  };
  function setConnResult(kind, msg, detail) {
    var box = document.getElementById('connResult');
    if (!box) return;
    box.className = 'test-state ' + (kind === 'ok' ? 'is-ok' : kind === 'wait' ? 'is-wait' : 'is-fail');
    var text = document.getElementById('connResultText');
    if (text) text.textContent = msg;
    var det = document.getElementById('connResultDetail');
    if (det) det.textContent = detail || '';
  }
  function testConnection() {
    var p = findProvider(providerDetailId);
    if (!p) return;
    if (typeof d2OpenTestConnection === 'function') { d2OpenTestConnection(); return; }
    collectProviderForm(p);
    openSheet('connTest');
    if (SERVER_MODE && serverOnline) {
      setConnResult('wait', '正在让服务器替你去连…最多等 8 秒', '请求由后端发出，界面不显示 Key');
      var saved = pendingProviderKey;
      var chain = Promise.resolve();
      if (saved) {
        pendingProviderKey = null;
        chain = serverFetch('/providers/' + encodeURIComponent(p.id) + '/key', { method: 'POST', body: { apiKey: saved } }).then(function () {
          p.hasKey = true;
        });
      }
      chain.then(function () {
        save();
        return serverFetch('/providers/' + encodeURIComponent(p.id) + '/test', { method: 'POST' });
      }).then(function (data) {
        var detail = (data.url || '') + (data.status ? ' · HTTP ' + data.status : '') + (data.ms ? ' · ' + data.ms + 'ms' : '');
        setConnResult(data.ok ? 'ok' : 'fail', data.message || (data.ok ? '连上了。' : '没连上。'), detail);
      }).catch(function (err) {
        setConnResult('fail', err.message || '没连上。', '分类：' + errorKindLabel(err.kind || 'network'));
      });
      return;
    }
    var target = apiUrl(p, 'models');
    var t0 = Date.now();
    fetchWithTimeout(target, { method: 'GET', headers: authHeaders(p) }, 8000).then(function (res) {
      var ms = Date.now() - t0;
      if (!res.ok) {
        var c = classifyApiError(null, res.status);
        setConnResult('fail', c.message, 'HTTP ' + res.status + ' · ' + ms + 'ms · ' + target);
        return;
      }
      return res.text().then(function () {
        setConnResult('ok', '连上了：这家能正常响应。', 'HTTP ' + res.status + ' · ' + ms + 'ms · ' + target);
      });
    }).catch(function (err) {
      var c = classifyApiError(err, null);
      setConnResult('fail', c.message, '分类：' + errorKindLabel(c.kind) + ' · ' + target);
    });
  }
  function queryBalance(providerId, silent) {
    var p = findProvider(providerId);
    if (!p) return;
    var proto = protocolOf(p);
    if (!proto.balance) { if (!silent) toast('这家不支持查询余额。'); return; }
    if (!providerHasKey(p)) { if (!silent) toast('先填 API Key，再查余额。'); return; }
    if (SERVER_MODE && serverOnline) {
      serverFetch('/providers/' + encodeURIComponent(providerId) + '/balance', { method: 'POST' }).then(function (data) {
        p.balance = {
          supported: data.supported !== false,
          amount: data.amount,
          currency: data.currency || '¥',
          at: data.at || '',
          failed: !!data.failed,
          failKind: data.failKind || ''
        };
        save();
        refreshAfterBalance();
        if (!silent) toast(data.amount === null || data.amount === undefined ? '余额暂不可查。' : '余额已更新。');
      }).catch(function () {
        p.balance = { supported: true, amount: null, currency: (p.balance && p.balance.currency) || '¥', at: '', failed: true, failKind: 'network' };
        save();
        refreshAfterBalance();
        if (!silent) toast('余额暂不可查。');
      });
      return;
    }
    var url = String(p.baseUrl || '').replace(/\/+$/, '') + (proto.balancePath || '');
    fetchWithTimeout(url, { method: 'GET', headers: authHeaders(p) }, 8000).then(function (res) {
      if (!res.ok) { var e = new Error('http'); e.status = res.status; throw e; }
      return res.json();
    }).then(function (json) {
      var amount = null;
      var currency = '¥';
      if (p.protocol === 'deepseek') {
        var info = (json.balance_infos || [])[0] || {};
        amount = parseFloat(info.total_balance);
        currency = (info.currency === 'USD') ? '$' : '¥';
      } else if (p.protocol === 'openrouter') {
        var total = parseFloat(json.data && json.data.total_credits);
        var used = parseFloat(json.data && json.data.total_usage);
        amount = total - (isNaN(used) ? 0 : used);
        currency = '$';
      }
      if (amount === null || isNaN(amount)) throw new Error('parse');
      p.balance = { supported: true, amount: amount, currency: currency, at: nowLabel() };
      save();
      refreshAfterBalance();
      if (!silent) toast('余额已更新。');
    }).catch(function (err) {
      var c = classifyApiError(err, err && err.status);
      p.balance = { supported: true, amount: null, currency: (p.balance && p.balance.currency) || '¥', at: '', failed: true, failKind: c.kind };
      save();
      refreshAfterBalance();
      if (!silent) toast('余额暂不可查。');
    });
  }
  function refreshAfterBalance() {
    if (providerDetailId && currentView === 'providers') renderProviderDetail();
    if (currentView === 'stats') renderStats();
  }

  /* ---------------- 模型编辑 ---------------- */
  var modelDraft = null;
  var LEVEL_PRESETS = [
    { id: 'none', levels: [] },
    { id: 'onoff', levels: ['off', 'on'] },
    { id: 'four', levels: ['off', 'auto', 'low', 'high'] },
    { id: 'five', levels: ['off', 'auto', 'low', 'medium', 'high'] },
    { id: 'six', levels: ['off', 'auto', 'low', 'medium', 'high', 'max'] },
    { id: 'seven', levels: ['off', 'auto', 'low', 'medium', 'high', 'xhigh', 'max'] },
    { id: 'effort', levels: ['low', 'medium', 'high', 'xhigh', 'max'] }
  ];
  function matchLevelPreset(levels) {
    var key = (levels || []).join(',');
    for (var i = 0; i < LEVEL_PRESETS.length; i++) if (LEVEL_PRESETS[i].levels.join(',') === key) return LEVEL_PRESETS[i].id;
    return 'five';
  }
  function openModelEditor(payload) {
    if (payload === 'new') {
      modelDraft = {
        id: newId('model'), providerId: providerDetailId, name: '', modelId: '', icon: '',
        caps: { vision: false, tools: true, reasoning: true }, context: 128000, favorite: false,
        source: 'user', price: null,
        reasoning: defaultReasoningFor('')
      };
    } else {
      var m = findModel(payload);
      if (!m) return;
      modelDraft = clone(m);
    }
    openSheet('modelEdit');
  }
  SHEETS.modelEdit = function () {
    if (!modelDraft) return null;
    var m = modelDraft;
    var r = m.reasoning || { mode: 'none', levels: [] };
    var levelPreset = matchLevelPreset(r.levels);
    var price = m.price || {};
    var modeOptions = REASON_MODES.map(function (mode) {
      return '<option value="' + mode.id + '"' + (mode.id === r.mode ? ' selected' : '') + '>' + esc(mode.label) + '</option>';
    }).join('');
    var levelOptions = LEVEL_PRESETS.map(function (p) {
      return '<option value="' + p.id + '"' + (p.id === levelPreset ? ' selected' : '') + '>' + esc(levelPresetLabel(p)) + '</option>';
    }).join('');
    var defaultOptions = ['off', 'auto', 'low', 'medium', 'high', 'max', 'on'].map(function (lv) {
      return '<option value="' + lv + '"' + (lv === (r.defaultLevel || 'off') ? ' selected' : '') + '>' + esc(REASON_TEXT[lv]) + '</option>';
    }).join('');
    var provider = findProvider(m.providerId);
    return {
      title: m.modelId ? '编辑模型' : '添加新模型',
      body:
        '<div class="bind-mini">' + modelIconHTML(m, 'p-icon--sm') +
          '<span class="bind-mini__main"><span class="bind-mini__label">属于</span><span class="bind-mini__value">' + esc(provider ? provider.name : '未指定') + '</span></span></div>' +
        '<label class="field-label" for="mName">显示名</label>' +
        '<input class="field field--title" id="mName" type="text" value="' + esc(m.name) + '" placeholder="例如：白露 · 慢">' +
        '<label class="field-label" for="mModelId">模型 ID</label>' +
        '<input class="field" id="mModelId" type="text" value="' + esc(m.modelId) + '" placeholder="例如：deepseek-chat">' +
        '<p class="sheet-label">能力</p>' +
        '<div class="form-card a2-card" style="padding:4px 14px">' +
          a2SwitchRow('mCapVision', '视觉', '能读图片', m.caps && m.caps.vision) +
          a2SwitchRow('mCapTools', '工具调用', '能调用工具 / 函数', m.caps && m.caps.tools) +
          a2SwitchRow('mCapReasoning', '思考', '回复里可以带思考过程', m.caps && m.caps.reasoning) +
        '</div>' +
        '<label class="field-label" for="mContext">上下文长度（token）</label>' +
        '<input class="field" id="mContext" type="number" inputmode="numeric" value="' + esc(m.context || 128000) + '">' +
        '<p class="sheet-label">思考档位怎么翻译</p>' +
        '<label class="field-label" for="mReasonMode">思考方式</label>' +
        '<select class="field" id="mReasonMode">' + modeOptions + '</select>' +
        '<label class="field-label" for="mLevelPreset">支持的档位</label>' +
        '<select class="field" id="mLevelPreset">' + levelOptions + '</select>' +
        '<label class="field-label" for="mDefault">默认档位</label>' +
        '<select class="field" id="mDefault">' + defaultOptions + '</select>' +
        '<label class="field-label" for="mSuffixHigh">中转站高档模型 ID（仅「用模型名区分档位」时需要）</label>' +
        '<input class="field" id="mSuffixHigh" type="text" value="' + esc(r.map && r.map.high && r.map.high !== m.modelId ? r.map.high : '') + '" placeholder="例如：bailu-slow-thinking">' +
        '<p class="sheet-label">单价 · 每百万 token（可留空）</p>' +
        '<div class="form-card a2-card" style="padding:4px 14px">' +
          '<div class="form-row"><span class="form-row__label">输入</span><div class="form-row__main"><input class="field" id="mPriceIn" type="number" inputmode="decimal" value="' + (price.input !== undefined && price.input !== null ? esc(price.input) : '') + '" placeholder="不设置"></div></div>' +
          '<div class="form-row"><span class="form-row__label">缓存命中</span><div class="form-row__main"><input class="field" id="mPriceCache" type="number" inputmode="decimal" value="' + (price.cache !== undefined && price.cache !== null ? esc(price.cache) : '') + '" placeholder="不设置"></div></div>' +
          '<div class="form-row"><span class="form-row__label">输出</span><div class="form-row__main"><input class="field" id="mPriceOut" type="number" inputmode="decimal" value="' + (price.output !== undefined && price.output !== null ? esc(price.output) : '') + '" placeholder="不设置"></div></div>' +
          '<div class="form-row"><span class="form-row__label">币种</span><div class="form-row__main"><select class="field" id="mCurrency"><option value="¥"' + ((price.currency || '¥') === '¥' ? ' selected' : '') + '>¥ 人民币</option><option value="$"' + (price.currency === '$' ? ' selected' : '') + '>$ 美元</option></select></div></div>' +
          a2SwitchRow('mNoPrice', '不设置单价', '统计页会显示「未设单价」，不计入花费', !m.price) +
        '</div>' +
        a2SwitchRow('mFav', '收藏', '收藏后出现在模型弹层最上面的「收藏」分组', !!m.favorite),
      foot: '<button class="btn" type="button" data-close>取消</button>' +
        '<button class="btn btn--primary" type="button" data-action="save-model">保存模型</button>'
    };
  };
  function levelPresetLabel(p) {
    if (!p.levels.length) return '不能调';
    return p.levels.map(function (lv) { return REASON_TEXT[lv]; }).join(' / ');
  }
  function saveModelEdit() {
    var m = modelDraft;
    if (!m) return;
    var el;
    el = document.getElementById('mName'); if (el && el.value.trim()) m.name = el.value.trim();
    el = document.getElementById('mModelId'); if (el && el.value.trim()) m.modelId = el.value.trim();
    if (!m.modelId) m.modelId = m.name || 'unnamed-model';
    if (!m.name) m.name = prettyModelName(m.modelId);
    el = document.getElementById('mContext'); if (el && el.value) m.context = Math.max(1024, parseInt(el.value, 10) || 128000);
    m.caps = {
      vision: document.getElementById('mCapVision') && document.getElementById('mCapVision').getAttribute('aria-checked') === 'true',
      tools: document.getElementById('mCapTools') && document.getElementById('mCapTools').getAttribute('aria-checked') === 'true',
      reasoning: document.getElementById('mCapReasoning') && document.getElementById('mCapReasoning').getAttribute('aria-checked') === 'true'
    };
    var mode = document.getElementById('mReasonMode') ? document.getElementById('mReasonMode').value : 'none';
    var levelPreset = document.getElementById('mLevelPreset') ? document.getElementById('mLevelPreset').value : 'none';
    var levels = [];
    LEVEL_PRESETS.forEach(function (p) { if (p.id === levelPreset) levels = p.levels.slice(); });
    if (mode === 'none') levels = [];
    if (mode === 'deepseek' && levels.join(',') !== 'off,on') levels = ['off', 'on'];
    var def = document.getElementById('mDefault') ? document.getElementById('mDefault').value : 'off';
    if (!levels.length) def = 'off';
    else if (levels.indexOf(def) === -1) def = levels[0];
    var suffix = document.getElementById('mSuffixHigh') ? document.getElementById('mSuffixHigh').value.trim() : '';
    m.reasoning = { mode: mode, levels: levels, defaultLevel: def, note: reasoningNoteFor(mode, m.modelId, suffix) };
    if (mode === 'relay_suffix') {
      m.reasoning.map = { off: m.modelId, low: m.modelId, high: suffix || (m.modelId + '-thinking') };
    }
    var noPrice = document.getElementById('mNoPrice') && document.getElementById('mNoPrice').getAttribute('aria-checked') === 'true';
    if (noPrice) {
      m.price = null;
    } else {
      var pin = parseFloat((document.getElementById('mPriceIn') || {}).value);
      var pcache = parseFloat((document.getElementById('mPriceCache') || {}).value);
      var pout = parseFloat((document.getElementById('mPriceOut') || {}).value);
      if (isNaN(pin) && isNaN(pcache) && isNaN(pout)) m.price = null;
      else m.price = {
        input: isNaN(pin) ? 0 : pin,
        cache: isNaN(pcache) ? 0 : pcache,
        output: isNaN(pout) ? 0 : pout,
        currency: document.getElementById('mCurrency') ? document.getElementById('mCurrency').value : '¥'
      };
    }
    m.favorite = document.getElementById('mFav') && document.getElementById('mFav').getAttribute('aria-checked') === 'true';
    var exists = false;
    state.models.forEach(function (x, i) { if (x.id === m.id) { state.models[i] = m; exists = true; } });
    if (!exists) state.models.push(m);
    var provider = findProvider(m.providerId);
    if (provider) {
      if (!provider.models) provider.models = [];
      if (provider.models.indexOf(m.id) === -1) provider.models.push(m.id);
    }
    save();
    closeSheet();
    modelDraft = null;
    if (providerDetailId) { providerTab = 'models'; renderProviderDetail(); }
    renderMe();
    updateChatHeader();
    toast('模型已保存。');
  }
  function reasoningNoteFor(mode, modelId, suffix) {
    if (mode === 'none') return '这个模型不能调思考深度，请求里不会带任何思考参数';
    if (mode === 'deepseek') return 'DeepSeek 官方是 thinking.type + reasoning_effort：关闭 / 低 / 高 / 最高（官方 medium 与 xhigh 都归到高）';
    if (mode === 'anthropic_budget') return 'thinking.budget_tokens，会保证 max_tokens 大于 budget';
    if (mode === 'gemini_budget') return 'generationConfig.thinkingConfig.thinkingBudget';
    if (mode === 'openai_effort') return 'reasoning_effort / reasoning.effort';
    if (mode === 'openrouter') return 'reasoning.effort 或 reasoning.max_tokens';
    if (mode === 'relay_suffix') return '这家用模型名区分档位，高档切到 ' + (suffix || (modelId + '-thinking'));
    return '';
  }
  function toggleModelFavorite(id) {
    var m = findModel(id);
    if (!m) return;
    m.favorite = !m.favorite;
    save();
    if (sheetName === 'modelPicker') refreshModelPickerPreserve();
    if (providerDetailId && currentView === 'providers') renderProviderTab();
    if (currentView === 'providers' && !providerDetailId) renderProviderListInner();
  }

  /* ---------------- 导入 / 导出 ---------------- */
  SHEETS.providerExport = function (payload) {
    if (payload !== undefined && payload !== null) exportTarget = payload;
    var p = exportTarget ? findProvider(exportTarget) : null;
    var count = p ? 1 : state.providers.length;
    return {
      title: p ? '导出「' + p.name + '」' : '导出全部提供商',
      body: '<p class="sheet-note" style="text-align:left;font-size:11.5px">会导出 ' + count + ' 家提供商和它们下面的模型。</p>' +
        a2SwitchRow('exportKeySwitch', '包含 API Key', '默认不带。勾选后 Key 会明文写进 JSON，注意别发给别人', exportIncludeKey) +
        (exportIncludeKey ? '<div class="a2-banner a2-banner--warn">' + IC_INFO_A2 + '<span>这份文件会带着 Key，只放在自己手机里。</span></div>' : ''),
      foot: '<button class="btn" type="button" data-close>取消</button>' +
        '<button class="btn btn--primary" type="button" data-action="export-run">导出 JSON</button>'
    };
  };
  function toggleExportKey() {
    exportIncludeKey = !exportIncludeKey;
    openSheet('providerExport');
  }
  function exportProviders() {
    var onlyId = exportTarget;
    var list = onlyId ? [findProvider(onlyId)].filter(Boolean) : state.providers;
    if (!list.length) { toast('还没有可导出的提供商。'); return; }
    var name = onlyId ? list[0].name : (list.length + '个提供商');
    if (SERVER_MODE && serverOnline) {
      var path = '/providers/export?includeApiKey=' + (exportIncludeKey ? '1' : '0') + (onlyId ? '&id=' + encodeURIComponent(onlyId) : '');
      serverDownload(path).then(function (blob) {
        downloadBlob('缪诗鸳杞-模型提供商-' + name + '.json', blob);
        closeSheet();
        toast(exportIncludeKey ? '已导出（含 API Key，注意保管）。' : '已导出（不含 API Key）。');
      }).catch(apiToast);
      return;
    }
    var modelIds = {};
    list.forEach(function (p) { (p.models || []).forEach(function (mid) { modelIds[mid] = 1; }); });
    var models = state.models.filter(function (m) { return modelIds[m.id]; }).map(function (m) { return clone(m); });
    var providers = list.map(function (p) {
      var c = clone(p);
      if (!exportIncludeKey) c.apiKey = '';
      return c;
    });
    var payload = {
      app: 'miushi-yuanqi', kind: 'providers', version: 1,
      exportedAt: new Date().toISOString(), includeApiKey: !!exportIncludeKey,
      providers: providers, models: models
    };
    downloadText('缪诗鸳杞-模型提供商-' + name + '.json', JSON.stringify(payload, null, 2));
    closeSheet();
    toast(exportIncludeKey ? '已导出（含 API Key，注意保管）。' : '已导出（不含 API Key）。');
  }
  function handleProviderFile(file) {
    readFileText(file).then(function (text) {
      var raw = tryParseJson(text);
      if (!raw) { toast('这不是一份能读的提供商文件。'); return; }
      var providers = [];
      var models = [];
      if (Array.isArray(raw.providers)) { providers = raw.providers; models = raw.models || []; }
      else if (raw.kind === 'providers' && Array.isArray(raw.providers)) { providers = raw.providers; models = raw.models || []; }
      else if (raw.baseUrl || raw.apiPath) { providers = [raw]; models = raw.models || []; }
      if (!providers.length) { toast('读到了文件，但里面没有提供商。'); return; }
      var idMap = {};
      models.forEach(function (m) {
        if (!m || !m.id) return;
        var copy = clone(m);
        copy.id = findModel(m.id) ? newId('model') : m.id;
        idMap[m.id] = copy.id;
        if (!findModel(copy.id)) state.models.push(copy);
      });
      var added = 0;
      providers.forEach(function (p) {
        if (!p || (!p.baseUrl && !p.name)) return;
        var copy = clone(p);
        copy.id = findProvider(p.id) ? newId('prv') : (p.id || newId('prv'));
        copy.name = uniqueProviderName(copy.name || '导入的提供商');
        copy.apiKey = '';
        copy.source = 'imported';
        copy.enabled = copy.enabled !== false;
        copy.advanced = copy.advanced || { responseApi: false, returnThinking: true, fetchBalance: false, timeout: 45 };
        copy.balance = copy.balance || { supported: false, amount: 0, currency: '¥', at: '' };
        copy.models = (copy.models || []).map(function (mid) { return idMap[mid] || mid; }).filter(function (mid) { return !!findModel(mid); });
        state.providers.push(copy);
        added += 1;
      });
      save();
      providerDetailId = '';
      renderProviders();
      renderMe();
      toast('已导入 ' + added + ' 家提供商。' + (models.length ? ' 模型也一起带进来了。' : ''));
    }).catch(function () { toast('文件打不开，换一份再试试。'); });
  }

  /* ---------------- 模型选择弹层 ---------------- */
  function providerBalanceLabel(p) {
    var proto = protocolOf(p);
    if (!proto.balance) return { text: '余额暂不可查', muted: true };
    var b = p.balance || {};
    if (b.amount || b.amount === 0) {
      return { text: (b.currency || '¥') + Number(b.amount).toFixed(2), muted: false };
    }
    return { text: '余额暂不可查', muted: true };
  }
  function mpMatches(m, p, q) {
    if (!q) return true;
    return ((m.name || '') + ' ' + (m.modelId || '') + ' ' + (p.name || '')).toLowerCase().indexOf(q) !== -1;
  }
  function mpModelTags(m) {
    var out = '';
    if (m.caps && m.caps.vision) out += '<span class="a2-tag">视觉</span>';
    if (m.caps && m.caps.tools) out += '<span class="a2-tag">工具</span>';
    if (m.caps && m.caps.reasoning) out += '<span class="a2-tag">思考</span>';
    return out;
  }
  function mpModelRow(m) {
    var selected = state.modelId === m.id;
    return '<div class="mp-model' + (selected ? ' is-selected' : '') + '" data-a2="model-pick" data-id="' + esc(m.id) + '" role="button" tabindex="0" aria-label="使用 ' + esc(m.name) + '">' +
      modelIconHTML(m, 'p-icon--sm') +
      '<span class="mp-model__main"><span class="mp-model__name">' + esc(m.name) + (selected ? ' · 正在用' : '') + '</span>' +
        '<span class="mp-model__id">' + esc(m.modelId) + '</span>' +
        '<span class="mp-model__tags">' + mpModelTags(m) + '</span></span>' +
      '<button class="model-row__fav' + (m.favorite ? ' is-on' : '') + '" type="button" data-a2="mp-fav" data-id="' + esc(m.id) + '" aria-label="收藏" aria-pressed="' + (m.favorite ? 'true' : 'false') + '">' + IC_HEART + '</button>' +
    '</div>';
  }
  function mpProviderGroupHtml(p, models, open) {
    var bal = providerBalanceLabel(p);
    return '<div class="mp-group' + (open ? ' is-open' : '') + '" id="mpGroup-' + esc(p.id) + '">' +
      '<button class="mp-group__head" type="button" data-a2="mp-group" data-id="' + esc(p.id) + '" aria-expanded="' + (open ? 'true' : 'false') + '">' +
        providerIconHTML(p, 'p-icon--sm') +
        '<span class="mp-group__main"><span class="mp-group__name">' + esc(p.name) + ' <span class="count">' + models.length + ' 个</span></span></span>' +
        '<span class="mp-group__balance' + (bal.muted ? ' is-muted' : '') + '">' + esc(bal.text) + '</span>' +
        '<svg class="mp-group__chev" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M6.4 8 10 11.6 13.6 8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
      '</button>' +
      '<div class="mp-group__body">' + models.map(mpModelRow).join('') + '</div>' +
    '</div>';
  }
  function renderModelPickerHtml(query) {
    var q = String(query || '').toLowerCase();
    var favList = [];
    var groups = [];
    enabledProviders().forEach(function (p) {
      var models = providerModels(p).filter(function (m) { return mpMatches(m, p, q); });
      var favs = models.filter(function (m) { return m.favorite; });
      favs.forEach(function (m) { favList.push({ m: m, p: p }); });
      if (models.length) groups.push({ p: p, models: models });
    });
    var html = '';
    if (favList.length) {
      var favOpen = !mpCollapsed.fav;
      html += '<div class="mp-group' + (favOpen ? ' is-open' : '') + '" id="mpGroup-fav">' +
        '<button class="mp-group__head" type="button" data-a2="mp-group" data-id="fav" aria-expanded="' + (favOpen ? 'true' : 'false') + '">' +
          '<span class="p-icon p-icon--sm p-icon--letter" aria-hidden="true">♥</span>' +
          '<span class="mp-group__main"><span class="mp-group__name">收藏 <span class="count">' + favList.length + ' 个</span></span></span>' +
          '<span class="mp-group__balance is-muted">常用</span>' +
          '<svg class="mp-group__chev" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M6.4 8 10 11.6 13.6 8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
        '</button><div class="mp-group__body">' + favList.map(function (it) { return mpModelRow(it.m); }).join('') + '</div></div>';
    }
    groups.forEach(function (g) {
      var open = q ? true : !mpCollapsed[g.p.id];
      html += mpProviderGroupHtml(g.p, g.models, open);
    });
    if (!html) html = '<p class="a2-empty">没有找到模型。换个关键词试试。</p>';
    var pills = '';
    if (favList.length) pills += '<button class="mp-pill" type="button" data-a2="mp-pill" data-id="fav">收藏</button>';
    groups.forEach(function (g) {
      pills += '<button class="mp-pill" type="button" data-a2="mp-pill" data-id="' + esc(g.p.id) + '">' +
        iconHTMLByKey(providerIconKey(g.p), g.p.name, '') + esc(g.p.name) + '</button>';
    });
    return { html: html, pills: pills };
  }
  function renderModelPickerList(query) {
    var box = document.getElementById('mpList');
    if (!box) return;
    var out = renderModelPickerHtml(query);
    box.innerHTML = out.html;
    var pills = document.getElementById('mpPills');
    if (pills) pills.innerHTML = out.pills;
  }
  function refreshModelPickerPreserve() {
    if (sheetName !== 'modelPicker') return;
    var top = sheetBody ? sheetBody.scrollTop : 0;
    var out = renderModelPickerHtml(mpQuery);
    var box = document.getElementById('mpList');
    if (box) box.innerHTML = out.html;
    var pills = document.getElementById('mpPills');
    if (pills) pills.innerHTML = out.pills;
    if (sheetBody) sheetBody.scrollTop = top;
  }
  function jumpToMpGroup(id) {
    if (id === 'fav') {
      var favEl = document.getElementById('mpGroup-fav');
      if (favEl && sheetBody) sheetBody.scrollTo({ top: Math.max(0, favEl.offsetTop - 8), behavior: 'smooth' });
      return;
    }
    mpCollapsed[id] = false;
    var out = renderModelPickerHtml(mpQuery);
    var box = document.getElementById('mpList');
    if (box) box.innerHTML = out.html;
    var pills = document.getElementById('mpPills');
    if (pills) pills.innerHTML = out.pills;
    var el = document.getElementById('mpGroup-' + id);
    if (el && sheetBody) sheetBody.scrollTo({ top: Math.max(0, el.offsetTop - 8), behavior: 'smooth' });
  }
  SHEETS.modelPicker = function () {
    if (sheetName !== 'modelPicker') mpQuery = '';
    var out = renderModelPickerHtml(mpQuery);
    return {
      title: '选择模型',
      body: '<div class="a2-search">' +
          '<svg viewBox="0 0 18 18" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="4.8"/><path d="m11.8 11.8 3 3"/></svg>' +
          '<input id="mpSearch" data-search="modelPicker" type="search" placeholder="搜索模型或提供商" value="' + esc(mpQuery) + '">' +
        '</div>' +
        '<div id="mpList">' + out.html + '</div>' +
        '<div class="mp-pills" id="mpPills">' + out.pills + '</div>' +
        '<p class="a2-note">只显示启用的提供商。点组头可以折叠；底部胶囊可以跳到那一家。</p>'
    };
  };
  function selectModelA2(id) {
    var m = findModel(id);
    if (!m) return;
    state.modelId = m.id;
    var chat = ensureChat(state.currentCharacterId);
    if (chat) chat.modelId = m.id;
    save();
    closeSheet();
    updateChatHeader();
    renderMe();
    toast('模型换成 ' + m.name + '。');
  }
