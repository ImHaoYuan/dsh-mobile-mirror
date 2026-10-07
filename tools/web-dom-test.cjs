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
  get scrollHeight() { return this._scrollHeight === null ? this.childNodes.length * 100 : this._scrollHeight; }
  set scrollHeight(v) { this._scrollHeight = v; }
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
  scrollTo() { this.scrollTop = this.scrollHeight; }
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
  /** 支持类选择器（.cls）与标签名（button / input）；够 app.js 用就行。 */
  querySelectorAll(sel) {
    const parts = String(sel).split(',').map((s) => s.trim());
    const out = [];
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType !== 1) continue;
        for (const p of parts) {
          const hit = p.charAt(0) === '.'
            ? child._classes.has(p.slice(1))
            : child.tagName === p.toUpperCase();
          if (hit) { out.push(child); break; }
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

  globalThis.document = {
    readyState: 'complete',
    visibilityState: 'visible',
    body: body,
    addEventListener() {},
    createElement(t) { return new El(t); },
    createDocumentFragment() { return new Frag(); },
    createTextNode(t) { return new Txt(t); },
    getElementById(id) { return registry[id] || null; }
  };
  globalThis.window = { addEventListener() {}, confirm: () => confirmAnswer };
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

function loadApp() {
  const tmp = path.join(os.tmpdir(), 'dsh-mm-dom-app-' + process.pid + '.cjs');
  fs.copyFileSync(APP_JS, tmp);
  delete require.cache[tmp];
  require(tmp);
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
  ok('reasoning 折叠块存在', countClass(stream, 'reason') === 1);
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

  input.value = 'x'.repeat(7001);
  input.dispatch('input');
  eq('7001 字符显示字数', registry['composer-count'].textContent, '7001/8000');
  eq('未超限不算 over', registry['composer-count']._classes.has('over'), false);
  input.value = 'x'.repeat(8001);
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

  // ---- 停止按钮 ----
  eq('空闲时停止按钮隐藏', stopBtn.hidden, true);
  es.emit('message', JSON.stringify({ e: 'event', d: { type: 'turn/start', seq: 20, time: NOW, data: { turn: 2 } } }));
  eq('运行中停止按钮出现', stopBtn.hidden, false);

  confirmAnswer = false;
  cancelReplies = [];          // 取消确认时不该发出请求，所以不留任何响应
  stopBtn.dispatch('click');
  await tick(); await tick();
  eq('确认框取消则不请求 /api/cancel', countCalls('/api/cancel'), 0);
  eq('取消后按钮仍可用', stopBtn.disabled, false);

  confirmAnswer = true;
  const cancelDefer = deferred();
  cancelReplies.push(cancelDefer);
  stopBtn.dispatch('click');
  await tick();
  eq('确认后请求 /api/cancel', countCalls('/api/cancel'), 1);
  eq('停止请求体只有 sessionId', lastCall('/api/cancel').body, JSON.stringify({ sessionId: 's1' }));
  eq('停止请求进行中按钮禁用', stopBtn.disabled, true);
  stopBtn.dispatch('click');
  eq('停止进行中连点不会再发', countCalls('/api/cancel'), 1);
  cancelDefer.reply({ accepted: true }, 200);
  await tick(); await tick();
  eq('停止完成后按钮恢复可用', stopBtn.disabled, false);
  ok('停止成功给了提示', registry['toast'].textContent.indexOf('已请求停止') !== -1, registry['toast'].textContent);

  // ---- 停止失败文案 ----
  cancelReplies.push({ body: { error: 'cancel-failed', message: '上游炸了' }, status: 502 });
  stopBtn.dispatch('click');
  await tick(); await tick(); await tick();
  ok('停止失败提示上游报错', registry['toast'].textContent.indexOf('停止失败') !== -1, registry['toast'].textContent);

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

function summary() {
  console.log('\n========================================');
  console.log('通过 ' + pass + ' / 失败 ' + fail);
  if (fail) { console.log('失败用例：'); failures.forEach((f) => console.log('  - ' + f)); }
  console.log('========================================');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.log('脚本自身异常：' + (e && e.stack)); process.exit(2); });
