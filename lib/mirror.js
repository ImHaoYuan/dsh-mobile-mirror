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

/**
 * 单个文本块的字符上限。
 *
 * 这个值**不是**用来"省流量"的，只是一道病态数据的保命阀：它曾经是 4000，
 * 结果正常的长回答、长思考过程在手机上被硬生生截断（末尾挂一句"已截断"），
 * 而用户根本没有别的途径看到剩下的内容 —— 那是我方凭空制造的损失，
 * 不是带宽换来的收益。现在提到 100000：正常聊天（哪怕一口气几千字）
 * 永远不会碰到，只有真的病态（整篇文件塞进一条消息）才兜一下。
 */
const MAX_TEXT = 100000

/**
 * 工具参数的字符上限。
 * 同上：2000 会把 `write` 的整段内容截掉，提到 20000 只留保命作用。
 */
const MAX_ARGS = 20000

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
 * `data.source.kind` 里唯一代表"真人输入"的值。其余都是 DSH 程序化注入的。
 */
const USER_SOURCE_KIND = 'user'

/**
 * 判断一条 `user/message` 是不是 DSH 注入的（而非真人打的）。
 *
 * DSH 把注入内容也塞进 `user/message`，只能靠 `data.source.kind` 区分。
 * 实测到的 kind（取自真实会话日志 `session.v4.jsonl.zstd`）：
 *
 * | kind                 | 内容                                        |
 * |----------------------|---------------------------------------------|
 * | `user`               | 真人输入 —— **唯一该显示的**                |
 * | `agent-instructions` | AGENTS.md / CLAUDE.md 等指令文件            |
 * | `runtime-context`    | "Current runtime context…"                  |
 * | `skill-catalog`      | 技能目录                                    |
 * | `user-approval`      | 审批策略变更通知（机器产生，也不是真人输入）|
 *
 * 后四种每轮都会重放一遍，合计几千字节英文，对"看对话"毫无价值。
 *
 * **fail-safe 方向**：取不到 `source` 或 `kind` 时返回 `false`（当真人消息处理）。
 * 宁可多显示一条注入消息，也绝不能吞掉用户自己说的话。
 *
 * 刻意用白名单（只认 `user`）而不是黑名单：`source.kind` 表达的是**来源**，
 * `user` 是唯一意味着"人打的"的来源。将来 DSH 新增注入类型时，默认也会被隐藏，
 * 不会又冒出来一堆噪音。
 *
 * @param data - `user/message` 事件的 data。
 * @returns 是注入消息（应丢弃）返回 true。
 */
export function isInjectedUserMessage(data) {
  if (!data || typeof data !== 'object') return false
  const source = data.source
  if (!source || typeof source !== 'object') return false
  const kind = typeof source.kind === 'string' ? source.kind : ''
  if (!kind) return false
  return kind !== USER_SOURCE_KIND
}

/**
 * 整块被 `<system-reminder>…</system-reminder>` 包住的文本。
 *
 * 这是 DSH 标记"这块是注入的"的写法。之所以还要额外认它，是因为有一种情况
 * `source.kind` 帮不上忙：**子代理（teammate）的启动提示**。对那个子会话来说，
 * 它的 prompt 就是"用户输入"，所以 `kind` 是 `user`；但内容其实是两个块 ——
 * 第 0 块是 `<system-reminder>You are teammate "xxx"…`，第 1 块才是真正的任务书。
 * 整条丢掉会把任务书也丢了，所以只能按块剥。
 */
const SYSTEM_REMINDER_RE = /^\s*<system-reminder>[\s\S]*<\/system-reminder>\s*$/

/**
 * 剥掉纯注入的文本块（只动整块就是 `<system-reminder>` 的那种）。
 *
 * 刻意要求**首尾都被包住**才剥：只在开头出现（正文跟在后面）的块保持原样，
 * 免得把"引用了一段 reminder 然后接着说正事"的内容误伤。
 *
 * @param blocks - `projectBlocks` 的输出。
 * @returns 过滤后的新数组（输入不是数组时原样返回）。
 */
export function stripInjectedBlocks(blocks) {
  if (!Array.isArray(blocks)) return blocks
  return blocks.filter((b) => !(b && b.type === 'text' && typeof b.text === 'string' && SYSTEM_REMINDER_RE.test(b.text)))
}

/** `deliverables/presented` 最多下发几个文件、路径与说明各留多长。 */
const MAX_DELIVERABLES = 20
const MAX_DELIVERABLE_PATH = 512
const MAX_DELIVERABLE_DESC = 200

/**
 * 把一个持久事件投影成手机页需要的形状。
 *
 * 返回 null 表示这个事件**不需要下发**：要么纯冗余（`assistant/attempt`），
 * 要么是手机上刻意不显示的内容（注入的 `user/message`、系统提示、开发者消息）。
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

    case 'turn/end': {
      // reason 是个判别联合（TurnEndReason）：
      //   completed / blocked / max-tokens / interrupted / forked —— 只有 kind
      //   aborted —— 额外带 reason: TurnEndCancelCause
      //   error   —— 额外带 error: LlmFailure { message, code, status?, … }
      //
      // 曾经这里只留 reason.kind，于是 DSH 报「本轮运行失败：API 密钥无效」时，
      // 手机上只显示一句「本轮出错」，**真正的错误正文被这一行丢掉了**。
      const reason = data.reason && typeof data.reason === 'object' ? data.reason : {}
      const out = { turn: data.turn, reason: reason.kind || 'unknown' }
      const failure = reason.error
      if (failure && typeof failure === 'object') {
        // 只挑这三个字段：LlmFailure 里还有 providerRetryAfterMs / requestId /
        // offloadImages，手机上用不到，整包透传只是白占带宽。
        out.error = {
          message: typeof failure.message === 'string' ? failure.message : '',
          code: typeof failure.code === 'string' ? failure.code : '',
          status: typeof failure.status === 'number' ? failure.status : null,
        }
      }
      return { type, seq, time, data: out }
    }

    case 'step/start':
    case 'step/end':
      return { type, seq, time, data: { turn: data.turn, step: data.step } }

    case 'user/message': {
      // 注入内容也是以 user/message 送进来的（AGENTS.md 指令、运行时上下文、
      // 技能目录、审批策略通知），靠 data.source.kind 区分，见 isInjectedUserMessage。
      if (isInjectedUserMessage(data)) return null
      const rawBlocks = projectBlocks(contentOf(data))
      const blocks = stripInjectedBlocks(rawBlocks)
      // 整条都是 <system-reminder>（剥完什么都不剩）→ 连空气泡都不要。
      // 但"本来就没有文本块"的消息照旧下发 —— 那是真人发的（比如只带附件）。
      if (rawBlocks.length > 0 && blocks.length === 0) return null
      return {
        type, seq, time,
        data: { role: 'user', id: data.id ? String(data.id) : null, blocks },
      }
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

    // 「把文件挂在回复结尾」—— 电脑端靠的就是这个事件（`present` 工具）。
    //
    // 它落到 default 分支时，"有界浅拷贝"会把 files 数组压成 `[array]`，**路径与说明全丢**，
    // 于是手机端既没数据也没渲染（用户看到的"电脑端有、手机端没有"）。必须显式处理。
    case 'deliverables/presented': {
      const raw = Array.isArray(data.files) ? data.files : []
      const files = []
      for (const f of raw) {
        if (!f || typeof f !== 'object') continue
        const p = typeof f.path === 'string' ? f.path.trim() : ''
        if (!p) continue
        files.push({
          path: p.slice(0, MAX_DELIVERABLE_PATH),
          description: typeof f.description === 'string'
            ? f.description.trim().slice(0, MAX_DELIVERABLE_DESC)
            : '',
        })
        if (files.length >= MAX_DELIVERABLES) break
      }
      // 空清单整条不下发：没有文件的 present 不该在会话里留一行空气
      if (files.length === 0) return null
      return { type, seq, time, data: { turn: data.turn, files } }
    }

    // 系统提示 / 开发者消息：内容极长且对"看对话"没有价值 —— 整个丢掉。
    //
    // 早先的版本是下发一行"已省略"标记，但那行标记本身也是噪音：手机上要的是
    // "谁说了什么"，不是"这里有一段你没看到的东西"。会话里最终只剩三类：
    // 真人消息、助手回复、工具调用。
    case 'system/message':
    case 'developer/message':
      return null

    // assistant/attempt 与 assistant/message 内容重复，且额外携带一份 stream 原始记录 —— 丢弃。
    case 'assistant/attempt':
      return null

    default:
      // 未知类型：只下发类型与序号，让调试视图能看见"这里有个没处理的事件"，
      // 但不把可能很大的 data 原样透传出去 —— 换成一份**有界的浅拷贝**（见下）。
      return { type, seq, time, data: safeUnknownData(data), unknown: true }
  }
}

/** 未知事件的 data 最多抄多少个键、总共多少字符。 */
const UNKNOWN_DATA_MAX_KEYS = 24
const UNKNOWN_DATA_MAX_CHARS = 512
/** 单个字符串值最长多少字符。 */
const UNKNOWN_DATA_MAX_STRING = 120

/**
 * 给**未知事件**的 data 做一份有界的浅拷贝。
 *
 * 为什么值得做：排查「手机上不显示错误」时，我是靠逆向 `app.asar` 才知道错误正文
 * 藏在 `turn/end` 的 `reason.error` 里。如果当初网页端能看到未接事件的字段名，
 * 这一步会快得多 —— 未接事件的字段本身就是最好的线索。
 *
 * 三条边界，缺一不可：
 * - **只抄一层**：嵌套对象 / 数组只报形状（`[object]` / `[array]`），不递归；
 * - **只抄原始值**：函数、Symbol、循环引用一律不进；
 * - **总长封顶**：键数与字符数都封顶，防止某个事件带上整个消息体把带宽吃光。
 *
 * @param data - 原始事件 data。
 * @returns 浅拷贝，或 null（没有可用内容时）。
 */
function safeUnknownData(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  const out = {}
  let chars = 0
  let count = 0
  for (const key of Object.keys(data)) {
    if (count >= UNKNOWN_DATA_MAX_KEYS || chars >= UNKNOWN_DATA_MAX_CHARS) break
    const value = data[key]
    let safe
    if (value === null || typeof value === 'boolean' || typeof value === 'number') {
      safe = value
    } else if (typeof value === 'string') {
      safe = value.length > UNKNOWN_DATA_MAX_STRING ? `${value.slice(0, UNKNOWN_DATA_MAX_STRING)}…` : value
    } else if (Array.isArray(value)) {
      safe = `[array ${value.length}]`
    } else if (value && typeof value === 'object') {
      safe = '[object]'
    } else {
      continue
    }
    out[key] = safe
    chars += key.length + String(safe).length
    count += 1
  }
  return count > 0 ? out : null
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
 * 关于 `throughSeq` / `beforeSeq`：宿主 `paginate()` 里
 * `end = min(throughSeq + 1, beforeSeq ?? throughSeq + 1)`，**`throughSeq` 是读取上界**。
 * 两者都传 `beforeSeq` 时 `end = beforeSeq`，正好是"严格早于当前最早那条"的那一页。
 *
 * 1.3.2 曾把 `throughSeq` 传成 -1（误以为 -1 表示"会话头"）—— 实际 `end = min(0, beforeSeq) = 0`，
 * `slice(cut, 0)` 恒为空、`hasMore` 恒为 false：手机端"往上翻不报错，也永远不出内容"。
 * 校验只保证 `throughSeq >= -1`，它并不是"无上界"的哨兵值。
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

/**
 * 单条消息的字符上限。
 * 与 `lib/web/app.js` 的 `PROMPT_MAX` **必须一致** —— 两边各判一次，
 * 不一致就会出现"手机上打得出来、服务端拒收"这种最难查的组合。
 * 测试里有一条断言钉住这一点。
 */
export const MAX_PROMPT_CHARS = 100000

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

/**
 * 自定义答案的字符上限。
 * 同样从 4000 提到 20000：手机上手打一段长回答是完全正常的事，
 * 原来那个值会把"说清楚"和"发得出去"对立起来。
 */
export const MAX_ANSWER_CHARS = 20000

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
  const log = typeof options.log === 'function' ? options.log : () => {}
  // 最后一个订阅者断开后，宽限这么久再释放认领 —— 页面刷新会让 SSE 短暂断开，
  // 立刻释放等于把已经过了 deadline 的问题当场判超时。
  const holdGraceMs = Number.isFinite(options.holdGraceMs) && options.holdGraceMs >= 0 ? options.holdGraceMs : 3000
  const pending = new Map()
  const listeners = new Set()
  let counter = 0
  // 认领等待的实现由外部注入（宿主侧是 ctx.userQuestions.attachWait）。
  // hub 自己不认识 DSH，只负责"谁在等、谁还挂着"——单测因此不需要真宿主。
  let waitAttacher = typeof options.attachWait === 'function' ? options.attachWait : null
  let holdReleaseTimer = null

  /**
   * 摘掉计时器与 abort 监听，避免长跑进程里堆积。
   * 认领也要在这里释放：条目一旦离开待答表，计时权必须还给宿主。
   */
  function detach(entry) {
    if (entry.timer) {
      clearTimeout(entry.timer)
      entry.timer = null
    }
    if (entry.signal && entry.onAbort) {
      try { entry.signal.removeEventListener('abort', entry.onAbort) } catch { /* 忽略 */ }
      entry.onAbort = null
    }
    entry.held = false
    releaseClaim(entry)
  }

  /**
   * 释放一次等待认领，把计时权还给宿主。
   *
   * 认领期间宿主**不跑自己的倒计时**（TimedQuestionWait.schedule 在 claims.size>0 时直接返回），
   * 所以"释放"就是让宿主重新计时：deadline 已过的话它会立刻放行模型，
   * 与"从来没人认领"的结局完全一致。
   * @param entry - 待答条目。
   * @returns 是否真的释放了。
   */
  function releaseClaim(entry) {
    if (!entry || typeof entry.release !== 'function') return false
    const release = entry.release
    entry.release = null
    try { release() } catch { /* 认领方出错不能反过来影响提问 */ }
    return true
  }

  /**
   * 认领等待：手机正在看着这张卡片期间，别让宿主超时。
   *
   * **只对限时提问有意义**（`request.wait.timed === true`，即 `tool-ask-user` 配成
   * `mode: timed` 且这次调用带正数 timeout）。限时提问没有任何回答界面认领时，
   * 到点宿主直接放行模型 → 工具返回 pending → 问题进入 continued；此后作答会走
   * "迟到回复"那条路（steer 一条用户消息），结果是"答案被暂存 + agent 又跑一轮"。
   * 手机认领之后，宿主不再自己计时，手机上看多久都不会超时。
   *
   * 注意：认领**只挡住宿主那个计时器**。桌面端自己的倒计时仍然会到点 reject
   * （见 dsh-client-ui-user-questions 的 claim），所以真正救的是"桌面 GUI 没开 /
   * 没有别的回答界面"这种只有手机在看的场合 —— 而那正是这个插件的存在意义。
   *
   * 失败一律降级：认领不了就退回"不认领"的旧行为，绝不把提问本身搞坏。
   * @param entry - 待答条目。
   * @returns 是否发起了认领。
   */
  function startClaim(entry) {
    if (entry.release || !waitAttacher || !entry.wait || entry.wait.timed !== true) return false
    if (!entry.agent || !entry.wait.callId) return false
    const controller = new AbortController()
    entry.release = () => { try { controller.abort() } catch { /* 忽略 */ } }
    const id = entry.id
    const sessionId = entry.sessionId
    Promise.resolve()
      .then(() => waitAttacher(entry.agent, entry.wait.callId, controller.signal))
      .then(async (stream) => {
        // attachWait 是 async generator；拿不到就说明这次等待已经结束了
        if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') return
        let announced = false
        try {
          for await (const frame of stream) {
            if (controller.signal.aborted) break
            const remainingMs = frame && Number.isFinite(frame.remainingMs) ? frame.remainingMs : null
            announced = true
            notify({ e: 'question-hold', d: { id, sessionId, held: true, remainingMs } })
          }
        } finally {
          if (announced) notify({ e: 'question-hold', d: { id, sessionId, held: false } })
        }
      })
      .catch((err) => {
        log(`[mobile-mirror] 认领提问等待失败，退回宿主计时：${err && err.message}`)
      })
    return true
  }

  /** 释放所有仍被认领的等待（手机侧全断了）。 */
  function releaseAllHolds() {
    for (const entry of [...pending.values()]) {
      if (!entry.held) continue
      entry.held = false
      releaseClaim(entry)
      notify({ e: 'question-hold', d: { id: entry.id, sessionId: entry.sessionId, held: false } })
    }
  }

  /** 取消待执行的释放（又有人连上来了）。 */
  function cancelHoldRelease() {
    if (!holdReleaseTimer) return
    clearTimeout(holdReleaseTimer)
    holdReleaseTimer = null
  }

  /** 订阅者清零 → 宽限期后释放全部认领。 */
  function scheduleHoldRelease() {
    cancelHoldRelease()
    if (holdGraceMs <= 0) return releaseAllHolds()
    holdReleaseTimer = setTimeout(() => {
      holdReleaseTimer = null
      releaseAllHolds()
    }, holdGraceMs)
    // 别让这个宽限定时器拖住进程退出
    if (holdReleaseTimer && typeof holdReleaseTimer.unref === 'function') holdReleaseTimer.unref()
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
     * @param meta - `{ agent, wait }`：认领宿主等待所需的信息（可选）。
     * @returns `{ id, promise }`。
     */
    register(sessionId, questions, signal, callId, meta) {
      counter += 1
      const id = `q${Date.now().toString(36)}-${counter.toString(36)}`
      let resolveFn = null
      let rejectFn = null
      const promise = new Promise((resolve, reject) => {
        resolveFn = resolve
        rejectFn = reject
      })
      const extra = meta && typeof meta === 'object' ? meta : {}
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
        // 认领宿主等待用的信息。缺任何一项都只是"不认领"，不影响提问本身。
        agent: extra.agent || null,
        wait: extra.wait && extra.wait.timed === true ? extra.wait : null,
        held: false,
        release: null,
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
     * 手机声明"我正看着这张卡片"（或不再看了）。
     *
     * 认领成功 = 宿主不再跑自己的倒计时，手机上作答永远不会变成"迟到回复"；
     * 不再看/页面断开就立刻释放，让宿主按原 deadline 决定，不会把 agent 卡住。
     * @param id - 问题 id。
     * @param on - true 认领，false 释放。
     * @returns `{ ok, held, claimed }` 或 `{ ok:false, status, error, message }`。
     */
    hold(id, on) {
      const entry = pending.get(id)
      if (!entry) return { ok: false, status: 404, error: 'question-not-found', message: '这个问题已经结束或不存在' }
      if (on === true) {
        if (entry.held) return { ok: true, held: true, claimed: typeof entry.release === 'function' }
        entry.held = true
        cancelHoldRelease()
        const claimed = startClaim(entry)
        return { ok: true, held: true, claimed }
      }
      if (!entry.held) return { ok: true, held: false, claimed: false }
      entry.held = false
      releaseClaim(entry)
      return { ok: true, held: false, claimed: false }
    },

    /**
     * 注入"认领宿主等待"的实现（宿主侧是 `ctx.userQuestions.attachWait`）。
     * 拿不到就传 null：一切退回"不认领"的旧行为，提问本身照常工作。
     * @param fn - `(agent, callId, signal) => AsyncIterable<{remainingMs}>`。
     */
    setWaitAttacher(fn) {
      waitAttacher = typeof fn === 'function' ? fn : null
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
      cancelHoldRelease()
      return () => {
        listeners.delete(listener)
        // 手机侧全断了（页面关掉、切走、断网）：宽限期后把认领全放掉，
        // 否则宿主会一直等一个没人看的卡片，agent 就真的卡死了。
        if (listeners.size === 0) scheduleHoldRelease()
      }
    },

    /** 当前订阅者数量（诊断与测试用）。 */
    get subscribers() {
      return listeners.size
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
 * @param options - log 日志函数；attachWait 认领宿主等待的实现（可选）。
 * @returns `(request, next) => Promise<answer>`。
 */
export function createQuestionAnswerer(hub, options = {}) {
  const log = options.log || (() => {})
  // 认领宿主等待的能力由宿主侧注入（`ctx.userQuestions.attachWait`）。
  // 注入失败/拿不到服务时只是不认领，行为与改造前一致。
  if (hub && typeof hub.setWaitAttacher === 'function') {
    hub.setWaitAttacher(typeof options.attachWait === 'function' ? options.attachWait : null)
  }
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
    // 限时提问（askTimed）才需要认领：认领期间宿主不跑自己的倒计时，
    // 手机就能从容作答而不会掉进"迟到回复 → 又跑一轮"。
    // 默认配置（`tool-ask-user` 的 `mode: legacy`）下没有限时等待，这里为 null，一切照旧。
    const wait = request.wait && request.wait.timed === true && callId ? { callId, timed: true } : null
    const entry = hub.register(agent.id, questions, request.signal, callId, { agent, wait })
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
