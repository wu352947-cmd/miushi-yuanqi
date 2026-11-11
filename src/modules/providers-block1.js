  /* =========================================================================
     第一块 · 提供商「保存后自动连接」/ 真实测试连接 / 网址自动补全
     模块和 app.js 同作用域（构建时注入），运行时可直接用 state / save / toast 等。
     顶层只声明，不读 state / DOM。
     ========================================================================= */

  var D2_FORWARD_MODES = [
    { id: 'auto', label: '自动判断（推荐）', hint: '按协议和模型家族自动选' },
    { id: 'openai_compat_translate', label: 'OpenAI 兼容 · 翻译', hint: '中转只吃 OpenAI 参数：思考档位翻译成 reasoning_effort' },
    { id: 'openai_compat_passthrough', label: 'OpenAI 兼容 · 透传', hint: '中转原样转发：用模型家族原生的思考参数' },
    { id: 'native_anthropic', label: '原生 Anthropic 格式', hint: '强制走 /v1/messages' },
    { id: 'native_gemini', label: '原生 Gemini 格式', hint: '强制走 /v1beta/models' },
    { id: 'model_suffix', label: '模型名区分档位（model_suffix）', hint: '切档位等于换成对应模型 ID，例如 -thinking' }
  ];

  var D2_PATHS = { openai: '/chat/completions', openai_responses: '/responses', anthropic: '/v1/messages', gemini: '/v1beta/models/{model}:generateContent' };

  function d2CleanUrl(url) {
    var m = /^([a-z]+:)\/\/(.*)$/i.exec(url || '');
    if (!m) return url || '';
    var rest = m[2].replace(/\/{2,}/g, '/').replace(/\/v1\/v1(?=\/|$)/gi, '/v1').replace(/\/+$/, '');
    return m[1] + '//' + rest;
  }

  /* 与 server/url_normalize.py 同一套规则的前端镜像（离线也能补全；在线以接口结果为准） */
  function d2NormProvider(baseUrl, apiPath, protocol) {
    var originalBase = String(baseUrl || '').trim();
    var originalPath = String(apiPath || '').trim();
    var proto = String(protocol || 'openai').trim() || 'openai';
    var changes = [];
    function add(field, from, to) {
      if (from === to) return;
      changes.push({ field: field, from: from, to: to, label: '已自动改为 ' + to });
    }
    var base = originalBase;
    if (!base) return { baseUrl: '', apiPath: originalPath, protocol: proto, changes: changes };
    if (!/^https?:\/\//i.test(base)) {
      if (/^[a-z]+:\/\//i.test(base)) base = 'https://' + base.replace(/^[a-z]+:\/\//i, '');
      else base = 'https://' + base.replace(/^\/+/, '');
    }
    base = d2CleanUrl(base);
    var inferredProto = '';
    var inferredPath = null;
    var rules = [
      [/^(.+?)\/chat\/completions\/?$/i, 'openai', '/chat/completions'],
      [/^(.+?)\/responses\/?$/i, 'openai_responses', '/responses'],
      [/^(.+?)\/messages\/?$/i, 'anthropic', '/v1/messages'],
      [/^(.+?)(?:\/v1beta)?\/models\/[^/:]+:(?:stream)?generateContent\/?$/i, 'gemini', null]
    ];
    var i;
    for (i = 0; i < rules.length; i++) {
      var mm = rules[i][0].exec(base);
      if (mm) { base = mm[1]; inferredProto = rules[i][1]; inferredPath = rules[i][2]; break; }
    }
    if (!inferredProto) {
      var modelsRules = [[/^(.+?)\/v1\/models\/?$/i, '/v1'], [/^(.+?)\/models\/?$/i, '']];
      for (i = 0; i < modelsRules.length; i++) {
        var m2 = modelsRules[i][0].exec(base);
        if (m2) { base = m2[1] + modelsRules[i][1]; break; }
      }
    }
    if (inferredProto === 'anthropic' || inferredProto === 'gemini') base = base.replace(/\/v1$/i, '');
    base = d2CleanUrl(base);
    var protocolOut = proto;
    if (inferredProto && inferredProto !== proto) {
      var openaiFamily = ['openai', 'openai_responses', 'deepseek', 'openrouter'];
      if (!(openaiFamily.indexOf(inferredProto) >= 0 && openaiFamily.indexOf(proto) >= 0)) {
        protocolOut = inferredProto;
        changes.push({ field: 'protocol', from: proto, to: inferredProto, label: '已自动改为 ' + ({ anthropic: 'Anthropic', gemini: 'Gemini', openai: 'OpenAI 兼容' }[inferredProto] || inferredProto) });
      } else if (proto === 'openai' || !proto) {
        protocolOut = inferredProto;
      }
    }
    var defaults = Object.keys(D2_PATHS).map(function (k) { return D2_PATHS[k]; });
    var userCustom = !!originalPath && defaults.indexOf(originalPath) === -1;
    var path = inferredPath !== null ? inferredPath : (userCustom ? originalPath : (D2_PATHS[protocolOut] || '/chat/completions'));
    if (path) {
      if (path.charAt(0) !== '/') path = '/' + path;
      path = path.replace(/\/{2,}/g, '/');
      if (/\/v1$/i.test(base) && /^\/v1(\/|$)/i.test(path)) path = path.slice(3);
    }
    add('baseUrl', originalBase, base);
    add('apiPath', originalPath, path);
    return { baseUrl: base, apiPath: path, protocol: protocolOut, changes: changes };
  }

  function d2ProviderFind(id) {
    for (var i = 0; i < state.providers.length; i++) if (state.providers[i].id === id) return state.providers[i];
    return null;
  }

  function d2ModelIconHtml(model, cls) {
    if (typeof modelIconHTML === 'function') {
      try { return modelIconHTML(model, cls || 'p-icon--sm'); } catch (e) { /* 忽略 */ }
    }
    return '<span class="p-icon ' + (cls || '') + '">' + esc(String((model && (model.name || model.modelId)) || '?').charAt(0)) + '</span>';
  }

  function d2RenderUrlHint(norm) {
    var box = document.getElementById('d2UrlHint');
    if (!box) return;
    var lines = (norm && norm.changes || []).map(function (c) { return '<span>' + esc(c.label) + '</span>'; });
    box.innerHTML = lines.length ? lines.join('') : '';
    box.classList.toggle('is-show', lines.length > 0);
  }

  function d2AutofillProviderFields(p, norm, opts) {
    if (!p || !norm) return;
    var baseEl = document.getElementById('provBase');
    var pathEl = document.getElementById('provPath');
    var protoEl = document.getElementById('provProtocol');
    if (baseEl) baseEl.value = norm.baseUrl;
    if (pathEl) pathEl.value = norm.apiPath;
    if (protoEl && norm.protocol) protoEl.value = norm.protocol;
    p.baseUrl = norm.baseUrl;
    p.apiPath = norm.apiPath;
    p.protocol = norm.protocol;
    d2RenderUrlHint(norm);
    if (opts && opts.save) save();
  }

  function d2NormalizeProviderForm(showToast) {
    var p = d2ProviderFind(providerDetailId);
    if (!p) return null;
    var baseEl = document.getElementById('provBase');
    var pathEl = document.getElementById('provPath');
    var protoEl = document.getElementById('provProtocol');
    var norm = d2NormProvider(
      baseEl ? baseEl.value : p.baseUrl,
      pathEl ? pathEl.value : p.apiPath,
      protoEl ? protoEl.value : p.protocol
    );
    d2AutofillProviderFields(p, norm);
    if (showToast && norm.changes.length) toast('网址已自动补全，检查一下再保存。');
    return norm;
  }

  /* 打开「测试连接」：先提示会发一条测试消息，可选同时检测思考档位 */
  function d2OpenTestConnection() {
    var p = d2ProviderFind(providerDetailId);
    if (!p) return;
    collectProviderForm(p);
    openSheet('connTest');
  }

  function d2CachedTestLine(p) {
    var cached = (p.advanced || {}).testResult;
    if (!cached) return '';
    return '<p class="d2-test-cached">上次测试：' + esc(cached.at || '—') + ' · ' + (cached.ok ? '成功' : '没成功') + (cached.modelName ? ' · ' + esc(cached.modelName) : '') + '</p>';
  }

  function d2TestResultHtml(data) {
    var rows = '';
    if (data.reasoning && data.reasoning.checked && data.reasoning.results) {
      rows = '<div class="d2-test-levels"><p class="sheet-label">思考档位逐项结果</p>' + data.reasoning.results.map(function (r) {
        return '<div class="d2-test-level ' + (r.ok ? 'is-ok' : 'is-fail') + '"><span>' + esc(reasonLabel(r.level)) + '</span><span>' + (r.ok ? '可以' : '这家不支持') + (r.ms ? ' · ' + r.ms + 'ms' : '') + '</span></div>';
      }).join('') + '</div>';
    }
    return '<div class="test-state ' + (data.ok ? 'is-ok' : 'is-fail') + '"><span class="test-state__dot"></span>' +
        '<span>' + esc(data.message || (data.ok ? '测试连接成功。' : '没连上。')) + '</span></div>' +
      '<p class="test-detail">' + esc([data.modelName || '', data.streamSupported === true ? '支持流式' : (data.streamSupported === false ? '不支持流式' : ''), data.ms ? data.ms + 'ms' : '', data.at || ''].filter(Boolean).join(' · ')) + '</p>' +
      (data.responseText ? '<p class="d2-test-echo">模型回了一句：' + esc(data.responseText) + '</p>' : '') + rows;
  }

  function d2RunTestConnection() {
    var p = d2ProviderFind(providerDetailId);
    if (!p) return;
    var box = document.getElementById('d2TestBody');
    var reasoningEl = document.getElementById('d2TestReasoning');
    var checkReasoning = !!(reasoningEl && reasoningEl.getAttribute('aria-checked') === 'true');
    if (box) box.innerHTML = '<div class="test-state is-wait"><span class="test-state__dot"></span><span>正在让后端发一条最小测试消息…最多等 25 秒</span></div>';
    if (!(SERVER_MODE && serverOnline)) {
      if (box) box.innerHTML = '<div class="test-state is-fail"><span class="test-state__dot"></span><span>离线演示模式连不上后端：等用 http(s) 打开正式版再测试连接。</span></div>';
      return;
    }
    collectProviderForm(p);
    var modelId = '';
    var ownModels = (state.models || []).filter(function (m) { return m.providerId === p.id; });
    for (var i = 0; i < ownModels.length; i++) { if (ownModels[i].id === state.modelId) { modelId = ownModels[i].id; break; } }
    if (!modelId && ownModels.length) modelId = ownModels[0].id;
    if (!modelId) {
      if (box) box.innerHTML = '<div class="test-state is-fail"><span class="test-state__dot"></span><span>这家还没有模型：先拉取模型或手动添加一个，再测试连接。</span></div>';
      return;
    }
    save();
    serverFetch('/providers/' + encodeURIComponent(p.id) + '/test', { method: 'POST', body: { modelId: modelId, checkStream: true, checkReasoning: checkReasoning } }).then(function (data) {
      if (box) box.innerHTML = d2TestResultHtml(data);
      if (!p.advanced) p.advanced = {};
      p.advanced.testResult = {
        at: data.at || nowLabel(),
        ok: !!data.ok,
        message: data.message || '',
        modelId: data.modelId || modelId,
        modelName: data.modelName || '',
        streamSupported: !!data.streamSupported,
        reasoning: data.reasoning || { checked: false, results: [] }
      };
      save();
      var cachedBox = document.getElementById('d2TestCached');
      if (cachedBox) cachedBox.innerHTML = d2CachedTestLine(p);
    }).catch(function (err) {
      if (box) box.innerHTML = '<div class="test-state is-fail"><span class="test-state__dot"></span><span>' + esc(err.message || '测试连接没成功，稍后再试。') + '</span></div>';
    });
  }

  function d2ConnectResultSheet(data) {
    var p = d2ProviderFind(providerDetailId);
    var modelNames = (data.models || []).slice(0, 12).map(function (m) {
      return '<span class="d2-model-chip">' + d2ModelIconHtml(m) + '<span>' + esc(m.name || m.modelId || '') + '</span></span>';
    }).join('');
    if ((data.models || []).length > 12) modelNames += '<span class="a2-tag a2-tag--muted">…等 ' + data.models.length + ' 个</span>';
    var changes = (data.changes || []).map(function (c) { return '<li>' + esc(c.label || (c.field + ' → ' + c.to)) + '</li>'; }).join('');
    var balance = data.balance && data.balance.amount !== undefined && data.balance.amount !== null
      ? '<p class="d2-connect-balance">余额 ' + esc(data.balance.currency || '¥') + Number(data.balance.amount).toFixed(2) + ' · ' + esc(data.balance.at || '') + '</p>' : '';
    var ok = !!data.connected;
    return {
      title: ok ? '已连接' : '已保存',
      body: '<div class="test-state ' + (ok ? 'is-ok' : 'is-wait') + '"><span class="test-state__dot"></span><span>' + esc(data.message || '') + '</span></div>' +
        (changes ? '<p class="sheet-label">自动修正</p><ul class="d2-connect-changes">' + changes + '</ul>' : '') +
        (modelNames ? '<p class="sheet-label">识别到的模型</p><div class="d2-model-chips">' + modelNames + '</div>' : '') +
        balance +
        (data.probe && data.probe.url ? '<p class="d2-connect-probe">探测 ' + esc(data.probe.url) + (data.probe.status ? ' · HTTP ' + data.probe.status : '') + (data.probe.ms ? ' · ' + data.probe.ms + 'ms' : '') + '</p>' : '') +
        '<p class="a2-note">' + (ok ? '配置已经保存，可以直接在聊天里选这些模型。' : '配置已经保存，可以直接用；模型也可以手动添加。') + '</p>',
      foot: '<button class="btn btn--primary" type="button" data-close>好</button>'
    };
  }

  function d2ApplySaveConnectResult(p, data) {
    if (!p) return;
    if (data.provider) {
      var serverProvider = data.provider;
      p.baseUrl = serverProvider.baseUrl || p.baseUrl;
      p.apiPath = serverProvider.apiPath || p.apiPath;
      p.protocol = serverProvider.protocol || p.protocol;
      p.name = serverProvider.name || p.name;
      p.hasKey = !!serverProvider.hasKey;
      p.keyMasked = serverProvider.keyMasked || '';
      p.advanced = Object.assign({}, p.advanced || {}, serverProvider.advanced || {});
      p.extras = Object.assign({}, p.extras || {}, serverProvider.extras || {});
      p.balance = serverProvider.balance || p.balance;
      p.models = (serverProvider.models || []).slice();
    }
    if (Array.isArray(data.models) && data.models.length) {
      var keep = (state.models || []).filter(function (m) { return m.providerId !== p.id; });
      state.models = keep.concat(data.models);
      if (!state.models.some(function (m) { return m.id === state.modelId; })) {
        state.modelId = data.models[0].id;
      }
    }
    save();
  }

  function d2SaveProviderFlow(silent) {
    var p = d2ProviderFind(providerDetailId);
    if (!p) return;
    collectProviderForm(p);
    var norm = d2NormProvider(p.baseUrl, p.apiPath, p.protocol);
    p.baseUrl = norm.baseUrl;
    p.apiPath = norm.apiPath;
    p.protocol = norm.protocol;
    d2RenderUrlHint(norm);
    if (!SERVER_MODE || !serverOnline) {
      save();
      renderProviderDetail();
      renderMe();
      if (!silent) toast('已保存（离线演示模式：连不上后端，无法自动识别模型）。');
      return;
    }
    var savedKey = pendingProviderKey;
    pendingProviderKey = null;
    var payload = {
      name: p.name, baseUrl: p.baseUrl, apiPath: p.apiPath, protocol: p.protocol,
      enabled: !!p.enabled, advanced: p.advanced || {}, extras: p.extras || {}
    };
    var chain = Promise.resolve();
    if (savedKey !== null && savedKey !== undefined) {
      chain = serverFetch('/providers/' + encodeURIComponent(p.id) + '/key', { method: 'POST', body: { apiKey: savedKey } }).then(function (data) {
        p.hasKey = !!data.hasKey;
        p.keyMasked = data.keyMasked || '';
      });
    }
    chain = chain.then(function () {
      return serverFetch('/providers/' + encodeURIComponent(p.id), { method: 'PUT', body: { provider: payload } });
    });
    chain = chain.then(function () {
      return serverFetch('/providers/' + encodeURIComponent(p.id) + '/save-connect', { method: 'POST', body: { provider: payload, advanced: p.advanced || {} } });
    }).then(function (data) {
      d2ApplySaveConnectResult(p, data);
      renderProviderDetail();
      renderMe();
      closeSheet();
      openSheet('d2ConnectResult', data);
      if (!silent) toast(data.message || '已保存。');
    }).catch(function (err) {
      save();
      renderProviderDetail();
      if (!silent) toast(err.message || '保存没成功，检查网址和 Key 再试一次。');
    });
  }

  /* 聊天里 400 兜底后：把这个「模型 + 档位」标记为这家不支持，以后不再发送 */
  function d2OnServerFallback(removed, level) {
    var model = currentModel();
    var provider = model ? providerOf(model) : null;
    if (!model || !provider) return;
    if (!provider.advanced) provider.advanced = {};
    if (!provider.advanced.unsupportedReasoning) provider.advanced.unsupportedReasoning = {};
    provider.advanced.unsupportedReasoning[model.id + '|' + (level || 'auto')] = true;
    save();
    toast('这家不支持「' + (reasonLabel(level) || '这个') + '」档，已自动关闭，以后不再发送。');
  }

  function d2DowngradeLevel(model, level) {
    if (!model || !level || level === 'auto' || level === 'off') return level;
    var provider = providerOf(model);
    var map = provider && provider.advanced && provider.advanced.unsupportedReasoning;
    if (map && map[model.id + '|' + level]) return 'auto';
    return level;
  }

  function d2ForwardModeOptionsHtml(current) {
    return D2_FORWARD_MODES.map(function (m) {
      return '<option value="' + m.id + '"' + (m.id === (current || 'auto') ? ' selected' : '') + '>' + esc(m.label) + '</option>';
    }).join('');
  }

  function d2ForwardModeHint(current) {
    for (var i = 0; i < D2_FORWARD_MODES.length; i++) if (D2_FORWARD_MODES[i].id === current) return D2_FORWARD_MODES[i].hint;
    return D2_FORWARD_MODES[0].hint;
  }

  function d2AfterProviderDetail(p) {
    if (!p) return;
    var baseEl = document.getElementById('provBase');
    if (baseEl) {
      var host = baseEl.closest ? (baseEl.closest('.form-row__main') || baseEl.closest('.form-row')) : null;
      if (host && !document.getElementById('d2UrlHint')) {
        var hint = document.createElement('p');
        hint.className = 'd2-url-hint';
        hint.id = 'd2UrlHint';
        host.appendChild(hint);
      }
    }
    d2RenderUrlHint(d2NormProvider(p.baseUrl, p.apiPath, p.protocol));
    var check = document.getElementById('d2UrlNormalizeBtn');
    if (check) check.removeAttribute('disabled');
  }

  function d2InitProviders() {
    /* 覆盖测试连接弹层：先提示费用，再测试 */
    SHEETS.connTest = function () {
      var p = d2ProviderFind(providerDetailId);
      if (!p) return null;
      var ownModels = (state.models || []).filter(function (m) { return m.providerId === p.id; });
      var current = ownModels.filter(function (m) { return m.id === state.modelId; })[0] || ownModels[0];
      var cached = d2CachedTestLine(p);
      return {
        title: '测试连接',
        body: (cached || '') +
          '<p class="sheet-label">要测的模型</p>' +
          '<div class="bind-mini"><span class="d2-model-chip">' + (current ? d2ModelIconHtml(current) : '') + '<span>' + esc(current ? (current.name || current.modelId) : '还没有模型') + '</span></span>' +
            '<span class="a2-tag a2-tag--muted">' + (current && current.modelId ? esc(current.modelId) : '先拉取或添加一个模型') + '</span></div>' +
          '<div class="d2-cost-warn">' +
            '<p><b>会发一条测试消息</b>，按次计费的接口可能扣一次费。</p>' +
            '<p class="d2-cost-sub">这不是生成聊天内容，只是一句 "hi"，max tokens 很小。</p>' +
          '</div>' +
          '<div class="toggle-row">' +
            '<div class="toggle-row__main"><span class="toggle-row__label">同时检测思考档位</span><span class="toggle-row__sub">每个可用档位各发一条，会额外产生几次请求费用</span></div>' +
            '<button class="switch" id="d2TestReasoning" type="button" role="switch" aria-checked="false" aria-label="同时检测思考档位"><span></span></button>' +
          '</div>' +
          '<div id="d2TestBody"></div>' +
          '<p class="a2-note">失败只给一句中文原因和下一步；结果和时间会缓存在这家提供商里。</p>',
        foot: '<button class="btn" type="button" data-close>取消</button>' +
          '<button class="btn btn--primary" type="button" data-d2-test-start>开始测试</button>'
      };
    };

    SHEETS.d2ConnectResult = function (data) { return d2ConnectResultSheet(data || {}); };

    document.addEventListener('focusout', function (e) {
      var el = e.target;
      if (el && el.id === 'provBase') d2NormalizeProviderForm(false);
    }, true);

    document.addEventListener('change', function (e) {
      var el = e.target;
      if (!el) return;
      if (el.id === 'provProtocol') {
        var p = d2ProviderFind(providerDetailId);
        if (!p) return;
        var pathEl = document.getElementById('provPath');
        var proto = el.value;
        if (pathEl && (!pathEl.value.trim() || Object.keys(D2_PATHS).map(function (k) { return D2_PATHS[k]; }).indexOf(pathEl.value.trim()) >= 0)) {
          pathEl.value = D2_PATHS[proto] || '/chat/completions';
        }
        d2NormalizeProviderForm(false);
        save();
      }
      if (el.id === 'provForwardMode') {
        var prov = d2ProviderFind(providerDetailId);
        if (prov) {
          if (!prov.advanced) prov.advanced = {};
          prov.advanced.forwardMode = el.value;
          var hintEl = document.getElementById('d2ForwardHint');
          if (hintEl) hintEl.textContent = d2ForwardModeHint(el.value);
          save();
        }
      }
    }, true);

    document.addEventListener('click', function (e) {
      var el = e.target && e.target.closest ? e.target.closest('[data-d2-test-start]') : null;
      if (el) { d2RunTestConnection(); return; }
      var toggle = e.target && e.target.closest ? e.target.closest('#d2TestReasoning') : null;
      if (toggle) {
        var on = toggle.getAttribute('aria-checked') !== 'true';
        toggle.setAttribute('aria-checked', String(on));
        return;
      }
    }, false);
  }

  document.addEventListener('DOMContentLoaded', function () {
    setTimeout(d2InitProviders, 0);
  });
