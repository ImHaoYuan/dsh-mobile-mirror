/**
 * P1 + P2 测试：会话数据层 + 五条镜像路由。
 *
 * 关键点：用一个**伪造的 sessionController** 驱动真实的 HTTP 服务，
 * 于是不需要启动 DSH、不需要重启宿主，就能端到端验证
 * `/api/sessions`、`/api/follow`（SSE）、`/api/page`、`/api/prompt`、`/api/cancel`
 * 的完整管道 —— 包括登录鉴权、SSE 头、事件投影、逐字帧、背压、
 * 写操作的校验/幂等/节流/CSRF 闸门。
 */

import https from 'node:https'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  projectEvent, projectStreamFrame, projectSnapshot, encodeFollowFrame,
  normalizeSummary, titleOf, projectBlocks, listSessions, pageBack, openFollow,
  validatePrompt, createPromptLedger, createRateGate, sendPrompt, cancelTurn, MAX_PROMPT_CHARS,
  // P3：工作区分组 / 模型 / 模式 / 提问
  presetOf, presetLabel, workspaceOf, groupSessions, PRESET_NAMES,
  normalizeModelCatalog, createCatalogCache, loadModelCatalog, loadPresetRoster,
  validateModelSwitch, switchModel, validatePresetSwitch, switchPreset,
  validateAnswers, createQuestionHub, createQuestionAnswerer, MAX_ANSWER_CHARS,
  // P4：新建会话
  normalizeWorkspaces, listRegisteredWorkspaces, validateSessionCreate, createSession,
  // P5：隐藏系统消息
  isInjectedUserMessage, stripInjectedBlocks,
} from '../lib/mirror.js'
import { createMirrorServer, WEB_ROOT } from '../lib/server.js'

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

// MessageBase 的确切字段名没查到，正文位置的兜底必须覆盖
eq('正文兜底：data.blocks',
  projectEvent({ type: 'user/message', seq: 1, time: 1, data: { blocks: [{ type: 'text', text: 'B' }] } }).data.blocks[0].text, 'B')
eq('正文兜底：message.blocks',
  projectEvent({ type: 'assistant/message', seq: 1, time: 1, data: { message: { blocks: [{ type: 'text', text: 'C' }] } } }).data.blocks[0].text, 'C')
eq('正文兜底：content 是裸字符串',
  projectEvent({ type: 'user/message', seq: 1, time: 1, data: { content: 'D' } }).data.blocks[0].text, 'D')
eq('正文兜底：都没有则为空数组，不炸',
  projectEvent({ type: 'user/message', seq: 1, time: 1, data: { nothing: 1 } }).data.blocks.length, 0)

const presented = projectEvent({
  type: 'deliverables/presented', seq: 9, time: 1,
  data: {
    turn: 2,
    files: [
      { path: 'D:\\a\\x.apk', description: '安装包' },
      { path: '   ' },
      'junk',
      null,
    ],
  },
})
eq('presented 下发文件清单', presented.data.files.length, 1)
eq('presented 保留路径', presented.data.files[0].path, 'D:\\a\\x.apk')
eq('presented 保留说明', presented.data.files[0].description, '安装包')
eq('presented 不再走未知事件分支', presented.unknown, undefined)
eq('presented 空清单整条不下发',
  projectEvent({ type: 'deliverables/presented', seq: 9, time: 1, data: { files: [] } }), null)
eq('presented 条数封顶 20',
  projectEvent({
    type: 'deliverables/presented', seq: 9, time: 1,
    data: { files: Array.from({ length: 50 }, (_, i) => ({ path: '/x/' + i })) },
  }).data.files.length, 20)
eq('presented 路径超长截断',
  projectEvent({
    type: 'deliverables/presented', seq: 9, time: 1,
    data: { files: [{ path: 'a'.repeat(900) }] },
  }).data.files[0].path.length, 512)

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

// 系统提示 / 开发者消息：整条丢弃，连"已省略"标记都不发
// （早先会下发一行 note，但那行本身就是噪音）
eq('system/message：整条丢弃',
  projectEvent({ type: 'system/message', seq: 6, time: 60, data: { content: [{ type: 'text', text: 'x'.repeat(50000) }] } }), null)
eq('developer/message：整条丢弃',
  projectEvent({ type: 'developer/message', seq: 6, time: 60, data: { content: [{ type: 'text', text: 'AGENTS.md 正文' }] } }), null)

// —— 注入的 user/message ——
//
// DSH 把 AGENTS.md、运行时上下文、技能目录等**也塞进 user/message**，只能靠
// `data.source.kind` 区分真人输入。kind 取值取自真实会话日志
// （sessions/--D-VibeCoding-Plugin--/session-*/session.v4.jsonl.zstd）。
console.log('\n  -- 注入的 user/message --')

const realUserEvent = {
  type: 'user/message', seq: 10, time: 100,
  data: { id: 'u1', content: [{ type: 'text', text: '你好' }], source: { kind: 'user', rpcId: 'r1' } },
}
eq('真人消息：保留', projectEvent(realUserEvent).data.blocks[0].text, '你好')

for (const kind of ['agent-instructions', 'runtime-context', 'skill-catalog', 'user-approval']) {
  eq(`注入 kind=${kind}：丢弃`, projectEvent({
    type: 'user/message', seq: 11, time: 100,
    data: { id: 'u2', content: [{ type: 'text', text: '<system-reminder>很长的一段英文</system-reminder>' }], source: { kind } },
  }), null)
}

// fail-safe：任何"说不清来源"的情况都必须当真人消息保留 ——
// 宁可多显示一条注入内容，也绝不能吞掉用户自己说的话。
const noSource = { type: 'user/message', seq: 12, time: 100, data: { content: [{ type: 'text', text: 'hi' }] } }
eq('缺 source：保留（fail-safe）', projectEvent(noSource).data.blocks[0].text, 'hi')
eq('source 不是对象：保留',
  projectEvent({ type: 'user/message', seq: 12, time: 100, data: { content: [{ type: 'text', text: 'hi' }], source: 'nope' } }).data.blocks[0].text, 'hi')
eq('source 里没有 kind：保留',
  projectEvent({ type: 'user/message', seq: 12, time: 100, data: { content: [{ type: 'text', text: 'hi' }], source: {} } }).data.blocks[0].text, 'hi')
eq('kind 是空串：保留',
  projectEvent({ type: 'user/message', seq: 12, time: 100, data: { content: [{ type: 'text', text: 'hi' }], source: { kind: '' } } }).data.blocks[0].text, 'hi')
eq('kind 不是字符串：保留',
  projectEvent({ type: 'user/message', seq: 12, time: 100, data: { content: [{ type: 'text', text: 'hi' }], source: { kind: 7 } } }).data.blocks[0].text, 'hi')

// 纯函数直接测（含"将来 DSH 加新 kind"的白名单语义）
eq('isInjectedUserMessage(null)', isInjectedUserMessage(null), false)
eq('isInjectedUserMessage(undefined)', isInjectedUserMessage(undefined), false)
eq('isInjectedUserMessage(不是对象)', isInjectedUserMessage('x'), false)
eq('isInjectedUserMessage({})', isInjectedUserMessage({}), false)
eq('kind=user → 不是注入', isInjectedUserMessage({ source: { kind: 'user' } }), false)
eq('kind=runtime-context → 是注入', isInjectedUserMessage({ source: { kind: 'runtime-context' } }), true)
eq('将来新增的未知 kind 也算注入（白名单语义，免得又冒出一堆噪音）',
  isInjectedUserMessage({ source: { kind: 'future-thing' } }), true)

// —— 按块剥离 <system-reminder> ——
//
// 为什么不能只靠 source.kind：**子代理的启动提示** kind 是 `user`（对那个子会话
// 来说它确实是"用户输入"），但内容是两块 —— 第 0 块是 reminder，第 1 块是真正的
// 任务书。整条丢掉会把任务书也丢了，所以只能按块剥。用例取自真实会话日志。
console.log('\n  -- 按块剥离 <system-reminder> --')

const REMINDER = '<system-reminder>\nYou are teammate "mobile-ui".\nYour Team Lead is named "lead".\n</system-reminder>\n\n'
const teammateMsg = {
  type: 'user/message', seq: 20, time: 200,
  data: {
    id: 'u3', source: { kind: 'user' },
    content: [{ type: 'text', text: REMINDER }, { type: 'text', text: '你要为插件实现手机端界面' }],
  },
}
const teammateOut = projectEvent(teammateMsg)
eq('子代理提示：剥掉 reminder 后还剩一块', teammateOut.data.blocks.length, 1)
eq('子代理提示：留下的是真正的任务书', teammateOut.data.blocks[0].text, '你要为插件实现手机端界面')

eq('整条就是一个 reminder → 连空气泡都不要',
  projectEvent({
    type: 'user/message', seq: 21, time: 200,
    data: { id: 'u4', source: { kind: 'user' }, content: [{ type: 'text', text: REMINDER }] },
  }), null)

// 只在**开头**出现、正文跟在同一个块里的，保持原样 —— 别误伤"引用了 reminder 又接着说正事"
const quoted = projectEvent({
  type: 'user/message', seq: 22, time: 200,
  data: { id: 'u5', content: [{ type: 'text', text: '<system-reminder>x</system-reminder>\n然后是正文' }] },
})
eq('reminder 后面跟着正文的块：不剥', quoted.data.blocks[0].text, '<system-reminder>x</system-reminder>\n然后是正文')
eq('纯文本消息照常', projectEvent({
  type: 'user/message', seq: 23, time: 200,
  data: { id: 'u6', content: [{ type: 'text', text: '普通一句' }] },
}).data.blocks[0].text, '普通一句')
// 没有文本块的消息不能因为"剥完为空"被误删（那是真人发的，比如只带附件）
check('本来就没有文本块 → 仍然下发（不当成剥空）',
  projectEvent({ type: 'user/message', seq: 24, time: 200, data: { id: 'u7', content: [] } }) !== null)

// 纯函数直接测
eq('stripInjectedBlocks(null)', stripInjectedBlocks(null), null)
eq('stripInjectedBlocks(非数组)', stripInjectedBlocks('x'), 'x')
eq('stripInjectedBlocks 只动文本块', stripInjectedBlocks([
  { type: 'image' }, { type: 'text', text: REMINDER }, { type: 'text', text: '正文' },
]).length, 2)
eq('stripInjectedBlocks 不动非字符串 text', stripInjectedBlocks([{ type: 'text', text: 123 }]).length, 1)
eq('stripInjectedBlocks 不动空对象', stripInjectedBlocks([null, {}, 'x']).length, 3)

eq('assistant/attempt：整条丢弃', projectEvent({ type: 'assistant/attempt', seq: 7, time: 70, data: {} }), null)

// ---- 未知事件：保留一份有界浅拷贝 ----
// 排查「手机上不显示错误」时，是靠逆向 app.asar 才知道正文藏在 turn/end 的
// reason.error 里。未接事件的字段名本身就是最好的线索，所以不能只留一个 unknown 标记。
const bigUnknown = projectEvent({ type: 'brand/new', seq: 8, time: 80, data: { big: 'x'.repeat(9999) } })
eq('未知类型：标记 unknown', bigUnknown.unknown, true)
check('未知类型：超大字符串被截断，不原样下发', bigUnknown.data.big.length < 200)

const shapes = projectEvent({
  type: 'brand/new', seq: 8.5, time: 85,
  data: { n: 1, s: 'txt', b: true, z: null, o: { nested: 'x' }, a: ['y', 'z'] },
})
eq('未知事件：数字照抄', shapes.data.n, 1)
eq('未知事件：字符串照抄', shapes.data.s, 'txt')
eq('未知事件：布尔照抄', shapes.data.b, true)
eq('未知事件：null 照抄', shapes.data.z, null)
eq('未知事件：嵌套对象只报形状（不递归）', shapes.data.o, '[object]')
eq('未知事件：数组只报长度', shapes.data.a, '[array 2]')

const manyKeys = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`k${i}`, i]))
check('未知事件：键数封顶 24', Object.keys(projectEvent({ type: 'x/y', seq: 8.6, time: 86, data: manyKeys }).data).length <= 24)
eq('未知事件：data 空对象时给 null', projectEvent({ type: 'x/y', seq: 8.7, time: 87, data: {} }).data, null)
eq('未知事件：data 不是对象时给 null', projectEvent({ type: 'x/y', seq: 8.8, time: 88, data: 'str' }).data, null)
eq('未知事件：data 是数组时给 null', projectEvent({ type: 'x/y', seq: 8.9, time: 89, data: [1, 2] }).data, null)

// ---- 轮次失败：错误正文必须透传 ----
// 这是用户报的「电脑上显示 API 密钥无效、手机上没有」的根因所在：
// 原先这一行只留 reason.kind，于是正文被丢在这里。
const failedTurn = projectEvent({
  type: 'turn/end', seq: 8.95, time: 89.5,
  data: {
    turn: 2,
    reason: {
      kind: 'error',
      error: { message: 'API 密钥无效', code: 'INVALID_API_KEY', status: 401, requestId: 'req-1', providerRetryAfterMs: 5000 },
    },
  },
})
eq('turn/end error：reason 仍是 error', failedTurn.data.reason, 'error')
eq('turn/end error：正文透传', failedTurn.data.error.message, 'API 密钥无效')
eq('turn/end error：错误码透传', failedTurn.data.error.code, 'INVALID_API_KEY')
eq('turn/end error：HTTP 状态透传', failedTurn.data.error.status, 401)
eq('turn/end error：requestId 不透传', failedTurn.data.error.requestId, undefined)
eq('turn/end error：providerRetryAfterMs 不透传', failedTurn.data.error.providerRetryAfterMs, undefined)

const sparseFail = projectEvent({ type: 'turn/end', seq: 8.96, time: 89.6, data: { turn: 3, reason: { kind: 'error', error: { message: '只给了正文' } } } })
eq('turn/end error：缺 code 时为 ""', sparseFail.data.error.code, '')
eq('turn/end error：缺 status 时为 null', sparseFail.data.error.status, null)
eq('turn/end error：连 error 对象都没有时不凭空造字段', projectEvent({ type: 'turn/end', seq: 8.97, time: 89.7, data: { turn: 4, reason: { kind: 'error' } } }).data.error, undefined)
eq('turn/end completed：不带 error', projectEvent({ type: 'turn/end', seq: 8.98, time: 89.8, data: { turn: 5, reason: { kind: 'completed' } } }).data.error, undefined)
eq('turn/end reason 缺失：降级 unknown', projectEvent({ type: 'turn/end', seq: 8.99, time: 89.9, data: { turn: 6 } }).data.reason, 'unknown')

eq('非法输入返回 null', projectEvent(null), null)

// 截断（Bug1：上限曾经是 4000，正常的长回答在手机上被硬截断）
const longText = projectEvent({ type: 'user/message', seq: 9, time: 90, data: { content: [{ type: 'text', text: 'y'.repeat(50000) }] } })
eq('五万字正文原样透传（不再截断正常消息）', longText.data.blocks[0].text.length, 50000)
check('五万字正文里没有截断标记', !longText.data.blocks[0].text.includes('已截断'))
const hugeText = projectEvent({ type: 'user/message', seq: 9.1, time: 90.1, data: { content: [{ type: 'text', text: 'y'.repeat(120000) }] } })
check('病态超长（12 万）仍截断并留标记', hugeText.data.blocks[0].text.includes('已截断，原长 120000 字符'))
check('病态超长的体积被压住', hugeText.data.blocks[0].text.length < 110000, `长度 ${hugeText.data.blocks[0].text.length}`)
const longReason = projectEvent({ type: 'assistant/message', seq: 9.2, time: 90.2, data: { message: { content: [{ type: 'reasoning', text: 'z'.repeat(30000) }] } } })
eq('三万字思考过程原样透传', longReason.data.blocks[0].text.length, 30000)

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

// 快照路径同样过滤（projectSnapshot 内部就是 projectEvent + filter(Boolean)）——
// 这一条很重要：翻历史时会重放整段记录，注入内容也在这里被挡掉，手机根本收不到。
const filteredSnap = projectSnapshot({
  header: { id: 's9', cwd: 'D:\\x', createdAt: 1 },
  cursor: 3,
  hasMore: false,
  records: [
    { type: 'event', event: realUserEvent },
    { type: 'event', event: { type: 'user/message', seq: 11, time: 100, data: { content: [{ type: 'text', text: 'AGENTS.md 正文' }], source: { kind: 'agent-instructions' } } } },
    { type: 'event', event: { type: 'system/message', seq: 12, time: 100, data: { content: [{ type: 'text', text: '系统提示' }] } } },
    { type: 'event', event: { type: 'developer/message', seq: 13, time: 100, data: { content: [{ type: 'text', text: '开发者消息' }] } } },
  ],
  projections: { values: {} },
})
eq('快照：注入内容与系统提示都被过滤', filteredSnap.records.length, 1)
eq('快照：留下的正是真人消息', filteredSnap.records[0].data.blocks[0].text, '你好')

eq('信封：snapshot', encodeFollowFrame({ type: 'snapshot', header: {}, records: [] }).e, 'snapshot')
eq('信封：冗余帧返回 null', encodeFollowFrame({ type: 'assistant-stream', frame: { type: 'chunk', chunk: { type: 'text-delta', index: 0, text: '' } } }), null)
eq('信封：未知帧返回 null', encodeFollowFrame({ type: 'weird' }), null)

// —— P2 纯函数 ——
eq('校验：缺 sessionId', validatePrompt({ requestId: 'a', text: 'x' }).error, 'missing-session-id')
eq('校验：requestId 含空格', validatePrompt({ sessionId: 's', requestId: 'a b', text: 'x' }).error, 'bad-request-id')
eq('校验：requestId 为空', validatePrompt({ sessionId: 's', requestId: '', text: 'x' }).error, 'bad-request-id')
eq('校验：requestId 超长', validatePrompt({ sessionId: 's', requestId: 'a'.repeat(129), text: 'x' }).error, 'bad-request-id')
eq('校验：text 不是字符串', validatePrompt({ sessionId: 's', requestId: 'a', text: 123 }).error, 'bad-text')
eq('校验：text 全是空白', validatePrompt({ sessionId: 's', requestId: 'a', text: '   \n ' }).error, 'empty-text')
eq('校验：text 超长', validatePrompt({ sessionId: 's', requestId: 'a', text: 'x'.repeat(MAX_PROMPT_CHARS + 1) }).error, 'text-too-long')
const okPrompt = validatePrompt({ sessionId: ' s ', requestId: 'a-1_B', text: '  你好  ', timeZone: 'Asia/Shanghai' })
eq('校验：通过并 trim 正文', okPrompt.value.text, '你好')
eq('校验：sessionId 也 trim', okPrompt.value.sessionId, 's')
eq('校验：时区透传', okPrompt.value.timeZone, 'Asia/Shanghai')
eq('校验：时区超长则丢弃', validatePrompt({ sessionId: 's', requestId: 'a', text: 'x', timeZone: 'z'.repeat(65) }).value.timeZone, undefined)

const ledger = createPromptLedger({ limit: 3, ttlMs: 1000 })
eq('台账：初始没有', ledger.has('r1'), false)
ledger.remember('r1')
eq('台账：记下后命中', ledger.has('r1'), true)
eq('台账：没记过的不命中', ledger.has('r2'), false)
for (const key of ['r2', 'r3', 'r4']) ledger.remember(key)
check('台账：超过上限淘汰最老的', !ledger.has('r1') && ledger.has('r4'), `size=${ledger.size}`)

const gate = createRateGate({ minIntervalMs: 300 })
eq('闸门：首次放行', gate.allow('s', 1000), true)
eq('闸门：间隔内拦下', gate.allow('s', 1100), false)
eq('闸门：间隔后放行', gate.allow('s', 1400), true)
eq('闸门：不同键互不影响', gate.allow('other', 1400), true)

// —— prompt 的 signal 兜底 ——
// 真机上踩过的坑：DSH 门面 prompt(request, signal) 第一行是 signal.throwIfAborted()，
// 且没有 undefined 保护。不传 signal 会得到一个 TypeError，
// 报错文案是 "Cannot read properties of undefined (reading 'throwIfAborted')"，
// 完全看不出根因，白花了一轮排查。
const sigController = {
  got: [],
  async prompt(request, signal) {
    signal.throwIfAborted()   // 模仿 DSH 门面，故意不加保护
    this.got.push(signal)
    return { accepted: true }
  },
}
const noSignalResult = await sendPrompt(sigController, { sessionId: 's', requestId: 'sig-1', text: 'x' })
eq('sendPrompt：调用方不传 signal 也能成功', noSignalResult.ok, true)
check('sendPrompt：内部补的是真实 AbortSignal',
  !!sigController.got[0] &&
  typeof sigController.got[0].throwIfAborted === 'function' &&
  sigController.got[0].aborted === false,
  sigController.got[0] ? `aborted=${sigController.got[0].aborted}` : 'signal 为空')

const providedAbort = new AbortController()
const fwdController = {
  got: null,
  async prompt(request, signal) { signal.throwIfAborted(); this.got = signal; return { accepted: true } },
}
await sendPrompt(fwdController, { sessionId: 's', requestId: 'sig-2', text: 'x' }, { signal: providedAbort.signal })
check('sendPrompt：调用方给了 signal 就原样透传', fwdController.got === providedAbort.signal)

const preAborted = new AbortController()
preAborted.abort()
let abortThrew = null
try {
  await sendPrompt(sigController, { sessionId: 's', requestId: 'sig-3', text: 'x' }, { signal: preAborted.signal })
} catch (err) { abortThrew = err }
check('sendPrompt：已 abort 的 signal 会抛（证明门面的检查真的在跑）',
  abortThrew !== null && /abort/i.test(String(abortThrew && abortThrew.name) + String(abortThrew && abortThrew.message)))

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
  // 注入的 user/message（AGENTS.md / 运行时上下文那一类）—— 必须整条丢弃。
  // 放在末尾是刻意的：前面那几条的索引（slice(0,4) / [4] / [6]）都不用动。
  { type: 'user/message', seq: 8, time: 800, data: { id: 'm2', content: [{ type: 'text', text: '<system-reminder>很长的一段英文'.repeat(500) }], source: { kind: 'runtime-context' } } },
]

let followRequest = null
// 翻页请求原样留一份：throughSeq / beforeSeq 传错会让手机端"往上翻就断"
let pageRequest = null
let promptCalls = []
let promptSignals = []
let cancelCalls = []
let catalogCalls = 0
let selectModelCalls = []
let sessionCreateCalls = []
function fakeController() {
  promptCalls = []
  promptSignals = []
  cancelCalls = []
  catalogCalls = 0
  selectModelCalls = []
  sessionCreateCalls = []
  return {
    // 精确模仿 DSH 门面（app.asar 第 339488 行）：
    //   prompt(request, signal) { signal.throwIfAborted(); return this.commands.prompt(request); }
    // 门面第一行就调 signal.throwIfAborted()，而且**没有 undefined 保护**。
    // 所以这里故意也不加保护：调用方忘传 signal 时必须在这里炸出来，
    // 而不是等到真机上只看到一句"上游报错"。
    async prompt(request, signal) {
      signal.throwIfAborted()
      promptCalls.push(request)
      promptSignals.push(signal)
      return { accepted: true }
    },
    cancel(request) {
      cancelCalls.push(request)
      return { accepted: true }
    },
    async list() {
      return {
        items: [
          {
            sessionId: 'sess-2', running: false, updatedAt: 200, cwd: 'D:\\b', blank: false,
            projections: {
              values: {
                title: '第二个',
                // 创造模式：投影和 header 故意不一致的用例在纯函数一节里
                agentPreset: 'cordis',
                modelSelection: {
                  lastUsed: { provider: 'doulor', model: 'wb-ds41f' },
                  next: { provider: 'doulor', model: 'wb-ds41f' },
                },
              },
            },
          },
          {
            sessionId: SESSION_ID, running: true, updatedAt: 100, cwd: 'D:\\a', blank: true,
            projections: { values: { title: '第一个', agentPreset: 'ptc' } },
          },
        ],
      }
    },
    async modelCatalog() {
      catalogCalls += 1
      return {
        default: { provider: 'doulor', model: 'wb-ds41f', reasoningEffort: 'medium' },
        routableProviders: ['doulor', 'olomc'],
        groups: [
          {
            id: 'doulor', name: 'Doulor',
            models: [{
              id: 'wb-ds41f', name: 'WB-DS41F', description: '主力模型',
              reasoning: { efforts: [{ id: 'low', name: '低' }, { id: 'medium', name: '中' }], defaultEffort: 'medium' },
            }],
          },
          { id: 'olomc', name: 'Voyager Gateway', models: [{ id: 'nim/nvidia/glm-5.3', name: 'GLM-5.3' }] },
          // 空组：上游会过滤，这里确认本插件也过滤
          { id: 'empty', name: '空组', models: [] },
        ],
        failures: [{ id: 'broken', name: '坏提供方', message: '连接超时' }],
      }
    },
    async selectModel(request) {
      selectModelCalls.push(request)
      if (request.model === 'nope') {
        throw Object.assign(new Error('模型不可用'), { code: 'session/model-unavailable' })
      }
      return { selected: { provider: request.provider, model: request.model, reasoningEffort: request.reasoningEffort } }
    },
    // P4：新建会话。门面签名是 create(request) —— **没有 signal**（app.asar 319530）。
    async create(request) {
      sessionCreateCalls.push(request)
      if (request.cwd === 'D:\\boom') {
        throw Object.assign(new Error('目录不可用'), { code: 'session/unavailable' })
      }
      return { sessionId: 'session-new-1', agentPreset: request.agentPreset || 'standard' }
    },
    async page(request) {
      pageRequest = request
      return { records: [{ type: 'event', event: { type: 'user/message', seq: 0, time: 1, data: { content: [{ type: 'text', text: '更早' }] } } }], hasMore: false }
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
        // 注入消息也要走一遍真实的长连接路径，验证它在服务端就被丢掉
        yield { type: 'event', event: RAW_EVENTS[7] }
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
  // 主服务开写操作；只读模式（false）在下面单独起一个服务验证。
  allowedHosts: [], enablePrompt: true,
}
let presetSelectCalls = []
/** 伪造 agentPresets 服务（形状对齐 app.asar 288737 的 select(agent, agentPreset)）。 */
const fakePresets = {
  async list() {
    return [
      { id: 'standard' },
      { id: 'ptc' },
      { id: 'minimal' },
      { id: 'cordis' },
      { id: 'custom-one', name: '我的模式', description: '自己写的' },
    ]
  },
  async select(agent, preset) {
    presetSelectCalls.push({ agentId: agent && agent.id, preset })
    if (preset === 'ghost') throw Object.assign(new Error('没有这个模式'), { code: 'agent-preset/not-found' })
    if (preset === 'started') throw Object.assign(new Error('This session has already started'), { code: 'agent-preset/locked' })
    return preset
  },
}
/** 伪造 agents 服务：select 的第一个参数必须是 Agent 对象，所以这里得能取到。 */
const fakeAgents = {
  get(id) {
    if (id === 'no-agent-session') return null
    return { id, ctx: {}, session: {} }
  },
}

/**
 * 伪造 workspaceRegistry（list() 是**同步**的，形状对齐 app.asar 1090460）。
 * 故意包含一个和已有会话重复的目录（D:\a）：合并后应该只剩一条，且以登记表那条为准。
 */
const fakeRegistry = {
  list() {
    return [
      { id: 'ws-1', path: 'D:\\proj\\alpha', title: 'alpha 项目' },
      { id: 'ws-2', path: 'D:\\proj\\empty', title: '' },
      { id: 'ws-3', path: 'D:\\a', title: '会话里也有的目录' },
    ]
  },
}

const deps = { controller: null, presets: fakePresets, agents: fakeAgents, registry: fakeRegistry }
const mirror = createMirrorServer(config, { log: () => {}, configFile: path.join(TMP, 'config.json'), deps })
await mirror.listen()
const certPem = mirror.certPem

function req(pathname, { method = 'GET', headers = {}, body, json, rawText, raw = false, skipNameCheck = false, contentType } = {}) {
  return new Promise((resolve, reject) => {
    const isJson = json !== undefined
    const payload = rawText !== undefined
      ? rawText
      : (isJson ? JSON.stringify(json) : (body ? new URLSearchParams(body).toString() : null))
    const type = contentType !== undefined
      ? contentType
      : (isJson || rawText !== undefined ? 'application/json; charset=utf-8' : 'application/x-www-form-urlencoded')
    const r = https.request({
      host: '127.0.0.1', port: PORT, path: pathname, method,
      ca: certPem, rejectUnauthorized: true,
      // agent:false —— 不复用连接池。否则同一端口上换了服务端实例时，
      // 客户端会拿池里那个已经死掉的 socket 去发请求，得到 ECONNRESET。
      agent: false,
      // 故意伪造 Host 的用例：TLS 客户端默认会拿 Host 去比对证书 SAN，
      // 那会把请求提前打死在客户端。此时只跳过名称比对，证书链仍然验证。
      ...(skipNameCheck ? { checkServerIdentity: () => undefined } : {}),
      headers: {
        Host: `127.0.0.1:${PORT}`,
        ...(payload !== null && type ? { 'Content-Type': type, 'Content-Length': Buffer.byteLength(payload) } : {}),
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

/**
 * 取原始字节。字体是二进制，req() 会把它按 utf8 转成字符串 ——
 * 那样即使服务端读坏了文件，测试也看不出来（乱码在两边都乱），
 * 所以必须拿到 Buffer 才能验"字节没被改过"。
 */
function reqRaw(pathname, { headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const r = https.request({
      host: '127.0.0.1', port: PORT, path: pathname, method: 'GET',
      ca: certPem, rejectUnauthorized: true, agent: false,
      headers: { Host: `127.0.0.1:${PORT}`, ...headers },
    }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, buf: Buffer.concat(chunks) }))
    })
    r.on('error', reject)
    r.end()
  })
}

/**
 * 打开一条 SSE，收到 frames 条 data 帧（或超时）后主动断开。
 * req() 会一直读到 end，而 SSE 是长连接，所以必须单独写一个。
 */
function sseCollect(pathname, { headers = {}, frames = 1, timeoutMs = 4000 } = {}) {
  return new Promise((resolve, reject) => {
    const got = []
    let settled = false
    const r = https.request({
      host: '127.0.0.1', port: PORT, path: pathname, method: 'GET',
      ca: certPem, rejectUnauthorized: true, agent: false,
      headers: { Host: `127.0.0.1:${PORT}`, Accept: 'text/event-stream', ...headers },
    }, (res) => {
      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        try { r.destroy() } catch { /* 忽略 */ }
        resolve({ status: res.statusCode, headers: res.headers, frames: got })
      }
      let buf = ''
      res.on('data', (chunk) => {
        buf += chunk.toString('utf8')
        let at
        while ((at = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, at)
          buf = buf.slice(at + 2)
          const line = block.split('\n').find((l) => l.startsWith('data: '))
          if (!line) continue
          try { got.push(JSON.parse(line.slice(6))) } catch { /* 忽略心跳 */ }
          if (got.length >= frames) { finish(); return }
        }
      })
      res.on('end', finish)
      const timer = setTimeout(finish, timeoutMs)
    })
    r.on('error', (err) => { if (!settled) { settled = true; reject(err) } })
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
eq('snapshot 只投影了前 4 条里的 3 条（system/message 被整条丢掉）', frames[0].d.records.length, 3)
check('snapshot 里没有任何 system/message / developer/message',
  frames[0].d.records.every((r) => r.type !== 'system/message' && r.type !== 'developer/message'))
check('snapshot 里的 assistant/message 丢掉了冗余 stream', frames[0].d.records[2].data.stream === undefined)

const eventFrames = frames.filter((frame) => frame.e === 'event')
eq('SSE 下发事件帧', eventFrames.length, 2)
// 长连接上真跑一遍注入消息：它在服务端就被丢掉，手机一个字节都收不到
check('注入的 user/message 一帧都没下发（事件帧仍是 2）', !follow.text.includes('system-reminder'))
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

// ==================== 三·五、P2 写操作 ====================
console.log('\n———— 写操作 ————')

const anonPrompt = await req('/api/prompt', { method: 'POST', json: { sessionId: SESSION_ID, requestId: 'anon-1', text: 'x' } })
eq('未登录发消息 → 401', anonPrompt.status, 401)
const anonCancel = await req('/api/cancel', { method: 'POST', json: { sessionId: SESSION_ID } })
eq('未登录停止 → 401', anonCancel.status, 401)

// CSRF：写操作强制 JSON，表单类简单请求打不进来
const wrongType = await req('/api/prompt', {
  method: 'POST', headers: { Cookie: cookie }, body: { sessionId: SESSION_ID },
  contentType: 'application/x-www-form-urlencoded',
})
eq('表单内容类型 → 415', wrongType.status, 415)
eq('415 说明原因', wrongType.body.error, 'unsupported-media-type')

const badJson = await req('/api/prompt', {
  method: 'POST', headers: { Cookie: cookie }, rawText: '{ 这不是 json', contentType: 'application/json',
})
eq('非法 JSON → 400', badJson.status, 400)
eq('非法 JSON 错误码', badJson.body.error, 'bad-body')

// 参数校验：各用独立 sessionId，避免互相触发节流
const empty = await req('/api/prompt', { method: 'POST', headers: { Cookie: cookie }, json: { sessionId: 'v1', requestId: 'v1', text: '   ' } })
eq('空消息 → 400', empty.status, 400)
eq('空消息错误码', empty.body.error, 'empty-text')
const tooLong = await req('/api/prompt', { method: 'POST', headers: { Cookie: cookie }, json: { sessionId: 'v2', requestId: 'v2', text: 'x'.repeat(MAX_PROMPT_CHARS + 1) } })
eq('超长消息 → 400', tooLong.status, 400)
eq('超长错误码', tooLong.body.error, 'text-too-long')
const badId = await req('/api/prompt', { method: 'POST', headers: { Cookie: cookie }, json: { sessionId: 'v3', requestId: 'a b', text: 'x' } })
eq('非法 requestId → 400', badId.status, 400)
eq('非法 requestId 错误码', badId.body.error, 'bad-request-id')
const noSession = await req('/api/prompt', { method: 'POST', headers: { Cookie: cookie }, json: { requestId: 'v4', text: 'x' } })
eq('缺 sessionId → 400', noSession.status, 400)
eq('缺 sessionId 错误码', noSession.body.error, 'missing-session-id')

// 正常发送
const sent = await req('/api/prompt', {
  method: 'POST', headers: { Cookie: cookie },
  json: { sessionId: SESSION_ID, requestId: 'req-1', text: '  你好 DSH  ', timeZone: 'Asia/Shanghai' },
})
eq('发送成功 → 200', sent.status, 200)
eq('返回 accepted', sent.body.accepted, true)
eq('首次不是 duplicate', sent.body.duplicate, false)
eq('controller.prompt 被调用一次', promptCalls.length, 1)
eq('请求体：mode 固定 queue', promptCalls[0].mode, 'queue')
eq('请求体：sessionId', promptCalls[0].sessionId, SESSION_ID)
eq('请求体：requestId 透传', promptCalls[0].requestId, 'req-1')
eq('请求体：content 形状', JSON.stringify(promptCalls[0].content), JSON.stringify([{ type: 'text', text: '你好 DSH' }]))
eq('请求体：时区透传', promptCalls[0].clientTimeZone, 'Asia/Shanghai')
check('路由：传给 controller.prompt 的是真实 AbortSignal',
  !!promptSignals[0] &&
  typeof promptSignals[0].throwIfAborted === 'function' &&
  promptSignals[0].aborted === false,
  promptSignals[0] ? `aborted=${promptSignals[0].aborted}` : 'signal 为空')

// 幂等：同一 requestId 立刻重发。此刻仍在 300ms 节流窗口内，
// 必须走幂等返回 200，而不是被节流成 429 —— 否则弱网重试会看到"发送太快了"。
const again = await req('/api/prompt', { method: 'POST', headers: { Cookie: cookie }, json: { sessionId: SESSION_ID, requestId: 'req-1', text: '你好 DSH' } })
eq('重复 requestId → 200（而不是 429）', again.status, 200)
eq('重复 requestId 标记 duplicate', again.body.duplicate, true)
eq('重复 requestId 没有再次调用 controller', promptCalls.length, 1)

// 节流：换个新 requestId 立刻再发
const tooFast = await req('/api/prompt', { method: 'POST', headers: { Cookie: cookie }, json: { sessionId: SESSION_ID, requestId: 'req-2', text: '再来一条' } })
eq('300ms 内换新 id → 429', tooFast.status, 429)
eq('429 错误码', tooFast.body.error, 'too-fast')

await new Promise((resolve) => setTimeout(resolve, 320))
const sent2 = await req('/api/prompt', { method: 'POST', headers: { Cookie: cookie }, json: { sessionId: SESSION_ID, requestId: 'req-3', text: '第二条' } })
eq('等过窗口后可再发 → 200', sent2.status, 200)
eq('第二次确实调用了 controller', promptCalls.length, 2)

// 停止当前轮
const cancelled = await req('/api/cancel', { method: 'POST', headers: { Cookie: cookie }, json: { sessionId: SESSION_ID } })
eq('停止 → 200', cancelled.status, 200)
eq('停止返回 accepted', cancelled.body.accepted, true)
eq('controller.cancel 收到 sessionId', cancelCalls[0].sessionId, SESSION_ID)
const cancelNoId = await req('/api/cancel', { method: 'POST', headers: { Cookie: cookie }, json: {} })
eq('停止缺 sessionId → 400', cancelNoId.status, 400)
eq('停止缺参错误码', cancelNoId.body.error, 'missing-session-id')

// 写操作的 Host 闸门同样生效
const badHostPrompt = await req('/api/prompt', {
  method: 'POST', headers: { Cookie: cookie, Host: 'evil.example.com' },
  json: { sessionId: SESSION_ID, requestId: 'req-9', text: 'x' }, skipNameCheck: true,
})
check('伪造 Host 发消息被挡', badHostPrompt.status === 403, String(badHostPrompt.status))

// Bug1 回归：长内容必须真的发得出去。
// 上限是 4000 的时候，正常的长回答在手机上被截断；上限提到 100000 后，
// 请求体闸门（MAX_JSON_BYTES）也必须跟着放宽，否则会退化成一句 socket hang up。
const longPrompt = await req('/api/prompt', {
  method: 'POST', headers: { Cookie: cookie },
  json: { sessionId: 'v5', requestId: 'v5', text: 'x'.repeat(50000) },
})
eq('五万字符消息 → 200（长内容发得出去）', longPrompt.status, 200)
// 上限按 UTF-16 字符数算，请求体按 UTF-8 字节算：中文一字 3 字节，
// 所以"字符数没超"不等于"字节数没超"。这条专门钉住这个换算。
const chinesePrompt = await req('/api/prompt', {
  method: 'POST', headers: { Cookie: cookie },
  json: { sessionId: 'v6', requestId: 'v6', text: '好'.repeat(50000) },
})
eq('五万汉字消息 → 200（字节数被正确考虑）', chinesePrompt.status, 200)
// 真·超限：回一个干净的 413，而不是把连接掐掉
const oversized = await req('/api/prompt', {
  method: 'POST', headers: { Cookie: cookie },
  json: { sessionId: 'v7', requestId: 'v7', text: 'x'.repeat(2 * 1024 * 1024) },
})
eq('超大请求体 → 413（不是断链）', oversized.status, 413)
eq('超大请求体错误码', oversized.body.error, 'body-too-large')
check('超大请求体给出可读提示', /KB/.test(String(oversized.body.message)), String(oversized.body.message))

// ==================== 三·五·五、P3：分组 / 模型 / 模式 / 提问 ====================
console.log('\n———— P3 纯函数：工作区分组 ————')

eq('工作区：取末段做名字', workspaceOf('D:\\VibeCoding\\Plugin\\dsh-mobile-mirror').name, 'dsh-mobile-mirror')
eq('工作区：key 归一化为小写', workspaceOf('D:\\VibeCoding\\Plugin').key, 'd:\\vibecoding\\plugin')
eq('工作区：去掉尾部斜杠', workspaceOf('D:\\a\\b\\').key, 'd:\\a\\b')
eq('工作区：空 cwd 归到"无工作区"', workspaceOf('').name, '无工作区')
eq('工作区：空 cwd 的 key 是空串', workspaceOf(null).key, '')
eq('工作区：空 cwd 没有 path', workspaceOf(undefined).path, null)

const groupedItems = [
  { id: 'g1', cwd: 'D:\\proj\\alpha', updatedAt: 10 },
  { id: 'g2', cwd: 'D:\\proj\\beta', updatedAt: 30 },
  { id: 'g3', cwd: 'D:\\proj\\alpha', updatedAt: 40 },
  { id: 'g4', cwd: '', updatedAt: 999 },
  { id: 'g5', cwd: 'd:\\PROJ\\ALPHA', updatedAt: 5 },
]
const gs = groupSessions(groupedItems)
eq('分组数量（大小写不敏感，5 条并成 3 组）', gs.length, 3)
eq('组按最近更新时间降序', gs.map((g) => g.name).join(','), 'alpha,beta,无工作区')
eq('"无工作区"排最后（哪怕它最新）', gs[2].key, '')
eq('组内按时间降序', gs[0].items.map((i) => i.id).join(','), 'g3,g1,g5')
eq('组头 updatedAt 取组内最大', gs[0].updatedAt, 40)
eq('组头带完整路径', gs[0].path, 'D:\\proj\\alpha')
eq('没有 running 时不置位', gs[0].running, false)
eq('组内有 running 时组头置位', groupSessions([{ id: 'x', cwd: 'D:\\p', running: true }])[0].running, true)
eq('空列表返回空数组', groupSessions([]).length, 0)
eq('非数组也不炸', groupSessions(null).length, 0)

console.log('\n———— P3 纯函数：模式显示（投影优先于 header） ————')

// 这是本次修掉的那个显示 bug 的回归护栏：
// header.agentPreset 是**创建时**的模式且被深冻结，会话在空白期换模式只落在投影里。
// DSH 源码注释原文："Reconstruction reads the `agentPreset` Session projection,
// never the header alone."
eq('模式：读投影而不是 header', presetOf({
  projections: { values: { agentPreset: 'cordis' } },
  agentPreset: 'standard',
}), 'cordis')
// 投影缺失时**故意**不回退到 header：header 是创建事实，会话在空白期换过模式的话
// 它就是过期的。宁可什么都不显示，也不能显示错的（那正是本次修掉的 bug）。
eq('模式：投影缺失时不回退到 header（header 可能是过期值）', presetOf({ projections: { values: {} }, agentPreset: 'ptc' }), null)
eq('模式：都没有就是 null', presetOf({}), null)
eq('模式：非字符串当没有', presetOf({ projections: { values: { agentPreset: 42 } } }), null)
eq('模式：归一化摘要带上投影里的模式', normalizeSummary({
  sessionId: 's', projections: { values: { agentPreset: 'cordis' } }, agentPreset: 'standard',
}).preset, 'cordis')
eq('模式中文名：standard', presetLabel('standard'), '标准模式')
eq('模式中文名：ptc', presetLabel('ptc'), 'PTC 模式')
eq('模式中文名：minimal', presetLabel('minimal'), '极简模式')
eq('模式中文名：cordis', presetLabel('cordis'), '创造模式')
eq('模式中文名：roster 自带的优先', presetLabel('cordis', [{ id: 'cordis', name: '我的创造' }]), '我的创造')
eq('模式中文名：未知 id 原样返回', presetLabel('weird'), 'weird')
eq('模式中文名：空 id 返回 null', presetLabel(''), null)
eq('内置模式表就 4 个', Object.keys(PRESET_NAMES).length, 4)

// 事件投影：换模式 / 换模型必须下发，否则手机在长连接期间跟不上变化
eq('事件投影：agent-preset/selected',
  JSON.stringify(projectEvent({ type: 'agent-preset/selected', seq: 9, time: 1, data: { agentPreset: 'cordis' } }).data),
  JSON.stringify({ agentPreset: 'cordis' }))
eq('事件投影：model/selection',
  JSON.stringify(projectEvent({ type: 'model/selection', seq: 9, time: 1, data: { provider: 'doulor', model: 'wb-ds41f', reasoningEffort: 'low' } }).data),
  JSON.stringify({ provider: 'doulor', model: 'wb-ds41f', reasoningEffort: 'low' }))
eq('事件投影：model/selection 缺档位时为 null',
  projectEvent({ type: 'model/selection', seq: 9, time: 1, data: { provider: 'p', model: 'm' } }).data.reasoningEffort, null)

// 快照也必须以投影为准
const snapProj = projectSnapshot({
  type: 'snapshot',
  header: { id: 's', cwd: 'D:\\a', agentPreset: 'standard' },
  projections: { values: { agentPreset: 'cordis', title: 'T' } },
  records: [],
})
eq('快照：模式以投影为准', snapProj.header.agentPreset, 'cordis')
eq('快照：projections 原样带出', snapProj.projections.agentPreset, 'cordis')

console.log('\n———— P3 纯函数：模型目录 ————')

const rawCatalog = {
  default: { provider: 'doulor', model: 'wb-ds41f', reasoningEffort: 'medium' },
  routableProviders: ['doulor', 'olomc'],
  groups: [
    { id: 'doulor', name: 'Doulor', models: [{ id: 'wb-ds41f', name: 'WB-DS41F', reasoning: { efforts: [{ id: 'low' }, { id: 'medium', name: '中' }], defaultEffort: 'medium' } }] },
    { id: 'empty', name: '空组', models: [] },
    { id: 'broken', models: [{ id: 'x' }] },
  ],
  failures: [{ id: 'bad', name: '坏', message: '超时' }],
}
const norm = normalizeModelCatalog(rawCatalog)
eq('目录：空组被过滤', norm.groups.length, 2)
eq('目录：没有 name 的组用 id 当名字', norm.groups[1].name, 'broken')
eq('目录：没有 name 的模型用 id 当名字', norm.groups[1].models[0].name, 'x')
eq('目录：档位被保留', norm.groups[0].models[0].efforts.length, 2)
eq('目录：档位没有 name 时用 id', norm.groups[0].models[0].efforts[0].name, 'low')
eq('目录：defaultEffort 保留', norm.groups[0].models[0].defaultEffort, 'medium')
eq('目录：失败提供方保留', norm.failures[0].message, '超时')
eq('目录：默认选择保留', norm.default.model, 'wb-ds41f')
eq('目录：垃圾输入不炸', normalizeModelCatalog(null).groups.length, 0)
eq('目录：groups 不是数组也不炸', normalizeModelCatalog({ groups: 'x' }).groups.length, 0)

const cache = createCatalogCache({ ttlMs: 1000 })
let cacheLoads = 0
const loader = async () => { cacheLoads += 1; return { v: cacheLoads } }
const c1 = await cache.get(loader)
const c2 = await cache.get(loader)
eq('缓存：第二次命中缓存', cacheLoads, 1)
eq('缓存：两次拿到同一个值', c1.v === c2.v, true)
const parallel = await Promise.all([cache.get(loader), cache.get(loader), cache.get(loader)])
eq('缓存：并发只打一次上游', cacheLoads, 1)
eq('缓存：并发结果一致', parallel.every((x) => x.v === 1), true)
cache.invalidate()
await cache.get(loader)
eq('缓存：失效后重新拉', cacheLoads, 2)
eq('缓存：cached 暴露当前值', cache.cached.v, 2)

const badSwitch = validateModelSwitch({})
eq('切模型校验：缺 sessionId', badSwitch.error, 'missing-session-id')
eq('切模型校验：缺 provider', validateModelSwitch({ sessionId: 's' }).error, 'missing-provider')
eq('切模型校验：缺 model', validateModelSwitch({ sessionId: 's', provider: 'p' }).error, 'missing-model')
eq('切模型校验：合法输入归一化',
  JSON.stringify(validateModelSwitch({ sessionId: ' s ', provider: ' p ', model: ' m ', reasoningEffort: ' low ' }).value),
  JSON.stringify({ sessionId: 's', provider: 'p', model: 'm', reasoningEffort: 'low' }))
eq('切模型校验：空档位等于没给',
  validateModelSwitch({ sessionId: 's', provider: 'p', model: 'm', reasoningEffort: '  ' }).value.reasoningEffort, undefined)

const switchedPure = await switchModel({
  async selectModel(request) { return { selected: { provider: request.provider, model: request.model } } },
}, { sessionId: 's', provider: 'p', model: 'm' })
eq('切模型：成功', switchedPure.ok, true)
eq('切模型：返回选中项', switchedPure.selected.model, 'm')
eq('切模型：没给档位时不硬塞', switchedPure.selected.reasoningEffort, null)

const presetsPure = await loadPresetRoster(fakePresets)
eq('模式清单：条数', presetsPure.length, 5)
eq('模式清单：内置模式补上中文名', presetsPure.find((p) => p.id === 'cordis').label, '创造模式')
eq('模式清单：自建模式用自己的名字', presetsPure.find((p) => p.id === 'custom-one').label, '我的模式')
eq('模式清单：服务缺失时返回空数组', (await loadPresetRoster(null)).length, 0)

const presetAgent = { id: 'sess-1', ctx: {}, session: {} }
const presetPure = await switchPreset(fakePresets, { get: () => presetAgent }, { sessionId: 'sess-1', preset: 'ptc' })
eq('切模式：成功', presetPure.ok, true)
eq('切模式：返回模式 id', presetPure.selected, 'ptc')
eq('切模式：把 Agent 对象交给了上游', presetSelectCalls[presetSelectCalls.length - 1].agentId, 'sess-1')
eq('切模式：缺 preset → 400', (await switchPreset(fakePresets, { get: () => presetAgent }, { sessionId: 's' })).status, 400)
eq('切模式：没有活体 agent → 409', (await switchPreset(fakePresets, { get: () => null }, { sessionId: 's', preset: 'ptc' })).status, 409)
eq('切模式：模式服务缺失 → 503', (await switchPreset(null, { get: () => presetAgent }, { sessionId: 's', preset: 'ptc' })).status, 503)
eq('切模式：agents 服务缺失 → 503', (await switchPreset(fakePresets, null, { sessionId: 's', preset: 'ptc' })).status, 503)

console.log('\n———— P3 纯函数：答案校验与提问中心 ————')

const questions = [
  { id: 'q1', question: '选一个', options: [{ label: 'A' }, { label: 'B' }] },
  { id: 'q2', question: '多说点', multiSelect: true, options: [{ label: 'X' }] },
]
eq('答案校验：不是数组', validateAnswers({ answers: 'x' }, questions).error, 'bad-answers')
eq('答案校验：没有题目', validateAnswers({ answers: [] }, []).error, 'no-questions')
eq('答案校验：少答一题', validateAnswers({ answers: [{ id: 'q1', selected: ['A'] }] }, questions).error, 'bad-answers')
eq('答案校验：id 不匹配', validateAnswers({ answers: [{ id: 'zz', selected: ['A'] }, { id: 'q2', selected: ['X'] }] }, questions).error, 'bad-answers')
eq('答案校验：同一题给两次', validateAnswers({ answers: [{ id: 'q1', selected: ['A'] }, { id: 'q1', selected: ['B'] }] }, questions).error, 'bad-answers')
eq('答案校验：既没选也没写', validateAnswers({ answers: [{ id: 'q1', selected: [] }, { id: 'q2', selected: ['X'] }] }, questions).error, 'empty-answer')
eq('答案校验：自定义答案太长',
  validateAnswers({ answers: [{ id: 'q1', selected: [], custom: 'x'.repeat(MAX_ANSWER_CHARS + 1) }, { id: 'q2', selected: ['X'] }] }, questions).error,
  'answer-too-long')
eq('答案校验：全空选项 + 自定义 = 合法（桌面端也有这种答案）',
  JSON.stringify(validateAnswers({ answers: [{ id: 'q1', selected: [], custom: '我自己写的' }, { id: 'q2', selected: ['X'] }] }, questions).value),
  JSON.stringify({ answers: [{ id: 'q1', selected: [], custom: '我自己写的' }, { id: 'q2', selected: ['X'] }] }))
eq('答案校验：多选可以多值',
  validateAnswers({ answers: [{ id: 'q1', selected: ['A'] }, { id: 'q2', selected: ['X', 'Y'] }] }, questions).value.answers[1].selected.length, 2)

const hub = createQuestionHub({ maxPending: 3 })
const hubFrames = []
const unsub = hub.subscribe((f) => hubFrames.push(f))
const entryA = hub.register('sess-1', questions, null, 'call-A')
eq('提问中心：登记后有 1 条待答', hub.size, 1)
eq('提问中心：登记会通知订阅者', hubFrames[0].e, 'question')
eq('提问中心：帧里带会话 id', hubFrames[0].d.sessionId, 'sess-1')
eq('提问中心：帧里带 callId', hubFrames[0].d.callId, 'call-A')
eq('提问中心：按会话过滤', hub.list('sess-2').length, 0)
eq('提问中心：不过滤时能拿到', hub.list().length, 1)

const answeredA = hub.answer({ questionId: entryA.id, answers: [{ id: 'q1', selected: ['A'] }, { id: 'q2', selected: ['X'] }] })
eq('提问中心：作答成功', answeredA.ok, true)
eq('提问中心：作答后待答清空', hub.size, 0)
eq('提问中心：宿主拿到答案', (await entryA.promise).answers.length, 2)
eq('提问中心：作答会通知订阅者', hubFrames[hubFrames.length - 1].e, 'question-settled')
eq('提问中心：重复作答 → 404', hub.answer({ questionId: entryA.id, answers: [] }).status, 404)
eq('提问中心：不存在的 id → 404', hub.answer({ questionId: 'zzz', answers: [] }).status, 404)
eq('提问中心：缺 questionId → 400', hub.answer({}).status, 400)

const entryB = hub.register('sess-1', questions, null, null)
eq('提问中心：答案不合法 → 400', hub.answer({ questionId: entryB.id, answers: [{ id: 'q1', selected: ['A'] }] }).status, 400)
eq('提问中心：校验失败后仍然待答', hub.size, 1)
eq('提问中心：别处结算 → resolve 成 null', hub.settle(entryB.id), true)
eq('提问中心：结算后 promise 得到 null', await entryB.promise, null)
eq('提问中心：结算后不再待答', hub.size, 0)

// 超额淘汰最老的；被淘汰的那条要干净退场（resolve null），不能变成未处理拒绝
const entryC = hub.register('s', questions, null, null)
const entryD = hub.register('s', questions, null, null)
const entryE = hub.register('s', questions, null, null)
const entryF = hub.register('s', questions, null, null)
eq('提问中心：超过上限后只留 maxPending 条', hub.size, 3)
eq('提问中心：最老的那条被淘汰成 null', await entryC.promise, null)
eq('提问中心：较新的还在', hub.list().length, 3)
hub.settle(entryD.id); hub.settle(entryE.id); hub.settle(entryF.id)
const framesBeforeUnsub = hubFrames.length
unsub()
const entryH = hub.register('s', questions, null, null)
eq('提问中心：退订后不再收到帧', hubFrames.length, framesBeforeUnsub)
hub.settle(entryH.id)
eq('提问中心：退订后结算也不再收到帧', hubFrames.length, framesBeforeUnsub)

// 中止信号：应该让这条路径 reject（整条 waterfall 随之失败）
const abortCtrl = new AbortController()
const hubAbort = createQuestionHub({})
const entryG = hubAbort.register('s', questions, abortCtrl.signal, null)
let abortErr = null
entryG.promise.catch((err) => { abortErr = err })
abortCtrl.abort()
await new Promise((r) => setTimeout(r, 10))
check('提问中心：中止会拒绝这条路径', abortErr !== null && abortErr.name === 'AbortError', String(abortErr && abortErr.name))
eq('提问中心：中止后不再待答', hubAbort.size, 0)

console.log('\n———— P3 纯函数：answerer 竞速 ————')

// 手机先答
const hub1 = createQuestionHub({})
const answerer1 = createQuestionAnswerer(hub1, { log: () => {} })
let desktopCalled = 0
const desktopAnswer = { answers: [{ id: 'q1', selected: ['B'] }, { id: 'q2', selected: ['X'] }] }
const pending1 = answerer1({ agent: { id: 'sess-1' }, questions }, () => { desktopCalled += 1; return new Promise(() => {}) })
await new Promise((r) => setTimeout(r, 5))
eq('answerer：先同步调用了 next()（桌面卡片要立刻出现）', desktopCalled, 1)
const live1 = hub1.list('sess-1')[0]
hub1.answer({ questionId: live1.id, answers: [{ id: 'q1', selected: ['A'] }, { id: 'q2', selected: ['X'] }] })
eq('answerer：手机先答就用手机的答案', JSON.stringify((await pending1).answers[0]), JSON.stringify({ id: 'q1', selected: ['A'] }))

// 桌面先答 → 手机侧要被告知收起卡片，并沿用桌面的答案
const hub2 = createQuestionHub({})
const answerer2 = createQuestionAnswerer(hub2, { log: () => {} })
const settledFrames = []
hub2.subscribe((f) => settledFrames.push(f))
const pending2 = answerer2({ agent: { id: 'sess-1' }, questions }, () => Promise.resolve(desktopAnswer))
eq('answerer：桌面先答就用桌面的答案', await pending2, desktopAnswer)
eq('answerer：桌面先答后手机侧收到 question-settled',
  settledFrames.some((f) => f.e === 'question-settled' && f.d.outcome === 'elsewhere'), true)
eq('answerer：桌面先答后不再待答', hub2.size, 0)

// 桌面这条路炸了（GUI 没开），只要手机还挂着就继续等手机
const hub3 = createQuestionHub({})
const answerer3 = createQuestionAnswerer(hub3, { log: () => {} })
const pending3 = answerer3({ agent: { id: 'sess-1' }, questions }, () => Promise.reject(new Error('no answerer')))
await new Promise((r) => setTimeout(r, 5))
const live3 = hub3.list('sess-1')[0]
hub3.answer({ questionId: live3.id, answers: [{ id: 'q1', selected: ['A'] }, { id: 'q2', selected: ['X'] }] })
eq('answerer：桌面报错但手机还能答', (await pending3).answers.length, 2)

// 桌面这条路炸了、手机也不答 → 把桌面的错误原样抛出（保持原有语义）
const hub4 = createQuestionHub({})
const answerer4 = createQuestionAnswerer(hub4, { log: () => {} })
const pending4 = answerer4({ agent: { id: 'sess-1' }, questions }, () => Promise.reject(new Error('no answerer')))
await new Promise((r) => setTimeout(r, 5))
hub4.settle(hub4.list('sess-1')[0].id)
let err4 = null
try { await pending4 } catch (err) { err4 = err }
check('answerer：桌面报错且手机不答 → 抛桌面的错误', err4 !== null && /no answerer/.test(err4.message), String(err4 && err4.message))

// 没有 agent 的请求不归这里管
const hub5 = createQuestionHub({})
const answerer5 = createQuestionAnswerer(hub5, { log: () => {} })
let passedThrough = 0
await answerer5({ questions }, () => { passedThrough += 1; return Promise.resolve(desktopAnswer) })
eq('answerer：没有 agent 的请求直接放行', passedThrough, 1)
eq('answerer：放行的请求不进待答表', hub5.size, 0)

// next() 同步抛（Remote 转发器在作用域不匹配时会 throw）也不能带崩
const hub6 = createQuestionHub({})
const answerer6 = createQuestionAnswerer(hub6, { log: () => {} })
const pending6 = answerer6({ agent: { id: 'sess-1' }, questions }, () => { throw new TypeError('forwarded scoped event must carry its Agent directly') })
await new Promise((r) => setTimeout(r, 5))
eq('answerer：next() 同步抛时手机这条路仍然可用', hub6.list('sess-1').length, 1)
hub6.answer({ questionId: hub6.list('sess-1')[0].id, answers: [{ id: 'q1', selected: ['A'] }, { id: 'q2', selected: ['X'] }] })
eq('answerer：同步抛之后仍能拿到手机答案', (await pending6).answers.length, 2)

/* ==================================================================
 * 认领等待（Bug2：手机上答完不该变成"答案被暂存 + agent 又跑一轮"）
 *
 * 背景：`ask_user_question` 是限时提问（默认 120 秒）。没有任何回答界面认领时，
 * 到点宿主直接放行模型 → 工具返回 pending → 问题进入 continued；此后作答会走
 * "迟到回复"那条路（steer 一条用户消息），于是答案被暂存、agent 又跑一轮。
 * 手机认领之后钟归手机管，作答永远是"时答"。
 *
 * 这里用假的 attachWait 验证认领/释放的时机，不需要真宿主。
 * ================================================================== */
console.log('\n———— 认领等待 ————')

/** 假 attachWait：记录调用参数，被释放时记一笔。 */
function fakeWaitAttach(options = {}) {
  const calls = []
  const ended = []
  const fn = (agent, callId, signal) => {
    calls.push({ agent, callId, signal })
    if (options.throws) throw new Error('assertLiveRoot failed')
    return (async function* () {
      try {
        if (signal.aborted) return
        yield { remainingMs: options.remainingMs === undefined ? 118000 : options.remainingMs }
        if (options.endAfterFirstFrame) return
        await new Promise((resolve) => {
          if (signal.aborted) return resolve()
          signal.addEventListener('abort', resolve, { once: true })
        })
      } finally {
        ended.push(callId)
      }
    })()
  }
  return { fn, calls, ended }
}

/** 造一个"限时提问"的 answerer 调用。 */
function timedRequest(agent) {
  return { agent, questions, signal: null, wait: { callId: 'call-1', timed: true } }
}

// ① 没注入认领实现（拿不到 ctx.userQuestions）→ 不认领，行为同改造前
const hubHold0 = createQuestionHub({})
const ansHold0 = createQuestionAnswerer(hubHold0, { log: () => {} })
const pendHold0 = ansHold0(timedRequest({ id: 'sess-1' }), () => new Promise(() => {}))
await new Promise((r) => setTimeout(r, 5))
const q0 = hubHold0.list('sess-1')[0]
eq('没有认领实现时 hold 仍然返回 ok', hubHold0.hold(q0.id, true).ok, true)
eq('没有认领实现时 claimed=false（如实说没接管）', hubHold0.hold(q0.id, true).claimed, false)
hubHold0.answer({ questionId: q0.id, answers: [{ id: 'q1', selected: ['A'] }, { id: 'q2', selected: ['X'] }] })
eq('不认领也不影响作答', (await pendHold0).answers.length, 2)

// ② 认领：attachWait 被调用，参数正确，并把剩余时长推给手机
const att1 = fakeWaitAttach({})
const hubHold1 = createQuestionHub({})
const ansHold1 = createQuestionAnswerer(hubHold1, { log: () => {}, attachWait: att1.fn })
const frames1 = []
hubHold1.subscribe((f) => frames1.push(f))
const pendHold1 = ansHold1(timedRequest({ id: 'sess-1' }), () => new Promise(() => {}))
await new Promise((r) => setTimeout(r, 5))
const q1h = hubHold1.list('sess-1')[0]
const hold1 = hubHold1.hold(q1h.id, true)
eq('认领成功', hold1.claimed, true)
await new Promise((r) => setTimeout(r, 5))
eq('attachWait 被调用一次', att1.calls.length, 1)
eq('attachWait 收到 callId', att1.calls[0].callId, 'call-1')
eq('attachWait 收到 agent 本体（认领要按 agent 校验存活）', att1.calls[0].agent.id, 'sess-1')
eq('认领后把剩余时长推给手机',
  JSON.stringify(frames1.filter((f) => f.e === 'question-hold').map((f) => [f.d.held, f.d.remainingMs])),
  JSON.stringify([[true, 118000]]))

// ③ 手机作答 → 自动释放认领（宿主随即按自己的规则收尾）
hubHold1.answer({ questionId: q1h.id, answers: [{ id: 'q1', selected: ['A'] }, { id: 'q2', selected: ['X'] }] })
eq('作答后手机拿到答案', (await pendHold1).answers.length, 2)
await new Promise((r) => setTimeout(r, 5))
eq('作答后释放了认领', att1.ended.length, 1)
eq('释放的正是那一次认领', att1.ended[0], 'call-1')
eq('作答后不再待答', hubHold1.size, 0)

// ④ 手机说"不看了" → 立刻释放
const att2 = fakeWaitAttach({})
const hubHold2 = createQuestionHub({})
const ansHold2 = createQuestionAnswerer(hubHold2, { log: () => {}, attachWait: att2.fn })
const pendHold2 = ansHold2(timedRequest({ id: 'sess-1' }), () => new Promise(() => {}))
await new Promise((r) => setTimeout(r, 5))
const q2h = hubHold2.list('sess-1')[0]
hubHold2.hold(q2h.id, true)
await new Promise((r) => setTimeout(r, 5))
hubHold2.hold(q2h.id, false)
await new Promise((r) => setTimeout(r, 5))
eq('说"不看了"就释放认领', att2.ended.length, 1)
hubHold2.answer({ questionId: q2h.id, answers: [{ id: 'q1', selected: ['A'] }, { id: 'q2', selected: ['X'] }] })
await pendHold2

// ⑤ 最后一个订阅者断开 → 宽限期后释放；宽限期内又连上就不释放
const att3 = fakeWaitAttach({})
const hubHold3 = createQuestionHub({ holdGraceMs: 0 })
const ansHold3 = createQuestionAnswerer(hubHold3, { log: () => {}, attachWait: att3.fn })
const unsub3 = hubHold3.subscribe(() => {})
const pendHold3 = ansHold3(timedRequest({ id: 'sess-1' }), () => new Promise(() => {}))
await new Promise((r) => setTimeout(r, 5))
const q3h = hubHold3.list('sess-1')[0]
hubHold3.hold(q3h.id, true)
await new Promise((r) => setTimeout(r, 5))
eq('手机连着时认领有效', att3.ended.length, 0)
unsub3()
await new Promise((r) => setTimeout(r, 5))
eq('手机全断了立刻释放（holdGraceMs=0）', att3.ended.length, 1)

const att4 = fakeWaitAttach({})
const hubHold4 = createQuestionHub({ holdGraceMs: 30 })
const ansHold4 = createQuestionAnswerer(hubHold4, { log: () => {}, attachWait: att4.fn })
const unsub4 = hubHold4.subscribe(() => {})
const pendHold4 = ansHold4(timedRequest({ id: 'sess-1' }), () => new Promise(() => {}))
await new Promise((r) => setTimeout(r, 5))
const q4h = hubHold4.list('sess-1')[0]
hubHold4.hold(q4h.id, true)
await new Promise((r) => setTimeout(r, 5))
unsub4()
hubHold4.subscribe(() => {})   // 宽限期内页面重连（刷新）
await new Promise((r) => setTimeout(r, 60))
eq('宽限期内重连就不释放认领（页面刷新不该丢掉提问）', att4.ended.length, 0)

// ⑥ 非限时提问不认领（legacy 模式下没有 wait 信息）
const att5 = fakeWaitAttach({})
const hubHold5 = createQuestionHub({})
const ansHold5 = createQuestionAnswerer(hubHold5, { log: () => {}, attachWait: att5.fn })
const pendHold5 = ansHold5({ agent: { id: 'sess-1' }, questions, signal: null }, () => new Promise(() => {}))
await new Promise((r) => setTimeout(r, 5))
const q5h = hubHold5.list('sess-1')[0]
eq('非限时提问不认领（没有 wait 信息）', hubHold5.hold(q5h.id, true).claimed, false)
eq('非限时提问不会去调 attachWait', att5.calls.length, 0)
hubHold5.answer({ questionId: q5h.id, answers: [{ id: 'q1', selected: ['A'] }, { id: 'q2', selected: ['X'] }] })
await pendHold5

// ⑦ 认领实现抛错（agent 不是存活根 agent）→ 降级，不炸、不卡
const att6 = fakeWaitAttach({ throws: true })
const hubHold6 = createQuestionHub({})
const ansHold6 = createQuestionAnswerer(hubHold6, { log: () => {}, attachWait: att6.fn })
const pendHold6 = ansHold6(timedRequest({ id: 'sess-1' }), () => new Promise(() => {}))
await new Promise((r) => setTimeout(r, 5))
const q6h = hubHold6.list('sess-1')[0]
hubHold6.hold(q6h.id, true)
await new Promise((r) => setTimeout(r, 10))
hubHold6.answer({ questionId: q6h.id, answers: [{ id: 'q1', selected: ['A'] }, { id: 'q2', selected: ['X'] }] })
eq('认领实现抛错也不影响作答', (await pendHold6).answers.length, 2)

// ⑧ 认领后宿主那条路先答 → 认领同样要释放
const att7 = fakeWaitAttach({})
const hubHold7 = createQuestionHub({})
const ansHold7 = createQuestionAnswerer(hubHold7, { log: () => {}, attachWait: att7.fn })
let resolveDesktop7 = null
const desktopLater7 = new Promise((resolve) => { resolveDesktop7 = resolve })
const pendHold7 = ansHold7(timedRequest({ id: 'sess-1' }), () => desktopLater7)
await new Promise((r) => setTimeout(r, 5))
const q7h = hubHold7.list('sess-1')[0]
hubHold7.hold(q7h.id, true)
await new Promise((r) => setTimeout(r, 5))
eq('桌面还没答时认领生效', att7.ended.length, 0)
resolveDesktop7(desktopAnswer)
eq('桌面先答仍用桌面的答案', await pendHold7, desktopAnswer)
await new Promise((r) => setTimeout(r, 5))
eq('桌面先答后认领被释放（不留悬挂认领）', att7.ended.length, 1)


console.log('\n———— P3 路由：分组 / 模型 / 模式 / 提问 ————')

const groupedRes = await req('/api/sessions', { headers: { Cookie: cookie } })
eq('/api/sessions 仍然返回 items（向后兼容）', groupedRes.body.items.length, 2)
eq('/api/sessions 新增 groups', Array.isArray(groupedRes.body.groups), true)
eq('分组数量', groupedRes.body.groups.length, 2)
// 组按 updatedAt 降序：sess-2（D:\b，updatedAt 200）在 sess-1（D:\a，100）前面
eq('分组名（按组内最近更新时间降序）', groupedRes.body.groups.map((g) => g.name).join(','), 'b,a')
eq('分组带完整路径', groupedRes.body.groups.every((g) => typeof g.path === 'string'), true)
eq('组头带 running 标记', groupedRes.body.groups.some((g) => g.running === true), true)
eq('摘要里带上模式（投影值）', groupedRes.body.items.find((i) => i.id === 'sess-2').preset, 'cordis')

const modelsRes = await req('/api/models', { headers: { Cookie: cookie } })
eq('/api/models → 200', modelsRes.status, 200)
eq('/api/models 过滤空组', modelsRes.body.catalog.groups.length, 2)
eq('/api/models 带默认选择', modelsRes.body.catalog.default.model, 'wb-ds41f')
eq('/api/models 带档位', modelsRes.body.catalog.groups[0].models[0].efforts.length, 2)
eq('/api/models 带失败的提供方', modelsRes.body.catalog.failures[0].message, '连接超时')
await req('/api/models', { headers: { Cookie: cookie } })
eq('/api/models 走了 60 秒缓存（只打一次上游）', catalogCalls, 1)
const anonModels = await req('/api/models')
eq('未登录取模型目录 → 401', anonModels.status, 401)

const switchRes = await req('/api/model', {
  method: 'POST', headers: { Cookie: cookie },
  json: { sessionId: SESSION_ID, provider: 'olomc', model: 'nim/nvidia/glm-5.3', reasoningEffort: 'low' },
})
eq('/api/model → 200', switchRes.status, 200)
eq('/api/model 返回选中项', switchRes.body.selected.model, 'nim/nvidia/glm-5.3')
eq('/api/model 透传档位', switchRes.body.selected.reasoningEffort, 'low')
eq('/api/model 调到了上游', selectModelCalls.length, 1)
eq('/api/model 把 sessionId 传对了', selectModelCalls[0].sessionId, SESSION_ID)

const anonModel = await req('/api/model', { method: 'POST', json: { sessionId: SESSION_ID, provider: 'p', model: 'm' } })
eq('未登录切模型 → 401', anonModel.status, 401)
const formModel = await req('/api/model', {
  method: 'POST', headers: { Cookie: cookie }, body: { sessionId: SESSION_ID },
  contentType: 'application/x-www-form-urlencoded',
})
eq('切模型用表单类型 → 415', formModel.status, 415)
eq('415 错误码', formModel.body.error, 'unsupported-media-type')
const rawModel = await req('/api/model', {
  method: 'POST', headers: { Cookie: cookie }, rawText: '{不是 json', contentType: 'application/json',
})
eq('切模型非法 JSON → 400', rawModel.status, 400)
eq('非法 JSON 错误码', rawModel.body.error, 'bad-body')
const noProvider = await req('/api/model', { method: 'POST', headers: { Cookie: cookie }, json: { sessionId: SESSION_ID } })
eq('缺 provider → 400', noProvider.status, 400)
eq('缺 provider 错误码', noProvider.body.error, 'missing-provider')
const upstreamModel = await req('/api/model', {
  method: 'POST', headers: { Cookie: cookie }, json: { sessionId: SESSION_ID, provider: 'doulor', model: 'nope' },
})
eq('上游拒绝切模型 → 502', upstreamModel.status, 502)
eq('502 透传上游 code', upstreamModel.body.code, 'session/model-unavailable')

const presetsRes = await req('/api/presets', { headers: { Cookie: cookie } })
eq('/api/presets → 200', presetsRes.status, 200)
eq('/api/presets 条数', presetsRes.body.presets.length, 5)
eq('/api/presets 内置模式带中文名', presetsRes.body.presets.find((p) => p.id === 'cordis').label, '创造模式')
eq('/api/presets 自建模式用自己的名字', presetsRes.body.presets.find((p) => p.id === 'custom-one').label, '我的模式')
const anonPresets = await req('/api/presets')
eq('未登录取模式清单 → 401', anonPresets.status, 401)

const presetRes = await req('/api/preset', {
  method: 'POST', headers: { Cookie: cookie }, json: { sessionId: SESSION_ID, preset: 'cordis' },
})
eq('/api/preset → 200', presetRes.status, 200)
eq('/api/preset 返回模式 id', presetRes.body.selected, 'cordis')
eq('/api/preset 返回中文名', presetRes.body.label, '创造模式')
eq('/api/preset 把 Agent 对象交给上游', presetSelectCalls[presetSelectCalls.length - 1].agentId, SESSION_ID)

const presetLocked = await req('/api/preset', {
  method: 'POST', headers: { Cookie: cookie }, json: { sessionId: SESSION_ID, preset: 'started' },
})
eq('已开始的会话切模式 → 409', presetLocked.status, 409)
eq('409 错误码是 preset-locked', presetLocked.body.error, 'preset-locked')
check('409 文案点明这是 DSH 的规则', /DSH/.test(String(presetLocked.body.message)), presetLocked.body.message)
const presetGhost = await req('/api/preset', {
  method: 'POST', headers: { Cookie: cookie }, json: { sessionId: SESSION_ID, preset: 'ghost' },
})
eq('不存在的模式 → 404', presetGhost.status, 404)
eq('404 错误码', presetGhost.body.error, 'preset-not-found')
const presetNoAgent = await req('/api/preset', {
  method: 'POST', headers: { Cookie: cookie }, json: { sessionId: 'no-agent-session', preset: 'ptc' },
})
eq('会话没有活体 agent → 409', presetNoAgent.status, 409)
eq('409 错误码是 agent-not-live', presetNoAgent.body.error, 'agent-not-live')
const presetNoId = await req('/api/preset', { method: 'POST', headers: { Cookie: cookie }, json: { sessionId: SESSION_ID } })
eq('缺 preset → 400', presetNoId.status, 400)
eq('缺 preset 错误码', presetNoId.body.error, 'missing-preset')

// —— 待答问题：列表 / 作答 / SSE ——
const noQuestions = await req('/api/questions', { headers: { Cookie: cookie } })
eq('没有待答问题时返回空数组', noQuestions.body.items.length, 0)

// 先开流，再登记问题，验证"推"这条路
const streamP = sseCollect('/api/questions/stream', { headers: { Cookie: cookie }, frames: 1 })
await new Promise((r) => setTimeout(r, 120))
const liveQuestion = mirror.questionHub.register(SESSION_ID, questions, null, 'call-live')
const streamRes = await streamP
eq('/api/questions/stream → 200', streamRes.status, 200)
check('问题流 Content-Type 是 SSE', String(streamRes.headers['content-type']).startsWith('text/event-stream'), String(streamRes.headers['content-type']))
eq('问题流推来的是 question 帧', streamRes.frames[0].e, 'question')
eq('问题流帧里带会话 id', streamRes.frames[0].d.sessionId, SESSION_ID)
eq('问题流帧里带题目', streamRes.frames[0].d.questions.length, 2)

// 列表页据此打"待回答"角标
const flagged = await req('/api/sessions', { headers: { Cookie: cookie } })
eq('有待答问题的会话被标记', flagged.body.items.find((i) => i.id === SESSION_ID).pendingQuestion, true)
eq('没有待答问题的会话不标记', flagged.body.items.find((i) => i.id === 'sess-2').pendingQuestion, false)

const listedQuestions = await req('/api/questions?id=' + SESSION_ID, { headers: { Cookie: cookie } })
eq('按会话查待答问题', listedQuestions.body.items.length, 1)
eq('查别的会话为空', (await req('/api/questions?id=sess-2', { headers: { Cookie: cookie } })).body.items.length, 0)

// —— 认领等待（写操作）：手机看着卡片时别让宿主超时 ——
const holdOn = await req('/api/questions/hold', {
  method: 'POST', headers: { Cookie: cookie }, json: { questionId: liveQuestion.id, hold: true },
})
eq('认领等待 → 200', holdOn.status, 200)
eq('认领返回 held=true', holdOn.body.held, true)
// 测试里的镜像没注入 attachWait（那是 lib/index.js 在真宿主里做的），
// 所以这里如实回 claimed=false —— 没接管就别说接管了。
eq('没有认领实现时如实回 claimed=false', holdOn.body.claimed, false)
const holdOff = await req('/api/questions/hold', {
  method: 'POST', headers: { Cookie: cookie }, json: { questionId: liveQuestion.id, hold: false },
})
eq('释放等待 → 200', holdOff.status, 200)
eq('释放返回 held=false', holdOff.body.held, false)
const holdNoId = await req('/api/questions/hold', { method: 'POST', headers: { Cookie: cookie }, json: { hold: true } })
eq('认领缺 questionId → 400', holdNoId.status, 400)
eq('认领缺 questionId 错误码', holdNoId.body.error, 'missing-question-id')
const holdGone = await req('/api/questions/hold', {
  method: 'POST', headers: { Cookie: cookie }, json: { questionId: 'never-existed', hold: true },
})
eq('认领已结束的问题 → 404', holdGone.status, 404)
eq('认领已结束的问题错误码', holdGone.body.error, 'question-not-found')
const anonHold = await req('/api/questions/hold', { method: 'POST', json: { questionId: 'x', hold: true } })
eq('未登录认领 → 401', anonHold.status, 401)

const answerRes = await req('/api/answer', {
  method: 'POST', headers: { Cookie: cookie },
  json: { questionId: liveQuestion.id, answers: [{ id: 'q1', selected: ['A'] }, { id: 'q2', selected: [], custom: '我写的' }] },
})
eq('回答问题 → 200', answerRes.status, 200)
eq('回答问题返回 accepted', answerRes.body.accepted, true)
const liveAnswer = await liveQuestion.promise
eq('宿主收到了手机答案', liveAnswer.answers.length, 2)
eq('自定义答案原样带出', liveAnswer.answers[1].custom, '我写的')

const anonAnswer = await req('/api/answer', { method: 'POST', json: { questionId: 'x', answers: [] } })
eq('未登录回答问题 → 401', anonAnswer.status, 401)
const formAnswer = await req('/api/answer', {
  method: 'POST', headers: { Cookie: cookie }, body: { questionId: 'x' },
  contentType: 'application/x-www-form-urlencoded',
})
eq('回答问题用表单类型 → 415', formAnswer.status, 415)
const goneAnswer = await req('/api/answer', {
  method: 'POST', headers: { Cookie: cookie }, json: { questionId: 'never-existed', answers: [] },
})
eq('回答已经结束的问题 → 404', goneAnswer.status, 404)
eq('404 错误码', goneAnswer.body.error, 'question-not-found')
const noQid = await req('/api/answer', { method: 'POST', headers: { Cookie: cookie }, json: { answers: [] } })
eq('缺 questionId → 400', noQid.status, 400)
eq('缺 questionId 错误码', noQid.body.error, 'missing-question-id')
const badAnswers = await req('/api/answer', {
  method: 'POST', headers: { Cookie: cookie },
  json: { questionId: 'whatever', answers: [{ id: 'q1', selected: ['A'] }] },
})
eq('答案不合法时先报"问题不存在"（已结算）', badAnswers.status, 404)

// 收尾：确认重复作答会被挡住
const dupAnswer = await req('/api/answer', {
  method: 'POST', headers: { Cookie: cookie }, json: { questionId: liveQuestion.id, answers: [] },
})
eq('重复回答同一个问题 → 404', dupAnswer.status, 404)

// ==================== 三·五·六、P4：新建会话 + 内嵌字体 ====================
console.log('\n———— P4：新建会话 / 内嵌字体 ————')

// —— 纯函数：合并登记表与已有会话 ——
const merged = normalizeWorkspaces(
  [{ id: 'w1', path: 'D:\\x', title: '登记名' }, { id: 'w2', path: 'D:\\y' }],
  [{ cwd: 'D:\\x' }, { cwd: 'D:\\z' }, { cwd: '' }],
)
eq('合并后按 path 去重', merged.length, 3)
eq('登记过的排前面', merged.map((w) => w.path).join(','), 'D:\\x,D:\\y,D:\\z')
eq('重复目录以登记表为准', merged[0].name, '登记名')
eq('无标题的登记项回退目录名', merged[1].name, 'y')
eq('会话独有目录也进清单', merged[2].path, 'D:\\z')
eq('空 cwd 被丢掉', merged.filter((w) => !w.path).length, 0)
eq('会话数统计正确', merged[0].sessionCount, 1)

eq('没有 registry 服务时退化成只用会话目录',
  normalizeWorkspaces(null, [{ cwd: 'D:\\only' }]).map((w) => w.path).join(','), 'D:\\only')
eq('registry.list() 抛错时退化成只用会话目录',
  normalizeWorkspaces({ list() { throw new Error('坏了') } }, [{ cwd: 'D:\\only' }]).length, 1)
eq('listRegisteredWorkspaces 对 null 返回空数组', listRegisteredWorkspaces(null).length, 0)

// —— 纯函数：校验 ——
eq('缺位置 → missing-location', validateSessionCreate({}).error, 'missing-location')
eq('相对路径被拒', validateSessionCreate({ cwd: 'a\\b' }).error, 'path-not-absolute')
eq('POSIX 绝对路径放行', validateSessionCreate({ cwd: '/a/b' }).value.cwd, '/a/b')
eq('Windows 绝对路径放行', validateSessionCreate({ cwd: 'D:\\a' }).value.cwd, 'D:\\a')
eq('UNC 路径放行', validateSessionCreate({ cwd: '\\\\srv\\share' }).value.cwd, '\\\\srv\\share')
eq('只有 workspaceId 也合法', validateSessionCreate({ workspaceId: 'w1' }).value.workspaceId, 'w1')
eq('preset 映射成 agentPreset 由调用方负责', validateSessionCreate({ cwd: 'D:\\a', preset: 'p' }).value.preset, 'p')

const noService = await createSession(null, { cwd: 'D:\\a' })
eq('会话服务缺失 → 503', noService.status, 503)
eq('会话服务缺失错误码', noService.error, 'session-service-unavailable')

// —— 路由：文件夹清单 ——
const ws = await req('/api/workspaces', { headers: { Cookie: cookie } })
eq('工作区清单 → 200', ws.status, 200)
const wsRows = ws.body.workspaces
eq('登记表 3 条 + 会话独有 1 条，去重后 4 条', wsRows.length, 4)
eq('登记过的排前面，会话独有的排后面',
  wsRows.map((w) => w.path).join(','), 'D:\\proj\\alpha,D:\\proj\\empty,D:\\a,D:\\b')
eq('重复目录以登记表为准', wsRows[2].title, '会话里也有的目录')
eq('重复目录不重复出现', wsRows.filter((w) => w.path === 'D:\\a').length, 1)
eq('登记的 id 带出来', wsRows[0].id, 'ws-1')
eq('会话独有目录没有 id', wsRows[3].id, '')
eq('会话数按 cwd 统计', wsRows[2].sessionCount, 1)
eq('没建过会话的登记目录 sessionCount 为 0', wsRows[1].sessionCount, 0)

const anonWs = await req('/api/workspaces')
eq('未登录读工作区清单 → 401', anonWs.status, 401)

// —— 路由：新建会话 ——
const created = await req('/api/session', {
  method: 'POST', headers: { Cookie: cookie }, json: { cwd: 'D:\\proj\\alpha' },
})
eq('新建会话 → 200', created.status, 200)
eq('返回新会话 id', created.body.sessionId, 'session-new-1')
eq('cwd 原样传给宿主', sessionCreateCalls[0].cwd, 'D:\\proj\\alpha')
eq('不传 preset 时不带 agentPreset', sessionCreateCalls[0].agentPreset, undefined)

const byWorkspace = await req('/api/session', {
  method: 'POST', headers: { Cookie: cookie }, json: { workspaceId: 'ws-2' },
})
eq('用 workspaceId 也能建', byWorkspace.status, 200)
eq('workspaceId 传给宿主', sessionCreateCalls[1].workspaceId, 'ws-2')
eq('带 workspaceId 时不传 cwd', sessionCreateCalls[1].cwd, undefined)

const withPreset = await req('/api/session', {
  method: 'POST', headers: { Cookie: cookie }, json: { cwd: 'D:\\a', preset: 'cordis' },
})
eq('可以顺带指定模式', withPreset.status, 200)
eq('preset 映射成 agentPreset', sessionCreateCalls[2].agentPreset, 'cordis')
eq('宿主返回的模式带出来', withPreset.body.preset, 'cordis')

const noLoc = await req('/api/session', { method: 'POST', headers: { Cookie: cookie }, json: {} })
eq('既没 cwd 也没 workspaceId → 400', noLoc.status, 400)
eq('缺位置错误码', noLoc.body.error, 'missing-location')

const relPath = await req('/api/session', {
  method: 'POST', headers: { Cookie: cookie }, json: { cwd: 'relative\\dir' },
})
eq('相对路径 → 400', relPath.status, 400)
eq('相对路径错误码', relPath.body.error, 'path-not-absolute')
eq('被拒的请求没有打到宿主', sessionCreateCalls.length, 3)

const longPath = await req('/api/session', {
  method: 'POST', headers: { Cookie: cookie }, json: { cwd: 'D:\\' + 'x'.repeat(5000) },
})
eq('超长路径 → 400', longPath.status, 400)
eq('超长路径错误码', longPath.body.error, 'path-too-long')

const anonCreate = await req('/api/session', { method: 'POST', json: { cwd: 'D:\\a' } })
eq('未登录新建会话 → 401', anonCreate.status, 401)

const formCreate = await req('/api/session', {
  method: 'POST', headers: { Cookie: cookie }, body: { cwd: 'D:\\a' },
  contentType: 'application/x-www-form-urlencoded',
})
eq('新建会话用表单类型 → 415（CSRF 闸门）', formCreate.status, 415)

const boom = await req('/api/session', {
  method: 'POST', headers: { Cookie: cookie }, json: { cwd: 'D:\\boom' },
})
eq('宿主抛错 → 502', boom.status, 502)
eq('上游错误码透传', boom.body.code, 'session/unavailable')

// —— 路由：内嵌字体 ——
const fontCss = await req('/font.css', { raw: true })
eq('GET /font.css → 200', fontCss.status, 200)
check('font.css 声明 JetBrains Mono', fontCss.text.includes("font-family: 'JetBrains Mono'"))
check('font.css 引用 Regular', fontCss.text.includes('/font/JetBrainsMono-Regular.ttf'))
check('font.css 引用 Bold', fontCss.text.includes('/font/JetBrainsMono-Bold.ttf'))
check('font-display: swap（先用回退字体渲染）', fontCss.text.includes('font-display: swap'))

const ttf = await reqRaw('/font/JetBrainsMono-Regular.ttf')
eq('GET 字体 → 200', ttf.status, 200)
eq('字体 MIME 是 font/ttf', ttf.headers['content-type'], 'font/ttf')
check('字体开了长缓存', String(ttf.headers['cache-control']).includes('max-age=31536000'),
  String(ttf.headers['cache-control']))
const onDisk = fs.readFileSync(path.join(WEB_ROOT, 'fonts', 'JetBrainsMono-Regular.ttf'))
eq('字体字节数一致（没被 utf8 读坏）', ttf.buf.length, onDisk.length)
check('字体字节完全一致', ttf.buf.equals(onDisk), `${ttf.buf.length} vs ${onDisk.length}`)
eq('TrueType 魔数正确', ttf.buf.subarray(0, 4).toString('hex'), '00010000')

const anonFont = await reqRaw('/font/JetBrainsMono-Regular.ttf')
eq('字体不需要登录（登录页也要用它）', anonFont.status, 200)
const anonCss = await req('/font.css', { raw: true })
eq('font.css 也不需要登录', anonCss.status, 200)
check('font.css 是 CSS 类型', String(anonCss.headers['content-type']).includes('text/css'),
  String(anonCss.headers['content-type']))

// 只有白名单里那两个字体文件是公开的。不在白名单里的路径会掉回"需要登录"，
// 所以未登录的访客连"哪些路径存在"都问不出来 —— 这是有意的，不是遗漏。
const missingFont = await req('/font/Nope.ttf')
eq('白名单外的字体路径 → 401（不泄露路径是否存在）', missingFont.status, 401)
const traversalFont = await req('/font/../../mobile-mirror.json')
check('路径穿越拿不到配置',
  traversalFont.status !== 200 && !traversalFont.text.includes('passwordHash'),
  `${traversalFont.status} ${traversalFont.text.slice(0, 40)}`)


// ==================== 二·五、下载文件（0.10）—— 主服务关闭前测 ====================
console.log('\n———— 下载文件 ————')
{
  // 自己造一个临时工作区，并把 registry / controller 换成指向它的替身
  // （deps 是普通对象，路由每次调用都现读，所以换完立即生效）
  const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-dl-'))
  fs.mkdirSync(path.join(WS, 'out'))
  const payload = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('假装是个 APK', 'utf8'), Buffer.alloc(300, 0x78)])
  const apk = path.join(WS, 'out', 'dsh-mobile-mirror-client-0.10.apk')
  fs.writeFileSync(apk, payload)
  fs.writeFileSync(path.join(WS, 'note.txt'), '你好')

  const origList = fakeRegistry.list
  const origController = deps.controller
  fakeRegistry.list = () => [{ id: 'ws-dl', path: WS, title: '下载测试' }]
  deps.controller = {
    async list() {
      return {
        items: [{
          sessionId: 'sess-dl', running: false, updatedAt: 1, cwd: WS, blank: false,
          projections: { values: { title: '下载测试' } },
        }],
      }
    },
  }

  const rel = 'out/dsh-mobile-mirror-client-0.10.apk'
  const ok = await reqRaw(`/api/file?id=sess-dl&path=${encodeURIComponent(rel)}`, { headers: { Cookie: cookie } })
  eq('相对路径 → 200', ok.status, 200)
  eq('字节一字不差', ok.buf.equals(payload), true)
  eq('按扩展名给 MIME', ok.headers['content-type'], 'application/vnd.android.package-archive')
  check('声明为附件并带文件名', /attachment; filename="dsh-mobile-mirror-client-0\.10\.apk"/.test(String(ok.headers['content-disposition'])), String(ok.headers['content-disposition']))
  eq('声明支持 Range', ok.headers['accept-ranges'], 'bytes')

  const abs = await reqRaw(`/api/file?path=${encodeURIComponent(apk)}`, { headers: { Cookie: cookie } })
  eq('绝对路径 → 200', abs.status, 200)
  eq('绝对路径字节正确', abs.buf.equals(payload), true)

  const head = await req(`/api/file?path=${encodeURIComponent(apk)}`, { method: 'HEAD', headers: { Cookie: cookie } })
  eq('HEAD → 200', head.status, 200)
  eq('HEAD 给长度', head.headers['content-length'], String(payload.length))

  const part = await reqRaw(`/api/file?path=${encodeURIComponent(apk)}`, { headers: { Cookie: cookie, Range: 'bytes=2-9' } })
  eq('Range → 206', part.status, 206)
  eq('Range 字节正确', part.buf.equals(payload.subarray(2, 10)), true)
  eq('Range 头正确', part.headers['content-range'], `bytes 2-9/${payload.length}`)

  const tail = await reqRaw(`/api/file?path=${encodeURIComponent(apk)}`, { headers: { Cookie: cookie, Range: 'bytes=-4' } })
  eq('后缀 Range → 206', tail.status, 206)
  eq('后缀 Range 取到末尾 4 字节', tail.buf.equals(payload.subarray(payload.length - 4)), true)

  const bad = await reqRaw(`/api/file?path=${encodeURIComponent(apk)}`, { headers: { Cookie: cookie, Range: 'bytes=99999-' } })
  eq('越界 Range → 416', bad.status, 416)

  const outside = await reqRaw(`/api/file?path=${encodeURIComponent(path.join(WS, '..', 'outside.txt'))}`, { headers: { Cookie: cookie } })
  eq('工作区之外 → 403', outside.status, 403)
  const outsideBody = (() => { try { return JSON.parse(outside.buf.toString('utf8')) } catch { return {} } })()
  eq('越界错误码', outsideBody.error, 'outside-workspace')

  const trav = await reqRaw(`/api/file?id=sess-dl&path=${encodeURIComponent('../../../../Windows/win.ini')}`, { headers: { Cookie: cookie } })
  eq('相对路径往上越界 → 403', trav.status, 403)

  const missing = await reqRaw(`/api/file?path=${encodeURIComponent(path.join(WS, 'nope.txt'))}`, { headers: { Cookie: cookie } })
  eq('文件不存在 → 404', missing.status, 404)

  const dir = await reqRaw(`/api/file?path=${encodeURIComponent(WS)}`, { headers: { Cookie: cookie } })
  eq('目录 → 404', dir.status, 404)

  const noPath = await reqRaw('/api/file', { headers: { Cookie: cookie } })
  eq('缺 path → 400', noPath.status, 400)

  const noId = await reqRaw(`/api/file?path=${encodeURIComponent(rel)}`, { headers: { Cookie: cookie } })
  eq('相对路径缺会话 id → 400', noId.status, 400)

  const txt = await reqRaw(`/api/file?id=sess-dl&path=${encodeURIComponent('note.txt')}`, { headers: { Cookie: cookie } })
  eq('文本文件内容正确', txt.buf.toString('utf8'), '你好')
  eq('文本 MIME 带 charset', txt.headers['content-type'], 'text/plain; charset=utf-8')

  fakeRegistry.list = origList
  deps.controller = origController
  fs.rmSync(WS, { recursive: true, force: true })
}
await mirror.close()

// ==================== 三·六、只读模式（enablePrompt=false） ====================
console.log('\n———— 只读模式 ————')
// 复用同一个端口（上一个服务已关）与同一个账号：config 已被 /setup 改过。
const readOnly = createMirrorServer(
  { ...config, enablePrompt: false },
  { log: () => {}, configFile: path.join(TMP, 'config-readonly.json'), deps: { controller: fakeController() } },
)
await readOnly.listen()
const roLogin = await req('/login', { method: 'POST', body: { username: 'u', password: 'pass-123', remember: 'on' } })
const roCookie = String(roLogin.headers['set-cookie']).split(';')[0]
check('只读模式仍可登录', roLogin.status === 303 && roCookie.startsWith('dsh_mm_session='))

const roPrompt = await req('/api/prompt', { method: 'POST', headers: { Cookie: roCookie }, json: { sessionId: 's', requestId: 'ro-1', text: 'x' } })
eq('enablePrompt=false 发消息 → 403', roPrompt.status, 403)
eq('403 错误码', roPrompt.body.error, 'prompt-disabled')
const roCancel = await req('/api/cancel', { method: 'POST', headers: { Cookie: roCookie }, json: { sessionId: 's' } })
eq('enablePrompt=false 停止 → 403', roCancel.status, 403)
eq('只读模式下列表仍可用', (await req('/api/sessions', { headers: { Cookie: roCookie } })).status, 200)
// P3：切模型 / 切模式 / 回答问题同样是写操作，enablePrompt=false 时必须一起关掉
const roModel = await req('/api/model', {
  method: 'POST', headers: { Cookie: roCookie }, json: { sessionId: 's', provider: 'p', model: 'm' },
})
eq('enablePrompt=false 切模型 → 403', roModel.status, 403)
eq('切模型的 403 错误码', roModel.body.error, 'prompt-disabled')
const roPreset = await req('/api/preset', {
  method: 'POST', headers: { Cookie: roCookie }, json: { sessionId: 's', preset: 'ptc' },
})
eq('enablePrompt=false 切模式 → 403', roPreset.status, 403)
const roAnswer = await req('/api/answer', {
  method: 'POST', headers: { Cookie: roCookie }, json: { questionId: 'q', answers: [] },
})
eq('enablePrompt=false 回答问题 → 403', roAnswer.status, 403)
const roHold = await req('/api/questions/hold', {
  method: 'POST', headers: { Cookie: roCookie }, json: { questionId: 'q', hold: true },
})
eq('enablePrompt=false 认领等待 → 403', roHold.status, 403)
eq('认领等待的 403 错误码', roHold.body.error, 'prompt-disabled')
const roCreate = await req('/api/session', {
  method: 'POST', headers: { Cookie: roCookie }, json: { cwd: 'D:\\a' },
})
eq('enablePrompt=false 新建会话 → 403', roCreate.status, 403)
eq('新建会话的 403 错误码', roCreate.body.error, 'prompt-disabled')
eq('只读模式下 controller.prompt 一次都没被调用', promptCalls.length, 0)
eq('只读模式下 controller.selectModel 一次都没被调用', selectModelCalls.length, 0)
eq('只读模式下 controller.create 一次都没被调用', sessionCreateCalls.length, 0)
eq('只读模式下工作区清单仍可读',
  (await req('/api/workspaces', { headers: { Cookie: roCookie } })).status, 200)
await readOnly.close()

// ==================== 三·七、上游报错的透传 ====================
console.log('\n———— 上游报错透传 ————')
// 502 要把上游的 code 带出来。只透传 message 的话，"业务拒绝"（RemoteError 带 code）
// 和"DSH 代码缺陷"（普通 TypeError 没有 code）在手机上长得一模一样。
const failingDeps = {
  controller: {
    ...fakeController(),
    async prompt(request) {
      if (request.content[0].text === 'nocode') {
        // 模仿真机上那个 bug：普通 TypeError，没有 code
        throw new TypeError("Cannot read properties of undefined (reading 'throwIfAborted')")
      }
      const err = new Error('boom from upstream')
      err.code = 'session/not-found'
      throw err
    },
  },
}
const failing = createMirrorServer(
  { ...config, enablePrompt: true },
  { log: () => {}, configFile: path.join(TMP, 'config-failing.json'), deps: failingDeps },
)
await failing.listen()
const failLogin = await req('/login', { method: 'POST', body: { username: 'u', password: 'pass-123', remember: 'on' } })
const failCookie = String(failLogin.headers['set-cookie']).split(';')[0]

const coded = await req('/api/prompt', { method: 'POST', headers: { Cookie: failCookie }, json: { sessionId: 's1', requestId: 'fail-1', text: 'x' } })
eq('上游抛错 → 502', coded.status, 502)
eq('502 的 error 是本插件自己的错误码', coded.body.error, 'prompt-failed')
eq('502 透传上游 code', coded.body.code, 'session/not-found')
eq('502 透传上游 message', coded.body.message, 'boom from upstream')

const noCode = await req('/api/prompt', { method: 'POST', headers: { Cookie: failCookie }, json: { sessionId: 's2', requestId: 'fail-2', text: 'nocode' } })
eq('无 code 的 TypeError 也回 502', noCode.status, 502)
check('上游没有 code 时不凭空造字段', noCode.body.code === undefined, JSON.stringify(noCode.body))
check('无 code 时 message 仍原样带出',
  /throwIfAborted/.test(String(noCode.body.message)), String(noCode.body.message))

await failing.close()

// ==================== 四、脱离 HTTP 直测数据层入口 ====================
console.log('\n———— 数据层入口 ————')
const controller = fakeController()
const listed = await listSessions(controller, new AbortController().signal)
eq('listSessions 排序', listed[0].id, 'sess-2')
const paged = await pageBack(controller, SESSION_ID, 5, 20, new AbortController().signal)
eq('pageBack 投影', paged.records[0].data.blocks[0].text, '更早')
// 翻页参数必须对：throughSeq 是会话头（-1），beforeSeq 才是"当前最早那条"。
// 1.3.1 把两者传成同一个值，大会话上手机侧超时 → "连不上电脑"。
eq('pageBack 的 throughSeq 是会话头 -1', pageRequest.throughSeq, -1)
eq('pageBack 的 beforeSeq 是当前最早那条', pageRequest.beforeSeq, 5)
await pageBack(controller, SESSION_ID, 5, 999, new AbortController().signal)
eq('pageBack 把 maxMessages 夹到 200', pageRequest.maxMessages, 200)

const iterator = openFollow(controller, SESSION_ID, { maxMessages: 999 }, new AbortController().signal)
const first = await iterator[Symbol.asyncIterator]().next()
eq('openFollow 首帧是 snapshot', first.value.type, 'snapshot')
eq('openFollow 把 maxMessages 夹到 200', followRequest.maxMessages, 200)

fs.rmSync(TMP, { recursive: true, force: true })
console.log(`\n${passed}/${passed + failed} 通过`)
if (failed > 0) process.exitCode = 1
