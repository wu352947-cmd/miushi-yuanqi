/* 统计页：数据聚合 + 图表 / 热力图 / 排行 / 余额渲染。
 *
 * 从 src/app.js 的「统计页」分节整块拆出。构建时 build.mjs 会把本文件拼进
 * app.js 的模块注入点，仍处于同一个 IIFE 作用域，函数声明照旧互相可见。
 * 本文件顶层只有字面量初始化，不依赖 app.js 的初始化顺序。
 */

/* ---- 统计页状态（原先散在 app.js 的 A2 状态区，一并搬过来）---- */
  var statsRange = '7d';
  var statsMetric = 'token';
  var rankTab = 'model';

  /* ---------------- 统计页 ---------------- */
  var CURRENCY_RATE = 7.1;
  var STATS_RANGES = [
    { id: 'today', label: '今天' },
    { id: '7d', label: '7 天' },
    { id: '30d', label: '30 天' },
    { id: '90d', label: '90 天' },
    { id: 'all', label: '全部' }
  ];
  function usageRecords() { return DATA.usageRecords || []; }
  function rangeCutoff(range) {
    var today = new Date();
    today.setHours(0, 0, 0, 0);
    if (range === 'today') return today.getTime();
    if (range === '7d') return today.getTime() - 6 * 86400000;
    if (range === '30d') return today.getTime() - 29 * 86400000;
    if (range === '90d') return today.getTime() - 89 * 86400000;
    return 0;
  }
  function rangeRecords(range) {
    var cut = rangeCutoff(range);
    return usageRecords().filter(function (r) { return !cut || r.t >= cut; });
  }
  function costOfRecord(r) {
    var m = findModel(r.m);
    var price = m && m.price ? m.price : null;
    if (!price) return { cost: 0, priced: false, rate: 1 };
    var rate = (price.currency === '$') ? CURRENCY_RATE : 1;
    var cached = r.ct || 0;
    var input = Math.max(0, (r.pt || 0) - cached);
    var cost = (input * (price.input || 0) + cached * (price.cache || 0) + (r.ot || 0) * (price.output || 0)) / 1000000 * rate;
    return { cost: cost, priced: true, rate: rate };
  }
  function dayKey(ts) {
    var d = new Date(ts);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  function monthKey(ts) {
    var d = new Date(ts);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1);
  }
  function aggregateUsage(records) {
    var t = {
      prompt: 0, cache: 0, output: 0, ms: 0, count: 0, errors: 0, cost: 0,
      unpriced: {}, byModel: {}, byProvider: {}, byChar: {}, byDay: {}, byMonth: {}
    };
    records.forEach(function (r) {
      var tokens = (r.pt || 0) + (r.ot || 0);
      var c = costOfRecord(r);
      t.prompt += r.pt || 0;
      t.cache += r.ct || 0;
      t.output += r.ot || 0;
      t.ms += r.ms || 0;
      t.count += 1;
      if (r.err) t.errors += 1;
      t.cost += c.cost;
      if (!c.priced) t.unpriced[r.m] = 1;
      function bump(map, key) {
        if (!map[key]) map[key] = { tokens: 0, count: 0, cost: 0 };
        map[key].tokens += tokens;
        map[key].count += 1;
        map[key].cost += c.cost;
      }
      bump(t.byModel, r.m);
      bump(t.byProvider, r.p);
      bump(t.byChar, r.c);
      if (!t.byDay[dayKey(r.t)]) t.byDay[dayKey(r.t)] = { tokens: 0, prompt: 0, cache: 0, output: 0, cost: 0, count: 0 };
      var dd = t.byDay[dayKey(r.t)];
      dd.tokens += tokens; dd.prompt += r.pt || 0; dd.cache += r.ct || 0; dd.output += r.ot || 0; dd.cost += c.cost; dd.count += 1;
      if (!t.byMonth[monthKey(r.t)]) t.byMonth[monthKey(r.t)] = { tokens: 0, prompt: 0, cache: 0, output: 0, cost: 0, count: 0 };
      var mm = t.byMonth[monthKey(r.t)];
      mm.tokens += tokens; mm.prompt += r.pt || 0; mm.cache += r.ct || 0; mm.output += r.ot || 0; mm.cost += c.cost; mm.count += 1;
    });
    t.hitRate = t.prompt ? t.cache / t.prompt : 0;
    t.avgMs = t.count ? t.ms / t.count : 0;
    t.unpricedCount = Object.keys(t.unpriced).length;
    return t;
  }
  function fmtTok(n) {
    n = n || 0;
    if (n >= 1000000) return (n / 1000000).toFixed(2) + 'M';
    if (n >= 10000) return (n / 10000).toFixed(1) + ' 万';
    return fmtNum(n);
  }
  function fmtCost(n) { return '¥' + (n || 0).toFixed(2); }
  function fmtMs(ms) { return (ms / 1000).toFixed(1) + 's'; }

  function statsRangeChips() {
    return '<div class="stats-range" role="group" aria-label="时间范围">' +
      STATS_RANGES.map(function (r) {
        return '<button class="' + (statsRange === r.id ? 'is-on' : '') + '" type="button" data-a2="stats-range" data-value="' + r.id + '" aria-pressed="' + (statsRange === r.id ? 'true' : 'false') + '">' + esc(r.label) + '</button>';
      }).join('') + '</div>';
  }
  function statsHero(agg, rangeLabel) {
    var changes = statsMetric === 'cost'
      ? fmtCost(agg.cost)
      : fmtTok(agg.prompt + agg.output);
    return '<div class="a2-card">' +
      '<div class="a2-card__head"><span class="label">' + esc(rangeLabel) + '总览</span></div>' +
      '<p class="reason-current" style="font-size:30px;letter-spacing:.02em">' + changes + '<span style="font-family:var(--sans);font-size:10px;color:var(--text-3);margin-left:6px">' + (statsMetric === 'cost' ? '估算花费' : 'token') + '</span></p>' +
      '<div class="stats-overview" style="margin-top:12px">' +
        '<div class="stat-cell"><b class="stat-cell__num">' + fmtTok(agg.prompt) + '</b><span class="stat-cell__label">输入 Token</span></div>' +
        '<div class="stat-cell"><b class="stat-cell__num">' + fmtTok(agg.output) + '</b><span class="stat-cell__label">输出 Token</span></div>' +
        '<div class="stat-cell"><b class="stat-cell__num">' + fmtTok(agg.cache) + '</b><span class="stat-cell__label">缓存命中 Token</span></div>' +
        '<div class="stat-cell"><b class="stat-cell__num">' + (agg.hitRate * 100).toFixed(1) + '<small>%</small></b><span class="stat-cell__label">缓存命中率</span></div>' +
        '<div class="stat-cell stat-cell--wide"><b class="stat-cell__num">' + fmtCost(agg.cost) + '</b><span class="stat-cell__label">估算花费 · 按模型单价折算' + (agg.unpricedCount ? '（' + agg.unpricedCount + ' 个模型未设单价，未计入）' : '') + '</span></div>' +
        '<div class="stat-cell"><b class="stat-cell__num">' + fmtNum(agg.count) + '</b><span class="stat-cell__label">请求次数</span></div>' +
        '<div class="stat-cell"><b class="stat-cell__num">' + fmtMs(agg.avgMs) + '</b><span class="stat-cell__label">平均每次回复用时</span></div>' +
      '</div>' +
      '<p class="a2-note" style="text-align:left">花费 = 各类 token × 模型单价；美元按 ¥' + CURRENCY_RATE + ' / $ 折算。数据来自本地假 usage 记录（约 60 天）。</p>' +
    '</div>';
  }
  function heatmapHtml() {
    var today = new Date();
    today.setHours(0, 0, 0, 0);
    var start = new Date(today.getTime() - 364 * 86400000);
    start = new Date(start.getTime() - start.getDay() * 86400000);
    var counts = {};
    var max = 0;
    usageRecords().forEach(function (r) {
      var d = new Date(r.t);
      d.setHours(0, 0, 0, 0);
      var k = d.getTime();
      counts[k] = (counts[k] || 0) + 1;
      if (counts[k] > max) max = counts[k];
    });
    var dayCount = Math.round((today.getTime() - start.getTime()) / 86400000) + 1;
    var totalCells = Math.ceil(dayCount / 7) * 7;
    var cells = '';
    for (var i = 0; i < totalCells; i++) {
      var ts = start.getTime() + i * 86400000;
      var cnt = counts[ts] || 0;
      var level = 0;
      if (cnt > 0) {
        if (cnt >= Math.max(5, Math.ceil(max * 0.75))) level = 4;
        else if (cnt >= Math.max(3, Math.ceil(max * 0.5))) level = 3;
        else if (cnt >= 2) level = 2;
        else level = 1;
      }
      if (ts > today.getTime()) level = 0;
      var d = new Date(ts);
      cells += '<i class="heat-cell" data-l="' + level + '" title="' + (d.getMonth() + 1) + '月' + d.getDate() + '日 · ' + cnt + ' 条"></i>';
    }
    return '<div class="a2-card">' +
      '<div class="a2-card__head"><span class="label">聊天热力图 · 近一年</span><span class="a2-sub">颜色越深，消息越多</span></div>' +
      '<div class="heatmap-wrap"><div class="heatmap" id="heatmap">' + cells + '</div></div>' +
      '<div class="heat-legend"><span>少</span><i data-l="0"></i><i data-l="1"></i><i data-l="2"></i><i data-l="3"></i><i data-l="4"></i><span>多</span></div>' +
      '<p class="a2-note" style="text-align:left">按天统计消息条数（近 365 天），可以左右滑。</p>' +
    '</div>';
  }
  function buildBuckets(records, range) {
    var buckets = [];
    var today = new Date();
    today.setHours(0, 0, 0, 0);
    if (range === 'today') {
      for (var h = 0; h < 24; h++) buckets.push({ key: 'h' + h, label: (h === 0 || h === 6 || h === 12 || h === 18) ? (h + '时') : '', prompt: 0, cache: 0, output: 0, cost: 0, count: 0 });
      records.forEach(function (r) {
        var d = new Date(r.t);
        var b = buckets[d.getHours()];
        if (!b) return;
        b.prompt += r.pt || 0; b.cache += r.ct || 0; b.output += r.ot || 0; b.cost += costOfRecord(r).cost; b.count += 1;
      });
      return { buckets: buckets, mode: 'hour' };
    }
    if (range === 'all') {
      var months = {};
      records.forEach(function (r) { if (!months[monthKey(r.t)]) months[monthKey(r.t)] = 1; });
      var keys = Object.keys(months).sort();
      if (!keys.length) keys = [monthKey(Date.now())];
      keys.forEach(function (k) {
        buckets.push({ key: k, label: (parseInt(k.slice(5), 10)) + '月', prompt: 0, cache: 0, output: 0, cost: 0, count: 0 });
      });
      var map = {};
      buckets.forEach(function (b) { map[b.key] = b; });
      records.forEach(function (r) {
        var b = map[monthKey(r.t)];
        if (!b) return;
        b.prompt += r.pt || 0; b.cache += r.ct || 0; b.output += r.ot || 0; b.cost += costOfRecord(r).cost; b.count += 1;
      });
      return { buckets: buckets, mode: 'month' };
    }
    var days = range === '90d' ? 90 : range === '30d' ? 30 : 7;
    for (var i = days - 1; i >= 0; i--) {
      var d = new Date(today.getTime() - i * 86400000);
      buckets.push({ key: dayKey(d.getTime()), label: (d.getMonth() + 1) + '/' + d.getDate(), prompt: 0, cache: 0, output: 0, cost: 0, count: 0 });
    }
    var dayMap = {};
    buckets.forEach(function (b) { dayMap[b.key] = b; });
    records.forEach(function (r) {
      var b = dayMap[dayKey(r.t)];
      if (!b) return;
      b.prompt += r.pt || 0; b.cache += r.ct || 0; b.output += r.ot || 0; b.cost += costOfRecord(r).cost; b.count += 1;
    });
    return { buckets: buckets, mode: 'day' };
  }
  function chartHtml(records, agg) {
    var built = buildBuckets(records, statsRange);
    var buckets = built.buckets;
    var maxV = 0;
    buckets.forEach(function (b) {
      b.value = statsMetric === 'cost' ? b.cost : (b.prompt + b.cache + b.output);
      if (b.value > maxV) maxV = b.value;
    });
    var step = Math.max(1, Math.ceil(buckets.length / 10));
    var bars = buckets.map(function (b, i) {
      var label = '';
      if (built.mode === 'hour') label = b.label;
      else label = (i % step === 0 || i === buckets.length - 1) ? b.label : '';
      var inner;
      if (statsMetric === 'cost') {
        inner = '<i class="chart-seg chart-seg--cost" style="height:' + (maxV ? Math.max(1, b.value / maxV * 100) : 0).toFixed(1) + '%"></i>';
      } else {
        var hIn = maxV ? Math.max(b.prompt - b.cache, 0) / maxV * 100 : 0;
        var hCache = maxV ? b.cache / maxV * 100 : 0;
        var hOut = maxV ? b.output / maxV * 100 : 0;
        inner = '<i class="chart-seg chart-seg--out" style="height:' + hOut.toFixed(1) + '%"></i>' +
          '<i class="chart-seg chart-seg--cache" style="height:' + hCache.toFixed(1) + '%"></i>' +
          '<i class="chart-seg chart-seg--in" style="height:' + hIn.toFixed(1) + '%"></i>';
      }
      return '<div class="chart-col" title="' + esc(label || b.key) + '"><div class="chart-stack">' + inner + '</div></div>';
    }).join('');
    var labels = buckets.map(function (b, i) {
      var text = built.mode === 'hour' ? '' : ((i % step === 0 || i === buckets.length - 1) ? b.label : '');
      return '<span>' + esc(text) + '</span>';
    }).join('');
    var inTok = agg.prompt - agg.cache;
    return '<div class="a2-card">' +
      '<div class="chart-top"><span class="label">' + (built.mode === 'month' ? '每月用量' : built.mode === 'hour' ? '今天各小时' : '每日用量') + '</span>' +
        '<div class="metric-toggle" role="group" aria-label="统计口径">' +
          '<button class="' + (statsMetric === 'token' ? 'is-on' : '') + '" type="button" data-a2="stats-metric" data-value="token">按 Token</button>' +
          '<button class="' + (statsMetric === 'cost' ? 'is-on' : '') + '" type="button" data-a2="stats-metric" data-value="cost">按花费</button>' +
        '</div></div>' +
      '<div class="chart-bars">' + bars + '</div>' +
      '<div class="chart-labels">' + labels + '</div>' +
      '<div class="chart-legend">' +
        '<span><i class="chart-seg--in"></i>输入</span><span><i class="chart-seg--cache"></i>缓存</span><span><i class="chart-seg--out"></i>输出</span>' +
      '</div>' +
      '<div class="chart-sum" style="margin-top:8px"><span class="a2-sub">本期总计</span><b>' + (statsMetric === 'cost' ? fmtCost(agg.cost) : fmtTok(agg.prompt + agg.output)) + '</b></div>' +
      '<p class="a2-sub" style="margin-top:2px">输入 ' + fmtTok(inTok) + ' · 缓存 ' + fmtTok(agg.cache) + ' · 输出 ' + fmtTok(agg.output) + '</p>' +
    '</div>';
  }
  function rankItems(records) {
    var map = {};
    var total = 0;
    records.forEach(function (r) {
      var key;
      if (rankTab === 'provider') key = r.p;
      else if (rankTab === 'char') key = r.c;
      else key = r.m;
      var tokens = (r.pt || 0) + (r.ot || 0);
      if (!map[key]) map[key] = { key: key, tokens: 0, count: 0, cost: 0 };
      map[key].tokens += tokens;
      map[key].count += 1;
      map[key].cost += costOfRecord(r).cost;
      total += tokens;
    });
    var items = Object.keys(map).map(function (k) {
      var it = map[k];
      it.total = total;
      if (rankTab === 'provider') {
        var p = findProvider(it.key);
        it.label = p ? p.name : '未标记';
        it.icon = p ? providerIconHTML(p, 'p-icon--sm') : '<span class="p-icon p-icon--sm p-icon--letter">·</span>';
      } else if (rankTab === 'char') {
        var c = findChar(it.key);
        it.label = c ? c.name : '未标记';
        it.icon = avatarHTML(c || { name: '·' }, 'avatar avatar--ai av-xxs');
      } else {
        var m = findModel(it.key);
        it.label = m ? m.name : (it.key || '未标记');
        it.icon = m ? modelIconHTML(m, 'p-icon--sm') : '<span class="p-icon p-icon--sm p-icon--letter">·</span>';
      }
      return it;
    });
    items.sort(function (a, b) { return b.tokens - a.tokens; });
    return items;
  }
  function rankHtml(records) {
    var items = rankItems(records).slice(0, 6);
    var max = items.length ? items[0].tokens : 1;
    var rows = items.length ? items.map(function (it) {
      var pct = it.total ? (it.tokens / it.total * 100) : 0;
      return '<div class="rank-row"><span class="rank-row__icon">' + it.icon + '</span>' +
        '<span class="rank-row__main">' +
          '<span class="rank-row__top"><span class="rank-row__name">' + esc(it.label) + '</span>' +
            '<span class="rank-row__num">' + fmtNum(it.count) + ' 次</span></span>' +
          '<span class="rank-bar"><i style="width:' + (max ? (it.tokens / max * 100).toFixed(1) : 0) + '%"></i></span>' +
        '</span><span class="rank-row__pct">' + pct.toFixed(1) + '%</span></div>';
    }).join('') : '<p class="a2-empty">这个范围还没有记录。</p>';
    return '<div class="a2-card">' +
      '<div class="a2-card__head"><span class="label">排行</span></div>' +
      '<div class="rank-tabs" role="group" aria-label="排行维度">' +
        '<button class="' + (rankTab === 'model' ? 'is-on' : '') + '" type="button" data-a2="rank-tab" data-value="model">按模型</button>' +
        '<button class="' + (rankTab === 'provider' ? 'is-on' : '') + '" type="button" data-a2="rank-tab" data-value="provider">按提供商</button>' +
        '<button class="' + (rankTab === 'char' ? 'is-on' : '') + '" type="button" data-a2="rank-tab" data-value="char">按角色</button>' +
      '</div><div class="rank-list">' + rows + '</div>' +
      '<p class="a2-note" style="text-align:left">百分比按 token 占比算，条数是请求次数。陪伴应用里，和谁聊得最多一眼就能看见。</p>' +
    '</div>';
  }
  function balanceHtml() {
    var rows = state.providers.map(function (p) {
      var proto = protocolOf(p);
      var bal = p.balance || {};
      var supported = !!proto.balance;
      var amountHtml;
      if (!supported) {
        amountHtml = '<span class="balance-row__amt is-muted"><b>这家不支持查询</b><span></span></span>';
      } else if (bal.amount || bal.amount === 0) {
        amountHtml = '<span class="balance-row__amt"><b>' + esc(bal.currency || '¥') + Number(bal.amount).toFixed(2) + '</b><span>' + esc(bal.at || '') + '</span></span>';
      } else {
        amountHtml = '<span class="balance-row__amt is-muted"><b>余额暂不可查</b><span>' + (bal.at ? esc(bal.at) : '') + '</span></span>';
      }
      return '<div class="balance-row">' + providerIconHTML(p, 'p-icon--sm') +
        '<span class="balance-row__main"><span class="balance-row__name">' + esc(p.name) + '</span>' +
          '<span class="balance-row__time">' + (supported ? (bal.amount || bal.amount === 0 ? '支持查询余额' : '查询失败时只显示小灰字') : '这家不支持查询余额') + '</span></span>' +
        amountHtml +
        (supported ? '<button class="balance-row__refresh" type="button" data-a2="bal-query" data-id="' + esc(p.id) + '" aria-label="查询余额">' + IC_REFRESH_A2 + '</button>' : '') +
      '</div>';
    }).join('');
    return '<div class="a2-card">' +
      '<div class="a2-card__head"><span class="label">余额</span><span class="a2-sub">只有官方接口支持的类型能查</span></div>' +
      '<div class="balance-list">' + rows + '</div>' +
      '<p class="a2-note" style="text-align:left">查询失败时不弹英文报错，只显示「余额暂不可查」。</p>' +
    '</div>';
  }
  function statsLiteHtml() {
    var chats = Object.keys(state.chats).filter(function (id) { return hasChat(id); }).length;
    var conversations = Math.max(chats, DATA.statsMeta.conversations || 0);
    var messages = DATA.statsMeta.messages || 0;
    return '<div class="a2-card">' +
      '<div class="stat-grid-3">' +
        '<div class="stat-mini"><b>' + fmtNum(conversations) + '</b><span>总对话数</span></div>' +
        '<div class="stat-mini"><b>' + fmtNum(messages) + '</b><span>总消息数</span></div>' +
        '<div class="stat-mini"><b>' + fmtNum(daysTogether(state.settings.startDate)) + '</b><span>在一起天数</span></div>' +
      '</div>' +
      '<p class="a2-note" style="text-align:left">总消息数按 usage 记录与本地聊天粗算；每条记录都带提供商 + 模型 ID + 显示名，旧数据缺信息时归到「未标记」并在这里说明。本次范围里未标记 0 条。</p>' +
    '</div>';
  }
  /* ---------- B 阶段：统计页数字全部来自后端 usage 表 ---------- */
  var statsServerData = null;
  var statsLoading = false;

  function renderStats() {
    var box = document.getElementById('statsScroll');
    if (!box) return;
    if (!SERVER_MODE || !serverOnline) { renderStatsLocal(); return; }
    if (statsServerData) {
      renderStatsServer(statsServerData, true);
    } else {
      box.innerHTML = statsRangeChips() + '<div class="a2-card"><p class="a2-sub">正在从服务器汇总 usage…</p></div>';
    }
    loadServerStats();
  }

  function loadServerStats() {
    if (statsLoading) return;
    statsLoading = true;
    serverFetch('/stats?range=' + encodeURIComponent(statsRange) + '&metric=' + encodeURIComponent(statsMetric) + '&rank=' + encodeURIComponent(rankTab)).then(function (data) {
      statsLoading = false;
      statsServerData = data;
      renderStatsServer(data, true);
    }).catch(function (err) {
      statsLoading = false;
      var box = document.getElementById('statsScroll');
      if (box) box.innerHTML = statsRangeChips() + '<div class="a2-card"><p class="a2-sub">统计没加载出来：' + esc(err.message) + '</p></div>';
    });
  }

  function renderStatsServer(data, keepScroll) {
    var box = document.getElementById('statsScroll');
    if (!box) return;
    var top = keepScroll ? box.scrollTop : 0;
    box.innerHTML = statsRangeChips() +
      '<div class="a2-banner">' + IC_INFO_A2 +
        '<span>每条记录由服务器从 API 的 usage 字段写入 SQLite 的 usage 表（输入 / 缓存 / 输出 / 耗时 / 是否出错 / 是否估算），统计页只从这里汇总。余额卡来自提供商缓存。</span></div>' +
      statsServerHero(data.overview, data.rangeLabel) +
      heatmapServerHtml(data.heatmap) +
      chartServerHtml(data) +
      rankServerHtml(data.rank) +
      balanceServerHtml(data.balance) +
      liteServerHtml(data.lite, data.overview);
    box.scrollTop = top;
    var hm = document.getElementById('heatmap');
    if (hm) hm.scrollLeft = hm.scrollWidth;
  }

  function statsServerHero(agg, rangeLabel) {
    agg = agg || {};
    var main = statsMetric === 'cost' ? fmtCost(agg.cost) : fmtTok((agg.prompt || 0) + (agg.output || 0));
    var note = '花费 = 各类 token × 模型单价；美元按 ¥' + (agg.currencyRate || CURRENCY_RATE) + ' / $ 折算。';
    if (agg.estimatedCount) note += ' 其中 ' + agg.estimatedCount + ' 条是拿不到 usage 时按字数估算的。';
    return '<div class="a2-card">' +
      '<div class="a2-card__head"><span class="label">' + esc(rangeLabel || '') + '总览</span></div>' +
      '<p class="reason-current" style="font-size:30px;letter-spacing:.02em">' + main + '<span style="font-family:var(--sans);font-size:10px;color:var(--text-3);margin-left:6px">' + (statsMetric === 'cost' ? '估算花费' : 'token') + '</span></p>' +
      '<div class="stats-overview" style="margin-top:12px">' +
        '<div class="stat-cell"><b class="stat-cell__num">' + fmtTok(agg.prompt) + '</b><span class="stat-cell__label">输入 Token</span></div>' +
        '<div class="stat-cell"><b class="stat-cell__num">' + fmtTok(agg.output) + '</b><span class="stat-cell__label">输出 Token</span></div>' +
        '<div class="stat-cell"><b class="stat-cell__num">' + fmtTok(agg.cache) + '</b><span class="stat-cell__label">缓存命中 Token</span></div>' +
        '<div class="stat-cell"><b class="stat-cell__num">' + (Number(agg.hitRate || 0) * 100).toFixed(1) + '<small>%</small></b><span class="stat-cell__label">缓存命中率</span></div>' +
        '<div class="stat-cell stat-cell--wide"><b class="stat-cell__num">' + fmtCost(agg.cost) + '</b><span class="stat-cell__label">估算花费 · 按模型单价折算' + (agg.unpricedCount ? '（' + agg.unpricedCount + ' 个模型未设单价，未计入）' : '') + '</span></div>' +
        '<div class="stat-cell"><b class="stat-cell__num">' + fmtNum(agg.count || 0) + '</b><span class="stat-cell__label">请求次数</span></div>' +
        '<div class="stat-cell"><b class="stat-cell__num">' + fmtMs(agg.avgMs || 0) + '</b><span class="stat-cell__label">平均每次回复用时</span></div>' +
      '</div>' +
      '<p class="a2-note" style="text-align:left">' + esc(note) + '</p>' +
    '</div>';
  }

  function heatmapServerHtml(hm) {
    var cells = (hm && hm.cells) || [];
    var out = cells.map(function (cell) {
      var md = '';
      var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(cell.date || '');
      if (m) md = (+m[2]) + '月' + (+m[3]) + '日';
      return '<i class="heat-cell" data-l="' + (cell.level || 0) + '" title="' + esc(md + ' · ' + (cell.count || 0) + ' 条') + '"></i>';
    }).join('');
    return '<div class="a2-card">' +
      '<div class="a2-card__head"><span class="label">聊天热力图 · 近一年</span><span class="a2-sub">颜色越深，请求越多</span></div>' +
      '<div class="heatmap-wrap"><div class="heatmap" id="heatmap">' + out + '</div></div>' +
      '<div class="heat-legend"><span>少</span><i data-l="0"></i><i data-l="1"></i><i data-l="2"></i><i data-l="3"></i><i data-l="4"></i><span>多</span></div>' +
      '<p class="a2-note" style="text-align:left">按天统计 usage 记录条数（近 365 天），可以左右滑。</p>' +
    '</div>';
  }

  function chartServerHtml(data) {
    var chart = data.chart || { mode: 'day', buckets: [] };
    var buckets = chart.buckets || [];
    var agg = data.overview || {};
    var maxV = 0;
    buckets.forEach(function (b) {
      if ((b.value || 0) > maxV) maxV = b.value || 0;
    });
    var step = Math.max(1, Math.ceil(buckets.length / 10));
    var bars = buckets.map(function (b, i) {
      var label = chart.mode === 'hour' ? (b.label || '') : ((i % step === 0 || i === buckets.length - 1) ? (b.label || '') : '');
      var inner;
      if (statsMetric === 'cost') {
        inner = '<i class="chart-seg chart-seg--cost" style="height:' + (maxV ? Math.max(1, (b.value || 0) / maxV * 100) : 0).toFixed(1) + '%"></i>';
      } else {
        var hIn = maxV ? Math.max((b.prompt || 0) - (b.cache || 0), 0) / maxV * 100 : 0;
        var hCache = maxV ? (b.cache || 0) / maxV * 100 : 0;
        var hOut = maxV ? (b.output || 0) / maxV * 100 : 0;
        inner = '<i class="chart-seg chart-seg--out" style="height:' + hOut.toFixed(1) + '%"></i>' +
          '<i class="chart-seg chart-seg--cache" style="height:' + hCache.toFixed(1) + '%"></i>' +
          '<i class="chart-seg chart-seg--in" style="height:' + hIn.toFixed(1) + '%"></i>';
      }
      return '<div class="chart-col" title="' + esc(b.key || '') + '"><div class="chart-stack">' + inner + '</div></div>';
    }).join('');
    var labels = buckets.map(function (b, i) {
      var text = chart.mode === 'hour' ? '' : ((i % step === 0 || i === buckets.length - 1) ? (b.label || '') : '');
      return '<span>' + esc(text) + '</span>';
    }).join('');
    var empty = buckets.length ? '' : '<p class="a2-sub">这个范围还没有记录。</p>';
    return '<div class="a2-card">' +
      '<div class="chart-top"><span class="label">' + (chart.mode === 'month' ? '每月用量' : chart.mode === 'hour' ? '今天各小时' : '每日用量') + '</span>' +
        '<div class="metric-toggle" role="group" aria-label="统计口径">' +
          '<button class="' + (statsMetric === 'token' ? 'is-on' : '') + '" type="button" data-a2="stats-metric" data-value="token">按 Token</button>' +
          '<button class="' + (statsMetric === 'cost' ? 'is-on' : '') + '" type="button" data-a2="stats-metric" data-value="cost">按花费</button>' +
        '</div></div>' +
      '<div class="chart-bars">' + bars + '</div>' +
      '<div class="chart-labels">' + labels + '</div>' +
      '<div class="chart-legend">' +
        '<span><i class="chart-seg--in"></i>输入</span><span><i class="chart-seg--cache"></i>缓存</span><span><i class="chart-seg--out"></i>输出</span>' +
      '</div>' + empty +
      '<div class="chart-sum" style="margin-top:8px"><span class="a2-sub">本期总计</span><b>' + (statsMetric === 'cost' ? fmtCost(agg.cost) : fmtTok((agg.prompt || 0) + (agg.output || 0))) + '</b></div>' +
      '<p class="a2-sub" style="margin-top:2px">输入 ' + fmtTok((agg.prompt || 0) - (agg.cache || 0)) + ' · 缓存 ' + fmtTok(agg.cache) + ' · 输出 ' + fmtTok(agg.output) + '</p>' +
    '</div>';
  }

  function rankServerHtml(rank) {
    var items = (rank && rank.items) || [];
    var tab = (rank && rank.tab) || rankTab;
    var max = items.length ? items[0].tokens : 1;
    var rows = items.length ? items.map(function (it) {
      var icon = '<span class="p-icon p-icon--sm p-icon--letter">·</span>';
      if (tab === 'provider') {
        var p = findProvider(it.key);
        if (p) icon = providerIconHTML(p, 'p-icon--sm');
      } else if (tab === 'char') {
        var c = findChar(it.key);
        icon = avatarHTML(c || { name: '·' }, 'avatar avatar--ai av-xxs');
      } else {
        var m = findModel(it.key);
        if (m) icon = modelIconHTML(m, 'p-icon--sm');
      }
      return '<div class="rank-row"><span class="rank-row__icon">' + icon + '</span>' +
        '<span class="rank-row__main">' +
          '<span class="rank-row__top"><span class="rank-row__name">' + esc(it.label || '未标记') + '</span>' +
            '<span class="rank-row__num">' + fmtNum(it.count || 0) + ' 次</span></span>' +
          '<span class="rank-bar"><i style="width:' + (max ? (it.tokens / max * 100).toFixed(1) : 0) + '%"></i></span>' +
        '</span><span class="rank-row__pct">' + Number(it.pct || 0).toFixed(1) + '%</span></div>';
    }).join('') : '<p class="a2-empty">这个范围还没有记录。</p>';
    return '<div class="a2-card">' +
      '<div class="a2-card__head"><span class="label">排行</span></div>' +
      '<div class="rank-tabs" role="group" aria-label="排行维度">' +
        '<button class="' + (tab === 'model' ? 'is-on' : '') + '" type="button" data-a2="rank-tab" data-value="model">按模型</button>' +
        '<button class="' + (tab === 'provider' ? 'is-on' : '') + '" type="button" data-a2="rank-tab" data-value="provider">按提供商</button>' +
        '<button class="' + (tab === 'char' ? 'is-on' : '') + '" type="button" data-a2="rank-tab" data-value="char">按角色</button>' +
      '</div><div class="rank-list">' + rows + '</div>' +
      '<p class="a2-note" style="text-align:left">百分比按 token 占比算，条数是请求次数。每条记录都带提供商 + 模型 ID + 显示名，不会出现「未知模型」。</p>' +
    '</div>';
  }

  function balanceServerHtml(items) {
    items = items || [];
    var rows = items.map(function (b) {
      var p = findProvider(b.providerId);
      var amountHtml;
      if (!b.supported) {
        amountHtml = '<span class="balance-row__amt is-muted"><b>这家不支持查询</b><span></span></span>';
      } else if (b.amount || b.amount === 0) {
        amountHtml = '<span class="balance-row__amt"><b>' + esc(b.currency || '¥') + Number(b.amount).toFixed(2) + '</b><span>' + esc(b.at || '') + '</span></span>';
      } else {
        amountHtml = '<span class="balance-row__amt is-muted"><b>余额暂不可查</b><span></span></span>';
      }
      return '<div class="balance-row">' + (p ? providerIconHTML(p, 'p-icon--sm') : '') +
        '<span class="balance-row__main"><span class="balance-row__name">' + esc(b.name) + '</span>' +
          '<span class="balance-row__time">' + (b.supported ? '由后端查询并缓存 5 分钟' : '这家不支持查询余额') + '</span></span>' +
        amountHtml +
        (b.supported ? '<button class="balance-row__refresh" type="button" data-a2="bal-query" data-id="' + esc(b.providerId) + '" aria-label="查询余额">' + IC_REFRESH_A2 + '</button>' : '') +
      '</div>';
    }).join('');
    return '<div class="a2-card">' +
      '<div class="a2-card__head"><span class="label">余额</span><span class="a2-sub">只有官方接口支持的类型能查</span></div>' +
      '<div class="balance-list">' + (rows || '<p class="a2-empty">还没有提供商。</p>') + '</div>' +
      '<p class="a2-note" style="text-align:left">查询失败时不弹英文报错，只显示「余额暂不可查」。</p>' +
    '</div>';
  }

  function liteServerHtml(lite, overview) {
    lite = lite || {};
    var note = '总对话数与总消息数来自 SQLite；每条 usage 都带提供商 + 模型 ID + 显示名。';
    if (overview && overview.estimatedCount) note += ' 本次范围里 ' + overview.estimatedCount + ' 条为估算。';
    return '<div class="a2-card">' +
      '<div class="stat-grid-3">' +
        '<div class="stat-mini"><b>' + fmtNum(lite.conversations || 0) + '</b><span>总对话数</span></div>' +
        '<div class="stat-mini"><b>' + fmtNum(lite.messages || 0) + '</b><span>总消息数</span></div>' +
        '<div class="stat-mini"><b>' + fmtNum(lite.daysTogether || 1) + '</b><span>在一起天数</span></div>' +
      '</div>' +
      '<p class="a2-note" style="text-align:left">' + esc(note) + '</p>' +
    '</div>';
  }

  function renderStatsLocal() {
    var box = document.getElementById('statsScroll');
    if (!box) return;
    var records = rangeRecords(statsRange);
    var agg = aggregateUsage(records);
    var rangeObj = STATS_RANGES.filter(function (r) { return r.id === statsRange; })[0] || STATS_RANGES[1];
    box.innerHTML = statsRangeChips() +
      '<div class="a2-banner">' + IC_INFO_A2 +
        '<span>离线模式：用浏览器里的演示数据展示统计页样式。连上本机后端后，这里会变成 usage 表里的真实数据。</span></div>' +
      statsHero(agg, rangeObj.label) +
      heatmapHtml() +
      chartHtml(records, agg) +
      rankHtml(records) +
      balanceHtml() +
      statsLiteHtml();
    var hm = document.getElementById('heatmap');
    if (hm) hm.scrollLeft = hm.scrollWidth;
  }
  function setStatsRange(range) {
    statsRange = range;
    statsServerData = null;
    renderStats();
  }
  function setStatsMetric(metric) {
    statsMetric = metric;
    statsServerData = null;
    renderStats();
  }
  function setRankTab(tab) {
    rankTab = tab;
    statsServerData = null;
    renderStats();
  }
