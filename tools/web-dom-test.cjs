/* 手机界面行为测试（在仓库里，可重复运行）
 * 用法：node tools/web-dom-test.cjs
 * 用一个极简 fake DOM + fake fetch/EventSource，把 app.js 的界面逻辑真跑一遍：
 *   - boot 不抛错（顺带验证 app.js 引用的 id 在 index.html 里都存在）
 *   - 会话列表渲染 / 工作区分组 / 折叠 / running 自动进入
 *   - snapshot 重建 / 逐字流式 / assistant/message 替换临时气泡（不重复）
 *   - tool/call 与 tool/result 归并 / 往上翻历史
 *   - 调试面板、输入框、发送与停止
 *   - P3：模型与模式芯片、选择面板、手机端回答提问
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const WEB = path.join(__dirname, '..', 'lib', 'web');
const APP_JS = path.join(WEB, 'app.js');
const INDEX = path.join(WEB, 'index.html');

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; failures.push(name); console.log('  FAIL  ' + name + (extra ? '  ← ' + extra : '')); }
}
function eq(name, a, b) { ok(name, a === b, 'got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b)); }

/* ============================== fake DOM ============================== */

let ROOT = null;
function connected(node) {
  let cur = node;
  while (cur && cur.parentNode) cur = cur.parentNode;
  return cur === ROOT;
}

class Txt {
  constructor(t) { this.nodeType = 3; this.data = String(t); this.parentNode = null; }
  get textContent() { return this.data; }
  set textContent(v) { this.data = String(v); }
  appendData(s) { this.data += s; }
  get isConnected() { return connected(this); }
}

class Raw {
  constructor(html) { this.nodeType = 4; this.html = String(html); this.parentNode = null; }
  get textContent() { return this.html; }
  get isConnected() { return connected(this); }
}

class Frag {
  constructor() { this.nodeType = 11; this.childNodes = []; }
  appendChild(n) { this.childNodes.push(n); n.parentNode = this; return n; }
  removeChild(n) {
    const i = this.childNodes.indexOf(n);
    if (i !== -1) { this.childNodes.splice(i, 1); n.parentNode = null; }
    return n;
  }
}

/**
 * 极简选择器匹配：`tag` / `.cls` / `tag.cls`。
 * 只认这三种 —— app.js 用到的选择器都能覆盖，认不出的写法直接不匹配。
 */
function matchesPart(child, part) {
  const m = /^([a-zA-Z][\w-]*)?(?:\.([\w-]+))?$/.exec(String(part));
  if (!m) return false;
  const tag = m[1] || '';
  const cls = m[2] || '';
  if (!tag && !cls) return false;
  if (tag && child.tagName !== tag.toUpperCase()) return false;
  if (cls && !child._classes.has(cls)) return false;
  return true;
}

class El {
  constructor(tag) {
    this.nodeType = 1;
    this.tagName = String(tag).toUpperCase();
    this.childNodes = [];
    this.parentNode = null;
    this.attributes = {};
    this.style = {};
    this.hidden = false;
    this.open = false;
    this.disabled = false;
    this._listeners = {};
    this._classes = new Set();
    this._scrollHeight = null;
    this.scrollTop = 0;
    this.clientHeight = 300;
  }
  get className() { return Array.from(this._classes).join(' '); }
  set className(v) { this._classes = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get classList() {
    const self = this;
    return {
      add() { for (const c of arguments) self._classes.add(c); },
      remove() { for (const c of arguments) self._classes.delete(c); },
      contains(c) { return self._classes.has(c); },
      toggle(c, force) {
        const on = force === undefined ? !self._classes.has(c) : !!force;
        if (on) self._classes.add(c); else self._classes.delete(c);
        return on;
      }
    };
  }
  get textContent() { return this.childNodes.map((n) => n.textContent).join(''); }
  set textContent(v) {
    this.childNodes.forEach((n) => { n.parentNode = null; });
    this.childNodes = [];
    if (v !== null && v !== undefined && String(v) !== '') this.appendChild(new Txt(v));
  }
  get firstChild() { return this.childNodes.length ? this.childNodes[0] : null; }
  get isConnected() { return connected(this); }
  get scrollHeight() {
    if (this._scrollHeight !== null) return this._scrollHeight;
    // 每个"可见的"直接子节点算 100px。hidden 的节点在真浏览器里不占位，
    // 刻度条要按消息在流里的位置算比例 —— 把藏起来的节点也算进去就会整体错位。
    let h = 0;
    for (const c of this.childNodes) if (c.nodeType === 1 && !c.hidden) h += 100;
    return h;
  }
  set scrollHeight(v) { this._scrollHeight = v; }
  /* 布局量：与上面那套「每个可见直接子节点 100px」的模型保持一致。 */
  get offsetHeight() { return this.hidden ? 0 : 100; }
  get offsetTop() {
    const parent = this.parentNode;
    if (!parent) return 0;
    let top = 0;
    for (const c of parent.childNodes) {
      if (c === this) return top;
      if (c.nodeType === 1 && !c.hidden) top += 100;
    }
    return 0;
  }
  appendChild(node) {
    if (node.nodeType === 11) {
      node.childNodes.slice().forEach((c) => this.appendChild(c));
      node.childNodes = [];
      return node;
    }
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }
  insertBefore(node, ref) {
    if (node.nodeType === 11) {
      node.childNodes.slice().forEach((c) => this.insertBefore(c, ref));
      node.childNodes = [];
      return node;
    }
    if (node.parentNode) node.parentNode.removeChild(node);
    const i = ref ? this.childNodes.indexOf(ref) : -1;
    node.parentNode = this;
    if (i === -1) this.childNodes.push(node);
    else this.childNodes.splice(i, 0, node);
    return node;
  }
  removeChild(node) {
    const i = this.childNodes.indexOf(node);
    if (i !== -1) { this.childNodes.splice(i, 1); node.parentNode = null; }
    return node;
  }
  insertAdjacentHTML(pos, html) { this.appendChild(new Raw(html)); }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null; }
  addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); }
  dispatch(type, ev) { (this._listeners[type] || []).forEach((fn) => fn(ev || {})); }
  // 真 scrollTo 认参数对象（{top, behavior}）；不传就按"滚到底"处理
  scrollTo(opts) {
    if (opts && typeof opts.top === 'number') this.scrollTop = opts.top;
    else this.scrollTop = this.scrollHeight;
  }
  // 复制兜底路径会调这两个（textarea + execCommand），真 DOM 有，这里给个空实现
  select() {}
  setSelectionRange() {}
  querySelector(sel) {
    const parts = String(sel).split(',').map((s) => s.trim());
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType !== 1) continue;
        for (const p of parts) {
          if (p.charAt(0) === '.' && child._classes.has(p.slice(1))) return child;
        }
        const found = walk(child);
        if (found) return found;
      }
      return null;
    };
    return walk(this);
  }
  /**
   * 支持 `tag`、`.cls` 和 `tag.cls`（如 `pre.md-code`）；够 app.js 用就行，
   * 不是通用实现 —— 不支持的写法一律不匹配（而不是抛错）。
   */
  querySelectorAll(sel) {
    const parts = String(sel).split(',').map((s) => s.trim()).filter(Boolean);
    const out = [];
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType !== 1) continue;
        for (const p of parts) {
          if (matchesPart(child, p)) { out.push(child); break; }
        }
        walk(child);
      }
    };
    walk(this);
    return out;
  }
}

function dump(node) { return node.textContent; }
function rawHtmlOf(node, out) {
  out = out || [];
  for (const c of node.childNodes) {
    if (c.nodeType === 4) out.push(c.html);
    if (c.nodeType === 1) rawHtmlOf(c, out);
  }
  return out;
}
function countClass(node, cls, acc) {
  acc = acc || { n: 0 };
  for (const c of node.childNodes) {
    if (c.nodeType !== 1) continue;
    if (c._classes.has(cls)) acc.n++;
    countClass(c, cls, acc);
  }
  return acc.n;
}
function findAll(node, cls, out) {
  out = out || [];
  for (const c of node.childNodes) {
    if (c.nodeType !== 1) continue;
    if (c._classes.has(cls)) out.push(c);
    findAll(c, cls, out);
  }
  return out;
}

/* ============================== fake 环境 ============================== */

const registry = {};
let fetchLog = [];
let routes = {};
let lastES = null;
let confirmAnswer = true;
let promptReplies = [];      // 每次 POST /api/prompt 依次取一个：{body,status} 或 deferred
let cancelReplies = [];
let fakeLocalStorage = {};    // P4：折叠状态的落盘替身
let sessionCalls = [];        // P4：POST /api/session 的调用记录

/** 手动控制的响应：先不回复，等测试里 reply() 再回。 */
function deferred() {
  let settle = null;
  const promise = new Promise((r) => { settle = r; });
  return {
    promise: promise,
    reply(body, status) { settle(resp(body, status)); }
  };
}

class FakeEventSource {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this._listeners = {};
    FakeEventSource.last = this;
    lastES = this;
  }
  addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); }
  close() { this.readyState = 2; }
  emit(type, data) { (this._listeners[type] || []).forEach((fn) => fn({ data: data })); }
}

function resp(obj, status) {
  const st = status === undefined ? 200 : status;
  const body = JSON.stringify(obj);
  return Promise.resolve({
    ok: st === 200, status: st,
    json: () => Promise.resolve(JSON.parse(body)),
    text: () => Promise.resolve(body)
  });
}
function tick() { return new Promise((r) => setTimeout(r, 0)); }

/**
 * 可派发事件的目标。
 * document / window 以前是空壳 addEventListener(){}，而"认领提问等待"正是靠
 * visibilitychange 与 pagehide 决定要不要放开认领 —— 不能派发就测不到。
 */
function makeEventTarget(extra) {
  const listeners = {};
  return Object.assign({
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener(type, fn) {
      const list = listeners[type];
      if (list) listeners[type] = list.filter((f) => f !== fn);
    },
    dispatch(type, event) { (listeners[type] || []).forEach((fn) => fn(event || { type: type })); }
  }, extra || {});
}

function buildDom(enablePrompt) {
  Object.keys(registry).forEach((k) => delete registry[k]);
  const html = fs.readFileSync(INDEX, 'utf8').replace('{{ENABLE_PROMPT}}', enablePrompt).replace('{{USERNAME}}', 'alice');
  const ids = [];
  const re = /id="([^"]+)"/g;
  let m;
  while ((m = re.exec(html)) !== null) ids.push({ id: m[1], index: m.index });
  ids.forEach((entry) => {
    const start = html.lastIndexOf('<', entry.index);
    const end = html.indexOf('>', entry.index);
    const tag = html.slice(start, end + 1);
    const el = new El('div');
    el.setAttribute('id', entry.id);
    // 从模板里认一下 hidden / disabled，否则 fake DOM 会漏掉这些初始状态
    if (/\shidden(\s|>)/.test(tag)) el.hidden = true;
    if (/\sdisabled(\s|>)/.test(tag)) el.disabled = true;
    registry[entry.id] = el;
  });
  const idList = ids.map((e) => e.id);

  const body = new El('body');
  body.setAttribute('data-enable-prompt', enablePrompt);
  // 把带 id 的节点挂到 body 下面，保证 isConnected 成立
  idList.forEach((id) => body.appendChild(registry[id]));
  ROOT = body;

  globalThis.document = makeEventTarget({
    readyState: 'complete',
    visibilityState: 'visible',
    body: body,
    createElement(t) { return new El(t); },
    createDocumentFragment() { return new Frag(); },
    createTextNode(t) { return new Txt(t); },
    getElementById(id) { return registry[id] || null; }
  });
  globalThis.window = makeEventTarget({ confirm: () => confirmAnswer });
  globalThis.location = { href: 'http://127.0.0.1:19388/' };
  globalThis.EventSource = FakeEventSource;
  // P4：折叠状态要真落盘才能验证"默认折叠 + 展开也存 0"。
  // Node 默认没有 localStorage（要 --experimental-webstorage），所以自己造一个。
  fakeLocalStorage = {};
  globalThis.localStorage = {
    getItem(k) { return Object.prototype.hasOwnProperty.call(fakeLocalStorage, k) ? fakeLocalStorage[k] : null; },
    setItem(k, v) { fakeLocalStorage[k] = String(v); },
    removeItem(k) { delete fakeLocalStorage[k]; },
    clear() { fakeLocalStorage = {}; }
  };
  globalThis.fetch = function (url, opts) {
    const method = String((opts && opts.method) || 'GET').toUpperCase();
    const rec = {
      url: String(url),
      method: method,
      headers: (opts && opts.headers) || {},
      keepalive: !!(opts && opts.keepalive),
      body: opts && opts.body !== undefined ? String(opts.body) : null
    };
    fetchLog.push(rec);
    const key = String(url).split('?')[0];
    const h = routes[method + ' ' + key] || (method === 'GET' ? routes[key] : null);
    // P3 新增的读接口：给个空壳默认值，免得每个场景都要显式声明。
    // 场景里想断言具体内容时，照旧在 routes 里覆盖即可。
    if (!h && method === 'GET') {
      if (key === '/api/models') return resp({ catalog: { default: null, routableProviders: [], groups: [], failures: [] } });
      if (key === '/api/presets') return resp({ presets: [] });
      if (key === '/api/questions') return resp({ items: [] });
    }
    // 认领等待：服务端默认"接受且认领成功"，场景里想验失败路径再覆盖它
    if (!h && method === 'POST' && key === '/api/questions/hold') return resp({ ok: true, held: true, claimed: true });
    if (!h) return resp({ error: 'not-found' }, 404);
    return h(rec);
  };
  return html;
}

function countCalls(prefix) {
  return fetchLog.filter((r) => r.url.indexOf(prefix) === 0).length;
}
function lastCall(prefix) {
  const hit = fetchLog.filter((r) => r.url.indexOf(prefix) === 0);
  return hit.length ? hit[hit.length - 1] : null;
}
/** app.js 把内部 state 挂在 globalThis.DSHMobileMirror 上，便于断言幂等状态。 */
function appState() {
  return globalThis.DSHMobileMirror.state;
}

let appExports = null;
function loadApp() {
  const tmp = path.join(os.tmpdir(), 'dsh-mm-dom-app-' + process.pid + '.cjs');
  fs.copyFileSync(APP_JS, tmp);
  delete require.cache[tmp];
  appExports = require(tmp);
  return tmp;
}

/* ============================== 用例 ============================== */

const NOW = Date.now();
const SESSIONS = {
  items: [
    { id: 's1', title: null, running: true, blank: false, agentAvailable: true, updatedAt: NOW - 90000, cwd: 'D:\\VibeCoding\\Plugin', origin: null, parentSessionId: null },
    { id: 's2', title: '另一个会话', running: false, blank: true, agentAvailable: false, updatedAt: NOW - 3 * 86400000, cwd: 'D:\\work\\proj', origin: null, parentSessionId: null }
  ]
};

const RECORDS = [
  { type: 'turn/start', seq: 1, time: NOW - 5000, data: { turn: 1 } },
  { type: 'user/message', seq: 2, time: NOW - 4900, data: { role: 'user', id: 'u1', blocks: [{ type: 'text', text: '帮我看看 <img src=x onerror=alert(1)>' }] } },
  { type: 'assistant/message', seq: 3, time: NOW - 4800, data: { role: 'assistant', blocks: [{ type: 'text', text: '**好**的' }, { type: 'reasoning', text: '先读文件' }], usage: { inputTokens: 1200, outputTokens: 30 }, interrupted: false, model: 'dsh-x' } },
  { type: 'tool/call', seq: 4, time: NOW - 4700, data: { callId: 'c1', name: 'read_file', args: '{"path":"a.js"}' } }
];

function snapshot(records, cursor, extra) {
  return JSON.stringify({
    e: 'snapshot',
    d: Object.assign({
      header: { id: 's1', cwd: 'D:\\VibeCoding\\Plugin', createdAt: NOW - 100000, agentPreset: 'default' },
      cursor: cursor, hasMore: false, records: records,
      projections: { title: '修 bug 的会话', model: 'dsh-x' },
      assistantStream: null
    }, extra || {})
  });
}

async function main() {
  console.log('\n[场景 A] ENABLE_PROMPT=yes 的完整交互');
  buildDom('yes');
  routes = {
    '/api/sessions': () => resp(SESSIONS),
    '/api/page': () => resp({ records: [
      { type: 'turn/start', seq: -1, time: NOW - 9000, data: { turn: 0 } },
      { type: 'user/message', seq: 0, time: NOW - 8900, data: { role: 'user', id: 'u0', blocks: [{ type: 'text', text: 'OLDERMARK' }] } }
    ], hasMore: false })
  };
  fetchLog = [];
  let tmpPath = null;
  let threw = null;
  try { tmpPath = loadApp(); } catch (e) { threw = e; }
  ok('boot() 不抛错（也说明 app.js 用到的 id 在 index.html 里都存在）', !threw, threw && threw.stack);
  if (threw) { summary(); return; }

  await tick();
  const list = registry['list'];
  eq('会话列表渲染 2 行', findAll(list, 'session').length, 2);
  // P3-A：列表按工作区分组，行标题不再重复文件夹名（分组头上已经写了完整路径）
  eq('title=null 时不再重复文件夹名', findAll(list, 'session-title')[0].textContent, '未命名会话');
  ok('相对时间显示 1 分钟前', findAll(list, 'session-sub')[0].textContent.indexOf('1 分钟前') !== -1, findAll(list, 'session-sub')[0].textContent);
  eq('按工作区分成 2 组', findAll(list, 'group').length, 2);
  eq('分组头显示文件夹名', findAll(list, 'group-name').map((n) => n.textContent).sort().join(','), 'Plugin,proj');
  eq('分组头显示会话数', findAll(list, 'group-count')[0].textContent, '1');
  eq('分组头显示完整路径（首尾保留）', findAll(list, 'group-path')[0].textContent, 'D:\\…\\Plugin');
  // 组头（有成员在跑）+ 会话行，各一个脉冲点
  eq('running 组头与会话行各有一个脉冲点', findAll(list, 'dot').filter((d) => d._classes.has('on')).length, 2);
  eq('列表错误框隐藏', registry['list-error'].hidden, true);
  eq('输入区可见（ENABLE_PROMPT=yes）', registry['composer'].hidden, false);
  eq('P2 起 textarea 可用（不再禁用）', registry['composer-input'].disabled, false);
  eq('空内容时发送按钮禁用', registry['composer-send'].disabled, true);
  eq('未运行时没有停止按钮', registry['btn-stop'].hidden, true);

  eq('自动进入最近更新的 running 会话', registry['view-chat'].hidden, false);
  ok('EventSource 连到了 s1', !!lastES && lastES.url.indexOf('id=s1') !== -1, lastES && lastES.url);

  // ---- snapshot ----
  const es = lastES;
  es.emit('message', snapshot(RECORDS, 4, { hasMore: true }));
  const stream = registry['stream'];
  let text = dump(stream);
  eq('标题取 projections.title', registry['chat-title'].textContent, '修 bug 的会话');
  ok('渲染了第 1 轮分隔', text.indexOf('第 1 轮') !== -1);
  ok('用户消息里的 XSS 只以文本节点存在（未生成 HTML）',
    text.indexOf('<img src=x onerror=alert(1)>') !== -1 && rawHtmlOf(stream).every((h) => h.indexOf('onerror') === -1));
  ok('assistant Markdown 粗体渲染', text.indexOf('<strong>好</strong>') !== -1);
  ok('reasoning 收进「工作过程」折叠卡',
    countClass(stream, 'work-reason') === 1 && countClass(stream, 'reason') === 0);
  ok('tool/call 折叠卡片存在', countClass(stream, 'tool') === 1);
  ok('usage 小字存在', text.indexOf('输入 1.2k') !== -1);
  eq('末尾没有 turn/end → 判定为运行中', registry['chat-sub'].textContent.indexOf('运行中'), 0);
  es.emit('message', JSON.stringify({ e: 'event', d: { type: 'turn/end', seq: 4.5, time: NOW, data: { turn: 1, reason: 'completed' } } }));
  eq('收到 turn/end 后回到空闲', registry['chat-sub'].textContent.indexOf('空闲'), 0);
  ok('turn/end 显示完成文案', dump(stream).indexOf('本轮完成') !== -1);

  // ---- 逐字流式 ----
  es.emit('stream', JSON.stringify({ e: 'stream', d: { k: 'start', turn: 2, step: 1 } }));
  es.emit('stream', JSON.stringify({ e: 'stream', d: { k: 'text', i: 0, t: '流式' } }));
  es.emit('stream', JSON.stringify({ e: 'stream', d: { k: 'text', i: 0, t: '内容XYZ' } }));
  es.emit('stream', JSON.stringify({ e: 'stream', d: { k: 'reason', i: 1, t: '边想边说' } }));
  text = dump(stream);
  ok('临时气泡出现"正在输出…"', text.indexOf('正在输出…') !== -1);
  ok('逐字追加后是完整片段', text.indexOf('流式内容XYZ') !== -1);
  ok('思考帧进入折叠块', text.indexOf('边想边说') !== -1);
  eq('运行中状态', registry['chat-sub'].textContent.indexOf('运行中'), 0);
  eq('临时气泡只有一个', countClass(stream, 'live'), 1);

  // ---- 最终 assistant/message 替换临时气泡 ----
  es.emit('message', JSON.stringify({ e: 'event', d: { type: 'assistant/message', seq: 5, time: NOW, data: { role: 'assistant', blocks: [{ type: 'text', text: '最终内容ABC' }], usage: { outputTokens: 7 }, interrupted: true, model: 'dsh-y' } } }));
  text = dump(stream);
  eq('临时气泡已被移除', countClass(stream, 'live'), 0);
  eq('最终内容只出现一次（无重复）', text.split('最终内容ABC').length - 1, 1);
  eq('临时气泡内容不再残留', text.indexOf('流式内容XYZ'), -1);
  ok('interrupted 标注', text.indexOf('已中断') !== -1);

  // ---- 去重：重复 seq 丢弃 ----
  es.emit('message', JSON.stringify({ e: 'event', d: { type: 'assistant/message', seq: 5, time: NOW, data: { role: 'assistant', blocks: [{ type: 'text', text: '最终内容ABC' }], usage: null, interrupted: false, model: null } } }));
  eq('同 seq 事件被去重', dump(stream).split('最终内容ABC').length - 1, 1);

  // ---- tool/result 归并 ----
  es.emit('message', JSON.stringify({ e: 'event', d: { type: 'tool/result', seq: 6, time: NOW, data: { callId: 'c1', isError: false, blocks: [{ type: 'text', text: 'RESULTMARK' }], error: null } } }));
  text = dump(stream);
  eq('tool/result 归并进已有卡片（未新增卡片）', countClass(stream, 'tool'), 1);
  ok('结果内容出现在卡片里', text.indexOf('RESULTMARK') !== -1);
  ok('卡片上打了完成标记', text.indexOf('完成') !== -1);

  es.emit('message', JSON.stringify({ e: 'event', d: { type: 'tool/result', seq: 7, time: NOW, data: { callId: 'c9', isError: true, blocks: [], error: { name: 'Error', code: 'E_NO' } } } }));
  ok('找不到卡片的 result 单独渲染并标红', findAll(stream, 'tool-error').length === 1 && dump(stream).indexOf('E_NO') !== -1);

  // ---- 重连：snapshot 重建不重复 ----
  const again = RECORDS.concat([
    { type: 'assistant/message', seq: 5, time: NOW, data: { role: 'assistant', blocks: [{ type: 'text', text: 'SNAPONLY' }], usage: null, interrupted: false, model: null } }
  ]);
  es.emit('message', snapshot(again, 5, { hasMore: true }));
  text = dump(stream);
  eq('重连重建后 SNAPONLY 只出现一次', text.split('SNAPONLY').length - 1, 1);
  eq('重连重建后没有残留旧临时气泡', countClass(stream, 'live'), 0);
  eq('重连重建后 tool 卡片仍只有 1 张', countClass(stream, 'tool'), 1);

  // ---- abandoned 帧清掉临时气泡 ----
  es.emit('stream', JSON.stringify({ e: 'stream', d: { k: 'start', turn: 3, step: 1 } }));
  es.emit('stream', JSON.stringify({ e: 'stream', d: { k: 'text', i: 0, t: 'ABANDONEDTEXT' } }));
  es.emit('stream', JSON.stringify({ e: 'stream', d: { k: 'end', outcome: 'abandoned' } }));
  eq('abandoned 后临时气泡被清掉', dump(stream).indexOf('ABANDONEDTEXT'), -1);

  // ---- 往上翻历史 ----
  const beforeChildren = stream.childNodes.length;
  const beforeHeight = stream.scrollHeight;
  stream.scrollTop = 0;
  fetchLog = [];
  stream.dispatch('scroll');
  stream.dispatch('scroll');
  stream.dispatch('scroll');
  await tick(); await tick();
  eq('/api/page 只请求一次（并发去重）', countCalls('/api/page'), 1);
  eq('更早的记录插到了最前面', stream.childNodes.length, beforeChildren + 2);
  ok('插入后 scrollTop 被补偿（视觉位置不跳）', stream.scrollTop === beforeHeight * 0 + (stream.scrollHeight - beforeHeight), 'scrollTop=' + stream.scrollTop);
  eq('老记录渲染在最前', stream.firstChild.textContent.indexOf('OLDERMARK') !== -1 || dump(stream.childNodes[0]).indexOf('第 0 轮') !== -1, true);
  eq('hasMore=false 后不再请求', (fetchLog = [], stream.scrollTop = 0, stream.dispatch('scroll'), await tick(), fetchLog.length), 0);

  // ---- 调试面板 ----
  eq('调试面板默认收起', registry['debug'].hidden, true);
  registry['btn-raw'].dispatch('click');
  eq('点"原始"后展开', registry['debug'].hidden, false);
  eq('调试面板记录数 > 0', Number(registry['debug-count'].textContent) > 0, true);
  ok('调试面板里有 snapshot 信封', dump(registry['debug-body']).indexOf('snapshot') !== -1);
  registry['btn-debug-clear'].dispatch('click');
  eq('清空后计数为 0', registry['debug-count'].textContent, '0');
  registry['btn-debug-close'].dispatch('click');
  eq('收起后隐藏', registry['debug'].hidden, true);

  // ---- 回到最新按钮 ----
  ok('滚上去后显示"回到最新"', registry['btn-bottom'].hidden === false);
  registry['btn-bottom'].dispatch('click');
  eq('点击后按钮隐藏', registry['btn-bottom'].hidden, true);
  eq('点击后吸底', stream.scrollTop, stream.scrollHeight);

  // ---- 会话列表加载失败 ----
  routes['/api/sessions'] = () => resp({ error: 'session-controller-unavailable' }, 503);
  registry['btn-back'].dispatch('click');
  await tick(); await tick();
  eq('返回列表后隐藏对话视图', registry['view-chat'].hidden, true);
  eq('失败时显示错误框', registry['list-error'].hidden, false);
  ok('503 error 码翻译成人话', registry['list-error-text'].textContent.indexOf('会话控制器不可用') !== -1, registry['list-error-text'].textContent);
  ok('错误框里有重试按钮', !!registry['btn-list-retry']);

  routes['/api/sessions'] = () => resp({ error: 'list-failed', message: '读取会话列表失败：boom' }, 500);
  registry['btn-list-retry'].dispatch('click');
  await tick(); await tick();
  ok('未知错误码时展示服务端 message', registry['list-error-text'].textContent.indexOf('boom') !== -1, registry['list-error-text'].textContent);

  console.log('\n[场景 B] ENABLE_PROMPT=no');
  const htmlB = buildDom('no');
  routes = { '/api/sessions': () => resp({ items: [] }) };
  fetchLog = [];
  threw = null;
  try { loadApp(); } catch (e) { threw = e; }
  ok('ENABLE_PROMPT=no 时 boot 不抛错', !threw, threw && threw.stack);
  await tick();
  eq('输入区整个不显示', registry['composer'].hidden, true);
  eq('空列表给引导文案', registry['list-empty'].hidden, false);
  ok('引导文案在模板里', htmlB.indexOf('还没有会话') !== -1 && htmlB.indexOf('在电脑上开一段对话') !== -1);

  await scenarioP2();
  await scenarioP3();
  await scenarioP4();
  await scenarioP5();
  await scenarioG();
  await scenarioH();
  await scenarioI();
  await scenarioSubagent();
  await scenarioTurnFailure();
  await scenarioRail();
  await scenarioWorkFold();

  summary();
}

/* ============================== 场景 C：P2 发送 / 停止 ============================== */

function userMessageEvent(seq, text) {
  return JSON.stringify({
    e: 'event',
    d: { type: 'user/message', seq: seq, time: NOW, data: { role: 'user', id: 'u' + seq, blocks: [{ type: 'text', text: text }] } }
  });
}

async function scenarioP2() {
  console.log('\n[场景 C] P2 发送 / 乐观回显 / 幂等重试 / 停止');
  buildDom('yes');
  confirmAnswer = true;
  promptReplies = [];
  cancelReplies = [];
  routes = {
    '/api/sessions': () => resp({ items: [
      { id: 's1', title: 'P2 会话', running: false, blank: false, agentAvailable: true, updatedAt: NOW, cwd: 'D:\\VibeCoding\\Plugin' }
    ] }),
    'POST /api/prompt': () => {
      const next = promptReplies.shift();
      if (!next) return resp({ accepted: true, duplicate: false });
      return next.promise ? next.promise : resp(next.body, next.status);
    },
    'POST /api/cancel': () => {
      const next = cancelReplies.shift();
      if (!next) return resp({ accepted: true });
      return next.promise ? next.promise : resp(next.body, next.status);
    }
  };
  fetchLog = [];
  let threw = null;
  try { loadApp(); } catch (e) { threw = e; }
  ok('P2 boot 不抛错', !threw, threw && threw.stack);
  if (threw) return;
  await tick();

  // 进会话
  findAll(registry['list'], 'session')[0].dispatch('click');
  const es = lastES;
  es.emit('message', snapshot([], 0, { projections: { title: 'P2 会话' } }));
  const stream = registry['stream'];
  const input = registry['composer-input'];
  const sendBtn = registry['composer-send'];
  const stopBtn = registry['btn-stop'];

  eq('进入会话视图', registry['view-chat'].hidden, false);
  eq('未运行时停止按钮不存在', stopBtn.hidden, true);
  eq('空输入时发送按钮禁用', sendBtn.disabled, true);

  // ---- 输入区行为 ----
  input.value = '你好';
  input.dispatch('input');
  eq('有内容后发送按钮可用', sendBtn.disabled, false);
  eq('短文本不显示字数', registry['composer-count'].hidden, true);

  // 上限与提示线都从 app.js 取，不写死 —— 见 web-pure-test.cjs 里同一处的说明
  const PROMPT_MAX = appExports.PROMPT_MAX;
  const PROMPT_AT = appExports.PROMPT_COUNTER_AT;
  input.value = 'x'.repeat(PROMPT_AT + 1);
  input.dispatch('input');
  eq('过提示线显示字数', registry['composer-count'].textContent, (PROMPT_AT + 1) + '/' + PROMPT_MAX);
  eq('未超限不算 over', registry['composer-count']._classes.has('over'), false);
  input.value = 'x'.repeat(PROMPT_MAX + 1);
  input.dispatch('input');
  eq('超限时标红', registry['composer-count']._classes.has('over'), true);
  eq('超限时发送按钮禁用', sendBtn.disabled, true);

  input.value = '你好';
  input.dispatch('input');
  eq('回到正常文本后按钮可用', sendBtn.disabled, false);

  // ---- Enter 行为 ----
  const enterEv = { key: 'Enter', ctrlKey: false, metaKey: false, preventDefault() { this.defaultPrevented = true; } };
  input.dispatch('keydown', enterEv);
  eq('手机端 Enter 不发送（保持换行）', countCalls('/api/prompt'), 0);
  eq('手机端 Enter 不 preventDefault', !!enterEv.defaultPrevented, false);

  // ---- 乐观回显 ----
  const first = deferred();
  promptReplies.push(first);
  const ctrlEv = { key: 'Enter', ctrlKey: true, metaKey: false, preventDefault() { this.defaultPrevented = true; } };
  input.dispatch('keydown', ctrlEv);
  eq('Ctrl+Enter 触发发送', countCalls('/api/prompt'), 1);
  eq('Ctrl+Enter 被 preventDefault', !!ctrlEv.defaultPrevented, true);
  eq('立刻出现"发送中"气泡', countClass(stream, 'pending'), 1);
  ok('气泡里是刚发的文本', dump(stream).indexOf('你好') !== -1);
  eq('发送后输入框被清空', input.value, '');
  eq('发送中按钮禁用', sendBtn.disabled, true);

  const call1 = lastCall('/api/prompt');
  eq('POST 方法', call1.method, 'POST');
  eq('Content-Type 是 JSON', call1.headers['Content-Type'], 'application/json');
  const body1 = JSON.parse(call1.body);
  eq('payload.sessionId', body1.sessionId, 's1');
  eq('payload.text', body1.text, '你好');
  ok('payload.requestId 合法: ' + body1.requestId, /^[A-Za-z0-9_-]{1,128}$/.test(body1.requestId));
  ok('payload.timeZone 非空', typeof body1.timeZone === 'string' && body1.timeZone.length > 0, body1.timeZone);

  // ---- 发送中连点不会重复发（第一条还在飞） ----
  input.value = '连点';
  input.dispatch('input');
  sendBtn.dispatch('click');
  sendBtn.dispatch('click');
  eq('发送中连点不会再发', countCalls('/api/prompt'), 1);
  eq('连点后输入框内容没被清掉（说明第二次被挡下）', input.value, '连点');

  // ---- 成功：等 user/message 事件到了才撤气泡 ----
  first.reply({ accepted: true, duplicate: false }, 200);
  await tick(); await tick();
  eq('成功后气泡先留着等回显', countClass(stream, 'pending'), 1);
  eq('成功后 sending 归位', appState().sendingId, null);
  es.emit('message', userMessageEvent(10, '你好'));
  eq('收到 user/message 后气泡撤掉', countClass(stream, 'pending'), 0);
  eq('消息只出现一次（没有重复）', dump(stream).split('你好').length - 1, 1);
  eq('回显后没有条目在等回显', appState().pending.filter((e) => !e.failed).length, 0);

  // ---- 失败：撤气泡 + 文本回到输入框 + requestId 保留 ----
  input.value = '会失败的文本';
  input.dispatch('input');
  promptReplies.push({ body: { error: 'too-fast', message: '发送太快了，稍等一下' }, status: 429 });
  sendBtn.dispatch('click');
  await tick(); await tick(); await tick();
  eq('失败后气泡撤掉', countClass(stream, 'pending'), 0);
  eq('失败后文本回到输入框', input.value, '会失败的文本');
  ok('失败 toast 显示服务端文案', registry['toast'].textContent.indexOf('发送太快了') !== -1, registry['toast'].textContent);
  eq('失败 toast 可见', registry['toast'].hidden, false);
  eq('失败后发送按钮恢复可用', sendBtn.disabled, false);

  const failBody = JSON.parse(lastCall('/api/prompt').body);
  eq('失败后 requestId 被保留（等重试复用）', appState().pending[0].requestId, failBody.requestId);
  eq('失败后 pending.text 被保留', appState().pending[0].text, '会失败的文本');
  eq('失败后条目还在队列里', appState().pending.length, 1);
  eq('失败后条目标记为 failed（不在等回显）', appState().pending[0].failed, true);

  // ---- 改动文本后换新 id ----
  input.value = '改过的文本';
  input.dispatch('input');
  promptReplies.push({ body: { error: 'too-fast', message: '太快' }, status: 429 });
  sendBtn.dispatch('click');
  await tick(); await tick(); await tick();
  const changedBody = JSON.parse(lastCall('/api/prompt').body);
  ok('改动文本后换了新 requestId', changedBody.requestId !== failBody.requestId,
    changedBody.requestId + ' vs ' + failBody.requestId);

  // ---- 重试复用同一个 requestId ----
  input.dispatch('input');
  promptReplies.push({ body: { accepted: true, duplicate: false }, status: 200 });
  sendBtn.dispatch('click');
  await tick(); await tick();
  const retryBody = JSON.parse(lastCall('/api/prompt').body);
  eq('重试复用同一个 requestId', retryBody.requestId, changedBody.requestId);
  eq('重试文本不变', retryBody.text, '改过的文本');
  es.emit('message', userMessageEvent(11, '改过的文本'));
  eq('回显后没有条目在等回显（下次发送会换新 id）', appState().pending.filter((e) => !e.failed).length, 0);

  // ---- duplicate=true 视为成功，不报错 ----
  registry['toast'].hidden = true;
  registry['toast'].textContent = '';
  input.value = '重复发送';
  input.dispatch('input');
  promptReplies.push({ body: { accepted: true, duplicate: true }, status: 200 });
  sendBtn.dispatch('click');
  await tick(); await tick();
  eq('duplicate 不报错（无 toast）', registry['toast'].hidden, true);
  eq('duplicate 后气泡仍在等回显', countClass(stream, 'pending'), 1);
  es.emit('message', userMessageEvent(13, '重复发送'));
  eq('duplicate 的回显到了也撤气泡', countClass(stream, 'pending'), 0);

  // ---- 403 / 503 文案 ----
  input.value = '被关掉';
  input.dispatch('input');
  promptReplies.push({ body: { error: 'prompt-disabled', message: '写操作已关闭' }, status: 403 });
  sendBtn.dispatch('click');
  await tick(); await tick(); await tick();
  ok('403 提示写操作被关闭', registry['toast'].textContent.indexOf('配置关闭') !== -1, registry['toast'].textContent);

  input.value = '控制器没了';
  input.dispatch('input');
  promptReplies.push({ body: { error: 'session-controller-unavailable', message: '未就绪' }, status: 503 });
  sendBtn.dispatch('click');
  await tick(); await tick(); await tick();
  ok('503 提示控制器不可用', registry['toast'].textContent.indexOf('会话控制器不可用') !== -1, registry['toast'].textContent);
  input.value = '';
  input.dispatch('input');

  // ---- 停止按钮：页面内二次确认 ----
  // 为什么不用 window.confirm：APK 是 WebView 外壳，MainActivity 只设了 WebViewClient、
  // 没设 WebChromeClient，Android 在没人接管 onJsConfirm 时让 confirm() **直接返回 false**
  // —— 点「停止」等于什么都没发生。所以下面把 confirm 钉成 false 来跑这一整段。
  confirmAnswer = false;
  eq('空闲时停止按钮隐藏', stopBtn.hidden, true);
  es.emit('message', JSON.stringify({ e: 'event', d: { type: 'turn/start', seq: 20, time: NOW, data: { turn: 2 } } }));
  eq('运行中停止按钮出现', stopBtn.hidden, false);

  cancelReplies = [];          // 上膛阶段不该发出任何请求，所以不留响应
  stopBtn.dispatch('click');
  await tick();
  eq('第一下只上膛，不请求 /api/cancel', countCalls('/api/cancel'), 0);
  eq('上膛时按钮自己写着要确认', stopBtn.textContent, '确认停止？');
  ok('上膛有样式类', stopBtn.classList.contains('armed'));
  ok('上膛时给了提示', registry['toast'].textContent.indexOf('再点一次') !== -1, registry['toast'].textContent);

  // 上膛后 3 秒没再点要自己复位，否则按钮会一直卡在"确认停止？"上
  await new Promise((r) => setTimeout(r, 3100));
  eq('3 秒没再点就自动复位', stopBtn.textContent, '停止');
  ok('复位后不再是上膛态', !stopBtn.classList.contains('armed'));
  eq('复位后仍可用', stopBtn.disabled, false);

  const cancelDefer = deferred();
  cancelReplies.push(cancelDefer);
  stopBtn.dispatch('click');
  await tick();
  eq('再点一下重新上膛', stopBtn.textContent, '确认停止？');
  stopBtn.dispatch('click');
  await tick();
  eq('第二下才请求 /api/cancel（confirm 恒为 false 也不受影响）', countCalls('/api/cancel'), 1);
  eq('停止请求体只有 sessionId', lastCall('/api/cancel').body, JSON.stringify({ sessionId: 's1' }));
  eq('停止请求进行中按钮禁用', stopBtn.disabled, true);
  stopBtn.dispatch('click');
  eq('停止进行中连点不会再发', countCalls('/api/cancel'), 1);
  cancelDefer.reply({ accepted: true }, 200);
  await tick(); await tick();
  eq('停止完成后按钮恢复可用', stopBtn.disabled, false);
  eq('停止完成后按钮文案复位', stopBtn.textContent, '停止');
  ok('停止成功给了提示', registry['toast'].textContent.indexOf('已请求停止') !== -1, registry['toast'].textContent);

  // ---- 停止失败文案 ----
  cancelReplies.push({ body: { error: 'cancel-failed', message: '上游炸了' }, status: 502 });
  stopBtn.dispatch('click');
  await tick();
  stopBtn.dispatch('click');
  await tick(); await tick(); await tick();
  ok('停止失败提示上游报错', registry['toast'].textContent.indexOf('停止失败') !== -1, registry['toast'].textContent);
  confirmAnswer = true;

  // ---- 重连 snapshot 里已经有我这条消息 → 不重复挂气泡 ----
  es.emit('message', userMessageEvent(30, '重连前发的'));
  await tick();
  input.value = '重连前发的';
  input.dispatch('input');
  const deferSnap = deferred();
  promptReplies.push(deferSnap);
  sendBtn.dispatch('click');
  await tick();
  eq('重连前：气泡在', countClass(stream, 'pending'), 1);
  es.emit('message', snapshot([
    { type: 'user/message', seq: 30, time: NOW, data: { role: 'user', id: 'u30', blocks: [{ type: 'text', text: '重连前发的' }] } }
  ], 30, { projections: { title: 'P2 会话' } }));
  eq('snapshot 里已有这条消息 → 气泡不再挂回', countClass(stream, 'pending'), 0);
  deferSnap.reply({ accepted: true, duplicate: false }, 200);
  await tick(); await tick();
  eq('snapshot 命中后消息仍只有一条', dump(stream).split('重连前发的').length - 1, 1);

  // ---- 乐观回显里的 HTML 只能当文本 ----
  const XSS = '<img src=x onerror=alert(1)>';
  input.value = XSS;
  input.dispatch('input');
  const xssDefer = deferred();
  promptReplies.push(xssDefer);
  sendBtn.dispatch('click');
  await tick();
  ok('"发送中"气泡里的 HTML 没有被解析',
    dump(stream).indexOf(XSS) !== -1 && rawHtmlOf(stream).every((h) => h.indexOf('onerror') === -1));
  xssDefer.reply({ accepted: true, duplicate: false }, 200);
  await tick();
  es.emit('message', userMessageEvent(40, XSS));
  await tick();
  eq('XSS 文本回显后气泡撤掉', countClass(stream, 'pending'), 0);

  // ================= 回归：多条消息同时等回显 =================
  // 缺陷场景：A 已受理、气泡还在等回显时又发 B，旧实现会把 A 的气泡引用覆盖成孤儿，
  // 之后 A 的回显删掉的是 B 的气泡。排队模式下（mode=queue）这个窗口很长。
  console.log('  -- 回归：待回显队列 --');
  const sendText = async (text, reply) => {
    input.value = text;
    input.dispatch('input');
    const d = reply ? deferred() : null;
    if (d) promptReplies.push(d); else promptReplies.push({ body: { accepted: true, duplicate: false }, status: 200 });
    sendBtn.dispatch('click');
    await tick();
    if (d) { d.reply(reply.body, reply.status); await tick(); await tick(); }
    return d;
  };
  // 队列里分两类条目：等回显的（!failed）和失败待重试的（failed）。
  // 前面失败路径留下的条目会一直留着（这是复用 requestId 的机制），所以断言要分开看。
  const waitingTexts = () => appState().pending.filter((e) => !e.failed).map((e) => e.text).join(',');
  const failedTexts = () => appState().pending.filter((e) => e.failed).map((e) => e.text).join(',');
  const entryOf = (t) => appState().pending.filter((e) => e.text === t)[0];
  const staleFailures = failedTexts();
  ok('前面失败路径留下的待重试条目还在（供复用 id）', staleFailures.indexOf('会失败的文本') !== -1, staleFailures);

  await sendText('队列A');
  eq('A 受理后只有 A 在等回显', waitingTexts(), '队列A');
  eq('A 的气泡在 DOM 上', countClass(stream, 'pending'), 1);

  await sendText('队列B');
  eq('A 还没回显也能发 B（两个气泡同时挂着）', countClass(stream, 'pending'), 2);
  eq('两条都在等回显，按发送顺序', waitingTexts(), '队列A,队列B');
  const qIdA = entryOf('队列A').requestId;
  const qIdB = entryOf('队列B').requestId;
  ok('A/B 是两个不同的 requestId', qIdA !== qIdB, qIdA + ' vs ' + qIdB);

  es.emit('message', userMessageEvent(60, '队列A'));
  eq('回显 A 后只剩 B 的气泡（A 不是孤儿）', countClass(stream, 'pending'), 1);
  eq('回显 A 后只剩 B 在等回显', waitingTexts(), '队列B');
  ok('DOM 里留下的是 B 的气泡', dump(stream).indexOf('队列B') !== -1);
  eq('回显 A 没动 B 的 requestId', entryOf('队列B').requestId, qIdB);
  eq('回显 A 没动那些失败条目', failedTexts(), staleFailures);
  eq('A 只渲染一次（没有本地重复）', dump(stream).split('队列A').length - 1, 1);

  es.emit('message', userMessageEvent(61, '队列B'));
  eq('回显 B 后气泡全撤', countClass(stream, 'pending'), 0);
  eq('回显 B 后没有条目在等回显', waitingTexts(), '');
  eq('B 只渲染一次', dump(stream).split('队列B').length - 1, 1);

  // ---- 失败路径：A 失败保留 id → 发 B → B 的回显不能吃掉 A → 重试 A 复用 A 的 id ----
  await sendText('失败保留A', { body: { error: 'too-fast', message: '太快' }, status: 429 });
  const keepIdA = entryOf('失败保留A').requestId;
  eq('A 失败后条目仍在队列里（留着 id）', entryOf('失败保留A').failed, true);
  eq('A 失败后它不在等回显', waitingTexts(), '');
  eq('A 失败后没有气泡残留', countClass(stream, 'pending'), 0);

  await sendText('成功B');
  eq('B 受理后是 B 在等回显', waitingTexts(), '成功B');
  eq('B 的气泡在（A 的失败条目不会顶掉它）', countClass(stream, 'pending'), 1);

  es.emit('message', userMessageEvent(70, '成功B'));
  eq('B 的回显只消费 B', countClass(stream, 'pending'), 0);
  eq('B 回显后没有条目在等回显', waitingTexts(), '');
  eq('B 的回显没吃掉 A 的失败条目', entryOf('失败保留A').failed, true);

  input.value = '失败保留A';
  input.dispatch('input');
  promptReplies.push({ body: { accepted: true, duplicate: false }, status: 200 });
  sendBtn.dispatch('click');
  await tick(); await tick();
  eq('重试 A 复用原来的 requestId', JSON.parse(lastCall('/api/prompt').body).requestId, keepIdA);
  eq('复用后队列里只有一个 A（不会出现两个同 id 条目）',
    appState().pending.filter((e) => e.requestId === keepIdA).length, 1);
  eq('重试 A 后气泡重新出现', countClass(stream, 'pending'), 1);
  es.emit('message', userMessageEvent(71, '失败保留A'));
  eq('重试 A 的回显后气泡撤掉、队列里没有等回显的了',
    countClass(stream, 'pending') + waitingTexts().length, 0);

  // ---- 失败只撤自己那一个：D 失败时 C 的气泡不受影响 ----
  await sendText('先成功的C');
  eq('C 在等回显', waitingTexts(), '先成功的C');
  await sendText('后失败的D', { body: { error: 'prompt-failed', message: '炸了' }, status: 502 });
  eq('D 失败只撤 D 的气泡，C 还在', countClass(stream, 'pending'), 1);
  eq('D 失败后只有 C 在等回显', waitingTexts(), '先成功的C');
  eq('D 变成失败待重试条目', entryOf('后失败的D').failed, true);
  eq('D 是最新一条 → 文本回填', input.value, '后失败的D');
  es.emit('message', userMessageEvent(80, '先成功的C'));
  eq('C 的回显撤 C 的气泡，D 的失败条目留着', countClass(stream, 'pending'), 0);
  eq('C 回显后没有条目在等回显', waitingTexts(), '');
  eq('D 的失败条目没被吃掉', entryOf('后失败的D').failed, true);

  // ---- 失败回填不能冲掉用户正在打的内容 ----
  input.value = '在飞的消息';
  input.dispatch('input');
  const busyDefer = deferred();
  promptReplies.push(busyDefer);
  sendBtn.dispatch('click');
  await tick();
  input.value = '我正在打新内容';     // 请求还在飞的时候用户开始打下一条
  input.dispatch('input');
  busyDefer.reply({ error: 'too-fast', message: '太快' }, 429);
  await tick(); await tick(); await tick();
  eq('失败不冲掉用户正在输入的内容', input.value, '我正在打新内容');
  ok('提示里说明了原文没回填', registry['toast'].textContent.indexOf('避免冲掉') !== -1, registry['toast'].textContent);
  eq('原文没丢：失败条目还在队列里', entryOf('在飞的消息').failed, true);
  eq('原文没丢：条目里存着原文', entryOf('在飞的消息').text, '在飞的消息');

  // ---- snapshot 重建：只对账掉 records 里出现的那条 ----
  await sendText('快照A');
  await sendText('快照B');
  eq('快照前两条在等回显', waitingTexts(), '快照A,快照B');
  eq('快照前两个气泡', countClass(stream, 'pending'), 2);
  es.emit('message', snapshot([
    { type: 'user/message', seq: 90, time: NOW, data: { role: 'user', id: 'u90', blocks: [{ type: 'text', text: '快照A' }] } }
  ], 90, { projections: { title: 'P2 会话' } }));
  eq('snapshot 只对账掉 A', waitingTexts(), '快照B');
  eq('snapshot 后只剩 B 的气泡', countClass(stream, 'pending'), 1);
  es.emit('message', snapshot([
    { type: 'user/message', seq: 90, time: NOW, data: { role: 'user', id: 'u90', blocks: [{ type: 'text', text: '快照A' }] } },
    { type: 'user/message', seq: 91, time: NOW, data: { role: 'user', id: 'u91', blocks: [{ type: 'text', text: '快照B' }] } }
  ], 91, { projections: { title: 'P2 会话' } }));
  eq('snapshot 里两条都有 → 没有等回显的了', waitingTexts(), '');
  eq('snapshot 后没有气泡残留', countClass(stream, 'pending'), 0);

  // ---- 失败后退回列表再重进同一个会话，重试仍复用同一个 requestId ----
  input.value = '跨视图重试';
  input.dispatch('input');
  promptReplies.push({ body: { error: 'prompt-failed', message: '上游炸了' }, status: 502 });
  sendBtn.dispatch('click');
  await tick(); await tick(); await tick();
  const crossBody = JSON.parse(lastCall('/api/prompt').body);
  ok('502 提示上游报错', registry['toast'].textContent.indexOf('上游报错') !== -1, registry['toast'].textContent);

  registry['btn-back'].dispatch('click');
  await tick(); await tick();
  findAll(registry['list'], 'session')[0].dispatch('click');
  await tick();
  const es2 = lastES;
  es2.emit('message', snapshot([], 0, { projections: { title: 'P2 会话' } }));
  input.value = '跨视图重试';
  input.dispatch('input');
  promptReplies.push({ body: { accepted: true, duplicate: false }, status: 200 });
  sendBtn.dispatch('click');
  await tick(); await tick();
  eq('换视图回来重试仍复用同一个 requestId',
    JSON.parse(lastCall('/api/prompt').body).requestId, crossBody.requestId);
  eq('跨视图重试后气泡重新出现', countClass(stream, 'pending'), 1);
  es2.emit('message', userMessageEvent(50, '跨视图重试'));
  eq('跨视图回显后气泡撤掉', countClass(stream, 'pending'), 0);
}

/* ============================== 场景 D：P3 分组 / 模型 / 模式 / 提问 ============================== */

async function scenarioP3() {
  console.log('\n[场景 D] P3 分组 / 模型 / 模式 / 提问');
  buildDom('yes');

  const d1 = { id: 'd1', title: '甲会话', running: false, blank: false, agentAvailable: true, updatedAt: NOW - 1000, cwd: 'D:\\proj\\alpha' };
  const d2 = { id: 'd2', title: null, running: false, blank: true, agentAvailable: true, updatedAt: NOW - 2000, cwd: 'D:\\proj\\alpha' };
  const d3 = { id: 'd3', title: '乙会话', running: false, blank: true, agentAvailable: true, updatedAt: NOW - 3000, cwd: '' };

  routes = {
    '/api/sessions': () => resp({
      items: [d1, d2, d3],
      groups: [
        { key: 'd:\\proj\\alpha', name: 'alpha', path: 'D:\\proj\\alpha', items: [d1, d2], updatedAt: NOW - 1000, running: false },
        { key: '', name: '无工作区', path: null, items: [d3], updatedAt: NOW - 3000, running: false }
      ]
    }),
    '/api/models': () => resp({ catalog: {
      default: { provider: 'doulor', model: 'wb', reasoningEffort: 'medium' },
      routableProviders: ['doulor'],
      groups: [{ id: 'doulor', name: 'Doulor', models: [
        { id: 'wb', name: 'WB-DS41F', description: '主力模型', efforts: [{ id: 'low', name: '低' }, { id: 'high', name: '高' }], defaultEffort: 'medium' }
      ] }],
      failures: [{ id: 'bad', name: '坏提供方', message: '连接超时' }]
    } }),
    '/api/presets': () => resp({ presets: [
      { id: 'standard', label: '标准模式' },
      { id: 'cordis', label: '创造模式', description: '用对话定制 DSH' }
    ] }),
    '/api/questions': () => resp({ items: [] }),
    'POST /api/model': () => resp({ selected: { provider: 'doulor', model: 'wb', reasoningEffort: 'high' } }),
    'POST /api/preset': () => resp({ selected: 'standard', label: '标准模式' }),
    'POST /api/answer': () => resp({ accepted: true, answers: [] })
  };

  fetchLog = [];
  loadApp();
  await tick(); await tick();

  // boot() 里 connectQuestions() 先建，所以此刻 lastES 就是问题流
  const questionsES = lastES;
  ok('问题流是一条独立的 EventSource', !!questionsES && questionsES.url.indexOf('/api/questions/stream') !== -1, questionsES && questionsES.url);

  // ---- 分组渲染（用服务端给的 groups） ----
  const list = registry['list'];
  eq('服务端的 groups 被采用', findAll(list, 'group').length, 2);
  eq('组名按服务端给的顺序', findAll(list, 'group-name').map((n) => n.textContent).join(','), 'alpha,无工作区');
  eq('无工作区的组不显示路径', findAll(list, 'group-path')[1].textContent, '');
  eq('组内会话数', findAll(list, 'group-count').map((n) => n.textContent).join(','), '2,1');
  eq('组内会话都渲染出来', findAll(list, 'session').length, 3);

  // ---- 折叠（P4：默认折叠） ----
  const firstGroup = findAll(list, 'group')[0];
  const alphaKey = 'dsh-mm-collapsed:' + 'd:\\proj\\alpha';
  eq('默认折叠', firstGroup._classes.has('collapsed'), true);
  eq('默认折叠时不写盘（没点过就没有记录）', fakeLocalStorage[alphaKey], undefined);
  findAll(list, 'group-head')[0].dispatch('click');
  eq('点组头展开', firstGroup._classes.has('collapsed'), false);
  eq('展开显式写 0（不是 removeItem）', fakeLocalStorage[alphaKey], '0');
  findAll(list, 'group-head')[0].dispatch('click');
  eq('再点折叠', firstGroup._classes.has('collapsed'), true);
  eq('折叠写 1', fakeLocalStorage[alphaKey], '1');

  // ---- 进一个"还没开始"的会话：模式可换 ----
  findAll(list, 'session')[1].dispatch('click');   // d2，blank=true
  await tick();
  const followES = lastES;
  eq('进了对话页', registry['view-chat'].hidden, false);
  followES.emit('message', JSON.stringify({
    e: 'snapshot',
    d: {
      header: { id: 'd2', cwd: 'D:\\proj\\alpha', createdAt: NOW - 5000, agentPreset: 'standard' },
      cursor: 0, hasMore: false, records: [], assistantStream: null,
      projections: {
        title: '甲会话',
        agentPreset: 'cordis',   // 投影说创造模式，header 却说 standard
        modelSelection: { lastUsed: null, next: { provider: 'doulor', model: 'wb', reasoningEffort: 'medium' } }
      }
    }
  }));
  await tick();

  const chips = findAll(registry['chat-sub'], 'chip');
  eq('头部有 2 枚芯片（模式 + 模型）', chips.length, 2);
  eq('模式芯片用投影里的中文名（不是 header 的 standard）', chips[0].textContent, '创造模式');
  eq('模型芯片用目录里的友好名', chips[1].textContent, 'WB-DS41F');
  eq('还没开始的会话模式可换', chips[0].disabled, false);
  eq('模型芯片可点', chips[1].disabled, false);

  // ---- 模型面板 ----
  chips[1].dispatch('click');
  await tick();
  eq('模型面板打开了', registry['sheet'].hidden, false);
  eq('面板标题', registry['sheet-title'].textContent, '切换模型');
  eq('列出了一个模型', findAll(registry['sheet-body'], 'opt').length, 1);
  eq('当前模型被标出来', findAll(registry['sheet-body'], 'opt')[0]._classes.has('on'), true);
  eq('当前模型的档位被列出', findAll(registry['sheet-body'], 'effort').length, 2);
  eq('失败的提供方也显示出来', registry['sheet-body'].textContent.indexOf('连接超时') !== -1, true);

  findAll(registry['sheet-body'], 'effort')[1].dispatch('click');   // 选 high
  await tick(); await tick();
  const modelBody = JSON.parse(lastCall('/api/model').body);
  eq('POST /api/model 带上会话', modelBody.sessionId, 'd2');
  eq('POST /api/model 带上模型', modelBody.model, 'wb');
  eq('POST /api/model 带上档位', modelBody.reasoningEffort, 'high');
  eq('切换后面板自动关闭', registry['sheet'].hidden, true);

  // ---- 模式面板 ----
  findAll(registry['chat-sub'], 'chip')[0].dispatch('click');
  await tick();
  eq('模式面板打开了', registry['sheet'].hidden, false);
  eq('模式面板标题', registry['sheet-title'].textContent, '切换模式');
  eq('列出了两个模式', findAll(registry['sheet-body'], 'opt').length, 2);
  eq('当前模式被标出来', findAll(registry['sheet-body'], 'opt')[1]._classes.has('on'), true);
  findAll(registry['sheet-body'], 'opt')[0].dispatch('click');      // 选 standard
  await tick(); await tick();
  const presetBody = JSON.parse(lastCall('/api/preset').body);
  eq('POST /api/preset 带上会话', presetBody.sessionId, 'd2');
  eq('POST /api/preset 带上模式', presetBody.preset, 'standard');

  // ---- 已开始的会话：模式芯片置灰 ----
  registry['btn-back'].dispatch('click');
  await tick();
  findAll(registry['list'], 'session')[0].dispatch('click');        // d1，blank=false
  await tick();
  const followES2 = lastES;
  followES2.emit('message', JSON.stringify({
    e: 'snapshot',
    d: {
      header: { id: 'd1', cwd: 'D:\\proj\\alpha', createdAt: NOW - 5000, agentPreset: 'standard' },
      cursor: 0, hasMore: false, records: [], assistantStream: null,
      projections: { title: '甲会话', agentPreset: 'ptc', modelSelection: { lastUsed: { provider: 'doulor', model: 'wb' }, next: { provider: 'doulor', model: 'wb' } } }
    }
  }));
  await tick();
  const chips2 = findAll(registry['chat-sub'], 'chip');
  eq('已开始的会话模式芯片置灰', chips2[0].disabled, true);
  eq('置灰时给出原因', chips2[0].title, '已开始的会话不能改模式');
  eq('已开始的会话模型仍然可换', chips2[1].disabled, false);
  eq('模式名仍按投影显示', chips2[0].textContent, 'PTC 模式');

  // ---- 提问卡片 ----
  eq('没有待答问题时卡片隐藏', registry['qcard'].hidden, true);
  questionsES.emit('message', JSON.stringify({
    e: 'question',
    d: {
      id: 'q-1', sessionId: 'd1', callId: 'call-1', createdAt: NOW,
      questions: [{ id: 'qa', header: '确认一下', question: '要继续吗？', detail: '会影响磁盘', options: [{ label: '继续', description: '往下做' }, { label: '停下' }] }]
    }
  }));
  eq('有待答问题时卡片出现', registry['qcard'].hidden, false);
  eq('卡片标题', registry['qcard-title'].textContent, '需要你决定');
  eq('渲染了 1 道题', findAll(registry['qcard-body'], 'q-item').length, 1);
  eq('渲染了 2 个选项', findAll(registry['qcard-body'], 'q-opt').length, 2);
  eq('有自定义答案输入框', findAll(registry['qcard-body'], 'q-custom').length, 1);
  eq('没作答时不能提交', registry['qcard-submit'].disabled, true);
  eq('没作答时给出提示', registry['qcard-count'].textContent, '还剩 1 题');

  // ---- 认领等待（Bug2：手机上答完不该变成"答案被暂存 + agent 又跑一轮"） ----
  // 卡片一出现就要认领：宿主默认只等 120 秒，没人认领时到点就放行模型
  await tick();
  const holdCall = lastCall('/api/questions/hold');
  ok('卡片出现后立刻认领等待', !!holdCall, holdCall && holdCall.body);
  eq('认领请求带问题 id', JSON.parse(holdCall.body).questionId, 'q-1');
  eq('认领请求 hold=true', JSON.parse(holdCall.body).hold, true);

  // 服务端确认接管后，脚注要如实说明"不会超时"
  questionsES.emit('message', JSON.stringify({ e: 'question-hold', d: { id: 'q-1', sessionId: 'd1', held: true, remainingMs: 118000 } }));
  await tick();
  eq('接管后脚注说明不会超时', registry['qcard-note'].textContent, '已接管等待，宿主这边不会超时');

  // 切到后台：必须放开认领，否则宿主会一直等一个没人看的卡片（agent 卡死）
  globalThis.document.visibilityState = 'hidden';
  globalThis.document.dispatch('visibilitychange');
  await tick();
  eq('切到后台放开认领', JSON.parse(lastCall('/api/questions/hold').body).hold, false);
  eq('放开后脚注退回默认说明', registry['qcard-note'].textContent, '手机上答完，电脑那边会自动继续');

  // 回到前台：重新认领
  globalThis.document.visibilityState = 'visible';
  globalThis.document.dispatch('visibilitychange');
  await tick();
  eq('回到前台重新认领', JSON.parse(lastCall('/api/questions/hold').body).hold, true);

  // ---- 卡片可收起：不收起的话它一直占着输入框上方，把上面的会话消息挤扁 ----
  eq('默认展开', registry['qcard']._classes.has('collapsed'), false);
  eq('收起键写着"收起"', registry['qcard-toggle'].textContent, '收起');
  eq('展开时 aria-expanded=true', registry['qcard-toggle'].getAttribute('aria-expanded'), 'true');
  registry['qcard-toggle'].dispatch('click');
  eq('点一下就收起', registry['qcard']._classes.has('collapsed'), true);
  eq('收起后按钮变成"展开"', registry['qcard-toggle'].textContent, '展开');
  eq('收起后 aria-expanded=false', registry['qcard-toggle'].getAttribute('aria-expanded'), 'false');
  await tick();
  eq('收起时放掉认领（不能等一个被收起来的卡片）',
    JSON.parse(lastCall('/api/questions/hold').body).hold, false);
  registry['qcard-toggle'].dispatch('click');
  eq('再点一下展开', registry['qcard']._classes.has('collapsed'), false);
  await tick();
  eq('展开后重新认领', JSON.parse(lastCall('/api/questions/hold').body).hold, true);

  // 页面卸载：放开认领（keepalive 让请求在卸载过程中也能发出去）
  globalThis.window.dispatch('pagehide');
  await tick();
  eq('页面卸载时放开认领', JSON.parse(lastCall('/api/questions/hold').body).hold, false);
  eq('卸载时的释放请求带 keepalive', lastCall('/api/questions/hold').keepalive, true);

  findAll(registry['qcard-body'], 'q-opt')[0].dispatch('click');
  eq('选中的选项被标出来', findAll(registry['qcard-body'], 'q-opt')[0]._classes.has('on'), true);
  eq('作答后可以提交', registry['qcard-submit'].disabled, false);
  eq('作答后计数变了', registry['qcard-count'].textContent, '可以提交了');

  registry['qcard-submit'].dispatch('click');
  await tick(); await tick();
  const answerBody = JSON.parse(lastCall('/api/answer').body);
  eq('POST /api/answer 带上问题 id', answerBody.questionId, 'q-1');
  eq('POST /api/answer 带上选项', JSON.stringify(answerBody.answers), JSON.stringify([{ id: 'qa', selected: ['继续'] }]));

  // 服务端回一条 question-settled，卡片收起来
  questionsES.emit('message', JSON.stringify({ e: 'question-settled', d: { id: 'q-1', sessionId: 'd1', outcome: 'answered' } }));
  await tick();
  eq('问题结束后卡片收起', registry['qcard'].hidden, true);

  // ---- 别的会话的提问：只提示，不占当前会话的卡片 ----
  questionsES.emit('message', JSON.stringify({
    e: 'question',
    d: { id: 'q-2', sessionId: 'other', callId: null, createdAt: NOW, questions: [{ id: 'qb', question: '?' }] }
  }));
  await tick();
  eq('别的会话的提问不占当前会话的卡片', registry['qcard'].hidden, true);
  ok('别的会话的提问给了提示', registry['toast'].textContent.indexOf('等你回答') !== -1, registry['toast'].textContent);

  // ---- 换一个新问题：自动展开（收起状态只属于上一张卡片） ----
  registry['qcard-toggle'].dispatch('click');   // 先把上一张收起
  eq('收起状态记下了', appState().qcardCollapsed, true);
  questionsES.emit('message', JSON.stringify({
    e: 'question',
    d: {
      id: 'q-10', sessionId: 'd1', callId: 'call-10', createdAt: NOW,
      questions: [{ id: 'qc', question: '换个新问题' }]
    }
  }));
  await tick();
  eq('新问题出现', registry['qcard'].hidden, false);
  eq('新问题自动展开（新问题必须让人看见）', registry['qcard']._classes.has('collapsed'), false);
  eq('展开状态同步到按钮', registry['qcard-toggle'].getAttribute('aria-expanded'), 'true');
  eq('新问题重新认领等待', JSON.parse(lastCall('/api/questions/hold').body).hold, true);
  questionsES.emit('message', JSON.stringify({ e: 'question-settled', d: { id: 'q-10', sessionId: 'd1', outcome: 'answered' } }));
  await tick();
  eq('新问题结束后卡片收起', registry['qcard'].hidden, true);

  // ---- 只读模式：两枚芯片都点不动 ----
  buildDom('no');
  fetchLog = [];
  loadApp();
  await tick(); await tick();
  findAll(registry['list'], 'session')[0].dispatch('click');
  await tick();
  lastES.emit('message', JSON.stringify({
    e: 'snapshot',
    d: {
      header: { id: 'd1', cwd: 'D:\\proj\\alpha', createdAt: NOW - 5000, agentPreset: 'standard' },
      cursor: 0, hasMore: false, records: [], assistantStream: null,
      projections: { title: '甲会话', agentPreset: 'cordis', modelSelection: { lastUsed: null, next: { provider: 'doulor', model: 'wb' } } }
    }
  }));
  await tick();
  const roChips = findAll(registry['chat-sub'], 'chip');
  eq('只读模式下仍然显示 2 枚芯片', roChips.length, 2);
  eq('只读模式下模式芯片点不动', roChips[0].disabled, true);
  eq('只读模式下模型芯片点不动', roChips[1].disabled, true);
  roChips[1].dispatch('click');
  await tick();
  eq('只读模式下模型面板不打开', registry['sheet'].hidden, true);
  roChips[0].dispatch('click');
  await tick();
  eq('只读模式下模式面板不打开', registry['sheet'].hidden, true);
}

/* ============================== 场景 E：P4 新建会话 ============================== */

async function scenarioP4() {
  console.log('\n[场景 E] P4 新建会话');
  buildDom('yes');
  fakeLocalStorage = {};
  routes = {
    '/api/sessions': () => resp({ items: [
      { id: 'n1', title: '已有会话', running: false, blank: false, agentAvailable: true, updatedAt: NOW, cwd: 'D:\\proj\\alpha' }
    ] }),
    '/api/workspaces': () => resp({ workspaces: [
      { id: 'ws-1', path: 'D:\\proj\\alpha', name: 'alpha 项目', title: 'alpha 项目', sessionCount: 1 },
      { id: 'ws-2', path: 'D:\\proj\\empty', name: 'empty', title: '', sessionCount: 0 }
    ] }),
    'POST /api/session': (rec) => {
      sessionCalls.push(rec);
      return resp({ sessionId: 'session-brand-new', preset: 'standard' });
    }
  };
  fetchLog = [];
  sessionCalls = [];
  loadApp();
  await tick(); await tick();

  // ---- 打开面板 ----
  eq('新建面板默认是关的', registry['sheet'].hidden, true);
  registry['btn-new'].dispatch('click');
  await tick(); await tick();
  eq('点 ＋ 打开面板', registry['sheet'].hidden, false);
  eq('面板标题', registry['sheet-title'].textContent, '新建会话');
  eq('拉了一次工作区清单', countCalls('/api/workspaces'), 1);

  const opts = findAll(registry['sheet-body'], 'opt');
  eq('两个候选文件夹各一行', opts.length, 2);
  ok('第一行显示登记名', opts[0].textContent.indexOf('alpha 项目') !== -1, opts[0].textContent);
  ok('第二行显示目录名', opts[1].textContent.indexOf('empty') !== -1, opts[1].textContent);

  // ---- 选文件夹 → POST /api/session ----
  opts[0].dispatch('click');
  await tick(); await tick();
  eq('发了一次新建请求', sessionCalls.length, 1);
  const bodyA = JSON.parse(sessionCalls[0].body);
  eq('优先用 workspaceId', bodyA.workspaceId, 'ws-1');
  eq('有 workspaceId 就不带 cwd', bodyA.cwd, undefined);
  eq('建完面板关掉', registry['sheet'].hidden, true);
  eq('建完直接进新会话', registry['view-chat'].hidden, false);
  eq('当前会话就是新建的那个', appState().sessionId, 'session-brand-new');
  ok('新会话按 id 直接 follow', lastES.url.indexOf('id=session-brand-new') !== -1, lastES.url);
  ok('给了一次成功提示', registry['toast'].textContent.indexOf('新建') !== -1, registry['toast'].textContent);

  // ---- 手输路径：清单里没有的文件夹也能建 ----
  registry['btn-new'].dispatch('click');
  await tick(); await tick();
  const input = findAll(registry['sheet-body'], 'sheet-input')[0];
  ok('面板里有手输路径的输入框', !!input);
  const pathBtn = findAll(registry['sheet-body'], 'btn').filter((b) => b.textContent.indexOf('在这个文件夹新建') !== -1)[0];
  ok('有"在这个文件夹新建"按钮', !!pathBtn);
  pathBtn.dispatch('click');
  await tick();
  eq('空路径不发请求', sessionCalls.length, 1);
  ok('空路径给了提示', registry['toast'].textContent.indexOf('文件夹路径') !== -1, registry['toast'].textContent);

  input.value = '  D:\\proj\\brand-new  ';
  pathBtn.dispatch('click');
  await tick(); await tick();
  eq('填了路径就发请求', sessionCalls.length, 2);
  eq('路径去掉首尾空白', JSON.parse(sessionCalls[1].body).cwd, 'D:\\proj\\brand-new');

  // ---- 上游报错：面板留着，让人能改 ----
  routes['POST /api/session'] = (rec) => {
    sessionCalls.push(rec);
    return resp({ error: 'session-create-failed', code: 'session/unavailable', message: '目录不可用' }, 502);
  };
  registry['btn-new'].dispatch('click');
  await tick(); await tick();
  findAll(registry['sheet-body'], 'opt')[0].dispatch('click');
  await tick(); await tick();
  ok('失败时给出人话提示', registry['toast'].textContent.indexOf('新建会话失败') !== -1, registry['toast'].textContent);
  eq('失败后面板仍开着（可以改路径重试）', registry['sheet'].hidden, false);
  eq('失败后按钮恢复可点', findAll(registry['sheet-body'], 'opt')[0].disabled, false);

  // ---- 只读模式：入口直接拒绝 ----
  buildDom('no');
  fetchLog = [];
  sessionCalls = [];
  loadApp();
  await tick(); await tick();
  registry['btn-new'].dispatch('click');
  await tick(); await tick();
  eq('只读模式下新建面板不打开', registry['sheet'].hidden, true);
  ok('只读模式下给了提示', registry['toast'].textContent.indexOf('enablePrompt') !== -1, registry['toast'].textContent);
  eq('只读模式下没发新建请求', sessionCalls.length, 0);
}

/* ============================== 场景 F：P5 隐藏系统消息 ============================== */

async function scenarioP5() {
  console.log('\n[场景 F] P5 隐藏系统消息');

  // 正常情况下客户端根本收不到这些东西：宿主侧 lib/mirror.js 的 projectEvent
  // 已经把注入消息和系统提示整条丢掉了。这里**故意**从长连接灌进去，验证两件事：
  //   1) 真人消息照常渲染
  //   2) 老宿主（还没重启）发来的 system/message / developer/message 不再渲染出任何节点
  // 第 2 条正好覆盖"新页面 + 旧宿主"这个半更新状态，不然那一瞬间又会冒出一堆英文。
  buildDom('yes');
  fakeLocalStorage = {};
  routes = {
    '/api/sessions': () => resp({ items: [
      { id: 'h1', title: '隐藏测试', running: false, blank: false, agentAvailable: true, updatedAt: NOW, cwd: 'D:\\proj\\alpha' }
    ] })
  };
  fetchLog = [];
  loadApp();
  await tick(); await tick();
  findAll(registry['list'], 'session')[0].dispatch('click');
  await tick();
  const es = lastES;

  es.emit('message', JSON.stringify({
    e: 'snapshot',
    d: {
      header: { id: 'h1', cwd: 'D:\\proj\\alpha', createdAt: NOW, agentPreset: 'standard' },
      cursor: 0, hasMore: false, assistantStream: null,
      records: [{ type: 'user/message', seq: 1, time: NOW, data: { role: 'user', id: 'u1', blocks: [{ type: 'text', text: '真人说的' }] } }],
      projections: { title: '隐藏测试' }
    }
  }));
  await tick();
  eq('真人消息照常渲染', findAll(registry['stream'], 'me').length, 1);
  const before = registry['stream'].childNodes.length;
  ok('真人消息内容在页面上', registry['stream'].textContent.indexOf('真人说的') !== -1, registry['stream'].textContent);

  // 老宿主才会发的两类：系统提示 / 开发者消息（旧版会下发一行"已省略"标记）
  es.emit('message', JSON.stringify({
    e: 'event', d: { type: 'system/message', seq: 2, time: NOW, data: { omitted: true, note: '系统提示（已省略）' } }
  }));
  es.emit('message', JSON.stringify({
    e: 'event', d: { type: 'developer/message', seq: 3, time: NOW, data: { omitted: true, note: '开发者消息（已省略）' } }
  }));
  await tick();
  eq('system/message 不产生任何节点', registry['stream'].childNodes.length, before);
  eq('页面上没有 sys-note', findAll(registry['stream'], 'sys-note').length, 0);
  ok('页面上看不到"已省略"', registry['stream'].textContent.indexOf('已省略') === -1, registry['stream'].textContent);

  // 未知类型走 default 分支，同样不该炸、不该产生节点
  es.emit('message', JSON.stringify({ e: 'event', d: { type: 'brand/new', seq: 4, time: NOW, data: null } }));
  await tick();
  eq('未知事件类型也不产生节点', registry['stream'].childNodes.length, before);
}

/* ===================== 场景 G：代码块头部条 / 复制键 ===================== */

/**
 * Node 21+ 自带 `globalThis.navigator`，而且是只读 getter —— 直接赋值在严格模式下会抛错。
 * 用 defineProperty 覆盖才稳。
 */
function setNavigator(value) {
  Object.defineProperty(globalThis, 'navigator', { value, configurable: true, writable: true });
}

async function scenarioG() {
  console.log('\n[场景 G] 代码块头部条与复制键');

  // 假 DOM 的 insertAdjacentHTML 不解析 HTML，markdown 不会变成真实元素，
  // 所以这里直接给 decorateCodeBlocks 喂一个手搭的容器。
  // 测的仍然是真函数 + 真（假）DOM 行为：包不包、包几层、点复制键复制到什么。
  buildDom('yes');
  fakeLocalStorage = {};
  routes = { '/api/sessions': () => resp({ items: [
    { id: 'g1', title: '复制测试', running: false, blank: false, agentAvailable: true, updatedAt: NOW, cwd: 'D:\\proj\\alpha' }
  ] }) };
  fetchLog = [];
  loadApp();
  await tick(); await tick();
  const P = appExports;
  const el = (t) => globalThis.document.createElement(t);

  function codeBlock(lang, text) {
    const box = el('div');
    const pre = el('pre');
    pre.className = 'md-code';
    if (lang !== null) pre.setAttribute('data-lang', lang);
    pre.textContent = text;
    box.appendChild(pre);
    return box;
  }

  // ---- 装饰 ----
  const box = codeBlock('javascript', 'const a = 1');
  P.decorateCodeBlocks(box);
  eq('pre 被包进 .code-block', findAll(box, 'code-block').length, 1);
  eq('头部条只有一个', findAll(box, 'code-head').length, 1);
  eq('语言名取自 data-lang', findAll(box, 'code-lang')[0].textContent, 'javascript');
  eq('有复制键', findAll(box, 'copy-btn').length, 1);
  eq('复制键初始文案', findAll(box, 'copy-btn')[0].textContent, '复制');
  eq('pre 没有被丢掉', findAll(box, 'md-code').length, 1);
  ok('pre 现在挂在 .code-block 下面',
    findAll(box, 'md-code')[0].parentNode._classes.has('code-block'),
    String(findAll(box, 'md-code')[0].parentNode.className));

  // ---- 幂等：同一个容器重复装饰不该套两层 ----
  P.decorateCodeBlocks(box);
  eq('重复装饰不会套两层', findAll(box, 'code-block').length, 1);
  eq('重复装饰不会多出复制键', findAll(box, 'copy-btn').length, 1);

  // ---- 没有 data-lang 时给占位 ----
  const box2 = codeBlock(null, 'x');
  P.decorateCodeBlocks(box2);
  eq('没有语言信息时用占位', findAll(box2, 'code-lang')[0].textContent, '代码');

  // ---- 多个代码块一起装饰 ----
  const box3 = el('div');
  const preA = el('pre'); preA.className = 'md-code'; preA.setAttribute('data-lang', 'js'); preA.textContent = 'A';
  const preB = el('pre'); preB.className = 'md-code'; preB.textContent = 'B';
  box3.appendChild(preA); box3.appendChild(preB);
  P.decorateCodeBlocks(box3);
  eq('两个代码块各包一层', findAll(box3, 'code-block').length, 2);
  eq('两个复制键', findAll(box3, 'copy-btn').length, 2);
  eq('装饰后顺序不变', findAll(box3, 'md-code').map((p) => p.textContent).join(''), 'AB');

  // ---- 点击复制：navigator.clipboard 成功路径 ----
  let copied = null;
  setNavigator({ clipboard: { writeText: (t) => { copied = t; return Promise.resolve(); } } });
  findAll(box, 'copy-btn')[0].dispatch('click');
  await tick();
  eq('复制的是代码正文', copied, 'const a = 1');
  eq('复制成功给出反馈', findAll(box, 'copy-btn')[0].textContent, '已复制');
  eq('反馈带 done 类', findAll(box, 'copy-btn')[0]._classes.has('done'), true);

  // ---- writeText 被拒（非安全上下文会这样）→ 退回 execCommand ----
  let execCalled = 0;
  globalThis.document.execCommand = () => { execCalled += 1; return true; };
  setNavigator({ clipboard: { writeText: () => Promise.reject(new Error('not secure')) } });
  findAll(box3, 'copy-btn')[0].dispatch('click');
  await tick(); await tick();
  eq('writeText 被拒时退回 execCommand', execCalled, 1);
  eq('兜底路径也给出成功反馈', findAll(box3, 'copy-btn')[0].textContent, '已复制');

  // ---- 完全没有 clipboard → 直接兜底，不该抛错 ----
  setNavigator({});
  let threw = null;
  try { findAll(box3, 'copy-btn')[1].dispatch('click'); await tick(); } catch (e) { threw = e; }
  ok('没有 clipboard 也不抛错', !threw, threw && threw.stack);
  eq('没有 clipboard 时兜底同样生效', findAll(box3, 'copy-btn')[1].textContent, '已复制');

  // ---- 反馈会自动复位 ----
  await new Promise((r) => setTimeout(r, 1300));
  eq('反馈 1.2 秒后复位', findAll(box, 'copy-btn')[0].textContent, '复制');
  eq('复位时去掉 done 类', findAll(box, 'copy-btn')[0]._classes.has('done'), false);

  // ---- 复制失败时如实反馈 ----
  globalThis.document.execCommand = () => false;
  setNavigator({});
  findAll(box3, 'copy-btn')[0].dispatch('click');
  await tick(); await tick();
  eq('复制失败时如实说失败', findAll(box3, 'copy-btn')[0].textContent, '复制失败');
  eq('失败时不加 done 类', findAll(box3, 'copy-btn')[0]._classes.has('done'), false);

  // ---- 助手消息上的复制键：走真实的 SSE 渲染路径，不是手搭容器 ----
  findAll(registry['list'], 'session')[0].dispatch('click');
  await tick();
  const es = lastES;
  es.emit('message', JSON.stringify({
    e: 'snapshot',
    d: {
      header: { id: 'g1', cwd: 'D:\\proj\\alpha', createdAt: NOW, agentPreset: 'standard' },
      cursor: 0, hasMore: false, assistantStream: null, records: [],
      projections: { title: '复制测试' }
    }
  }));
  await tick();
  es.emit('message', JSON.stringify({
    e: 'event',
    d: {
      type: 'assistant/message', seq: 1, time: NOW,
      data: {
        role: 'assistant', id: 'a1',
        blocks: [{ type: 'text', text: '这是正文' }, { type: 'reasoning', text: '想了半天' }],
        usage: { inputTokens: 3, outputTokens: 5 }, interrupted: false, model: 'wb-test'
      }
    }
  }));
  await tick();

  const stream = registry['stream'];
  eq('助手消息渲染出来了', findAll(stream, 'assistant').length, 1);
  const metaRow = findAll(stream, 'meta')[0];
  ok('助手消息有元信息行', !!metaRow);
  const msgCopy = findAll(metaRow, 'copy-btn');
  eq('元信息行里有复制键', msgCopy.length, 1);
  let copiedMsg = null;
  setNavigator({ clipboard: { writeText: (t) => { copiedMsg = t; return Promise.resolve(); } } });
  msgCopy[0].dispatch('click');
  await tick();
  eq('只复制正文，不含思考过程', copiedMsg, '这是正文');

  // 纯工具调用的一轮没有正文：它的块全进了「工作过程」卡，消息自己没什么可显示的
  // → 整条不渲染。以前会退化成一句「（无内容）」，还带一个点了只复制到空字符串的键。
  es.emit('message', JSON.stringify({
    e: 'event',
    d: {
      type: 'assistant/message', seq: 2, time: NOW,
      data: {
        role: 'assistant', id: 'a2',
        blocks: [{ type: 'tool-call', id: 'c1', name: 'read_file', args: '{}' }],
        usage: null, interrupted: false, model: 'wb-test'
      }
    }
  }));
  await tick();
  eq('没有正文的助手消息不再渲染成空气泡', findAll(stream, 'assistant').length, 1);
  eq('它也就不会多出一条元信息行（复制键跟着一起没了）', findAll(stream, 'meta').length, 1);
  eq('它的命令进了工作过程卡', findAll(findAll(stream, 'work')[0], 'tool').length, 1);
  ok('正文里没有「（无内容）」', dump(stream).indexOf('（无内容）') === -1);
}

/* ===================== 场景 H：进场动画 ===================== */

/**
 * 这组测的是最容易写错的地方：进场动画**只能**加在实时新增的消息上。
 * 快照重建一次插入几十条历史，若都加动画，打开会话时一屏会同时乱动 ——
 * 而且这种 bug 不报错、只是难看，很容易被改回去。
 */
async function scenarioH() {
  console.log('\n[场景 H] 进场动画只加在实时新增的消息上');

  buildDom('yes');
  fakeLocalStorage = {};
  routes = {
    '/api/sessions': () => resp({ items: [
      { id: 'h1', title: '动画测试', running: false, blank: false, agentAvailable: true, updatedAt: NOW, cwd: 'D:\\proj\\alpha' }
    ] })
  };
  fetchLog = [];
  loadApp();
  await tick(); await tick();
  findAll(registry['list'], 'session')[0].dispatch('click');
  await tick();
  const es = lastES;

  function snap(records, cursor) {
    return JSON.stringify({
      e: 'snapshot',
      d: {
        header: { id: 'h1', cwd: 'D:\\proj\\alpha', createdAt: NOW, agentPreset: 'standard' },
        cursor: cursor, hasMore: false, assistantStream: null,
        records: records, projections: { title: '动画测试' }
      }
    });
  }
  function assistant(seq, text) {
    return { type: 'assistant/message', seq: seq, time: NOW,
      data: { role: 'assistant', blocks: [{ type: 'text', text: text }], usage: null, interrupted: false, model: null } };
  }
  function live(seq, text) {
    return JSON.stringify({ e: 'event', d: assistant(seq, text) });
  }

  // ---- 1. 快照重建的历史消息不该带动画 ----
  es.emit('message', snap([{ type: 'user/message', seq: 1, time: NOW,
    data: { role: 'user', id: 'u1', blocks: [{ type: 'text', text: '开场' }] } }], 1));
  await tick();
  const stream = registry['stream'];
  eq('快照渲染的消息不带 .msg-in', countClass(stream, 'msg-in'), 0);

  // ---- 2. 实时新增的消息该带动画 ----
  es.emit('message', live(2, 'LIVE'));
  await tick();
  eq('实时新增的消息带 .msg-in', countClass(stream, 'msg-in'), 1);

  // ---- 3. 再次快照重建：整棵树重建，不该有任何 .msg-in ----
  es.emit('message', snap([
    { type: 'user/message', seq: 1, time: NOW,
      data: { role: 'user', id: 'u1', blocks: [{ type: 'text', text: '开场' }] } },
    assistant(2, 'LIVE'),
    assistant(3, 'REPLAY')
  ], 3));
  await tick();
  eq('快照重建后一条 .msg-in 都没有', countClass(stream, 'msg-in'), 0);
  ok('重建后历史消息确实渲染了', dump(stream).indexOf('REPLAY') !== -1);

  // ---- 4. 重建之后实时消息仍带动画 —— 这条抓的是"replaying 卡在 true" ----
  es.emit('message', live(4, 'AFTER'));
  await tick();
  eq('重建之后实时消息仍然带动画（replaying 已复位）', countClass(stream, 'msg-in'), 1);
}

async function scenarioI() {
  console.log('\n[场景 I] 动效的 JS 侧：错开只播一次 / 按钮反馈 / toast 退场');

  const twoSessions = () => resp({ items: [
    { id: 'i1', title: '会话甲', running: false, blank: false, agentAvailable: true, updatedAt: NOW, cwd: 'D:\\proj\\alpha' },
    { id: 'i2', title: '会话乙', running: false, blank: false, agentAvailable: true, updatedAt: NOW, cwd: 'D:\\proj\\alpha' }
  ] });

  buildDom('yes');
  fakeLocalStorage = {};
  // routes 是按场景各自定义的 —— 漏了 'POST /api/prompt' 就会落到 404，
  // 于是"失败"与"成功"两条路径都变成同一种失败（not-found）。
  routes = {
    '/api/sessions': twoSessions,
    'POST /api/prompt': () => {
      const next = promptReplies.shift();
      if (!next) return resp({ accepted: true, duplicate: false });
      return next.promise ? next.promise : resp(next.body, next.status);
    }
  };
  fetchLog = [];
  promptReplies = [];
  loadApp();
  await tick(); await tick();

  // ---- 1. 第一次渲染：分组头与会话行按文档顺序依次错开 ----
  const rows = findAll(registry['list'], 'session');
  eq('列表渲染出两行', rows.length, 2);
  eq('会话行带 .list-in', rows[0]._classes.has('list-in'), true);
  eq('分组头先出场（0ms）', findAll(registry['list'], 'group-head')[0].style.animationDelay, '0ms');
  eq('第一行延迟 24ms', rows[0].style.animationDelay, '24ms');
  eq('第二行延迟 48ms（依次错开）', rows[1].style.animationDelay, '48ms');

  // ---- 2. 再刷新一次：整棵重建，但**不能重播** ----
  // 列表每 10 秒会重新拉一次（renderSessions 每次都先 textContent=''）；
  // 若每回重建都重放动画，界面会一直闪。
  registry['btn-refresh'].dispatch('click');
  await tick(); await tick();
  eq('刷新后列表仍是两行', findAll(registry['list'], 'session').length, 2);
  eq('刷新不重播错开动画', countClass(registry['list'], 'list-in'), 0);

  // ---- 3. 进会话：标题淡入 ----
  findAll(registry['list'], 'session')[0].dispatch('click');
  const es = lastES;
  es.emit('message', snapshot([], 0, { projections: { title: '会话甲' } }));
  await tick();
  eq('进会话后标题带 .title-in', registry['chat-title']._classes.has('title-in'), true);

  // ---- 4. 发一条会失败的：按钮抖动 + toast 进出场 ----
  // 把非 0ms 的定时器抓下来手动触发，免得真等 4 秒。
  // 0ms 的必须放行 —— tick() 本身就是 setTimeout(r, 0)，拦了整个场景会卡死。
  const realSetTimeout = globalThis.setTimeout;
  const timers = [];
  globalThis.setTimeout = function (fn, ms) {
    if (!ms) return realSetTimeout(fn, 0);
    timers.push({ fn: fn, ms: ms });
    return 90000 + timers.length;
  };
  // 按毫秒数找，不靠入队顺序 —— flashSend 的 600ms 排在 toast 的 4000ms 前面
  function takeTimer(ms) {
    const i = timers.findIndex((t) => t.ms === ms);
    return i === -1 ? null : timers.splice(i, 1)[0].fn;
  }
  try {
    const input = registry['composer-input'];
    input.value = '会失败的';
    input.dispatch('input');
    // 注意形状：promptReplies 收的是 { body, status } 普通对象，
    // 不是 routes 用的 resp(...) —— 写错形状会被当成"没有状态码"，
    // 于是连成功的那次也走失败分支（这条断言就是这么被带出来的）。
    promptReplies.push({ body: { error: 'prompt-failed', message: '上游炸了' }, status: 502 });
    registry['composer-send'].dispatch('click');
    await tick(); await tick(); await tick();

    eq('失败时 toast 可见', registry['toast'].hidden, false);
    ok('失败 toast 带上游原因（说明确实走的是失败分支）',
      registry['toast'].textContent.indexOf('上游炸了') !== -1, registry['toast'].textContent);
    eq('失败时按钮抖了一下', registry['composer-send']._classes.has('shake'), true);
    eq('失败时还没有退场类', registry['toast']._classes.has('toast-out'), false);

    // 自动隐藏（4000ms）先跑：加退场类，但**还不隐藏**
    const hide = takeTimer(4000);
    eq('抓到 toast 自动隐藏定时器（4000ms）', typeof hide, 'function');
    if (hide) hide();
    eq('退场时先加 .toast-out（播淡出）', registry['toast']._classes.has('toast-out'), true);
    eq('退场动画播完前不隐藏', registry['toast'].hidden, false);

    // 退场收尾（180ms）再跑：这时才真隐藏
    const done = takeTimer(180);
    eq('抓到退场收尾定时器（180ms）', typeof done, 'function');
    if (done) done();
    eq('动画播完才隐藏', registry['toast'].hidden, true);
    eq('隐藏时清掉退场类（否则下次进场会接着淡出）',
      registry['toast']._classes.has('toast-out'), false);

    // ---- 5. 再发一条成功的：脉冲环 ----
    // 上一轮失败把原文回填进输入框了，直接点发送即可（requestId 会被复用）
    promptReplies.push({ body: { accepted: true, duplicate: false }, status: 200 });
    registry['composer-send'].dispatch('click');
    await tick(); await tick(); await tick();
    eq('成功发送后按钮脉冲一下', registry['composer-send']._classes.has('pulse'), true);
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
}

/* ===================== 场景 J：子智能体在侧栏里不显示 ===================== */
/**
 * 这条需求**反转过一次**，历史留在注释里，免得下次又照老注释改回去：
 *   - 0.5.x：用户反馈「手机镜像看不到子智能体」→ 给子会话加标记 + 缩进 + 排到父会话后面；
 *   - 0.15.8：用户要求「把侧栏的子智能体彻底隐藏」→ 侧栏渲染时整类滤掉。
 *
 * 数据层一个字都不用改：DSH 本来就会返回子会话，`mirror.js` 的 `normalizeSummary()`
 * 也照旧透传 `origin` / `parentSessionId`。改的只是**侧栏渲染**。
 *
 * 这个场景钉住四件事：
 *   ① `origin='subagent'` 与带 `parentSessionId` 的会话都不出现；
 *   ② 过滤后为空的分组整块丢掉（不留一个只写着 "0" 的分组头）；
 *   ③ 分组头的会话数与运行圆点都只按**看得见的行**算；
 *   ④ 剩下的会话照常能点进对话页。
 */
async function scenarioSubagent() {
  console.log('\n[场景 J] 子智能体：在侧栏里彻底不显示');
  buildDom('yes');

  const child = { id: 'c1', title: '子任务', running: true, blank: false, agentAvailable: true, updatedAt: NOW - 1000, cwd: 'D:\\proj\\alpha', origin: 'subagent', parentSessionId: 'p1' };
  const other = { id: 'o1', title: '普通会话', running: false, blank: false, agentAvailable: true, updatedAt: NOW - 3000, cwd: 'D:\\proj\\alpha' };
  // 父会话不在本组的孤儿子会话：照样藏（判据只看它自己）
  const orphan = { id: 'c2', title: '孤儿子会话', running: false, blank: false, agentAvailable: true, updatedAt: NOW - 4000, cwd: 'D:\\proj\\alpha', parentSessionId: 'not-here' };
  const parent = { id: 'p1', title: '父会话', running: false, blank: false, agentAvailable: true, updatedAt: NOW - 5000, cwd: 'D:\\proj\\alpha' };
  // 整个分组里只有子会话 → 这一块要整块消失
  const kidOnly = { id: 'c3', title: '另一个子任务', running: false, blank: false, agentAvailable: true, updatedAt: NOW - 6000, cwd: 'D:\\work\\kids', origin: 'subagent' };

  const items = [child, other, orphan, parent];

  routes = {
    '/api/sessions': () => resp({ items: items, groups: [
      { key: 'd:\\proj\\alpha', name: 'alpha', path: 'D:\\proj\\alpha', items: items, updatedAt: NOW - 1000, running: true },
      { key: 'd:\\work\\kids', name: 'kids', path: 'D:\\work\\kids', items: [kidOnly], updatedAt: NOW - 6000, running: false }
    ] }),
    '/api/questions': () => resp({ items: [] }),
    '/api/models': () => resp({ catalog: { default: null, routableProviders: [], groups: [], failures: [] } })
  };

  fetchLog = [];
  loadApp();
  await tick(); await tick();

  const list = registry['list'];
  const rows = findAll(list, 'session');
  eq('子会话不进列表（4 条里只剩 2 条）', rows.length, 2);

  const titles = rows.map(function (r) {
    const t = findAll(r, 'session-title')[0];
    return t ? t.textContent : '';
  });
  eq('留下的是普通会话与父会话', titles.join('|'), '普通会话|父会话');

  eq('没有任何一条带 session-child（缩进 + 引导线）', findAll(list, 'session-child').length, 0);
  eq('没有任何「子智能体」标签', findAll(list, 'tag-sub').length, 0);

  const heads = findAll(list, 'group-head');
  eq('全是子会话的分组整块消失', heads.length, 1);
  eq('分组头的会话数只数看得见的行', findAll(list, 'group-count')[0].textContent, '2');
  eq('分组名只剩 alpha', findAll(list, 'group-name')[0].textContent, 'alpha');

  // alpha 里跑着的只有那个被滤掉的子会话 → 圆点不该亮（"亮了却找不到谁在跑"更糟）
  eq('圆点按看得见的行重算：没有行在跑就不亮', findAll(heads[0], 'dot').length, 0);

  // 剩下的行照常能点进去
  rows[1].dispatch('click');
  await tick();
  eq('点父会话能进对话页', registry['view-chat'].hidden, false);
}

/* ===================== 场景 K：轮次失败的报错正文 ===================== */
/**
 * 用户报「电脑上 DSH 报『本轮运行失败 API 密钥无效』，手机上没显示」。
 *
 * 根因在数据层：`mirror.js` 的 `turn/end` 原先只透传 `reason.kind`，
 * 把 `reason.error`（`LlmFailure`: message / code / status）整个丢掉了；
 * 网页端也只把 `'error'` 映射成一句「本轮出错」。于是手机上只剩一句干巴巴的状态。
 */
async function scenarioTurnFailure() {
  console.log('\n[场景 K] 轮次失败：报错正文 + toast + 快照不重弹');
  buildDom('yes');

  const s1 = { id: 's1', title: '会失败的会话', running: true, blank: false, agentAvailable: true, updatedAt: NOW - 1000, cwd: 'D:\\proj\\alpha' };

  routes = {
    '/api/sessions': () => resp({ items: [s1], groups: [
      { key: 'd:\\proj\\alpha', name: 'alpha', path: 'D:\\proj\\alpha', items: [s1], updatedAt: NOW - 1000, running: true }
    ] }),
    '/api/questions': () => resp({ items: [] }),
    '/api/models': () => resp({ catalog: { default: null, routableProviders: [], groups: [], failures: [] } })
  };

  fetchLog = [];
  loadApp();
  await tick(); await tick();

  findAll(registry['list'], 'session')[0].dispatch('click');
  await tick();
  const es = lastES;
  const stream = registry['stream'];

  // ---- 1. 实时失败：正文要出来，并且弹 toast ----
  // 注意形状：这里要发**投影后**的 data（reason 是字符串 kind，error 平级挂在 data 上），
  // 也就是 mirror.js 真正下发给网页的那个形状 —— 不是 DSH 原始的
  // `reason: { kind, error }`。发错形状测的就是不存在的东西。
  registry['toast'].hidden = true;
  es.emit('message', JSON.stringify({
    e: 'event',
    d: { type: 'turn/end', seq: 2, time: NOW, data: { turn: 1, reason: 'error', error: { message: 'API 密钥无效', code: 'INVALID_API_KEY', status: 401 } } }
  }));
  await tick();
  ok('实时失败渲染出报错正文', dump(stream).indexOf('本轮出错：API 密钥无效') !== -1, dump(stream).slice(-160));
  ok('实时失败渲染出错误码与 HTTP 状态', dump(stream).indexOf('INVALID_API_KEY · HTTP 401') !== -1);
  eq('实时失败带 failed 类（比 warn 更重的样式）', countClass(stream, 'failed') >= 1, true);
  eq('实时失败弹了 toast', registry['toast'].hidden, false);
  ok('toast 是同一句错误', registry['toast'].textContent.indexOf('API 密钥无效') !== -1, registry['toast'].textContent);

  // ---- 2. 快照重放历史错误：照样渲染，但**不弹 toast** ----
  // 否则每次打开会话都会为几天前的一次失败弹窗。
  registry['toast'].hidden = true;
  es.emit('message', JSON.stringify({
    e: 'snapshot',
    d: {
      header: { id: 's1', cwd: 'D:\\proj\\alpha', createdAt: NOW - 5000 },
      cursor: 2, hasMore: false, assistantStream: null,
      records: [
        { type: 'turn/start', seq: 1, time: NOW - 4000, data: { turn: 1 } },
        { type: 'turn/end', seq: 2, time: NOW - 3000, data: { turn: 1, reason: 'error', error: { message: '几天前的那次失败' } } }
      ]
    }
  }));
  await tick();
  ok('快照重放照样渲染历史错误', dump(stream).indexOf('几天前的那次失败') !== -1, dump(stream).slice(-160));
  eq('快照重放不为历史错误弹 toast', registry['toast'].hidden, true);

  // ---- 3. completed：既不 failed 也不弹 ----
  // seq 要递增：上面的快照把游标推到了 2，比游标旧的事件会被当成重复丢掉。
  registry['toast'].hidden = true;
  es.emit('message', JSON.stringify({ e: 'event', d: { type: 'turn/end', seq: 10, time: NOW, data: { turn: 2, reason: 'completed' } } }));
  await tick();
  ok('completed 仍显示完成文案', dump(stream).indexOf('本轮完成') !== -1);
  eq('completed 不弹 toast', registry['toast'].hidden, true);

  // ---- 4. error 但没有正文：仍算失败（那一轮确实白跑了），退回朴素文案 ----
  registry['toast'].hidden = true;
  es.emit('message', JSON.stringify({ e: 'event', d: { type: 'turn/end', seq: 11, time: NOW, data: { turn: 3, reason: 'error' } } }));
  await tick();
  ok('没有正文时退回朴素文案', dump(stream).indexOf('本轮出错') !== -1);
  eq('没有正文时仍然弹 toast（不能当正常结束）', registry['toast'].hidden, false);

  // ---- 5. 容忍原始形状：reason 是对象时取它的 kind，不能渲染成 [object Object] ----
  registry['toast'].hidden = true;
  es.emit('message', JSON.stringify({ e: 'event', d: { type: 'turn/end', seq: 12, time: NOW, data: { turn: 4, reason: { kind: 'aborted' } } } }));
  await tick();
  ok('原始 reason 对象取 kind 而不是 [object Object]',
    dump(stream).indexOf('本轮已中止') !== -1 && dump(stream).indexOf('[object Object]') === -1, dump(stream).slice(-120));
  eq('aborted 不弹 toast（用户自己停的）', registry['toast'].hidden, true);
}

/* ===================== 场景 L：右侧快捷跳转刻度条 =====================
 *
 * 目标只有一件事：回头能立刻找到"我自己说过的那句"。
 * 所以只标用户消息、只在两句以上时出现、点一下跳过去。
 * 助手消息不标 —— 它每轮都说一大段，全标出来等于没标。
 */
async function scenarioRail() {
  console.log('\n[场景 L] 右侧快捷跳转刻度条');
  buildDom('yes');

  const s1 = { id: 's1', title: '长会话', running: false, blank: false, agentAvailable: true, updatedAt: NOW - 1000, cwd: 'D:\\proj\\alpha' };
  routes = {
    '/api/sessions': () => resp({ items: [s1], groups: [
      { key: 'd:\\proj\\alpha', name: 'alpha', path: 'D:\\proj\\alpha', items: [s1], updatedAt: NOW - 1000, running: false }
    ] }),
    '/api/questions': () => resp({ items: [] }),
    '/api/models': () => resp({ catalog: { default: null, routableProviders: [], groups: [], failures: [] } }),
    'POST /api/prompt': () => resp({ accepted: true, requestId: 'r1' })
  };

  fetchLog = [];
  loadApp();
  await tick(); await tick();
  findAll(registry['list'], 'session')[0].dispatch('click');
  await tick();
  const es = lastES;
  const stream = registry['stream'];
  const rail = registry['rail'];

  // ---- 1. 只说过一句：不出现（一句的时候刻度条只会挡视线） ----
  es.emit('message', snapshot([
    { type: 'turn/start', seq: 1, time: NOW - 5000, data: { turn: 1 } },
    { type: 'user/message', seq: 2, time: NOW - 4900, data: { role: 'user', id: 'u1', blocks: [{ type: 'text', text: '第一句' }] } },
    { type: 'assistant/message', seq: 3, time: NOW - 4800, data: { role: 'assistant', blocks: [{ type: 'text', text: '好' }] } }
  ], 3));
  await tick();
  eq('只说过一句时不显示刻度条', rail.hidden, true);
  eq('刻度数为 0', findAll(rail, 'rail-tick').length, 0);

  // ---- 2. 两句以上：常驻，一句一条 ----
  // 流里的节点顺序：分隔条 / me / assistant / 分隔条 / me / assistant / me / assistant
  // 假 DOM 里每个直接子节点算 100px，所以三句的位置分别是 100 / 400 / 600。
  const recs = [
    { type: 'turn/start', seq: 1, time: NOW - 5000, data: { turn: 1 } },
    { type: 'user/message', seq: 2, time: NOW - 4900, data: { role: 'user', id: 'u1', blocks: [{ type: 'text', text: '帮我看看登录' }] } },
    { type: 'assistant/message', seq: 3, time: NOW - 4800, data: { role: 'assistant', blocks: [{ type: 'text', text: '好' }] } },
    { type: 'turn/start', seq: 4, time: NOW - 4000, data: { turn: 2 } },
    { type: 'user/message', seq: 5, time: NOW - 3900, data: { role: 'user', id: 'u2', blocks: [{ type: 'text', text: '再看下注册' }] } },
    { type: 'assistant/message', seq: 6, time: NOW - 3800, data: { role: 'assistant', blocks: [{ type: 'text', text: '好' }] } },
    { type: 'user/message', seq: 7, time: NOW - 3700, data: { role: 'user', id: 'u3', blocks: [{ type: 'text', text: '顺便把测试补上' }] } },
    { type: 'assistant/message', seq: 8, time: NOW - 3600, data: { role: 'assistant', blocks: [{ type: 'text', text: '好' }] } }
  ];
  es.emit('message', snapshot(recs, 8));
  await tick();
  eq('两句以上时常驻显示', rail.hidden, false);
  const ticks = findAll(rail, 'rail-tick');
  eq('刻度数 = 我说过的话的句数（助手消息不占刻度）', ticks.length, 3);
  eq('刻度按位置排（100/800、450/800、650/800）',
    ticks.map((t) => t.style.top).join(','), '18.75%,56.25%,81.25%');
  eq('刻度带无障碍说明', ticks[0].getAttribute('aria-label'), '跳到我说的第 1 句');
  // 滚到底时高亮的是最后一句
  eq('离视口中线最近的那条被高亮', ticks[2]._classes.has('on'), true);
  eq('其余刻度不高亮', ticks[0]._classes.has('on'), false);

  // ---- 3. "发送中"的气泡不算（它还没在 records 里落定，位置随后会跳） ----
  registry['composer-input'].value = '正在发的那句';
  registry['composer-send'].dispatch('click');
  await tick();
  eq('发送中的气泡进流了', countClass(stream, 'pending') >= 1, true);
  eq('发送中的气泡不占刻度', findAll(rail, 'rail-tick').length, 3);

  // ---- 4. 点一下跳过去 ----
  const targets = findAll(stream, 'me').filter((n) => !n._classes.has('pending'));
  ticks[0].dispatch('click');
  eq('跳到那句（留 12px 余量）', stream.scrollTop, 88);
  eq('跳过去的目标闪一下', targets[0]._classes.has('jump-hit'), true);
  eq('跳过去后刻度高亮跟着走', ticks[0]._classes.has('on'), true);

  // ---- 5. 按住先看内容，松手收起 ----
  const tip = registry['rail-tip'];
  eq('平时不显示预览', tip.hidden, true);
  ticks[1].dispatch('pointerdown');
  eq('按住刻度显示预览', tip.hidden, false);
  eq('预览里是那句的原话', tip.textContent, '再看下注册');
  ticks[1].dispatch('pointerup');
  eq('松手收起预览', tip.hidden, true);

  // ---- 6. 滚动时高亮跟着走 ----
  // 跳转后有 700ms 的锁：平滑滚动自己会发一串 scroll，那期间不能改判高亮。
  stream.scrollTop = 600;
  stream.dispatch('scroll');
  await tick();
  eq('跳转动画期间滚动事件不改判', ticks[0]._classes.has('on'), true);
  // 锁过期（= 动画滚完）之后，滚动才接管高亮
  appState().scrollLock = 0;
  stream.dispatch('scroll');
  await tick();
  eq('滚到下面时高亮最后一句', ticks[2]._classes.has('on'), true);
  eq('上面那条不再高亮', ticks[0]._classes.has('on'), false);

  // ---- 7. 开了"减少动效"：直接跳，不闪 ----
  const realMatchMedia = globalThis.window.matchMedia;
  globalThis.window.matchMedia = () => ({ matches: true });
  targets[2]._classes.delete('jump-hit');
  ticks[2].dispatch('click');
  eq('减少动效时不播"到了"动画', targets[2]._classes.has('jump-hit'), false);
  eq('减少动效时仍然跳到位', stream.scrollTop, 588);
  globalThis.window.matchMedia = realMatchMedia;

  // ---- 8. 换会话要把刻度一起清掉 ----
  es.emit('message', snapshot([
    { type: 'turn/start', seq: 1, time: NOW - 5000, data: { turn: 1 } },
    { type: 'user/message', seq: 2, time: NOW - 4900, data: { role: 'user', id: 'x1', blocks: [{ type: 'text', text: '新会话里只说了这一句' }] } }
  ], 2));
  await tick();
  eq('新会话只有一句时刻度条收起', rail.hidden, true);
  eq('旧刻度被清干净', findAll(rail, 'rail-tick').length, 0);
}

/* ===================== 场景 M：工作过程统一折叠 =====================
 *
 * 以前思考和命令是两摊：思考是助手消息里的一层折叠，命令（read / write / edit）
 * 是流里一堆独立卡片，一轮下来手机上要滑很久。它们本来就是同一件事的两面
 * （"它想了什么、动了什么"），所以统一收进一张「工作过程」。
 * 正在跑的那一轮展开，turn/end 一到就收起来 —— 这正是"已结束的回答，过程折起来"。
 */
async function scenarioWorkFold() {
  console.log('\n[场景 M] 工作过程：思考 + 命令统一折叠');
  buildDom('yes');

  const s1 = { id: 's1', title: '干活', running: true, blank: false, agentAvailable: true, updatedAt: NOW - 1000, cwd: 'D:\\proj\\alpha' };
  routes = {
    '/api/sessions': () => resp({ items: [s1], groups: [
      { key: 'd:\\proj\\alpha', name: 'alpha', path: 'D:\\proj\\alpha', items: [s1], updatedAt: NOW - 1000, running: true }
    ] }),
    '/api/questions': () => resp({ items: [] }),
    '/api/models': () => resp({ catalog: { default: null, routableProviders: [], groups: [], failures: [] } })
  };

  fetchLog = [];
  loadApp();
  await tick(); await tick();
  findAll(registry['list'], 'session')[0].dispatch('click');
  await tick();
  const es = lastES;
  const stream = registry['stream'];
  const ev = (type, seq, data) => es.emit('message', JSON.stringify({ e: 'event', d: { type, seq, time: NOW, data } }));

  // ---- 1. 轮次开始：**不**在这里建卡（第一件工作时才现场建），所以不留空卡 ----
  ev('turn/start', 1, { turn: 1 });
  await tick();
  ok('轮次开始不预先建卡（快照里没有 turn/start 时也靠现场建）', !appState().work);
  eq('还没干活时不占位', findAll(stream, 'work').length, 0);

  // ---- 2. 用户消息不算工作内容 ----
  ev('user/message', 2, { role: 'user', blocks: [{ type: 'text', text: '帮我改一下' }] });
  await tick();
  eq('用户消息不算工作内容', findAll(stream, 'work').length, 0);

  // ---- 3. 思考进折叠卡，正文留在消息里 ----
  ev('assistant/message', 3, {
    role: 'assistant',
    blocks: [{ type: 'reasoning', text: '先看看这个文件' }, { type: 'text', text: '我先读一下文件' }]
  });
  await tick();
  const work = findAll(stream, 'work')[0];
  ok('有思考后卡片出现', !!work);
  eq('正在跑的这一轮默认展开', work.open, true);
  eq('标题写着「工作过程」', work.textContent.indexOf('工作过程') !== -1, true);
  eq('思考收进工作过程', findAll(work, 'work-reason').length, 1);
  eq('思考原文在卡里', findAll(work, 'work-reason')[0].textContent.indexOf('先看看这个文件') !== -1, true);
  const assistants = findAll(stream, 'assistant').filter((n) => !n._classes.has('live'));
  eq('助手正文留在消息里', assistants[0].textContent.indexOf('我先读一下文件') !== -1, true);
  eq('助手消息里不再夹着思考', assistants[0].textContent.indexOf('先看看这个文件'), -1);
  eq('思考不再用嵌套折叠（手机上难点）', findAll(stream, 'reason').length, 0);

  // ---- 4. 命令（工具调用）也进同一张卡 ----
  ev('tool/call', 4, { callId: 'c1', name: 'read_file', args: '{"path":"a.js"}' });
  await tick();
  const work2 = findAll(stream, 'work')[0];
  eq('命令卡收进工作过程', findAll(work2, 'fold').length, 1);
  eq('命令卡不是流的直接子节点（收在卡里）',
    stream.childNodes.filter((n) => n.nodeType === 1 && n._classes.has('tool')).length, 0);
  eq('两件工作后标题带件数', findAll(work2, 'work-count')[0].textContent, '2 项');

  // ---- 5. 工具结果填回同一张命令卡（不算新的一件工作） ----
  ev('tool/result', 5, { callId: 'c1', isError: false, blocks: [{ type: 'text', text: '文件内容在这里' }] });
  await tick();
  const work3 = findAll(stream, 'work')[0];
  eq('结果填进原卡片', findAll(work3, 'tool-result')[0].textContent.indexOf('文件内容在这里') !== -1, true);
  eq('结果不算新的一件工作', findAll(work3, 'work-count')[0].textContent, '2 项');

  // ---- 6. 第二段思考接着往同一张卡里放（不新开一张） ----
  ev('assistant/message', 6, {
    role: 'assistant',
    blocks: [{ type: 'reasoning', text: '现在动手改' }, { type: 'text', text: '改好了' }]
  });
  await tick();
  const work4 = findAll(stream, 'work')[0];
  eq('同一轮只有一张工作过程卡', findAll(stream, 'work').length, 1);
  eq('两段思考都在里面', findAll(work4, 'work-reason').length, 2);
  eq('件数累加', findAll(work4, 'work-count')[0].textContent, '3 项');
  eq('第二段正文也留在消息里', dump(stream).indexOf('改好了') !== -1, true);

  // ---- 7. 轮次结束：过程折起来 ----
  ev('turn/end', 7, { turn: 1, reason: 'completed' });
  await tick();
  const work5 = findAll(stream, 'work')[0];
  eq('回答结束后工作过程自动折起', work5.open, false);
  eq('折起来了但还在（随时能点开）', work5.hidden, false);
  eq('件数留在标题上（收起来也看得见做了多少）', findAll(work5, 'work-count')[0].textContent, '3 项');

  // ---- 8. 位置：在这一轮的提问之后、回答正文之前 ----
  const kids = stream.childNodes.filter((n) => n.nodeType === 1);
  const iDivider = kids.findIndex((n) => n._classes.has('divider'));
  const iUser = kids.findIndex((n) => n._classes.has('me'));
  const iWork = kids.findIndex((n) => n._classes.has('work'));
  const iMsg = kids.findIndex((n) => n._classes.has('assistant'));
  ok('折叠卡在这一轮的提问之后', iWork > iUser && iWork > iDivider, 'user=' + iUser + ' work=' + iWork);
  ok('折叠卡排在回答正文之前（先看过程，再看回答）', iWork < iMsg, 'work=' + iWork + ' msg=' + iMsg);

  // ---- 9. 没有工作内容的轮次不留空卡 ----
  ev('turn/start', 8, { turn: 2 });
  await tick();
  ev('assistant/message', 9, { role: 'assistant', blocks: [{ type: 'text', text: '不用动手，直接答' }] });
  await tick();
  ev('turn/end', 10, { turn: 2, reason: 'completed' });
  await tick();
  eq('没用工具、没思考的轮次不留空卡', findAll(stream, 'work').length, 1);
  eq('那张卡还是第一轮的', findAll(stream, 'work')[0] === work5, true);

  // ---- 10. 快照重建：历史轮次收起，正在跑的那轮展开 ----
  es.emit('message', snapshot([
    { type: 'turn/start', seq: 20, time: NOW - 9000, data: { turn: 5 } },
    { type: 'user/message', seq: 21, time: NOW - 8900, data: { role: 'user', blocks: [{ type: 'text', text: '历史那一轮' }] } },
    { type: 'assistant/message', seq: 22, time: NOW - 8800, data: { role: 'assistant', blocks: [{ type: 'reasoning', text: '历史思考' }, { type: 'text', text: '历史回答' }] } },
    { type: 'tool/call', seq: 23, time: NOW - 8700, data: { callId: 'h1', name: 'edit_file', args: '{"path":"b.js"}' } },
    { type: 'turn/end', seq: 24, time: NOW - 8600, data: { turn: 5, reason: 'completed' } },
    { type: 'turn/start', seq: 25, time: NOW - 8500, data: { turn: 6 } },
    { type: 'user/message', seq: 26, time: NOW - 8400, data: { role: 'user', blocks: [{ type: 'text', text: '正在跑的那一轮' }] } },
    { type: 'assistant/message', seq: 27, time: NOW - 8300, data: { role: 'assistant', blocks: [{ type: 'reasoning', text: '正在想的' }, { type: 'text', text: '先说着' }] } }
  ], 27));
  await tick();
  const snapFolds = findAll(stream, 'work');
  eq('两轮各一张卡', snapFolds.length, 2);
  eq('历史那一轮收起来', snapFolds[0].open, false);
  eq('历史思考在里面', findAll(snapFolds[0], 'work-reason')[0].textContent.indexOf('历史思考') !== -1, true);
  eq('历史命令也在里面', findAll(snapFolds[0], 'tool-args').length, 1);
  eq('正在跑的那一轮展开', snapFolds[1].open, true);

  // ---- 11. 真实形状：快照窗口把某一轮的 turn/start 切在外面（轮中片段） ----
  // 真实会话里约七成助手消息只有「思考 + 命令」、没有正文；而历史快照按条数切窗口，
  // 很容易把 turn/start 切在窗口外 —— 那时若还等 turn/start 才建卡，整轮就没有卡，
  // 思考和命令又散回消息里，手机上看到的就是"折叠没生效"。
  es.emit('message', snapshot([
    { type: 'assistant/message', seq: 60, time: NOW - 5000, data: { role: 'assistant', blocks: [
      { type: 'reasoning', text: '轮中思考' },
      { type: 'tool-call', id: 'm1', name: 'read_file', args: '{"path":"a.js"}' }
    ] } },
    { type: 'tool/result', seq: 61, time: NOW - 4900, data: { callId: 'm1', isError: false, blocks: [{ type: 'text', text: '文件内容' }] } },
    { type: 'assistant/message', seq: 62, time: NOW - 4800, data: { role: 'assistant', blocks: [
      { type: 'tool-call', id: 'm2', name: 'grep', args: '{"pattern":"x"}' }
    ] } }
  ], 62));
  await tick();
  eq('窗口里没有 turn/start 也能建出工作过程卡', findAll(stream, 'work').length, 1);
  const midCard = findAll(stream, 'work')[0];
  eq('轮中思考进了卡', findAll(midCard, 'work-reason').length, 1);
  eq('两条命令都进了卡', findAll(midCard, 'fold').length, 2);
  eq('件数 = 思考 + 两条命令', findAll(midCard, 'work-count')[0].textContent, '3 项');
  eq('没有正文的助手消息一条都不渲染（不再满屏空气泡）', findAll(stream, 'assistant').length, 0);
  eq('正文里没有「（无内容）」', dump(stream).indexOf('（无内容）'), -1);

  // ---- 12. 真·空数据（blocks 为空）才留「（无内容）」 ----
  es.emit('message', snapshot([
    { type: 'assistant/message', seq: 70, time: NOW, data: { role: 'assistant', blocks: [] } }
  ], 70));
  await tick();
  eq('块数组本身为空时才留一个「（无内容）」', dump(stream).indexOf('（无内容）') !== -1, true);

  // ---- 13. 已中断的消息即使没有正文也照样渲染（标签不能丢） ----
  es.emit('message', snapshot([
    { type: 'assistant/message', seq: 71, time: NOW, data: { role: 'assistant', blocks: [{ type: 'reasoning', text: '被打断的思考' }], interrupted: true } }
  ], 71));
  await tick();
  const cut = findAll(stream, 'assistant');
  eq('已中断的消息照样渲染', cut.length, 1);
  eq('它带着「已中断」', cut[0].textContent.indexOf('已中断') !== -1, true);
  eq('思考仍然进了卡', findAll(findAll(stream, 'work')[0], 'work-reason').length, 1);

  // ---- 14. 往上翻历史：老记录不能塞进当前这一轮的卡里 ----
  es.emit('message', snapshot([
    { type: 'turn/start', seq: 80, time: NOW, data: { turn: 9 } },
    { type: 'user/message', seq: 81, time: NOW, data: { role: 'user', blocks: [{ type: 'text', text: '现在这一轮' }] } },
    { type: 'assistant/message', seq: 82, time: NOW, data: { role: 'assistant', blocks: [{ type: 'reasoning', text: '当前思考' }] } }
  ], 82, { hasMore: true }));
  await tick();
  eq('当前这一轮有卡', findAll(stream, 'work').length, 1);
  eq('当前这一轮 1 件工作', findAll(findAll(stream, 'work')[0], 'work-reason').length, 1);
  eq('只有一件时标题上不写件数（"1 项"是废话）', findAll(findAll(stream, 'work')[0], 'work-count')[0].textContent, '');

  routes['/api/page'] = () => resp({ records: [
    { type: 'turn/start', seq: 70, time: NOW - 9000, data: { turn: 8 } },
    { type: 'assistant/message', seq: 71, time: NOW - 8900, data: { role: 'assistant', blocks: [
      { type: 'reasoning', text: '更早的思考' },
      { type: 'tool-call', id: 'old1', name: 'read_file', args: '{"path":"z.js"}' }
    ] } },
    { type: 'turn/end', seq: 72, time: NOW - 8800, data: { turn: 8, reason: 'completed' } }
  ], hasMore: false });
  appState().scrollLock = 0;
  stream.scrollTop = 0;
  fetchLog = [];
  stream.dispatch('scroll');
  await tick(); await tick(); await tick();
  eq('确实去要了更早的一页', countCalls('/api/page'), 1);
  const twoCards = findAll(stream, 'work');
  eq('历史自己也有一张卡', twoCards.length, 2);
  eq('历史思考进了历史那张卡', findAll(twoCards[0], 'work-reason')[0].textContent.indexOf('更早的思考') !== -1, true);
  eq('历史那张卡是收起来的', twoCards[0].open, false);
  eq('当前这一轮还是 1 件工作（没被历史污染）', findAll(twoCards[1], 'work-reason').length, 1);
}

function summary() {
  console.log('\n========================================');
  console.log('通过 ' + pass + ' / 失败 ' + fail);
  if (fail) { console.log('失败用例：'); failures.forEach((f) => console.log('  - ' + f)); }
  console.log('========================================');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.log('脚本自身异常：' + (e && e.stack)); process.exit(2); });
