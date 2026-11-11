/* 提供商：列表 / 详情 / 配置表单 / 保存·删除·复制·新建。
 *
 * 从 src/app.js 的三个「提供商」分节整块拆出。块内没有顶层 var 也没有
 * SHEETS 赋值，搬移不影响初始化顺序；build.mjs 会把本文件拼进同一个 IIFE，
 * 所以 findProvider / esc / toast 这些依赖照旧可见。
 */

  /* ---------------- 提供商：列表 ---------------- */
  function renderProviders() {
    var title = document.getElementById('providerTitle');
    if (!title) return;
    if (providerDetailId) { renderProviderDetail(); return; }
    title.textContent = '模型与提供商';
    var bar = document.getElementById('providerBar');
    if (bar) { bar.classList.remove('is-show'); bar.innerHTML = ''; }
    var box = document.getElementById('providerScroll');
    if (!box) return;
    box.innerHTML =
      '<div class="a2-toolbar">' +
        '<button class="lib-action lib-action--primary" type="button" data-action="new-provider">' + IC_PLUS_A2 + '添加</button>' +
        '<button class="lib-action" type="button" data-action="import-provider">' + IC_IMPORT_A2 + '导入</button>' +
        '<button class="lib-action" type="button" data-action="export-providers">导出</button>' +
      '</div>' +
      '<div class="a2-search">' +
        '<svg viewBox="0 0 18 18" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="4.8"/><path d="m11.8 11.8 3 3"/></svg>' +
        '<input id="providerSearch" data-search="provider" type="search" placeholder="搜索提供商或模型" value="' + esc(providerQuery) + '">' +
      '</div>' +
      '<div class="a2-banner">' + IC_INFO_A2 +
        '<span>API Key 加密存在本机后端，界面始终只显示掩码；所有模型请求由后端发出，浏览器不再直连。</span></div>' +
      '<div class="prov-list" id="provListBox"></div>' +
      '<p class="a2-note">点一家进去改配置、拉取模型或测试连接。禁用的提供商会变浅红，也不会出现在聊天的模型选择里。</p>';
    renderProviderListInner();
  }

  function renderProviderListInner() {
    var box = document.getElementById('provListBox');
    if (!box) return;
    var q = String(providerQuery || '').toLowerCase();
    var list = state.providers.slice().sort(function (a, b) { return (b.enabled ? 1 : 0) - (a.enabled ? 1 : 0); });
    if (q) {
      list = list.filter(function (p) {
        if ((p.name || '').toLowerCase().indexOf(q) !== -1) return true;
        if ((p.baseUrl || '').toLowerCase().indexOf(q) !== -1) return true;
        return providerModels(p).some(function (m) {
          return (m.name + ' ' + m.modelId).toLowerCase().indexOf(q) !== -1;
        });
      });
    }
    if (!list.length) {
      box.innerHTML = '<p class="a2-empty">没有找到。换个关键词，或者点上面的「添加」新建一家。</p>';
      return;
    }
    box.innerHTML = list.map(function (p) {
      var proto = protocolOf(p);
      return '<button class="prov-card' + (p.enabled ? '' : ' is-off') + '" type="button" data-a2="provider-open" data-id="' + esc(p.id) + '">' +
        providerIconHTML(p, '') +
        '<span class="prov-card__main">' +
          '<span class="prov-card__top"><span class="prov-card__name">' + esc(p.name) + '</span>' +
            '<span class="a2-tag ' + (p.enabled ? '' : 'a2-tag--off') + '">' + (p.enabled ? '已启用' : '已停用') + '</span></span>' +
          '<span class="prov-card__meta">' + esc(proto.name) + ' · ' + esc(hostOf(p.baseUrl)) + '</span>' +
        '</span>' +
        '<span class="prov-card__balance"><b>' + providerModels(p).length + '</b><span>个模型</span></span>' +
        LIB_CHEV +
      '</button>';
    }).join('');
  }

  /* ---------------- 提供商：详情 ---------------- */
  function renderProviderDetail() {
    var p = findProvider(providerDetailId);
    if (!p) { providerDetailId = ''; renderProviders(); return; }
    var title = document.getElementById('providerTitle');
    if (title) title.textContent = p.name;
    var bar = document.getElementById('providerBar');
    if (bar) {
      bar.classList.add('is-show');
      bar.innerHTML =
        '<button class="btn btn--soft" type="button" data-action="test-conn">测试连接</button>' +
        '<button class="btn btn--danger" type="button" data-action="delete-provider">删除</button>' +
        '<button class="btn btn--primary" type="button" data-action="save-provider">保存</button>' +
        '<p class="d2-provider-save-note">保存后自动连接，不扣费</p>';
    }
    var box = document.getElementById('providerScroll');
    if (!box) return;
    box.innerHTML =
      '<div class="prov-hero">' +
        providerIconHTML(p, 'p-icon--lg') +
        '<div class="prov-hero__main"><h3 class="prov-hero__name">' + esc(p.name) + '</h3>' +
          '<p class="prov-hero__meta">' + esc(protocolName(p.protocol)) + ' · ' + (p.enabled ? '已启用' : '已停用') + ' · ' + providerModels(p).length + ' 个模型</p></div>' +
        '<div class="prov-hero__actions">' +
          '<button class="mini-btn" type="button" data-action="copy-provider">复制</button>' +
          '<button class="mini-btn" type="button" data-a2="export-provider" data-id="' + esc(p.id) + '">导出</button>' +
        '</div>' +
      '</div>' +
      '<div class="a2-tabs" role="tablist" aria-label="提供商设置">' +
        '<button class="a2-tab' + (providerTab === 'config' ? ' is-on' : '') + '" type="button" data-a2="provider-tab" data-value="config" role="tab">配置</button>' +
        '<button class="a2-tab' + (providerTab === 'models' ? ' is-on' : '') + '" type="button" data-a2="provider-tab" data-value="models" role="tab">模型</button>' +
        '<button class="a2-tab' + (providerTab === 'advanced' ? ' is-on' : '') + '" type="button" data-a2="provider-tab" data-value="advanced" role="tab">高级设置</button>' +
      '</div>' +
      '<div id="provTabBody">' + providerTabHtml(p) + '</div>';
    if (typeof d2AfterProviderDetail === 'function') d2AfterProviderDetail(p);
  }

  function providerTabHtml(p) {
    if (providerTab === 'models') return providerModelsTabHtml(p);
    if (providerTab === 'advanced') return providerAdvancedTabHtml(p);
    return providerConfigTabHtml(p);
  }

  function renderProviderTab() {
    var body = document.getElementById('provTabBody');
    if (!body) { renderProviderDetail(); return; }
    var p = findProvider(providerDetailId);
    if (!p) return;
    body.innerHTML = providerTabHtml(p);
    if (typeof d2AfterProviderDetail === 'function') d2AfterProviderDetail(p);
  }

  function a2SwitchRow(id, label, sub, on) {
    return '<div class="form-row">' +
      '<span class="form-row__label">' + esc(label) + '</span>' +
      '<div class="form-row__main"><p class="form-row__hint" style="margin:0">' + esc(sub || '') + '</p></div>' +
      '<button class="switch" id="' + id + '" data-a2="toggle-switch" type="button" role="switch" aria-checked="' + (on ? 'true' : 'false') + '" aria-label="' + esc(label) + '"><span></span></button>' +
    '</div>';
  }
  function a2InputRow(label, inner, hint) {
    return '<div class="form-row"><span class="form-row__label">' + esc(label) + '</span>' +
      '<div class="form-row__main">' + inner + (hint ? '<p class="form-row__hint">' + esc(hint) + '</p>' : '') + '</div></div>';
  }

  function providerConfigTabHtml(p) {
    var proto = protocolOf(p);
    var keyValue = providerKeyMask(p);
    var iconStrip = '<div class="icon-strip">' + iconChoicesHtml(providerIconKey(p) || 'generic') + '</div>';
    return '<div class="a2-card form-card">' +
        a2SwitchRow('provSwitchEnabled', '启用这家', '停用后不出现在聊天的模型选择里', p.enabled) +
        a2InputRow('名称', '<input class="field" id="provName" type="text" value="' + esc(p.name) + '" placeholder="例如：白露中转">') +
        '<div class="form-row form-row--stack"><span class="form-row__label">图标</span>' + iconStrip +
          '<p class="form-row__hint">官方图标按类型自动匹配；点一个可以自己换。</p></div>' +
        a2InputRow('协议类型', '<select class="field" id="provProtocol">' + protocolOptionsHtml(p.protocol) + '</select>', proto.note || '') +
        a2InputRow('Base URL', '<input class="field" id="provBase" type="text" value="' + esc(p.baseUrl) + '" placeholder="https://api.example.com/v1">') +
        '<div class="form-row"><span class="form-row__label">API 路径</span><div class="form-row__main">' +
          '<div class="key-row"><input class="field" id="provPath" type="text" value="' + esc(p.apiPath) + '" placeholder="/chat/completions">' +
          '<button class="pull-btn" type="button" data-action="pull-models">' + IC_REFRESH_A2 + '拉取模型</button></div>' +
          '<p class="form-row__hint">OpenAI 兼容走 GET {base}/models；Anthropic 走 /v1/models；Gemini 走 /v1beta/models。</p>' +
        '</div></div>' +
        '<div class="form-row"><span class="form-row__label">API Key</span><div class="form-row__main">' +
          '<div class="key-row"><input class="field" id="provKey" type="password" value="' + esc(keyValue) + '" placeholder="sk-••••••••" autocomplete="off" spellcheck="false">' +
          '<button class="eye-btn" type="button" data-a2="key-eye">' + IC_EYE + '显示</button></div>' +
          '<p class="form-row__hint">Key 加密保存在本机后端，浏览器只显示掩码；导出默认不带 Key。</p>' +
        '</div></div>' +
        a2SwitchRow('provSwitchResponseApi', 'Response API', '打开后用 /responses，而不是 /chat/completions', p.advanced && p.advanced.responseApi) +
        a2SwitchRow('provSwitchThinking', '回传历史思考过程', '关闭后不在回复里显示「想了 N 秒」', !p.advanced || p.advanced.returnThinking !== false) +
        a2SwitchRow('provSwitchBalance', '获取账户余额', proto.balance ? '这家有官方余额接口' : '这家不支持查询余额', p.advanced && p.advanced.fetchBalance) +
      '</div>' +
      '<div class="a2-banner">' + IC_INFO_A2 +
        '<span>API Key 加密保存在本机后端，浏览器不直接拿 Key 发请求；测试连接、拉模型、余额、聊天都由后端转发。</span></div>';
  }

  function providerModelsTabHtml(p) {
    var models = providerModels(p);
    var rows = models.length ? models.map(function (m) {
      return '<div class="model-row" data-a2="model-edit" data-id="' + esc(m.id) + '" role="button" tabindex="0">' +
        modelIconHTML(m, 'p-icon--sm') +
        '<span class="model-row__main">' +
          '<span class="model-row__name">' + esc(m.name) + '</span>' +
          '<span class="model-row__id">' + esc(m.modelId) + '</span>' +
          '<span class="model-row__tags">' + capsTagsHtml(m) + priceTagHtml(m) + '</span>' +
        '</span>' +
        '<button class="model-row__fav' + (m.favorite ? ' is-on' : '') + '" type="button" data-a2="model-fav" data-id="' + esc(m.id) + '" aria-label="收藏" aria-pressed="' + (m.favorite ? 'true' : 'false') + '">' + IC_HEART + '</button>' +
      '</div>';
    }).join('') : '<p class="a2-empty">还没有模型。可以手动添加，也可以点「拉取模型」。</p>';
    return '<div class="a2-card">' +
        '<div class="a2-card__head"><span class="label">这家下面的模型 · ' + models.length + ' 个</span>' +
          '<button class="text-btn" type="button" data-action="pull-models">' + '拉取模型' + '</button></div>' +
        '<div class="model-list">' + rows + '</div>' +
        '<button class="lib-action lib-action--primary" type="button" data-action="new-model" style="width:100%;margin-top:10px">' + IC_PLUS_A2 + '添加新模型</button>' +
      '</div>' +
      '<p class="a2-note">图标按模型 ID 自动匹配（deepseek / claude / gemini / gpt / qwen / kimi…），匹配不到用中性的字母圆形。</p>';
  }

  function providerAdvancedTabHtml(p) {
    var proto = protocolOf(p);
    var adv = p.advanced || {};
    var bal;
    if (proto.balance) {
      var b = p.balance || {};
      bal = '<div class="a2-card">' +
        '<div class="a2-card__head"><span class="label">余额</span>' +
          '<button class="text-btn" type="button" data-a2="bal-query" data-id="' + esc(p.id) + '">查询</button></div>' +
        (b.amount || b.amount === 0
          ? '<p class="reason-current" style="font-size:26px">' + esc(b.currency || '¥') + Number(b.amount).toFixed(2) + '</p>' +
            '<p class="a2-sub">查询于 ' + esc(b.at || '—') + '</p>'
          : '<p class="a2-sub">余额暂不可查</p>') +
        '<p class="a2-note" style="text-align:left">DeepSeek 走 GET /user/balance；OpenRouter 走 GET /api/v1/credits。查不到时只显示小灰字，不弹英文报错。</p>' +
      '</div>';
    } else {
      bal = '<div class="a2-card"><div class="a2-card__head"><span class="label">余额</span></div>' +
        '<p class="a2-sub">这家不支持查询余额</p>' +
        '<p class="a2-note" style="text-align:left">只有 DeepSeek 官方与 OpenRouter 有公开的余额接口，其他类型默认关闭。</p></div>';
    }
    var forwardMode = adv.forwardMode || 'auto';
    return '<div class="a2-card form-card">' +
        '<div class="form-row form-row--stack"><span class="form-row__label">中转转发方式</span>' +
          '<select class="field" id="provForwardMode">' + (typeof d2ForwardModeOptionsHtml === 'function' ? d2ForwardModeOptionsHtml(forwardMode) : '') + '</select>' +
          '<p class="form-row__hint" id="d2ForwardHint">' + esc(typeof d2ForwardModeHint === 'function' ? d2ForwardModeHint(forwardMode) : '档位由后端真实模型家族 + 转发方式决定，不看中转站名字') + '</p>' +
        '</div>' +
        a2InputRow('请求超时', '<input class="field" id="provTimeout" type="number" inputmode="numeric" value="' + esc(adv.timeout || 45) + '" placeholder="45">', '单位秒；测试连接最多等 25 秒') +
        a2SwitchRow('provSwitchThinkingAdv', '回传历史思考过程', '关闭后回复里不显示「想了 N 秒」', adv.returnThinking !== false) +
      '</div>' +
      bal +
      '<div class="a2-card">' +
        '<div class="a2-card__head"><span class="label">这家还能做什么</span></div>' +
        '<div class="bind-mini"><span class="bind-mini__main"><span class="bind-mini__label">复制一家</span><span class="bind-mini__value">同样的协议与模型，另起一份</span></span>' +
          '<button class="mini-btn" type="button" data-action="copy-provider">复制</button></div>' +
        '<div class="bind-mini"><span class="bind-mini__main"><span class="bind-mini__label">导出配置</span><span class="bind-mini__value">JSON，默认不带 API Key</span></span>' +
          '<button class="mini-btn" type="button" data-a2="export-provider" data-id="' + esc(p.id) + '">导出</button></div>' +
      '</div>' +
      '<div class="a2-banner">' + IC_INFO_A2 +
        '<span>高级设置只影响请求方式，不会把 Key 写进导出文件。Extra 字段（导入时没认出来的）都收在额外资料里，界面不展开。</span></div>';
  }

  function iconChoicesHtml(current) {
    var keys = Object.keys(PROVIDER_ICONS).sort();
    var out = '<button class="icon-choice' + (current === 'generic' ? ' is-on' : '') + '" type="button" data-a2="icon-pick" data-value="generic" aria-label="通用图标"><span class="p-icon--letter">通</span></button>';
    keys.forEach(function (k) {
      out += '<button class="icon-choice' + (current === k ? ' is-on' : '') + '" type="button" data-a2="icon-pick" data-value="' + esc(k) + '" aria-label="' + esc(k) + '">' + PROVIDER_ICONS[k] + '</button>';
    });
    return out;
  }
  function protocolOptionsHtml(selected) {
    return (DATA.protocols || []).map(function (pr) {
      return '<option value="' + esc(pr.id) + '"' + (pr.id === selected ? ' selected' : '') + '>' + esc(pr.name) + '</option>';
    }).join('');
  }
  function capsTagsHtml(m) {
    var out = '';
    if (m.caps && m.caps.vision) out += '<span class="a2-tag">视觉</span>';
    if (m.caps && m.caps.tools) out += '<span class="a2-tag">工具</span>';
    if (m.caps && m.caps.reasoning) out += '<span class="a2-tag">思考</span>';
    if (m.context) out += '<span class="a2-tag a2-tag--muted">' + shortContext(m.context) + '</span>';
    return out;
  }
  function priceTagHtml(m) {
    if (!m.price) return '<span class="a2-tag a2-tag--muted">未设单价</span>';
    var p = m.price;
    return '<span class="a2-tag a2-tag--muted">' + esc(p.currency || '¥') + (p.input || 0) + ' / ' + (p.output || 0) + ' 每百万</span>';
  }

  /* ---------------- 提供商：保存 / 删除 / 复制 / 新建 ---------------- */
  function collectProviderForm(p) {
    if (!p) return;
    var el;
    el = document.getElementById('provName'); if (el && el.value.trim()) p.name = el.value.trim();
    el = document.getElementById('provProtocol'); if (el) p.protocol = el.value;
    el = document.getElementById('provBase'); if (el) p.baseUrl = el.value.trim();
    el = document.getElementById('provPath'); if (el) p.apiPath = el.value.trim();
    el = document.getElementById('provKey');
    if (el) {
      var v = el.value || '';
      if (v.indexOf('•') === -1) {
        if (SERVER_MODE && serverOnline) {
          /* 只在用户真的输入了新 Key 时上传；明文不留在前端状态里 */
          if (v.trim()) pendingProviderKey = v.trim();
        } else {
          p.apiKey = v.trim();
        }
      }
    }
    el = document.getElementById('provSwitchEnabled'); if (el) p.enabled = el.getAttribute('aria-checked') === 'true';
    if (!p.advanced) p.advanced = {};
    el = document.getElementById('provSwitchResponseApi'); if (el) p.advanced.responseApi = el.getAttribute('aria-checked') === 'true';
    el = document.getElementById('provSwitchThinking'); if (el) p.advanced.returnThinking = el.getAttribute('aria-checked') === 'true';
    el = document.getElementById('provSwitchThinkingAdv'); if (el) p.advanced.returnThinking = el.getAttribute('aria-checked') === 'true';
    el = document.getElementById('provSwitchBalance'); if (el) p.advanced.fetchBalance = el.getAttribute('aria-checked') === 'true';
    el = document.getElementById('provTimeout'); if (el && el.value) p.advanced.timeout = Math.max(5, parseInt(el.value, 10) || 45);
    el = document.getElementById('provForwardMode'); if (el) p.advanced.forwardMode = el.value;
  }
  function saveProvider(silent) {
    var p = findProvider(providerDetailId);
    if (!p) return;
    if (typeof d2SaveProviderFlow === 'function') { d2SaveProviderFlow(silent); return; }
    collectProviderForm(p);
    function done() {
      save();
      renderProviderDetail();
      renderMe();
      if (silent) return;
      toast('「' + p.name + '」已保存。');
    }
    if (SERVER_MODE && serverOnline && pendingProviderKey !== null) {
      var key = pendingProviderKey;
      pendingProviderKey = null;
      serverFetch('/providers/' + encodeURIComponent(p.id) + '/key', { method: 'POST', body: { apiKey: key } }).then(function (data) {
        p.hasKey = !!data.hasKey;
        p.keyMasked = data.keyMasked || '';
        delete p.apiKey;
        done();
      }).catch(function (err) { apiToast(err); done(); });
      return;
    }
    done();
  }
  function deleteProvider() {
    var p = findProvider(providerDetailId);
    if (!p) return;
    openSheet('confirm', {
      title: '删除提供商？',
      text: '「' + p.name + '」下面的模型也会一起从聊天选择里消失，删掉就找不回来了。',
      label: '删除', run: 'delete-provider', id: p.id
    });
  }
  function copyProvider() {
    var p = findProvider(providerDetailId);
    if (!p) return;
    var copy = clone(p);
    copy.id = newId('prv');
    copy.name = uniqueProviderName(p.name + '（副本）');
    copy.apiKey = '';
    copy.source = 'copy';
    copy.models = (p.models || []).map(function (mid) {
      var m = findModel(mid);
      if (!m) return '';
      var nm = clone(m);
      nm.id = newId('model');
      nm.providerId = copy.id;
      nm.name = m.name;
      state.models.push(nm);
      return nm.id;
    }).filter(Boolean);
    state.providers.push(copy);
    save();
    providerDetailId = copy.id;
    renderMe();
    renderProviderDetail();
    toast('复制好了，Key 没有带过来。');
  }
  function uniqueProviderName(base) {
    var name = base;
    var n = 1;
    while (state.providers.some(function (p) { return p.name === name; })) { n += 1; name = base + '（' + n + '）'; }
    return name;
  }
  function createProviderFromTemplate(key) {
    var tpl = (DATA.providerTemplates || []).filter(function (t) { return t.key === key; })[0];
    if (!tpl) return;
    var p = {
      id: newId('prv'), name: uniqueProviderName(tpl.name), icon: tpl.icon, protocol: tpl.protocol,
      baseUrl: tpl.baseUrl, apiPath: tpl.apiPath, apiKey: '', enabled: true, models: [],
      balance: { supported: false, amount: 0, currency: '¥', at: '' },
      advanced: { responseApi: false, returnThinking: true, fetchBalance: false, timeout: 45 },
      source: 'user', extras: {}
    };
    state.providers.push(p);
    save();
    closeSheet();
    navTo('providers');
    providerDetailId = p.id;
    providerTab = 'config';
    renderProviders();
    toast('已新建「' + p.name + '」，先填 API Key，再拉取模型。');
  }
  function applyProtocolDefaults(protocolId) {
    var proto = protocolOf({ protocol: protocolId });
    var pathEl = document.getElementById('provPath');
    var baseEl = document.getElementById('provBase');
    if (pathEl && !pathEl.value.trim()) pathEl.value = proto.path || '';
    if (proto.id === 'anthropic' && baseEl && !baseEl.value.trim()) baseEl.value = 'https://api.anthropic.com';
    if (proto.id === 'gemini' && baseEl && !baseEl.value.trim()) baseEl.value = 'https://generativelanguage.googleapis.com';
  }
