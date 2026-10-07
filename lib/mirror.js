/**
 * dsh-mobile-mirror —— 会话数据层。
 *
 * 职责：把 `sessionController` 的原始帧归一化成手机页能直接渲染的形状。
 *
 * 为什么必须做归一化，而不是把原始帧透传：
 *   DSH 的会话事件里有些条目**极大** —— `request/header` 带着完整的工具 schema 列表，
 *   `system/message` 带着整个系统提示，`assistant/message` 还带一份 `stream` 原始记录
 *   （而逐字内容我们已经通过 assistant-stream 单独推过了，再传一遍纯属浪费）。
 *   手机在 Wi-Fi 上，这些几十上百 KB 的字段会让界面卡住。所以按事件类型做投影，
 *   该省略的省略、该截断的截断，并在必要时留下标记说明"这里省略了什么"。
 *
 * 本文件不 import 任何 DSH 内部模块，也不依赖 Cordis —— 可以脱离宿主单测。
 */

/** 单个文本块的字符上限。 */
const MAX_TEXT = 4000

/** 工具参数的字符上限。 */
const MAX_ARGS = 2000

/** 快照默认带回的历史事件条数。 */
export const DEFAULT_MAX_MESSAGES = 60

/** 翻页默认条数。 */
export const DEFAULT_PAGE_MESSAGES = 40

/**
 * 截断超长字符串，并留下可见标记。
 * @param value - 原值。
 * @param limit - 上限。
 * @returns 截断后的字符串；非字符串返回空串。
 */
function clip(value, limit) {
  if (typeof value !== 'string') return ''
  if (value.length <= limit) return value
  return `${value.slice(0, limit)}\n\n…（已截断，原长 ${value.length} 字符）`
}

/**
 * 从会话摘要里尽力抽出标题。
 *
 * `SessionSummary` 结构里**没有** title 字段，标题只可能出现在
 * `projections.values` 这个开放记录里（由 session-title 之类的插件写入）。
 * 键名没有稳定约定，所以这里按"常见键优先 + 模糊匹配兜底"来取，
 * 取不到就返回 null，由前端降级显示 cwd。
 * @param summary - SessionSummary。
 * @returns 标题，或 null。
 */
export function titleOf(summary) {
  const values = summary && summary.projections && summary.projections.values
  if (!values || typeof values !== 'object') return null
  for (const key of ['title', 'sessionTitle', 'name', 'label']) {
    const value = values[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  for (const [key, value] of Object.entries(values)) {
    if (/title/i.test(key) && typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

/**
 * 把 SessionSummary 归一化成手机页需要的字段。
 * @param summary - SessionSummary。
 * @returns 归一化后的会话行。
 */
export function normalizeSummary(summary) {
  const source = summary || {}
  return {
    id: String(source.sessionId || ''),
    title: titleOf(source),
    running: source.running === true,
    blank: source.blank === true,
    agentAvailable: source.agentAvailable === true,
    updatedAt: Number(source.updatedAt) || 0,
    cwd: typeof source.cwd === 'string' ? source.cwd : null,
    origin: source.origin || null,
    parentSessionId: source.parentSessionId ? String(source.parentSessionId) : null,
  }
}

/**
 * 读取会话列表，按最近活动降序。
 * @param controller - ctx.sessionController。
 * @param signal - 取消信号。
 * @returns 归一化后的会话行数组。
 */
export async function listSessions(controller, signal) {
  const value = await controller.list({}, signal)
  const items = Array.isArray(value && value.items) ? value.items : []
  return items
    .map(normalizeSummary)
    .filter((item) => item.id)
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

/**
 * 取出事件记录里的裸事件。
 *
 * 对形状做防御：正常是 `SessionEventEntry { type:'event', event }`，
 * 但也接受"记录本身就是事件"的情况，避免因为版本差异整个流挂掉。
 * @param record - 历史记录项。
 * @returns 裸事件，或 null。
 */
function eventOf(record) {
  if (!record || typeof record !== 'object') return null
  if (record.event && typeof record.event === 'object') return record.event
  if (typeof record.type === 'string' && typeof record.seq === 'number') return record
  return null
}

/**
 * 投影一组内容块。
 * @param content - 内容块数组。
 * @returns 精简后的内容块数组。
 */
export function projectBlocks(content) {
  if (!Array.isArray(content)) return []
  const out = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    switch (block.type) {
      case 'text':
        out.push({ type: 'text', text: clip(block.text, MAX_TEXT) })
        break
      case 'reasoning':
        out.push({ type: 'reasoning', text: clip(block.text, MAX_TEXT) })
        break
      case 'image': {
        const attachment = block.attachment || {}
        out.push({
          type: 'image',
          attachmentId: attachment.attachmentId ? String(attachment.attachmentId) : null,
          mediaType: attachment.mediaType || null,
          width: Number(attachment.width) || 0,
          height: Number(attachment.height) || 0,
          bytes: Number(attachment.bytes) || 0,
        })
        break
      }
      case 'file': {
        const attachment = block.attachment || {}
        out.push({
          type: 'file',
          name: attachment.name || null,
          bytes: Number(attachment.bytes) || 0,
          attachmentId: attachment.attachmentId ? String(attachment.attachmentId) : null,
        })
        break
      }
      case 'tool-call':
        out.push({
          type: 'tool-call',
          id: block.id ? String(block.id) : null,
          name: block.name ? String(block.name) : null,
          args: clip(block.arguments, MAX_ARGS),
        })
        break
      default:
        out.push({ type: String(block.type || 'unknown') })
    }
  }
  return out
}

/**
 * 从事件 data 里取出内容块。
 *
 * 为什么要这么啰嗦：`MessageBase` 的确切字段名没有查到（inspect 只给出了
 * `UserMessage extends MessageBase`），而正文取不到会让消息整条显示为空白。
 * 所以把几种可能的位置都试一遍 —— 拿到第一个数组就用，全没有再看是不是
 * 直接放了个字符串。这是纯防御，正常情况下第一个分支就命中。
 */
function contentOf(data) {
  if (!data || typeof data !== 'object') return []
  const message = data.message && typeof data.message === 'object' ? data.message : {}
  const candidates = [data.content, data.blocks, message.content, message.blocks]
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate
  }
  for (const candidate of [data.content, message.content]) {
    if (typeof candidate === 'string' && candidate) return [{ type: 'text', text: candidate }]
  }
  return []
}

/** 归一化 token 用量。 */
function projectUsage(usage) {
  if (!usage || typeof usage !== 'object') return null
  const pick = (key) => (Number.isFinite(usage[key]) ? usage[key] : undefined)
  return {
    inputTokens: pick('inputTokens'),
    outputTokens: pick('outputTokens'),
    totalTokens: pick('totalTokens'),
    cacheReadTokens: pick('cacheReadTokens'),
    cacheWriteTokens: pick('cacheWriteTokens'),
    reasoningTokens: pick('reasoningTokens'),
  }
}

/**
 * 把一个持久事件投影成手机页需要的形状。
 *
 * 返回 null 表示这个事件**不需要下发**（纯冗余）。
 * @param wire - SessionWireEvent。
 * @returns 投影后的事件，或 null。
 */
export function projectEvent(wire) {
  if (!wire || typeof wire !== 'object') return null
  const { type, seq, time } = wire
  const data = wire.data && typeof wire.data === 'object' ? wire.data : {}
  if (typeof type !== 'string' || typeof seq !== 'number') return null

  switch (type) {
    case 'turn/start':
      return { type, seq, time, data: { turn: data.turn } }

    case 'turn/end':
      return { type, seq, time, data: { turn: data.turn, reason: (data.reason && data.reason.kind) || 'unknown' } }

    case 'step/start':
    case 'step/end':
      return { type, seq, time, data: { turn: data.turn, step: data.step } }

    case 'user/message':
      return {
        type, seq, time,
        data: { role: 'user', id: data.id ? String(data.id) : null, blocks: projectBlocks(contentOf(data)) },
      }

    case 'assistant/message':
      return {
        type, seq, time,
        data: {
          role: 'assistant',
          id: data.message && data.message.id ? String(data.message.id) : null,
          blocks: projectBlocks(contentOf(data)),
          usage: projectUsage(data.usage),
          interrupted: data.interrupted === true,
          model: (data.message && data.message.source && data.message.source.model) || null,
        },
      }

    case 'tool/call':
      return {
        type, seq, time,
        data: {
          callId: data.callId ? String(data.callId) : null,
          name: data.name ? String(data.name) : null,
          args: clip(data.arguments, MAX_ARGS),
        },
      }

    case 'tool/result': {
      const message = data.message || {}
      const source = message.source || {}
      return {
        type, seq, time,
        data: {
          callId: source.callId ? String(source.callId) : (data.callId ? String(data.callId) : null),
          isError: message.isError === true || Boolean(data.error),
          blocks: projectBlocks(contentOf(data)),
          error: data.error
            ? { name: data.error.name || null, code: data.error.code || null, reason: data.error.reason || null }
            : null,
        },
      }
    }

    // 这一条带着完整的工具 schema 列表和调用配置，原样下发会有几十上百 KB。
    // 手机页只需要"用了哪个模型、这轮带了多少工具"。
    case 'request/header': {
      const header = data.header || {}
      const config = header.config || {}
      return {
        type, seq, time,
        data: {
          turn: data.turn,
          reason: data.reason || null,
          model: config.model || null,
          provider: config.provider || null,
          toolCount: Array.isArray(header.tools) ? header.tools.length : 0,
          omitted: ['toolSchemas'],
        },
      }
    }

    case 'request/context':
      return { type, seq, time, data: { provider: data.provider || null, model: data.model || null } }

    // 系统提示 / 开发者消息：内容极长且对"看对话"没有价值，只留标记。
    case 'system/message':
      return { type, seq, time, data: { omitted: true, note: '系统提示（已省略）' } }

    case 'developer/message':
      return { type, seq, time, data: { omitted: true, note: '开发者消息（已省略）' } }

    // assistant/attempt 与 assistant/message 内容重复，且额外携带一份 stream 原始记录 —— 丢弃。
    case 'assistant/attempt':
      return null

    default:
      // 未知类型：只下发类型与序号，让调试视图能看见"这里有个没处理的事件"，
      // 但不把可能很大的 data 透传出去。
      return { type, seq, time, data: null, unknown: true }
  }
}

/**
 * 投影一个逐字流式帧。返回 null 表示不需要下发。
 * 键名刻意压短（k/i/t/a）—— 流式帧数量最多，带宽最敏感。
 * @param frame - SessionAssistantStreamFrame。
 * @returns 投影后的帧，或 null。
 */
export function projectStreamFrame(frame) {
  if (!frame || typeof frame !== 'object') return null
  switch (frame.type) {
    case 'start':
      return { k: 'start', turn: frame.turn, step: frame.step }

    case 'chunk': {
      const chunk = frame.chunk
      if (!chunk || typeof chunk !== 'object') return null
      switch (chunk.type) {
        case 'text-delta':
          return typeof chunk.text === 'string' && chunk.text
            ? { k: 'text', i: chunk.index, t: chunk.text }
            : null
        case 'reasoning-delta':
          return typeof chunk.text === 'string' && chunk.text
            ? { k: 'reason', i: chunk.index, t: chunk.text }
            : null
        case 'tool-call-delta':
          return { k: 'tool', i: chunk.index, id: chunk.id ? String(chunk.id) : null, name: chunk.name, a: chunk.argumentsDelta || '' }
        case 'block-start':
          return { k: 'block-start', i: chunk.index, bt: chunk.blockType }
        case 'block-end':
          return { k: 'block-end', i: chunk.index }
        case 'usage':
          return { k: 'usage', u: projectUsage(chunk.usage) }
        case 'finish':
          return { k: 'finish', r: (chunk.reason && chunk.reason.kind) || null }
        default:
          return null
      }
    }

    case 'end':
      return { k: 'end', outcome: (frame.outcome && frame.outcome.kind) || null }

    default:
      return null
  }
}

/**
 * 投影一个 follow 快照。
 * @param frame - SessionFollowFrame（type 为 snapshot）。
 * @returns 归一化后的快照。
 */
export function projectSnapshot(frame) {
  const header = frame.header || {}
  const records = Array.isArray(frame.records) ? frame.records : []
  const baseline = frame.assistantStream || null
  const active = baseline && baseline.activeAttempt ? baseline.activeAttempt : null

  return {
    header: {
      id: header.id ? String(header.id) : null,
      cwd: typeof header.cwd === 'string' ? header.cwd : null,
      createdAt: Number(header.createdAt) || 0,
      agentPreset: header.agentPreset || null,
    },
    cursor: typeof frame.cursor === 'number' ? frame.cursor : 0,
    hasMore: frame.hasMore === true,
    records: records.map((record) => projectEvent(eventOf(record))).filter(Boolean),
    projections: (frame.projections && frame.projections.values) || {},
    assistantStream: baseline
      ? {
        revision: baseline.revision,
        activeAttempt: active
          ? {
            attemptId: active.attemptId ? String(active.attemptId) : null,
            turn: active.turn,
            step: active.step,
            nextIndex: active.nextIndex,
            // 已产生的流式块要重放，才能还原"正在输出中"的那条消息
            stream: (Array.isArray(active.stream) ? active.stream : [])
              .map(projectStreamFrame)
              .filter(Boolean),
          }
          : null,
      }
      : null,
  }
}

/**
 * 归一化一个 follow 帧。
 * @param frame - SessionFollowFrame。
 * @returns `{ e, d }` 信封，或 null（该帧不下发）。
 */
export function encodeFollowFrame(frame) {
  if (!frame || typeof frame !== 'object') return null
  switch (frame.type) {
    case 'snapshot':
      return { e: 'snapshot', d: projectSnapshot(frame) }
    case 'event': {
      const event = projectEvent(eventOf(frame.event) || frame.event)
      return event ? { e: 'event', d: event } : null
    }
    case 'assistant-stream': {
      const stream = projectStreamFrame(frame.frame)
      return stream ? { e: 'stream', d: stream } : null
    }
    default:
      return null
  }
}

/**
 * 往上翻历史。
 *
 * 关于 `throughSeq` / `beforeSeq`：`throughSeq` 是必填的"截至哪个序号"，
 * `beforeSeq` 是向前的游标。从当前视图最早那条事件往前翻时两者取同一个值。
 * 这个语义是从类型签名推断的，实测若不对，改这一处即可。
 * @param controller - ctx.sessionController。
 * @param sessionId - 会话 id。
 * @param beforeSeq - 当前视图中最早事件的 seq。
 * @param maxMessages - 本次最多返回多少条。
 * @param signal - 取消信号。
 * @returns `{ records, hasMore }`。
 */
export async function pageBack(controller, sessionId, beforeSeq, maxMessages, signal) {
  const page = await controller.page({
    address: { kind: 'session', sessionId },
    throughSeq: beforeSeq,
    beforeSeq,
    maxMessages: Number.isFinite(maxMessages) && maxMessages > 0 ? Math.min(maxMessages, 200) : DEFAULT_PAGE_MESSAGES,
  }, signal)
  const records = Array.isArray(page && page.records) ? page.records : []
  return {
    records: records.map((record) => projectEvent(eventOf(record))).filter(Boolean),
    hasMore: page && page.hasMore === true,
  }
}

/**
 * 打开一个会话的跟随流。
 * @param controller - ctx.sessionController。
 * @param sessionId - 会话 id。
 * @param options - maxMessages 覆盖项。
 * @param signal - 取消信号。
 * @returns 归一化帧的异步迭代器。
 */
export function openFollow(controller, sessionId, options, signal) {
  const maxMessages = Number.isFinite(options && options.maxMessages) && options.maxMessages > 0
    ? Math.min(options.maxMessages, 200)
    : DEFAULT_MAX_MESSAGES

  return controller.follow({
    address: { kind: 'session', sessionId },
    assistantStream: true,
    maxMessages,
    turnWindow: { minMessages: Math.min(30, maxMessages), minTurns: 3 },
  }, signal)
}

/* ========================================================================
 * P2：写操作（发消息 / 停止当前轮）
 *
 * 这是插件第一次能改变宿主状态，所以校验与幂等都在这一层做掉，
 * 路由层只负责搬运和状态码。
 * ====================================================================== */

/** 单条消息的字符上限。手机输入 8000 足够，也避免有人拿它灌宿主。 */
export const MAX_PROMPT_CHARS = 8000

/** requestId 的允许形状。刻意收窄：它会被上游当作幂等键，格式必须可控。 */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

/**
 * 幂等台账：记住最近成功提交过的 requestId。
 *
 * 为什么需要它：`SessionPromptRequest` 带 `requestId`，说明上游设计上支持幂等，
 * 但"上游确实按 requestId 去重"这件事我没有实测验证过。弱网下手机重发是常态，
 * 一旦上游不去重，用户就会看到自己发了两遍。所以在本地再兜一层，
 * 不把正确性全押在未验证的假设上。
 * @param options - limit 条数上限，ttlMs 过期时间。
 * @returns 台账句柄。
 */
export function createPromptLedger(options = {}) {
  const limit = Number.isFinite(options.limit) && options.limit > 0 ? options.limit : 200
  const ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs > 0 ? options.ttlMs : 10 * 60 * 1000
  const seen = new Map()

  /** 清掉过期的。 */
  function sweep(now) {
    for (const [key, at] of seen) {
      if (now - at > ttlMs) seen.delete(key)
    }
  }

  return {
    /**
     * 这个 requestId 是否已经成功提交过。
     * @param requestId - 幂等键。
     * @returns 是否重复。
     */
    has(requestId) {
      const at = seen.get(requestId)
      if (at === undefined) return false
      if (Date.now() - at > ttlMs) {
        seen.delete(requestId)
        return false
      }
      return true
    },
    /**
     * 记下一个已成功提交的 requestId。
     * @param requestId - 幂等键。
     */
    remember(requestId) {
      seen.set(requestId, Date.now())
      if (seen.size <= limit) return
      sweep(Date.now())
      // 仍然超限就按插入顺序淘汰最老的
      while (seen.size > limit) {
        const oldest = seen.keys().next().value
        if (oldest === undefined) break
        seen.delete(oldest)
      }
    },
    /** 当前记录数，用于诊断。 */
    get size() {
      return seen.size
    },
  }
}

/**
 * 发送节流闸门：同一个键在 minIntervalMs 内只放行一次。
 * 防的是手机端误触连点把宿主刷爆。
 * @param options - minIntervalMs 最小间隔。
 * @returns 闸门句柄。
 */
export function createRateGate(options = {}) {
  const minIntervalMs = Number.isFinite(options.minIntervalMs) && options.minIntervalMs >= 0
    ? options.minIntervalMs
    : 300
  const last = new Map()
  return {
    /**
     * 是否放行；放行时会记下当前时间。
     * @param key - 闸门键（这里用 sessionId）。
     * @param now - 当前时间，便于测试注入。
     * @returns 是否放行。
     */
    allow(key, now = Date.now()) {
      const previous = last.get(key)
      if (previous !== undefined && now - previous < minIntervalMs) return false
      last.set(key, now)
      return true
    },
  }
}

/**
 * 校验并归一化一条待发送的消息。
 * @param input - 原始请求体。
 * @returns `{ value }` 或 `{ error, message }`。
 */
export function validatePrompt(input) {
  const source = input && typeof input === 'object' ? input : {}
  const sessionId = typeof source.sessionId === 'string' ? source.sessionId.trim() : ''
  if (!sessionId) return { error: 'missing-session-id', message: '缺少会话 id' }

  if (typeof source.requestId !== 'string' || !REQUEST_ID_PATTERN.test(source.requestId)) {
    return { error: 'bad-request-id', message: 'requestId 非法（只允许字母、数字、下划线、连字符，1–128 位）' }
  }

  if (typeof source.text !== 'string') return { error: 'bad-text', message: '消息内容必须是文本' }
  const text = source.text.trim()
  if (!text) return { error: 'empty-text', message: '消息不能为空' }
  if (text.length > MAX_PROMPT_CHARS) {
    return { error: 'text-too-long', message: `消息太长（上限 ${MAX_PROMPT_CHARS} 字符，当前 ${text.length}）` }
  }

  const timeZone = typeof source.timeZone === 'string' && source.timeZone.length > 0 && source.timeZone.length <= 64
    ? source.timeZone
    : undefined

  return { value: { sessionId, requestId: source.requestId, text, timeZone } }
}

/**
 * 发送一条纯文本消息。
 *
 * 只支持 text：`PromptContentPart` 里的 image 需要 base64 走 `admitPromptContent`
 * 准入管道、file 需要先上传拿 receiptId，都不在这一版范围内。
 * @param controller - ctx.sessionController。
 * @param input - 原始请求体。
 * @param options - ledger 幂等台账，signal 取消信号（缺省时内部补一个）。
 * @returns `{ ok: true, accepted, duplicate }` 或 `{ ok: false, status, error, message }`。
 */
export async function sendPrompt(controller, input, options = {}) {
  const checked = validatePrompt(input)
  if (checked.error) return { ok: false, status: 400, error: checked.error, message: checked.message }

  const { sessionId, requestId, text, timeZone } = checked.value
  const ledger = options.ledger
  if (ledger && ledger.has(requestId)) return { ok: true, accepted: true, duplicate: true }

  const request = {
    requestId,
    sessionId,
    // 固定 queue：排队等当前轮结束。steer（插进正在跑的轮次）语义未验证，不做。
    mode: 'queue',
    content: [{ type: 'text', text }],
  }
  if (timeZone) request.clientTimeZone = timeZone

  // DSH 的门面方法 prompt(request, signal) 第一行就是 signal.throwIfAborted()，
  // 而且**没有 undefined 保护**（同一个门面里 schedule 服务用的是 signal?.throwIfAborted()）。
  // 忘了传 signal 得到的是一个 TypeError（"Cannot read properties of undefined"），
  // 而不是有意义的错误。所以在这里兜底，而不是指望每个调用方都记得传。
  //
  // 这个 signal 只在门面入口被检查一次，不会传到 commands.prompt，
  // 因此给一个永不 abort 的 signal 是安全的：它不会影响已经受理的轮次。
  const signal = options.signal || new AbortController().signal
  const value = await controller.prompt(request, signal)
  if (ledger) ledger.remember(requestId)
  return { ok: true, accepted: value ? value.accepted === true : false, duplicate: false }
}

/**
 * 停止某个会话当前正在跑的轮次。
 * @param controller - ctx.sessionController。
 * @param sessionId - 会话 id。
 * @returns `{ ok: true, accepted }` 或 `{ ok: false, status, error, message }`。
 */
export async function cancelTurn(controller, sessionId) {
  const id = typeof sessionId === 'string' ? sessionId.trim() : ''
  if (!id) return { ok: false, status: 400, error: 'missing-session-id', message: '缺少会话 id' }
  const value = await controller.cancel({ sessionId: id })
  return { ok: true, accepted: value ? value.accepted === true : false }
}
