/**
 * P1 测试：会话数据层 + 三条镜像路由。
 *
 * 关键点：用一个**伪造的 sessionController** 驱动真实的 HTTP 服务，
 * 于是不需要启动 DSH、不需要重启宿主，就能端到端验证
 * `/api/sessions`、`/api/follow`（SSE）、`/api/page` 的完整管道
 * —— 包括登录鉴权、SSE 头、事件投影、逐字帧、背压与收尾。
 */

import https from 'node:https'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  projectEvent, projectStreamFrame, projectSnapshot, encodeFollowFrame,
  normalizeSummary, titleOf, projectBlocks, listSessions, pageBack, openFollow,
} from '../lib/mirror.js'
import { createMirrorServer } from '../lib/server.js'

const PORT = 19397
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-p1-'))

let passed = 0
let failed = 0
function check(name, ok, detail) {
  if (ok) { passed += 1; console.log(`PASS  ${name}${detail ? `  — ${detail}` : ''}`) } else { failed += 1; console.log(`FAIL  ${name}${detail ? `  — ${detail}` : ''}`) }
}
function eq(name, actual, expected) {
  check(name, Object.is(actual, expected), `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
}

// ==================== 一、数据层（纯函数） ====================
console.log('\n———— 数据层 ————')

// 标题提取：SessionSummary 没有 title 字段，只能从 projections.values 里捞
eq('标题：projections.title 优先', titleOf({ projections: { values: { title: '  会话甲  ' } } }), '会话甲')
eq('标题：模糊匹配 title 类键', titleOf({ projections: { values: { sessionTitle: '会话乙' } } }), '会话乙')
eq('标题：取不到返回 null', titleOf({ projections: { values: {} } }), null)
eq('标题：没有 projections 也不炸', titleOf({}), null)

const summary = normalizeSummary({
  sessionId: 's1', running: true, updatedAt: 123, cwd: 'D:\\x',
  projections: { values: { title: 'T' } },
})
eq('摘要归一化：id', summary.id, 's1')
eq('摘要归一化：running', summary.running, true)
eq('摘要归一化：title', summary.title, 'T')
eq('摘要归一化：缺字段不炸', normalizeSummary({}).running, false)

// 内容块
const blocks = projectBlocks([
  { type: 'text', text: 'hi' },
  { type: 'reasoning', text: 'think' },
  { type: 'image', attachment: { attachmentId: 'a1', mediaType: 'image/png', width: 3, height: 4, bytes: 5 } },
  { type: 'tool-call', id: 'c', name: 'read', arguments: '{"a":1}' },
  { type: 'mystery' },
  null,
])
eq('内容块：条数（含丢弃 null）', blocks.length, 5)
eq('内容块：image 提取 attachmentId', blocks[2].attachmentId, 'a1')
eq('内容块：未知类型保留 type', blocks[4].type, 'mystery')

// 事件投影
const userEvent = projectEvent({ type: 'user/message', seq: 1, time: 10, data: { id: 'm1', content: [{ type: 'text', text: 'hello' }] } })
eq('user/message：role', userEvent.data.role, 'user')
eq('user/message：文本', userEvent.data.blocks[0].text, 'hello')

const headerEvent = projectEvent({
  type: 'request/header', seq: 2, time: 20,
  data: { turn: 1, reason: 'user', header: { config: { model: 'm', provider: 'p' }, tools: [{}, {}, {}] } },
})
eq('request/header：只留 toolCount', headerEvent.data.toolCount, 3)
check('request/header：不下发工具 schema', headerEvent.data.tools === undefined && headerEvent.data.omitted.includes('toolSchemas'))

const assistantEvent = projectEvent({
  type: 'assistant/message', seq: 3, time: 30,
  data: {
    message: { id: 'a1', content: [{ type: 'text', text: 'hi' }], source: { model: 'deepseek' } },
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2 },
    interrupted: true,
    stream: [{ huge: 'x'.repeat(5000) }],
  },
})
eq('assistant/message：模型', assistantEvent.data.model, 'deepseek')
eq('assistant/message：usage', assistantEvent.data.usage.outputTokens, 5)
eq('assistant/message：中断标记', assistantEvent.data.interrupted, true)
check('assistant/message：丢掉冗余 stream 字段', assistantEvent.data.stream === undefined)

const resultEvent = projectEvent({
  type: 'tool/result', seq: 5, time: 50,
  data: { message: { isError: true, source: { callId: 'c1' }, content: [{ type: 'text', text: 'boom' }] } },
})
eq('tool/result：callId 从 source 取', resultEvent.data.callId, 'c1')
eq('tool/result：错误标记', resultEvent.data.isError, true)

const sysEvent = projectEvent({ type: 'system/message', seq: 6, time: 60, data: { content: [{ type: 'text', text: 'x'.repeat(50000) }] } })
eq('system/message：省略', sysEvent.data.omitted, true)
check('system/message：不携带 5 万字正文', !JSON.stringify(sysEvent).includes('xxxxx'))

eq('assistant/attempt：整条丢弃', projectEvent({ type: 'assistant/attempt', seq: 7, time: 70, data: {} }), null)
eq('未知类型：保留 type 但不下发 data', projectEvent({ type: 'brand/new', seq: 8, time: 80, data: { big: 'x'.repeat(9999) } }).unknown, true)
eq('非法输入返回 null', projectEvent(null), null)

// 截断
const longText = projectEvent({ type: 'user/message', seq: 9, time: 90, data: { content: [{ type: 'text', text: 'y'.repeat(10000) }] } })
check('超长文本被截断并留标记', longText.data.blocks[0].text.includes('已截断') && longText.data.blocks[0].text.length < 5000, `长度 ${longText.data.blocks[0].text.length}`)

// 逐字帧
eq('逐字：text-delta', projectStreamFrame({ type: 'chunk', chunk: { type: 'text-delta', index: 0, text: 'ab' } }).k, 'text')
eq('逐字：空 delta 丢弃', projectStreamFrame({ type: 'chunk', chunk: { type: 'text-delta', index: 0, text: '' } }), null)
eq('逐字：tool-call-delta', projectStreamFrame({ type: 'chunk', chunk: { type: 'tool-call-delta', index: 1, id: 'c', name: 'read', argumentsDelta: '{' } }).a, '{')
eq('逐字：end outcome', projectStreamFrame({ type: 'end', outcome: { kind: 'committed' } }).outcome, 'committed')
eq('逐字：未知 chunk 丢弃', projectStreamFrame({ type: 'chunk', chunk: { type: 'nope' } }), null)

// 快照 + 信封
const snapshot = projectSnapshot({
  header: { id: 's1', cwd: 'D:\\x', createdAt: 1, agentPreset: null },
  cursor: 42,
  hasMore: true,
  records: [{ type: 'event', event: { type: 'user/message', seq: 41, time: 1, data: { content: [{ type: 'text', text: 'a' }] } } }],
  projections: { values: { title: 'T' } },
  assistantStream: {
    revision: 1,
    activeAttempt: { attemptId: 'at1', turn: 2, step: 1, nextIndex: 3, stream: [{ type: 'chunk', chunk: { type: 'text-delta', index: 0, text: 'partial' } }] },
  },
})
eq('快照：cursor', snapshot.cursor, 42)
eq('快照：hasMore', snapshot.hasMore, true)
eq('快照：records 投影', snapshot.records[0].data.blocks[0].text, 'a')
eq('快照：投影值透传', snapshot.projections.title, 'T')
eq('快照：活动 attempt 重放', snapshot.assistantStream.activeAttempt.stream[0].t, 'partial')

eq('信封：snapshot', encodeFollowFrame({ type: 'snapshot', header: {}, records: [] }).e, 'snapshot')
eq('信封：冗余帧返回 null', encodeFollowFrame({ type: 'assistant-stream', frame: { type: 'chunk', chunk: { type: 'text-delta', index: 0, text: '' } } }), null)
eq('信封：未知帧返回 null', encodeFollowFrame({ type: 'weird' }), null)

// ==================== 二、伪造 sessionController ====================
const SESSION_ID = 'sess-1'

const RAW_EVENTS = [
  { type: 'user/message', seq: 1, time: 100, data: { id: 'm1', content: [{ type: 'text', text: '你好' }] } },
  { type: 'request/header', seq: 2, time: 200, data: { turn: 1, reason: 'user', header: { config: { model: 'deepseek-v4', provider: 'deepseek' }, tools: [{}, {}] } } },
  { type: 'assistant/message', seq: 3, time: 300, data: { message: { id: 'a1', content: [{ type: 'text', text: '在的' }], source: { model: 'deepseek-v4' } }, usage: { inputTokens: 7, outputTokens: 3 }, interrupted: false, stream: [{ junk: 'x'.repeat(3000) }] } },
  { type: 'system/message', seq: 4, time: 400, data: { content: [{ type: 'text', text: 'S'.repeat(30000) }] } },
  { type: 'tool/call', seq: 5, time: 500, data: { callId: 'c1', name: 'read_file', arguments: '{"path":"README.md"}' } },
  { type: 'tool/result', seq: 6, time: 600, data: { message: { isError: false, source: { callId: 'c1' }, content: [{ type: 'text', text: '内容' }] } } },
  { type: 'turn/end', seq: 7, time: 700, data: { turn: 1, reason: { kind: 'completed' } } },
]

let followRequest = null
function fakeController() {
  return {
    async list() {
      return {
        items: [
          { sessionId: 'sess-2', running: false, updatedAt: 200, cwd: 'D:\\b', projections: { values: { title: '第二个' } } },
          { sessionId: SESSION_ID, running: true, updatedAt: 100, cwd: 'D:\\a', projections: { values: { title: '第一个' } } },
        ],
      }
    },
    async page(request) {
      return { records: [{ type: 'event', event: { type: 'user/message', seq: 0, time: 1, data: { content: [{ type: 'text', text: '更早' }] } } }], hasMore: false, _echo: request }
    },
    follow(request, signal) {
      followRequest = request
      return (async function* generate() {
        yield { type: 'snapshot', header: { id: SESSION_ID, cwd: 'D:\\a', createdAt: 1 }, cursor: 7, hasMore: false, records: RAW_EVENTS.slice(0, 4).map((event) => ({ type: 'event', event })), projections: { values: { title: '第一个' } }, assistantStream: null }
        yield { type: 'event', event: RAW_EVENTS[4] }
        yield { type: 'assistant-stream', frame: { type: 'start', turn: 1, step: 2 } }
        yield { type: 'assistant-stream', frame: { type: 'chunk', chunk: { type: 'text-delta', index: 0, text: '正在' } } }
        yield { type: 'assistant-stream', frame: { type: 'chunk', chunk: { type: 'text-delta', index: 0, text: '输出' } } }
        yield { type: 'assistant-stream', frame: { type: 'chunk', chunk: { type: 'text-delta', index: 0, text: '' } } }
        yield { type: 'assistant-stream', frame: { type: 'end', outcome: { kind: 'committed' } } }
        yield { type: 'event', event: RAW_EVENTS[6] }
        if (signal && signal.aborted) return
      })()
    },
  }
}

// ==================== 三、三条路由（真 HTTPS + 真鉴权） ====================
console.log('\n———— 路由 ————')

const config = {
  port: PORT, username: '', passwordHash: null, password: null,
  sessionTtlDays: 30, tls: true, certDir: path.join(TMP, 'cert'),
  allowedHosts: [], enablePrompt: false,
}
const deps = { controller: null }
const mirror = createMirrorServer(config, { log: () => {}, configFile: path.join(TMP, 'config.json'), deps })
await mirror.listen()
const certPem = mirror.certPem

function req(pathname, { method = 'GET', headers = {}, body, raw = false, skipNameCheck = false } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? new URLSearchParams(body).toString() : null
    const r = https.request({
      host: '127.0.0.1', port: PORT, path: pathname, method,
      ca: certPem, rejectUnauthorized: true,
      // 故意伪造 Host 的用例：TLS 客户端默认会拿 Host 去比对证书 SAN，
      // 那会把请求提前打死在客户端。此时只跳过名称比对，证书链仍然验证。
      ...(skipNameCheck ? { checkServerIdentity: () => undefined } : {}),
      headers: {
        Host: `127.0.0.1:${PORT}`,
        ...(payload ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...headers,
      },
    }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve({ status: res.statusCode, headers: res.headers, text, body: raw ? text : (() => { try { return JSON.parse(text) } catch { return null } })() })
      })
    })
    r.on('error', reject)
    if (payload) r.write(payload)
    r.end()
  })
}

// 建账号并登录
await req('/setup', { method: 'POST', body: { username: 'u', password: 'pass-123', confirm: 'pass-123' } })
const login = await req('/login', { method: 'POST', body: { username: 'u', password: 'pass-123', remember: 'on' } })
const cookie = String(login.headers['set-cookie']).split(';')[0]
check('登录成功拿到 Cookie', login.status === 303 && cookie.startsWith('dsh_mm_session='))

// 未登录访问镜像接口 → 401
// 注意顺序：鉴权在"会话能力是否就绪"之前，不向未登录者泄露服务状态。
const anon = await req('/api/sessions')
eq('未登录访问 /api/sessions → 401', anon.status, 401)
const anonFollow = await req('/api/follow?id=x')
eq('未登录访问 /api/follow → 401', anonFollow.status, 401)

// 已登录、但会话服务还没接入 → 503
const before = await req('/api/sessions', { headers: { Cookie: cookie } })
eq('会话服务未接入 → 503', before.status, 503)
eq('503 带可读原因', before.body.error, 'session-controller-unavailable')

// 接入伪造 controller
deps.controller = fakeController()

const list = await req('/api/sessions', { headers: { Cookie: cookie } })
eq('/api/sessions → 200', list.status, 200)
eq('列表按 updatedAt 降序', list.body.items[0].id, 'sess-2')
eq('列表带标题', list.body.items[0].title, '第二个')
eq('列表带 running', list.body.items[1].running, true)

// 翻页
const page = await req('/api/page?id=' + SESSION_ID + '&before=5&max=20', { headers: { Cookie: cookie } })
eq('/api/page → 200', page.status, 200)
eq('翻页返回投影后的事件', page.body.records[0].data.blocks[0].text, '更早')
eq('翻页透传 hasMore', page.body.hasMore, false)

// SSE
const follow = await req('/api/follow?id=' + SESSION_ID + '&max=30', { headers: { Cookie: cookie }, raw: true })
eq('/api/follow → 200', follow.status, 200)
check('SSE Content-Type 正确', String(follow.headers['content-type']).startsWith('text/event-stream'), String(follow.headers['content-type']))
check('SSE 禁缓存', String(follow.headers['cache-control']).includes('no-store'))

const frames = follow.text
  .split('\n\n')
  .map((chunk) => chunk.trim())
  .filter((chunk) => chunk.startsWith('data:'))
  .map((chunk) => JSON.parse(chunk.slice(5).trim()))

eq('SSE 首帧是 snapshot', frames[0].e, 'snapshot')
eq('snapshot cursor', frames[0].d.cursor, 7)
eq('snapshot 只投影了前 4 条历史', frames[0].d.records.length, 4)
check('snapshot 里的 system/message 被省略', frames[0].d.records[3].data.omitted === true)
check('snapshot 里的 assistant/message 丢掉了冗余 stream', frames[0].d.records[2].data.stream === undefined)

const eventFrames = frames.filter((frame) => frame.e === 'event')
eq('SSE 下发事件帧', eventFrames.length, 2)
eq('tool/call 事件投影', eventFrames[0].d.data.name, 'read_file')
eq('turn/end 事件投影 reason', eventFrames[1].d.data.reason, 'completed')

const streamFrames = frames.filter((frame) => frame.e === 'stream')
eq('SSE 下发逐字帧（空 delta 被丢弃）', streamFrames.length, 4)
eq('逐字拼接结果', streamFrames.filter((f) => f.d.k === 'text').map((f) => f.d.t).join(''), '正在输出')
eq('逐字 end 帧', streamFrames[streamFrames.length - 1].d.outcome, 'committed')

check('follow 请求带上了 assistantStream', followRequest.assistantStream === true)
eq('follow 请求 maxMessages 透传', followRequest.maxMessages, 30)
eq('follow 请求地址形状', JSON.stringify(followRequest.address), JSON.stringify({ kind: 'session', sessionId: SESSION_ID }))

// 缺参数
const noId = await req('/api/follow', { headers: { Cookie: cookie } })
eq('/api/follow 缺 id → 400', noId.status, 400)
const noBefore = await req('/api/page?id=' + SESSION_ID, { headers: { Cookie: cookie } })
eq('/api/page 缺 before → 400', noBefore.status, 400)

// 越权：伪造 Host 访问镜像接口
const badHost = await req('/api/sessions', { headers: { Cookie: cookie, Host: 'evil.example.com' }, skipNameCheck: true })
check('伪造 Host 访问镜像接口被挡', badHost.status === 403, String(badHost.status))

// —— 静态页面与资源（前端界面靠这几个文件才能真正跑起来） ——
const home = await req('/', { headers: { Cookie: cookie }, raw: true })
eq('主页 → 200', home.status, 200)
check('主页引用了 /app.js', home.text.includes('/app.js'))
check('主页引用了 /app.css', home.text.includes('/app.css'))
check('主页占位符已全部替换', !home.text.includes('{{'), (home.text.match(/\{\{[^}]*\}\}/g) || []).join(' '))
check('主页带上了当前账号', home.text.includes('u'))

const js = await req('/app.js', { headers: { Cookie: cookie }, raw: true })
eq('/app.js → 200', js.status, 200)
check('/app.js Content-Type 正确', String(js.headers['content-type']).startsWith('text/javascript'), String(js.headers['content-type']))
check('/app.js 走 raw、没有模板替换残留', !js.text.includes('{{'))
check('/app.js 不是错误页', !js.text.includes('<html') && js.text.length > 10000, `${js.text.length} 字节`)

const css = await req('/app.css', { headers: { Cookie: cookie }, raw: true })
eq('/app.css → 200', css.status, 200)
check('/app.css Content-Type 正确', String(css.headers['content-type']).startsWith('text/css'), String(css.headers['content-type']))
check('/app.css 走 raw、没有模板替换残留', !css.text.includes('{{'))

// 资源与页面一样在登录之后才可取
const anonJs = await req('/app.js')
eq('未登录取 /app.js → 401', anonJs.status, 401)

// 白名单之外一律 404（用编码的 ../ 绕开客户端的路径规范化）
const traversal = await req('/..%2fpackage.json', { headers: { Cookie: cookie } })
check('编码目录遍历被挡', traversal.status === 404, String(traversal.status))
const unknown = await req('/secret.txt', { headers: { Cookie: cookie } })
check('白名单外路径 → 404', unknown.status === 404, String(unknown.status))

await mirror.close()

// ==================== 四、脱离 HTTP 直测数据层入口 ====================
console.log('\n———— 数据层入口 ————')
const controller = fakeController()
const listed = await listSessions(controller, new AbortController().signal)
eq('listSessions 排序', listed[0].id, 'sess-2')
const paged = await pageBack(controller, SESSION_ID, 5, 20, new AbortController().signal)
eq('pageBack 投影', paged.records[0].data.blocks[0].text, '更早')

const iterator = openFollow(controller, SESSION_ID, { maxMessages: 999 }, new AbortController().signal)
const first = await iterator[Symbol.asyncIterator]().next()
eq('openFollow 首帧是 snapshot', first.value.type, 'snapshot')
eq('openFollow 把 maxMessages 夹到 200', followRequest.maxMessages, 200)

fs.rmSync(TMP, { recursive: true, force: true })
console.log(`\n${passed}/${passed + failed} 通过`)
if (failed > 0) process.exitCode = 1
