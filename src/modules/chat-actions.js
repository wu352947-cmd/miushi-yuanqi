  /* =========================================================================
     第三块 · 聊天页收纳菜单 / 单条消息操作 / 分支 / 检查点 / 作者注释 /
     重新生成 / 续写 / AI 帮答 / 多选删除
     模块和 app.js 同作用域（构建时注入），运行时可直接用 state / save / openSheet 等。
     ========================================================================= */

  var D2_MSG_SELECT = { on: false, ids: {} };
  var D2_MSG_TARGET = null;
  var D2_IMPERSONATE_TEXT = '';
  var D2_MSG_LOCAL_SEQ = 1;

  function d2caActiveChat() {
    if (typeof d2ActiveChat === 'function') return d2ActiveChat(state.currentCharacterId);
    return state.chats[state.currentCharacterId] || null;
  }

  function d2caServer() {
    return !!(SERVER_MODE && serverOnline);
  }

  function d2caChatId() {
    var chat = d2caActiveChat();
    return chat && chat.id ? chat.id : '';
  }

  function d2caIndexById(messageId) {
    for (var i = 0; i < chatMessages.length; i++) {
      if (String(chatMessages[i].id) === String(messageId)) return i;
    }
    return -1;
  }

  function d2caLastAiIndex() {
    for (var i = chatMessages.length - 1; i >= 0; i--) {
      if (chatMessages[i].role === 'ai') return i;
    }
    return -1;
  }

  function d2caLastMessageId() {
    if (!chatMessages.length) return 0;
    return chatMessages[chatMessages.length - 1].id || 0;
  }

  function d2caNowLabel() {
    var d = new Date();
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + hm(d);
  }

  /* 本地消息补一个稳定 id，供编辑 / 删除 / 多选 / 跳转使用 */
  function d2EnsureMessageIds(list) {
    (list || []).forEach(function (m, index) {
      if (!m.id) m.id = 'local-' + (index + 1) + '-' + String(m.time || '').replace(':', '') + '-' + String(m.text || '').length;
    });
    return list;
  }

  /* ---------------- 保存检查点 ---------------- */
  function d2SaveCheckpoint() {
    var chat = d2caActiveChat();
    if (!chat) { toast('还没有对话。'); return; }
    var messageId = d2caLastMessageId();
    if (!messageId) { toast('这段对话还没有消息，先聊一句再存检查点。'); return; }
    var settings = Object.assign({}, chat.settings || {});
    var checkpoints = Array.isArray(settings.checkpoints) ? settings.checkpoints.slice() : [];
    var last = chatMessages[chatMessages.length - 1] || {};
    checkpoints.push({ messageId: messageId, at: d2caNowLabel(), title: String(last.text || '').slice(0, 30) || '检查点' });
    settings.checkpoints = checkpoints;
    if (typeof D2ChatStore !== 'undefined') {
      D2ChatStore.updateChat(chat.id, { settings: { checkpoints: checkpoints } }).then(function () {
        toast('检查点存好了，之后可以回到这里另开一段。');
        openSheet('d2Checkpoints');
      }).catch(function (err) { toast(err.message || '检查点没存上。'); });
    } else {
      chat.settings = settings;
      save();
      toast('检查点存好了。');
      openSheet('d2Checkpoints');
    }
  }

  function d2SheetCheckpoints() {
    var chat = d2caActiveChat();
    var list = (chat && chat.settings && chat.settings.checkpoints) || [];
    var rows = list.length ? list.map(function (item, index) {
      return '<div class="d2-checkpoint-row">' +
        '<span class="d2-checkpoint-row__main"><span class="d2-chat-row__title">' + esc(item.title || '检查点') + '</span>' +
          '<span class="d2-chat-row__time">' + esc(item.at || '') + '</span></span>' +
        '<button class="mini-btn" type="button" data-d2a-cp-branch="' + index + '">回到这里另开</button>' +
        '<button class="mini-btn" type="button" data-d2a-cp-del="' + index + '">删掉</button></div>';
    }).join('') : '<p class="a2-empty">还没有检查点。在聊天菜单点「保存检查点」存一个。</p>';
    return {
      title: '检查点',
      body: '<div class="d2-checkpoints">' + rows + '</div>' +
        '<p class="a2-note">回到检查点 = 从那个位置复制一段新对话，原来的对话不动。</p>',
      foot: '<button class="btn" type="button" data-close>关闭</button>'
    };
  };

  /* ---------------- 作者注释 ---------------- */
  function d2SheetAuthorNote() {
    var chat = d2caActiveChat();
    var note = (chat && chat.settings && chat.settings.authorNote) || {};
    return {
      title: '作者注释',
      body: '<p class="a2-note" style="text-align:left;margin-top:0">只对这段聊天生效的额外指令，会插进提示词的聊天记录里。</p>' +
        '<label class="field-label" for="d2AuthorNoteText">注释内容</label>' +
        '<textarea class="field" id="d2AuthorNoteText" style="min-height:110px" placeholder="例如：她这阵子说话更轻、更慢。">' + esc(note.text || '') + '</textarea>' +
        '<label class="field-label" for="d2AuthorNoteDepth">插入深度（0 = 最后一条消息之前）</label>' +
        '<input class="field" id="d2AuthorNoteDepth" type="number" inputmode="numeric" min="0" max="20" value="' + esc(String(note.depth === undefined ? 0 : note.depth)) + '">',
      foot: '<button class="btn" type="button" data-d2a-author-note-clear>清空</button>' +
        '<button class="btn btn--primary" type="button" data-d2a-author-note-save>保存</button>'
    };
  };

  function d2SaveAuthorNote(clear) {
    var chat = d2caActiveChat();
    if (!chat) return;
    var textEl = document.getElementById('d2AuthorNoteText');
    var depthEl = document.getElementById('d2AuthorNoteDepth');
    var text = clear ? '' : (textEl ? textEl.value : '');
    var depth = clear ? 0 : Math.max(0, Math.min(20, parseInt(depthEl ? depthEl.value : '0', 10) || 0));
    D2ChatStore.updateChat(chat.id, { settings: { authorNote: { text: text, depth: depth } } }).then(function () {
      closeSheet();
      toast(text ? '作者注释保存好了。' : '作者注释清掉了。');
    }).catch(function (err) { toast(err.message || '作者注释没存上。'); });
  }

  /* ---------------- 单条消息操作 ---------------- */
  function d2OpenMessageActions(messageId) {
    var index = d2caIndexById(messageId);
    if (index === -1) { toast('这条消息不在了，刷新一下再试。'); return; }
    var msg = chatMessages[index];
    D2_MSG_TARGET = { id: msg.id, index: index, role: msg.role };
    openSheet('d2MsgActions');
  }

  function d2SheetMsgActions() {
    var target = D2_MSG_TARGET;
    if (!target) return null;
    var msg = chatMessages[target.index] || {};
    var isLastAi = target.role === 'ai' && target.index === d2caLastAiIndex();
    return {
      title: '消息操作',
      body: '<p class="d2-msg-preview">' + esc(String(msg.text || '').slice(0, 80)) + '</p>' +
        '<div class="menu-list">' +
        '<button class="menu-row" type="button" data-d2a-msg-edit><span class="menu-row__icon">✎</span><span class="menu-row__main"><span class="menu-row__title">编辑这条</span><span class="menu-row__sub">改完立刻生效，标「已编辑」</span></span></button>' +
        '<button class="menu-row" type="button" data-d2a-msg-copy><span class="menu-row__icon">⧉</span><span class="menu-row__main"><span class="menu-row__title">复制</span><span class="menu-row__sub">复制到剪贴板</span></span></button>' +
        (target.role === 'ai' ? '<button class="menu-row" type="button" data-d2a-msg-regen><span class="menu-row__icon">↻</span><span class="menu-row__main"><span class="menu-row__title">重新生成</span><span class="menu-row__sub">' + (isLastAi ? '删掉这条，让模型重写' : '只能重新生成最后一条回复；这条可以「从这里分支」') + '</span></span></button>' : '') +
        '<button class="menu-row" type="button" data-d2a-msg-branch><span class="menu-row__icon">⑂</span><span class="menu-row__main"><span class="menu-row__title">从这里分支</span><span class="menu-row__sub">复制到这条为止，另开一段新对话</span></span></button>' +
        '<button class="menu-row" type="button" data-d2a-msg-delete><span class="menu-row__icon">✕</span><span class="menu-row__main"><span class="menu-row__title">删除这条</span><span class="menu-row__sub">删掉就找不回来了</span></span></button>' +
        '</div>'
    };
  };

  function d2SheetMsgEdit() {
    var target = D2_MSG_TARGET;
    if (!target) return null;
    var msg = chatMessages[target.index] || {};
    return {
      title: '编辑消息',
      body: '<textarea class="field" id="d2MsgEditText" style="min-height:150px">' + esc(msg.text || '') + '</textarea>' +
        '<p class="a2-note">保存后会在这条消息上标「已编辑」。</p>',
      foot: '<button class="btn" type="button" data-close>取消</button>' +
        '<button class="btn btn--primary" type="button" data-d2a-msg-edit-save>保存</button>'
    };
  };

  function d2CopyText(text) {
    function fallback() {
      try {
        var ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        toast('复制好了。');
      } catch (e) { toast('这个浏览器不让复制，长按消息自己选吧。'); }
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast('复制好了。'); }).catch(fallback);
    } else fallback();
  }

  /* ---------------- 重新生成 / 续写 / AI 帮答 ---------------- */
  function d2RunRegenerate() {
    var chat = d2caActiveChat();
    if (!chat) { toast('还没有对话。'); return; }
    var index = d2caLastAiIndex();
    if (index === -1) { toast('这段还没有可重新生成的回复。'); return; }
    closeSheet();
    if (!d2caServer()) {
      chatMessages.splice(index, 1);
      chat.messages = chatMessages;
      save();
      renderChat();
      localFakeReply();
      toast('（离线演示）重新生成了一条。');
      return;
    }
    chatMessages.splice(index, 1);
    chat.messages = chatMessages;
    save();
    renderChat();
    sendChat({ mode: 'regenerate' });
  }

  function d2RunContinue() {
    var chat = d2caActiveChat();
    if (!chat) { toast('还没有对话。'); return; }
    closeSheet();
    if (!d2caServer()) {
      localFakeReply();
      toast('（离线演示）接着写了一条。');
      return;
    }
    sendChat({ mode: 'continue' });
  }

  function d2RunImpersonate() {
    closeSheet();
    if (!d2caServer()) {
      toast('离线演示模式连不上模型：AI 帮答要在正式版里用。');
      return;
    }
    toast('正在替你写一条…');
    serverFetch('/chats/' + encodeURIComponent(state.currentCharacterId) + '/impersonate', {
      method: 'POST',
      body: { modelId: state.modelId, reasoningLevel: chatReasoningLevel() }
    }).then(function (data) {
      D2_IMPERSONATE_TEXT = data.text || '';
      openSheet('d2Impersonate');
    }).catch(function (err) { toast(err.message || '这次没写出来，可以自己写一条。'); });
  }

  function d2SheetImpersonate() {
    return {
      title: 'AI 帮答',
      body: '<p class="a2-note" style="text-align:left;margin-top:0">这是替「你」写的一条，确认后才会作为你的消息发出去。</p>' +
        '<div class="d2-impersonate-text">' + esc(D2_IMPERSONATE_TEXT) + '</div>',
      foot: '<button class="btn" type="button" data-d2a-impersonate-again>换一条</button>' +
        '<button class="btn" type="button" data-close>取消</button>' +
        '<button class="btn btn--primary" type="button" data-d2a-impersonate-send>采纳并发送</button>'
    };
  };

  /* ---------------- 多选删除 ---------------- */
  function d2RenderSelectBar() {
    var bar = document.getElementById('d2MsgSelectBar');
    if (!bar) return;
    var count = Object.keys(D2_MSG_SELECT.ids).filter(function (id) { return D2_MSG_SELECT.ids[id]; }).length;
    if (!D2_MSG_SELECT.on) { bar.classList.remove('is-show'); bar.innerHTML = ''; return; }
    bar.classList.add('is-show');
    bar.innerHTML = '<span class="d2-select-bar__count">已选 ' + count + ' 条</span>' +
      '<button class="btn btn--soft" type="button" data-d2a-select-cancel>取消</button>' +
      '<button class="btn btn--danger" type="button" data-d2a-select-delete>删除选中</button>';
  }

  function d2DecorateChat() {
    var list = document.getElementById('chatList');
    if (!list) return;
    if (D2_MSG_SELECT.on) list.classList.add('is-selecting'); else list.classList.remove('is-selecting');
    Array.prototype.forEach.call(list.querySelectorAll('.msg'), function (el) {
      var id = el.getAttribute('data-msg-id') || '';
      el.classList.toggle('is-msg-selected', !!(D2_MSG_SELECT.on && D2_MSG_SELECT.ids[id]));
      if (D2_MSG_SELECT.on && id) {
        if (!el.querySelector('.d2-msg-check')) {
          var box = document.createElement('button');
          box.type = 'button';
          box.className = 'd2-msg-check';
          box.setAttribute('data-d2a-msg-check', id);
          box.setAttribute('aria-pressed', D2_MSG_SELECT.ids[id] ? 'true' : 'false');
          box.setAttribute('aria-label', '选择这条消息');
          el.insertBefore(box, el.firstChild);
        } else {
          el.querySelector('.d2-msg-check').setAttribute('aria-pressed', D2_MSG_SELECT.ids[id] ? 'true' : 'false');
        }
      } else {
        var existing = el.querySelector('.d2-msg-check');
        if (existing) existing.remove();
      }
    });
    d2RenderSelectBar();
  }

  function d2ToggleSelectMode(on) {
    D2_MSG_SELECT.on = !!on;
    D2_MSG_SELECT.ids = {};
    renderChat();
    if (typeof d2DecorateChat === 'function') d2DecorateChat();
    if (on) toast('点消息多选，底部可以删除。');
  }

  function d2DeleteSelectedMessages() {
    var ids = Object.keys(D2_MSG_SELECT.ids).filter(function (id) { return D2_MSG_SELECT.ids[id]; });
    if (!ids.length) { toast('先点几条消息。'); return; }
    var chat = d2caActiveChat();
    if (!chat) return;
    d2OpenConfirm('删除选中的消息？', '删掉 ' + ids.length + ' 条消息就找不回来了。', '删除', function () {
      var chain = Promise.resolve();
      ids.forEach(function (id) {
        chain = chain.then(function () { return D2ChatStore.deleteMessage(chat.id, id); });
      });
      chain.then(function () {
        D2_MSG_SELECT.on = false;
        D2_MSG_SELECT.ids = {};
        chat.messages = chatMessages;
        save();
        renderChat();
        if (typeof d2DecorateChat === 'function') d2DecorateChat();
        toast('删掉了 ' + ids.length + ' 条消息。');
      }).catch(function (err) { toast(err.message || '删除没成功。'); });
    }, true);
  }

  /* ---------------- 聊天页收纳菜单 ---------------- */
  function d2MenuRow(attr, icon, title, sub) {
    return '<button class="menu-row" type="button" ' + attr + '>' +
      '<span class="menu-row__icon">' + icon + '</span>' +
      '<span class="menu-row__main"><span class="menu-row__title">' + title + '</span><span class="menu-row__sub">' + sub + '</span></span>' +
      '<svg class="row-chev" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M8 5.6 12.4 10 8 14.4"/></svg></button>';
  }

  function d2InstallChatMenu() {
    SHEETS.chatMenu = function () {
      return {
        title: '聊天菜单',
        body: '<div class="menu-list">' +
          d2MenuRow('data-d2a="new-chat"', '<svg viewBox="0 0 20 20" fill="none"><path d="M10 4.6v10.8M4.6 10h10.8"/></svg>', '开始新聊天', '为当前角色开一段新对话') +
          d2MenuRow('data-d2a="manage-chats"', '<svg viewBox="0 0 20 20" fill="none"><rect x="3.4" y="4.4" width="13.2" height="11.2" rx="2.2"/><path d="M6.6 8h6.8M6.6 11.6h4.2"/></svg>', '管理聊天文件', '这个角色的全部对话：切换 / 改名 / 置顶 / 删除') +
          d2MenuRow('data-d2a="checkpoint-save"', '<svg viewBox="0 0 20 20" fill="none"><path d="M6.4 3.6v5.2l3.6-2 3.6 2V3.6"/><rect x="4.4" y="3.6" width="11.2" height="12.8" rx="2"/></svg>', '保存检查点', '在当前位置存一个分支点，之后回到这里另开') +
          d2MenuRow('data-d2a="delete-mode"', '<svg viewBox="0 0 20 20" fill="none"><path d="M4.6 6.2h10.8M8 3.6h4M6.4 6.2l.7 10h5.8l.7-10"/></svg>', '删除消息', '进入多选模式，批量删除') +
          d2MenuRow('data-d2a="regenerate"', '<svg viewBox="0 0 20 20" fill="none"><path d="M15.6 8.2A5.8 5.8 0 1 0 16 11"/><path d="M15.8 4.4v3.8h-3.8"/></svg>', '重新生成', '删掉最后一条回复，让她重写') +
          d2MenuRow('data-d2a="continue"', '<svg viewBox="0 0 20 20" fill="none"><path d="M4.4 6.4h8.2M4.4 10h11.2M4.4 13.6h6.2"/><path d="m13 4.6 3 3-3 3"/></svg>', '续写', '让她接着上一条继续写') +
          d2MenuRow('data-d2a="impersonate"', '<svg viewBox="0 0 20 20" fill="none"><circle cx="7.2" cy="7.4" r="2.6"/><path d="M3.4 15.4c.6-2.4 2-3.6 3.8-3.6s3.2 1.2 3.8 3.6"/><path d="M13.4 7.2h3.2v5.4h-3.2z"/></svg>', 'AI 帮答', '替「我」写一条，确认后再发') +
          d2MenuRow('data-d2a="author-note"', '<svg viewBox="0 0 20 20" fill="none"><path d="M5.4 3.6h9.2c.8 0 1.4.6 1.4 1.4v10c0 .8-.6 1.4-1.4 1.4H5.4c-.8 0-1.4-.6-1.4-1.4V5c0-.8.6-1.4 1.4-1.4z"/><path d="M7.2 7h5.6M7.2 10h5.6M7.2 13h3.4"/></svg>', '作者注释', '只对这段聊天生效的额外指令') +
          d2MenuRow('data-open="chatBook"', '<svg viewBox="0 0 20 20" fill="none"><path d="M4.4 4.6h5.2c.7 0 1.2.5 1.2 1.2v9.6H5.6c-.7 0-1.2-.5-1.2-1.2V4.6z"/><path d="M15.6 4.6h-5.2c-.7 0-1.2.5-1.2 1.2v9.6h5.2c.7 0 1.2-.5 1.2-1.2V4.6z"/></svg>', '本聊天绑定的世界书', '常开与关键词') +
          d2MenuRow('data-d2a="export-chat"', '<svg viewBox="0 0 20 20" fill="none"><path d="M10 3.6v7.2M6.8 7.6l3.2 3.2 3.2-3.2M4.4 13.4v2.2c0 .6.5 1.1 1.1 1.1h9c.6 0 1.1-.5 1.1-1.1v-2.2"/></svg>', '记录导出', '本项目 JSON，含绑定信息') +
          '</div>' +
          '<p class="sheet-label">更多</p>' +
          '<div class="menu-list">' +
          d2MenuRow('data-a2="preview-open"', '<svg viewBox="0 0 20 20" fill="none"><path d="M4 4.6h12v9.8H9.6L6 17.4v-3H4z"/><path d="M7 8h6M7 10.6h3.6"/></svg>', '查看这次发给模型的内容', '按真实顺序拼好的提示词预览') +
          d2MenuRow('data-open="presetSwitch"', '<svg viewBox="0 0 20 20" fill="none"><path d="M5.4 3.6h9.2c.8 0 1.4.6 1.4 1.4v10c0 .8-.6 1.4-1.4 1.4H5.4c-.8 0-1.4-.6-1.4-1.4V5c0-.8.6-1.4 1.4-1.4z"/></svg>', '提示词预设 · 这场文风', '换文风，或设为角色默认') +
          d2MenuRow('data-nav="providers"', '<svg viewBox="0 0 20 20" fill="none"><rect x="3.2" y="4.2" width="5" height="5" rx="1.4"/><rect x="11.8" y="4.2" width="5" height="5" rx="1.4"/><rect x="7.5" y="11.6" width="5" height="5" rx="1.4"/></svg>', '模型与提供商', '管理 API Key、模型与余额') +
          '</div>'
      };
    };
  }

  function d2TapMessage(target) {
    var msgEl = target && target.closest ? target.closest('.msg') : null;
    if (!msgEl) return;
    var id = msgEl.getAttribute('data-msg-id');
    if (!id) return;
    if (D2_MSG_SELECT.on) {
      if (D2_MSG_SELECT.ids[id]) delete D2_MSG_SELECT.ids[id]; else D2_MSG_SELECT.ids[id] = true;
      d2DecorateChat();
      return;
    }
    d2OpenMessageActions(id);
  }

  /* ---------------- 初始化 ---------------- */
  function d2ChatActionsInit() {
    d2InstallChatMenu();
    SHEETS.d2Checkpoints = d2SheetCheckpoints;
    SHEETS.d2AuthorNote = d2SheetAuthorNote;
    SHEETS.d2MsgActions = d2SheetMsgActions;
    SHEETS.d2MsgEdit = d2SheetMsgEdit;
    SHEETS.d2Impersonate = d2SheetImpersonate;
    /* 选中态底栏挂进聊天页 */
    var chatView = document.querySelector('.view--chat');
    if (chatView && !document.getElementById('d2MsgSelectBar')) {
      var bar = document.createElement('div');
      bar.id = 'd2MsgSelectBar';
      bar.className = 'd2-select-bar';
      var composer = chatView.querySelector('.composer-zone');
      if (composer && composer.parentNode) composer.parentNode.insertBefore(bar, composer);
      else chatView.appendChild(bar);
    }
    document.addEventListener('click', function (e) {
      var el = e.target && e.target.closest ? e.target : null;
      if (!el || !el.closest) return;
      var hit;
      if ((hit = el.closest('[data-d2a-msg-check]'))) {
        var id = hit.getAttribute('data-d2a-msg-check');
        if (D2_MSG_SELECT.ids[id]) delete D2_MSG_SELECT.ids[id]; else D2_MSG_SELECT.ids[id] = true;
        d2DecorateChat();
        e.stopPropagation();
        return;
      }
      if ((hit = el.closest('#chatList .msg'))) {
        if (el.closest('.d2-msg-check')) return;
        d2TapMessage(hit);
        return;
      }
      if ((hit = el.closest('[data-d2a="new-chat"]'))) {
        closeSheet();
        D2ChatStore.create(state.currentCharacterId).then(function (chat) {
          renderChat();
          toast('开了一段新对话：' + chat.title);
        }).catch(function (err) { toast(err.message || '新对话没建成。'); });
        return;
      }
      if ((hit = el.closest('[data-d2a="manage-chats"]'))) { closeSheet(); d2OpenChatList(state.currentCharacterId); return; }
      if ((hit = el.closest('[data-d2a="checkpoint-save"]'))) { closeSheet(); d2SaveCheckpoint(); return; }
      if ((hit = el.closest('[data-d2a="delete-mode"]'))) { closeSheet(); d2ToggleSelectMode(true); return; }
      if ((hit = el.closest('[data-d2a="regenerate"]'))) { d2RunRegenerate(); return; }
      if ((hit = el.closest('[data-d2a="continue"]'))) { d2RunContinue(); return; }
      if ((hit = el.closest('[data-d2a="impersonate"]'))) { d2RunImpersonate(); return; }
      if ((hit = el.closest('[data-d2a="author-note"]'))) { closeSheet(); openSheet('d2AuthorNote'); return; }
      if ((hit = el.closest('[data-d2a="export-chat"]'))) {
        closeSheet();
        var chat = d2caActiveChat();
        if (!chat) { toast('还没有对话。'); return; }
        D2ChatStore.exportChat(chat.id).then(function () { toast('导出好了。'); }).catch(function (err) { toast(err.message || '导出没成功。'); });
        return;
      }
      if ((hit = el.closest('[data-d2a-author-note-save]'))) { d2SaveAuthorNote(false); return; }
      if ((hit = el.closest('[data-d2a-author-note-clear]'))) { d2SaveAuthorNote(true); return; }
      if ((hit = el.closest('[data-d2a-cp-branch]'))) {
        var cpChat = d2caActiveChat();
        var cpIndex = parseInt(hit.getAttribute('data-d2a-cp-branch'), 10) || 0;
        var cps = (cpChat.settings && cpChat.settings.checkpoints) || [];
        var cp = cps[cpIndex];
        if (!cp || !cpChat || !cpChat.id) return;
        D2ChatStore.branch(cpChat.id, cp.messageId).then(function () {
          closeSheet();
          toast('从检查点另开了一段新对话。');
        }).catch(function (err) { toast(err.message || '从检查点另开没成功。'); });
        return;
      }
      if ((hit = el.closest('[data-d2a-cp-del]'))) {
        var delChat = d2caActiveChat();
        var delIndex = parseInt(hit.getAttribute('data-d2a-cp-del'), 10) || 0;
        var delList = ((delChat.settings && delChat.settings.checkpoints) || []).slice();
        delList.splice(delIndex, 1);
        D2ChatStore.updateChat(delChat.id, { settings: { checkpoints: delList } }).then(function () { openSheet('d2Checkpoints'); toast('删掉这个检查点。'); });
        return;
      }
      if ((hit = el.closest('[data-d2a-msg-edit]'))) { openSheet('d2MsgEdit'); return; }
      if ((hit = el.closest('[data-d2a-msg-edit-save]'))) {
        var target = D2_MSG_TARGET;
        var chat = d2caActiveChat();
        var inputEl = document.getElementById('d2MsgEditText');
        if (!target || !chat) return;
        D2ChatStore.editMessage(chat.id, target.id, inputEl ? inputEl.value : '').then(function () {
          closeSheet();
          chat.messages = chatMessages;
          save();
          renderChat();
          toast('改好了。');
        }).catch(function (err) { toast(err.message || '编辑没成功。'); });
        return;
      }
      if ((hit = el.closest('[data-d2a-msg-copy]'))) {
        var copyTarget = D2_MSG_TARGET;
        var copyMsg = copyTarget ? chatMessages[copyTarget.index] : null;
        closeSheet();
        if (copyMsg) d2CopyText(String(copyMsg.text || ''));
        return;
      }
      if ((hit = el.closest('[data-d2a-msg-regen]'))) {
        var regenTarget = D2_MSG_TARGET;
        if (!regenTarget || regenTarget.index !== d2caLastAiIndex()) {
          toast('只能重新生成最后一条回复；想从这里重来可以点「从这里分支」。');
          return;
        }
        d2RunRegenerate();
        return;
      }
      if ((hit = el.closest('[data-d2a-msg-branch]'))) {
        var branchTarget = D2_MSG_TARGET;
        var branchChat = d2caActiveChat();
        closeSheet();
        if (!branchTarget || !branchChat) return;
        D2ChatStore.branch(branchChat.id, branchTarget.id).then(function () {
          toast('从这里另开了一段新对话。');
        }).catch(function (err) { toast(err.message || '分支没成功。'); });
        return;
      }
      if ((hit = el.closest('[data-d2a-msg-delete]'))) {
        var delTarget = D2_MSG_TARGET;
        var delMsgChat = d2caActiveChat();
        if (!delTarget || !delMsgChat) return;
        closeSheet();
        d2OpenConfirm('删除这条消息？', '删掉就找不回来了。', '删除', function () {
          D2ChatStore.deleteMessage(delMsgChat.id, delTarget.id).then(function () {
            delMsgChat.messages = chatMessages;
            save();
            renderChat();
            toast('删掉了。');
          }).catch(function (err) { toast(err.message || '删除没成功。'); });
        }, true);
        return;
      }
      if ((hit = el.closest('[data-d2a-select-cancel]'))) { d2ToggleSelectMode(false); return; }
      if ((hit = el.closest('[data-d2a-select-delete]'))) { d2DeleteSelectedMessages(); return; }
      if ((hit = el.closest('[data-d2a-impersonate-send]'))) {
        closeSheet();
        if (D2_IMPERSONATE_TEXT) sendChat({ text: D2_IMPERSONATE_TEXT });
        return;
      }
      if ((hit = el.closest('[data-d2a-impersonate-again]'))) { d2RunImpersonate(); return; }
    });

    /* 渲染完聊天后补多选勾选框 */
    var chatList = document.getElementById('chatList');
    if (chatList && window.MutationObserver) {
      var observer = new MutationObserver(function () {
        if (D2_MSG_SELECT.on) d2DecorateChat();
      });
      observer.observe(chatList, { childList: true });
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    setTimeout(d2ChatActionsInit, 0);
  });
