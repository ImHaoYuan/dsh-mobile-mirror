/*!
 * DSH 手机镜像 · 手机端对话界面
 *
 * 零依赖、零构建、零 CDN：纯原生 DOM + EventSource。
 * 文件上半部分是纯函数（不碰 DOM），Node 下可以直接 require 做单测；
 * 下半部分是浏览器界面逻辑，遇到 Node 环境会提前返回。
 */
(function (global) {
  'use strict';

  /* ======================================================================
   * 一、纯函数区（无 DOM 依赖）
   * ====================================================================== */

  /** HTML 转义。凡是拼 HTML 字符串的地方，服务端文本都要先过这里。 */
  function esc(value) {
    if (value === null || value === undefined) return '';
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /** 数字化；null/undefined/空串/NaN 一律返回 null。 */
  function num(value) {
    if (value === null || value === undefined || value === '') return null;
    var n = Number(value);
    return isFinite(n) ? n : null;
  }

  /** 截断长文本。 */
  function clip(text, max) {
    var s = String(text === null || text === undefined ? '' : text);
    var n = num(max);
    if (n === null || n <= 0 || s.length <= n) return s;
    return s.slice(0, Math.max(1, n - 1)) + '…';
  }

  /** 字节数 → 人读文本。 */
  function humanBytes(value) {
    var n = num(value);
    if (n === null || n < 0) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }

  /** token 数 → 短文本。 */
  function humanTokens(value) {
    var n = num(value);
    if (n === null || n < 0) return '';
    if (n < 1000) return String(Math.round(n));
    if (n < 1000000) return (n / 1000).toFixed(n < 10000 ? 1 : 0) + 'k';
    return (n / 1000000).toFixed(1) + 'M';
  }

  /**
   * 相对时间。now 可注入，方便单测。
   * 0 秒 → 刚刚；90 秒 → 1 分钟前；2 小时 → 2 小时前；3 天 → 3 天前。
   */
  function relTime(ts, now) {
    var t = num(ts);
    if (t === null || t <= 0) return '';
    var base = num(now);
    if (base === null) base = Date.now();
    var sec = Math.floor((base - t) / 1000);
    if (sec < 0) sec = 0;
    if (sec < 60) return '刚刚';
    var min = Math.floor(sec / 60);
    if (min < 60) return min + ' 分钟前';
    var hour = Math.floor(sec / 3600);
    if (hour < 24) return hour + ' 小时前';
    var day = Math.floor(sec / 86400);
    if (day < 30) return day + ' 天前';
    var month = Math.floor(day / 30);
    if (month < 12) return month + ' 个月前';
    return Math.floor(day / 365) + ' 年前';
  }

  /** 路径最后一段（兼容 Windows 反斜杠）。 */
  function pathTail(p) {
    var s = String(p === null || p === undefined ? '' : p).replace(/[\\/]+$/, '');
    if (!s) return '';
    var parts = s.split(/[\\/]+/);
    return parts[parts.length - 1] || s;
  }

  /** 列表项是否真的有标题。 */
  function hasTitle(item) {
    return !!(item && typeof item === 'object' && typeof item.title === 'string' && item.title.trim());
  }

  /** 列表主标题：title 缺失时降级为 cwd 末段。 */
  function sessionLabel(item) {
    if (!item || typeof item !== 'object') return '未命名会话';
    if (hasTitle(item)) return item.title.trim();
    return pathTail(item.cwd) || '未命名会话';
  }

  /** 列表副标题：有标题时补 cwd 末段，再拼相对时间。 */
  function sessionSubtitle(item, now) {
    if (!item || typeof item !== 'object') return '';
    var parts = [];
    if (hasTitle(item)) {
      var tail = pathTail(item.cwd);
      if (tail) parts.push(tail);
    }
    var rel = relTime(item.updatedAt, now);
    if (rel) parts.push(rel);
    return parts.join(' · ');
  }

  /** 轮次结束原因 → 展示文案。completed 之外都算"需要留意"。 */
  function turnEndText(reason) {
    var key = String(reason === null || reason === undefined ? '' : reason);
    var table = {
      completed: '本轮完成',
      aborted: '本轮已中止',
      blocked: '本轮被阻塞',
      error: '本轮出错',
      'max-tokens': '达到 token 上限',
      interrupted: '本轮被打断',
      forked: '本轮已分叉'
    };
    return {
      text: table[key] || (key ? '本轮结束：' + key : '本轮结束'),
      warn: key !== 'completed'
    };
  }

  /** 把 blocks 里的可读文本抽出来（用于摘要）。 */
  function blocksToText(blocks, max) {
    if (!Array.isArray(blocks)) return '';
    var chunks = [];
    for (var i = 0; i < blocks.length; i++) {
      var b = blocks[i];
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'text' && typeof b.text === 'string') chunks.push(b.text);
      else if (b.type === 'image') chunks.push('[图片]');
      else if (b.type === 'file') chunks.push('[文件 ' + (b.name || '') + ']');
    }
    var text = chunks.join('\n').trim();
    return clip(text, max);
  }

  /** 非文本 block → 一个小标签的描述。 */
  function blockChip(block) {
    if (!block || typeof block !== 'object') return null;
    // text / reasoning 是正文，不是"小标签"
    if (block.type === 'text' || block.type === 'reasoning') return null;
    if (block.type === 'image') {
      var label = '图片';
      if (num(block.width) !== null && num(block.height) !== null) label += ' ' + block.width + '×' + block.height;
      var size = humanBytes(block.bytes);
      if (size) label += ' · ' + size;
      return { kind: 'image', label: label };
    }
    if (block.type === 'file') {
      var name = typeof block.name === 'string' && block.name ? block.name : '文件';
      var bytes = humanBytes(block.bytes);
      return { kind: 'file', label: name + (bytes ? ' · ' + bytes : '') };
    }
    if (block.type === 'tool-call') {
      return { kind: 'tool', label: '工具调用 ' + (block.name || '') };
    }
    if (typeof block.type === 'string' && block.type) {
      return { kind: 'other', label: '[' + block.type + ']' };
    }
    return null;
  }

  /** JSON.parse 的安全包装。 */
  function tryJson(text) {
    try {
      return { ok: true, value: JSON.parse(text) };
    } catch (e) {
      return { ok: false, value: null };
    }
  }

  /** 工具参数 → 一行摘要。解析失败就用原文首行。 */
  function summarizeArgs(argsText, max) {
    var limit = num(max) === null ? 90 : num(max);
    var raw = String(argsText === null || argsText === undefined ? '' : argsText);
    var trimmed = raw.trim();
    if (!trimmed) return '';
    var flat = '';
    var parsed = tryJson(trimmed);
    if (parsed.ok && parsed.value && typeof parsed.value === 'object' && !Array.isArray(parsed.value)) {
      var keys = Object.keys(parsed.value);
      var parts = [];
      for (var i = 0; i < keys.length && i < 4; i++) {
        var value = parsed.value[keys[i]];
        var text;
        if (value === null || value === undefined) text = String(value);
        else if (typeof value === 'object') text = JSON.stringify(value);
        else text = String(value);
        parts.push(keys[i] + '=' + clip(text.replace(/\s+/g, ' '), 48));
      }
      flat = parts.join(' ');
    } else if (parsed.ok && Array.isArray(parsed.value)) {
      flat = '[' + parsed.value.length + ' 项]';
    }
    if (!flat) flat = trimmed.split('\n')[0];
    return clip(flat, limit);
  }

  /** 工具参数 → 完整展示文本。能解析就格式化，不能（含被截断的）就原文。 */
  function formatToolArgs(argsText) {
    var raw = String(argsText === null || argsText === undefined ? '' : argsText);
    var trimmed = raw.trim();
    if (!trimmed) return '';
    var parsed = tryJson(trimmed);
    if (parsed.ok) {
      try {
        return JSON.stringify(parsed.value, null, 2);
      } catch (e) {
        return raw;
      }
    }
    return raw;
  }

  /** usage → 一行小字。字段可能缺，防御性读取。 */
  function formatUsage(usage) {
    if (!usage || typeof usage !== 'object') return '';
    var parts = [];
    var map = [
      ['inputTokens', '输入'], ['outputTokens', '输出'], ['totalTokens', '合计'],
      ['cacheReadTokens', '缓存读'], ['cacheWriteTokens', '缓存写'], ['reasoningTokens', '思考']
    ];
    for (var i = 0; i < map.length; i++) {
      var v = num(usage[map[i][0]]);
      if (v !== null) parts.push(map[i][1] + ' ' + humanTokens(v));
    }
    return parts.join(' · ');
  }

  /* ---------------------------- 精简 Markdown ---------------------------- */

  /**
   * 行内标记。输入必须已经是 esc() 过的文本。
   * 行内代码先抽成占位符，避免里面的 * [ ] ` 被当成标记。
   */
  function mdInline(escaped) {
    var text = String(escaped === null || escaped === undefined ? '' : escaped);
    var codes = [];

    text = text.replace(/`([^`\n]+)`/g, function (whole, body) {
      codes.push(body);
      return '\u0000C' + (codes.length - 1) + '\u0000';
    });

    // 链接：只放行 http/https，其余降级成纯文本（保持 esc 后的字面量）
    text = text.replace(/\[([^\]\n]*)\]\(([^()\s]+)\)/g, function (whole, label, url) {
      if (!/^https?:\/\//i.test(url)) return whole;
      return '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + label + '</a>';
    });

    text = text.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');

    text = text.replace(/\u0000C(\d+)\u0000/g, function (whole, idx) {
      var body = codes[Number(idx)];
      return '<code>' + (body === undefined ? '' : body) + '</code>';
    });
    return text;
  }

  /**
   * 精简 Markdown → HTML。
   * 支持：# 标题、**粗体**、*斜体*、`行内代码`、```围栏代码块、-/* 无序列表、
   * 1. 有序列表、> 引用、[t](u) 链接、--- 水平线、段落与换行。
   * 先整体转义再做标记替换；代码块内容原样保留（已转义，不会被解析成标记）。
   */
  function renderMarkdown(src) {
    var lines = String(src === null || src === undefined ? '' : src).replace(/\r\n?/g, '\n').split('\n');
    var out = [];
    var para = [];
    var list = null;   // { ordered:boolean, items:string[] }
    var quote = [];    // string[]

    function flushPara() {
      if (!para.length) return;
      out.push('<p>' + para.map(function (line) { return mdInline(esc(line)); }).join('<br>') + '</p>');
      para = [];
    }
    function flushList() {
      if (!list) return;
      var tag = list.ordered ? 'ol' : 'ul';
      out.push('<' + tag + '>' + list.items.map(function (item) {
        return '<li>' + mdInline(esc(item)) + '</li>';
      }).join('') + '</' + tag + '>');
      list = null;
    }
    function flushQuote() {
      if (!quote.length) return;
      out.push('<blockquote>' + quote.map(function (line) { return mdInline(esc(line)); }).join('<br>') + '</blockquote>');
      quote = [];
    }
    function flushAll() { flushPara(); flushList(); flushQuote(); }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];

      // 围栏代码块：内容整段原样保留
      var fence = /^\s*```(.*)$/.exec(line);
      if (fence) {
        flushAll();
        var lang = String(fence[1] || '').trim();
        var buf = [];
        i++;
        while (i < lines.length) {
          if (/^\s*```\s*$/.test(lines[i])) break;
          buf.push(lines[i]);
          i++;
        }
        out.push('<pre class="md-code"' + (lang ? ' data-lang="' + esc(lang) + '"' : '') + '><code>'
          + esc(buf.join('\n')) + '</code></pre>');
        continue;
      }

      if (!line.trim()) { flushAll(); continue; }

      var heading = /^(#{1,6})\s+(.*)$/.exec(line);
      if (heading) {
        flushAll();
        var level = heading[1].length;
        var title = heading[2].replace(/\s+#+\s*$/, '');
        out.push('<h' + level + '>' + mdInline(esc(title)) + '</h' + level + '>');
        continue;
      }

      if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { flushAll(); out.push('<hr>'); continue; }

      var bq = /^\s*>\s?(.*)$/.exec(line);
      if (bq) { flushPara(); flushList(); quote.push(bq[1]); continue; }

      var ul = /^\s*[-*+]\s+(.*)$/.exec(line);
      if (ul) {
        flushPara(); flushQuote();
        if (!list || list.ordered) { flushList(); list = { ordered: false, items: [] }; }
        list.items.push(ul[1]);
        continue;
      }

      var ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
      if (ol) {
        flushPara(); flushQuote();
        if (!list || !list.ordered) { flushList(); list = { ordered: true, items: [] }; }
        list.items.push(ol[1]);
        continue;
      }

      flushList(); flushQuote();
      para.push(line);
    }
    flushAll();
    return out.join('\n');
  }

  /* ======================================================================
   * 纯函数导出（浏览器里 module 不存在，这一段是空操作）
   * ====================================================================== */

  var PURE = {
    esc: esc, num: num, clip: clip,
    humanBytes: humanBytes, humanTokens: humanTokens,
    relTime: relTime, pathTail: pathTail,
    sessionLabel: sessionLabel, sessionSubtitle: sessionSubtitle,
    turnEndText: turnEndText, blocksToText: blocksToText, blockChip: blockChip,
    summarizeArgs: summarizeArgs, formatToolArgs: formatToolArgs, formatUsage: formatUsage,
    mdInline: mdInline, renderMarkdown: renderMarkdown
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = PURE;

  // Node（单测）环境下没有 document，界面逻辑到此为止。
  if (typeof document === 'undefined') return;

  /* ======================================================================
   * 二、界面逻辑
   * ====================================================================== */

  var ES_CLOSED = 2;          // EventSource.CLOSED
  var DEBUG_LIMIT = 50;       // 调试面板最多保留的原始信封
  var STICK_GAP = 80;         // 距底部小于这个值算"吸底"
  var TOP_GAP = 32;           // 距顶部小于这个值触发往上翻历史
  var PAGE_SIZE = 200;

  var CONFIG = { enablePrompt: false };
  var els = {};
  var state = {
    view: 'list',
    sessions: [],
    sessionId: null,
    sessionTitle: '',
    sub: { cwd: '', preset: '', model: '' },
    autoEntered: false,
    listLoaded: false,
    lastListAt: 0,
    generation: 0,
    source: null,
    maxSeq: 0,
    oldestSeq: 0,
    hasMore: false,
    loadingOlder: false,
    stick: true,
    scrollLock: 0,
    activeTurn: null,
    attemptId: null,
    live: null,
    toolCards: {},
    toolResults: {},
    toolOrphans: {},
    debug: [],
    debugOn: false
  };

  function $(id) { return document.getElementById(id); }

  /* ------------------------------ 启动 ------------------------------ */

  function boot() {
    els.viewList = $('view-list');
    els.viewChat = $('view-chat');
    els.list = $('list');
    els.listScroll = $('list-scroll');
    els.listHint = $('list-hint');
    els.listEmpty = $('list-empty');
    els.listError = $('list-error');
    els.listErrorText = $('list-error-text');
    els.btnRefresh = $('btn-refresh');
    els.btnListRetry = $('btn-list-retry');
    els.chatTitle = $('chat-title');
    els.chatSub = $('chat-sub');
    els.chatDot = $('chat-dot');
    els.btnBack = $('btn-back');
    els.btnRaw = $('btn-raw');
    els.stream = $('stream');
    els.streamHint = $('stream-hint');
    els.btnBottom = $('btn-bottom');
    els.connBanner = $('conn-banner');
    els.connText = $('conn-text');
    els.btnReconnect = $('btn-reconnect');
    els.debug = $('debug');
    els.debugBody = $('debug-body');
    els.debugCount = $('debug-count');
    els.btnDebugClear = $('btn-debug-clear');
    els.btnDebugClose = $('btn-debug-close');
    els.composer = $('composer');
    els.composerInput = $('composer-input');
    els.composerSend = $('composer-send');
    els.toast = $('toast');

    CONFIG.enablePrompt = document.body.getAttribute('data-enable-prompt') === 'yes';
    if (CONFIG.enablePrompt) els.composer.hidden = false;

    bind();
    loadSessions(true);
  }

  function bind() {
    els.btnRefresh.addEventListener('click', function () { loadSessions(false); });
    els.btnListRetry.addEventListener('click', function () { loadSessions(false); });
    els.btnBack.addEventListener('click', goList);
    els.btnRaw.addEventListener('click', function () { toggleDebug(); });
    els.btnDebugClear.addEventListener('click', function () {
      state.debug = [];
      renderDebug();
    });
    els.btnDebugClose.addEventListener('click', function () { toggleDebug(false); });
    els.btnBottom.addEventListener('click', function () { stickToBottom(true); });
    els.btnReconnect.addEventListener('click', function () { connect(); });
    els.stream.addEventListener('scroll', onStreamScroll, { passive: true });

    window.addEventListener('pagehide', disconnect);
    window.addEventListener('online', function () {
      if (state.view === 'chat' && (!state.source || state.source.readyState === ES_CLOSED)) connect();
    });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState !== 'visible') return;
      if (state.view === 'chat') {
        if (!state.source || state.source.readyState === ES_CLOSED) connect();
      } else if (Date.now() - state.lastListAt > 10000) {
        loadSessions(false);
      }
    });
  }

  function setView(name) {
    state.view = name;
    els.viewList.hidden = name !== 'list';
    els.viewChat.hidden = name !== 'chat';
  }

  /* ------------------------------ 网络 ------------------------------ */

  var ERROR_TEXT = {
    'session-controller-unavailable': '宿主端会话控制器不可用（DSH 可能还没就绪）',
    'unknown-session': '会话不存在或已经关闭',
    'bad-request': '请求参数有误',
    'missing-id': '请求缺少会话 id',
    'missing-before': '翻页参数不完整',
    unauthorized: '登录已失效，请重新登录'
  };

  /** 把接口错误翻成人话：认识的错误码 → 文案；否则优先用服务端 message。 */
  function humanError(err) {
    if (!err) return '未知错误';
    var code = err.code || '';
    if (code && ERROR_TEXT[code]) return ERROR_TEXT[code];
    if (err.detail) return err.detail;
    if (code) return code;
    if (err.status === 503) return '服务暂时不可用（HTTP 503）';
    if (err.status === 404) return '接口不存在（HTTP 404）—— 宿主端可能还没实现';
    if (err.status === 401) return '登录已失效，请重新登录';
    if (err.status) return 'HTTP ' + err.status;
    return err.message || '网络错误';
  }

  function fetchJSON(url) {
    return fetch(url, {
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { Accept: 'application/json' }
    }).then(function (res) {
      if (res.status === 401) {
        location.href = '/login';
        throw new Error('登录已失效');
      }
      if (!res.ok) {
        return res.text().then(function (body) {
          var code = '';
          var message = '';
          var parsed = tryJson(String(body || '').trim());
          if (parsed.ok && parsed.value && typeof parsed.value === 'object') {
            code = String(parsed.value.error || '');
            message = String(parsed.value.message || '');
          }
          var err = new Error(message || code || ('HTTP ' + res.status));
          err.status = res.status;
          err.code = code;
          err.detail = message;
          throw err;
        });
      }
      return res.json();
    });
  }

  /* ------------------------------ 会话列表 ------------------------------ */

  function loadSessions(autoEnter) {
    els.listError.hidden = true;
    els.btnRefresh.disabled = true;
    if (!state.listLoaded) {
      els.listHint.hidden = false;
      els.listHint.textContent = '正在载入会话…';
    }
    fetchJSON('/api/sessions').then(function (data) {
      var items = data && Array.isArray(data.items) ? data.items : [];
      state.sessions = items;
      state.listLoaded = true;
      state.lastListAt = Date.now();
      els.listHint.hidden = true;
      renderSessions(items);
      if (autoEnter && !state.autoEntered) {
        state.autoEntered = true;
        var target = null;
        for (var i = 0; i < items.length; i++) {
          // 列表已按 updatedAt 降序，第一条 running 就是最近更新的那个
          if (items[i] && items[i].running) { target = items[i]; break; }
        }
        if (target) openSession(target.id, sessionLabel(target));
      }
    }).catch(function (err) {
      els.listHint.hidden = true;
      els.listError.hidden = false;
      els.listErrorText.textContent = '载入会话失败：' + humanError(err);
    }).then(function () {
      els.btnRefresh.disabled = false;
    });
  }

  function renderSessions(items) {
    els.list.textContent = '';
    els.listEmpty.hidden = !!items.length;
    if (!items.length) return;
    var frag = document.createDocumentFragment();
    for (var i = 0; i < items.length; i++) frag.appendChild(sessionRow(items[i]));
    els.list.appendChild(frag);
  }

  function sessionRow(item) {
    var id = item && item.id ? String(item.id) : '';
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'session';

    var dot = document.createElement('span');
    dot.className = 'dot' + (item && item.running ? ' on' : '');

    var main = document.createElement('span');
    main.className = 'session-main';

    var title = document.createElement('span');
    title.className = 'session-title';
    title.textContent = sessionLabel(item);

    var sub = document.createElement('span');
    sub.className = 'session-sub';
    sub.textContent = sessionSubtitle(item);

    main.appendChild(title);
    main.appendChild(sub);

    var tags = [];
    if (item && item.running) tags.push({ text: '运行中', cls: 'tag tag-on' });
    if (item && item.agentAvailable === false) tags.push({ text: '无 agent', cls: 'tag' });
    if (item && item.blank) tags.push({ text: '空白', cls: 'tag' });
    if (tags.length) {
      var row = document.createElement('span');
      row.className = 'session-tags';
      for (var t = 0; t < tags.length; t++) {
        var tag = document.createElement('span');
        tag.className = tags[t].cls;
        tag.textContent = tags[t].text;
        row.appendChild(tag);
      }
      main.appendChild(row);
    }

    btn.appendChild(dot);
    btn.appendChild(main);
    btn.addEventListener('click', function () { openSession(id, sessionLabel(item)); });
    return btn;
  }

  /* ------------------------------ 视图切换 ------------------------------ */

  function openSession(id, title) {
    if (!id) return;
    state.sessionId = String(id);
    state.sessionTitle = title || '';
    state.autoEntered = true;
    setView('chat');
    resetStream();
    renderChatHeader();
    connect();
  }

  function goList() {
    disconnect();
    state.sessionId = null;
    setView('list');
    loadSessions(false);
  }

  function resetStream() {
    state.maxSeq = 0;
    state.oldestSeq = 0;
    state.hasMore = false;
    state.loadingOlder = false;
    state.stick = true;
    state.activeTurn = null;
    state.attemptId = null;
    state.live = null;
    state.toolCards = {};
    state.toolResults = {};
    state.toolOrphans = {};
    state.sub = { cwd: '', preset: '', model: '' };
    els.stream.textContent = '';
    els.btnBottom.hidden = true;
    showTopHint('');
    els.connBanner.hidden = true;
  }

  function isRunning() {
    return !!state.attemptId || state.activeTurn !== null || !!(state.live && state.live.el);
  }

  function renderChatHeader() {
    els.chatTitle.textContent = state.sessionTitle || '会话';
    var running = isRunning();
    els.chatDot.className = 'dot' + (running ? ' on' : '');
    var parts = [running ? '运行中' : '空闲'];
    if (state.sub.cwd) parts.push(state.sub.cwd);
    if (state.sub.preset) parts.push(state.sub.preset);
    if (state.sub.model) parts.push(state.sub.model);
    els.chatSub.textContent = parts.join(' · ');
  }

  /* ------------------------------ SSE ------------------------------ */

  function disconnect() {
    if (state.source) {
      try { state.source.close(); } catch (e) { /* 忽略 */ }
      state.source = null;
    }
    state.generation++;
  }

  function connect() {
    disconnect();
    var gen = ++state.generation;
    var url = '/api/follow?id=' + encodeURIComponent(state.sessionId || '') + '&max=' + PAGE_SIZE;
    var es;
    try {
      es = new EventSource(url);
    } catch (err) {
      showToast('无法建立实时连接：' + (err && err.message ? err.message : err));
      return;
    }
    state.source = es;

    es.addEventListener('open', function () {
      if (gen !== state.generation) return;
      els.connBanner.hidden = true;
    });

    // 服务端只发 data: 行，走 message；万一将来加了 event: 名字也能收
    var kinds = ['message', 'snapshot', 'event', 'stream'];
    for (var i = 0; i < kinds.length; i++) {
      es.addEventListener(kinds[i], function (ev) {
        if (gen !== state.generation) return;
        handleEnvelope(ev.data, gen);
      });
    }

    es.addEventListener('error', function () {
      if (gen !== state.generation) return;
      var closed = es.readyState === ES_CLOSED;
      els.connText.textContent = closed
        ? '实时连接已断开（服务端未接受 SSE）'
        : '实时连接中断，正在重连…';
      els.connBanner.hidden = false;
    });
  }

  function handleEnvelope(raw, gen) {
    var parsed = tryJson(String(raw === null || raw === undefined ? '' : raw));
    if (!parsed.ok) {
      pushDebug('bad-json', String(raw));
      return;
    }
    var env = parsed.value;
    if (!env || typeof env !== 'object') return;
    var kind = String(env.e || 'unknown');
    pushDebug(kind, env.d);
    if (kind === 'snapshot') applySnapshot(env.d, gen);
    else if (kind === 'event') applyEvent(env.d, gen);
    else if (kind === 'stream') applyStreamFrame(env.d, gen, false);
  }

  /* ------------------------------ 快照 / 事件 ------------------------------ */

  function applySnapshot(snap, gen) {
    if (!snap || typeof snap !== 'object') return;
    var el = els.stream;
    var keepFromBottom = 0;
    if (!state.stick) keepFromBottom = el.scrollHeight - el.scrollTop;

    // 重连后整体重建，避免重复消息
    el.textContent = '';
    state.maxSeq = 0;
    state.oldestSeq = 0;
    state.hasMore = false;
    state.loadingOlder = false;
    state.activeTurn = null;
    state.attemptId = null;
    state.live = null;
    state.toolCards = {};
    state.toolResults = {};
    state.toolOrphans = {};
    showTopHint('');

    var header = snap.header && typeof snap.header === 'object' ? snap.header : {};
    var proj = snap.projections && typeof snap.projections === 'object' ? snap.projections : {};

    var title = '';
    if (typeof proj.title === 'string' && proj.title.trim()) title = proj.title.trim();
    else if (state.sessionTitle) title = state.sessionTitle;
    else title = pathTail(header.cwd) || '会话';
    state.sessionTitle = title;

    state.sub = {
      cwd: pathTail(header.cwd),
      preset: header.agentPreset ? String(header.agentPreset) : '',
      model: typeof proj.model === 'string' ? proj.model : ''
    };

    var records = Array.isArray(snap.records) ? snap.records.slice() : [];
    records.sort(bySeq);
    for (var i = 0; i < records.length; i++) appendEvent(records[i], el);
    if (records.length) {
      var first = num(records[0].seq);
      if (first !== null) state.oldestSeq = first;
    }

    var cursor = num(snap.cursor);
    if (cursor !== null) state.maxSeq = Math.max(state.maxSeq, cursor);
    state.hasMore = !!snap.hasMore;

    // 重放"正在输出中"的临时气泡
    var info = snap.assistantStream;
    var attempt = info && typeof info === 'object' ? info.activeAttempt : null;
    if (attempt && typeof attempt === 'object') {
      state.attemptId = attempt.attemptId ? String(attempt.attemptId) : 'active';
      var frames = Array.isArray(attempt.stream) ? attempt.stream : [];
      for (var f = 0; f < frames.length; f++) applyStreamFrame(frames[f], gen, true);
    }

    renderChatHeader();
    if (state.stick) stickToBottom(false);
    else el.scrollTop = Math.max(0, el.scrollHeight - keepFromBottom);
  }

  function bySeq(a, b) {
    var x = num(a && a.seq);
    var y = num(b && b.seq);
    if (x === null) return y === null ? 0 : -1;
    if (y === null) return 1;
    return x - y;
  }

  function applyEvent(ev, gen) {
    if (!ev || typeof ev !== 'object') return;
    var seq = num(ev.seq);
    if (seq !== null) {
      if (seq <= state.maxSeq) return;   // 按 seq 去重
      state.maxSeq = seq;
    }
    appendEvent(ev, els.stream);
    if (state.stick) stickToBottom(false);
  }

  /**
   * 渲染一条事件。target 默认为消息流；往上翻历史时先塞进 DocumentFragment。
   * 返回新建的节点（没渲染则返回 null）。
   */
  function appendEvent(ev, target) {
    if (!ev || typeof ev !== 'object') return null;
    var host = target || els.stream;
    var type = String(ev.type || '');
    var data = ev.data && typeof ev.data === 'object' ? ev.data : null;
    var node = null;

    switch (type) {
      case 'turn/start': node = renderTurnStart(data); break;
      case 'turn/end': node = renderTurnEnd(data); break;
      case 'user/message': node = renderUserMessage(data); break;
      case 'assistant/message': node = renderAssistantMessage(data); break;
      case 'tool/call': node = renderToolCall(data); break;
      case 'tool/result': node = renderToolResult(data); break;
      case 'system/message':
      case 'developer/message': node = renderSystemNote(data); break;
      // step/start、step/end 不做独立大块；request/* 只在调试视图里看；未知类型直接忽略
      default: return null;
    }

    if (!node) return null;
    host.appendChild(node);
    // 临时气泡永远保持在末尾
    if (host === els.stream && state.live && state.live.el) els.stream.appendChild(state.live.el);
    return node;
  }

  function renderTurnStart(data) {
    var turn = data ? num(data.turn) : null;
    state.activeTurn = turn === null ? 0 : turn;
    renderChatHeader();
    var el = document.createElement('div');
    el.className = 'divider';
    var span = document.createElement('span');
    span.textContent = turn === null ? '新一轮' : ('第 ' + turn + ' 轮');
    el.appendChild(span);
    return el;
  }

  function renderTurnEnd(data) {
    state.activeTurn = null;
    renderChatHeader();
    var info = turnEndText(data ? data.reason : '');
    var el = document.createElement('div');
    el.className = 'turn-end' + (info.warn ? ' warn' : '');
    el.textContent = info.text;
    return el;
  }

  function msgWrap(kind) {
    var el = document.createElement('div');
    el.className = 'msg ' + kind;
    var body = document.createElement('div');
    body.className = 'body';
    el.appendChild(body);
    return { el: el, body: body };
  }

  function blockChipEl(block) {
    var info = blockChip(block);
    if (!info) return null;
    var el = document.createElement('div');
    el.className = 'chip chip-' + info.kind;
    el.textContent = info.label;
    return el;
  }

  function reasoningEl(text, open) {
    var det = document.createElement('details');
    det.className = 'fold reason';
    if (open) det.open = true;
    var sum = document.createElement('summary');
    sum.textContent = '思考过程';
    var body = document.createElement('div');
    body.className = 'reason-body';
    body.textContent = String(text === null || text === undefined ? '' : text);
    det.appendChild(sum);
    det.appendChild(body);
    return det;
  }

  /** 把 blocks 按顺序渲染进容器；连续 text 合并进同一个气泡。 */
  function renderBlocksInto(container, blocks, options) {
    var opts = options || {};
    var bubble = null;
    function ensureBubble() {
      if (!bubble) {
        bubble = document.createElement('div');
        bubble.className = 'bubble md';
        container.appendChild(bubble);
      }
      return bubble;
    }
    var list = Array.isArray(blocks) ? blocks : [];
    for (var i = 0; i < list.length; i++) {
      var b = list[i];
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'text') {
        var html = renderMarkdown(b.text);
        if (html) ensureBubble().insertAdjacentHTML('beforeend', html);
      } else if (b.type === 'reasoning') {
        bubble = null;
        container.appendChild(reasoningEl(b.text, !!opts.reasoningOpen));
      } else if (b.type === 'tool-call') {
        bubble = null;
        container.appendChild(toolCard({ callId: b.id, name: b.name, args: b.args }).el);
      } else {
        bubble = null;
        var chip = blockChipEl(b);
        if (chip) container.appendChild(chip);
      }
    }
    return container;
  }

  function renderUserMessage(data) {
    var wrap = msgWrap('me');
    var bubble = document.createElement('div');
    bubble.className = 'bubble';
    var blocks = data && Array.isArray(data.blocks) ? data.blocks : [];
    for (var i = 0; i < blocks.length; i++) {
      var b = blocks[i];
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'text') {
        var p = document.createElement('div');
        p.className = 'plain';
        p.textContent = String(b.text === null || b.text === undefined ? '' : b.text);
        bubble.appendChild(p);
      } else {
        var chip = blockChipEl(b);
        if (chip) bubble.appendChild(chip);
      }
    }
    if (!bubble.firstChild) {
      var none = document.createElement('div');
      none.className = 'plain';
      none.textContent = '（空消息）';
      bubble.appendChild(none);
    }
    wrap.body.appendChild(bubble);
    return wrap.el;
  }

  function renderAssistantMessage(data) {
    // 用最终内容替换"正在输出"的临时气泡，避免重复
    removeLive();
    state.attemptId = null;

    var wrap = msgWrap('assistant');
    var blocks = data && Array.isArray(data.blocks) ? data.blocks : [];
    renderBlocksInto(wrap.body, blocks, {});
    if (!wrap.body.firstChild) {
      var none = document.createElement('div');
      none.className = 'plain';
      none.textContent = '（无内容）';
      wrap.body.appendChild(none);
    }

    var meta = document.createElement('div');
    meta.className = 'meta';
    if (data && data.interrupted) {
      var tag = document.createElement('span');
      tag.className = 'tag tag-warn';
      tag.textContent = '已中断';
      meta.appendChild(tag);
    }
    if (data && typeof data.model === 'string' && data.model) {
      var model = document.createElement('span');
      model.className = 'meta-model';
      model.textContent = data.model;
      meta.appendChild(model);
    }
    var usage = formatUsage(data ? data.usage : null);
    if (usage) {
      var u = document.createElement('span');
      u.className = 'meta-usage';
      u.textContent = usage;
      meta.appendChild(u);
    }
    if (meta.firstChild) wrap.body.appendChild(meta);

    renderChatHeader();
    return wrap.el;
  }

  function renderSystemNote(data) {
    var el = document.createElement('div');
    el.className = 'sys-note';
    var note = data && typeof data.note === 'string' ? data.note
      : (data && data.omitted ? '（系统消息已省略）' : '（系统消息）');
    el.textContent = note;
    return el;
  }

  /* ------------------------------ 工具卡片 ------------------------------ */

  function toolCard(data) {
    var callId = data && data.callId ? String(data.callId) : '';
    var name = data && typeof data.name === 'string' ? data.name : '';
    var args = data && data.args !== null && data.args !== undefined ? String(data.args) : '';

    // 结果先到、调用后到（翻历史时常见）：把之前孤零零的结果节点收掉
    if (callId && state.toolOrphans[callId]) {
      var orphan = state.toolOrphans[callId];
      if (orphan.parentNode) orphan.parentNode.removeChild(orphan);
      delete state.toolOrphans[callId];
    }

    var det = document.createElement('details');
    det.className = 'fold tool';
    var sum = document.createElement('summary');
    var nameEl = document.createElement('span');
    nameEl.className = 'tool-name';
    nameEl.textContent = name || '工具';
    var brief = document.createElement('span');
    brief.className = 'tool-brief';
    brief.textContent = summarizeArgs(args);
    sum.appendChild(nameEl);
    sum.appendChild(brief);

    var argsEl = document.createElement('pre');
    argsEl.className = 'tool-args';
    argsEl.textContent = formatToolArgs(args);

    var resultEl = document.createElement('div');
    resultEl.className = 'tool-result';
    resultEl.hidden = true;

    det.appendChild(sum);
    det.appendChild(argsEl);
    det.appendChild(resultEl);

    var card = {
      el: det, summary: sum, nameEl: nameEl, brief: brief, argsEl: argsEl,
      resultEl: resultEl, flag: null, callId: callId, name: name, args: args
    };
    card.setArgs = function (text) {
      card.args = String(text === null || text === undefined ? '' : text);
      card.argsEl.textContent = formatToolArgs(card.args);
      card.brief.textContent = summarizeArgs(card.args);
    };
    card.setName = function (value) {
      card.name = String(value === null || value === undefined ? '' : value);
      card.nameEl.textContent = card.name || '工具';
    };

    if (callId) {
      state.toolCards[callId] = card;
      if (state.toolResults[callId]) fillToolResult(card, state.toolResults[callId]);
    }
    return card;
  }

  /** 工具结果的标题文案（失败原因拼在后面）。 */
  function resultHeadText(result) {
    var text = result && result.isError ? '执行失败' : '执行结果';
    if (result && result.error && typeof result.error === 'object') {
      var parts = [];
      if (result.error.name) parts.push(String(result.error.name));
      if (result.error.code) parts.push(String(result.error.code));
      if (result.error.reason) parts.push(String(result.error.reason));
      if (parts.length) text += '：' + parts.join(' / ');
    }
    return text;
  }

  /** 结果里什么都没有时给一行占位。 */
  function appendEmptyNote(container) {
    if (container.querySelector('.bubble, .chip, .fold')) return;
    var none = document.createElement('div');
    none.className = 'plain';
    none.style.color = 'var(--dim)';
    none.textContent = '（无输出）';
    container.appendChild(none);
  }

  function fillToolResult(card, result) {
    if (!card || !result) return;
    var isError = !!result.isError;
    card.el.classList.toggle('tool-error', isError);
    card.resultEl.hidden = false;
    card.resultEl.textContent = '';
    card.resultEl.classList.toggle('error', isError);

    var head = document.createElement('div');
    head.className = 'tool-result-head';
    head.textContent = resultHeadText(result);
    card.resultEl.appendChild(head);

    var blocks = Array.isArray(result.blocks) ? result.blocks : [];
    renderBlocksInto(card.resultEl, blocks, {});
    appendEmptyNote(card.resultEl);

    if (!card.flag) {
      card.flag = document.createElement('span');
      card.flag.className = 'tool-flag';
      card.summary.appendChild(card.flag);
    }
    card.flag.textContent = isError ? '失败' : '完成';
    card.flag.classList.toggle('bad', isError);
  }

  function renderToolCall(data) {
    return toolCard(data).el;
  }

  function renderToolResult(data) {
    var callId = data && data.callId ? String(data.callId) : '';
    if (callId) state.toolResults[callId] = data;

    var card = callId ? state.toolCards[callId] : null;
    // 卡片已被重连重建 / 被临时气泡带走时不认，退化成独立渲染
    if (card && card.el.isConnected) {
      fillToolResult(card, data);
      return null;
    }

    var el = document.createElement('div');
    el.className = 'fold tool standalone' + (data && data.isError ? ' tool-error' : '');
    var head = document.createElement('div');
    head.className = 'tool-result-head';
    head.textContent = resultHeadText(data) + (callId ? ' · ' + clip(callId, 18) : '');
    el.appendChild(head);
    renderBlocksInto(el, data && Array.isArray(data.blocks) ? data.blocks : [], {});
    appendEmptyNote(el);
    if (callId) state.toolOrphans[callId] = el;
    return el;
  }

  /* ------------------------------ 流式输出 ------------------------------ */

  function ensureLive() {
    if (state.live && state.live.el) return state.live;
    var live = state.live || {};
    var el = document.createElement('div');
    el.className = 'msg assistant live';
    var body = document.createElement('div');
    body.className = 'body';
    var head = document.createElement('div');
    head.className = 'live-head';
    var dot = document.createElement('span');
    dot.className = 'dot on';
    var label = document.createElement('span');
    label.textContent = '正在输出…';
    head.appendChild(dot);
    head.appendChild(label);
    var content = document.createElement('div');
    content.className = 'bubble live-bubble';
    var meta = document.createElement('div');
    meta.className = 'meta';
    body.appendChild(head);
    body.appendChild(content);
    body.appendChild(meta);
    el.appendChild(body);
    els.stream.appendChild(el);

    live.el = el;
    live.content = content;
    live.meta = meta;
    live.blocks = live.blocks || {};
    live.usage = live.usage || null;
    live.finish = live.finish || null;
    state.live = live;
    return live;
  }

  function liveKey(index) {
    var step = state.live && state.live.step !== null && state.live.step !== undefined ? state.live.step : '-';
    return step + ':' + String(index);
  }

  function liveBlock(index, kind) {
    var live = ensureLive();
    var key = liveKey(index);
    if (live.blocks[key]) return live.blocks[key];
    var entry = { kind: kind, node: null, body: null, text: '', textNode: null, card: null };

    if (kind === 'text') {
      var div = document.createElement('div');
      div.className = 'live-text';
      entry.node = div;
      live.content.appendChild(div);
    } else if (kind === 'reason') {
      var det = document.createElement('details');
      det.className = 'fold reason';
      var sum = document.createElement('summary');
      sum.textContent = '思考过程';
      var pre = document.createElement('div');
      pre.className = 'reason-body';
      det.appendChild(sum);
      det.appendChild(pre);
      entry.node = det;
      entry.body = pre;
      live.content.appendChild(det);
    } else if (kind === 'tool') {
      var card = toolCard({ callId: '', name: '', args: '' });
      entry.node = card.el;
      entry.card = card;
      live.content.appendChild(card.el);
    } else {
      var generic = document.createElement('div');
      generic.className = 'chip';
      generic.textContent = '[' + kind + ']';
      entry.node = generic;
      live.content.appendChild(generic);
    }
    live.blocks[key] = entry;
    return entry;
  }

  function liveAppend(index, kind, chunk) {
    if (!chunk) return;
    var entry = liveBlock(index, kind);
    entry.text += chunk;
    var host = kind === 'text' ? entry.node : entry.body;
    if (!host) return;
    if (entry.textNode) {
      entry.textNode.appendData(chunk);
    } else {
      entry.textNode = document.createTextNode(chunk);
      host.appendChild(entry.textNode);
    }
  }

  function liveStart(frame) {
    ensureLive();
    var turn = num(frame.turn);
    var step = num(frame.step);
    state.live.turn = turn;
    state.live.step = step;
    state.activeTurn = turn === null ? state.activeTurn : turn;
    state.attemptId = state.attemptId || 'active';
    renderChatHeader();
  }

  function liveTool(frame) {
    var index = frame.i;
    ensureLive();
    var key = liveKey(index);
    var entry = state.live.blocks[key];
    if (!entry || entry.kind !== 'tool') entry = liveBlock(index, 'tool');
    var card = entry.card;
    if (frame.name) card.setName(frame.name);
    if (frame.id) {
      card.callId = String(frame.id);
      state.toolCards[card.callId] = card;
    }
    entry.text += String(frame.a === null || frame.a === undefined ? '' : frame.a);
    card.setArgs(entry.text);
  }

  function liveBlockStart(frame) {
    var bt = String(frame.bt === null || frame.bt === undefined ? '' : frame.bt);
    var kind = bt === 'text' ? 'text'
      : (bt === 'reasoning' ? 'reason' : ((bt === 'tool-call' || bt === 'tool') ? 'tool' : ''));
    if (!kind) return;
    liveBlock(frame.i, kind);
  }

  function renderLiveMeta() {
    if (!state.live || !state.live.meta) return;
    var parts = [];
    var usage = formatUsage(state.live.usage);
    if (usage) parts.push(usage);
    if (state.live.finish) parts.push('结束：' + String(state.live.finish));
    state.live.meta.textContent = parts.join(' · ');
  }

  function removeLive() {
    var live = state.live;
    if (!live) return;
    if (live.blocks) {
      for (var key in live.blocks) {
        if (!Object.prototype.hasOwnProperty.call(live.blocks, key)) continue;
        var entry = live.blocks[key];
        if (entry && entry.card && entry.card.callId && state.toolCards[entry.card.callId] === entry.card) {
          delete state.toolCards[entry.card.callId];
        }
      }
    }
    if (live.el && live.el.parentNode) live.el.parentNode.removeChild(live.el);
    state.live = null;
  }

  function applyStreamFrame(frame, gen, replay) {
    if (!frame || typeof frame !== 'object') return;
    var kind = String(frame.k || '');
    switch (kind) {
      case 'start':
        liveStart(frame);
        break;
      case 'text':
        liveAppend(frame.i, 'text', String(frame.t === null || frame.t === undefined ? '' : frame.t));
        break;
      case 'reason':
        liveAppend(frame.i, 'reason', String(frame.t === null || frame.t === undefined ? '' : frame.t));
        break;
      case 'tool':
        liveTool(frame);
        break;
      case 'block-start':
        liveBlockStart(frame);
        break;
      case 'block-end':
        break;
      case 'usage':
        if (state.live) { state.live.usage = frame.u; renderLiveMeta(); }
        break;
      case 'finish':
        if (state.live) { state.live.finish = frame.r; renderLiveMeta(); }
        break;
      case 'end':
        if (String(frame.outcome) === 'abandoned') {
          removeLive();
          renderChatHeader();
        }
        break;
      default:
        break;
    }
    if (!replay && state.stick) stickToBottom(false);
  }

  /* ------------------------------ 滚动 / 翻历史 ------------------------------ */

  function stickToBottom(smooth) {
    var el = els.stream;
    state.stick = true;
    els.btnBottom.hidden = true;
    if (smooth) {
      // 平滑滚动期间不要被滚动事件反复改判，滚完再按真实位置重算
      state.scrollLock = Date.now() + 700;
      try {
        el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
        setTimeout(function () {
          state.scrollLock = 0;
          onStreamScroll();
        }, 720);
        return;
      } catch (e) { /* 老浏览器：退化成直接跳 */ }
    }
    el.scrollTop = el.scrollHeight;
  }

  function onStreamScroll() {
    if (state.scrollLock && Date.now() < state.scrollLock) return;
    var el = els.stream;
    var gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    var atBottom = gap < STICK_GAP;
    state.stick = atBottom;
    els.btnBottom.hidden = atBottom;
    if (el.scrollTop < TOP_GAP) loadOlder();
  }

  function showTopHint(text) {
    if (!els.streamHint) return;
    if (text) {
      els.streamHint.textContent = text;
      els.streamHint.hidden = false;
    } else {
      els.streamHint.hidden = true;
    }
  }

  function loadOlder() {
    if (state.loadingOlder || !state.hasMore || !state.sessionId || !state.oldestSeq) return;
    state.loadingOlder = true;
    var gen = state.generation;
    var before = state.oldestSeq;
    showTopHint('正在载入更早的消息…');

    fetchJSON('/api/page?id=' + encodeURIComponent(state.sessionId) + '&before=' + before + '&max=' + PAGE_SIZE)
      .then(function (page) {
        if (gen !== state.generation) return;
        var recs = page && Array.isArray(page.records) ? page.records : [];
        var fresh = [];
        for (var i = 0; i < recs.length; i++) {
          var seq = num(recs[i] && recs[i].seq);
          if (seq === null || seq >= before) continue;   // 去重：只要更早的
          fresh.push(recs[i]);
        }
        fresh.sort(bySeq);
        if (fresh.length) {
          prependRecords(fresh);
          var oldest = num(fresh[0].seq);
          if (oldest !== null) state.oldestSeq = oldest;
          state.hasMore = !!(page && page.hasMore);
        } else {
          state.hasMore = false;   // 服务端没给新东西，别死循环
        }
        if (!state.hasMore) showTopHint('');
      })
      .catch(function (err) {
        if (gen !== state.generation) return;
        showTopHint('');
        showToast('载入更早消息失败：' + humanError(err));
      })
      .then(function () {
        state.loadingOlder = false;
        showTopHint('');
      });
  }

  function prependRecords(records) {
    var el = els.stream;
    var beforeHeight = el.scrollHeight;
    var beforeTop = el.scrollTop;
    var frag = document.createDocumentFragment();
    for (var i = 0; i < records.length; i++) appendEvent(records[i], frag);
    el.insertBefore(frag, el.firstChild);
    // 保持视觉位置：把新增的高度补进 scrollTop
    var delta = el.scrollHeight - beforeHeight;
    el.scrollTop = beforeTop + delta;
    state.stick = false;
  }

  /* ------------------------------ 调试视图 ------------------------------ */

  function pushDebug(kind, data) {
    var text;
    try {
      text = JSON.stringify(data, null, 1);
    } catch (e) {
      text = String(data);
    }
    if (text === undefined) text = String(data);
    if (text.length > 20000) text = text.slice(0, 20000) + '\n…（已截断）';
    state.debug.push({ kind: String(kind || '?'), text: text });
    while (state.debug.length > DEBUG_LIMIT) state.debug.shift();
    if (state.debugOn) renderDebug();
  }

  function renderDebug() {
    els.debugCount.textContent = String(state.debug.length);
    var frag = document.createDocumentFragment();
    for (var i = 0; i < state.debug.length; i++) {
      var item = state.debug[i];
      var box = document.createElement('div');
      box.className = 'dbg-item';
      var kind = document.createElement('div');
      kind.className = 'dbg-kind';
      kind.textContent = '#' + (i + 1) + ' ' + item.kind;
      var pre = document.createElement('pre');
      pre.className = 'dbg-json';
      pre.textContent = item.text;
      box.appendChild(kind);
      box.appendChild(pre);
      frag.appendChild(box);
    }
    els.debugBody.textContent = '';
    els.debugBody.appendChild(frag);
    els.debugBody.scrollTop = els.debugBody.scrollHeight;
  }

  function toggleDebug(force) {
    state.debugOn = force === undefined ? !state.debugOn : !!force;
    els.debug.hidden = !state.debugOn;
    els.btnRaw.setAttribute('aria-pressed', state.debugOn ? 'true' : 'false');
    if (state.debugOn) renderDebug();
  }

  /* ------------------------------ 提示条 ------------------------------ */

  var toastTimer = null;
  function showToast(message, ms) {
    if (!els.toast) return;
    els.toast.textContent = String(message);
    els.toast.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { els.toast.hidden = true; }, num(ms) === null ? 4000 : num(ms));
  }

  /* ------------------------------ 入口 ------------------------------ */

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  global.DSHMobileMirror = { state: state, connect: connect, disconnect: disconnect, renderMarkdown: renderMarkdown };
})(typeof globalThis !== 'undefined' ? globalThis : this);
