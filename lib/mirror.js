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

/* ========================================================================
 * P3：agent preset（模式）与工作区（文件夹）
 * ====================================================================== */

/**
 * DSH 内置 preset 的中文名。
 *
 * 来源：`@deepseek-ai/dsh-agent-preset-registry/display` 的 `BUILT_IN_PRESET_KEYS`
 * （内置 preset 自己**不发布** `name`，显示名走 locale 词典），词典里的中文值在
 * app.asar 384549-384556。内置 preset 恰好四个，与 `dsh-web-app/presets/*.patch.yml` 一一对应。
 *
 * 为什么在插件里硬编码一份：词典属于桌面端 UI，宿主的 `agentPresets.list()` 对内置
 * preset 只回 `{ id }`，拿不到显示名。用户自建的 preset 会在 `list()` 里带自己的
 * `name`，那种情况走它自己的名字（见 presetLabel），所以这张表只兜内置的四个。
 */
export const PRESET_NAMES = {
  standard: '标准模式',
  ptc: 'PTC 模式',
  minimal: '极简模式',
  cordis: '创造模式',
}

/**
 * 读取会话**当前生效**的 preset。
 *
 * 坑：`SessionSummary` 顶层的 `cwd`/`agentPreset` 之类字段来自**会话头部**，
 * 那是"创建这一刻"的值；之后切过模式的话头部不会更新。真正生效的值在
 * `projections.values.agentPreset` —— 它的投影定义是
 * `init: header => header.agentPreset`、`apply: 被 agent-preset/selected 事件推进`
 * （app.asar 288032）。
 *
 * 实测教训：本项目一个真实会话头部写着 `standard`、日志 seq 3 是
 * `agent-preset/selected {agentPreset:"cordis"}`，桌面端显示"创造模式"，
 * 而早期版本读头部字段、在手机上显示成了 `standard`。所以这里一律读投影。
 * @param summary - SessionSummary。
 * @returns preset id，或 null。
 */
export function presetOf(summary) {
  const values = summary && summary.projections && summary.projections.values
  if (!values || typeof values !== 'object') return null
  const value = values.agentPreset
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/**
 * preset id → 展示名。
 *
 * 优先级：roster 里该 preset 自己发布的 `name`（用户自建 preset）→ 内置中文表 →
 * 原样回 id（未知 preset 至少还能看出是什么，不显示空白）。
 * @param id - preset id。
 * @param roster - `agentPresets.list()` 的结果（可缺省）。
 * @returns 展示名，或 null（id 为空时）。
 */
export function presetLabel(id, roster) {
  const key = typeof id === 'string' ? id.trim() : ''
  if (!key) return null
  if (Array.isArray(roster)) {
    for (const row of roster) {
      if (!row || row.id !== key) continue
      if (typeof row.name === 'string' && row.name.trim()) return row.name.trim()
      break
    }
  }
  return PRESET_NAMES[key] || key
}

/**
 * 从 cwd 抽出工作区（文件夹）标识。
 *
 * 空 cwd 归到"无工作区"一组（key 为空串），保证它排在最后。
 * key 统一小写：Windows 路径大小写不敏感，`D:\Foo` 与 `d:\foo` 是同一个文件夹，
 * 不归一化会把同一个工作区拆成两组。
 * @param cwd - 会话工作目录。
 * @returns `{ key, name, path }`。
 */
export function workspaceOf(cwd) {
  const raw = typeof cwd === 'string' ? cwd.trim() : ''
  if (!raw) return { key: '', name: '无工作区', path: null }
  const normalized = raw.replace(/[\\/]+$/, '') || raw
  const parts = normalized.split(/[\\/]+/).filter(Boolean)
  const name = parts.length ? parts[parts.length - 1] : normalized
  return { key: normalized.toLowerCase(), name, path: normalized }
}

/**
 * 按工作区把会话分组。
 *
 * 组内会话按 updatedAt 降序；组之间按"组内最新活动"降序；"无工作区"永远排最后
 * （它不是真的工作区，放中间会打断阅读节奏）。
 * @param items - normalizeSummary() 之后的会话行（需已排序，但本函数会再排一次）。
 * @returns 组数组，每组 `{ key, name, path, items, updatedAt, running }`。
 */
export function groupSessions(items) {
  const list = Array.isArray(items) ? items : []
  const groups = new Map()

  for (const item of list) {
    if (!item) continue
    const workspace = workspaceOf(item.cwd)
    let group = groups.get(workspace.key)
    if (!group) {
      group = { key: workspace.key, name: workspace.name, path: workspace.path, items: [], updatedAt: 0, running: false }
      groups.set(workspace.key, group)
    }
    group.items.push(item)
    const updatedAt = Number(item.updatedAt) || 0
    if (updatedAt > group.updatedAt) group.updatedAt = updatedAt
    if (item.running === true) group.running = true
  }

  const out = [...groups.values()]
  for (const group of out) group.items.sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0))
  out.sort((a, b) => {
    // 无工作区垫底；两侧都是"无工作区"时保持稳定（返回 0 而不是 1，否则排序结果依赖实现）
    if (a.key === '' && b.key === '') return 0
    if (a.key === '') return 1
    if (b.key === '') return -1
    return b.updatedAt - a.updatedAt
  })
  return out
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
    // 当前生效的模式。**必须**取投影：顶层的 agentPreset 是会话创建时的值，
    // 切过模式之后就不准了（详见 presetOf 的注释）。
    preset: presetOf(source),
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

    // 会话中途切换模式。快照里的 header.agentPreset 是**创建时**的值，
    // 这条事件才是"现在是什么模式"，下发它前端才能在长连接期间跟上变化。
    case 'agent-preset/selected':
      return { type, seq, time, data: { agentPreset: data.agentPreset ? String(data.agentPreset) : null } }

    // 切换模型。data 就是 ModelSelection（{provider, model, reasoningEffort?}），
    // 与投影 modelSelection.next 同源；下发它，前端在长连接期间也能立刻更新头部芯片。
    case 'model/selection':
      return {
        type,
        seq,
        time,
        data: {
          provider: data.provider ? String(data.provider) : null,
          model: data.model ? String(data.model) : null,
          reasoningEffort: data.reasoningEffort ? String(data.reasoningEffort) : null,
        },
      }

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
  const projections = (frame.projections && frame.projections.values) || {}

  return {
    header: {
      id: header.id ? String(header.id) : null,
      cwd: typeof header.cwd === 'string' ? header.cwd : null,
      createdAt: Number(header.createdAt) || 0,
      // 投影优先：头部那个 agentPreset 是**会话创建时**的值，被
      // `agent-preset/selected` 事件推进后的当前值只存在于投影里。
      // 早期版本只读头部，导致"实际是创造模式、手机显示 standard"。
      agentPreset: (typeof projections.agentPreset === 'string' && projections.agentPreset)
        || header.agentPreset
        || null,
    },
    cursor: typeof frame.cursor === 'number' ? frame.cursor : 0,
    hasMore: frame.hasMore === true,
    records: records.map((record) => projectEvent(eventOf(record))).filter(Boolean),
    projections,
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

/* ========================================================================
 * P3-A：切换模型 / 模式（都是写操作，防护与 /api/prompt 同级）
 * ====================================================================== */

/** 自定义答案的字符上限，与 MAX_TEXT 一致。 */
export const MAX_ANSWER_CHARS = 4000

/**
 * 把 `sessionController.modelCatalog()` 的结果归一化。
 *
 * 上游形状（app.asar 318706）：
 *   { default:{provider,model,reasoningEffort?}, routableProviders:string[],
 *     groups:[{id,name,models:[{id,name,description?,reasoning?:{efforts:[{id,name,description?}],defaultEffort?}}]}],
 *     failures:[{id,name,message}] }
 *
 * 为什么归一化而不是透传：手机端要用它渲染选择面板，字段缺失（比如某个 provider 的
 * `resolveModelInfo` 失败、没有 `name`）会让整块面板出现 undefined。这里把每种缺失
 * 都补上确定的降级值，并把空组过滤掉（与上游 buildModelCatalog 的行为一致）。
 * @param value - modelCatalog() 的原始返回值。
 * @returns 归一化后的目录。
 */
export function normalizeModelCatalog(value) {
  const source = value && typeof value === 'object' ? value : {}
  const text = (input) => (typeof input === 'string' && input.trim() ? input.trim() : null)

  const groups = []
  for (const group of Array.isArray(source.groups) ? source.groups : []) {
    if (!group || typeof group !== 'object') continue
    const models = []
    for (const model of Array.isArray(group.models) ? group.models : []) {
      if (!model || typeof model !== 'object' || !text(model.id)) continue
      const reasoning = model.reasoning && typeof model.reasoning === 'object' ? model.reasoning : null
      const efforts = []
      if (reasoning) {
        for (const effort of Array.isArray(reasoning.efforts) ? reasoning.efforts : []) {
          if (!effort || typeof effort !== 'object' || !text(effort.id)) continue
          const id = text(effort.id)
          efforts.push({ id, name: text(effort.name) || id, description: text(effort.description) })
        }
      }
      const id = text(model.id)
      models.push({
        id,
        name: text(model.name) || id,
        description: text(model.description),
        efforts,
        defaultEffort: reasoning ? text(reasoning.defaultEffort) : null,
      })
    }
    // 空组过滤：上游 buildModelCatalog 也会过滤，这里保持一致，免得面板出现空标题
    if (!models.length) continue
    groups.push({ id: text(group.id) || '', name: text(group.name) || text(group.id) || '其他', models })
  }

  const failures = []
  for (const failure of Array.isArray(source.failures) ? source.failures : []) {
    if (!failure || typeof failure !== 'object') continue
    failures.push({
      id: text(failure.id) || '',
      name: text(failure.name) || text(failure.id) || '未知 provider',
      message: text(failure.message) || '不可用',
    })
  }

  const fallback = source.default && typeof source.default === 'object' ? source.default : {}
  return {
    default: {
      provider: text(fallback.provider),
      model: text(fallback.model),
      reasoningEffort: text(fallback.reasoningEffort),
    },
    routableProviders: (Array.isArray(source.routableProviders) ? source.routableProviders : [])
      .map((item) => text(item))
      .filter(Boolean),
    groups,
    failures,
  }
}

/**
 * 带 TTL 的目录缓存。
 *
 * 为什么必须缓存：`buildModelCatalog()` 对每个 provider 调 `listModels()`、对每个模型
 * 调 `resolveModelInfo()`（app.asar 326486），是若干次上游往返。手机每次进对话页都拉
 * 一次的话，切会话会明显发顿。60 秒足够新（模型列表几乎不变），也避免了并发重复拉取
 * （inflight 复用同一个 Promise）。
 * @param options - ttlMs 缓存时长。
 * @returns `{ get(loader), invalidate(), cached }`。
 */
export function createCatalogCache(options = {}) {
  const ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs >= 0 ? options.ttlMs : 60000
  let entry = null
  let inflight = null
  return {
    /**
     * 取缓存；过期或没有就调用 loader 重新拉一次。
     * @param loader - 返回 Promise 的取数函数。
     * @returns 目录值。
     */
    async get(loader) {
      const now = Date.now()
      if (entry && now - entry.at < ttlMs) return entry.value
      if (inflight) return inflight
      inflight = (async () => {
        try {
          const value = await loader()
          entry = { at: Date.now(), value }
          return value
        } finally {
          inflight = null
        }
      })()
      return inflight
    },
    /** 手动失效（切换成功后调用，保证下一次读到新值）。 */
    invalidate() {
      entry = null
    },
    /** 当前缓存值，没有则 null。 */
    get cached() {
      return entry ? entry.value : null
    },
  }
}

/**
 * 读取模型目录。
 * @param controller - ctx.sessionController。
 * @returns 归一化后的目录。
 */
export async function loadModelCatalog(controller) {
  // modelCatalog() 的 RPC 描述符 parameters 是空数组，没有 signal 参数。
  return normalizeModelCatalog(await controller.modelCatalog())
}

/**
 * 读取模式清单。
 *
 * 用 `agentPresets.list()`（不是 `remoteExportList()`）：前者返回数组、每个内置
 * preset 只有 `{ id, order? }`（显示名走桌面端词典），用户自建的会带 `name`。
 * 这里额外补一个中文 `label`，免得前端还要知道内置 id 的映射表。
 * @param presets - ctx.agentPresets。
 * @returns 模式行数组。
 */
export async function loadPresetRoster(presets) {
  if (!presets || typeof presets.list !== 'function') return []
  const rows = await presets.list()
  const out = []
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== 'object' || typeof row.id !== 'string' || !row.id.trim()) continue
    const id = row.id.trim()
    out.push({
      id,
      label: presetLabel(id, [row]),
      description: typeof row.description === 'string' && row.description.trim() ? row.description.trim() : null,
      broken: typeof row.broken === 'string' && row.broken.trim() ? row.broken.trim() : null,
    })
  }
  return out
}

/** 校验一次切换模型的请求。 */
export function validateModelSwitch(input) {
  const source = input && typeof input === 'object' ? input : {}
  const sessionId = typeof source.sessionId === 'string' ? source.sessionId.trim() : ''
  if (!sessionId) return { error: 'missing-session-id', message: '缺少会话 id' }
  const provider = typeof source.provider === 'string' ? source.provider.trim() : ''
  if (!provider) return { error: 'missing-provider', message: '缺少 provider' }
  const model = typeof source.model === 'string' ? source.model.trim() : ''
  if (!model) return { error: 'missing-model', message: '缺少模型 id' }
  const reasoningEffort = typeof source.reasoningEffort === 'string' && source.reasoningEffort.trim()
    ? source.reasoningEffort.trim()
    : undefined
  return { value: { sessionId, provider, model, reasoningEffort } }
}

/**
 * 切换某个会话的模型。
 *
 * 语义（app.asar 319530 / 326706）：**会话级**选择，对**下一次请求**生效 —— 正在跑的
 * 轮次不受影响，所以运行中调用是安全的。同时宿主会异步把这次选择存成默认值，存失败
 * 只记一条 warning，不影响返回值。
 * @param controller - ctx.sessionController。
 * @param input - `{ sessionId, provider, model, reasoningEffort? }`。
 * @returns `{ ok: true, selected }` 或 `{ ok: false, status, error, message }`。
 */
export async function switchModel(controller, input) {
  const checked = validateModelSwitch(input)
  if (checked.error) return { ok: false, status: 400, error: checked.error, message: checked.message }
  const { sessionId, provider, model, reasoningEffort } = checked.value
  const request = { sessionId, provider, model }
  if (reasoningEffort) request.reasoningEffort = reasoningEffort
  // selectModel 的描述符里没有 cancellation 参数（不像 search），不会踩 signal 那个坑。
  const value = await controller.selectModel(request)
  const selected = value && value.selected && typeof value.selected === 'object' ? value.selected : null
  return {
    ok: true,
    selected: {
      provider: (selected && selected.provider) || provider,
      model: (selected && selected.model) || model,
      reasoningEffort: (selected && selected.reasoningEffort) || reasoningEffort || null,
    },
  }
}

/** 校验一次切换模式的请求。 */
export function validatePresetSwitch(input) {
  const source = input && typeof input === 'object' ? input : {}
  const sessionId = typeof source.sessionId === 'string' ? source.sessionId.trim() : ''
  if (!sessionId) return { error: 'missing-session-id', message: '缺少会话 id' }
  const preset = typeof source.preset === 'string' ? source.preset.trim() : ''
  if (!preset) return { error: 'missing-preset', message: '缺少模式 id' }
  return { value: { sessionId, preset } }
}

/**
 * 切换某个会话的模式。
 *
 * 硬限制（app.asar 288737 `AgentPresetRegistry.select`）：
 *   `if (boundary.openTurnStartSeq !== null || boundary.lastTurn > 0) throw RemoteError('agent-preset/locked', ...)`
 * 也就是**会话一旦跑过至少一轮，模式就锁死了** —— 这是 DSH 的语义（模式决定这一会话
 * 挂哪些插件），不是本插件的限制。所以这里只对"还没开始"的会话放行，其余由路由层
 * 翻成 409 + 明确文案。
 *
 * 另一个坑：`select(agent, preset)` 的第一个参数是 **Agent 对象**（实现里要用
 * agent.id / agent.ctx / agent.session），不是 sessionId。宿主服务是进程内直调，
 * 没有 RPC 那层 `lookup: 'agent'` 的自动解析，所以必须自己用 agents.get() 取活体。
 * @param presets - ctx.agentPresets。
 * @param agents - ctx.agents。
 * @param input - `{ sessionId, preset }`。
 * @returns `{ ok: true, selected }` 或 `{ ok: false, status, error, message }`。
 */
export async function switchPreset(presets, agents, input) {
  const checked = validatePresetSwitch(input)
  if (checked.error) return { ok: false, status: 400, error: checked.error, message: checked.message }
  const { sessionId, preset } = checked.value
  if (!presets || typeof presets.select !== 'function') {
    return { ok: false, status: 503, error: 'preset-service-unavailable', message: '宿主端模式服务不可用' }
  }
  if (!agents || typeof agents.get !== 'function') {
    return { ok: false, status: 503, error: 'agent-service-unavailable', message: '宿主端 agent 服务不可用' }
  }
  const agent = agents.get(sessionId)
  if (!agent) {
    return { ok: false, status: 409, error: 'agent-not-live', message: '这个会话当前没有活动的 agent，暂时无法切换模式' }
  }
  const selected = await presets.select(agent, preset)
  return { ok: true, selected: typeof selected === 'string' && selected ? selected : preset }
}

/* ========================================================================
 * P4：新建会话
 *
 * 宿主那边的门是 `sessionController.create(request)`（app.asar 319530 附近），
 * 签名与类型（asar 1020986）：
 *
 *     SessionCreateRequest  { workspaceId?, cwd?, sessionId?, agentPreset? }
 *     SessionCreateValue    { sessionId, agentPreset? }
 *
 * 文档原话是 "Create or idempotently adopt one ordinary Session" —— 不传 sessionId
 * 就由宿主生成一个。所以这里既不需要自己造 id，也不需要先注册工作区：直接给 cwd 即可。
 *
 * 为什么把"文件夹清单"做成可选依赖：`workspaceRegistry` 只影响**清单里能不能列出
 * 还没建过会话的目录**，不影响建会话本身（cwd 那条路完全独立）。所以它缺了也只是
 * 清单少几个候选，不该让整个功能 503。
 * ====================================================================== */

/** 目录必须是绝对路径 —— 相对路径会落到 DSH 进程的 cwd 上，结果完全不可预期。 */
function isAbsolutePath(value) {
  return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value) || value.charAt(0) === '/'
}

/**
 * 读 DSH 的工作区登记表。
 *
 * 服务缺失或抛错都返回空数组 —— 清单会退化成"只有已有会话的目录"，
 * 但**不影响新建会话**（cwd 那条路完全独立），所以不该让整个接口失败。
 * @param registry - ctx.workspaceRegistry。
 * @returns 工作区实体数组（可能为空）。
 */
export function listRegisteredWorkspaces(registry) {
  if (!registry || typeof registry.list !== 'function') return []
  try {
    const rows = registry.list()
    return Array.isArray(rows) ? rows : []
  } catch {
    return []
  }
}

/**
 * 归一化"能建会话的文件夹"清单。
 *
 * 两个来源合并、按 path 去重：
 *   1. `workspaceRegistry.list()` —— DSH 登记过的工作区（可能还没建过会话）；
 *   2. 已有会话的 cwd —— 覆盖"有会话但没登记工作区"的目录。
 * 登记过的排前面（那是用户自己挑过的），其余沿用会话列表的活动顺序。
 * @param registered - `workspaceRegistry.list()` 的结果，可以是 null/undefined。
 * @param sessions - `normalizeSummary` 之后的会话列表。
 * @returns `[{ id, path, name, title, sessionCount }]`。
 */
export function normalizeWorkspaces(registered, sessions) {
  const rows = Array.isArray(sessions) ? sessions : []
  const seen = new Set()
  const out = []

  function sessionCount(path) {
    let n = 0
    for (const row of rows) if (row && row.cwd === path) n += 1
    return n
  }

  for (const item of Array.isArray(registered) ? registered : []) {
    const path = item && typeof item.path === 'string' ? item.path : ''
    if (!path || seen.has(path)) continue
    seen.add(path)
    const title = typeof item.title === 'string' ? item.title : ''
    out.push({
      id: item && typeof item.id === 'string' ? item.id : '',
      path,
      name: title || workspaceOf(path).name,
      title,
      sessionCount: sessionCount(path),
    })
  }

  for (const row of rows) {
    const path = row && typeof row.cwd === 'string' ? row.cwd : ''
    if (!path || seen.has(path)) continue
    seen.add(path)
    out.push({ id: '', path, name: workspaceOf(path).name, title: '', sessionCount: sessionCount(path) })
  }

  return out
}

/**
 * 校验新建会话的入参。
 * @param input - `{ cwd?, workspaceId?, preset? }`。
 * @returns `{ value }` 或 `{ error, message }`。
 */
export function validateSessionCreate(input) {
  const source = input && typeof input === 'object' ? input : {}
  const cwd = typeof source.cwd === 'string' ? source.cwd.trim() : ''
  const workspaceId = typeof source.workspaceId === 'string' ? source.workspaceId.trim() : ''
  if (!cwd && !workspaceId) return { error: 'missing-location', message: '缺少工作区或目录' }
  if (cwd) {
    if (cwd.length > 4096) return { error: 'path-too-long', message: '目录路径过长' }
    if (!isAbsolutePath(cwd)) return { error: 'path-not-absolute', message: '目录必须是绝对路径' }
  }
  const preset = typeof source.preset === 'string' ? source.preset.trim() : ''
  const value = {}
  if (cwd) value.cwd = cwd
  if (workspaceId) value.workspaceId = workspaceId
  if (preset) value.preset = preset
  return { value }
}

/**
 * 新建一个会话。
 * @param controller - ctx.sessionController。
 * @param input - `{ cwd?, workspaceId?, preset? }`。
 * @returns `{ ok: true, sessionId, preset }` 或 `{ ok: false, status, error, message }`。
 */
export async function createSession(controller, input) {
  const checked = validateSessionCreate(input)
  if (checked.error) return { ok: false, status: 400, error: checked.error, message: checked.message }
  if (!controller || typeof controller.create !== 'function') {
    return { ok: false, status: 503, error: 'session-service-unavailable', message: '宿主端会话服务不可用' }
  }
  const request = {}
  if (checked.value.cwd) request.cwd = checked.value.cwd
  if (checked.value.workspaceId) request.workspaceId = checked.value.workspaceId
  if (checked.value.preset) request.agentPreset = checked.value.preset
  const created = await controller.create(request)
  const sessionId = created && typeof created.sessionId === 'string' ? created.sessionId : ''
  if (!sessionId) {
    return { ok: false, status: 502, error: 'session-create-failed', message: '宿主端没有返回新会话 id' }
  }
  const preset = created && typeof created.agentPreset === 'string' ? created.agentPreset : ''
  return { ok: true, sessionId, preset: preset || null }
}

/* ========================================================================
 * P3-D：把 agent 的提问转给手机，并把答案送回宿主
 *
 * 背景（这一段是整个功能里最需要解释的部分）：
 *
 * `ask_user_question` 走的是 `ctx.userQuestions.ask()`，它把一个 Cordis **waterfall**
 * 事件 `user-questions/request` 派发给所有 answerer（app.asar 1057439）：
 *
 *     ctx.waterfall(scopeTarget(agent, agent), 'user-questions/request', {...request, agent}, noAnswerer)
 *
 * 桌面 GUI 自己就是通过 Remote 转发层注册的一个 answerer（asar 321570），它一旦认出
 * 作用域里的 agent 就**接管**问题、不再调用 `next()`。所以插件必须**排在它前面**才有机会
 * 参与 —— 用 `ctx.on(event, listener, { prepend: true })`（Cordis 的 register 会 unshift，
 * asar 275014）。
 *
 * 为什么不走 `userQuestions.answer()`：那条路只处理 `state === 'continued'` 的问题
 * （asar 1057312 `this.continued(agent).find(...)`），而 `continued` 只在 **timed 模式**
 * 的倒计时超时之后才出现。本部署是阻塞模式（工具 schema 里没有 `timeout` 字段，
 * 见 `isTimedAskUserQuestionSchema`），投影根本不记录 active 问题，`answer()` 会静默
 * 返回 false。所以只能用 answerer 这条路。
 *
 * 并发语义：手机与桌面**都能看到**同一个问题，谁先答谁生效。这是官方支持的场景 ——
 * 文档明确写了"另一个浏览器先结算时，迟到的结果会被网关静默丢弃"。
 * ====================================================================== */

/**
 * 校验一组答案。
 *
 * 上游要求（`AskUserQuestionAnswer`）：每个问题的 id 恰好出现一次。
 * 这里额外要求"要么选了选项、要么填了自定义答案"，否则提交一个全空的答案对用户
 * 毫无意义（桌面端把"跳过"表达为空 selected 的独立结果，不走这个入口）。
 * @param input - `{ answers: [{ id, selected, custom? }] }`。
 * @param questions - 这次提问的题目列表。
 * @returns `{ value: { answers } }` 或 `{ error, message }`。
 */
export function validateAnswers(input, questions) {
  const source = input && typeof input === 'object' ? input : {}
  if (!Array.isArray(source.answers)) return { error: 'bad-answers', message: 'answers 必须是数组' }

  const expected = new Set()
  for (const question of Array.isArray(questions) ? questions : []) {
    if (question && typeof question.id === 'string' && question.id) expected.add(question.id)
  }
  if (expected.size === 0) return { error: 'no-questions', message: '这个问题没有可回答的题目' }
  if (source.answers.length !== expected.size) {
    return { error: 'bad-answers', message: `需要为 ${expected.size} 道题各给一个答案，收到 ${source.answers.length} 个` }
  }

  const out = []
  const seen = new Set()
  for (const item of source.answers) {
    if (!item || typeof item !== 'object') return { error: 'bad-answers', message: '答案格式不正确' }
    const id = typeof item.id === 'string' ? item.id : ''
    if (!id || !expected.has(id)) return { error: 'bad-answers', message: `答案里的题目 id 不匹配：${id || '(空)'}` }
    if (seen.has(id)) return { error: 'bad-answers', message: `题目 ${id} 给了多个答案` }
    seen.add(id)

    const selected = []
    if (Array.isArray(item.selected)) {
      for (const label of item.selected) {
        if (typeof label === 'string' && label.trim()) selected.push(label.trim())
      }
    }
    let custom
    if (typeof item.custom === 'string' && item.custom.trim()) {
      if (item.custom.length > MAX_ANSWER_CHARS) {
        return { error: 'answer-too-long', message: `自定义答案太长（上限 ${MAX_ANSWER_CHARS} 字符）` }
      }
      custom = item.custom
    }
    if (!selected.length && custom === undefined) {
      return { error: 'empty-answer', message: `题目 ${id} 既没选选项、也没填自定义答案` }
    }
    out.push(custom === undefined ? { id, selected } : { id, selected, custom })
  }
  return { value: { answers: out } }
}

/**
 * 待回答问题中心。
 *
 * 它是宿主（answerer）与 HTTP 层（路由 / SSE）之间的唯一共享状态：
 *   - answerer 注册一个问题并 await 它的 promise；
 *   - 手机通过 HTTP 提交答案，或宿主侧因为桌面先答而"结算"掉它；
 *   - 订阅者（SSE）负责把变化推给手机。
 * @param options - maxPending 同时在等的问题数上限。
 * @returns 句柄：register / answer / settle / list / subscribe。
 */
export function createQuestionHub(options = {}) {
  const maxPending = Number.isFinite(options.maxPending) && options.maxPending > 0 ? options.maxPending : 20
  const pending = new Map()
  const listeners = new Set()
  let counter = 0

  /** 摘掉计时器与 abort 监听，避免长跑进程里堆积。 */
  function detach(entry) {
    if (entry.timer) {
      clearTimeout(entry.timer)
      entry.timer = null
    }
    if (entry.signal && entry.onAbort) {
      try { entry.signal.removeEventListener('abort', entry.onAbort) } catch { /* 忽略 */ }
      entry.onAbort = null
    }
  }

  /** 从待答表里移除，并拒绝它的 promise。 */
  function drop(id, reason) {
    const entry = pending.get(id)
    if (!entry) return false
    pending.delete(id)
    detach(entry)
    if (!entry.settled) {
      entry.settled = true
      entry.reject(reason || new Error('question dropped'))
    }
    return true
  }

  /**
   * 从待答表里移除，并把 promise **resolve 成 null**（"这条路径退场了"）。
   *
   * 与 drop 的区别很关键：drop 用于轮次中止（应该让整条 waterfall 失败），
   * settleEntry 用于"别处已经定夺"（桌面先答、超额淘汰）—— 这时不该产生
   * rejection，否则会变成未处理的 Promise 拒绝，或者把本来正常的提问带崩。
   */
  function settleEntry(id, outcome) {
    const entry = pending.get(id)
    if (!entry) return false
    pending.delete(id)
    detach(entry)
    if (!entry.settled) {
      entry.settled = true
      entry.resolve(null)
    }
    notify({ e: 'question-settled', d: { id, sessionId: entry.sessionId, outcome } })
    return true
  }

  /** 通知订阅者。单个订阅者出错不能影响别人。 */
  function notify(frame) {
    for (const listener of [...listeners]) {
      try { listener(frame) } catch { /* 忽略 */ }
    }
  }

  /** 下发给手机的公开视图（不含 resolve/reject 这些内部字段）。 */
  function view(entry) {
    return {
      id: entry.id,
      sessionId: entry.sessionId,
      callId: entry.callId,
      createdAt: entry.createdAt,
      questions: entry.questions,
    }
  }

  return {
    /**
     * 登记一个问题并等待答案。
     * @param sessionId - 所属会话。
     * @param questions - 题目列表。
     * @param signal - 该请求的取消信号（轮次被中止时用来落定）。
     * @param callId - 上游工具调用 id，仅用于展示与关联。
     * @returns `{ id, promise }`。
     */
    register(sessionId, questions, signal, callId) {
      counter += 1
      const id = `q${Date.now().toString(36)}-${counter.toString(36)}`
      let resolveFn = null
      let rejectFn = null
      const promise = new Promise((resolve, reject) => {
        resolveFn = resolve
        rejectFn = reject
      })
      const entry = {
        id,
        sessionId: String(sessionId || ''),
        callId: callId ? String(callId) : null,
        questions: Array.isArray(questions) ? questions : [],
        createdAt: Date.now(),
        settled: false,
        resolve: resolveFn,
        reject: rejectFn,
        signal: signal || null,
        onAbort: null,
        timer: null,
      }

      // 轮次被中止：落定它，让 waterfall 两侧都能干净退出
      if (signal && typeof signal.addEventListener === 'function') {
        entry.onAbort = () => {
          const error = new Error('question aborted')
          error.name = 'AbortError'
          if (drop(id, error)) notify({ e: 'question-settled', d: { id, sessionId: entry.sessionId, outcome: 'aborted' } })
        }
        try { signal.addEventListener('abort', entry.onAbort, { once: true }) } catch { entry.onAbort = null }
      }

      pending.set(id, entry)
      // 超额淘汰最老的：问题本来就该及时处理，堆着说明手机侧早就不看了。
      // 用 settleEntry 而不是 drop —— 淘汰是"这条路径退场"，不是失败，
      // 让对应的 waterfall 调用回到桌面那条路径去定夺。
      while (pending.size > maxPending) {
        const oldest = pending.keys().next().value
        if (oldest === undefined || oldest === id) break
        settleEntry(oldest, 'dropped')
      }

      notify({ e: 'question', d: view(entry) })
      return { id, promise }
    },

    /**
     * 用手机提交的答案结算一个问题。
     * @param input - `{ questionId, answers }`。
     * @returns `{ ok: true, answers }` 或 `{ ok: false, status, error, message }`。
     */
    answer(input) {
      const source = input && typeof input === 'object' ? input : {}
      const id = typeof source.questionId === 'string' ? source.questionId.trim() : ''
      if (!id) return { ok: false, status: 400, error: 'missing-question-id', message: '缺少问题 id' }
      const entry = pending.get(id)
      if (!entry) return { ok: false, status: 404, error: 'question-not-found', message: '这个问题已经结束或不存在' }
      if (entry.settled) return { ok: false, status: 409, error: 'question-settled', message: '这个问题已经被回答过了' }

      const checked = validateAnswers(source, entry.questions)
      if (checked.error) return { ok: false, status: 400, error: checked.error, message: checked.message }

      entry.settled = true
      pending.delete(id)
      detach(entry)
      entry.resolve(checked.value)
      notify({ e: 'question-settled', d: { id, sessionId: entry.sessionId, outcome: 'answered' } })
      return { ok: true, answers: checked.value.answers }
    },

    /**
     * 由别处（桌面先答 / 请求结束）结算：通知手机收起卡片。
     * 用 resolve(null) 而不是 reject —— 这时 waterfall 的结果已经由桌面那条路径决定，
     * 手机这条路径只是需要干净地退场，不该产生未处理的 rejection。
     * @param id - 问题 id。
     * @returns 是否命中。
     */
    settle(id) {
      return settleEntry(id, 'elsewhere')
    },

    /**
     * 待答问题列表（可选按会话过滤）。
     * @param sessionId - 会话 id；省略则返回全部。
     * @returns 公开视图数组。
     */
    list(sessionId) {
      const out = []
      for (const entry of pending.values()) {
        if (sessionId && entry.sessionId !== sessionId) continue
        out.push(view(entry))
      }
      return out
    },

    /**
     * 订阅问题变化。
     * @param listener - 收到 `{ e, d }` 帧。
     * @returns 取消订阅函数。
     */
    subscribe(listener) {
      if (typeof listener !== 'function') return () => {}
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },

    /** 当前待答数量，用于诊断。 */
    get size() {
      return pending.size
    },
  }
}

/**
 * 把一次 `user-questions/request` waterfall 调用接到手机上。
 *
 * 与桌面**并存**：`next()` 照常调用（桌面 GUI 的 answerer 会接管并显示卡片），
 * 同时把问题推给手机。两边谁先答谁生效 —— 官方支持这种并发，文档明确写了
 * "另一个浏览器先结算时，迟到的结果会被网关静默丢弃"。
 *
 * 为什么必须 prepend 注册：Remote 转发层那个 answerer 认出作用域里的 agent 之后
 * **不再调用 next()**（app.asar 321570），排在它后面就永远不会被执行。
 *
 * 失败安全：任何一个环节出问题都退回 `next()` 那条路径，绝不影响现有功能。
 * @param hub - createQuestionHub() 的句柄。
 * @param options - log 日志函数。
 * @returns `(request, next) => Promise<answer>`。
 */
export function createQuestionAnswerer(hub, options = {}) {
  const log = options.log || (() => {})
  return function answerer(request, next) {
    if (!hub) return next()
    const agent = request && request.agent
    const questions = request && Array.isArray(request.questions) ? request.questions : []
    // 没有 agent 的请求不归这里管（与 Remote 转发器同一判据）
    if (!agent || !agent.id || !questions.length) return next()

    // 先同步调用 next()：桌面的问题卡片要立刻出现，不能被我们拖慢。
    // 注意 next() 可能同步抛（Remote 转发器在 agent 与作用域不匹配时会 throw），
    // 所以必须包起来 —— 那种情况下手机这条路反而成了唯一能答的路径。
    let desktop
    try {
      desktop = Promise.resolve(next())
    } catch (err) {
      desktop = Promise.reject(err)
    }

    const callId = request.wait && request.wait.callId ? request.wait.callId : null
    const entry = hub.register(agent.id, questions, request.signal, callId)
    log(`[mobile-mirror] 收到提问（会话 ${agent.id}，${questions.length} 道题），已推给手机`)

    const viaPhone = entry.promise.then((answer) => ({ from: 'phone', answer }))
    const viaDesktop = desktop.then(
      (answer) => ({ from: 'desktop', answer }),
      (err) => ({ from: 'desktop-error', err }),
    )

    return Promise.race([viaPhone, viaDesktop]).then((winner) => {
      if (winner.from === 'desktop') {
        // 桌面先答：让手机把卡片收起来，并沿用桌面的答案
        hub.settle(entry.id)
        return winner.answer
      }
      if (winner.from === 'desktop-error') {
        // 桌面这条路走不通（桌面 GUI 没开着、没有连接的客户端……）。
        // 只要手机这边还挂着就继续等它 —— 否则就把桌面的错误原样抛出去，
        // 保持"没有 answerer 时报错"的原有语义。
        return entry.promise.then((answer) => {
          if (answer) return answer
          throw winner.err
        })
      }
      if (winner.answer) {
        log(`[mobile-mirror] 手机端已作答（会话 ${agent.id}）`)
        return winner.answer
      }
      // 手机这条路径退场（桌面已答 / 超额淘汰）而没有答案：交给桌面那条路径定夺
      return desktop
    })
  }
}
