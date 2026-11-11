/* 提示词预设：取用 / 列表 / 编辑 / 绑定 / 导入导出 / 拼装顺序预览。
 *
 * 从 src/app.js 的五个「预设」分节整块拆出。构建时 build.mjs 会把本文件
 * 拼进 app.js 的模块注入点，仍处于同一个 IIFE 作用域，函数声明照旧互相可见；
 * 块内没有顶层语句，不依赖 app.js 的初始化顺序。
 */

/* ---- 预设状态（原先散在 app.js 的 A2 状态区）---- */
  var presetDetailId = '';
  var presetPending = null;

  /* ---------------- 提示词预设：取用与列表 ---------------- */
  function defaultPreset() {
    return findPreset(state.settings.defaultPresetId) || state.promptPresets[0] || null;
  }
  function resolvedPreset(chat, char) {
    if (chat && chat.presetId) {
      var p = findPreset(chat.presetId);
      if (p) return { preset: p, source: 'chat' };
    }
    if (char && char.defaultPresetId) {
      var q = findPreset(char.defaultPresetId);
      if (q) return { preset: q, source: 'char' };
    }
    return { preset: defaultPreset(), source: 'global' };
  }
  function presetSourceLabel(source, char) {
    if (source === 'chat') return '这场指定';
    if (source === 'char') return (char ? char.name : '角色') + '的默认';
    return '全局默认';
  }
  function presetUsageCount(id) {
    var n = 0;
    state.characters.forEach(function (c) { if (c.defaultPresetId === id) n += 1; });
    Object.keys(state.chats).forEach(function (cid) { if (state.chats[cid] && state.chats[cid].presetId === id) n += 1; });
    return n;
  }
  function samplingSummary(p) {
    var s = (p && p.sampling) || {};
    var bits = [];
    if (s.temperature !== null && s.temperature !== undefined) bits.push('温度 ' + s.temperature);
    if (s.max_tokens !== null && s.max_tokens !== undefined) bits.push('最多 ' + s.max_tokens + ' tok');
    if (s.context_messages !== null && s.context_messages !== undefined) bits.push('上下文 ' + s.context_messages + ' 条');
    return bits.length ? bits.join(' · ') : '采样参数跟模型默认';
  }

  function renderPresets() {
    var title = document.getElementById('presetTitle');
    if (!title) return;
    if (presetDetailId) { renderPresetDetail(); return; }
    title.textContent = '提示词预设';
    var bar = document.getElementById('presetBar');
    if (bar) { bar.classList.remove('is-show'); bar.innerHTML = ''; }
    var box = document.getElementById('presetScroll');
    if (!box) return;
    var cards = state.promptPresets.map(function (p) {
      var isDefault = state.settings.defaultPresetId === p.id;
      var used = presetUsageCount(p.id);
      var tags = '';
      if (isDefault) tags += '<span class="a2-tag">全局默认</span>';
      if (p.builtin) tags += '<span class="a2-tag a2-tag--muted">内置</span>';
      if (p.source === 'tavern') tags += '<span class="a2-tag a2-tag--muted">酒馆导入</span>';
      if (used) tags += '<span class="a2-tag a2-tag--muted">' + used + ' 处在用</span>';
      return '<button class="preset-card" type="button" data-a2="preset-open" data-id="' + esc(p.id) + '">' +
        '<span class="preset-card__main">' +
          '<span class="preset-card__name">' + esc(p.name) + '</span>' +
          '<span class="preset-card__desc">' + esc(p.desc || samplingSummary(p)) + '</span>' +
          '<span class="preset-card__meta">' + tags + '<span class="a2-tag a2-tag--muted">' + (p.fragments || []).length + ' 条片段</span></span>' +
        '</span>' + LIB_CHEV +
      '</button>';
    }).join('');
    box.innerHTML =
      '<div class="a2-toolbar">' +
        '<button class="lib-action lib-action--primary" type="button" data-action="new-preset">' + IC_PLUS_A2 + '新建</button>' +
        '<button class="lib-action" type="button" data-action="import-preset">' + IC_IMPORT_A2 + '导入</button>' +
        '<button class="lib-action" type="button" data-action="export-presets">导出</button>' +
      '</div>' +
      '<div class="a2-banner">' + IC_INFO_A2 +
        '<span>取用顺序：这场聊天指定 &gt; 角色默认 &gt; 全局默认。预设只改文风与采样参数，不碰角色设定。</span></div>' +
      '<div class="prov-list">' + cards + '</div>' +
      '<p class="a2-note">导入支持酒馆（SillyTavern）的预设 JSON：prompts / prompt_order 结构和 temperature、top_p 等字段。</p>';
  }

  function renderPresetDetail() {
    var p = findPreset(presetDetailId);
    if (!p) { presetDetailId = ''; renderPresets(); return; }
    var title = document.getElementById('presetTitle');
    if (title) title.textContent = p.name;
    var bar = document.getElementById('presetBar');
    if (bar) {
      bar.classList.add('is-show');
      bar.innerHTML =
        '<button class="btn btn--soft" type="button" data-action="copy-preset">复制</button>' +
        '<button class="btn btn--danger" type="button" data-action="delete-preset">删除</button>' +
        '<button class="btn btn--primary" type="button" data-action="save-preset">保存</button>';
    }
    var box = document.getElementById('presetScroll');
    if (!box) return;
    var frags = (p.fragments || []).slice().sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
    var fragRows = frags.map(function (f) {
      return '<div class="frag-row">' +
        '<span class="role-dot role-dot--' + esc(f.role || 'system') + '"></span>' +
        '<div class="frag-row__main">' +
          '<span class="frag-row__title">' + esc(f.title) + '</span>' +
          '<span class="frag-row__meta">' +
            '<span class="a2-tag">' + esc(fragRoleLabel(f.role)) + '</span>' +
            '<span class="a2-tag a2-tag--muted">' + esc(fragPositionLabel(f)) + '</span>' +
            '<span class="a2-tag a2-tag--muted">顺序 ' + esc(f.order || 0) + '</span>' +
          '</span>' +
          '<p class="frag-body">' + esc(f.content) + '</p>' +
        '</div>' +
        '<button class="switch" type="button" role="switch" data-a2="frag-toggle" data-id="' + esc(p.id + ':' + f.id) + '" aria-checked="' + (f.enabled !== false ? 'true' : 'false') + '" aria-label="启用片段"><span></span></button>' +
        '<button class="mini-btn" type="button" data-a2="frag-open" data-id="' + esc(p.id + ':' + f.id) + '">改</button>' +
      '</div>';
    }).join('');
    var s = p.sampling || {};
    function pv(v) { return v === null || v === undefined ? '' : v; }
    box.innerHTML =
      '<div class="a2-banner">' + IC_INFO_A2 +
        '<span>这个预设共有 ' + frags.length + ' 条片段。位置决定它拼进提示词的哪一段；「不设置」的参数会用模型默认。</span></div>' +
      '<div class="a2-card form-card">' +
        a2InputRow('名称', '<input class="field field--title" id="presetName" type="text" value="' + esc(p.name) + '">') +
        a2InputRow('说明', '<input class="field" id="presetDesc" type="text" value="' + esc(p.desc || '') + '" placeholder="一句话说明这个预设的用途">') +
        '<div class="form-row"><span class="form-row__label">全局默认</span><div class="form-row__main"><p class="form-row__hint" style="margin:0">没有角色默认、这场也没指定时用它</p></div>' +
          '<button class="mini-btn" type="button" data-a2="preset-default" data-id="' + esc(p.id) + '">' + (state.settings.defaultPresetId === p.id ? '已是默认' : '设为默认') + '</button></div>' +
      '</div>' +
      '<div class="a2-card">' +
        '<div class="a2-card__head"><span class="label">提示词片段 · ' + frags.length + ' 条</span>' +
          '<button class="text-btn" type="button" data-a2="frag-new" data-id="' + esc(p.id) + '">+ 添加</button></div>' +
        (fragRows || '<p class="a2-empty">还没有片段。点右上角「添加」写第一条。</p>') +
      '</div>' +
      '<div class="a2-card">' +
        '<div class="a2-card__head"><span class="label">采样参数</span><span class="a2-sub">留空 = 不设置</span></div>' +
        '<div class="param-edit"><span class="param-edit__label">温度（0–2）</span><input class="field" id="spTemp" type="number" inputmode="decimal" value="' + esc(pv(s.temperature)) + '" placeholder="不设置"></div>' +
        '<div class="param-edit"><span class="param-edit__label">Top P（0–1）</span><input class="field" id="spTopP" type="number" inputmode="decimal" value="' + esc(pv(s.top_p)) + '" placeholder="不设置"></div>' +
        '<div class="param-edit"><span class="param-edit__label">最大输出 Token</span><input class="field" id="spMax" type="number" inputmode="numeric" value="' + esc(pv(s.max_tokens)) + '" placeholder="不设置"></div>' +
        '<div class="param-edit"><span class="param-edit__label">上下文消息条数</span><input class="field" id="spCtx" type="number" inputmode="numeric" value="' + esc(pv(s.context_messages)) + '" placeholder="不设置"></div>' +
        '<div class="param-edit"><span class="param-edit__label">频率惩罚</span><input class="field" id="spFreq" type="number" inputmode="decimal" value="' + esc(pv(s.frequency_penalty)) + '" placeholder="不设置"></div>' +
        '<div class="param-edit"><span class="param-edit__label">存在惩罚</span><input class="field" id="spPres" type="number" inputmode="decimal" value="' + esc(pv(s.presence_penalty)) + '" placeholder="不设置"></div>' +
        '<div class="param-edit"><span class="param-edit__label">流式输出</span><div class="form-row__main"><p class="form-row__hint" style="margin:0">打字机效果；配合 stream_options 才能拿到 usage</p></div>' +
          '<button class="switch" id="spStream" type="button" role="switch" aria-checked="' + (s.stream !== false ? 'true' : 'false') + '" aria-label="流式输出"><span></span></button></div>' +
      '</div>' +
      '<div class="a2-card"><div class="a2-card__head"><span class="label">这个预设还能做什么</span></div>' +
        '<div class="bind-mini"><span class="bind-mini__main"><span class="bind-mini__label">导出</span><span class="bind-mini__value">本应用 JSON，方便备份和带去别处</span></span>' +
          '<button class="mini-btn" type="button" data-a2="preset-export" data-id="' + esc(p.id) + '">导出</button></div>' +
        '<div class="bind-mini"><span class="bind-mini__main"><span class="bind-mini__label">绑到角色</span><span class="bind-mini__value">角色详情里可以设「默认文风」</span></span>' +
          '<button class="mini-btn" type="button" data-nav="characters">角色库</button></div>' +
      '</div>';
  }

  function fragRoleLabel(role) {
    if (role === 'user') return '用户';
    if (role === 'assistant') return '助手';
    return '系统';
  }
  function fragPositionLabel(f) {
    if (f.position === 'after_char') return '角色设定之后';
    if (f.position === 'depth') return '倒数第 ' + (f.depth || 2) + ' 条（深度注入）';
    if (f.position === 'after_user') return '用户这句话之后';
    return '角色设定之前';
  }
  function fragPositionOptions(selected) {
    return [
      { id: 'before_char', label: '角色设定之前' },
      { id: 'after_char', label: '角色设定之后' },
      { id: 'depth', label: '聊天记录里倒数第 N 条（深度注入）' },
      { id: 'after_user', label: '用户这句话之后' }
    ].map(function (o) {
      return '<option value="' + o.id + '"' + (o.id === selected ? ' selected' : '') + '>' + esc(o.label) + '</option>';
    }).join('');
  }

  /* ---------------- 预设编辑 ---------------- */
  function createPresetDraft() {
    var p = {
      id: newId('preset'), name: '新的预设', desc: '', builtin: false, source: 'user',
      fragments: [],
      sampling: { temperature: null, top_p: null, max_tokens: null, context_messages: null, stream: true, frequency_penalty: null, presence_penalty: null },
      extras: {}
    };
    state.promptPresets.push(p);
    save();
    presetDetailId = p.id;
    renderPresets();
    toast('先填名字和片段，再点保存。');
  }
  function savePresetDetail() {
    var p = findPreset(presetDetailId);
    if (!p) return;
    var el;
    el = document.getElementById('presetName'); if (el && el.value.trim()) p.name = el.value.trim();
    el = document.getElementById('presetDesc'); if (el) p.desc = el.value.trim();
    function num(id) {
      var e = document.getElementById(id);
      if (!e || String(e.value).trim() === '') return null;
      var n = parseFloat(e.value);
      return isNaN(n) ? null : n;
    }
    var prevStream = p.sampling && p.sampling.stream !== false;
    p.sampling = {
      temperature: num('spTemp'),
      top_p: num('spTopP'),
      max_tokens: num('spMax'),
      context_messages: num('spCtx'),
      frequency_penalty: num('spFreq'),
      presence_penalty: num('spPres'),
      stream: document.getElementById('spStream') ? document.getElementById('spStream').getAttribute('aria-checked') === 'true' : prevStream
    };
    save();
    renderPresetDetail();
    renderChatContext();
    renderMe();
    toast('预设已保存。');
  }
  function setGlobalPreset(id) {
    var p = findPreset(id);
    if (!p) return;
    state.settings.defaultPresetId = id;
    save();
    renderPresetDetail();
    renderChatContext();
    renderMe();
    toast('「' + p.name + '」现在是全局默认文风。');
  }
  function copyPreset(id) {
    var p = findPreset(id);
    if (!p) return;
    var copy = clone(p);
    copy.id = newId('preset');
    copy.name = uniquePresetName(p.name + '（副本）');
    copy.builtin = false;
    copy.source = 'copy';
    copy.fragments = (p.fragments || []).map(function (f) {
      var nf = clone(f);
      nf.id = newId('frag');
      return nf;
    });
    state.promptPresets.push(copy);
    save();
    presetDetailId = copy.id;
    renderPresets();
    toast('复制好了。');
  }
  function uniquePresetName(base) {
    var name = base;
    var n = 1;
    while (state.promptPresets.some(function (p) { return p.name === name; })) { n += 1; name = base + '（' + n + '）'; }
    return name;
  }
  function deletePreset() {
    var p = findPreset(presetDetailId);
    if (!p) return;
    openSheet('confirm', {
      title: '删除预设？',
      text: '用过它的角色和聊天会回到全局默认，删掉就找不回来了。',
      label: '删除', run: 'delete-preset', id: p.id
    });
  }
  function openFragEditor(ref) {
    fragRef = ref;
    openSheet('fragEdit');
  }
  SHEETS.fragEdit = function () {
    var parts = String(fragRef || '').split(':');
    var presetId = parts[0];
    var fragId = parts[1] || '';
    var preset = findPreset(presetId);
    if (!preset) return null;
    var f = fragId ? byId(preset.fragments, fragId) : null;
    var draft = f || {
      title: '', content: '', role: 'system', position: 'before_char', depth: 2,
      enabled: true, order: (preset.fragments || []).length * 10 + 10
    };
    return {
      title: f ? '编辑提示词片段' : '新建提示词片段',
      body: '<p class="sheet-note" style="text-align:left;margin-top:0">在《' + esc(preset.name) + '》里</p>' +
        '<label class="field-label" for="fragTitle">标题</label>' +
        '<input class="field field--title" id="fragTitle" type="text" value="' + esc(draft.title) + '" placeholder="例如：文风 · 细腻散文">' +
        '<label class="field-label" for="fragContent">内容</label>' +
        '<textarea class="field" id="fragContent" style="min-height:120px" placeholder="要注入给模型的话">' + esc(draft.content) + '</textarea>' +
        '<label class="field-label" for="fragRole">角色</label>' +
        '<select class="field" id="fragRole">' +
          '<option value="system"' + (draft.role === 'system' ? ' selected' : '') + '>系统 system</option>' +
          '<option value="user"' + (draft.role === 'user' ? ' selected' : '') + '>用户 user</option>' +
          '<option value="assistant"' + (draft.role === 'assistant' ? ' selected' : '') + '>助手 assistant</option>' +
        '</select>' +
        '<label class="field-label" for="fragPosition">位置</label>' +
        '<select class="field" id="fragPosition">' + fragPositionOptions(draft.position) + '</select>' +
        '<label class="field-label" for="fragDepth">深度（仅位置选「深度注入」时有意义）</label>' +
        '<input class="field" id="fragDepth" type="number" inputmode="numeric" value="' + esc(draft.depth || 2) + '" placeholder="2">' +
        '<label class="field-label" for="fragOrder">顺序</label>' +
        '<input class="field" id="fragOrder" type="number" inputmode="numeric" value="' + esc(draft.order || 0) + '">' +
        a2SwitchRow('fragEnabled', '启用这条', '关掉后不参与拼装', draft.enabled !== false),
      foot: (f ? '<button class="btn btn--danger" type="button" data-a2="frag-del" data-id="' + esc(presetId + ':' + fragId) + '">删除</button>' : '') +
        '<button class="btn" type="button" data-close>取消</button>' +
        '<button class="btn btn--primary" type="button" data-action="save-frag">保存</button>'
    };
  };
  function saveFrag() {
    var parts = String(fragRef || '').split(':');
    var preset = findPreset(parts[0]);
    var fragId = parts[1] || '';
    if (!preset) return;
    var f = fragId ? byId(preset.fragments, fragId) : null;
    var titleEl = document.getElementById('fragTitle');
    var contentEl = document.getElementById('fragContent');
    var title = titleEl && titleEl.value.trim() ? titleEl.value.trim() : '未命名片段';
    var content = contentEl ? contentEl.value : '';
    if (!f) {
      f = { id: newId('frag'), title: '', content: '', role: 'system', position: 'before_char', depth: 2, enabled: true, order: 0 };
      preset.fragments.push(f);
    }
    f.title = title;
    f.content = content;
    f.role = document.getElementById('fragRole') ? document.getElementById('fragRole').value : 'system';
    f.position = document.getElementById('fragPosition') ? document.getElementById('fragPosition').value : 'before_char';
    f.depth = document.getElementById('fragDepth') ? (parseInt(document.getElementById('fragDepth').value, 10) || 2) : 2;
    f.order = document.getElementById('fragOrder') ? (parseInt(document.getElementById('fragOrder').value, 10) || 0) : 0;
    f.enabled = document.getElementById('fragEnabled') ? document.getElementById('fragEnabled').getAttribute('aria-checked') === 'true' : true;
    save();
    closeSheet();
    if (presetDetailId) renderPresetDetail();
    renderChatContext();
    toast('片段已保存。');
  }
  function toggleFrag(ref) {
    var parts = String(ref || '').split(':');
    var preset = findPreset(parts[0]);
    var f = preset ? byId(preset.fragments, parts[1]) : null;
    if (!f) return;
    f.enabled = f.enabled === false;
    save();
    renderPresetDetail();
    renderChatContext();
  }
  function deleteFrag(ref) {
    var parts = String(ref || '').split(':');
    var preset = findPreset(parts[0]);
    if (!preset) return;
    preset.fragments = preset.fragments.filter(function (f) { return f.id !== parts[1]; });
    save();
    closeSheet();
    renderPresetDetail();
    renderChatContext();
    toast('片段已删掉。');
  }

  /* ---------------- 预设：绑定这场聊天 / 角色默认 ---------------- */
  SHEETS.presetSwitch = function () {
    var char = currentChar();
    if (!char) return null;
    var chat = ensureChat(char.id);
    var fallback = resolvedPreset(null, char);
    var list = '<button class="option' + (!chat.presetId ? ' is-selected' : '') + '" type="button" data-a2="preset-pick" data-id="">' +
      '<span class="option__mark" aria-hidden="true">默</span>' +
      '<span class="option__main"><span class="option__title">跟随默认（' + esc(fallback.preset ? fallback.preset.name : '默认') + '）</span>' +
      '<span class="option__desc">这场不单独指定文风</span></span>' +
      '<span class="option__source">' + esc(presetSourceLabel(fallback.source, char)) + '</span></button>';
    state.promptPresets.forEach(function (p) {
      var src = '';
      if (char.defaultPresetId === p.id) src = '角色默认';
      else if (state.settings.defaultPresetId === p.id) src = '全局默认';
      list += '<button class="option' + (chat.presetId === p.id ? ' is-selected' : '') + '" type="button" data-a2="preset-pick" data-id="' + esc(p.id) + '">' +
        '<span class="option__mark" aria-hidden="true">文</span>' +
        '<span class="option__main"><span class="option__title">' + esc(p.name) + '</span><span class="option__desc">' + esc(samplingSummary(p)) + '</span></span>' +
        (src ? '<span class="option__source">' + esc(src) + '</span>' : '') + '</button>';
    });
    var ask = '';
    if (presetPending) {
      var pp = findPreset(presetPending);
      if (pp) {
        ask = '<div class="ask-card" style="margin-top:12px">' +
          '<p class="ask-card__text">「' + esc(pp.name) + '」只改这场聊天，还是同时设为 ' + esc(char.name) + ' 以后的默认文风？</p>' +
          '<div class="ask-actions">' +
            '<button class="btn btn--soft" type="button" data-a2="preset-apply" data-value="chat">只改这场</button>' +
            '<button class="btn btn--primary" type="button" data-a2="preset-apply" data-value="char">同时设为默认</button>' +
          '</div></div>';
      }
    }
    return {
      title: '这场聊天的文风',
      body: '<p class="sheet-label">' + esc(char.name) + ' 的聊天用哪个提示词预设</p>' +
        '<div class="option-list">' + list + '</div>' + ask +
        '<p class="sheet-note">取的顺序：这场指定 &gt; 角色默认 &gt; 全局默认。预设不会和角色库混在一起。</p>'
    };
  };
  function pickPresetForChat(id) {
    var char = currentChar();
    if (!char) return;
    var chat = ensureChat(char.id);
    if (!id) {
      chat.presetId = '';
      presetPending = null;
      save();
      closeSheet();
      renderChatContext();
      toast('这场跟随默认文风。');
      return;
    }
    chat.presetId = id;
    presetPending = id;
    save();
    openSheet('presetSwitch');
  }
  function applyPresetBinding(mode) {
    var char = currentChar();
    if (!char || !presetPending) return;
    var chat = ensureChat(char.id);
    var p = findPreset(presetPending);
    chat.presetId = presetPending;
    if (mode === 'char') char.defaultPresetId = presetPending;
    save();
    closeSheet();
    presetPending = null;
    renderChatContext();
    renderPresets();
    renderMe();
    toast(mode === 'char'
      ? '这场用「' + p.name + '」，' + char.name + ' 以后的聊天也默认用它。'
      : '这场聊天用「' + p.name + '」。');
  }

  /* ---------------- 预设：导入 / 导出 ---------------- */
  function handlePresetFile(file) {
    if (SERVER_MODE && serverOnline) {
      readFileText(file).then(function (text) {
        var raw = tryParseJson(text);
        if (!raw) { toast('这不是一份能读的预设文件。'); return; }
        serverFetch('/presets/import', { method: 'POST', body: { payload: raw } }).then(function (data) {
          if (data && data.preset) presetDetailId = data.preset.id;
          toast((data && data.note) ? ('已导入。' + data.note) : '预设已导入。');
          return refreshFromServer();
        }).catch(apiToast);
      }).catch(function () { toast('文件打不开，换一份再试试。'); });
      return;
    }
    readFileText(file).then(function (text) {
      var raw = tryParseJson(text);
      if (!raw) { toast('这不是一份能读的预设文件。'); return; }
      var preset;
      try { preset = normalizeTavernPreset(raw, file.name); }
      catch (err) { toast(err && err.message ? err.message : '读不出这份预设。'); return; }
      preset.name = uniquePresetName(preset.name);
      state.promptPresets.push(preset);
      save();
      presetDetailId = preset.id;
      navTo('presets');
      toast('已导入「' + preset.name + '」。不认识的字段收进了额外资料。');
    }).catch(function () { toast('文件打不开，换一份再试试。'); });
  }
  function mapTavernRole(role) {
    if (role === 1 || role === 'user') return 'user';
    if (role === 2 || role === 'assistant') return 'assistant';
    if (role === 0 || role === 'system') return 'system';
    return 'system';
  }
  function mapTavernPosition(p) {
    if (p.position === 'before_char' || p.position === 'after_char') return p.position;
    if (p.injection_position !== undefined && Number(p.injection_depth) > 0) return 'depth';
    if (p.role === 1 || p.role === 'user') return 'after_user';
    return 'before_char';
  }
  function numOrNull(v) {
    if (v === undefined || v === null || v === '') return null;
    var n = parseFloat(v);
    return isNaN(n) ? null : n;
  }
  function normalizeTavernPreset(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('这不是一份能读的预设文件。');
    var prompts = Array.isArray(raw.prompts) ? raw.prompts : null;
    var hasSampling = ['temperature', 'top_p', 'max_tokens', 'openai_max_tokens', 'frequency_penalty', 'presence_penalty', 'top_k'].some(function (k) { return k in raw; });
    if (!prompts && !hasSampling && !Array.isArray(raw.prompt_order)) {
      throw new Error('这不是酒馆格式的提示词预设。');
    }
    var frags = [];
    var byIdentifier = {};
    (prompts || []).forEach(function (p, i) {
      if (!p || typeof p !== 'object') return;
      var title = pickStr(p.name, p.title, p.comment) || ('片段 ' + (i + 1));
      var content = typeof p.content === 'string' ? p.content : '';
      if (!content.trim()) return;
      var frag = {
        id: newId('frag'), title: title, content: content,
        role: mapTavernRole(p.role),
        position: mapTavernPosition(p),
        depth: p.injection_depth !== undefined ? Math.max(1, parseInt(p.injection_depth, 10) || 2) : 2,
        enabled: p.enabled !== false,
        order: 10 + i * 10
      };
      frags.push(frag);
      if (p.identifier) byIdentifier[p.identifier] = frag;
    });
    var orderList = null;
    if (Array.isArray(raw.prompt_order) && raw.prompt_order.length) {
      var first = raw.prompt_order[0];
      if (Array.isArray(first)) orderList = first;
      else if (first && Array.isArray(first.order)) orderList = first.order;
    }
    if (orderList) {
      var ordered = [];
      var used = {};
      orderList.forEach(function (item, idx) {
        var ident = typeof item === 'string' ? item : (item && item.identifier);
        var enabled = (typeof item === 'object' && item) ? item.enabled !== false : true;
        var frag = byIdentifier[ident];
        if (frag && !used[frag.id]) {
          frag.order = 10 + idx * 10;
          frag.enabled = enabled;
          ordered.push(frag);
          used[frag.id] = 1;
        }
      });
      frags.forEach(function (f) { if (!used[f.id]) ordered.push(f); });
      frags = ordered;
    }
    var sampling = {
      temperature: numOrNull(raw.temperature),
      top_p: numOrNull(raw.top_p),
      max_tokens: numOrNull(raw.max_tokens !== undefined ? raw.max_tokens : raw.openai_max_tokens),
      context_messages: numOrNull(raw.context_messages !== undefined ? raw.context_messages : raw.chat_history_limit),
      stream: raw.stream === false || raw.streaming === false ? false : true,
      frequency_penalty: numOrNull(raw.frequency_penalty),
      presence_penalty: numOrNull(raw.presence_penalty)
    };
    var known = ['prompts', 'prompt_order', 'temperature', 'top_p', 'top_k', 'max_tokens', 'openai_max_tokens', 'context_messages', 'chat_history_limit', 'frequency_penalty', 'presence_penalty', 'name', 'preset_name', 'stream', 'streaming', 'extensions', 'extra'];
    var extras = {};
    Object.keys(raw).forEach(function (k) { if (known.indexOf(k) === -1) extras[k] = raw[k]; });
    return {
      id: newId('preset'),
      name: pickStr(raw.name, raw.preset_name) || '导入的预设',
      desc: '从酒馆导入 · ' + frags.length + ' 条片段',
      builtin: false,
      source: 'tavern',
      fragments: frags,
      sampling: sampling,
      extras: extras
    };
  }
  function exportPreset(id) {
    var p = findPreset(id);
    if (!p) return;
    if (SERVER_MODE && serverOnline) {
      serverDownload('/presets/' + encodeURIComponent(id) + '/export').then(function (blob) {
        downloadBlob('缪诗鸳杞-提示词预设-' + p.name + '.json', blob);
        toast('预设已导出。');
      }).catch(apiToast);
      return;
    }
    downloadText('缪诗鸳杞-提示词预设-' + p.name + '.json', JSON.stringify({
      app: 'miushi-yuanqi', kind: 'prompt_preset', version: 1, preset: clone(p)
    }, null, 2));
    toast('预设已导出。');
  }
  function exportAllPresets() {
    if (SERVER_MODE && serverOnline) {
      serverDownload('/presets/export').then(function (blob) {
        downloadBlob('缪诗鸳杞-提示词预设-全部.json', blob);
        toast('全部预设已导出。');
      }).catch(apiToast);
      return;
    }
    downloadText('缪诗鸳杞-提示词预设-全部.json', JSON.stringify({
      app: 'miushi-yuanqi', kind: 'prompt_presets', version: 1,
      presets: state.promptPresets.map(function (p) { return clone(p); })
    }, null, 2));
    toast('全部预设已导出。');
  }

  /* ---------------- assemblePrompt：拼装顺序演示 ---------------- */
  function presetBlockOf(f, positionLabel) {
    return {
      kind: 'preset',
      label: '预设 · ' + f.title + '（' + positionLabel + '）',
      role: f.role || 'system',
      text: f.content || ''
    };
  }
  function assemblePrompt(context) {
    var ctx = context || {};
    var char = ctx.char || currentChar();
    var chat = ctx.chat || chatOf(state.currentCharacterId) || { messages: [] };
    var rp = resolvedPersona(chat, char);
    var persona = ctx.persona || rp.persona;
    var books = ctx.books || resolvedBooksFor(chat, char);
    var rpres = resolvedPreset(chat, char);
    var preset = ctx.preset || rpres.preset;
    var model = ctx.model || currentModel();
    var frags = (((preset && preset.fragments) || []).slice()).filter(function (f) { return f.enabled !== false; })
      .sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
    var blocks = [];
    var pre = frags.filter(function (f) { return f.position === 'before_char'; });
    var afterChar = frags.filter(function (f) { return f.position === 'after_char'; });
    var depthFrags = frags.filter(function (f) { return f.position === 'depth'; });
    var afterUser = frags.filter(function (f) { return f.position === 'after_user'; });
    pre.forEach(function (f) { blocks.push(presetBlockOf(f, '前置')); });
    var charText = [];
    if (char) {
      if (char.description) charText.push(char.description);
      if (char.personality) charText.push('性格：' + char.personality);
      if (char.scenario) charText.push('情景：' + char.scenario);
    }
    blocks.push({ kind: 'char', label: '角色设定 · ' + (char ? char.name : '未选角色'), role: 'system', text: charText.join('\n') });
    afterChar.forEach(function (f) { blocks.push(presetBlockOf(f, '角色设定之后')); });
    books.forEach(function (b) {
      var entries = (b.entries || []).filter(function (e) { return e.enabled !== false; });
      if (!entries.length) return;
      blocks.push({
        kind: 'book',
        label: '世界书 · ' + b.name + '（' + entries.length + ' 条）',
        role: 'system',
        text: entries.map(function (e) { return '· ' + (e.constant ? '常开 · ' : '') + e.title + '：' + e.content; }).join('\n')
      });
    });
    blocks.push({ kind: 'user', label: '用户设定 · ' + (persona ? persona.name : '未设置'), role: 'system', text: persona ? persona.description : '' });
    var limit = preset && preset.sampling && preset.sampling.context_messages ? preset.sampling.context_messages : 12;
    var msgs = (chat.messages || []).slice(-limit);
    var total = msgs.length;
    var insertBefore = {};
    depthFrags.forEach(function (f) {
      var depth = Math.max(1, parseInt(f.depth, 10) || 2);
      var idx = Math.max(0, total - depth);
      if (!insertBefore[idx]) insertBefore[idx] = [];
      insertBefore[idx].push(f);
    });
    msgs.forEach(function (msg, idx) {
      if (insertBefore[idx]) {
        insertBefore[idx].forEach(function (f) { blocks.push(presetBlockOf(f, '深度注入 · 倒数第 ' + (parseInt(f.depth, 10) || 2) + ' 条')); });
      }
      blocks.push({
        kind: 'chat',
        label: msg.role === 'ai' ? (char ? char.name : '角色') : (persona ? persona.name : '我'),
        role: msg.role === 'ai' ? 'assistant' : 'user',
        text: msg.text || ''
      });
    });
    afterUser.forEach(function (f) { blocks.push(presetBlockOf(f, '用户这句话之后 / 后置')); });
    var chars = blocks.reduce(function (n, b) { return n + (b.text || '').length; }, 0);
    var text = blocks.map(function (b) { return '[' + b.label + ']\n' + b.text; }).join('\n\n');
    return {
      blocks: blocks,
      text: text,
      chars: chars,
      tokens: Math.max(1, Math.round(chars / 2.2)),
      meta: {
        model: model ? model.name : '',
        preset: preset ? preset.name : '',
        presetSource: presetSourceLabel(rpres.source, char),
        persona: persona ? persona.name : '',
        books: books.map(function (b) { return b.name; })
      }
    };
  }
  function promptPreviewHtml(out, fromServer) {
    var meta = out.meta || {};
    var blocks = out.blocks || [];
    var html = '<div class="preview-stats">' +
      '<span class="a2-tag">模型 · ' + esc(meta.model || '未选') + '</span>' +
      '<span class="a2-tag">文风 · ' + esc(meta.preset || '默认') + '</span>' +
      '<span class="a2-tag a2-tag--muted">' + blocks.length + ' 段 · 约 ' + fmtNum(out.tokens || 0) + ' tok</span>' +
    '</div>';
    var chatCount = 0;
    blocks.forEach(function (b) {
      if (b.kind === 'chat') {
        chatCount += 1;
        var text = String(b.text || '');
        html += '<div class="preview-chat"><span class="preview-chat__role">' + (b.role === 'assistant' ? '她' : '我') + '</span>' +
          '<p class="preview-chat__text">' + esc(text.length > 110 ? text.slice(0, 110) + '…' : text) + '</p></div>';
        return;
      }
      html += '<div class="preview-block preview-block--' + esc(b.kind) + '">' +
        '<div class="preview-block__head"><span class="preview-block__label">' + esc(b.label) + '</span>' +
          '<span class="preview-block__role">' + esc(b.role || '') + '</span></div>' +
        '<p class="preview-block__text">' + esc(b.text || '（空）') + '</p></div>';
    });
    var banner = fromServer
      ? '<span>这是后端真正会发给模型的内容：预设前置 → 角色设定 → 世界书（常开 + 关键词命中）→ 用户设定 → 现在卡与记忆 → 聊天记录（含深度注入）→ 预设后置 → 当前用户句。世界书按预算裁过。</span>'
      : '<span>离线模式：用当前本地状态拼装，顺序与后端一致；连上后端后会显示服务器拼装结果。</span>';
    return {
      title: '这次发给模型的内容',
      body: '<div class="a2-banner">' + IC_INFO_A2 + banner + '</div>' + html +
        '<p class="a2-note">一共 ' + chatCount + ' 条聊天记录。</p>'
    };
  }
  SHEETS.previewPrompt = function () {
    var content = promptPreviewHtml(assemblePrompt({}), false);
    content.foot = '<button class="btn" type="button" data-close>知道了</button>';
    return content;
  };
  SHEETS.previewLoading = function () {
    return {
      title: '这次发给模型的内容',
      body: '<p class="a2-sub">正在向后端要拼装结果…</p>',
      foot: '<button class="btn" type="button" data-close>取消</button>'
    };
  };
  SHEETS.previewServer = function (payload) {
    var content = promptPreviewHtml(payload || {}, true);
    var reasoning = payload && payload.reasoning;
    var reasoningLine = '';
    if (reasoning) {
      reasoningLine = '<p class="a2-note">思考档位：' + esc((middleReasonText(reasoning.level))) + ' · ' +
        (reasoning.params ? esc(JSON.stringify(reasoning.params)) : '这次请求里不带思考参数') + '</p>';
    }
    content.body += reasoningLine;
    content.foot = '<button class="btn" type="button" data-close>知道了</button>';
    return content;
  };
  function middleReasonText(level) {
    var map = { off: '关闭', auto: '自动', low: '低', medium: '中', high: '高', max: '最高', on: '开启' };
    return map[level] || '关闭';
  }
  function openPromptPreview() {
    var char = currentChar();
    if (!char) { toast('先选一位角色。'); return; }
    if (!serverOnline) { openSheet('previewPrompt'); return; }
    openSheet('previewLoading');
    serverFetch('/chats/' + encodeURIComponent(char.id) + '/prompt-preview').then(function (data) {
      openSheet('previewServer', data);
    }).catch(function (err) { closeSheet(); apiToast(err); });
  }
