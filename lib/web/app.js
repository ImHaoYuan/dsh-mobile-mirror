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

  /**
   * 分组视图里的行标题。
   *
   * 分组头已经写着文件夹名，所以无标题的行不必再把文件夹名重复一遍 ——
   * 那样同一个分组里的每一行都会长得一模一样。
   */
  function groupedLabel(item) {
    if (hasTitle(item)) return item.title.trim();
    return '未命名会话';
  }

  /**
   * 列表副标题。
   *
   * P3-A 起不再拼工作区名：列表已经按文件夹分组、分组头上就写着完整路径，
   * 行里再重复一遍只是噪音。所以这里只留相对时间。
   */
  function sessionSubtitle(item, now) {
    if (!item || typeof item !== 'object') return '';
    return relTime(item.updatedAt, now) || '';
  }

  /**
   * 轮次结束原因 → 展示文案。completed 之外都算"需要留意"。
   *
   * `detail` 是整条 `turn/end` 的 data —— 当 `kind === 'error'` 时它带一个
   * `LlmFailure { message, code, status }`，**那才是「API 密钥无效」这类正文的出处**。
   * 只显示"本轮出错"等于把报错吃掉，用户根本不知道哪出了问题。
   */
  function turnEndText(reason, detail) {
    // 正常来说 reason 是投影后的**字符串**（就是 kind）。这里顺手容忍直接传原始
    // TurnEndReason 对象的情况 —— 否则 String({kind:'error'}) 会渲染成
    // 「本轮结束：[object Object]」，比不显示还难查。
    if (reason && typeof reason === 'object') reason = reason.kind;
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
    var base = table[key] || (key ? '本轮结束：' + key : '本轮结束');

    // 失败详情只在 reason 就是 error 时才用 —— 否则一条 completed 的 turn/end
    // 只要带了 error 字段就会被拼成「本轮完成：API 密钥无效」。
    var failure = key === 'error' && detail && detail.error && typeof detail.error === 'object' ? detail.error : null;
    var message = failure && typeof failure.message === 'string' ? failure.message.trim() : '';
    var meta = '';
    if (failure) {
      var bits = [];
      if (failure.code) bits.push(String(failure.code));
      if (typeof failure.status === 'number') bits.push('HTTP ' + failure.status);
      meta = bits.join(' · ');
    }

    return {
      // 有正文就拼上去；没有正文时**退回原来那句朴素提示** —— 字段缺失（旧数据、
      // 别的失败分支）不能让这一行彻底不显示。
      text: message ? base + '：' + message : base,
      meta: meta,
      warn: key !== 'completed',
      // 只要 reason 就是 error 就算失败 —— 哪怕 DSH 没给正文，这一轮也是白跑了，
      // 不能因为字段缺失就当成正常结束。aborted 是用户自己停的，不算。
      failed: key === 'error'
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
  /** URL 是否允许出现在 href/src 里：只放行 http/https，其余一律降级成纯文本。 */
  function safeUrl(url) {
    return /^https?:\/\//i.test(String(url === null || url === undefined ? '' : url));
  }

  /** 强调定界符的边界字符：`_` 紧挨着这些字符时不算强调，免得 snake_case_name 变斜体。 */
  var WORD_CHAR = /[0-9A-Za-z\u4e00-\u9fa5]/;

  /**
   * 找一对强调定界符的闭合位置。
   *
   * 内容为空、或以空白开头/结尾都不算合法闭合（CommonMark 的 flanking 规则）；
   * 遇到不合法的闭合符要往后继续找 —— 这是 `**粗 *斜* 粗**` 能正确解析的关键：
   * 外层 `**` 若在内层 `*` 上抢先闭合，结果就烂成 `*<em>粗 </em>斜<em> 粗</em>*`。
   */
  function findClose(text, from, delim) {
    var at = from;
    while (true) {
      var idx = text.indexOf(delim, at);
      if (idx < 0) return null;
      var body = text.slice(from, idx);
      if (body.length && !/^\s/.test(body) && !/\s$/.test(body)) {
        return { text: body, end: idx + delim.length };
      }
      at = idx + 1;
    }
  }

  /** `_` / `__` / `___` 的闭合符是否落在词边界上。 */
  function underscoreOk(text, openIdx, closeIdx, delimLen) {
    var before = openIdx > 0 ? text.charAt(openIdx - 1) : '';
    var after = text.charAt(closeIdx + delimLen);
    return !WORD_CHAR.test(before) && !WORD_CHAR.test(after);
  }

  /**
   * 从 start 处（text[start] === '['）解析 `[label](url "title")`。
   * 输入已转义，所以引号是 &quot; / &#39;。解析不出来返回 null。
   */
  function matchLink(text, start) {
    var close = text.indexOf(']', start + 1);
    if (close < 0 || text.charAt(close + 1) !== '(') return null;
    var end = text.indexOf(')', close + 2);
    if (end < 0) return null;
    var m = /^(\S+)(?:\s+(&quot;|&#39;)([\s\S]*?)\2)?$/.exec(text.slice(close + 2, end));
    if (!m) return null;
    return { label: text.slice(start + 1, close), url: m[1], title: m[3] || '', end: end + 1 };
  }

  /** 在 i 处尝试匹配一个行内强调标记，失败返回 null。 */
  function matchEmphasis(text, i) {
    var kinds = [
      ['***', '<strong><em>%s</em></strong>'], ['___', '<strong><em>%s</em></strong>'],
      ['**', '<strong>%s</strong>'], ['__', '<strong>%s</strong>'],
      ['~~', '<del>%s</del>'],
    ];
    for (var k = 0; k < kinds.length; k++) {
      var delim = kinds[k][0];
      if (text.substr(i, delim.length) !== delim) continue;
      var hit = findClose(text, i + delim.length, delim);
      if (!hit) continue;
      if (delim.charAt(0) === '_' && !underscoreOk(text, i, hit.end - delim.length, delim.length)) continue;
      return { html: kinds[k][1].replace('%s', mdEmphasis(hit.text)), end: hit.end };
    }
    var one = text.charAt(i);
    if (one === '*' || one === '_') {
      // 单字符定界符不能是更长一串定界符的一部分：`a **** b` 不是强调，
      // 否则中间那两个星号会被凑成一对，渲染出 `<em>*</em>*` 这种垃圾。
      if (text.charAt(i + 1) === one) return null;
      var single = findClose(text, i + 1, one);
      // 闭合符后面还紧跟着同字符，说明它属于更长的串，换下一个候选
      while (single && text.charAt(single.end) === one) single = findClose(text, single.end + 1, one);
      if (single) {
        if (one === '_' && !underscoreOk(text, i, single.end - 1, 1)) return null;
        return { html: '<em>' + mdEmphasis(single.text) + '</em>', end: single.end };
      }
    }
    return null;
  }

  /**
   * 行内标记 → HTML。输入是**已转义**的单行文本。
   *
   * 强调用递归下降而不是一串 replace：只有递归才能正确嵌套（`**粗 *斜* 粗**`），
   * 顺序化的 replace 会让内层标记被外层抢先匹配。
   */
  function mdEmphasis(text) {
    var out = '';
    var i = 0;
    var n = text.length;
    while (i < n) {
      var ch = text.charAt(i);

      // 图片 ![alt](url)
      if (ch === '!' && text.charAt(i + 1) === '[') {
        var img = matchLink(text, i + 1);
        if (img && safeUrl(img.url)) {
          out += '<img src="' + img.url + '" alt="' + img.label + '"'
            + (img.title ? ' title="' + img.title + '"' : '') + ' loading="lazy">';
          i = img.end;
          continue;
        }
      }

      // 链接 [label](url)
      if (ch === '[') {
        var link = matchLink(text, i);
        if (link && safeUrl(link.url)) {
          out += '<a href="' + link.url + '" target="_blank" rel="noopener noreferrer"'
            + (link.title ? ' title="' + link.title + '"' : '') + '>' + mdEmphasis(link.label) + '</a>';
          i = link.end;
          continue;
        }
      }

      // 自动链接：<https://…> 已被 esc 成 &lt;https://…&gt;
      if (text.substr(i, 4) === '&lt;') {
        var gt = text.indexOf('&gt;', i + 4);
        if (gt > 0) {
          var bare = text.slice(i + 4, gt);
          if (/^https?:\/\/\S+$/.test(bare)) {
            out += '<a href="' + bare + '" target="_blank" rel="noopener noreferrer">' + bare + '</a>';
            i = gt + 4;
            continue;
          }
        }
      }

      var mark = matchEmphasis(text, i);
      if (mark) { out += mark.html; i = mark.end; continue; }

      out += ch;
      i++;
    }
    return out;
  }

  /**
   * 行内代码先摘成占位符，内容不再参与任何解析（`a**b` 里的星号不会被当强调）；
   * 其余标记交给 mdEmphasis，最后再还原代码。
   */
  function mdInline(escaped) {
    var text = String(escaped === null || escaped === undefined ? '' : escaped).replace(/\u0000/g, '');
    var codes = [];
    text = text.replace(/`([^`\n]+)`/g, function (whole, body) {
      codes.push(body);
      return '\u0000C' + (codes.length - 1) + '\u0000';
    });
    text = mdEmphasis(text);
    return text.replace(/\u0000C(\d+)\u0000/g, function (whole, idx) {
      var body = codes[Number(idx)];
      return '<code>' + (body === undefined ? '' : body) + '</code>';
    });
  }

  /** 拆一行表格：去掉首尾竖线，`\|` 转义成占位符避免被当分隔符。 */
  function splitRow(line) {
    var t = String(line).replace(/\\\|/g, '\u0000P\u0000').trim();
    if (t.charAt(0) === '|') t = t.slice(1);
    if (t.charAt(t.length - 1) === '|') t = t.slice(0, -1);
    return t.split('|').map(function (cell) {
      return cell.replace(/\u0000P\u0000/g, '|').trim();
    });
  }

  /** 表格的分隔行：|---|---|、|:--|--:|:-:| 之类。 */
  function isTableDelim(line) {
    var cells = splitRow(line);
    if (!cells.length) return false;
    for (var i = 0; i < cells.length; i++) {
      if (!/^:?-{1,}:?$/.test(cells[i])) return false;
    }
    return true;
  }

  function tableAlign(cell) {
    var left = cell.charAt(0) === ':';
    var right = cell.charAt(cell.length - 1) === ':';
    if (left && right) return 'center';
    if (right) return 'right';
    if (left) return 'left';
    return '';
  }

  /**
   * 渲染 GFM 表格。外层套一个 .md-table 用来横向滚动 ——
   * 手机上列一多就会撑破屏幕，靠这个容器滚比让整个页面横向滚要舒服。
   */
  function renderTable(head, aligns, rows) {
    function cell(tag, text, idx) {
      var align = aligns[idx] || '';
      return '<' + tag + (align ? ' style="text-align:' + align + '"' : '') + '>'
        + mdInline(esc(text)) + '</' + tag + '>';
    }
    var html = '<div class="md-table"><table><thead><tr>';
    for (var c = 0; c < head.length; c++) html += cell('th', head[c], c);
    html += '</tr></thead><tbody>';
    for (var r = 0; r < rows.length; r++) {
      html += '<tr>';
      for (var k = 0; k < head.length; k++) html += cell('td', rows[r][k] === undefined ? '' : rows[r][k], k);
      html += '</tr>';
    }
    return html + '</tbody></table></div>';
  }

  /**
   * 精简 Markdown → HTML（够用就好，不追求 CommonMark 全兼容）。
   *
   * 支持：# 标题、**粗体**、*斜体*、`行内代码`、```围栏代码块、-/* 无序列表（可嵌套）、
   * 1. 有序列表（认起始号）、> 引用、[t](u "标题") 链接、![t](u) 图片、<url> 自动链接、
   * --- 水平线、~~删除线~~、- [x] 任务列表、GFM 表格、段落与换行。
   *
   * 安全性：先 esc 整体转义再做标记替换，所以原文里的 HTML 永远出不来；
   * 链接与图片只放行 http/https，其他协议（javascript:、data: 等）降级成纯文本。
   */
  function renderMarkdown(src) {
    var lines = String(src === null || src === undefined ? '' : src).replace(/\r\n?/g, '\n').split('\n');
    var out = [];
    var para = [];
    var quote = [];      // string[]
    var listRoots = [];  // 顶层列表节点（根层有序↔无序切换会产生多个）
    var listStack = [];  // 当前缩进路径上的列表节点，栈顶是正在填的那一层

    function flushPara() {
      if (!para.length) return;
      out.push('<p>' + para.map(function (line) { return mdInline(esc(line)); }).join('<br>') + '</p>');
      para = [];
    }
    function flushQuote() {
      if (!quote.length) return;
      out.push('<blockquote>' + quote.map(function (line) { return mdInline(esc(line)); }).join('<br>') + '</blockquote>');
      quote = [];
    }

    /** 列表项：task 为 null 表示普通项，true/false 表示勾选状态。 */
    function makeItem(text) {
      var task = /^\[([ xX])\]\s+(.*)$/.exec(text);
      if (task) return { text: task[2], task: task[1] !== ' ', children: [] };
      return { text: text, task: null, children: [] };
    }
    function newList(ordered, indent, startNo) {
      return { ordered: ordered, indent: indent, start: startNo, items: [] };
    }
    function renderList(node) {
      var tag = node.ordered ? 'ol' : 'ul';
      var start = node.ordered && node.start > 1 ? ' start="' + node.start + '"' : '';
      var items = node.items.map(function (item) {
        // 续行用 \n 分隔，这里还原成 <br>；分段做 mdInline 免得续行影响首行的解析
        var inner = item.text.split('\n').map(function (t) { return mdInline(esc(t)); }).join('<br>');
        if (item.task === true) inner = '<span class="md-check on" aria-hidden="true"></span>' + inner;
        else if (item.task === false) inner = '<span class="md-check" aria-hidden="true"></span>' + inner;
        if (item.children.length) inner += item.children.map(renderList).join('');
        return '<li' + (item.task === null ? '' : ' class="md-task"') + '>' + inner + '</li>';
      }).join('');
      return '<' + tag + start + '>' + items + '</' + tag + '>';
    }
    function flushList() {
      if (!listRoots.length) return;
      out.push(listRoots.map(renderList).join(''));
      listRoots = [];
      listStack = [];
    }
    function flushAll() { flushPara(); flushList(); flushQuote(); }

    /** 按缩进把一项挂到正确层级：更深→子列表，同级→同列表，更浅→退栈。 */
    function pushListItem(indent, ordered, text, startNo) {
      while (listStack.length > 1 && indent < listStack[listStack.length - 1].indent) listStack.pop();
      var top = listStack[listStack.length - 1];

      if (!top || indent < top.indent) {
        top = newList(ordered, indent, startNo);
        listRoots.push(top);
        listStack = [top];
      } else if (indent > top.indent) {
        var parent = top.items[top.items.length - 1];
        if (!parent) { top.items.push(makeItem(text)); return; }
        var child = newList(ordered, indent, startNo);
        parent.children.push(child);
        listStack.push(child);
        top = child;
      } else if (top.ordered !== ordered) {
        // 同缩进但类型变了（有序 ↔ 无序）：同级另起一个列表
        var sibling = newList(ordered, indent, startNo);
        var host = listStack.length > 1 ? listStack[listStack.length - 2].items[listStack[listStack.length - 2].items.length - 1] : null;
        if (host) host.children.push(sibling); else listRoots.push(sibling);
        listStack[listStack.length - 1] = sibling;
        top = sibling;
      }

      top.items.push(makeItem(text));
    }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];

      // 围栏代码块：内容整段原样保留
      var fence = /^\s*```(.*)$/.exec(line);
      if (fence) {
        flushAll();
        var lang = String(fence[1] || '').trim().split(/\s+/)[0] || '';
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

      // 表格：本行有竖线，且下一行是分隔行
      if (line.indexOf('|') >= 0 && i + 1 < lines.length && isTableDelim(lines[i + 1])) {
        flushAll();
        var head = splitRow(line);
        var aligns = splitRow(lines[i + 1]).map(tableAlign);
        var rows = [];
        i += 2;
        while (i < lines.length && lines[i].trim() && lines[i].indexOf('|') >= 0) {
          rows.push(splitRow(lines[i]));
          i++;
        }
        i--;  // 外层循环还会 i++
        out.push(renderTable(head, aligns, rows));
        continue;
      }

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

      var ul = /^(\s*)[-*+]\s+(.*)$/.exec(line);
      var ol = ul ? null : /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line);
      if (ul || ol) {
        flushPara(); flushQuote();
        var indent = (ul ? ul[1] : ol[1]).replace(/\t/g, '    ').length;
        pushListItem(indent, !!ol, ul ? ul[2] : ol[3], ol ? Number(ol[2]) : 1);
        continue;
      }

      // 列表项的续行：有缩进、又不是新标记、且当前确实在列表里 → 并进上一项
      if (listStack.length && /^\s+\S/.test(line)) {
        var cur = listStack[listStack.length - 1].items[listStack[listStack.length - 1].items.length - 1];
        if (cur) { cur.text += '\n' + line.trim(); continue; }
      }

      flushList(); flushQuote();
      para.push(line);
    }
    flushAll();
    return out.join('\n');
  }

  /* ---------------------------- P2：发送 / 停止 ---------------------------- */

  // 与服务端 MAX_PROMPT_CHARS 一致：去空白后最多 100000 字符。
  // 两边各判一次，值不一致就会出现"手机上打得出来、服务端拒收"这种最难查的组合，
  // tools/web-test.mjs 里有一条断言把这两个数字钉在一起。
  var PROMPT_MAX = 100000;
  // 接近上限才显示字数提示。跟着上限走，不写死 —— 上限从 8000 提到 100000 后，
  // 写死的 7000 会让字数提示在几乎每一条长消息上都冒出来。
  var PROMPT_COUNTER_AT = PROMPT_MAX - 1000;
  var REQUEST_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
  var idSeq = 0;

  /** 发送用的文本：去掉首尾空白（服务端按去空白后的内容判空、判长度）。 */
  function normalizePromptText(text) {
    return String(text === null || text === undefined ? '' : text).trim();
  }

  /** 本地预校验，返回错误码（'' 表示没问题），错误码与服务端一致。 */
  function promptTextError(text) {
    var t = normalizePromptText(text);
    if (!t) return 'empty-text';
    if (t.length > PROMPT_MAX) return 'text-too-long';
    return '';
  }

  /** 字数提示：只有接近上限才出现。 */
  function counterText(text) {
    var len = normalizePromptText(text).length;
    if (len <= PROMPT_COUNTER_AT) return { text: '', over: false };
    return { text: len + '/' + PROMPT_MAX, over: len > PROMPT_MAX };
  }

  /**
   * 生成 requestId（幂等键）。
   * 优先 crypto.randomUUID()，拿不到就自己拼一个（时间戳 36 进制 + 随机串 + 自增计数）。
   * 两种形态都必须匹配 ^[A-Za-z0-9_-]{1,128}$ —— UUID 里的 "-" 是合法字符。
   */
  function newRequestId(cryptoObj, nowMs) {
    var id = '';
    try {
      if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
        id = String(cryptoObj.randomUUID() || '');
      }
    } catch (e) { id = ''; }
    if (!id) {
      var stamp = num(nowMs);
      if (stamp === null) stamp = Date.now();
      idSeq += 1;
      id = stamp.toString(36) + '-' + Math.random().toString(36).slice(2, 10) + '-' + idSeq.toString(36);
    }
    id = id.replace(/[^A-Za-z0-9_-]/g, '');
    if (!id) id = 'r' + Date.now().toString(36);
    return id.slice(0, 128);
  }

  /** 浏览器时区；拿不到就退 UTC。intl 可注入，方便单测。 */
  function timeZoneOf(intl) {
    try {
      if (intl && typeof intl.DateTimeFormat === 'function') {
        var tz = intl.DateTimeFormat().resolvedOptions().timeZone;
        if (tz) return String(tz);
      }
    } catch (e) { /* 忽略 */ }
    return 'UTC';
  }

  /** POST /api/prompt 的请求体。 */
  function buildPromptPayload(sessionId, requestId, text, timeZone) {
    return {
      sessionId: String(sessionId === null || sessionId === undefined ? '' : sessionId),
      requestId: String(requestId === null || requestId === undefined ? '' : requestId),
      text: normalizePromptText(text),
      timeZone: String(timeZone || 'UTC')
    };
  }

  /**
   * snapshot 重放后对账：records 里出现的 user/message 按顺序配掉"最老的同文本"pending。
   * 返回应该被消掉的 pending 下标（升序）。
   * 同一段文本可能发过多次，所以必须按"顺序 + 文本"配对，不能只查存在性。
   */
  function matchPendingAgainstRecords(records, pendingTexts) {
    var out = [];
    if (!Array.isArray(records) || !Array.isArray(pendingTexts)) return out;
    var used = [];
    for (var i = 0; i < pendingTexts.length; i++) used.push(false);
    for (var r = 0; r < records.length; r++) {
      var ev = records[r];
      if (!ev || ev.type !== 'user/message' || !ev.data || typeof ev.data !== 'object') continue;
      var text = normalizePromptText(blocksToText(ev.data.blocks));
      if (!text) continue;
      for (var p = 0; p < pendingTexts.length; p++) {
        if (used[p]) continue;
        if (normalizePromptText(pendingTexts[p]) === text) { used[p] = true; out.push(p); break; }
      }
    }
    out.sort(function (a, b) { return a - b; });
    return out;
  }

  /* ======================================================================
   * P3 纯函数：工作区分组、模型/模式显示、答案组装
   * ====================================================================== */

  /** DSH 内置 preset 的中文名（与服务端 mirror.js 的 PRESET_NAMES 保持一致）。 */
  var PRESET_NAMES = { standard: '标准模式', ptc: 'PTC 模式', minimal: '极简模式', cordis: '创造模式' };

  /** 路径缩短：保留首段与末段，中间省略。长路径会把分组头撑爆。 */
  function shortPath(p) {
    var s = String(p === null || p === undefined ? '' : p).replace(/[\\/]+$/, '');
    if (!s) return '';
    var parts = s.split(/[\\/]+/).filter(function (x) { return x; });
    if (parts.length <= 2) return s;
    return parts[0] + '\\…\\' + parts[parts.length - 1];
  }

  /** 模式显示名：服务端 roster 的 label → 内置中文表 → 原 id。 */
  function presetDisplay(id, roster) {
    var key = String(id === null || id === undefined ? '' : id).trim();
    if (!key) return '';
    if (Array.isArray(roster)) {
      for (var i = 0; i < roster.length; i++) {
        var row = roster[i];
        if (!row || row.id !== key) continue;
        if (typeof row.label === 'string' && row.label.trim()) return row.label.trim();
        if (typeof row.name === 'string' && row.name.trim()) return row.name.trim();
        break;
      }
    }
    return PRESET_NAMES[key] || key;
  }

  /** 当前模型 → 显示名（在目录里能找到就用它的 name，否则用 id）。 */
  function modelDisplay(provider, model, catalog) {
    var pid = String(provider === null || provider === undefined ? '' : provider);
    var mid = String(model === null || model === undefined ? '' : model);
    if (!mid) return '';
    var groups = catalog && Array.isArray(catalog.groups) ? catalog.groups : [];
    for (var g = 0; g < groups.length; g++) {
      var group = groups[g];
      if (!group || !Array.isArray(group.models)) continue;
      if (pid && group.id !== pid) continue;
      for (var m = 0; m < group.models.length; m++) {
        if (group.models[m] && group.models[m].id === mid) return group.models[m].name || mid;
      }
    }
    return mid;
  }

  /**
   * 当前模式：投影优先，header 只作兜底。
   *
   * `header.agentPreset` 是**创建时**的模式，而且被深冻结（DSH 源码注释原文：
   * "The creation header names the preset a session STARTED with, and it is deep-frozen
   * because that is a creation fact"）。会话在还是空白的时候可以换模式，那次变更只落在
   * `agent-preset/selected` 事件里、进而进投影。所以投影才是"现在是什么模式" ——
   * 之前读 header，于是创造模式的会话在手机上显示成 "standard"。
   */
  function activePreset(proj, header) {
    var p = proj && typeof proj === 'object' ? proj : {};
    var h = header && typeof header === 'object' ? header : {};
    if (typeof p.agentPreset === 'string' && p.agentPreset) return p.agentPreset;
    if (typeof h.agentPreset === 'string' && h.agentPreset) return h.agentPreset;
    return '';
  }

  /**
   * 取"下一次请求会用的模型"。
   *
   * 来源优先级：投影 `modelSelection.next` → 最新一条 request/header 的 config → 全局默认。
   * `next` 的定义就是 `state.pending ?? state.lastUsed`（投影的 wire.view），所以它本身
   * 已经是答案了，后两级只是兜底。
   *
   * 注意投影的键叫 `modelSelection` 而不是 `model` —— 之前读错了键，模型芯片永远是空的。
   */
  function selectionOf(proj, fallback, catalog) {
    var p = proj && typeof proj === 'object' ? proj : {};
    var pick = p.modelSelection && typeof p.modelSelection === 'object' ? p.modelSelection.next : null;
    var provider = pick && typeof pick.provider === 'string' ? pick.provider : '';
    var model = pick && typeof pick.model === 'string' ? pick.model : '';
    var effort = pick && typeof pick.reasoningEffort === 'string' ? pick.reasoningEffort : '';

    if (!model && fallback && typeof fallback === 'object') {
      if (typeof fallback.provider === 'string') provider = fallback.provider;
      if (typeof fallback.model === 'string') model = fallback.model;
    }
    // 全新会话（没选过、也没跑过）投影两边都是 null，这时显示全局默认值 ——
    // 它正是"下一条请求会用的模型"，比留一个空芯片有用得多。
    var def = catalog && typeof catalog === 'object' ? catalog.default : null;
    if (!model && def && typeof def.model === 'string') {
      if (typeof def.provider === 'string') provider = def.provider;
      model = def.model;
      if (!effort && typeof def.reasoningEffort === 'string') effort = def.reasoningEffort;
    }
    return { provider: provider, model: model, reasoningEffort: effort };
  }

  /** 在目录里找出某个模型条目（用于拿它的 reasoning 档位）。 */
  function modelEntry(provider, model, catalog) {
    var groups = catalog && Array.isArray(catalog.groups) ? catalog.groups : [];
    for (var g = 0; g < groups.length; g++) {
      var group = groups[g];
      if (!group || group.id !== provider || !Array.isArray(group.models)) continue;
      for (var m = 0; m < group.models.length; m++) {
        if (group.models[m] && group.models[m].id === model) return group.models[m];
      }
    }
    return null;
  }

  /**
   * 本地兜底分组。
   * 服务端 /api/sessions 已经给了 groups，这里只在响应里**没有** groups 字段时兜一下，
   * 保证界面不会因为版本不一致而整块空掉。
   */
  function groupLocally(items) {
    var list = Array.isArray(items) ? items : [];
    var map = {};
    var order = [];
    for (var i = 0; i < list.length; i++) {
      var item = list[i] || {};
      var raw = typeof item.cwd === 'string' ? item.cwd.trim().replace(/[\\/]+$/, '') : '';
      var key = raw ? raw.toLowerCase() : '';
      if (!map[key]) {
        map[key] = {
          key: key,
          name: raw ? (pathTail(raw) || raw) : '无工作区',
          path: raw || null,
          items: [], updatedAt: 0, running: false
        };
        order.push(key);
      }
      map[key].items.push(item);
      var t = num(item.updatedAt) || 0;
      if (t > map[key].updatedAt) map[key].updatedAt = t;
      if (item.running) map[key].running = true;
    }
    var out = order.map(function (k) { return map[k]; });
    out.sort(function (a, b) {
      if (a.key === '' && b.key === '') return 0;
      if (a.key === '') return 1;
      if (b.key === '') return -1;
      return b.updatedAt - a.updatedAt;
    });
    return out;
  }

  /** 某道题的当前草稿 `{ selected, custom }`。 */
  function draftFor(draft, questionId) {
    var d = draft && typeof draft === 'object' ? draft[questionId] : null;
    if (!d || typeof d !== 'object') return { selected: [], custom: '' };
    return {
      selected: Array.isArray(d.selected) ? d.selected.slice() : [],
      custom: typeof d.custom === 'string' ? d.custom : ''
    };
  }

  /** 单选：点已选中的就取消，否则替换。 */
  function toggleSingle(current, label) {
    var sel = Array.isArray(current) ? current : [];
    if (sel.length === 1 && sel[0] === label) return [];
    return [label];
  }

  /** 多选：增删。 */
  function toggleMulti(current, label) {
    var sel = Array.isArray(current) ? current.slice() : [];
    var at = sel.indexOf(label);
    if (at >= 0) sel.splice(at, 1);
    else sel.push(label);
    return sel;
  }

  /**
   * 把草稿组装成 /api/answer 的 answers。
   * 返回 null 表示还有题目没答 —— 前端据此禁用提交按钮。
   */
  function answersFromDraft(questions, draft) {
    if (!Array.isArray(questions) || !questions.length) return null;
    var out = [];
    for (var i = 0; i < questions.length; i++) {
      var q = questions[i];
      if (!q || typeof q.id !== 'string') return null;
      var d = draftFor(draft, q.id);
      var selected = d.selected.filter(function (x) { return typeof x === 'string' && x.trim(); });
      var custom = d.custom.trim();
      if (!selected.length && !custom) return null;
      var item = { id: q.id, selected: selected };
      if (custom) item.custom = custom;
      out.push(item);
    }
    return out;
  }

  /** 还没作答的题目数量。 */
  function unansweredCount(questions, draft) {
    if (!Array.isArray(questions)) return 0;
    var n = 0;
    for (var i = 0; i < questions.length; i++) {
      var q = questions[i];
      if (!q || typeof q.id !== 'string') continue;
      var d = draftFor(draft, q.id);
      var has = d.selected.some(function (x) { return typeof x === 'string' && x.trim(); });
      if (!has && !d.custom.trim()) n++;
    }
    return n;
  }

  /** 折叠状态在 localStorage 里的键名（按工作区分开存）。 */
  function collapseKey(workspaceKey) {
    return 'dsh-mm-collapsed:' + String(workspaceKey === null || workspaceKey === undefined ? '' : workspaceKey);
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
    mdInline: mdInline, renderMarkdown: renderMarkdown,
    PROMPT_MAX: PROMPT_MAX, PROMPT_COUNTER_AT: PROMPT_COUNTER_AT, REQUEST_ID_RE: REQUEST_ID_RE,
    normalizePromptText: normalizePromptText, promptTextError: promptTextError, counterText: counterText,
    newRequestId: newRequestId, timeZoneOf: timeZoneOf,
    buildPromptPayload: buildPromptPayload, matchPendingAgainstRecords: matchPendingAgainstRecords,
    shortPath: shortPath, presetDisplay: presetDisplay, modelDisplay: modelDisplay,
    modelEntry: modelEntry, groupLocally: groupLocally,
    draftFor: draftFor, toggleSingle: toggleSingle, toggleMulti: toggleMulti,
    answersFromDraft: answersFromDraft, unansweredCount: unansweredCount,
    collapseKey: collapseKey, PRESET_NAMES: PRESET_NAMES, groupedLabel: groupedLabel,
    activePreset: activePreset, selectionOf: selectionOf
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
  // 刻度条出现的门槛：只说了一句的时候，那条刻度除了挡视线没有任何用
  var RAIL_MIN = 2;

  var CONFIG = { enablePrompt: false };
  var els = {};
  var state = {
    view: 'list',
    sessions: [],
    groups: [],
    sessionId: null,
    sessionTitle: '',
    // P3：preset/model 各带一个原始 id 与一个显示名 —— 切换面板按 id 匹配，
    // 头部按显示名渲染，两者不能混用。
    sub: {
      cwd: '', preset: '', presetLabel: '', model: '', modelLabel: '',
      provider: '', reasoningEffort: '', canSwitchPreset: true
    },
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
    // 快照重建期间为 true。重建会把几十条历史一次性插进消息流，
    // 那时不能给它们加"新消息"进场动画 —— 否则打开会话时一屏同时乱动。
    replaying: false,
    attemptId: null,
    live: null,
    toolCards: {},
    toolResults: {},
    toolOrphans: {},
    debug: [],
    debugOn: false,
    // P2：发送 / 停止
    // pending 是"待回显队列"，按发送顺序排；每个条目独立跟踪自己的气泡，
    // 互不覆盖（排队模式下可能同时挂着好几条）。
    // 条目：{ requestId, text, sessionId, el, failed, timer }
    //   failed=false 正在飞或已受理，都在等 user/message 回显（回显按顺序消费这类条目）
    //   failed=true  发送失败待重试，气泡已撤、只留 requestId 供 requestIdFor 复用
    pending: [],
    sendingId: null,      // 正在飞的 requestId（只有它自己的回包能清掉）
    cancelling: false,
    // P3-B/C：模型目录与模式清单（懒加载 + 客户端缓存，服务端还有一层 60 秒缓存）
    catalog: null,
    catalogAt: 0,
    presets: null,
    presetsAt: 0,
    // P3-A：已折叠的工作区 key
    collapsed: {},
    // P3-D：当前会话的待答问题 / 草稿 / 提交状态
    question: null,
    questionDraft: {},
    questionSending: false,
    questionNote: '',
    questionSource: null,
    // 右侧快捷跳转刻度条：{ el, target }[]（target 是 .msg.me 节点）
    railTicks: [],
    railActive: -1,
    railTimer: null,
    jumpTimer: null,
    // 已向服务端认领等待的问题 id（null = 没认领任何问题）。
    // 认领期间宿主不跑自己的 120 秒倒计时，手机上作答不会变成"迟到回复"。
    questionHoldId: null,
    questionHeld: false,
    questionWaitMs: null,
    // 提问卡片收起状态 + 当前卡片对应的问题 id（换问题要自动展开）
    qcardCollapsed: false,
    qcardId: null,
    // P4：新建会话用的文件夹清单与提交状态
    workspaces: null,
    creating: false
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
    els.btnNew = $('btn-new');
    els.btnListRetry = $('btn-list-retry');
    els.chatTitle = $('chat-title');
    els.chatSub = $('chat-sub');
    els.chatDot = $('chat-dot');
    els.btnBack = $('btn-back');
    els.btnRaw = $('btn-raw');
    els.stream = $('stream');
    els.rail = $('rail');
    els.railTip = $('rail-tip');
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
    els.composerCount = $('composer-count');
    els.btnStop = $('btn-stop');
    els.toast = $('toast');
    els.qcard = $('qcard');
    els.qcardTitle = $('qcard-title');
    els.qcardCount = $('qcard-count');
    els.qcardBody = $('qcard-body');
    els.qcardSubmit = $('qcard-submit');
    els.qcardToggle = $('qcard-toggle');
    els.qcardNote = $('qcard-note');
    els.sheet = $('sheet');
    els.sheetBackdrop = $('sheet-backdrop');
    els.sheetTitle = $('sheet-title');
    els.sheetBody = $('sheet-body');
    els.sheetClose = $('sheet-close');

    CONFIG.enablePrompt = document.body.getAttribute('data-enable-prompt') === 'yes';
    if (CONFIG.enablePrompt) {
      els.composer.hidden = false;
      autoGrow();
      updateSendState();
    }

    bind();
    connectQuestions();
    loadSessions(true);
  }

  function bind() {
    els.btnRefresh.addEventListener('click', function () { loadSessions(false); });
    els.btnNew.addEventListener('click', function () { openNewSheet(); });
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
    // P3-B/C：模型 / 模式选择面板
    els.sheetClose.addEventListener('click', closeSheet);
    els.sheetBackdrop.addEventListener('click', closeSheet);
    // P3-D：提交答案
    els.qcardSubmit.addEventListener('click', submitQuestion);
    els.qcardToggle.addEventListener('click', toggleQcard);
    els.btnStop.addEventListener('click', cancelRun);
    els.composerSend.addEventListener('click', sendPrompt);
    els.composerInput.addEventListener('input', function () {
      autoGrow();
      updateSendState();
    });
    els.composerInput.addEventListener('keydown', onComposerKey);

    window.addEventListener('pagehide', function () {
      // 页面要走了：先把等待认领放掉（宿主随即按原 deadline 决定，不会卡住 agent），
      // 再断长连接。keepalive 让这个请求在页面卸载过程中也能发出去。
      releaseQuestionHold();
      disconnect();
    });
    window.addEventListener('online', function () {
      if (state.view === 'chat' && (!state.source || state.source.readyState === ES_CLOSED)) connect();
    });
    document.addEventListener('visibilitychange', function () {
      // 切到后台就不再"看着"卡片：认领跟着页面可见性走
      syncQuestionHold();
      if (document.visibilityState !== 'visible') return;
      // 回到前台：任何断掉的长连接都补上。问题流断掉会漏掉提问，必须重连。
      if (!state.questionSource || state.questionSource.readyState === ES_CLOSED) connectQuestions();
      if (state.view === 'chat') {
        if (!state.source || state.source.readyState === ES_CLOSED) connect();
      } else if (Date.now() - state.lastListAt > 10000) {
        loadSessions(false);
      }
    });
  }

  /** 系统是否要求减少动效。真机上这通常来自"动画程序时长缩放 = 关闭"。 */
  function reducedMotion() {
    return typeof window !== 'undefined' &&
           typeof window.matchMedia === 'function' &&
           window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  /**
   * 切换列表页 / 聊天页。
   *
   * 用 View Transitions API（Chrome 111+）做转场：浏览器给切换前后的整页各拍一张
   * 快照，再由 CSS 里的 ::view-transition-* 规则决定怎么过渡。
   * 不支持时直接切 —— 没有任何副作用，只是没有动画。
   */
  function setView(name) {
    var same = state.view === name;
    var apply = function () {
      state.view = name;
      els.viewList.hidden = name !== 'list';
      els.viewChat.hidden = name !== 'chat';
      // 离开聊天页就不再"看着"那张卡片了，认领要跟着放掉
      syncQuestionHold();
    };

    if (same || reducedMotion() ||
        typeof document.startViewTransition !== 'function') {
      apply();
      return;
    }

    // 方向给 CSS 用：进聊天页与回列表页的滑动方向相反
    document.documentElement.setAttribute('data-nav', name === 'chat' ? 'forward' : 'back');
    document.startViewTransition(apply);
  }

  /* ------------------------------ 网络 ------------------------------ */

  var ERROR_TEXT = {
    'session-controller-unavailable': '宿主端会话控制器不可用（DSH 可能还没就绪）',
    'unknown-session': '会话不存在或已经关闭',
    'bad-request': '请求参数有误',
    'missing-id': '请求缺少会话 id',
    'missing-before': '翻页参数不完整',
    unauthorized: '登录已失效，请重新登录',
    // P2：发送 / 停止
    'prompt-disabled': '手机端写操作已被配置关闭（enablePrompt=false）',
    'missing-session-id': '请求缺少会话 id',
    'bad-request-id': '请求标识不合法，请重试',
    'empty-text': '内容不能为空',
    'text-too-long': '内容超过 ' + PROMPT_MAX + ' 字符上限',
    // 服务端请求体闸门（413）。客户端本来就会先拦，这里只是兜住"改了上限没改闸门"
    // 这类不一致 —— 没有它，用户看到的是一句莫名其妙的"socket hang up"。
    'body-too-large': '内容太长，服务端拒收（请缩短到 ' + PROMPT_MAX + ' 字符以内）',
    'bad-body': '请求体不是合法 JSON',
    'unsupported-media-type': '请求格式不被接受（需要 application/json）',
    'too-fast': '发送太快了，稍等一下',
    'prompt-failed': '上游报错',
    'cancel-failed': '上游报错',
    // P3：模型 / 模式 / 提问
    'models-failed': '读取模型列表失败',
    'model-failed': '切换模型失败',
    'presets-failed': '读取模式列表失败',
    'preset-failed': '切换模式失败',
    'preset-locked': '这个会话已经跑过至少一轮，模式不能再改了',
    'preset-not-found': '没有这个模式',
    'preset-invalid': '这个模式当前不可用',
    'agent-not-live': '这个会话当前没有活动的 agent，暂时无法切换模式',
    'preset-service-unavailable': '宿主端模式服务不可用',
    'agent-service-unavailable': '宿主端 agent 服务不可用',
    'missing-provider': '请求缺少 provider',
    'missing-model': '请求缺少模型 id',
    'missing-preset': '请求缺少模式 id',
    'missing-question-id': '请求缺少问题 id',
    'question-not-found': '这个问题已经结束了',
    'question-settled': '这个问题已经被回答过了',
    'bad-answers': '答案格式不对，请重试',
    'empty-answer': '还有题目没作答',
    'answer-too-long': '自定义答案太长了',
    'no-questions': '这个问题没有可回答的题目'
  };

  /** 这些错误码必须把服务端透传的细节一并显示出来，否则排查只能靠猜。 */
  var UPSTREAM_CODES = {
    'prompt-failed': 1, 'cancel-failed': 1,
    'model-failed': 1, 'preset-failed': 1, 'models-failed': 1, 'presets-failed': 1
  };

  /** 把接口错误翻成人话：认识的错误码 → 文案；否则优先用服务端 message。 */
  function humanError(err) {
    if (!err) return '未知错误';
    var code = err.code || '';
    if (code && ERROR_TEXT[code]) {
      // 上游失败必须把服务端透传的细节带出来。否则这张文案表会把真正的报错吃掉：
      // 用户只看到"上游报错"四个字，而真正的原因（DSH 内部的 TypeError、
      // 或者 session/not-found 这类业务码）只留在调试面板里，排查只能靠猜。
      // err.upstream 是上游 RemoteError 的 code，没有就不显示。
      if (UPSTREAM_CODES[code] && err.detail) {
        return ERROR_TEXT[code] + '：' + (err.upstream ? '[' + err.upstream + '] ' : '') + err.detail;
      }
      return ERROR_TEXT[code];
    }
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

  /** POST JSON；错误体统一解析成 { status, code, detail }，交给 humanError 翻人话。 */
  function postJSON(url, payload) {
    return fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (res) {
      if (res.status === 401) {
        location.href = '/login';
        throw new Error('登录已失效');
      }
      return res.text().then(function (body) {
        var parsed = tryJson(String(body || '').trim());
        var value = parsed.ok && parsed.value && typeof parsed.value === 'object' ? parsed.value : {};
        if (!res.ok) {
          var err = new Error(String(value.message || value.error || ('HTTP ' + res.status)));
          err.status = res.status;
          err.code = String(value.error || '');
          err.detail = String(value.message || '');
          // 上游 RemoteError 的 code（服务端在 502 里透传），与 err.code（本插件自己的
          // 错误码，如 prompt-failed）是两回事，分开存。
          err.upstream = String(value.code || '');
          throw err;
        }
        return value;
      });
    });
  }

  /* ------------------------------ 会话列表 ------------------------------ */

  /* ------------------------- 折叠状态（localStorage） ------------------------- */

  /**
   * 某个工作区当前是否折叠。**默认折叠**：没记录过就是折叠。
   *
   * 只有显式点开过（存 '0'）才展开 —— 不能把"展开"也当成默认值，
   * 否则"用户展开过"和"从没记录"就分不开了，一刷新又弹回折叠。
   * localStorage 在隐私模式下会抛，所以整段包 try：存不下只是下次打开恢复默认折叠。
   */
  function isCollapsed(key) {
    if (Object.prototype.hasOwnProperty.call(state.collapsed, key)) return state.collapsed[key] === true;
    var value = true;
    try {
      if (global.localStorage) value = global.localStorage.getItem(collapseKey(key)) !== '0';
    } catch (err) { value = true; }
    state.collapsed[key] = value;
    return value;
  }

  /** 记录折叠状态并写回 localStorage（折叠存 '1'，展开存 '0'，都要显式落盘）。 */
  function setCollapsed(key, value) {
    state.collapsed[key] = !!value;
    try {
      if (!global.localStorage) return;
      global.localStorage.setItem(collapseKey(key), value ? '1' : '0');
    } catch (err) { /* 忽略 */ }
  }

  function loadSessions(autoEnter) {
    els.listError.hidden = true;
    els.btnRefresh.disabled = true;
    if (!state.listLoaded) {
      els.listHint.hidden = false;
      els.listHint.textContent = '正在载入会话…';
    }
    fetchJSON('/api/sessions').then(function (data) {
      var items = data && Array.isArray(data.items) ? data.items : [];
      // P3-A：优先用服务端的分组；万一响应里没有（版本不一致）就在本地兜一份
      var groups = data && Array.isArray(data.groups) ? data.groups : groupLocally(items);
      state.sessions = items;
      state.groups = groups;
      state.listLoaded = true;
      state.lastListAt = Date.now();
      els.listHint.hidden = true;
      renderSessions(groups);
      if (autoEnter && !state.autoEntered) {
        state.autoEntered = true;
        var target = null;
        for (var i = 0; i < items.length; i++) {
          // 列表已按 updatedAt 降序，第一条 running 就是最近更新的那个
          if (items[i] && items[i].running) { target = items[i]; break; }
        }
        if (target) openSession(target.id, groupedLabel(target));
      }
    }).catch(function (err) {
      els.listHint.hidden = true;
      els.listError.hidden = false;
      els.listErrorText.textContent = '载入会话失败：' + humanError(err);
    }).then(function () {
      els.btnRefresh.disabled = false;
    });
  }

  function renderSessions(groups) {
    els.list.textContent = '';
    var list = Array.isArray(groups) ? groups : [];
    var total = 0;
    for (var g = 0; g < list.length; g++) {
      total += Array.isArray(list[g].items) ? list[g].items.length : 0;
    }
    els.listEmpty.hidden = total > 0;
    if (!total) return;
    var frag = document.createDocumentFragment();
    for (var i = 0; i < list.length; i++) frag.appendChild(groupBlock(list[i]));
    els.list.appendChild(frag);
    staggerList();
  }

  /**
   * 会话列表错开进场。**只播一次**。
   *
   * 这个标志是必需的：renderSessions 每次都先 textContent='' 再整棵重建，
   * 而列表每 10 秒会重新拉一次 —— 若每回重建都重放动画，界面会一直闪。
   */
  var listStaggered = false;

  function staggerList() {
    if (listStaggered || reducedMotion()) return;
    var nodes = collectStagger(els.list, []);
    if (!nodes.length) return;          // 空列表不算"播过"，等真有会话再播
    listStaggered = true;
    for (var i = 0; i < nodes.length; i++) {
      // 延迟封顶：会话多时不能让最后一行排到一秒以后
      nodes[i].style.animationDelay = Math.min(i, 11) * 24 + 'ms';
      nodes[i].classList.add('list-in');
    }
  }

  /** 按文档顺序收集需要错开进场的节点（分组头与会话行）。 */
  function collectStagger(node, out) {
    var kids = node.childNodes || [];
    for (var i = 0; i < kids.length; i++) {
      var c = kids[i];
      if (c.nodeType !== 1) continue;
      var cl = c.classList;
      if (cl && (cl.contains('group-head') || cl.contains('session'))) out.push(c);
      collectStagger(c, out);
    }
    return out;
  }

  /** 一个工作区分组：可折叠的头 + 会话行。 */
  function groupBlock(group) {
    var g = group || {};
    var key = typeof g.key === 'string' ? g.key : '';
    var items = Array.isArray(g.items) ? g.items : [];

    var wrap = document.createElement('div');
    wrap.className = 'group' + (isCollapsed(key) ? ' collapsed' : '');

    var head = document.createElement('button');
    head.type = 'button';
    head.className = 'group-head';

    var caret = document.createElement('span');
    caret.className = 'group-caret';
    caret.textContent = '▼';

    var name = document.createElement('span');
    name.className = 'group-name';
    name.textContent = g.name || '无工作区';

    var count = document.createElement('span');
    count.className = 'group-count';
    count.textContent = String(items.length);

    var path = document.createElement('span');
    path.className = 'group-path';
    path.textContent = g.path ? shortPath(g.path) : '';

    head.appendChild(caret);
    head.appendChild(name);
    head.appendChild(count);
    head.appendChild(path);
    if (g.running) {
      var dot = document.createElement('span');
      dot.className = 'dot on';
      head.appendChild(dot);
    }
    head.addEventListener('click', function () {
      var next = !isCollapsed(key);
      setCollapsed(key, next);
      wrap.className = 'group' + (next ? ' collapsed' : '');
    });

    var body = document.createElement('div');
    body.className = 'group-body';
    var ordered = orderWithChildren(items);
    for (var i = 0; i < ordered.length; i++) body.appendChild(sessionRow(ordered[i]));

    wrap.appendChild(head);
    wrap.appendChild(body);
    return wrap;
  }

  /**
   * 判断一条会话是不是子智能体。
   *
   * `mirror.js` 的 `normalizeSummary()` 把 DSH 的 `origin` 和 `parentSessionId`
   * 原样透传出来了，两个判据任一命中就算 —— 宁可多标，不可漏标。
   */
  function isSubagentItem(item) {
    if (!item) return false;
    if (item.origin === 'subagent') return true;
    return !!item.parentSessionId;
  }

  /**
   * 把子会话排到它的父会话后面。
   *
   * 服务端已经按 updatedAt 排好序了，这里**只做插入**：父会话留在原位，它的子会话
   * 紧跟其后，其它会话的相对顺序一概不动。
   *
   * 结尾那个兜底循环是刻意的：父会话不在本组（跨工作区）、父链缺失、或者出现环，
   * 都不能让任何一条会话从列表里消失 —— 宁可位置不对，也不能丢。
   */
  function orderWithChildren(items) {
    var list = Array.isArray(items) ? items : [];
    var present = {};
    for (var i = 0; i < list.length; i++) present[String((list[i] && list[i].id) || '')] = true;

    var kids = {};
    var tops = [];
    for (var j = 0; j < list.length; j++) {
      var it = list[j];
      var pid = it && it.parentSessionId ? String(it.parentSessionId) : '';
      if (pid && present[pid] && pid !== String(it.id || '')) {
        if (!kids[pid]) kids[pid] = [];
        kids[pid].push(it);
      } else {
        tops.push(it);
      }
    }

    var out = [];
    for (var k = 0; k < tops.length; k++) {
      out.push(tops[k]);
      var mine = kids[String((tops[k] && tops[k].id) || '')];
      if (mine) for (var m = 0; m < mine.length; m++) out.push(mine[m]);
    }
    for (var q = 0; q < list.length; q++) if (out.indexOf(list[q]) === -1) out.push(list[q]);
    return out;
  }

  function sessionRow(item) {
    var id = item && item.id ? String(item.id) : '';
    var child = isSubagentItem(item);
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'session' + (child ? ' session-child' : '');

    var dot = document.createElement('span');
    dot.className = 'dot' + (item && item.running ? ' on' : '');

    var main = document.createElement('span');
    main.className = 'session-main';

    var title = document.createElement('span');
    title.className = 'session-title';
    title.textContent = groupedLabel(item);

    var sub = document.createElement('span');
    sub.className = 'session-sub';
    sub.textContent = sessionSubtitle(item);

    main.appendChild(title);

    var tags = [];
    // P3-D 的角标放最前：它是唯一"需要你动手"的状态
    if (item && item.pendingQuestion) tags.push({ text: '待回答', cls: 'tag tag-ask' });
    if (child) tags.push({ text: '子智能体', cls: 'tag tag-sub' });
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
    // 相对时间挂在行右端（不在 .session-main 里）—— 和 DeepSeek 列表一样：标题在左、时间在右
    if (sub.textContent) btn.appendChild(sub);
    btn.addEventListener('click', function () { openSession(id, groupedLabel(item)); });
    return btn;
  }

  /* ------------------------------ 视图切换 ------------------------------ */

  function openSession(id, title) {
    if (!id) return;
    state.sessionId = String(id);
    state.sessionTitle = title || '';
    state.autoEntered = true;
    // 换会话：清掉上一个会话的提问与草稿。问题本身留在服务端，重新进这个会话时会
    // 从 /api/questions 拉回来，所以这里清掉不会丢东西。
    state.question = null;
    state.questionDraft = {};
    state.questionNote = '';
    setView('chat');
    resetStream();
    renderChatHeader();
    renderQuestionCard();
    connect();
    // 懒加载模型目录与模式清单（都有缓存，切会话不会反复拉）。
    // 这两个都是"锦上添花"的数据：拿不到时头部只是显示得朴素一点，功能不受影响。
    // 它们失败时会 re-throw（因为选择面板要靠这个错误在面板里给出提示），
    // 所以这里必须自己吞掉 —— 否则就是一个未处理的 Promise 拒绝。
    loadCatalog().catch(function () { /* 已在 pushDebug 里记过 */ });
    loadPresets().catch(function () { /* 已在 pushDebug 里记过 */ });
    // 补一次待答问题：提问可能在这个会话被打开之前就来了
    refreshQuestions();
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
    state.sub = {
      cwd: '', preset: '', presetLabel: '', model: '', modelLabel: '',
      provider: '', reasoningEffort: '', canSwitchPreset: true
    };
    // 换会话：把"发送中"气泡从 DOM 上摘掉（流已经清了），但队列和 requestId 都留着 ——
    // 失败后重进同一个会话再发，仍然要复用同一个 id（幂等规则见 requestIdFor）。
    // 计时器也留着：已受理但没等到回显的条目到点会自己收掉。
    var list = pendingList();
    for (var i = 0; i < list.length; i++) list[i].el = null;
    state.sendingId = null;
    els.stream.textContent = '';
    els.btnBottom.hidden = true;
    showTopHint('');
    els.connBanner.hidden = true;
    buildRail();   // 流清空了，刻度也一起清掉
  }

  function isRunning() {
    return !!state.attemptId || state.activeTurn !== null || !!(state.live && state.live.el);
  }

  /** 从已载入的列表里找一条会话。 */
  function sessionById(id) {
    var list = Array.isArray(state.sessions) ? state.sessions : [];
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].id === id) return list[i];
    }
    return null;
  }

  /**
   * 从快照头 + 投影推导头部要显示的东西。
   *
   * 两个曾经的坑都在这里收口：
   *
   * 1) 模式必须读 `projections.agentPreset`，不能读 `header.agentPreset`。创建头部记的是
   *    会话**开始时**的模式、而且被深冻结（DSH 源码注释原文："The creation header names
   *    the preset a session STARTED with, and it is deep-frozen because that is a creation
   *    fact"）；会话在还是空白的时候可以换模式，那次变更只落在 `agent-preset/selected`
   *    事件里。DSH 自己的重建逻辑也写明 "Reconstruction reads the `agentPreset` Session
   *    projection, never the header alone"。之前读 header，于是创造模式的会话在手机上
   *    显示成 "standard"。
   *
   * 2) 模型要读 `projections.modelSelection.next`。该投影的 view 定义是
   *    `{ lastUsed, next: state.pending ?? state.lastUsed }`，所以 `next` 就是"下一次请求
   *    会用的模型"，正是该显示的那个。之前读的是 `proj.model`，而这个投影的键叫
   *    `modelSelection` —— 字段名对不上，芯片永远是空的。
   *
   * @param header - 快照的 header。
   * @param proj - 快照的 projections.values。
   * @param fallback - 兜底的 `{provider, model}`，通常来自最新一条 request/header 事件。
   * @returns 头部用的 sub 对象。
   */
  function deriveSub(header, proj, fallback) {
    var h = header && typeof header === 'object' ? header : {};
    var presetId = activePreset(proj, header);
    var pick = selectionOf(proj, fallback, state.catalog);

    // 模式能不能换：只有从没跑过轮次的会话可以。blank 是 DSH 自己的判据；
    // 拿不到时保守放行，交给服务端的 agent-preset/locked 去拦。
    var row = sessionById(state.sessionId);
    var canSwitch = !(row && row.blank === false);

    return {
      cwd: typeof h.cwd === 'string' ? h.cwd : '',
      preset: presetId,
      presetLabel: presetDisplay(presetId, state.presets),
      provider: pick.provider,
      model: pick.model,
      modelLabel: modelDisplay(pick.provider, pick.model, state.catalog),
      reasoningEffort: pick.reasoningEffort,
      canSwitchPreset: canSwitch
    };
  }

  /**
   * 重画对话头部。
   *
   * P3 起头部多了两枚可点的芯片（模式 / 模型）。它们只出现在对话页 ——
   * 列表行里不显示模型：一行放不下，而且换模型本来就该是"进了会话再决定"的动作。
   */
  /** 上一次渲染标题时的会话 id —— 用来判断"是不是换会话了"。 */
  var headerSession = null;

  function renderChatHeader() {
    els.chatTitle.textContent = state.sessionTitle || '会话';
    // 换会话时让标题淡入一次。只在会话真的变了时才播：renderChatHeader 在每轮
    // 开始/结束时都会被调，每次都播会很吵。
    if (headerSession !== state.sessionId) {
      headerSession = state.sessionId;
      els.chatTitle.classList.remove('title-in');
      void els.chatTitle.offsetWidth;      // 强制重排，否则摘了再加不会重播动画
      els.chatTitle.classList.add('title-in');
    }
    var running = isRunning();
    els.chatDot.className = 'dot' + (running ? ' on' : '');
    // 停止按钮只在运行中出现
    if (els.btnStop) els.btnStop.hidden = !running;

    els.chatSub.textContent = '';
    var text = document.createElement('span');
    text.className = 'sub-text';
    var parts = [running ? '运行中' : '空闲'];
    if (state.sub.cwd) parts.push(pathTail(state.sub.cwd) || state.sub.cwd);
    text.textContent = parts.join(' · ');
    els.chatSub.appendChild(text);

    // 模式芯片：会话开跑之后就锁死了（DSH 的规则），那时置灰并说明原因
    if (state.sub.preset) {
      var presetLocked = !state.sub.canSwitchPreset;
      var presetChip = document.createElement('button');
      presetChip.type = 'button';
      presetChip.className = 'chip';
      presetChip.textContent = state.sub.presetLabel || state.sub.preset;
      presetChip.disabled = presetLocked || !CONFIG.enablePrompt;
      presetChip.title = presetLocked
        ? '已开始的会话不能改模式'
        : (CONFIG.enablePrompt ? '切换模式' : '手机端写操作已关闭（enablePrompt=false）');
      presetChip.addEventListener('click', openPresetSheet);
      els.chatSub.appendChild(presetChip);
    }

    // 模型芯片：任何会话都能换，对下一次请求生效（正在跑的那一轮不受影响）
    if (state.sub.model) {
      var modelChip = document.createElement('button');
      modelChip.type = 'button';
      modelChip.className = 'chip';
      modelChip.textContent = state.sub.modelLabel || state.sub.model;
      modelChip.disabled = !CONFIG.enablePrompt;
      modelChip.title = CONFIG.enablePrompt ? '切换模型' : '手机端写操作已关闭（enablePrompt=false）';
      modelChip.addEventListener('click', openModelSheet);
      els.chatSub.appendChild(modelChip);
    }
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

    var records = Array.isArray(snap.records) ? snap.records.slice() : [];
    records.sort(bySeq);

    // 投影里没有 modelSelection 时（比如 cached 提示还没算出来），退回最新一条
    // request/header 的 config —— 那是这个会话实际用过的模型。
    var lastHeader = null;
    for (var r = records.length - 1; r >= 0; r--) {
      if (records[r] && records[r].type === 'request/header') { lastHeader = records[r]; break; }
    }
    state.sub = deriveSub(header, proj, lastHeader && lastHeader.data ? lastHeader.data : null);

    // 重建期间关掉"新消息"进场动画：一次插入几十条，逐条淡入会变成一屏乱动。
    // 用 try/finally 保证渲染中途抛错也不会把标志留在 true 上。
    state.replaying = true;
    try {
      for (var i = 0; i < records.length; i++) appendEvent(records[i], el);
    } finally {
      state.replaying = false;
    }
    if (records.length) {
      var first = num(records[0].seq);
      if (first !== null) state.oldestSeq = first;
    }

    var cursor = num(snap.cursor);
    if (cursor !== null) state.maxSeq = Math.max(state.maxSeq, cursor);
    state.hasMore = !!snap.hasMore;

    // 重建把"发送中"气泡一起冲掉了：snapshot 里已经出现的消息就当回显到了
    // （逐条按"顺序 + 文本"配对），剩下的稍后由 pinTail() 挂回末尾继续等。
    reconcilePending(records);

    // 重放"正在输出中"的临时气泡
    var info = snap.assistantStream;
    var attempt = info && typeof info === 'object' ? info.activeAttempt : null;
    if (attempt && typeof attempt === 'object') {
      state.attemptId = attempt.attemptId ? String(attempt.attemptId) : 'active';
      var frames = Array.isArray(attempt.stream) ? attempt.stream : [];
      for (var f = 0; f < frames.length; f++) applyStreamFrame(frames[f], gen, true);
    }

    pinTail();
    renderChatHeader();
    if (state.stick) stickToBottom(false);
    else el.scrollTop = Math.max(0, el.scrollHeight - keepFromBottom);
    buildRail();   // 快照重建完立刻排一次刻度（这里必须同步：首屏就要能看到）
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
    var type = String(ev.type || '');
    var data = ev.data && typeof ev.data === 'object' ? ev.data : null;

    // P3：会话中途换模式 / 换模型 —— 头部芯片要跟着变。
    // 这两类事件不渲染成消息，只更新头部，所以在这里就地处理完就返回。
    if (type === 'agent-preset/selected') {
      if (data && typeof data.agentPreset === 'string' && data.agentPreset) {
        state.sub.preset = data.agentPreset;
        state.sub.presetLabel = presetDisplay(data.agentPreset, state.presets);
        renderChatHeader();
      }
      return;
    }
    if (type === 'model/selection') {
      if (data && typeof data.model === 'string' && data.model) {
        state.sub.provider = typeof data.provider === 'string' ? data.provider : '';
        state.sub.model = data.model;
        state.sub.modelLabel = modelDisplay(state.sub.provider, data.model, state.catalog);
        state.sub.reasoningEffort = typeof data.reasoningEffort === 'string' ? data.reasoningEffort : '';
        renderChatHeader();
      }
      return;
    }

    appendEvent(ev, els.stream);
    // 真正的 user/message 到了：按发送顺序消掉本会话最老的那个"发送中"气泡
    // （一次只发一条时，"下一条"就是它；排队时可能同时挂着好几条）
    if (String(ev.type) === 'user/message') shiftPending();
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
      // 系统提示 / 开发者消息 / 注入的 user/message 都由宿主侧的 projectEvent
      // 直接丢掉了，根本到不了这里（见 lib/mirror.js 的 isInjectedUserMessage）。
      // step/start、step/end 不做独立大块；request/* 只在调试视图里看；未知类型直接忽略
      default: return null;
    }

    if (!node) return null;
    host.appendChild(node);
    // 只给实时新增的节点加进场动画。两类情况不加：
    //   1. 快照重建（state.replaying）—— 一次几十条，逐条淡入会一屏乱动；
    //   2. 往上翻历史（target 是 DocumentFragment，不是 els.stream）—— 同理。
    if (host === els.stream && !state.replaying) node.classList.add('msg-in');
    // "正在输出"和"发送中"两个临时气泡永远保持在末尾
    if (host === els.stream) {
      pinTail();
      // 新消息会推着后面所有刻度的比例变，得重排；防抖见 scheduleRail
      scheduleRail();
    }
    return node;
  }

  /** 把临时气泡重新压到消息流末尾（live 在前，待回显的按发送顺序排在后）。 */
  function pinTail() {
    if (state.live && state.live.el) els.stream.appendChild(state.live.el);
    var list = pendingList();
    for (var i = 0; i < list.length; i++) {
      if (list[i].el) els.stream.appendChild(list[i].el);
    }
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
    var info = turnEndText(data ? data.reason : '', data);
    var el = document.createElement('div');
    el.className = 'turn-end' + (info.warn ? ' warn' : '') + (info.failed ? ' failed' : '');

    var line = document.createElement('div');
    line.className = 'turn-end-text';
    line.textContent = info.text;
    el.appendChild(line);
    if (info.meta) {
      var meta = document.createElement('div');
      meta.className = 'turn-end-meta';
      meta.textContent = info.meta;
      el.appendChild(meta);
    }

    // 失败要弹 toast：SSE 是按会话连的，用户如果停在会话列表页，
    // 光在聊天流里插一行他是看不到的。
    // **只在实时事件上弹** —— 快照重放时（state.replaying）会把历史错误也重播一遍，
    // 那样每次打开会话都会为几天前的一次失败弹窗。
    if (info.failed && !state.replaying) showToast(info.text, 6000);

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
    // 用 block-chip 而不是 chip：.chip 是顶栏的模式/模型芯片，两条规则曾经同名，
    // 后定义的那条把所有重叠属性都覆盖掉了，消息里的块芯片其实一直长着顶栏芯片的样子。
    el.className = 'block-chip block-chip-' + info.kind;
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

  /* ------------------------- 代码块头部条（语言 + 复制） ------------------------- */

  /**
   * 复制文本。两条路都兜住：
   *   1. 老浏览器根本没有 navigator.clipboard；
   *   2. 非安全上下文（http://）下 writeText 存在但会 reject。
   * 所以失败时退回到 textarea + execCommand 的老办法。
   */
  function copyText(text, done) {
    function viaTextarea() {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', 'readonly');
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      var ok = false;
      try {
        ta.select();
        if (ta.setSelectionRange) ta.setSelectionRange(0, ta.value.length);
        ok = document.execCommand('copy');
      } catch (e) {
        ok = false;
      }
      document.body.removeChild(ta);
      done(ok);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, viaTextarea);
    } else {
      viaTextarea();
    }
  }

  /** 复制键：点一下复制 getText() 的返回值，并在原地给出成功/失败反馈。 */
  function copyButton(label, getText) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'copy-btn';
    btn.textContent = label;
    btn.addEventListener('click', function () {
      copyText(getText() || '', function (ok) {
        btn.textContent = ok ? '已复制' : '复制失败';
        if (ok) btn.classList.add('done');
        setTimeout(function () {
          btn.textContent = label;
          btn.classList.remove('done');
        }, 1200);
      });
    });
    return btn;
  }

  /**
   * 给容器里每个 `pre.md-code` 套一层头部条（语言名 + 复制键）。
   *
   * 这是全站 markdown 落地的**唯一**接缝：renderMarkdown() 在 app.js 里只被
   * renderBlocksInto 调用一次，所以在这里加一遍就同时覆盖了助手消息、工具结果、
   * 翻历史三条路径。
   *
   * 流式气泡（live-text）走的是纯文本、不渲染 markdown，所以不用管它 ——
   * 最终消息到达时会把整个临时气泡替换掉。
   */
  function decorateCodeBlocks(container) {
    if (!container || !container.querySelectorAll) return container;
    var pres = container.querySelectorAll('pre.md-code');
    for (var i = 0; i < pres.length; i++) {
      var pre = pres[i];
      // 已经包过就别再包一层（同一个容器可能被重复渲染）
      if (pre.parentNode && pre.parentNode.className === 'code-block') continue;
      var box = document.createElement('div');
      box.className = 'code-block';
      var head = document.createElement('div');
      head.className = 'code-head';
      var lang = document.createElement('span');
      lang.className = 'code-lang';
      // 没有语言信息时给个占位，免得头部条空一半
      lang.textContent = pre.getAttribute('data-lang') || '代码';
      head.appendChild(lang);
      head.appendChild(copyButton('复制', function (p) {
        return function () { return p.textContent || ''; };
      }(pre)));
      box.appendChild(head);
      if (pre.parentNode) pre.parentNode.insertBefore(box, pre);
      box.appendChild(pre);
    }
    return container;
  }

  // DOM 测试用：假 DOM 的 insertAdjacentHTML 不解析 HTML，markdown 不会变成
  // 真实元素，所以测试直接拿这个函数喂一个手搭的容器。浏览器里是空操作。
  if (typeof module !== 'undefined' && module.exports) {
    module.exports.decorateCodeBlocks = decorateCodeBlocks;
    module.exports.copyText = copyText;
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
    decorateCodeBlocks(container);
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

  /** 助手消息的纯文本（只取 text 块，不含思考过程与工具调用）—— 复制键复制的就是它。 */
  function assistantPlainText(data) {
    var blocks = data && Array.isArray(data.blocks) ? data.blocks : [];
    var parts = [];
    for (var i = 0; i < blocks.length; i++) {
      var b = blocks[i];
      if (b && b.type === 'text' && typeof b.text === 'string' && b.text) parts.push(b.text);
    }
    return parts.join('\n\n');
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
    // 复制键：只复制正文，和 DeepSeek 那个"复制"一致（不带思考过程和工具调用）。
    // 没有任何正文时（比如纯工具调用的一轮）就不显示，免得点了复制到空字符串。
    var plain = assistantPlainText(data);
    if (plain) meta.appendChild(copyButton('复制', function () { return plain; }));
    if (meta.firstChild) wrap.body.appendChild(meta);

    renderChatHeader();
    return wrap.el;
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
      generic.className = 'block-chip';
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
    // 刻度条跟着滚动走：高亮"离视口中线最近"的那句
    updateRailActive();
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
    // 补了历史，整条流的比例都变了：刻度要整条重排
    buildRail();
  }

  /* ------------------------------ 右侧快捷跳转刻度条 ------------------------------ */

  /**
   * 我自己的消息（跳过"发送中 / 失败待重试"的气泡）。
   *
   * 只标用户消息：助手每轮都说一大段，全都标出来等于没标；而"回头找我说的那句"
   * 才是真正高频的动作。待回显的气泡在 records 里还没落定，位置随后会跳一次，
   * 给它打刻度只会闪一下，所以也排除。
   */
  function railTargets() {
    var out = [];
    if (!els.stream || typeof els.stream.querySelectorAll !== 'function') return out;
    var nodes = els.stream.querySelectorAll('.me');
    for (var i = 0; i < nodes.length; i++) {
      var cls = ' ' + String(nodes[i].className || '') + ' ';
      if (cls.indexOf(' pending ') >= 0 || cls.indexOf(' failed ') >= 0) continue;
      out.push(nodes[i]);
    }
    return out;
  }

  /** 元素中点占整条流的比例（0~1）。拿不到布局信息时退化到顶部，不会算出 NaN。 */
  function railRatio(el, total) {
    var top = typeof el.offsetTop === 'number' ? el.offsetTop : 0;
    var h = typeof el.offsetHeight === 'number' ? el.offsetHeight : 0;
    var r = (top + h / 2) / (total || 1);
    if (!isFinite(r)) return 0;
    return Math.max(0, Math.min(1, r));
  }

  /** 整条重建。少于两句就不显示 —— 一句的时候刻度条没有意义，只会挡视线。 */
  function buildRail() {
    if (!els.rail) return;
    var targets = railTargets();
    if (targets.length < RAIL_MIN) {
      els.rail.hidden = true;
      els.rail.textContent = '';
      hideRailTip();
      state.railTicks = [];
      state.railActive = -1;
      return;
    }
    els.rail.textContent = '';
    hideRailTip();
    state.railTicks = [];
    state.railActive = -1;
    var total = els.stream.scrollHeight || 1;
    for (var i = 0; i < targets.length; i++) {
      var tick = document.createElement('button');
      tick.className = 'rail-tick';
      tick.type = 'button';
      tick.style.top = (railRatio(targets[i], total) * 100).toFixed(2) + '%';
      tick.setAttribute('aria-label', '跳到我说的第 ' + (i + 1) + ' 句');
      railBindTick(tick, i);
      els.rail.appendChild(tick);
      state.railTicks.push({ el: tick, target: targets[i] });
    }
    els.rail.hidden = false;
    updateRailActive();
  }

  /**
   * 实时流每追加一条就重排一次刻度。这里做 120ms 防抖：助手正在输出时
   * 事件是连续来的，每来一条就重建一遍 DOM 会白烧手机的电。
   */
  function scheduleRail() {
    if (state.railTimer) return;
    state.railTimer = setTimeout(function () {
      state.railTimer = null;
      buildRail();
    }, 120);
  }

  function railBindTick(tick, index) {
    tick.addEventListener('click', function () { railJump(index); });
    // 按住先看内容再松手跳：手机上盲跳一条刻度很容易跳错
    tick.addEventListener('pointerdown', function () { railPreview(index); });
    tick.addEventListener('pointerup', hideRailTip);
    tick.addEventListener('pointercancel', hideRailTip);
    tick.addEventListener('pointerleave', hideRailTip);
  }

  function railPreview(index) {
    if (!els.railTip) return;
    var tick = state.railTicks[index];
    if (!tick) return;
    els.railTip.textContent = railSnippet(tick.target);
    els.railTip.hidden = false;
  }

  function hideRailTip() {
    if (els.railTip) els.railTip.hidden = true;
  }

  /** 预览文字：气泡里的纯文本，压掉换行，太长截断。 */
  function railSnippet(el) {
    var text = '';
    try { text = String((el && el.textContent) || ''); } catch (e) { text = ''; }
    text = text.replace(/\s+/g, ' ').trim();
    if (!text) return '（空消息）';
    return text.length > 60 ? text.slice(0, 60) + '…' : text;
  }

  function markRailActive(index) {
    for (var i = 0; i < state.railTicks.length; i++) {
      var el = state.railTicks[i].el;
      if (!el || !el.classList) continue;
      if (i === index) el.classList.add('on');
      else el.classList.remove('on');
    }
  }

  /** 视口中线落在哪两条消息之间 → 高亮最近的那条刻度。滚动时调用。 */
  function updateRailActive() {
    if (!state.railTicks || !state.railTicks.length) return;
    var view = (els.stream.scrollTop || 0) + (els.stream.clientHeight || 0) / 2;
    var best = 0;
    var bestD = Infinity;
    for (var i = 0; i < state.railTicks.length; i++) {
      var t = state.railTicks[i].target;
      var top = typeof t.offsetTop === 'number' ? t.offsetTop : 0;
      var h = typeof t.offsetHeight === 'number' ? t.offsetHeight : 0;
      var d = Math.abs(top + h / 2 - view);
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best === state.railActive) return;
    state.railActive = best;
    markRailActive(best);
  }

  function railJump(index) {
    var tick = state.railTicks[index];
    if (!tick) return;
    hideRailTip();
    var target = tick.target;
    var top = Math.max(0, (typeof target.offsetTop === 'number' ? target.offsetTop : 0) - 12);
    // 跳过去是"回头看"，别让贴底逻辑立刻把我拽回最新
    state.stick = false;
    els.btnBottom.hidden = false;
    state.scrollLock = Date.now() + 700;
    if (!reducedMotion() && typeof els.stream.scrollTo === 'function') {
      try {
        els.stream.scrollTo({ top: top, behavior: 'smooth' });
      } catch (e) {
        els.stream.scrollTop = top;   // 老浏览器不认参数对象
      }
    } else {
      els.stream.scrollTop = top;     // 开了"减少动效"就直接跳，别滑
    }
    state.railActive = index;
    markRailActive(index);
    hitTarget(target);
    setTimeout(function () {
      state.scrollLock = 0;
      onStreamScroll();
    }, 720);
  }

  /** 目标气泡闪一下，让眼睛知道"到了"。只加类，动画在 CSS 里（只动 transform/opacity）。 */
  function hitTarget(el) {
    if (!el || !el.classList || reducedMotion()) return;
    el.classList.remove('jump-hit');
    // 读一次布局属性强制刷新：连着点同一个目标时，不然动画不会重播
    if (typeof el.offsetWidth === 'number') { void el.offsetWidth; }
    el.classList.add('jump-hit');
    if (state.jumpTimer) clearTimeout(state.jumpTimer);
    state.jumpTimer = setTimeout(function () {
      state.jumpTimer = null;
      el.classList.remove('jump-hit');
    }, 520);
  }

  /* ------------------------------ 发送 / 停止 ------------------------------ */

  var COMPOSER_MAX_PX = 158;   // 与 app.css 里 textarea 的 max-height 一致：6 行 × 22.4 + padding 22 + 边框 2
  var COMPOSER_BORDER = 2;     // 上下各 1px 边框，box-sizing:border-box 下要补回来
  var PENDING_TIMEOUT_MS = 15000;   // 每个待回显条目各自计时，不存在全局计时器
  var PENDING_MAX = 50;             // 待回显队列上限（失败条目会留着等重试，需要封顶）

  /** textarea 自动增高，超过上限就内部滚动。 */
  function autoGrow() {
    var el = els.composerInput;
    if (!el || !el.style) return;
    el.style.height = 'auto';
    var next = num(el.scrollHeight);
    if (next === null || next <= 0) next = 44;
    if (next > COMPOSER_MAX_PX) {
      el.style.height = COMPOSER_MAX_PX + 'px';
      el.style.overflowY = 'auto';
    } else {
      el.style.height = (next + COMPOSER_BORDER) + 'px';
      el.style.overflowY = 'hidden';
    }
  }

  /** 发送按钮可用性 + 字数提示。 */
  function updateSendState() {
    var raw = els.composerInput ? els.composerInput.value : '';
    var counter = counterText(raw);
    if (els.composerCount) {
      els.composerCount.hidden = !counter.text;
      els.composerCount.textContent = counter.text;
      els.composerCount.classList.toggle('over', counter.over);
    }
    if (els.composerSend) {
      els.composerSend.disabled = !!state.sendingId || !!promptTextError(raw);
    }
  }

  /**
   * 发送按钮的一次性反馈：成功后扩散一圈光环，失败后左右抖一下。
   * 类必须用完就摘 —— 留着的话下次加同名类不会重播动画。
   */
  function flashSend(kind) {
    var el = els.composerSend;
    if (!el || reducedMotion()) return;
    el.classList.remove(kind);
    void el.offsetWidth;              // 强制重排，否则连续两次同类不会重播
    el.classList.add(kind);
    setTimeout(function () { el.classList.remove(kind); }, 600);
  }

  /** 手机端 Enter 必须换行（不抢 Enter）；桌面端 Ctrl/⌘+Enter 才发送。 */
  function onComposerKey(ev) {
    if (!ev || ev.key !== 'Enter' || !(ev.ctrlKey || ev.metaKey)) return;
    ev.preventDefault();
    sendPrompt();
  }

  /* --- 待回显队列：每条消息一个条目，各管各的气泡 --- */

  function pendingList() {
    if (!Array.isArray(state.pending)) state.pending = [];
    return state.pending;
  }

  function pendingIndexOf(requestId) {
    var list = pendingList();
    for (var i = 0; i < list.length; i++) {
      if (list[i].requestId === requestId) return i;
    }
    return -1;
  }

  /**
   * 队列清理：失败的条目会一直留着（供重试复用 id），所以要防止它无限膨胀。
   * - 同一会话 + 同一文本只留最新那条失败条目（老的留着也没用，id 已经会被复用）；
   * - 总数超上限时，从最老的失败条目开始丢（等回显的条目一个都不能丢）。
   * 失败条目没有气泡、没有计时器，直接 splice 是安全的。
   */
  function prunePending() {
    var list = pendingList();
    var seen = {};
    for (var i = list.length - 1; i >= 0; i--) {
      var e = list[i];
      if (!e.failed) continue;
      var key = e.sessionId + '\u0000' + e.text;
      if (seen[key]) { list.splice(i, 1); continue; }
      seen[key] = true;
    }
    while (list.length > PENDING_MAX) {
      var victim = -1;
      for (var j = 0; j < list.length; j++) {
        if (list[j].failed) { victim = j; break; }
      }
      if (victim < 0) break;
      list.splice(victim, 1);
    }
  }

  function isPending(requestId) {
    return pendingIndexOf(requestId) >= 0;
  }

  /** 摘掉一个条目（连同它的气泡和计时器）。返回被摘掉的条目或 null。 */
  function dropPending(requestId) {
    var list = pendingList();
    var i = pendingIndexOf(requestId);
    if (i < 0) return null;
    var entry = list.splice(i, 1)[0];
    if (entry.el && entry.el.parentNode) entry.el.parentNode.removeChild(entry.el);
    if (entry.timer) { clearTimeout(entry.timer); entry.timer = null; }
    updateSendState();
    return entry;
  }

  /**
   * 收到真实回显：按发送顺序消掉本会话最老的那个"还在等回显"的条目。
   * - 只看本会话：别的会话挂着的条目不该被这里的事件吃掉。
   * - 跳过发送失败的条目（它们没在等回显，只是留着 requestId 供重试复用），
   *   否则 B 的回显会把 A 的失败条目吃掉，B 自己的气泡反而成了孤儿。
   */
  function shiftPending() {
    var list = pendingList();
    for (var i = 0; i < list.length; i++) {
      if (list[i].sessionId === state.sessionId && !list[i].failed) {
        return dropPending(list[i].requestId);
      }
    }
    return null;
  }

  /** snapshot 重建后对账：records 里已经出现的消息，对应的待回显条目就不该再挂着。 */
  function reconcilePending(records) {
    var list = pendingList();
    var waiting = [];
    var texts = [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].failed) continue;   // 失败待重试的条目不在等回显
      waiting.push(list[i]);
      texts.push(list[i].text);
    }
    if (!waiting.length) return;
    var hits = matchPendingAgainstRecords(records, texts);
    for (var h = hits.length - 1; h >= 0; h--) {
      var entry = waiting[hits[h]];
      if (entry) dropPending(entry.requestId);
    }
  }

  /**
   * 取这次发送要用的 requestId —— 幂等规则就在这里，别改坏：
   *
   *   同一个 requestId 只代表"同一条文本的一次逻辑发送"。服务端按 requestId 去重，
   *   所以重试必须复用同一个 id，否则会真的重复发一条。
   *   只有两种情况才换新 id：
   *     ① 上一次已经发送成功（条目被回显消掉，队列里已经没有它）；
   *     ② 用户改动了文本内容（与队列里那条的 text 不一致）。
   *   会话换了也必须换新 id（同一个 id 不能跨会话用）。
   *
   *   只认"发送失败待重试"的条目（failed=true）：已经发成功、只是在等回显的条目
   *   绝不能复用 id，否则第二条会被服务端当成重复丢掉。
   *   复用时要顺手把那条旧条目摘掉，不然队列里会出现两个同 id 的条目、回显会错位。
   */
  function requestIdFor(text) {
    var list = pendingList();
    for (var i = list.length - 1; i >= 0; i--) {
      var e = list[i];
      if (!e.failed || !e.requestId) continue;
      if (e.text !== text || e.sessionId !== state.sessionId) continue;
      if (e.el && e.el.parentNode) e.el.parentNode.removeChild(e.el);
      if (e.timer) { clearTimeout(e.timer); e.timer = null; }
      list.splice(i, 1);
      return e.requestId;
    }
    return newRequestId(typeof crypto !== 'undefined' ? crypto : null);
  }

  /** 乐观回显用的"发送中"气泡。 */
  function pendingBubble(text) {
    var wrap = msgWrap('me pending');
    var bubble = document.createElement('div');
    bubble.className = 'bubble';
    var p = document.createElement('div');
    p.className = 'plain';
    p.textContent = text;
    bubble.appendChild(p);
    var meta = document.createElement('div');
    meta.className = 'meta';
    var label = document.createElement('span');
    label.className = 'pending-label';
    label.textContent = '发送中…';
    meta.appendChild(label);
    wrap.body.appendChild(bubble);
    wrap.body.appendChild(meta);
    return wrap.el;
  }

  /** 发送成功但一直没等到 user/message 时的兜底（排队时可能只是还在等当前轮跑完）。 */
  function armPendingTimeout(entry) {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(function () {
      entry.timer = null;
      if (!isPending(entry.requestId)) return;
      var sameSession = entry.sessionId === state.sessionId;
      dropPending(entry.requestId);   // 已经受理了，安静收掉，别让"发送中"永远挂着
      if (sameSession) {
        showToast('已受理，但还没出现在对话里 —— 如果会话正在忙，要等当前轮结束', 6000);
      }
    }, PENDING_TIMEOUT_MS);
  }

  /** 发送失败：文本塞回输入框，条目留在队列里等重试复用它的 requestId。 */
  function restoreText(text) {
    els.composerInput.value = text;
    autoGrow();
  }

  /** 发送一条纯文本消息。 */
  function sendPrompt() {
    if (!CONFIG.enablePrompt || state.sendingId) return;
    if (!state.sessionId) return;
    var text = normalizePromptText(els.composerInput.value);
    var bad = promptTextError(text);
    if (bad) {
      showToast(ERROR_TEXT[bad] || bad);
      return;
    }

    var requestId = requestIdFor(text);
    var entry = {
      requestId: requestId, text: text, sessionId: state.sessionId,
      el: pendingBubble(text), failed: false, timer: null
    };
    state.sendingId = requestId;
    pendingList().push(entry);
    prunePending();
    els.stream.appendChild(entry.el);
    els.composerInput.value = '';
    autoGrow();
    updateSendState();
    if (state.stick) stickToBottom(false);

    var tz = timeZoneOf(typeof Intl !== 'undefined' ? Intl : null);
    postJSON('/api/prompt', buildPromptPayload(state.sessionId, requestId, text, tz))
      .then(function (res) {
        flashSend('pulse');
        if (state.sendingId === requestId) state.sendingId = null;
        // 可能已经被 user/message 事件抢先收尾了
        if (!isPending(requestId)) { updateSendState(); return; }
        updateSendState();
        armPendingTimeout(entry);
        // duplicate=true 表示服务端判定这是幂等重放：消息早就发出去了，当成功处理，不报错
        if (res && res.duplicate) pushDebug('prompt-duplicate', { requestId: requestId, text: text });
      })
      .catch(function (err) {
        if (state.sendingId === requestId) state.sendingId = null;
        if (!isPending(requestId)) { updateSendState(); return; }
        pushDebug('prompt-error', {
          status: err && err.status, code: err && err.code, message: err && err.message
        });
        var list = pendingList();
        // 只撤自己那一个气泡。条目本身留在队列里（failed=true），
        // 重试时 requestIdFor 会复用它的 id 并顺手摘掉它。
        var sameSession = entry.sessionId === state.sessionId;
        var isNewest = list[list.length - 1] === entry;
        // 回填的两个前提：① 它是最新一条（否则回填的是别人的位置）；
        // ② 输入框是空的 —— 请求在飞的时候用户可能已经在打下一条了，别冲掉。
        var inputBusy = !!normalizePromptText(els.composerInput.value);
        entry.failed = true;
        if (entry.el && entry.el.parentNode) entry.el.parentNode.removeChild(entry.el);
        entry.el = null;
        prunePending();
        var suffix = '';
        if (sameSession && isNewest && !inputBusy) {
          restoreText(text);
        } else if (sameSession && isNewest) {
          // 原文没丢：还在队列条目里，也记一份到调试面板
          pushDebug('prompt-restore-skipped', { text: text });
          suffix = '（原文没放回输入框，避免冲掉你正在输入的内容）';
        }
        updateSendState();   // 必须在回填之后：按钮可用性看的是输入框当前内容
        flashSend('shake');
        showToast('发送失败：' + humanError(err) + suffix);
      });
  }

  /** 停止当前这一轮。只在运行中显示按钮，点之前先确认。 */
  function cancelRun() {
    if (state.cancelling || !state.sessionId) return;
    if (!window.confirm('停止当前这一轮？已经产出的内容会保留。')) return;
    state.cancelling = true;
    els.btnStop.disabled = true;
    postJSON('/api/cancel', { sessionId: state.sessionId })
      .then(function () {
        showToast('已请求停止', 2500);
      })
      .catch(function (err) {
        pushDebug('cancel-error', {
          status: err && err.status, code: err && err.code, message: err && err.message
        });
        showToast('停止失败：' + humanError(err));
      })
      .then(function () {
        state.cancelling = false;
        els.btnStop.disabled = false;
        renderChatHeader();
      });
  }

  /* ==================================================================
   * P3-B / P3-C：模型与模式的切换面板
   * ================================================================== */

  /** 面板里的一行说明。 */
  function sheetNote(text, warn) {
    var el = document.createElement('div');
    el.className = 'sheet-note' + (warn ? ' warn' : '');
    el.textContent = text;
    return el;
  }

  /** 拉模型目录。服务端有 60 秒缓存，客户端也缓存，切会话不会反复拉。 */
  function loadCatalog(force) {
    if (state.catalog && !force) return Promise.resolve(state.catalog);
    return fetchJSON('/api/models').then(function (data) {
      state.catalog = data && data.catalog ? data.catalog : null;
      state.catalogAt = Date.now();
      // 目录到了，显示名可能从 id 变成友好名，重画一次头部
      if (state.sessionId) {
        state.sub.modelLabel = modelDisplay(state.sub.provider, state.sub.model, state.catalog);
        renderChatHeader();
      }
      return state.catalog;
    }).catch(function (err) {
      pushDebug('models-error', { status: err && err.status, code: err && err.code, message: err && err.message });
      throw err;
    });
  }

  /** 拉模式清单。 */
  function loadPresets(force) {
    if (state.presets && !force) return Promise.resolve(state.presets);
    return fetchJSON('/api/presets').then(function (data) {
      state.presets = data && Array.isArray(data.presets) ? data.presets : [];
      state.presetsAt = Date.now();
      if (state.sessionId) {
        state.sub.presetLabel = presetDisplay(state.sub.preset, state.presets);
        renderChatHeader();
      }
      return state.presets;
    }).catch(function (err) {
      pushDebug('presets-error', { status: err && err.status, code: err && err.code, message: err && err.message });
      throw err;
    });
  }

  /** 打开底部面板；buildBody(container) 负责填内容。 */
  function openSheet(title, buildBody) {
    els.sheetTitle.textContent = title;
    els.sheetBody.textContent = '';
    buildBody(els.sheetBody);
    els.sheet.hidden = false;
  }

  function closeSheet() {
    els.sheet.hidden = true;
    els.sheetBody.textContent = '';
  }

  function openModelSheet() {
    if (!state.sessionId) return;
    if (!CONFIG.enablePrompt) { showToast('手机端写操作已被配置关闭（enablePrompt=false）', 3200); return; }
    if (state.catalog) { renderModelSheet(); return; }
    openSheet('切换模型', function (body) { body.appendChild(sheetNote('正在载入模型列表…')); });
    loadCatalog().then(function () {
      if (!els.sheet.hidden) renderModelSheet();
    }).catch(function (err) {
      if (els.sheet.hidden) return;
      els.sheetBody.textContent = '';
      els.sheetBody.appendChild(sheetNote('载入模型列表失败：' + humanError(err), true));
    });
  }

  function renderModelSheet() {
    var catalog = state.catalog;
    openSheet('切换模型', function (body) {
      var groups = catalog && Array.isArray(catalog.groups) ? catalog.groups : [];
      if (!groups.length) {
        body.appendChild(sheetNote('宿主端没有可用的模型。'));
        return;
      }
      body.appendChild(sheetNote('只对下一次请求生效，正在跑的这一轮不受影响。'));
      for (var g = 0; g < groups.length; g++) {
        var group = groups[g];
        var head = document.createElement('div');
        head.className = 'sheet-group';
        head.textContent = group.name || group.id || '其他';
        body.appendChild(head);
        var models = Array.isArray(group.models) ? group.models : [];
        for (var m = 0; m < models.length; m++) {
          body.appendChild(modelOption(group, models[m]));
        }
      }
      var failures = catalog && Array.isArray(catalog.failures) ? catalog.failures : [];
      if (failures.length) {
        var fh = document.createElement('div');
        fh.className = 'sheet-group';
        fh.textContent = '不可用的提供方';
        body.appendChild(fh);
        for (var f = 0; f < failures.length; f++) {
          var row = failures[f] || {};
          body.appendChild(sheetNote((row.name || row.id || '未知') + '：' + (row.message || '不可用')));
        }
      }
    });
  }

  /**
   * 一个模型条目。
   *
   * reasoning 档位只在**当前选中的那个模型**下面展开：每个模型都铺一排档位的话，
   * 面板会长到没法用。切换之后面板会重画，新模型的档位就出现了。
   */
  function modelOption(group, model) {
    var wrap = document.createElement('div');
    var current = state.sub.provider === group.id && state.sub.model === model.id;

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'opt' + (current ? ' on' : '');

    var label = document.createElement('span');
    label.className = 'opt-label';
    label.textContent = model.name || model.id;
    btn.appendChild(label);
    if (model.description) {
      var desc = document.createElement('span');
      desc.className = 'opt-desc';
      desc.textContent = model.description;
      btn.appendChild(desc);
    }
    btn.addEventListener('click', function () {
      // 点模型本体：已经在用的就沿用当前档位，否则用这个模型的默认档位
      var effort = current ? state.sub.reasoningEffort : (model.defaultEffort || '');
      applyModelChoice(group.id, model.id, effort || undefined);
    });
    wrap.appendChild(btn);

    var efforts = Array.isArray(model.efforts) ? model.efforts : [];
    if (efforts.length && current) {
      var row = document.createElement('div');
      row.className = 'opt-efforts';
      for (var e = 0; e < efforts.length; e++) {
        (function (effort) {
          var chip = document.createElement('button');
          chip.type = 'button';
          chip.className = 'effort' + (state.sub.reasoningEffort === effort.id ? ' on' : '');
          chip.textContent = effort.name || effort.id;
          if (effort.description) chip.title = effort.description;
          chip.addEventListener('click', function () { applyModelChoice(group.id, model.id, effort.id); });
          row.appendChild(chip);
        })(efforts[e]);
      }
      wrap.appendChild(row);
    }
    return wrap;
  }

  /** 乐观更新头部 → POST → 失败回滚。 */
  function applyModelChoice(provider, model, reasoningEffort) {
    if (!state.sessionId || !provider || !model) return;
    var sessionId = state.sessionId;
    var before = {
      provider: state.sub.provider, model: state.sub.model,
      modelLabel: state.sub.modelLabel, reasoningEffort: state.sub.reasoningEffort
    };

    // 乐观更新：手机上的操作要立刻有反馈
    state.sub.provider = provider;
    state.sub.model = model;
    state.sub.modelLabel = modelDisplay(provider, model, state.catalog);
    state.sub.reasoningEffort = reasoningEffort || '';
    renderChatHeader();

    var payload = { sessionId: sessionId, provider: provider, model: model };
    if (reasoningEffort) payload.reasoningEffort = reasoningEffort;

    postJSON('/api/model', payload).then(function (data) {
      var sel = data && data.selected ? data.selected : null;
      if (sel && typeof sel.model === 'string') {
        state.sub.provider = typeof sel.provider === 'string' && sel.provider ? sel.provider : state.sub.provider;
        state.sub.model = sel.model;
        state.sub.modelLabel = modelDisplay(state.sub.provider, sel.model, state.catalog);
        state.sub.reasoningEffort = typeof sel.reasoningEffort === 'string' ? sel.reasoningEffort : '';
      }
      renderChatHeader();
      closeSheet();
      showToast('已切换为 ' + (state.sub.modelLabel || state.sub.model), 2200);
      // 列表行本来就不显示模型，但缓存别留太旧
      state.lastListAt = 0;
    }).catch(function (err) {
      state.sub.provider = before.provider;
      state.sub.model = before.model;
      state.sub.modelLabel = before.modelLabel;
      state.sub.reasoningEffort = before.reasoningEffort;
      renderChatHeader();
      pushDebug('model-error', { status: err && err.status, code: err && err.code, message: err && err.message });
      showToast('切换模型失败：' + humanError(err), 4200);
    });
  }

  function openPresetSheet() {
    if (!state.sessionId) return;
    if (!CONFIG.enablePrompt) { showToast('手机端写操作已被配置关闭（enablePrompt=false）', 3200); return; }
    if (!state.sub.canSwitchPreset) {
      showToast('这个会话已经跑过至少一轮，模式不能再改了', 3600);
      return;
    }
    if (state.presets) { renderPresetSheet(); return; }
    openSheet('切换模式', function (body) { body.appendChild(sheetNote('正在载入模式列表…')); });
    loadPresets().then(function () {
      if (!els.sheet.hidden) renderPresetSheet();
    }).catch(function (err) {
      if (els.sheet.hidden) return;
      els.sheetBody.textContent = '';
      els.sheetBody.appendChild(sheetNote('载入模式列表失败：' + humanError(err), true));
    });
  }

  function renderPresetSheet() {
    var rows = Array.isArray(state.presets) ? state.presets : [];
    openSheet('切换模式', function (body) {
      if (!rows.length) {
        body.appendChild(sheetNote('宿主端没有可用的模式。'));
        return;
      }
      body.appendChild(sheetNote('模式决定这个会话挂哪些能力，只有还没开始过的会话能改。'));
      for (var i = 0; i < rows.length; i++) {
        var row = rows[i] || {};
        var current = row.id === state.sub.preset;
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'opt' + (current ? ' on' : '');

        var label = document.createElement('span');
        label.className = 'opt-label';
        label.textContent = row.label || row.id;
        btn.appendChild(label);

        if (row.description) {
          var desc = document.createElement('span');
          desc.className = 'opt-desc';
          desc.textContent = row.description;
          btn.appendChild(desc);
        }
        if (row.broken) {
          var broken = document.createElement('span');
          broken.className = 'opt-desc';
          broken.textContent = '不可用：' + row.broken;
          btn.appendChild(broken);
          btn.disabled = true;
        } else if (!current) {
          (function (id) {
            btn.addEventListener('click', function () { applyPresetChoice(id); });
          })(row.id);
        }
        body.appendChild(btn);
      }
    });
  }

  function applyPresetChoice(presetId) {
    if (!state.sessionId || !presetId) return;
    var sessionId = state.sessionId;
    var before = { preset: state.sub.preset, presetLabel: state.sub.presetLabel };

    state.sub.preset = presetId;
    state.sub.presetLabel = presetDisplay(presetId, state.presets);
    renderChatHeader();

    postJSON('/api/preset', { sessionId: sessionId, preset: presetId }).then(function (data) {
      var sel = data && typeof data.selected === 'string' && data.selected ? data.selected : presetId;
      state.sub.preset = sel;
      state.sub.presetLabel = (data && typeof data.label === 'string' && data.label) || presetDisplay(sel, state.presets);
      renderChatHeader();
      closeSheet();
      showToast('已切换为 ' + state.sub.presetLabel, 2200);
    }).catch(function (err) {
      state.sub.preset = before.preset;
      state.sub.presetLabel = before.presetLabel;
      // 服务端说"锁死了"：把芯片也置灰，别让用户反复试
      if (err && err.code === 'preset-locked') state.sub.canSwitchPreset = false;
      renderChatHeader();
      pushDebug('preset-error', { status: err && err.status, code: err && err.code, message: err && err.message });
      showToast('切换模式失败：' + humanError(err), 4200);
    });
  }

  /* ==================================================================
   * P4：新建会话
   *
   * 宿主那边是 `sessionController.create({ cwd | workspaceId, agentPreset? })`，
   * 不传 sessionId 就由宿主生成。所以手机上只需要"选个文件夹"这一件事。
   *
   * 刻意**不做模式选择器**：新建出来的会话是 blank 的，进去以后头部那枚模式芯片
   * 本来就能点（DSH 只禁止已开跑的会话改模式），没必要在建的时候先问一遍。
   * ================================================================== */

  /** 拉文件夹清单（DSH 已登记的工作区 + 已有会话的目录，服务端合并去重）。 */
  function loadWorkspaces(force) {
    if (state.workspaces && !force) return Promise.resolve(state.workspaces);
    return fetchJSON('/api/workspaces').then(function (data) {
      state.workspaces = data && Array.isArray(data.workspaces) ? data.workspaces : [];
      return state.workspaces;
    }).catch(function (err) {
      pushDebug('workspaces-error', { status: err && err.status, code: err && err.code, message: err && err.message });
      throw err;
    });
  }

  function openNewSheet() {
    if (!CONFIG.enablePrompt) {
      showToast('手机端写操作已被配置关闭（enablePrompt=false）', 3200);
      return;
    }
    if (state.workspaces) { renderNewSheet(); return; }
    openSheet('新建会话', function (body) { body.appendChild(sheetNote('正在载入文件夹…')); });
    loadWorkspaces().then(function () {
      if (!els.sheet.hidden) renderNewSheet();
    }).catch(function (err) {
      if (els.sheet.hidden) return;
      // 清单拉不到也还能手输路径 —— 新建会话本身不依赖这个接口
      els.sheetBody.textContent = '';
      els.sheetBody.appendChild(sheetNote('载入文件夹失败：' + humanError(err), true));
      appendPathRow(els.sheetBody);
    });
  }

  function renderNewSheet() {
    var rows = Array.isArray(state.workspaces) ? state.workspaces : [];
    openSheet('新建会话', function (body) {
      if (rows.length) {
        body.appendChild(sheetNote('选一个文件夹，新会话就在那里开始。'));
        for (var i = 0; i < rows.length; i++) body.appendChild(workspaceOption(rows[i]));
      } else {
        body.appendChild(sheetNote('还没找到任何文件夹，下面手输一个绝对路径也行。'));
      }
      appendPathRow(body);
    });
  }

  /** 一个候选文件夹。副标题用尾部路径，省得几个同名目录分不清。 */
  function workspaceOption(row) {
    var item = row && typeof row === 'object' ? row : {};
    var name = typeof item.name === 'string' && item.name ? item.name : String(item.path || '');
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'opt';

    var label = document.createElement('span');
    label.className = 'opt-label';
    label.textContent = name;
    btn.appendChild(label);

    if (typeof item.path === 'string' && item.path && item.path !== name) {
      var desc = document.createElement('span');
      desc.className = 'opt-desc';
      desc.textContent = shortPath(item.path);
      btn.appendChild(desc);
    }
    btn.addEventListener('click', function () {
      var payload = {};
      // workspaceId 优先（宿主自己解析路径）；没有登记 id 就退回 cwd
      if (typeof item.id === 'string' && item.id) payload.workspaceId = item.id;
      else if (typeof item.path === 'string' && item.path) payload.cwd = item.path;
      if (!payload.workspaceId && !payload.cwd) { showToast('这个条目没有可用路径', 2600); return; }
      createSession(payload);
    });
    return btn;
  }

  /** 手输路径那一行：清单里还没有的文件夹也能开会话。 */
  function appendPathRow(body) {
    var group = document.createElement('div');
    group.className = 'sheet-block';
    group.appendChild(sheetNote('其他路径…（必须是绝对路径）'));

    var input = document.createElement('input');
    input.type = 'text';
    input.className = 'sheet-input';
    input.placeholder = 'D:\\项目\\新文件夹';
    input.setAttribute('autocapitalize', 'none');
    input.setAttribute('autocorrect', 'off');
    input.setAttribute('spellcheck', 'false');
    group.appendChild(input);

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn';
    btn.textContent = '在这个文件夹新建';
    btn.addEventListener('click', function () {
      var value = String(input.value || '').trim();
      if (!value) { showToast('先填一个文件夹路径', 2400); return; }
      createSession({ cwd: value });
    });
    group.appendChild(btn);
    body.appendChild(group);
  }

  /** 真正建会话：成功后关面板、让清单与列表失效，然后直接进新会话。 */
  function createSession(payload) {
    if (state.creating) return;
    state.creating = true;
    setSheetBusy(true);

    postJSON('/api/session', payload).then(function (data) {
      state.creating = false;
      var id = data && typeof data.sessionId === 'string' ? data.sessionId : '';
      if (!id) {
        setSheetBusy(false);
        showToast('宿主端没有返回新会话 id', 3600);
        return;
      }
      closeSheet();
      // 新会话可能落在一个新文件夹里，清单要重拉；列表也刷一下让新行出现
      state.workspaces = null;
      loadSessions(false);
      openSession(id);
      // 进去的是一个空会话，给一句提示，免得以为没建成
      showToast('已新建会话', 2000);
    }).catch(function (err) {
      state.creating = false;
      setSheetBusy(false);
      pushDebug('session-create-error', { status: err && err.status, code: err && err.code, message: err && err.message });
      showToast('新建会话失败：' + humanError(err), 4200);
    });
  }

  /** 提交期间把面板里的按钮都禁掉，避免连点建出好几个会话。 */
  function setSheetBusy(busy) {
    var btns = els.sheetBody.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) btns[i].disabled = !!busy;
  }

  /* ==================================================================
   * P3-D：回答问题
   * ================================================================== */

  /**
   * 订阅问题流。
   *
   * 单独开一条 SSE 而不是复用 /api/follow：提问可能发生在任何会话，而 follow 是绑
   * 单个会话的。分开之后，人在列表页也能第一时间知道有会话在等回答。
   */
  function connectQuestions() {
    if (state.questionSource) {
      try { state.questionSource.close(); } catch (e) { /* 忽略 */ }
      state.questionSource = null;
    }
    var es;
    try {
      es = new EventSource('/api/questions/stream');
    } catch (err) {
      pushDebug('questions-stream-error', { message: err && err.message });
      return;
    }
    state.questionSource = es;
    // 用 addEventListener 而不是 onmessage：与 /api/follow 那条流的写法保持一致
    // （follow 用的是具名事件 snapshot/event/assistant-stream，这里用的是默认的 message）
    es.addEventListener('message', function (e) {
      // 注意 tryJson 返回的是 { ok, value } 而不是解析结果本身
      var parsed = tryJson(e && e.data);
      if (!parsed.ok) return;
      var frame = parsed.value;
      if (!frame || typeof frame !== 'object') return;
      applyQuestionFrame(frame);
    });
    es.addEventListener('error', function () {
      // EventSource 自己会重连，这里只记一笔状态
      pushDebug('questions-stream', { state: es.readyState });
    });
  }

  /** 处理一条问题流帧。 */
  function applyQuestionFrame(frame) {
    var kind = String(frame.e || '');
    var d = frame.d && typeof frame.d === 'object' ? frame.d : null;
    if (kind === 'question') {
      if (!d || !d.id) return;
      if (d.sessionId === state.sessionId) {
        state.question = d;
        state.questionDraft = {};
        state.questionNote = '';
        renderQuestionCard();
      } else {
        // 别的会话在等：提示一声，并把列表刷新出来（那一行会带"待回答"角标）
        showToast('有会话在等你回答', 3200);
        loadSessions(false);
      }
      return;
    }
    if (kind === 'question-settled') {
      if (!d || !d.id) return;
      if (state.question && state.question.id === d.id) {
        state.question = null;
        state.questionDraft = {};
        state.questionNote = '';
        // 服务端已经把这个条目的认领释放掉了，这里只清本地记录，不再发一次无用的释放请求
        if (state.questionHoldId === d.id) state.questionHoldId = null;
        state.questionHeld = false;
        renderQuestionCard();
      }
      // 超时是**最需要说清楚**的一种结局：卡片突然消失、什么都没说，
      // 用户只会以为"我答了但没生效"，然后在电脑上再答一遍（于是 agent 又跑一轮）。
      if (d.outcome === 'aborted') {
        showToast('问题已超时，本轮已继续；可在电脑上回答（会作为新消息）', 5200);
      }
      loadSessions(false);
      return;
    }
    // 服务端回执：认领成功 / 被释放（手机页面断开后服务端也会主动释放）
    if (kind === 'question-hold') {
      if (!d || !d.id || !state.question || state.question.id !== d.id) return;
      state.questionHeld = d.held === true;
      if (typeof d.remainingMs === 'number') state.questionWaitMs = d.remainingMs;
      refreshQuestionFoot();
    }
  }

  /** 进会话时补拉一次待答问题：提问可能在这个会话打开之前就来了。 */
  function refreshQuestions() {
    if (!state.sessionId) return;
    fetchJSON('/api/questions?id=' + encodeURIComponent(state.sessionId)).then(function (data) {
      var items = data && Array.isArray(data.items) ? data.items : [];
      if (!items.length) {
        if (state.question) {
          state.question = null;
          renderQuestionCard();
        }
        return;
      }
      // 一次只显示一个问题（服务端按登记顺序返回，取最老的那个）
      if (!state.question || state.question.id !== items[0].id) {
        state.question = items[0];
        state.questionDraft = {};
        state.questionNote = '';
      }
      renderQuestionCard();
    }).catch(function (err) {
      pushDebug('questions-error', { status: err && err.status, code: err && err.code, message: err && err.message });
    });
  }

  /**
   * 告诉服务端"我正看着这张卡片"。
   *
   * 为什么必须说：`ask_user_question` 是**限时**提问（默认 120 秒）。没有任何回答界面
   * 认领这次等待时，到点宿主就直接放行模型 —— 问题进入 continued，之后再作答会走
   * "迟到回复"那条路（把回答 steer 成一条用户消息），结果是**答案被暂存 + agent 又跑一轮**。
   * 手机认领之后，倒计时归手机管：只要卡片还在屏幕上，你就有充足时间作答，
   * 而且答完是"时答"，不会再多跑一轮。
   *
   * 反过来，**不看了就必须立刻放开**：否则宿主会一直等一个没人看的卡片，agent 真会卡死。
   * 所以只有"聊天页 + 卡片可见 + 页面在前台"三个条件同时成立才认领。
   */
  function syncQuestionHold() {
    var q = state.question;
    // 收起的卡片不算"看着"：收起来就等于不看了，认领必须放掉
    var visible = !!q && !!q.id && !els.qcard.hidden && !state.qcardCollapsed &&
      state.view === 'chat' && pageVisible();
    var wantId = visible ? q.id : null;
    if (wantId === state.questionHoldId) return;
    var releaseId = state.questionHoldId;
    state.questionHoldId = wantId;
    if (releaseId) postHold(releaseId, false);
    if (wantId) postHold(wantId, true);
  }

  /** 页面是否在前台。老浏览器没有 visibilityState 时按"可见"处理（宁可认领）。 */
  function pageVisible() {
    return !document || document.visibilityState !== 'hidden';
  }

  /**
   * 立刻释放认领（页面要走了）。
   * 用 keepalive 让请求在卸载过程中也能发出去；失败无所谓 ——
   * 服务端在最后一个问题流订阅者断开时还会兜底释放一次。
   */
  function releaseQuestionHold() {
    var id = state.questionHoldId;
    state.questionHoldId = null;
    state.questionHeld = false;
    if (!id) return;
    try {
      var req = fetch('/api/questions/hold', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        keepalive: true,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ questionId: id, hold: false })
      });
      if (req && typeof req.catch === 'function') req.catch(function () {});
    } catch (e) { /* 页面正在卸载，发不出去也不影响什么 */ }
  }

  /** 认领 / 释放一次等待。失败只记一笔调试信息 —— 退回宿主自己计时，功能照常。 */
  function postHold(questionId, on) {
    postJSON('/api/questions/hold', { questionId: questionId, hold: on }).then(function () {
      // 认领**是否真的生效**以服务端随后推的 question-hold 帧为准：
      // 接口返回的 claimed 只表示"开始尝试认领"（认领实现可能当场抛错），
      // 拿它当结果显示会给用户一个假的承诺。
      if (!on) {
        state.questionHeld = false;
        refreshQuestionFoot();
      }
    }).catch(function (err) {
      state.questionHeld = false;
      pushDebug('question-hold-error', { status: err && err.status, code: err && err.code, message: err && err.message });
      refreshQuestionFoot();
    });
  }

  /** 只更新计数与提交按钮，不重建 DOM —— 否则正在输入的自定义答案会丢焦点。 */
  function refreshQuestionFoot() {
    var q = state.question;
    if (!q || !Array.isArray(q.questions)) return;
    var left = unansweredCount(q.questions, state.questionDraft);
    els.qcardCount.textContent = left > 0 ? '还剩 ' + left + ' 题' : '可以提交了';
    // 认领成功与否要如实说：没认领时宿主到点会放行，用户得知道这件事
    var hint = state.questionHeld
      ? '已接管等待，答完之前不会超时'
      : '手机上答完，电脑那边会自动继续';
    els.qcardNote.textContent = state.questionNote || hint;
    els.qcardSubmit.disabled = state.questionSending || left > 0;
    els.qcardSubmit.textContent = state.questionSending ? '提交中…' : '提交';
  }

  /**
   * 渲染提问卡片。位置紧贴输入框上方，与桌面端"提问占据输入区"的心智一致。
   *
   * 卡片会一直占着输入框上方那块地，把上面的会话消息挤扁 —— 所以给了收起键。
   * 收起状态是"这一张卡片"的，换一个新问题就自动展开：新问题必须让人看见。
   */
  function renderQuestionCard() {
    var q = state.question;
    if (!q || !Array.isArray(q.questions) || !q.questions.length) {
      els.qcard.hidden = true;
      els.qcardBody.textContent = '';
      state.qcardId = null;
      syncQuestionHold();
      return;
    }
    if (q.id !== state.qcardId) {
      state.qcardId = q.id;
      state.qcardCollapsed = false;   // 新问题：自动展开
    }
    els.qcard.hidden = false;
    els.qcardTitle.textContent = q.questions.length > 1
      ? '有 ' + q.questions.length + ' 个问题要你决定'
      : '需要你决定';
    els.qcardBody.textContent = '';
    for (var i = 0; i < q.questions.length; i++) {
      els.qcardBody.appendChild(questionBlock(q.questions[i], i, q.questions.length));
    }
    refreshQuestionFoot();
    applyQcardCollapsed();
    // 卡片真的显示出来了才认领等待（见 syncQuestionHold）
    syncQuestionHold();
  }

  /** 把收起状态落到 DOM 上。只切类与按钮文案，没有高度动画。 */
  function applyQcardCollapsed() {
    if (!els.qcard) return;
    var off = state.qcardCollapsed === true;
    els.qcard.classList.toggle('collapsed', off);
    if (els.qcardToggle) {
      els.qcardToggle.textContent = off ? '展开' : '收起';
      els.qcardToggle.setAttribute('aria-expanded', off ? 'false' : 'true');
    }
  }

  function toggleQcard() {
    state.qcardCollapsed = !state.qcardCollapsed;
    applyQcardCollapsed();
    // 收起来就等于"不看这张卡片了"：认领要跟着放掉，否则 agent 会一直等一个
    // 被收起来的卡片（展开时会重新认领）。
    syncQuestionHold();
  }

  /** 渲染一道题。 */
  function questionBlock(question, index, total) {
    var q = question && typeof question === 'object' ? question : {};
    var id = typeof q.id === 'string' ? q.id : '';
    var box = document.createElement('div');
    box.className = 'q-item';

    if (total > 1 || q.header) {
      var head = document.createElement('div');
      head.className = 'q-head';
      var bits = [];
      if (total > 1) bits.push('第 ' + (index + 1) + ' 题');
      if (q.header) bits.push(String(q.header));
      head.textContent = bits.join(' · ');
      box.appendChild(head);
    }

    var stem = document.createElement('div');
    stem.className = 'q-q';
    stem.textContent = q.question || '（无题干）';
    box.appendChild(stem);

    if (q.detail) {
      var detail = document.createElement('div');
      detail.className = 'q-detail';
      detail.textContent = String(q.detail);
      box.appendChild(detail);
    }

    var options = Array.isArray(q.options) ? q.options : [];
    if (options.length) {
      var list = document.createElement('div');
      list.className = 'q-opts';
      for (var o = 0; o < options.length; o++) list.appendChild(questionOption(id, q, options[o]));
      box.appendChild(list);
    }

    // 自定义答案：桌面上也允许自己写，手机必须支持 —— 否则遇到没有合适选项的问题就没法答
    var custom = document.createElement('textarea');
    custom.className = 'q-custom';
    custom.rows = 2;
    custom.placeholder = options.length ? '也可以自己写一个答案…' : '输入你的答案…';
    custom.value = draftFor(state.questionDraft, id).custom;
    custom.addEventListener('input', function () {
      var d = draftFor(state.questionDraft, id);
      state.questionDraft[id] = { selected: d.selected, custom: custom.value };
      refreshQuestionFoot();
    });
    box.appendChild(custom);

    return box;
  }

  /** 渲染一个选项。多选用方框、单选用圆圈 —— 形状本身就说明了能选几个。 */
  function questionOption(questionId, question, option) {
    var opt = option && typeof option === 'object' ? option : {};
    var label = typeof opt.label === 'string' ? opt.label : String(option);
    var multi = question && question.multiSelect === true;
    var d = draftFor(state.questionDraft, questionId);
    var on = d.selected.indexOf(label) >= 0;

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'q-opt' + (on ? ' on' : '');

    var mark = document.createElement('span');
    mark.className = 'q-mark';
    mark.textContent = multi ? (on ? '☑' : '☐') : (on ? '◉' : '○');

    var main = document.createElement('span');
    main.className = 'q-opt-main';
    var lb = document.createElement('span');
    lb.className = 'q-opt-label';
    lb.textContent = label;
    main.appendChild(lb);
    if (opt.description) {
      var desc = document.createElement('span');
      desc.className = 'q-opt-desc';
      desc.textContent = String(opt.description);
      main.appendChild(desc);
    }

    btn.appendChild(mark);
    btn.appendChild(main);
    btn.addEventListener('click', function () {
      var cur = draftFor(state.questionDraft, questionId);
      var selected = multi ? toggleMulti(cur.selected, label) : toggleSingle(cur.selected, label);
      state.questionDraft[questionId] = { selected: selected, custom: cur.custom };
      // 选项不多，整张卡片重画比逐项改 class 更不容易出错
      renderQuestionCard();
    });
    return btn;
  }

  function submitQuestion() {
    var q = state.question;
    if (!q || state.questionSending) return;
    var answers = answersFromDraft(q.questions, state.questionDraft);
    if (!answers) {
      state.questionNote = '还有题目没作答';
      refreshQuestionFoot();
      return;
    }
    state.questionSending = true;
    state.questionNote = '';
    refreshQuestionFoot();

    postJSON('/api/answer', { questionId: q.id, answers: answers }).then(function () {
      state.questionSending = false;
      // 服务端随后会推一条 question-settled 把卡片收掉，这里先给即时反馈
      state.questionNote = '已提交，等电脑那边继续';
      refreshQuestionFoot();
      showToast('已提交答案', 2200);
    }).catch(function (err) {
      state.questionSending = false;
      pushDebug('answer-error', { status: err && err.status, code: err && err.code, message: err && err.message });
      state.questionNote = '提交失败：' + humanError(err);
      refreshQuestionFoot();
      showToast('提交失败：' + humanError(err), 4200);
    });
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
  var toastHideTimer = null;

  function showToast(message, ms) {
    if (!els.toast) return;
    els.toast.textContent = String(message);
    els.toast.hidden = false;
    // 上一次的退场动画可能还没收尾，先把它撤掉，否则新提示会接着往下淡出
    if (toastHideTimer) { clearTimeout(toastHideTimer); toastHideTimer = null; }
    els.toast.classList.remove('toast-out');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, num(ms) === null ? 4000 : num(ms));
  }

  /** 退场：先播淡出，动画放完再真正隐藏。 */
  function hideToast() {
    if (!els.toast || els.toast.hidden) return;
    els.toast.classList.add('toast-out');
    if (toastHideTimer) clearTimeout(toastHideTimer);
    toastHideTimer = setTimeout(function () {
      els.toast.hidden = true;
      els.toast.classList.remove('toast-out');
      toastHideTimer = null;
    }, reducedMotion() ? 0 : 180);
  }

  /* ------------------------------ 入口 ------------------------------ */

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  global.DSHMobileMirror = { state: state, connect: connect, disconnect: disconnect, renderMarkdown: renderMarkdown };
})(typeof globalThis !== 'undefined' ? globalThis : this);
