/**
 * 入口层集成测试：真的调用 lib/index.js 的 apply()。
 *
 * 这是唯一没被其他测试覆盖的一层，而它恰好决定了"手机能不能回答问题"：
 * 注册 `user-questions/request` 时必须带 `prepend: true`，否则 Remote 转发层那个
 * answerer 认出 agent 之后就不调 next()，永远轮不到我们（app.asar 321570）。
 *
 * 做法：用一个极简的 Cordis 上下文替身把 apply() 真跑一遍（真的起 HTTPS 服务、
 * 真的走登录），然后按 Cordis 的 waterfall 语义手工组合处理器，验证
 *   ① 注册的事件名与选项正确、日志说清楚了
 *   ② 手机通过真实 HTTP 路由作答后，waterfall 拿到的就是手机的答案
 *   ③ 顺序反过来（不 prepend）时手机答不上 —— 证明 prepend 不是装饰
 *
 * 不碰 $DSH_HOME：把 DSH_HOME 指到临时目录，用临时端口与临时配置。
 */

import fs from 'node:fs'
import os from 'node:os'
import net from 'node:net'
import path from 'node:path'
import https from 'node:https'
import { fileURLToPath, pathToFileURL } from 'node:url'

const LIB = fileURLToPath(new URL('../lib/', import.meta.url))

let passed = 0
let failed = 0
function check(name, ok, detail) {
  if (ok) { passed += 1; console.log(`PASS  ${name}`) } else { failed += 1; console.log(`FAIL  ${name}${detail ? `  — ${detail}` : ''}`) }
}
function eq(name, actual, expected) {
  check(name, Object.is(actual, expected), `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mm-host-'))

/** 要一个当前空闲的端口：绑 0 拿系统分配的号再放掉（有极小竞态，测试够用）。 */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port
      srv.close(() => resolve(port))
    })
  })
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

/** 这个端口现在还能不能连上（连不上 = 服务真的关了）。返回 { refused, note }。 */
function portRefuses(port) {
  return new Promise((resolve) => {
    const r = https.request({
      host: '127.0.0.1', port, path: '/health', method: 'GET',
      agent: false, rejectUnauthorized: false, timeout: 800,
    }, (res) => { res.resume(); resolve({ refused: false, note: `还活着，HTTP ${res.statusCode}` }) })
    r.on('error', (err) => resolve({ refused: true, note: err.code || err.message }))
    r.on('timeout', () => { r.destroy(); resolve({ refused: false, note: '超时（连接被接受但没回应）' }) })
    r.end()
  })
}

/** 轮询等待条件成立。 */
async function waitFor(fn, ms = 8000) {
  const until = Date.now() + ms
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() > until) return null
    await sleep(20)
  }
}

/**
 * apply() 只用到这几个成员，照 Cordis 的真实语义实现：
 *   - effect(execute)：**执行 execute 并把它的返回值当作清理函数**
 *     （app.asar 277473 `effect(execute: () => Effect)`；插件里写作 root.effect(() => dispose)）
 *   - on(event, fn, { prepend })：prepend 用 unshift 插到最前（app.asar 275014）
 */
function createFakeRoot(services) {
  const handlers = new Map()
  const disposers = []
  const calls = []
  const root = {
    effect(execute) {
      const disposable = execute()
      if (typeof disposable === 'function') disposers.push(disposable)
      return () => { if (typeof disposable === 'function') disposable() }
    },
    inject(keys, callback) {
      calls.push({ event: 'inject', keys: keys.slice() })
      const ctx = {}
      for (const k of keys) if (services[k]) ctx[k] = services[k]
      const dispose = callback(ctx)
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    get(key) { return services[key] || null },
    on(event, fn, options) {
      calls.push({ event, prepend: !!(options && options.prepend) })
      const list = handlers.get(event) || []
      if (options && options.prepend) list.unshift(fn)
      else list.push(fn)
      handlers.set(event, list)
    },
  }
  return { root, handlers, disposers, calls }
}

/**
 * Cordis 的 waterfall 语义：按注册顺序依次调用，谁不调 next() 谁就吃掉这次事件。
 * 用经典的 reduceRight 组合复刻它（与 app.asar 275005 的语义一致）。
 */
function runWaterfall(list, request) {
  const terminal = () => { throw new Error('user-questions/no-answerer') }
  return list.reduceRight((next, fn) => () => fn(request, next), terminal)()
}

/* ------------------------------ 伪造的服务 ------------------------------ */

const fakePresets = {
  async list() {
    return [{ id: 'cordis', name: undefined, description: '定制 DSH' }, { id: 'standard' }]
  },
  async select() {},
}
const fakeAgents = { get: () => ({ id: 'sess-1', ctx: {}, session: {} }) }
const createCalls = []
const fakeController = {
  async list() { return [] },
  async page() { return { records: [], hasMore: false } },
  follow() { throw new Error('入口测试不该用到 follow') },
  async prompt() { return { accepted: true, duplicate: false } },
  async cancel() {},
  async modelCatalog() { return { default: null, routableProviders: [], groups: [], failures: [] } },
  async selectModel(request) { return { selected: request } },
  async create(request) {
    createCalls.push(request)
    return { sessionId: 'session-from-host', agentPreset: request.agentPreset || 'standard' }
  },
}
/** workspaceRegistry.list() 是同步的（app.asar 1090460），这里照抄那个形状。 */
const fakeRegistry = {
  list() { return [{ id: 'ws-a', path: 'D:\\proj\\a', title: '项目 A' }] },
}

/**
 * webServer 替身：只实现 register()。
 *
 * 桌面设置面板的数据路由挂在它上面。注册不上**不会报错**，只会安静地少一个
 * 面板 —— 所以必须断言"真的注册了、路径对、只给回环、不泄密"。
 */
const routes = []
const fakeWebServer = {
  register(route) {
    routes.push(route)
    return () => {
      const i = routes.indexOf(route)
      if (i >= 0) routes.splice(i, 1)
    }
  },
}

/* ------------------------------ HTTP 客户端 ------------------------------ */

let PORT = 0
function request(method, pathname, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const r = https.request({
      host: '127.0.0.1', port: PORT, path: pathname, method,
      agent: false,
      // 证书层已由 cert-test.mjs 单独验证（真实 TLS 握手 + 负向用例），
      // 这里只关心入口接线，所以不重复校验证书链。
      rejectUnauthorized: false,
      headers: { Host: `127.0.0.1:${PORT}`, ...headers },
    }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { text += c })
      res.on('end', () => {
        let parsed = null
        try { parsed = JSON.parse(text) } catch { /* 非 JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed, text })
      })
    })
    r.on('error', reject)
    if (body !== null) r.write(body)
    r.end()
  })
}
const getJson = (p, cookie) => request('GET', p, { headers: cookie ? { Cookie: cookie } : {} })
const postJson = (p, obj, cookie) => request('POST', p, {
  headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
  body: JSON.stringify(obj),
})

/* ============================== 开跑 ============================== */

const QUESTION = [{ id: 'q1', question: '要继续吗？', header: '确认', options: [{ label: '继续' }, { label: '停下' }] }]

console.log('\n———— 入口：apply() 真跑一遍 ————')

PORT = await freePort()
fs.writeFileSync(path.join(TMP, 'mobile-mirror.json'), JSON.stringify({
  port: PORT, username: 'u', password: 'pass-123', tls: true, sessionTtlDays: 1,
  certDir: null, allowedHosts: [], enablePrompt: true,
}))
process.env.DSH_HOME = TMP

// 捕获插件日志：safeLog 是运行时调 console.log，所以替换 console.log 就能拿到。
// 只收 [mobile-mirror] 开头的行 —— 否则测试自己的输出会混进来（有的用例名里
// 正好包含"注册提问转发失败"，会把那条否定断言弄成自证）。
const logs = []
const realLog = console.log
console.log = (...args) => {
  const line = args.map((x) => String(x)).join(' ')
  if (line.includes('[mobile-mirror]')) logs.push(line)
  realLog(...args)
}

let applyErr = null
const services = { sessionController: fakeController, agentPresets: fakePresets, agents: fakeAgents, workspaceRegistry: fakeRegistry, webServer: fakeWebServer }
const { root, handlers, disposers, calls } = createFakeRoot(services)

let mod = null
try {
  mod = await import(pathToFileURL(path.join(LIB, 'index.js')).href)
  mod.apply(root)
} catch (err) {
  applyErr = err
}

check('apply() 不抛错', !applyErr, applyErr && applyErr.stack)
eq('插件名与 cordis.patch.yml 一致', mod && mod.name, 'mobile-mirror')
check('默认导出与具名导出一致', mod && mod.default && mod.default.name === mod.name)

const listened = await waitFor(() => logs.find((l) => l.includes('listening on 0.0.0.0:')))
check('插件真的把服务起起来了', !!listened, logs.join(' | '))
if (listened) eq('监听在配置的端口上', listened.includes(`0.0.0.0:${PORT}`), true)

check('日志写明已接入会话服务', logs.some((l) => l.includes('会话服务已接入')), logs.join(' | '))
check('日志写明已接入模式与 agent 服务', logs.some((l) => l.includes('模式与 agent 服务已接入')), logs.join(' | '))
check('日志写明已注册提问转发', logs.some((l) => l.includes('已注册提问转发')), logs.join(' | '))
check('日志里没有"注册提问转发失败"', !logs.some((l) => l.includes('注册提问转发失败')), logs.join(' | '))

// —— 注册本身 ——
const onCall = calls.find((c) => c.event === 'user-questions/request')
check('注册了 user-questions/request', !!onCall)
eq('注册时带 prepend（不带就会被 Remote 转发器吃掉）', onCall && onCall.prepend, true)
const answerers = handlers.get('user-questions/request') || []
eq('waterfall 上有一个处理器', answerers.length, 1)
check('注册时没有把 next 当成参数传错', typeof answerers[0] === 'function')

// —— 桌面设置面板的数据路由（lib/client.js 面板的唯一数据来源）——
console.log('\n———— 桌面设置面板：主机侧路由 ————')
const wsCall = calls.find((c) => c.event === 'inject' && c.keys.includes('webServer'))
check('注入了 webServer', !!wsCall, JSON.stringify(calls))
eq('只注册了一条路由（不多占路径）', routes.length, 1)
const panelRoute = routes[0]
check('路由是 exact 类型', !!panelRoute && panelRoute.kind === 'exact', panelRoute && panelRoute.kind)
eq('路径就是 /dsh-mirror/info.json', mod.PANEL_ROUTE, '/dsh-mirror/info.json')
eq('路由路径与导出的常量一致', panelRoute && panelRoute.path, mod.PANEL_ROUTE)
check('日志写明面板已接线', logs.some((l) => l.includes('桌面设置面板已接线')), logs.join(' | '))

/** 直接调用路由处理器：造一个最小的 req/res，绕开真实 HTTP。 */
function callPanelRoute(remoteAddress) {
  const req = { socket: { remoteAddress }, headers: {} }
  const res = {
    statusCode: 0,
    headers: {},
    setHeader(k, v) { this.headers[k] = v },
    end(body) { this.body = body },
  }
  panelRoute.handler(req, res)
  return res
}

const loopRes = callPanelRoute('127.0.0.1')
eq('回环请求回 200', loopRes.statusCode, 200)
eq('回环请求的 content-type 是 JSON', loopRes.headers['content-type'], 'application/json; charset=utf-8')
eq('回环请求不许被缓存', loopRes.headers['cache-control'], 'no-store')

const panel = JSON.parse(loopRes.body)
eq('payload 带 ok 标记', panel.ok, true)
eq('端口来自配置', panel.port, PORT)
eq('协议是 https', panel.scheme, 'https')
eq('回环设置页地址正确', panel.setupUrl, `https://127.0.0.1:${PORT}/setup`)
eq('回环主页地址正确', panel.loopbackUrl, `https://127.0.0.1:${PORT}/`)
eq('诊断页地址正确', panel.diagnosticsUrl, `https://127.0.0.1:${PORT}/pair.json`)
eq('带上账号', panel.username, 'u')
eq('口令状态为已配置', panel.configured, true)
eq('sessionTtlDays 透传', panel.sessionTtlDays, 1)
eq('enablePrompt 透传', panel.enablePrompt, true)
check('证书指纹非空（面板要显示它）', typeof panel.tls.fingerprint === 'string' && panel.tls.fingerprint.length > 0, JSON.stringify(panel.tls))
eq('tls.enabled 为 true', panel.tls.enabled, true)
check('局域网候选是个数组', Array.isArray(panel.candidates))
check('每个候选都有 name/address/https url',
  panel.candidates.every((c) => c.name && c.address && String(c.url).startsWith('https://')),
  JSON.stringify(panel.candidates))

// 少给永远比给多了再后悔便宜：这几样一个都不许出现在这条路由上。
for (const secret of ['passwordHash', 'password', 'certDir', 'stats', 'throttle']) {
  eq(`payload 不含 ${secret}`, Object.prototype.hasOwnProperty.call(panel, secret), false)
}
check('payload 整体不含 scrypt 字样', !loopRes.body.includes('scrypt'), loopRes.body)
check('payload 整体不含 cert.pem / key.pem 路径', !loopRes.body.includes('cert.pem') && !loopRes.body.includes('key.pem'), loopRes.body)

eq('非回环请求被拒（403）', callPanelRoute('10.0.0.9').statusCode, 403)
eq('非回环请求不吐正文', callPanelRoute('192.168.1.20').body, 'loopback only')
eq('IPv6 回环也算回环', callPanelRoute('::1').statusCode, 200)
eq('IPv4-mapped 回环也算回环', callPanelRoute('::ffff:127.0.0.1').statusCode, 200)

// —— 登录，然后走真实 HTTP 路由 ——
const login = await request('POST', '/login', {
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: 'username=u&password=pass-123',
})
const cookie = String(login.headers['set-cookie'] || '').split(';')[0]
check('能登录（说明明文口令已被转成哈希）', login.status === 303 && cookie.startsWith('dsh_mm_session='), `status=${login.status}`)

const presetsRes = await getJson('/api/presets', cookie)
eq('入口注入的 agentPresets 生效了', presetsRes.status, 200)
eq('模式清单条数', presetsRes.body.presets.length, 2)
eq('内置模式补上中文名', presetsRes.body.presets.find((p) => p.id === 'cordis').label, '创造模式')

// —— 新建会话：入口 → 宿主 ——
//
// workspaceRegistry 必须**单独**一次 inject：Cordis 的 inject 要等所有依赖就绪才回调，
// 把它塞进 agentPresets/agents 那一批里，任何一个服务缺失都会连带饿死另外两个。
console.log('\n———— 新建会话：入口 → 宿主 ————')

const injectCalls = calls.filter((c) => c.event === 'inject').map((c) => c.keys.join('+'))
check('workspaceRegistry 是单独一次 inject', injectCalls.includes('workspaceRegistry'), injectCalls.join(' | '))
check('没有把它混进 agentPresets 那一批',
  !injectCalls.some((k) => k.includes('workspaceRegistry') && k.includes('agentPresets')), injectCalls.join(' | '))
check('日志写明已接入工作区登记表', logs.some((l) => l.includes('工作区登记表已接入')), logs.join(' | '))
check('日志里没有"注入 workspaceRegistry 失败"',
  !logs.some((l) => l.includes('注入 workspaceRegistry 失败')), logs.join(' | '))

const wsRes = await getJson('/api/workspaces', cookie)
eq('工作区清单可读', wsRes.status, 200)
eq('登记的工作区出现在清单里', wsRes.body.workspaces[0].path, 'D:\\proj\\a')
eq('登记名带出来', wsRes.body.workspaces[0].name, '项目 A')
eq('没有会话的目录 sessionCount 为 0', wsRes.body.workspaces[0].sessionCount, 0)

const createRes = await postJson('/api/session', { cwd: 'D:\\proj\\a' }, cookie)
eq('新建会话成功', createRes.status, 200)
eq('宿主生成的 id 原样返回', createRes.body.sessionId, 'session-from-host')
eq('请求真的打到了宿主', createCalls.length, 1)
eq('cwd 传对了', createCalls[0].cwd, 'D:\\proj\\a')

console.log('\n———— 提问转发：手机作答 ————')

// 桌面那条路：假装 GUI 开着但用户还没点 —— 永远 pending。
// 必须显式挂到 waterfall 上：answerer 的 next() 走到链尾就是"没有 answerer"，
// 那是另一条分支（桌面报错 → 只等手机），不是这里要测的。
let desktopCalls = 0
const desktopNeverAnswers = () => { desktopCalls += 1; return new Promise(() => {}) }

const pending = runWaterfall([...answerers, desktopNeverAnswers], { agent: { id: 'sess-1' }, questions: QUESTION })

const listed = await waitFor(async () => {
  const res = await getJson('/api/questions?id=sess-1', cookie)
  return res.body.items.length ? res.body.items : null
})
check('手机侧看到了这个提问', !!listed, '等了 8 秒还是没登记进 hub')
if (listed) {
  eq('待答问题就是它', listed[0].questions.length, 1)
  eq('题干透传正确', listed[0].questions[0].question, '要继续吗？')
  eq('桌面那条路被同步调用过（桌面卡片照常出现）', desktopCalls, 1)

  const answered = await postJson('/api/answer', {
    questionId: listed[0].id,
    answers: [{ id: 'q1', selected: ['继续'] }],
  }, cookie)
  eq('手机作答 → 200', answered.status, 200)
  eq('响应带回答案', answered.body.accepted, true)

  const result = await pending
  eq('waterfall 拿到的就是手机给的答案', result.answers[0].selected[0], '继续')
  eq('答案的题目 id 正确', result.answers[0].id, 'q1')

  const after = await getJson('/api/questions?id=sess-1', cookie)
  eq('作答后待答列表清空', after.body.items.length, 0)
}

console.log('\n———— 顺序反过来就答不上（prepend 的存在理由） ————')

// Remote 转发层：认出 agent 后直接返回桌面的答案，不调 next()
const remoteForwarder = () => Promise.resolve({ answers: [{ id: 'q1', selected: ['桌面自己答的'] }] })

const wrongOrder = await runWaterfall([remoteForwarder, ...answerers], { agent: { id: 'sess-2' }, questions: QUESTION })
eq('排在后面前，提问被前面的处理器吃掉', wrongOrder.answers[0].selected[0], '桌面自己答的')
const listed2 = await getJson('/api/questions?id=sess-2', cookie)
eq('被吃掉时问题根本没登记进手机侧（手机无从作答）', listed2.body.items.length, 0)

console.log('\n———— 入口：服务与路由都在 ————')

const sessions = await getJson('/api/sessions', cookie)
eq('/api/sessions 可用（controller 已注入）', sessions.status, 200)
eq('/api/sessions 带 groups', Array.isArray(sessions.body.groups), true)
const models = await getJson('/api/models', cookie)
eq('/api/models 可用', models.status, 200)
const anon = await getJson('/api/sessions')
eq('未登录 → 401', anon.status, 401)
const disabled = await postJson('/api/answer', { questionId: 'x', answers: [] })
eq('未登录作答 → 401', disabled.status, 401)

// —— 拿不到 webServer 时必须软失败：一个便利面板不该把宿主拖垮 ——
console.log('\n———— 没有 webServer 时的软失败 ————')
const logsBefore = logs.length
const second = createFakeRoot({ sessionController: fakeController })
let secondErr = null
try { mod.apply(second.root) } catch (err) { secondErr = err }
check('没有 webServer 时 apply() 也不抛错', !secondErr, secondErr && secondErr.stack)
check('日志说明面板读不到主机信息',
  logs.slice(logsBefore).some((l) => l.includes('没有 webServer')), logs.slice(logsBefore).join(' | '))
eq('没有 webServer 时不会多注册任何路由', routes.length, 1)
// 等第二次 listen 的成败落定再收尾：否则它可能在主服务释放端口之后才绑上，
// 让下面那条"端口不再接受连接"变成偶发失败。
await waitFor(() => logs.slice(logsBefore).some((l) => l.includes('监听 0.0.0.0:')), 4000)
for (const d of second.disposers) {
  try { await d() } catch { /* 忽略 */ }
}

// —— 收尾 ——
console.log = realLog
for (const d of disposers) {
  try { await d() } catch { /* 忽略 */ }
}

// 端口必须真的不再接受连接：插件被禁用或热重载时，这是唯一能收回端口的机会。
// 收不回来就会残留占用，下次启用直接 EADDRINUSE。
// 注意不能用"再绑一次能不能成功"来判断 —— Windows 的 SO_REUSEADDR 会让重复绑定
// 成功，那个判断是空的。直接连一次才靠谱。
let probe = { refused: false, note: '未探测' }
for (let i = 0; i < 60 && !probe.refused; i += 1) {
  probe = await portRefuses(PORT)
  if (!probe.refused) await sleep(50)
}
check('dispose 之后端口不再接受连接', probe.refused, probe.note)

// 诊断信息，不是断言：上面那条"端口不再接受连接"才是真正的判据。
const leftovers = process.getActiveResourcesInfo().filter((r) => r !== 'TTYWrap')
if (leftovers.length) console.log(`（诊断：仍有活跃资源 ${leftovers.join(', ')}）`)

try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { /* 忽略 */ }

console.log(`\n${passed}/${passed + failed} 通过`)
// 明确退出：测试里还挂着一个永不 resolve 的 promise 用来模拟"桌面端没作答"，
// 虽然它本身不占事件循环，但没必要为此赌一把。
process.exit(failed > 0 ? 1 : 0)
