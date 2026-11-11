  /* =========================================================================
     第三块 · 聊天记录管理（数据层 + 对话列表 / 最近的聊天 / 搜索 / 改名 /
     人设三层绑定 / 导入导出）
     模块和 app.js 同作用域（构建时注入），运行时可直接用 state / save / openSheet 等。
     顶层只声明，不读 state / DOM。
     ========================================================================= */

  var D2_CHAT_LISTENERS = [];
  var D2_RECENT_STATE = { q: '', characterId: '', selectMode: false, selected: {} };

  function d2ChatIsServer() { return !!(SERVER_MODE && serverOnline); }

  function d2ChatCharName(characterId) {
    var character = findChar(characterId);
    return character ? character.name : '角色';
  }

  function d2Pad2(n) { return (n < 10 ? '0' : '') + n; }

  function d2NowStamp() {
    var d = new Date();
    return d.getFullYear() + '-' + d2Pad2(d.getMonth() + 1) + '-' + d2Pad2(d.getDate()) + ' ' + d2Pad2(d.getHours()) + ':' + d2Pad2(d.getMinutes());
  }

  function d2DefaultTitle(characterId) {
    return d2ChatCharName(characterId) + ' - ' + d2NowStamp();
  }

  function d2NewChatId() {
    return 'chat-' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
  }

  function d2LocalStore() {
    if (!state.d2LocalChats || typeof state.d2LocalChats !== 'object') state.d2LocalChats = {};
    return state.d2LocalChats;
  }

  function d2ActiveChat(characterId) {
    var charId = characterId || state.currentCharacterId;
    if (!charId) return null;
    if (!state.chats[charId]) {
      var chat = ensureChat(charId);
      if (chat && !chat.id) chat.id = d2NewChatId();
      return chat;
    }
    var active = state.chats[charId];
    if (!active.id) active.id = d2NewChatId();
    return active;
  }

  function d2NormalizeChat(chat) {
    if (!chat) return null;
    if (!chat.id) chat.id = d2NewChatId();
    if (!Array.isArray(chat.messages)) chat.messages = [];
    if (!chat.settings || typeof chat.settings !== 'object') chat.settings = {};
    return chat;
  }

  function d2ApplyActiveChat(chat, opts) {
    d2NormalizeChat(chat);
    state.chats[chat.characterId] = chat;
    /* 切回一段对话时自动恢复它记住的模型（思考档位由 chatReasoningLevel 读取） */
    if (chat.modelId && typeof findModel === 'function' && findModel(chat.modelId)) state.modelId = chat.modelId;
    if (state.currentCharacterId === chat.characterId) {
      chatMessages = chat.messages;
      if (currentView === 'chat') {
        renderChat();
        updateChatHeader();
        renderChatContext();
      }
    }
    save();
    if (opts && opts.toChat) go('chat');
    d2ChatEmit();
    return chat;
  }

  function d2SummarizeLocal(chat) {
    var messages = chat.messages || [];
    var last = messages.length ? messages[messages.length - 1] : null;
    var preview = last ? ((last.role === 'me' ? '我：' : '') + String(last.text || '')).replace(/\n/g, ' ') : '';
    return {
      id: chat.id,
      characterId: chat.characterId,
      title: chat.title || d2DefaultTitle(chat.characterId),
      preview: preview.slice(0, 80),
      messageCount: messages.length,
      lastAt: chat.lastAt || '',
      pinned: !!chat.pinned,
      personaId: chat.personaId || '',
      worldBookId: chat.worldBookId || '',
      presetId: chat.presetId || '',
      modelId: chat.modelId || '',
      reasoningLevel: chat.reasoningLevel || '',
      settings: chat.settings || {},
      source: 'local'
    };
  }

  function d2ChatEmit() {
    for (var i = 0; i < D2_CHAT_LISTENERS.length; i++) {
      try { D2_CHAT_LISTENERS[i](); } catch (e) { /* 忽略 */ }
    }
  }

  function d2LocalChatsFor(characterId) {
    var store = d2LocalStore();
    var out = [];
    var active = d2ActiveChat(characterId);
    if (active) out.push(active);
    Object.keys(store).forEach(function (id) {
      var chat = store[id];
      if (!chat || chat.characterId !== characterId) return;
      if (active && chat.id === active.id) return;
      out.push(chat);
    });
    return out;
  }

  /* ---------------- 冻结接口：D2ChatStore ---------------- */
  var D2ChatStore = {
    isServer: function () { return d2ChatIsServer(); },
    onChange: function (fn) { if (typeof fn === 'function') D2_CHAT_LISTENERS.push(fn); },
    active: function (characterId) { return d2ActiveChat(characterId); },

    list: function (characterId) {
      if (d2ChatIsServer()) {
        var q = characterId ? ('?characterId=' + encodeURIComponent(characterId)) : '';
        return serverFetch('/chats' + q).then(function (data) { return data.chats || []; });
      }
      var charIds = characterId ? [characterId] : state.characters.map(function (c) { return c.id; });
      var all = [];
      charIds.forEach(function (cid) {
        d2LocalChatsFor(cid).forEach(function (chat) { all.push(d2SummarizeLocal(chat)); });
      });
      all.sort(function (a, b) {
        if (!!b.pinned !== !!a.pinned) return b.pinned ? 1 : -1;
        return String(b.lastAt || '').localeCompare(String(a.lastAt || ''));
      });
      return Promise.resolve(all);
    },

    get: function (chatId) {
      if (d2ChatIsServer()) {
        return serverFetch('/chats/id/' + encodeURIComponent(chatId)).then(function (data) { return data.chat; });
      }
      var store = d2LocalStore();
      if (store[chatId]) return Promise.resolve(store[chatId]);
      for (var cid in state.chats) {
        if (state.chats[cid] && state.chats[cid].id === chatId) return Promise.resolve(state.chats[cid]);
      }
      return Promise.reject(new Error('这段对话已经不在了。'));
    },

    create: function (characterId, opts) {
      opts = opts || {};
      var active = d2ActiveChat(characterId);
      var base = {
        characterId: characterId,
        personaId: opts.personaId !== undefined ? opts.personaId : (active ? active.personaId || '' : ''),
        worldBookId: opts.worldBookId !== undefined ? opts.worldBookId : (active ? active.worldBookId || '' : ''),
        presetId: opts.presetId !== undefined ? opts.presetId : (active ? active.presetId || '' : ''),
        modelId: opts.modelId !== undefined ? opts.modelId : (state.modelId || ''),
        reasoningLevel: opts.reasoningLevel !== undefined ? opts.reasoningLevel : (active ? active.reasoningLevel || '' : ''),
        title: opts.title || ''
      };
      if (d2ChatIsServer()) {
        return serverFetch('/chats', { method: 'POST', body: base }).then(function (data) {
          return d2ApplyActiveChat(data.chat, { toChat: true });
        });
      }
      var character = findChar(characterId);
      var messages = [];
      if (character && character.first_mes) messages = [{ role: 'ai', text: character.first_mes, time: hm(new Date()) }];
      var chat = d2NormalizeChat({
        id: d2NewChatId(),
        characterId: characterId,
        personaId: base.personaId,
        worldBookId: base.worldBookId,
        presetId: base.presetId,
        modelId: base.modelId,
        reasoningLevel: base.reasoningLevel,
        title: base.title || d2DefaultTitle(characterId),
        pinned: false,
        settings: {},
        messages: messages,
        lastAt: new Date().toISOString()
      });
      var store = d2LocalStore();
      if (active && active.id && active.id !== chat.id) store[active.id] = active;
      state.chats[characterId] = chat;
      return Promise.resolve(d2ApplyActiveChat(chat, { toChat: true }));
    },

    switchTo: function (chatId) {
      return this.get(chatId).then(function (chat) {
        chat = d2NormalizeChat(chat);
        if (chat.characterId !== state.currentCharacterId) state.currentCharacterId = chat.characterId;
        if (!d2ChatIsServer()) {
          var store = d2LocalStore();
          var previous = state.chats[chat.characterId];
          if (previous && previous.id && previous.id !== chat.id) store[previous.id] = previous;
          delete store[chat.id];
        }
        return d2ApplyActiveChat(chat, { toChat: true });
      });
    },

    rename: function (chatId, title) {
      var clean = String(title || '').trim();
      if (!clean) return Promise.reject(new Error('标题不能空着。'));
      return this.updateChat(chatId, { title: clean, titleLocked: true });
    },

    setPinned: function (chatId, pinned) {
      return this.updateChat(chatId, { pinned: !!pinned }).then(function (chat) {
        toast(pinned ? '置顶了，找它更方便。' : '取消置顶。');
        return chat;
      });
    },

    remove: function (chatIds) {
      var ids = (chatIds || []).slice();
      if (!ids.length) return Promise.resolve(true);
      var self = this;
      function after() {
        var currentCharId = state.currentCharacterId;
        return self.list(currentCharId).then(function (list) {
          var active = d2ActiveChat(currentCharId);
          if (active && ids.indexOf(active.id) !== -1) {
            if (list.length) return self.switchTo(list[0].id);
            return self.create(currentCharId);
          }
          d2ChatEmit();
          renderMe();
          return true;
        });
      }
      if (d2ChatIsServer()) {
        return serverFetch('/chats/bulk-delete', { method: 'POST', body: { chatIds: ids } }).then(after);
      }
      var store = d2LocalStore();
      ids.forEach(function (id) {
        delete store[id];
        for (var cid in state.chats) {
          if (state.chats[cid] && state.chats[cid].id === id) delete state.chats[cid];
        }
      });
      save();
      return after();
    },

    search: function (q, characterId) {
      if (d2ChatIsServer()) {
        var params = '?q=' + encodeURIComponent(q || '');
        if (characterId) params += '&characterId=' + encodeURIComponent(characterId);
        return serverFetch('/chats/search' + params).then(function (data) { return data.results || []; });
      }
      var needle = String(q || '').toLowerCase();
      if (!needle) return Promise.resolve([]);
      var charIds = characterId ? [characterId] : state.characters.map(function (c) { return c.id; });
      var results = [];
      charIds.forEach(function (cid) {
        d2LocalChatsFor(cid).forEach(function (chat) {
          (chat.messages || []).forEach(function (m) {
            if (String(m.text || '').toLowerCase().indexOf(needle) === -1) return;
            results.push({
              chatId: chat.id, characterId: cid, chatTitle: chat.title || d2DefaultTitle(cid),
              messageId: m.id || null, role: m.role, text: String(m.text || '').slice(0, 160),
              time: m.time || '', createdAt: ''
            });
          });
        });
      });
      return Promise.resolve(results.slice(0, 50));
    },

    branch: function (chatId, messageId) {
      if (d2ChatIsServer()) {
        return serverFetch('/chats/id/' + encodeURIComponent(chatId) + '/branch', { method: 'POST', body: { messageId: messageId } })
          .then(function (data) { return d2ApplyActiveChat(data.chat, { toChat: true }); });
      }
      return this.get(chatId).then(function (chat) {
        var copy = clone(chat);
        copy.id = d2NewChatId();
        copy.title = (chat.title || d2DefaultTitle(chat.characterId)) + ' · 分支';
        copy.messages = (chat.messages || []).filter(function (m, index) {
          return index < (chat.messages || []).findIndex(function (x) { return (x.id || index) === messageId; }) + 1;
        });
        if (!copy.messages.length) copy.messages = clone(chat.messages || []);
        var store = d2LocalStore();
        if (state.chats[chat.characterId]) store[state.chats[chat.characterId].id] = state.chats[chat.characterId];
        return d2ApplyActiveChat(copy, { toChat: true });
      });
    },

    updateChat: function (chatId, patch) {
      var self = this;
      function mergeLocal(chat) {
        if (!chat) return null;
        if (patch.title !== undefined) chat.title = patch.title;
        if (patch.pinned !== undefined) chat.pinned = !!patch.pinned;
        ['personaId', 'worldBookId', 'presetId', 'modelId', 'reasoningLevel'].forEach(function (key) {
          if (patch[key] !== undefined) chat[key] = patch[key];
        });
        if (patch.settings && typeof patch.settings === 'object') {
          chat.settings = Object.assign({}, chat.settings || {}, patch.settings);
        }
        return chat;
      }
      if (d2ChatIsServer()) {
        return serverFetch('/chats/id/' + encodeURIComponent(chatId), { method: 'PATCH', body: patch }).then(function (data) {
          var summary = data.chat || {};
          var active = null;
          for (var cid in state.chats) if (state.chats[cid] && state.chats[cid].id === chatId) active = state.chats[cid];
          if (active) {
            mergeLocal(active);
            Object.keys(summary).forEach(function (key) {
              if (summary[key] !== undefined && summary[key] !== null && key !== 'messages') active[key] = summary[key];
            });
            save();
            if (currentView === 'chat') renderChatContext();
          }
          d2ChatEmit();
          renderMe();
          return summary;
        });
      }
      var store = d2LocalStore();
      var target = null;
      for (var cid2 in state.chats) if (state.chats[cid2] && state.chats[cid2].id === chatId) target = state.chats[cid2];
      if (!target && store[chatId]) target = store[chatId];
      if (!target) return Promise.reject(new Error('这段对话已经不在了。'));
      mergeLocal(target);
      save();
      d2ChatEmit();
      return Promise.resolve(d2SummarizeLocal(target));
    },

    autoTitle: function (chatId) {
      if (!d2ChatIsServer()) {
        return Promise.reject(new Error('离线演示模式连不上模型：先自己起个名字。'));
      }
      return serverFetch('/chats/id/' + encodeURIComponent(chatId) + '/auto-title', { method: 'POST', body: {} }).then(function (data) {
        if (!data.ok) {
          var err = new Error(data.message || '这次没能起名，可以自己改。');
          err.kind = 'soft';
          throw err;
        }
        return data;
      });
    },

    exportChat: function (chatId) {
      if (d2ChatIsServer()) {
        return serverDownload('/chats/id/' + encodeURIComponent(chatId) + '/export').then(function (blob) {
          downloadBlob('缪诗鸳杞-对话-' + (chatId.slice(-6)) + '.json', blob);
          return true;
        });
      }
      return this.get(chatId).then(function (chat) {
        var character = findChar(chat.characterId);
        var payload = {
          app: 'miushi-yuanqi', kind: 'chat', version: 1, exportedAt: new Date().toISOString(),
          character: { id: chat.characterId, name: character ? character.name : '' },
          bindings: {
            personaId: chat.personaId || '', worldBookId: chat.worldBookId || '', presetId: chat.presetId || '',
            modelId: chat.modelId || '', reasoningLevel: chat.reasoningLevel || ''
          },
          chat: chat
        };
        downloadBlob('缪诗鸳杞-对话-' + (chat.id.slice(-6)) + '.json', new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
        return true;
      });
    },

    exportChats: function (chatIds) {
      if (d2ChatIsServer()) {
        return serverFetch('/chats/bulk-export', { method: 'POST', body: { chatIds: chatIds } }).then(function (data) {
          downloadBlob('缪诗鸳杞-对话-' + chatIds.length + '段.json', new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
          return true;
        });
      }
      var self = this;
      return Promise.all((chatIds || []).map(function (id) { return self.get(id); })).then(function (chats) {
        var payload = { app: 'miushi-yuanqi', kind: 'chats', version: 1, exportedAt: new Date().toISOString(), chats: chats.filter(Boolean) };
        downloadBlob('缪诗鸳杞-对话-' + chatIds.length + '段.json', new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
        return true;
      });
    },

    importContent: function (content, characterId) {
      if (d2ChatIsServer()) {
        return serverFetch('/chats/import', { method: 'POST', body: { format: 'auto', content: content, characterId: characterId || '' } }).then(function (data) {
          return d2ApplyActiveChat(data.chat, { toChat: true });
        });
      }
      var parsed;
      try { parsed = JSON.parse(content); } catch (e) {
        return Promise.reject(new Error('离线演示模式只支持导入本项目导出的 JSON。'));
      }
      var items = parsed.chats || (parsed.chat ? [parsed.chat] : [parsed]);
      var self = this;
      var first = items[0];
      if (!first) return Promise.reject(new Error('文件里没有对话。'));
      var charId = first.characterId || characterId || state.currentCharacterId;
      var chat = clone(first);
      chat.id = d2NewChatId();
      chat.characterId = charId;
      chat.title = chat.title || d2DefaultTitle(charId);
      return Promise.resolve(d2ApplyActiveChat(d2NormalizeChat(chat), { toChat: true }));
    },

    editMessage: function (chatId, messageId, text) {
      var self = this;
      if (d2ChatIsServer()) {
        return serverFetch('/chats/id/' + encodeURIComponent(chatId) + '/messages/' + messageId, { method: 'PATCH', body: { text: text } }).then(function (data) {
          self._patchLocalMessage(chatId, messageId, data.message);
          return data.message;
        });
      }
      self._patchLocalMessage(chatId, messageId, { id: messageId, text: text, edited: true });
      return Promise.resolve({ id: messageId, text: text, edited: true });
    },

    deleteMessage: function (chatId, messageId) {
      var self = this;
      if (d2ChatIsServer()) {
        return serverFetch('/chats/id/' + encodeURIComponent(chatId) + '/messages/' + messageId, { method: 'DELETE' }).then(function () {
          self._removeLocalMessage(chatId, messageId);
          return true;
        });
      }
      self._removeLocalMessage(chatId, messageId);
      return Promise.resolve(true);
    },

    _patchLocalMessage: function (chatId, messageId, message) {
      function apply(chat) {
        if (!chat || chat.id !== chatId) return;
        (chat.messages || []).forEach(function (m) { if (String(m.id) === String(messageId)) { m.text = message.text; m.edited = true; } });
      }
      apply(state.chats[state.currentCharacterId]);
      Object.keys(state.chats).forEach(function (cid) { apply(state.chats[cid]); });
      if (state.currentCharacterId && state.chats[state.currentCharacterId]) chatMessages = state.chats[state.currentCharacterId].messages;
      save();
      if (currentView === 'chat') renderChat();
      d2ChatEmit();
    },

    _removeLocalMessage: function (chatId, messageId) {
      function apply(chat) {
        if (!chat || chat.id !== chatId) return;
        chat.messages = (chat.messages || []).filter(function (m) { return String(m.id) !== String(messageId); });
      }
      apply(state.chats[state.currentCharacterId]);
      Object.keys(state.chats).forEach(function (cid) { apply(state.chats[cid]); });
      if (state.currentCharacterId && state.chats[state.currentCharacterId]) chatMessages = state.chats[state.currentCharacterId].messages;
      save();
      if (currentView === 'chat') renderChat();
      d2ChatEmit();
    },

    refresh: function (characterId) {
      if (!d2ChatIsServer()) { d2ChatEmit(); return Promise.resolve([]); }
      return this.list(characterId).then(function (list) { d2ChatEmit(); return list; });
    }
  };

  /* ---------------- 时间 / 预览小工具 ---------------- */
  function d2ChatFormatTime(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var now = new Date();
    var sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
    if (sameDay) return d2Pad2(d.getHours()) + ':' + d2Pad2(d.getMinutes());
    var yesterday = new Date(now.getTime() - 86400000);
    if (d.getFullYear() === yesterday.getFullYear() && d.getMonth() === yesterday.getMonth() && d.getDate() === yesterday.getDate()) {
      return '昨天 ' + d2Pad2(d.getHours()) + ':' + d2Pad2(d.getMinutes());
    }
    if (d.getFullYear() === now.getFullYear()) return d2Pad2(d.getMonth() + 1) + '-' + d2Pad2(d.getDate());
    return d.getFullYear() + '-' + d2Pad2(d.getMonth() + 1) + '-' + d2Pad2(d.getDate());
  }

  function d2ChatEmptyText(characterId) {
    return '还没有别的对话。点「新对话」开一段新的。';
  }

  function d2ChatActiveId() {
    var active = d2ActiveChat();
    return active ? active.id : '';
  }

  /* ---------------- 通用确认弹层 ---------------- */
  var D2_CONFIRM_CB = null;
  function d2SheetD2Confirm(payload) {
    payload = payload || {};
    D2_CONFIRM_CB = payload.run || null;
    return {
      title: payload.title || '确认',
      body: '<p class="sheet-note" style="text-align:left">' + esc(payload.text || '') + '</p>',
      foot: '<button class="btn" type="button" data-close>取消</button>' +
        '<button class="btn ' + (payload.danger ? 'btn--danger' : 'btn--primary') + '" type="button" data-d2-confirm-run>' + esc(payload.label || '确定') + '</button>'
    };
  };

  function d2OpenConfirm(title, text, label, run, danger) {
    openSheet('d2Confirm', { title: title, text: text, label: label, run: run, danger: danger });
  }

  /* ---------------- 对话列表弹层（本角色） ---------------- */
  var d2ChatListState = { characterId: '', data: [], loading: false };

  function d2ChatRowHtml(chat, opts) {
    opts = opts || {};
    var charName = opts.showChar ? d2ChatCharName(chat.characterId) : '';
    var activeId = opts.activeId || '';
    var pin = chat.pinned ? '<span class="d2-pin" aria-label="已置顶">✧</span>' : '';
    var selected = opts.selected && opts.selected[chat.id];
    return '<div class="d2-chat-row' + (chat.id === activeId ? ' is-active' : '') + (selected ? ' is-selected' : '') + '" data-d2chat-row="' + esc(chat.id) + '">' +
      (opts.selectMode ? '<button class="d2-check' + (selected ? ' is-on' : '') + '" type="button" data-d2chat-check="' + esc(chat.id) + '" aria-pressed="' + (selected ? 'true' : 'false') + '" aria-label="选择这段对话"><span></span></button>' : '') +
      '<button class="d2-chat-row__main" type="button" data-d2chat-open="' + esc(chat.id) + '">' +
        '<span class="d2-chat-row__top"><span class="d2-chat-row__title">' + pin + esc(chat.title || '未命名对话') + '</span>' +
          '<span class="d2-chat-row__time">' + esc(d2ChatFormatTime(chat.lastAt)) + '</span></span>' +
        '<span class="d2-chat-row__preview">' + esc(chat.preview || '还没有消息') + '</span>' +
        '<span class="d2-chat-row__meta">' + (charName ? '<span class="a2-tag a2-tag--muted">' + esc(charName) + '</span>' : '') +
          '<span class="a2-tag a2-tag--muted">' + (chat.messageCount || 0) + ' 条</span></span>' +
      '</button>' +
      '<button class="d2-chat-row__more" type="button" data-d2chat-more="' + esc(chat.id) + '" aria-label="更多操作">⋯</button>' +
    '</div>';
  }

  function d2RenderChatListSheet() {
    var characterId = d2ChatListState.characterId || state.currentCharacterId;
    var rows = d2ChatListState.data.length
      ? d2ChatListState.data.map(function (chat) { return d2ChatRowHtml(chat, { activeId: d2ChatActiveId() }); }).join('')
      : '<p class="a2-empty">' + esc(d2ChatEmptyText(characterId)) + '</p>';
    return {
      title: d2ChatCharName(characterId) + ' 的对话',
      body: '<div class="a2-toolbar d2-chat-toolbar">' +
          '<button class="lib-action lib-action--primary" type="button" data-d2chat-new>' + '＋ 新对话</button>' +
          '<button class="lib-action" type="button" data-d2chat-import>' + '导入</button>' +
        '</div>' +
        '<p class="sheet-label">全部对话 · ' + d2ChatListState.data.length + ' 段</p>' +
        '<div class="d2-chat-list">' + rows + '</div>' +
        '<input type="file" id="d2ChatImportFile" accept=".json,.jsonl,application/json,text/plain" hidden>' +
        '<p class="a2-note">标题默认「角色名 - 日期 时间」；点行切换，点 ⋯ 改名 / 置顶 / 导出 / 删除。</p>'
    };
  }

  function d2OpenChatList(characterId) {
    d2ChatListState.characterId = characterId || state.currentCharacterId;
    d2ChatListState.loading = true;
    openSheet('d2ChatList');
    D2ChatStore.list(d2ChatListState.characterId).then(function (list) {
      d2ChatListState.data = list;
      d2ChatListState.loading = false;
      if (sheetName === 'd2ChatList') openSheet('d2ChatList');
    }).catch(function (err) {
      d2ChatListState.loading = false;
      toast(err.message || '对话列表没拉下来，稍后再试。');
    });
  }

  function d2SheetChatList() { return d2RenderChatListSheet(); }

  /* ---------------- 改名 / AI 起名弹层 ---------------- */
  var d2RenameTarget = '';
  function d2SheetRename(payload) {
    var chatId = payload && payload.chatId ? payload.chatId : d2RenameTarget;
    d2RenameTarget = chatId;
    var title = (payload && payload.title) || '';
    return {
      title: '给这段对话改名',
      body: '<label class="field-label" for="d2RenameInput">标题</label>' +
        '<input class="field field--title" id="d2RenameInput" type="text" value="' + esc(title) + '" maxlength="40" placeholder="例如：雨夜的信">' +
        '<div class="d2-rename-ai">' +
          '<button class="lib-action" type="button" data-d2chat-ai-title="' + esc(chatId) + '">' + '帮我起个名' + '</button>' +
          '<span class="d2-rename-ai__hint">会调用一次模型，按次计费的接口可能扣一次费。</span>' +
        '</div>' +
        '<p class="a2-note">自己改过的标题，AI 不会再覆盖。</p>',
      foot: '<button class="btn" type="button" data-close>取消</button>' +
        '<button class="btn btn--primary" type="button" data-d2chat-rename-save="' + esc(chatId) + '">保存</button>'
    };
  };

  function d2RenameChatFlow(chatId) {
    D2ChatStore.get(chatId).then(function (chat) {
      openSheet('d2Rename', { chatId: chatId, title: chat.title || '' });
    }).catch(function (err) { toast(err.message || '这段对话已经不在了。'); });
  }

  /* ---------------- 最近的聊天（全角色混排） ---------------- */
  function d2RecentFiltered(list) {
    var q = D2_RECENT_STATE.q.trim().toLowerCase();
    var charId = D2_RECENT_STATE.characterId;
    return list.filter(function (chat) {
      if (charId && chat.characterId !== charId) return false;
      if (!q) return true;
      return String(chat.title || '').toLowerCase().indexOf(q) !== -1 || String(chat.preview || '').toLowerCase().indexOf(q) !== -1;
    });
  }

  function d2RenderRecentSheet() {
    var charChips = '<button class="d2-chip' + (!D2_RECENT_STATE.characterId ? ' is-on' : '') + '" type="button" data-d2recent-filter="">全部</button>' +
      state.characters.map(function (c) {
        return '<button class="d2-chip' + (D2_RECENT_STATE.characterId === c.id ? ' is-on' : '') + '" type="button" data-d2recent-filter="' + esc(c.id) + '">' + esc(c.name) + '</button>';
      }).join('');
    var rows = '';
    if (D2_RECENT_STATE.q.trim()) {
      rows = d2RecentResults.length
        ? d2RecentResults.map(function (hit) {
            var charName = d2ChatCharName(hit.characterId);
            return '<button class="d2-search-hit" type="button" data-d2search-jump="' + esc(hit.chatId) + ':' + (hit.messageId || '') + '">' +
              '<span class="d2-chat-row__top"><span class="d2-chat-row__title">' + esc(hit.chatTitle || '未命名') + '</span>' +
              '<span class="d2-chat-row__time">' + esc(charName) + (hit.time ? ' · ' + esc(hit.time) : '') + '</span></span>' +
              '<span class="d2-chat-row__preview">' + esc(hit.text || '（标题命中）') + '</span></button>';
          }).join('')
        : '<p class="a2-empty">没有搜到。换个关键词试试。</p>';
    } else {
      var list = d2RecentFiltered(d2RecentList);
      rows = list.length
        ? list.map(function (chat) { return d2ChatRowHtml(chat, { showChar: true, activeId: d2ChatActiveId(), selectMode: D2_RECENT_STATE.selectMode, selected: D2_RECENT_STATE.selected }); }).join('')
        : '<p class="a2-empty">还没有聊天记录。先去和角色说句话。</p>';
    }
    var selectedIds = Object.keys(D2_RECENT_STATE.selected).filter(function (id) { return D2_RECENT_STATE.selected[id]; });
    var foot = '';
    if (D2_RECENT_STATE.selectMode) {
      foot = '<div class="d2-select-bar">' +
        '<span>已选 ' + selectedIds.length + ' 段</span>' +
        '<button class="btn btn--soft" type="button" data-d2recent-export>导出选中</button>' +
        '<button class="btn btn--danger" type="button" data-d2recent-delete>删除选中</button>' +
        '<button class="btn" type="button" data-d2recent-cancel>取消</button></div>';
    }
    return {
      title: '最近的聊天',
      body: '<div class="d2-recent-head">' +
          '<input class="field" id="d2RecentSearch" type="search" placeholder="搜消息内容或标题，点结果跳过去" value="' + esc(D2_RECENT_STATE.q) + '">' +
          '<button class="text-btn" type="button" data-d2recent-selectmode>' + (D2_RECENT_STATE.selectMode ? '完成' : '多选') + '</button>' +
        '</div>' +
        '<div class="d2-chips">' + charChips + '</div>' +
        '<div class="d2-chat-list">' + rows + '</div>' +
        '<input type="file" id="d2ChatImportFile" accept=".json,.jsonl,application/json,text/plain" hidden>',
      foot: foot
    };
  }

  var d2RecentList = [];
  var d2RecentResults = [];

  function d2OpenRecentChats() {
    D2_RECENT_STATE.q = '';
    D2_RECENT_STATE.characterId = '';
    D2_RECENT_STATE.selectMode = false;
    D2_RECENT_STATE.selected = {};
    d2RecentResults = [];
    openSheet('d2RecentChats');
    D2ChatStore.list('').then(function (list) {
      d2RecentList = list;
      if (sheetName === 'd2RecentChats') openSheet('d2RecentChats');
    }).catch(function (err) { toast(err.message || '最近的聊天没拉下来，稍后再试。'); });
  }

  function d2SheetRecentChats() { return d2RenderRecentSheet(); }

  function d2RunRecentSearch() {
    var q = D2_RECENT_STATE.q.trim();
    if (!q) { d2RecentResults = []; if (sheetName === 'd2RecentChats') openSheet('d2RecentChats'); return; }
    D2ChatStore.search(q, D2_RECENT_STATE.characterId).then(function (results) {
      d2RecentResults = results;
      if (sheetName === 'd2RecentChats') openSheet('d2RecentChats');
    }).catch(function (err) { toast(err.message || '搜索没成功，稍后再试。'); });
  }

  function d2JumpToMessage(chatId, messageId) {
    D2ChatStore.switchTo(chatId).then(function () {
      closeSheet();
      setTimeout(function () {
        if (!messageId) { scrollChatBottom(false); return; }
        var el = document.querySelector('[data-msg-id="' + messageId + '"]');
        if (el) {
          el.scrollIntoView({ block: 'center', behavior: 'smooth' });
          el.classList.add('is-flash');
          setTimeout(function () { el.classList.remove('is-flash'); }, 1800);
        } else {
          scrollChatBottom(false);
        }
      }, 120);
    }).catch(function (err) { toast(err.message || '这段对话打不开。'); });
  }

  /* ---------------- 人设三层绑定 ---------------- */
  function d2PersonaLayerRow(label, persona, sourceLabel, how) {
    return '<div class="d2-layer-row"><span class="d2-layer-row__label">' + esc(label) + '</span>' +
      '<span class="d2-layer-row__main"><span class="d2-layer-row__name">' + esc(persona ? persona.name : '未设置') + '</span>' +
      '<span class="d2-layer-row__sub">' + esc(how || '') + '</span></span>' +
      '<span class="a2-tag a2-tag--muted">' + esc(sourceLabel) + '</span></div>';
  }

  function d2SheetPersonaSwitch() {
    var character = currentChar();
    if (!character) return null;
    var chat = d2ActiveChat(character.id);
    var chatPersona = chat && chat.personaId ? findPersona(chat.personaId) : null;
    var charPersona = character.defaultPersonaId ? findPersona(character.defaultPersonaId) : null;
    var globalPersona = defaultPersona();
    var effective = resolvedPersona(chat, character);
    var sourceLabel = effective.source === 'chat' ? '这段聊天' : (effective.source === 'char' ? '角色默认' : '全局默认');
    var promptOn = state.settings.personaSwitchPrompt !== false;
    var autoBind = !!state.settings.autoBindPersonaChat;
    var options = '<button class="option' + (!chatPersona ? ' is-selected' : '') + '" type="button" data-d2persona-pick="">' +
      '<span class="option__mark" aria-hidden="true">默</span><span class="option__main"><span class="option__title">跟随角色 / 全局</span>' +
      '<span class="option__desc">这段聊天不单独指定</span></span></button>';
    state.userPersonas.forEach(function (p) {
      options += '<button class="option' + (chat && chat.personaId === p.id ? ' is-selected' : '') + '" type="button" data-d2persona-pick="' + esc(p.id) + '">' +
        avatarHTML(p, 'avatar avatar--me option__avatar') +
        '<span class="option__main"><span class="option__title">' + esc(p.name) + '</span><span class="option__desc">' + esc(firstSentence(p.description)) + '</span></span>' +
        (character.defaultPersonaId === p.id ? '<span class="option__source">角色默认</span>' : (p.is_default ? '<span class="option__source">全局默认</span>' : '')) + '</button>';
    });
    return {
      title: '人设 · 三层绑定',
      body: '<p class="sheet-label">现在生效：' + esc(sourceLabel) + '</p>' +
        '<div class="d2-layers">' +
          d2PersonaLayerRow('默认', globalPersona, '全局', '所有角色默认用这套') +
          d2PersonaLayerRow('角色', charPersona, charPersona ? '角色默认' : '未绑定', character.name + ' 的默认') +
          d2PersonaLayerRow('这段聊天', chatPersona, '聊天', '只对这段对话生效') +
        '</div>' +
        '<div class="d2-layer-note">优先级：聊天 &gt; 角色 &gt; 默认</div>' +
        '<div class="toggle-row"><div class="toggle-row__main"><span class="toggle-row__label">切换人设时提示</span><span class="toggle-row__sub">换「我」时问一句只改这场还是设为默认</span></div>' +
          '<button class="switch" id="d2SwitchPersonaPrompt" type="button" role="switch" aria-checked="' + String(promptOn) + '"><span></span></button></div>' +
        '<div class="toggle-row"><div class="toggle-row__main"><span class="toggle-row__label">自动把选中的人设绑定到当前聊天</span><span class="toggle-row__sub">不等确认，直接绑定这段对话</span></div>' +
          '<button class="switch" id="d2SwitchAutoBindPersona" type="button" role="switch" aria-checked="' + String(autoBind) + '"><span></span></button></div>' +
        '<p class="sheet-label">换成</p><div class="option-list">' + options + '</div>' +
        '<p class="a2-note">「这段聊天」优先于「角色默认」和「全局默认」；换回来会自动恢复。</p>'
    };
  };

  function d2PickPersona(personaId) {
    var character = currentChar();
    if (!character) return;
    var chat = d2ActiveChat(character.id);
    var persona = personaId ? findPersona(personaId) : null;
    var promptOn = state.settings.personaSwitchPrompt !== false;
    var autoBind = !!state.settings.autoBindPersonaChat;
    function bindChat() {
      if (!chat) return;
      chat.personaId = personaId || '';
      save();
      renderChatContext();
      renderMe();
      paintAllAvatars();
      toast(persona ? '这段聊天里的我是「' + persona.name + '」。' : '这段聊天跟随角色 / 全局默认。');
      d2ChatEmit();
      openSheet('personaSwitch');
    }
    if (!personaId) { bindChat(); return; }
    if (autoBind || !promptOn) { bindChat(); return; }
    openSheet('d2PersonaApply', { personaId: personaId, personaName: persona ? persona.name : '', characterId: character.id });
  }

  function d2SheetPersonaApply(payload) {
    payload = payload || {};
    return {
      title: '换成「' + (payload.personaName || '') + '」',
      body: '<p class="sheet-note" style="text-align:left">只改这段聊天，还是同时设为角色默认？</p>',
      foot: '<button class="btn btn--soft" type="button" data-d2persona-apply="chat">只改这场</button>' +
        '<button class="btn btn--primary" type="button" data-d2persona-apply="default">同时设为角色默认</button>'
    };
  };

  /* ---------------- 设置页开关 ---------------- */
  function d2SettingsSwitch(id, label, sub, on) {
    return '<div class="toggle-row"><div class="toggle-row__main"><span class="toggle-row__label">' + esc(label) + '</span>' +
      '<span class="toggle-row__sub">' + esc(sub) + '</span></div>' +
      '<button class="switch" id="' + id + '" type="button" role="switch" aria-checked="' + String(on) + '"><span></span></button></div>';
  }

  function d2RenderChatSettings() {
    var host = document.querySelector('.view--settings .page-scroll');
    if (!host) return;
    var card = document.getElementById('d2ChatSettingsCard');
    if (!card) {
      card = document.createElement('article');
      card.className = 'card d2-settings-card';
      card.id = 'd2ChatSettingsCard';
      host.appendChild(card);
    }
    card.innerHTML = '<div class="card-head"><span class="label"><span class="star">✧</span> 聊天记录</span></div>' +
      d2SettingsSwitch('d2SwitchChatPersonaPrompt', '切换人设时提示', '换「我」时问一句只改这场还是设为默认', state.settings.personaSwitchPrompt !== false) +
      d2SettingsSwitch('d2SwitchAutoBindChatPersona', '自动绑定人设到当前聊天', '选中的人设直接绑到这段对话', !!state.settings.autoBindPersonaChat) +
      d2SettingsSwitch('d2SwitchAiChatTitle', 'AI 帮我起聊天标题', '默认关闭；改标题时手动点「帮我起个名」也可以', !!state.settings.aiChatTitle);
  }

  function d2RenderRecentChatsEntry() {
    var sub = document.getElementById('d2RecentChatsSub');
    if (!sub) return;
    D2ChatStore.list('').then(function (list) {
      var today = 0;
      var now = new Date();
      list.forEach(function (chat) {
        var d = new Date(chat.lastAt || '');
        if (!isNaN(d.getTime()) && d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()) today += 1;
      });
      sub.textContent = list.length + ' 段 · 今天 ' + today + ' 段';
    }).catch(function () { sub.textContent = '查看全部角色按时间混排的聊天'; });
  }

  /* ---------------- 事件 ---------------- */
  function d2ChatHistoryInit() {
    SHEETS.d2Confirm = d2SheetD2Confirm;
    SHEETS.d2ChatList = d2SheetChatList;
    SHEETS.d2Rename = d2SheetRename;
    SHEETS.d2RecentChats = d2SheetRecentChats;
    SHEETS.personaSwitch = d2SheetPersonaSwitch;
    SHEETS.d2PersonaApply = d2SheetPersonaApply;
    SHEETS.d2ChatRowActions = d2SheetChatRowActions;
    var meList = document.getElementById('meList');
    if (meList && !document.getElementById('d2RecentChatsRow')) {
      var row = document.createElement('button');
      row.className = 'list-row';
      row.id = 'd2RecentChatsRow';
      row.type = 'button';
      row.innerHTML = '<span class="row-icon"><svg viewBox="0 0 20 20" fill="none"><path d="M3.6 4.6h12.8v9.4H9.2l-3.4 2.6v-2.6H3.6z"/><path d="M6.6 8h6.8M6.6 10.6h4.2"/></svg></span>' +
        '<span class="row-main"><span class="row-title serif">最近的聊天</span><span class="row-sub" id="d2RecentChatsSub">全部角色 · 按时间混排</span></span>' +
        '<svg class="row-chev" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M8 5.6 12.4 10 8 14.4"/></svg>';
      row.addEventListener('click', d2OpenRecentChats);
      meList.insertBefore(row, meList.firstChild);
    }

    document.addEventListener('click', function (e) {
      var el = e.target && e.target.closest ? e.target : null;
      if (!el) return;
      function closest(sel) { return el.closest(sel); }
      var hit;
      if ((hit = closest('[data-d2char-chats]'))) {
        d2OpenChatList(hit.getAttribute('data-d2char-chats'));
        return;
      }
      if ((hit = closest('[data-d2-confirm-run]'))) {
        var cb = D2_CONFIRM_CB;
        D2_CONFIRM_CB = null;
        closeSheet();
        if (typeof cb === 'function') cb();
        return;
      }
      if ((hit = closest('[data-d2chat-new]'))) {
        D2ChatStore.create(d2ChatListState.characterId || state.currentCharacterId).then(function (chat) {
          closeSheet();
          toast('开了一段新对话：' + chat.title);
          d2OpenChatList(chat.characterId);
        }).catch(function (err) { toast(err.message || '新对话没建成，稍后再试。'); });
        return;
      }
      if ((hit = closest('[data-d2chat-open]'))) {
        var chatId = hit.getAttribute('data-d2chat-open');
        D2ChatStore.switchTo(chatId).then(function () { closeSheet(); }).catch(function (err) { toast(err.message || '这段对话打不开。'); });
        return;
      }
      if ((hit = closest('[data-d2chat-more]'))) {
        d2OpenChatActions(hit.getAttribute('data-d2chat-more'));
        return;
      }
      if ((hit = closest('[data-d2chat-check]'))) {
        var id = hit.getAttribute('data-d2chat-check');
        if (D2_RECENT_STATE.selected[id]) delete D2_RECENT_STATE.selected[id]; else D2_RECENT_STATE.selected[id] = true;
        if (sheetName === 'd2RecentChats') openSheet('d2RecentChats');
        return;
      }
      if ((hit = closest('[data-d2recent-filter]'))) {
        D2_RECENT_STATE.characterId = hit.getAttribute('data-d2recent-filter') || '';
        openSheet('d2RecentChats');
        if (D2_RECENT_STATE.q.trim()) d2RunRecentSearch();
        return;
      }
      if ((hit = closest('[data-d2recent-selectmode]'))) {
        D2_RECENT_STATE.selectMode = !D2_RECENT_STATE.selectMode;
        D2_RECENT_STATE.selected = {};
        openSheet('d2RecentChats');
        return;
      }
      if ((hit = closest('[data-d2recent-cancel]'))) {
        D2_RECENT_STATE.selectMode = false;
        D2_RECENT_STATE.selected = {};
        openSheet('d2RecentChats');
        return;
      }
      if ((hit = closest('[data-d2recent-delete]'))) {
        var ids = Object.keys(D2_RECENT_STATE.selected).filter(function (key) { return D2_RECENT_STATE.selected[key]; });
        if (!ids.length) { toast('先选几段对话。'); return; }
        d2OpenConfirm('删除这些对话？', '删掉就找不回来了（' + ids.length + ' 段）。', '删除', function () {
          D2ChatStore.remove(ids).then(function () {
            D2_RECENT_STATE.selected = {};
            toast('删掉了 ' + ids.length + ' 段对话。');
            d2OpenRecentChats();
          }).catch(function (err) { toast(err.message || '删除没成功。'); });
        }, true);
        return;
      }
      if ((hit = closest('[data-d2recent-export]'))) {
        var expIds = Object.keys(D2_RECENT_STATE.selected).filter(function (key) { return D2_RECENT_STATE.selected[key]; });
        if (!expIds.length) { toast('先选几段对话。'); return; }
        D2ChatStore.exportChats(expIds).then(function () { toast('导出好了。'); }).catch(function (err) { toast(err.message || '导出没成功。'); });
        return;
      }
      if ((hit = closest('[data-d2search-jump]'))) {
        var parts = String(hit.getAttribute('data-d2search-jump')).split(':');
        d2JumpToMessage(parts[0], parts[1] ? parseInt(parts[1], 10) : 0);
        return;
      }
      if ((hit = closest('[data-d2persona-pick]'))) {
        d2PickPersona(hit.getAttribute('data-d2persona-pick') || '');
        return;
      }
      if ((hit = closest('[data-d2persona-apply]'))) {
        var mode = hit.getAttribute('data-d2persona-apply');
        var pending = sheetPayload && sheetPayload.personaId ? sheetPayload.personaId : '';
        var character = currentChar();
        var chat = d2ActiveChat(character.id);
        var persona = findPersona(pending);
        if (mode === 'chat' && chat) {
          chat.personaId = pending || '';
          save(); renderChatContext(); renderMe(); paintAllAvatars();
          closeSheet();
          toast(persona ? '这场聊天里的我是「' + persona.name + '」。' : '这场跟随默认。');
        } else if (persona && character) {
          if (chat) chat.personaId = persona.id;
          character.defaultPersonaId = persona.id;
          save(); renderChatContext(); renderMe(); renderCharLibrary(); renderPersonaLibrary(); paintAllAvatars();
          closeSheet();
          toast('这段和以后的聊天都用「' + persona.name + '」。');
        }
        return;
      }
      if ((hit = closest('[data-d2chat-rename-save]'))) {
        var renameId = hit.getAttribute('data-d2chat-rename-save');
        var input = document.getElementById('d2RenameInput');
        var fromSheet = sheetName;
        D2ChatStore.rename(renameId, input ? input.value : '').then(function () {
          closeSheet();
          toast('名字改好了。');
          if (fromSheet === 'd2ChatList') d2OpenChatList(d2ChatListState.characterId);
          else d2OpenRecentChats();
        }).catch(function (err) { toast(err.message || '改名没成功。'); });
        return;
      }
      if ((hit = closest('[data-d2chat-ai-title]'))) {
        var aiId = hit.getAttribute('data-d2chat-ai-title');
        D2ChatStore.autoTitle(aiId).then(function (data) {
          var inputEl = document.getElementById('d2RenameInput');
          if (inputEl && data.title) { inputEl.value = data.title; toast('AI 起的名字：' + data.title); }
        }).catch(function (err) { toast(err.message || '这次没能起名，可以自己改。'); });
        return;
      }
      if ((hit = closest('[data-d2chat-import]'))) {
        var fileInput = document.getElementById('d2ChatImportFile');
        if (fileInput) fileInput.click();
        return;
      }
      if ((hit = closest('[data-d2recent-import]'))) {
        var fileInput2 = document.getElementById('d2ChatImportFile');
        if (fileInput2) fileInput2.click();
        return;
      }
    });

    document.addEventListener('change', function (e) {
      var el = e.target;
      if (!el || el.id !== 'd2ChatImportFile') return;
      var file = el.files && el.files[0];
      el.value = '';
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        D2ChatStore.importContent(String(reader.result || ''), d2ChatListState.characterId || state.currentCharacterId).then(function (chat) {
          closeSheet();
          toast('导入好了：' + (chat.title || '一段新对话'));
        }).catch(function (err) { toast(err.message || '导入没成功，检查一下文件格式。'); });
      };
      reader.readAsText(file, 'utf-8');
    });

    document.addEventListener('input', function (e) {
      var el = e.target;
      if (el && el.id === 'd2RecentSearch') {
        D2_RECENT_STATE.q = el.value;
        if (d2RecentSearchTimer) clearTimeout(d2RecentSearchTimer);
        d2RecentSearchTimer = setTimeout(function () {
          if (D2_RECENT_STATE.q.trim()) d2RunRecentSearch();
          else { d2RecentResults = []; if (sheetName === 'd2RecentChats') openSheet('d2RecentChats'); }
        }, 260);
      }
    });

    document.addEventListener('click', function (e) {
      var el = e.target && e.target.closest ? e.target : null;
      if (!el || !el.closest) return;
      if (el.closest('#d2SwitchPersonaPrompt')) {
        state.settings.personaSwitchPrompt = state.settings.personaSwitchPrompt === false ? true : false;
        save();
        openSheet('personaSwitch');
        return;
      }
      if (el.closest('#d2SwitchAutoBindPersona') || el.closest('#d2SwitchAutoBindChatPersona')) {
        state.settings.autoBindPersonaChat = !state.settings.autoBindPersonaChat;
        save();
        if (sheetName === 'personaSwitch') openSheet('personaSwitch'); else d2RenderChatSettings();
        return;
      }
      if (el.closest('#d2SwitchChatPersonaPrompt')) {
        state.settings.personaSwitchPrompt = state.settings.personaSwitchPrompt === false ? true : false;
        save();
        d2RenderChatSettings();
        return;
      }
      if (el.closest('#d2SwitchAiChatTitle')) {
        state.settings.aiChatTitle = !state.settings.aiChatTitle;
        save();
        d2RenderChatSettings();
        return;
      }
    });

    D2ChatStore.onChange(function () {
      if (sheetName === 'd2ChatList') d2OpenChatList(d2ChatListState.characterId);
    });
    d2RenderRecentChatsEntry();
  }

  /* 对话列表行尾「⋯」操作弹层 */
  function d2OpenChatActions(chatId) {
    D2ChatStore.get(chatId).then(function (chat) {
      var pinned = !!chat.pinned;
      openSheet('d2ChatRowActions', { chatId: chatId, chat: chat, pinned: pinned });
    }).catch(function (err) { toast(err.message || '这段对话打不开。'); });
  }

  function d2SheetChatRowActions(payload) {
    payload = payload || {};
    var chatId = payload.chatId;
    var chat = payload.chat || {};
    return {
      title: chat.title || '对话',
      body: '<div class="menu-list">' +
        '<button class="menu-row" type="button" data-d2row-rename="' + esc(chatId) + '"><span class="menu-row__icon">✎</span><span class="menu-row__main"><span class="menu-row__title">改名</span><span class="menu-row__sub">也可以让 AI 帮我起个名</span></span></button>' +
        '<button class="menu-row" type="button" data-d2row-pin="' + esc(chatId) + '"><span class="menu-row__icon">✧</span><span class="menu-row__main"><span class="menu-row__title">' + (payload.pinned ? '取消置顶' : '置顶') + '</span><span class="menu-row__sub">' + (payload.pinned ? '放回按时间排序' : '小珍珠标记，排最前面') + '</span></span></button>' +
        '<button class="menu-row" type="button" data-d2row-switch="' + esc(chatId) + '"><span class="menu-row__icon">↩</span><span class="menu-row__main"><span class="menu-row__title">切换到这段</span><span class="menu-row__sub">' + esc(chat.preview || '') + '</span></span></button>' +
        '<button class="menu-row" type="button" data-d2row-export="' + esc(chatId) + '"><span class="menu-row__icon">⇩</span><span class="menu-row__main"><span class="menu-row__title">导出这段</span><span class="menu-row__sub">本项目 JSON，含绑定信息</span></span></button>' +
        '<button class="menu-row" type="button" data-d2row-delete="' + esc(chatId) + '"><span class="menu-row__icon">✕</span><span class="menu-row__main"><span class="menu-row__title">删除这段</span><span class="menu-row__sub">删掉就找不回来了</span></span></button>' +
        '</div>'
    };
  };

  var d2RecentSearchTimer = null;

  document.addEventListener('DOMContentLoaded', function () {
    setTimeout(d2ChatHistoryInit, 0);
    document.addEventListener('click', function (e) {
      var el = e.target && e.target.closest ? e.target : null;
      if (!el || !el.closest) return;
      var hit;
      if ((hit = el.closest('[data-d2row-rename]'))) { d2RenameChatFlow(hit.getAttribute('data-d2row-rename')); return; }
      if ((hit = el.closest('[data-d2row-pin]'))) {
        var pinId = hit.getAttribute('data-d2row-pin');
        var pinFrom = d2ChatListState.characterId ? 'd2ChatList' : 'd2RecentChats';
        D2ChatStore.get(pinId).then(function (chat) {
          return D2ChatStore.setPinned(pinId, !chat.pinned).then(function () {
            closeSheet();
            if (pinFrom === 'd2ChatList') d2OpenChatList(d2ChatListState.characterId); else d2OpenRecentChats();
          });
        }).catch(function (err) { toast(err.message || '置顶没成功。'); });
        return;
      }
      if ((hit = el.closest('[data-d2row-switch]'))) {
        D2ChatStore.switchTo(hit.getAttribute('data-d2row-switch')).then(function () { closeSheet(); }).catch(function (err) { toast(err.message || '打不开这段对话。'); });
        return;
      }
      if ((hit = el.closest('[data-d2row-export]'))) {
        D2ChatStore.exportChat(hit.getAttribute('data-d2row-export')).then(function () { toast('导出好了。'); }).catch(function (err) { toast(err.message || '导出没成功。'); });
        return;
      }
      if ((hit = el.closest('[data-d2row-delete]'))) {
        var delId = hit.getAttribute('data-d2row-delete');
        var delFrom = d2ChatListState.characterId ? 'd2ChatList' : 'd2RecentChats';
        d2OpenConfirm('删除这段对话？', '删掉就找不回来了。', '删除', function () {
          D2ChatStore.remove([delId]).then(function () {
            toast('删掉了。');
            if (delFrom === 'd2ChatList') d2OpenChatList(d2ChatListState.characterId); else d2OpenRecentChats();
          }).catch(function (err) { toast(err.message || '删除没成功。'); });
        }, true);
        return;
      }
    });
  });
