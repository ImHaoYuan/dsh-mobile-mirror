/**
 * 桌面设置面板（lib/client.js）测试。
 *
 * 为什么需要单独一套：这个文件是**手写的浏览器 bundle**，它有三类"写错了不报错"的
 * 故障，全部只能靠测试抓：
 *
 *   ① bundle 包裹格式 / 导出形状不对 → 浏览器连 factory 都注册不上，宿主侧一无所知；
 *   ② 槽注册参数（id / order / label）不对 → 安静地少一页，或者把官方那页顶掉；
 *   ③ 面板读的字段名与主机 payload 不一致 → 面板显示「—」或 undefined，
 *      正是当初 `turn/end` 丢 `reason.error` 那一类 bug 的同款。
 *
 * 做法：用 `new Function` 把 lib/client.js 当一个脚本跑起来，喂给它假的
 * `window.__ModuleLoader__` / `document` / `navigator` / `fetch` / `react`，
 * 然后真调用它导出的 `apply()`，把它注册的组件与选项原样抓下来。
 *
 * 不碰 $DSH_HOME，不起任何服务。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const LIB = fileURLToPath(new URL('../lib/', import.meta.url))
const CLIENT = path.join(LIB, 'client.js')
const INDEX = path.join(LIB, 'index.js')

let passed = 0
let failed = 0
function check(name, ok, detail) {
  if (ok) { passed += 1; console.log(`PASS  ${name}`) } else { failed += 1; console.log(`FAIL  ${name}${detail ? `  — ${detail}` : ''}`) }
}
function eq(name, actual, expected) {
  check(name, Object.is(actual, expected), `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
}
function deepEq(name, actual, expected) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  check(name, a === b, `期望 ${b}，实际 ${a}`)
}
/** 去掉整行注释：注释里会特意提到旧写法，直接在原文上断言会被自己的说明绊倒。 */
function codeOnly(source) {
  return String(source).split('\n').filter((line) => {
    const t = line.trim()
    return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*')
  }).join('\n')
}

const src = fs.readFileSync(CLIENT, 'utf8')
const code = codeOnly(src)

/* ------------------------------ 假的浏览器环境 ------------------------------ */

/** 一个够用的 DOM 元素替身。 */
function makeElement(tag) {
  return {
    tag,
    attrs: {},
    style: {},
    textContent: '',
    value: '',
    removed: false,
    setAttribute(k, v) { this.attrs[k] = v },
    select() {},
    remove() { this.removed = true },
    focus() {},
  }
}

/**
 * 造一套假环境并跑一遍 bundle。
 *
 * @param options.reactOk - require('react') 是否成功（false 用来验证"拿不到 react 也不炸"）。
 * @param options.withSlots - 上下文里有没有 slots 服务。
 * @param options.fetchImpl - fetch 实现。
 * @returns 环境、模块导出、注册记录与日志。
 */
function runBundle(options = {}) {
  const env = {
    styles: [],
    timers: [],
    cleared: [],
    warnings: [],
    fetchCalls: [],
    body: [],
  }
  const head = { children: [], appendChild(el) { this.children.push(el); env.styles.push(el) } }
  const body = { children: [], appendChild(el) { this.children.push(el); env.body.push(el) } }
  const document = {
    head,
    body,
    createElement: (tag) => makeElement(tag),
    execCommand: () => true,
  }
  const navigator = { clipboard: null }
  const consoleStub = {
    log: () => {},
    warn: (...args) => env.warnings.push(args.map((x) => String(x)).join(' ')),
    error: (...args) => env.warnings.push(args.map((x) => String(x)).join(' ')),
  }
  const fetchImpl = options.fetchImpl || (() => Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve({}),
  }))
  const fetchStub = (url, init) => {
    env.fetchCalls.push({ url, init })
    return fetchImpl(url, init)
  }

  let registered = null
  const window = {
    __ModuleLoader__: { load: (entry) => { registered = entry } },
    setInterval: (fn, ms) => { env.timers.push({ fn, ms }); return env.timers.length },
    clearInterval: (id) => { env.cleared.push(id) },
    setTimeout: (fn) => { void fn; return 0 },
  }

  // 把 bundle 当脚本执行。用 new Function 而不是 import：这个文件没有模块语法，
  // 它靠 window.__ModuleLoader__.load 自注册。
  // eslint-disable-next-line no-new-func
  const execute = new Function('window', 'document', 'navigator', 'fetch', 'console', src)
  execute(window, document, navigator, fetchStub, consoleStub)

  const React = {
    Fragment: Symbol('Fragment'),
    createElement: (type, props, ...children) => ({
      type,
      props: props || {},
      children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false),
    }),
    useState: (init) => [init, () => {}],
    useRef: (init) => ({ current: init }),
    useCallback: (fn) => fn,
    useEffect: () => {},
  }
  const requireStub = (spec) => {
    if (spec === 'react') {
      if (options.reactOk === false) throw new Error('react is not a platform seed word')
      return React
    }
    throw new Error(`意外的 require("${spec}")`)
  }

  const injections = []
  const registrations = []
  const slots = {
    inject(key, cb) { injections.push(key); const d = cb(); return typeof d === 'function' ? d : () => {} },
    register(opts, component) { registrations.push({ opts, component }); return () => {} },
  }
  const disposers = []
  const ctx = {
    effect(cb) { const d = cb(); if (typeof d === 'function') disposers.push(d); return () => {} },
    get(name) {
      if (name === 'slots') return options.withSlots === false ? undefined : slots
      return undefined
    },
    slots: options.withSlots === false ? undefined : slots,
  }

  const mod = registered === null ? null : registered.factory(requireStub)
  let applyErr = null
  if (mod) {
    try { mod.apply(ctx) } catch (err) { applyErr = err }
  }

  return { env, registered, mod, requireStub, injections, registrations, disposers, applyErr, document, React }
}

/* ==================== ① bundle 格式与注册 ==================== */
console.log('\n———— ① bundle 格式与槽注册 ————')

const run = runBundle()
check('bundle 真的调了 window.__ModuleLoader__.load', !!run.registered, '没有捕获到 load 调用')
eq('注册的 bundle id 是包名', run.registered && run.registered.id, 'dsh-mobile-mirror')
check('factory 是个函数', typeof (run.registered && run.registered.factory) === 'function')
check('factory 跑起来不抛错', !!run.mod, 'factory 抛了异常')
check('apply() 不抛错', !run.applyErr, run.applyErr && run.applyErr.stack)
check('导出 apply', run.mod && typeof run.mod.apply === 'function')
deepEq('导出 inject = ["slots"]', run.mod && run.mod.inject, ['slots'])

eq('注入了一次槽', run.injections.length, 1)
eq('注入的是 settings.section', run.injections[0], 'settings.section')
eq('注册了一次设置页', run.registrations.length, 1)
const reg = run.registrations[0]
deepEq('注册参数逐字正确', reg && reg.opts, {
  name: 'settings.section',
  id: 'mobile-mirror',
  order: 30,
  label: '手机镜像',
})
eq('注册的 id 是自己的（不覆盖官方页）', reg && reg.opts.id, 'mobile-mirror')
check('注册的是个组件函数', typeof (reg && reg.component) === 'function')

check('样式表插进了 head', run.env.styles.length === 1 && run.env.styles[0].tag === 'style')
eq('样式表带 data-mobile-mirror 标记（便于排查）',
  run.env.styles[0] && run.env.styles[0].attrs['data-mobile-mirror'], 'panel')
check('样式内容真的是面板 CSS', (run.env.styles[0] && run.env.styles[0].textContent || '').includes('.mm-panel'))
check('样式挂在 ctx.effect 上（插件卸载时会被摘掉）', run.disposers.length === 1)
for (const d of run.disposers) d()
eq('卸载后样式元素被移除', run.env.styles[0] && run.env.styles[0].removed, true)

/* ==================== ② 失败姿势：不许拖垮客户端 ==================== */
console.log('\n———— ② 拿不到 react / slots 时的软失败 ————')

const noReact = runBundle({ reactOk: false })
check('拿不到 react 时 apply() 不抛错', !noReact.applyErr, noReact.applyErr && noReact.applyErr.stack)
eq('拿不到 react 时不注册任何设置页', noReact.registrations.length, 0)
check('拿不到 react 时有日志说明',
  noReact.env.warnings.some((w) => w.includes('没有 react')), noReact.env.warnings.join(' | '))

const noSlots = runBundle({ withSlots: false })
check('拿不到 slots 时 apply() 不抛错', !noSlots.applyErr, noSlots.applyErr && noSlots.applyErr.stack)
eq('拿不到 slots 时不注册任何设置页', noSlots.registrations.length, 0)
check('拿不到 slots 时有日志说明',
  noSlots.env.warnings.some((w) => w.includes('没有 slots 服务')), noSlots.env.warnings.join(' | '))

/* ==================== ③ 主机 payload 与面板字段名耦合 ==================== */
console.log('\n———— ③ 主机 payload ↔ 面板字段名 ————')

const { buildPanelInfo } = await import(pathToFileURL(INDEX).href)
check('lib/index.js 导出了 buildPanelInfo', typeof buildPanelInfo === 'function')

const fakeMirror = {
  tlsInfo: {
    enabled: true,
    reason: '',
    fingerprint: '6C:98:48:95:6F:64:29:E4:37:0C:0D:56:F0:AC:B6:6C:94:FB:8E:96:11:5F:77:63:13:11:CC:39:2B:59:7A:1A',
    validTo: 'Oct 7 23:00:00 2027 GMT',
    subjectAltName: 'DNS:localhost, IP Address:127.0.0.1, IP Address:10.194.44.92',
  },
  pairInfo: () => [
    { name: 'WLAN', address: '10.194.44.92', url: 'https://10.194.44.92:19388/' },
    { name: 'vmnet1', address: '192.168.182.1', url: 'https://192.168.182.1:19388/' },
  ],
  configured: () => true,
  sessions: new Map([['s1', {}], ['s2', {}]]),
}
const panelConfig = { port: 19388, username: 'roxy', sessionTtlDays: 30, enablePrompt: true }
const payload = buildPanelInfo(fakeMirror, panelConfig)

eq('payload.ok 为 true', payload.ok, true)
eq('payload 端口来自配置', payload.port, 19388)
eq('payload 协议为 https', payload.scheme, 'https')
eq('payload 回环设置页地址', payload.setupUrl, 'https://127.0.0.1:19388/setup')
eq('payload 候选按主机给的顺序原样透传', payload.candidates[0].url, 'https://10.194.44.92:19388/')
eq('payload 在线会话数', payload.activeSessions, 2)

// 面板读了哪些 info.* / tls.* 字段，主机就必须给哪些 —— 少一个就是"显示 — 或 undefined"。
// 先去掉字符串字面量：`"/dsh-mirror/info.json"` 里的 `info.json` 会被正则误当成字段读取。
const codeNoStrings = code.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/'(?:[^'\\]|\\.)*'/g, "''")
const infoFields = new Set([...codeNoStrings.matchAll(/\binfo\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]))
const tlsFields = new Set([...codeNoStrings.matchAll(/\btls\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]))
check('确实扫到了面板读的 info 字段（正则没失效）', infoFields.size >= 8, [...infoFields].join(','))
check('确实扫到了面板读的 tls 字段', tlsFields.size >= 3, [...tlsFields].join(','))

const missingInfo = [...infoFields].filter((f) => !Object.prototype.hasOwnProperty.call(payload, f))
eq('面板读的每个 info 字段主机都给了', missingInfo.length ? missingInfo.join(', ') : '无', '无')
const missingTls = [...tlsFields].filter((f) => !Object.prototype.hasOwnProperty.call(payload.tls, f))
eq('面板读的每个 tls 字段主机都给了', missingTls.length ? missingTls.join(', ') : '无', '无')

// 候选对象的字段契约：主机给 name/address/url，面板也只许读这三个。
const candFields = new Set([...codeNoStrings.matchAll(/\b(?:primary|entry)\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]))
check('面板读的候选字段都在 {name,address,url} 里',
  [...candFields].every((f) => ['name', 'address', 'url'].includes(f)), [...candFields].join(','))
eq('主机给的候选字段就是这三个',
  Object.keys(payload.candidates[0]).sort().join(','), 'address,name,url')

/* ==================== ④ 面板真跑一遍（用主机真 payload）==================== */
console.log('\n———— ④ 面板渲染（喂真 payload）————')

/** 把 createElement 造出来的树拍平成纯文本，方便断言"页面上会出现什么字"。 */
function textOf(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  return textOf(node.children)
}

/** 用真 payload 跑一遍 Panel()，返回渲染出的文本。 */
async function renderPanel(data, { failFetch = false } = {}) {
  const hooks = { cursor: 0, states: [], cleanups: [] }
  const React = {
    Fragment: Symbol('Fragment'),
    // 子组件（AddressCard / CopyButton / InfoRow）也要真跑，否则断言"页面上有没有
    // 那个地址"就只是在断言一个没被展开的元素。函数组件在这里同步展开，
    // 并把 hooks 游标与 state 槽切成它自己的一份（父组件的随后恢复）。
    createElement: (type, props, ...children) => {
      const kids = children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false)
      if (typeof type === 'function') {
        const savedCursor = hooks.cursor
        const savedStates = hooks.states
        hooks.cursor = 0
        hooks.states = []
        try {
          return type({ ...(props || {}), children: kids.length === 1 ? kids[0] : kids.length ? kids : undefined })
        } finally {
          hooks.cursor = savedCursor
          hooks.states = savedStates
        }
      }
      return { type, props: props || {}, children: kids }
    },
    // 只够这个面板用：useState / useRef / useCallback / useEffect。
    useState(init) {
      const i = hooks.cursor++
      if (!(i in hooks.states)) hooks.states[i] = init
      return [hooks.states[i], (v) => { hooks.states[i] = typeof v === 'function' ? v(hooks.states[i]) : v }]
    },
    useRef(init) { hooks.cursor++; return { current: init } },
    useCallback(fn) { hooks.cursor++; return fn },
    useEffect(fn) { hooks.cursor++; hooks.cleanups.push(fn) },
  }
  const env = { styles: [], timers: [], cleared: [], warnings: [], fetchCalls: [], body: [] }
  const document = {
    head: { children: [], appendChild(el) { this.children.push(el); env.styles.push(el) } },
    body: { children: [], appendChild(el) { this.children.push(el) } },
    createElement: (tag) => makeElement(tag),
    execCommand: () => true,
  }
  let registered = null
  const window = {
    __ModuleLoader__: { load: (entry) => { registered = entry } },
    setInterval: (fn, ms) => { env.timers.push({ fn, ms }); return env.timers.length },
    clearInterval: (id) => { env.cleared.push(id) },
    setTimeout: () => 0,
  }
  const fetchStub = (url, init) => {
    env.fetchCalls.push({ url, init })
    if (failFetch) return Promise.reject(new Error('HTTP 404'))
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(data) })
  }
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', 'navigator', 'fetch', 'console', src)(
    window, document, { clipboard: null }, fetchStub, { log: () => {}, warn: () => {}, error: () => {} },
  )
  const mod = registered.factory((spec) => {
    if (spec === 'react') return React
    throw new Error(`意外的 require("${spec}")`)
  })
  const registrations = []
  const slots = { inject: (k, cb) => cb(), register: (opts, component) => { registrations.push({ opts, component }); return () => {} } }
  mod.apply({ effect: (cb) => cb(), get: () => slots, slots })

  const Panel = registrations[0].component
  // 第一遍：还没拿到数据（初始 state 是 loading）。
  hooks.cursor = 0
  const first = Panel()
  for (const fn of hooks.cleanups) fn()
  hooks.cleanups.length = 0
  // 等 fetch 落地（setState 会把 state 换成 ready）。
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
  // 第二遍：hooks.states 保留，于是拿到的是已更新的 state。
  hooks.cursor = 0
  const second = Panel()
  for (const fn of hooks.cleanups) fn()
  return { first: textOf(first), second: textOf(second), env }
}

const ok = await renderPanel(payload)
check('fetch 的路径就是主机那条路由', ok.env.fetchCalls[0] && ok.env.fetchCalls[0].url === '/dsh-mirror/info.json',
  ok.env.fetchCalls[0] && ok.env.fetchCalls[0].url)
eq('fetch 用 no-store', ok.env.fetchCalls[0] && ok.env.fetchCalls[0].init.cache, 'no-store')
eq('fetch 的 accept 头是 JSON', ok.env.fetchCalls[0] && ok.env.fetchCalls[0].init.headers.accept, 'application/json')
check('数据没到之前显示"正在读取"', ok.first.includes('正在读取'), ok.first)
check('拉到数据后不再显示"正在读取"', !ok.second.includes('正在读取'), ok.second)

check('显示手机访问地址（首选候选）', ok.second.includes('https://10.194.44.92:19388/'), ok.second)
check('显示首选候选的网卡名', ok.second.includes('WLAN'), ok.second)
check('显示本机设置页地址', ok.second.includes('https://127.0.0.1:19388/setup'), ok.second)
check('显示账号', ok.second.includes('roxy'), ok.second)
check('显示端口', ok.second.includes('19388'), ok.second)
check('显示证书指纹', ok.second.includes('6C:98:48:95'), ok.second)
check('显示有效期', ok.second.includes('2027'), ok.second)
check('显示在线会话数', ok.second.includes('2'), ok.second)
check('口令已配置时不出现"未配置"', !ok.second.includes('未配置'), ok.second)
check('不显示"没找到局域网 IPv4 地址"', !ok.second.includes('没找到局域网'), ok.second)
check('有刷新按钮', ok.second.includes('刷新'), ok.second)
check('说明会自动刷新', ok.second.includes('自动刷新'), ok.second)
check('注入了样式表', ok.env.styles.length === 1)

const fetchFail = await renderPanel(payload, { failFetch: true })
check('fetch 失败时给出可操作提示', fetchFail.second.includes('重启'), fetchFail.second)
check('fetch 失败时不显示主机数据（没数据可显示）', !fetchFail.second.includes('10.194.44.92'), fetchFail.second)

// 没有局域网网卡：必须明说手机连不上，而不是留个空白。
const noLan = buildPanelInfo({ ...fakeMirror, pairInfo: () => [] }, panelConfig)
const none = await renderPanel(noLan)
check('没有局域网地址时明确警告', none.second.includes('没找到局域网 IPv4 地址'), none.second)

// 口令没配：必须显式提示"现在谁都无法登录"，否则用户会以为手机坏了。
const unconfigured = buildPanelInfo({ ...fakeMirror, configured: () => false }, panelConfig)
const unconf = await renderPanel(unconfigured)
check('口令未配置时显示"未配置"', unconf.second.includes('未配置'), unconf.second)
check('口令未配置时提示去设置页设置', unconf.second.includes('设置账号和口令'), unconf.second)

// 明文 HTTP：必须警告，不能让它看起来跟 https 一样安全。
const plain = buildPanelInfo(
  { ...fakeMirror, tlsInfo: { enabled: false, reason: 'disabled by config' } },
  panelConfig,
)
const plainRun = await renderPanel(plain)
check('明文 HTTP 时显示警告文案', plainRun.second.includes('明文'), plainRun.second)

console.log(`\n${passed}/${passed + failed} 通过`)
if (failed > 0) process.exitCode = 1
