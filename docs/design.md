# dsh-mobile-mirror · 设计说明

> 这是**为什么这么做**的那一半。使用与安装请看 [README](../README.md)。

---

## 为什么是独立端口

DSH 自己的 Web 服务监听 `127.0.0.1:19387`（仅本机）。把它的 `host` 改成 `0.0.0.0`
虽然一行配置就能让手机打开完整 GUI，但那等于把**整个 GUI 和全部 /api 暴露到局域网**。

本插件换一条路：自己起一个只服务手机页面的小 HTTPS 服务（默认 `0.0.0.0:19388`），
只放行手机页面需要的接口，自带独立凭据。桌面 GUI 与 `/api` 的暴露面保持不变，
关掉插件就彻底消失。

## 为什么有 HTTPS

局域网明文 HTTP 下，同一个 Wi-Fi 里任何能抓包的人都能拿到你的密码。
所以默认走 TLS。

证书是**现场签发的自签证书**，不依赖 openssl、不引第三方包 ——
`lib/asn1.js` + `lib/cert.js` 手写 DER 组装 X.509，`node:crypto` 生成密钥与签名。
验证方式见下面的"自测"。

---

## 路由与认证边界

| 路径 | 认证要求 | 作用 |
|---|---|---|
| `GET /health` | 无 | 存活探测（无任何数据） |
| `GET /cert` | 无 | 下载证书（公钥信息，登录前就得能拿到） |
| `GET /font.css` · `GET /font/*.ttf` | 无 | 内嵌字体。**故意公开**：登录页自己也要用，而登录页不需要登录 |
| `GET /login` · `POST /login` | 无，但**有节流** | 登录页与登录 |
| `GET/POST /setup` | **仅本机（回环）** | 设置账号密码 |
| `GET /pair.json` | **仅本机（回环）** | 诊断信息 |
| `GET /logout` | 需登录 | 退出 |
| `GET /` | 需登录 | 手机主页（会话列表 + 对话） |
| `GET /api/sessions` | 需登录 | 会话列表，按最近活动降序，附工作区分组 |
| `GET /api/workspaces` | 需登录 | 可选的文件夹清单（已登记工作区 + 已有会话的目录，合并去重） |
| `POST /api/session` | 需登录 + JSON | **新建会话** |
| `GET /api/follow?id=&max=` | 需登录 | **SSE**：实时跟随一个会话 |
| `GET /api/page?id=&before=&max=` | 需登录 | 往上翻更早的历史 |
| `POST /api/prompt` | 需登录 + JSON | 发送一条文本消息 |
| `POST /api/cancel` | 需登录 + JSON | 停止当前轮 |
| `GET /api/models` | 需登录 | 可用模型目录（含推理档位），60 秒缓存 |
| `POST /api/model` | 需登录 + JSON | 切换会话的模型（下次请求生效） |
| `GET /api/presets` | 需登录 | 模式清单（标准 / PTC / 极简 / 创造 + 自建），60 秒缓存 |
| `POST /api/preset` | 需登录 + JSON | 切换会话的模式（仅未开跑的会话可换） |
| `GET /api/questions?id=` | 需登录 | 待回答的提问（给列表页角标用） |
| `POST /api/answer` | 需登录 + JSON | 回答一个提问 |
| `GET /api/questions/stream` | 需登录 | **SSE**：任何会话出现提问都推给手机 |

回环判定看 **socket 的真实来源地址**，不看 Host 头，所以伪造 Host 绕不过去。
鉴权在"会话服务是否就绪"之前 —— 未登录者拿到的是 401，不会因为 503 而得知服务状态。

---

## 镜像协议

### `GET /api/sessions`

```jsonc
{
  "items": [
    { "id": "session-abc", "title": "标题或 null", "running": true, "blank": false,
      "agentAvailable": true, "updatedAt": 1791350663634, "cwd": "D:\\x",
      "origin": null, "parentSessionId": null,
      "preset": "cordis",          // 当前模式 id，来自 Session 投影
      "pendingQuestion": false }   // 这个会话正在等手机回答
  ],
  "groups": [                      // 按 cwd 分组，组内最近活动降序，"无工作区"永远排最后
    { "key": "d:\\x", "name": "x", "path": "D:\\x", "updatedAt": 1791350663634,
      "running": true, "items": [ /* 同一批对象 */ ] }
  ]
}
```

`items` 保留扁平形态是为了向后兼容（旧页面只读它）；新页面用 `groups` 渲染可折叠的分组。
会话服务未就绪时返回 `503 {"error":"session-controller-unavailable"}`。

### `GET /api/follow?id=<sessionId>&max=<n>` → SSE

`Content-Type: text/event-stream`，每条消息是 `data: <JSON>\n\n`，
另有 `:` 开头的心跳注释行（20 秒一次，防手机浏览器与 AP 掐掉静默连接）。

信封三种：

```jsonc
{ "e": "snapshot", "d": { header, cursor, hasMore, records, projections, assistantStream } }
{ "e": "event",    "d": { type, seq, time, data } }
{ "e": "stream",   "d": { k, ... } }          // 逐字帧，键名压短以省带宽
```

**为什么重连时靠"重建"而不是"续传"**：`SessionFollowRequest` 里**没有游标参数**
（只有 `address` / `maxMessages` / `turnWindow` / `assistantStream`），
所以服务端无法从"上次断在哪"继续。设计改为：每次连接都下发一份完整快照，
前端按 `seq` 去重后重建视图。效果一样（切后台回来能补齐、不丢不重），机制不同。

### 事件投影：为什么不能原样透传

DSH 的会话事件里有几个**极大**的条目，直接下发会把手机界面卡死：

| 原始事件 | 处理 |
|---|---|
| `request/header` | 带**完整工具 schema 列表**（几十上百 KB）→ 只留 `model`/`provider`/`toolCount` |
| `user/message`（注入的） | AGENTS.md / 运行时上下文 / 技能目录等也是 `user/message`，靠 `source.kind` 与 `<system-reminder>` 块识别 → **整条或按块丢弃** |
| `system/message` | 带**整个系统提示** → **整条丢弃** |
| `developer/message` | 同上 |
| `assistant/message` | 额外带一份 `stream` 原始记录（逐字内容已单独推送）→ 丢弃该字段 |
| `assistant/attempt` | 与 `assistant/message` 重复 → **整条丢弃** |
| 未知类型 | 只下发 `type` + `seq`，不透传 `data`（调试视图能看到"这里有个没处理的事件"） |

文本块截断到 4000 字符、工具参数 2000 字符，截断处留可见标记。

### 隐藏系统消息：怎么区分"人打的"和"机器塞的"

手机上只想看到**谁说了什么**，不想看 AGENTS.md、`Current runtime context…` 这类每轮重放
几千字节英文。麻烦在于：**这些注入内容也是以 `user/message` 送进来的**，`role` 同样是 `user`，
从内容上根本分不出来（`Current runtime context…` 那条连 `<system-reminder>` 标签都没有）。

唯一可靠的判别依据是 `data.source.kind`：

| `source.kind` | 内容 | 手机上 |
|---|---|---|
| `user` | 真人输入 | **显示** |
| `agent-instructions` | `AGENTS.md` / `CLAUDE.md` 等指令文件 | 隐藏 |
| `runtime-context` | `Current runtime context…` | 隐藏 |
| `skill-catalog` | 技能目录 | 隐藏 |
| `user-approval` | 审批策略变更通知 | 隐藏 |

（这些取值是从真实会话日志 `sessions/--*/session-*/session.v4.jsonl.zstd` 里读出来的，
不是猜的。日志是**多帧 zstd**，按魔数 `28 B5 2F FD` 切开逐帧解压即可。）

判定函数是 `isInjectedUserMessage(data)`，**刻意用白名单**（只认 `user`）而不是黑名单：
`source.kind` 表达的是**来源**，`user` 是唯一意味着"人打的"的来源。将来 DSH 新增注入类型时
默认也会被隐藏，不会又冒出来一堆噪音。

**fail-safe 方向很重要**：取不到 `source`、`source` 不是对象、`kind` 缺失或不是非空字符串时，
一律**按真人消息处理**。宁可多显示一条注入内容，也绝不能吞掉用户自己说的话。

#### 还有第二种注入：`<system-reminder>` 块

只用 `source.kind` 会漏掉一类 —— **子代理（teammate）的启动提示**。对那个子会话来说，
它的 prompt 就是"用户输入"，所以 `kind` 是 `user`；但内容是**两个块**：

```
块 0: <system-reminder>You are teammate "mobile-ui". Your Team Lead is named "lead"…</system-reminder>
块 1: 你要为一个已经存在的 DSH 插件实现手机端界面…（8000 字的真实任务书）
```

整条丢掉会把任务书也丢了，所以这里按**块**剥：只剥"整块首尾都被 `<system-reminder>` 包住"
的文本块（`stripInjectedBlocks`），剥完什么都不剩才把整条丢掉。

刻意要求**首尾都被包住**：只在开头出现、正文跟在同一个块里的保持原样，
免得误伤"引用了一段 reminder 然后接着说正事"的内容。另外，"本来就没有文本块"的消息
（比如只带附件）不会因为"剥完为空"被误删 —— 判据是 `rawBlocks.length > 0 && blocks.length === 0`。

这两个规则都是拿真实会话日志回放验证过的：三份日志（含一个子代理会话）共 1478 条记录，
回放后手机上保留的 8 条 `user/message` 全是真人输入，**零条**残留 `system-reminder`。

过滤放在 `lib/mirror.js` 的 `projectEvent`（宿主侧）而不是页面里，有三个好处：

1. 翻历史时快照要**重放整段记录**，注入内容也在这里被挡掉，手机一个字节都收不到；
2. 快照与实时流走的是同一个 `projectEvent`，改一处两处都对；
3. 顺带消掉一个隐患 —— `app.js` 里 `shiftPending()` 是"见到 `user/message` 就消掉最老的
   发送中气泡"，注入消息也会触发它。目前只是因为注入消息恰好排在真人消息**之后**才没出错，
   属于靠顺序侥幸。

客户端那边对应的 `renderSystemNote` 与 `.sys-note` 样式一并删掉了（不留死代码）。
顺带的好处：`lib/web/*` 是热更新的，所以**即使宿主还没重启**（旧宿主仍在下发"已省略"标记），
新页面也已经不会渲染它们了。

### 标题从哪来

`SessionSummary` 里**没有 title 字段**，标题只可能出现在 `projections.values`
这个开放记录里（键名没有稳定约定）。所以做防御性读取：
`title` → `sessionTitle` → `name` → `label` → 模糊匹配含 `title` 的键；
取不到就返回 `null`，由前端降级显示 `cwd` 末段 + 相对时间。

### `POST /api/prompt` —— 发消息

```jsonc
// 请求（Content-Type: application/json）
{ "sessionId": "sess-1", "requestId": "a1b2c3d4-…", "text": "你好", "timeZone": "Asia/Shanghai" }

// 响应
200 { "accepted": true, "duplicate": false }
```

`duplicate: true` 表示这次是幂等重放，消息**没有**重复发出。

| 状态 | `error` | 含义 |
|---|---|---|
| 400 | `missing-session-id` / `bad-request-id` / `empty-text` / `text-too-long` / `bad-text` / `bad-body` | 参数问题 |
| 403 | `prompt-disabled` | 配置里 `enablePrompt=false` |
| 415 | `unsupported-media-type` | 没带 `application/json` |
| 429 | `too-fast` | 同一会话 300ms 内又发了一条 |
| 502 | `prompt-failed` | 上游报错，`message` 是原始信息 |
| 503 | `session-controller-unavailable` | 会话服务未就绪 |

**为什么有 `requestId` 与幂等台账。** 手机弱网下"发出去了但没收到响应"很常见，
用户会重发。`SessionPromptRequest` 带 `requestId`，说明上游设计上支持幂等——
但"上游确实按 requestId 去重"这件事没有实测验证过。所以服务端自己再记一层
（最近 200 个 id / 10 分钟），不把正确性全押在未验证的假设上。

**幂等优先于节流。** 重复的 `requestId` 在节流判断**之前**就返回 `200 {duplicate:true}`。
否则弱网重试（几百毫秒内）会拿到 `429 发送太快了`——那是最需要"已受理"的时刻。

**只支持纯文本。** `PromptContentPart` 还有 `image`（要 base64 走 `admitPromptContent`
准入管道）和 `file`（要先上传拿 `receiptId`），都不在这一版范围内。

**`mode` 固定 `queue`。** 另一个取值 `steer`（插进正在跑的轮次）语义未经验证，不做。

### `POST /api/cancel` —— 停止当前轮

```jsonc
{ "sessionId": "sess-1" }   // → 200 { "accepted": true }
```

同样受 `enablePrompt` 总开关约束（`false` 时 403），错误码同上，502 时为 `cancel-failed`。

### `GET /api/models` · `POST /api/model` —— 模型

```jsonc
// GET /api/models → 200
{ "catalog": {
  "default": { "provider": "doulor", "model": "wb-…", "reasoningEffort": "medium" },
  "routableProviders": ["doulor", "olomc"],
  "groups": [{ "id": "doulor", "name": "Doulor", "models": [
    { "id": "wb-…", "name": "WB-DS41F", "description": "…",
      "efforts": [{ "id": "low", "name": "低" }, { "id": "high", "name": "高" }],
      "defaultEffort": "medium" }
  ] }],
  "failures": [{ "id": "bad", "name": "坏提供方", "message": "连接超时" }]
} }

// POST /api/model（Content-Type: application/json）
{ "sessionId": "sess-1", "provider": "doulor", "model": "wb-…", "reasoningEffort": "high" }
// → 200 { "selected": { "provider": "…", "model": "…", "reasoningEffort": "high" } }
```

- 目录是**只读**的：只能切换电脑上已经存在的模型，没有新增/删除。
- `selectModel` 是**会话本地**的，**下一次请求才生效**（不打断正在跑的轮次）。
- `reasoningEffort` 可以省略 —— 省略时按目录里的 `defaultEffort`。
- 有提供方读不出模型时进 `failures`，页面把它列在面板底部（不静默吞掉）。
- 上游抛错 → `502 {"error":"model-failed","code":<上游 code>}`。

### `GET /api/presets` · `POST /api/preset` —— 模式

四个内置模式的 id 与中文名（来自 DSH 的 preset 注册表）：
`standard` 标准模式 · `ptc` PTC 模式 · `minimal` 极简模式 · `cordis` 创造模式。
自建模式用注册时给的名字。`broken: true` 的模式在面板里置灰。

```jsonc
{ "sessionId": "sess-1", "preset": "cordis" }
// → 200 { "selected": "cordis", "label": "创造模式" }
```

| 状态 | `error` | 含义 |
|---|---|---|
| 400 | `missing-session-id` / `missing-preset` | 参数问题 |
| 403 | `prompt-disabled` | 只读模式 |
| 404 | `preset-not-found` | 没有这个模式 |
| 409 | `preset-locked` | **这个会话已经跑过至少一轮，模式锁死** |
| 409 | `preset-invalid` | 模式当前不可用（如 `broken`） |
| 409 | `agent-not-live` | 会话没有活着的 Agent（进程重启过） |
| 502 | `preset-failed` | 上游报错 |
| 503 | `presets-unavailable` | 模式服务未就绪 |

`preset-locked` 不是 bug 而是 DSH 的规则：`AgentPresetRegistry.select` 里
`boundary.openTurnStartSeq !== null || boundary.lastTurn > 0` 就抛 `agent-preset/locked`。
手机页面据此把模式芯片置灰并提示"已开始的会话不能改模式"。

### 为什么"当前模式"读投影而不是 header

`header.agentPreset` 是**创建时**的模式，而且被深冻结 —— DSH 源码注释原文：
"The creation header names the preset a session STARTED with, and it is deep-frozen
because that is a creation fact."。会话**在还是空白的时候可以换模式**，那次变更只落在
`agent-preset/selected` 事件里、进而进 Session 投影。

所以两边都按投影读：`projectSnapshot` / `projectEvent` / `normalizeSummary` 取
`projections.values.agentPreset`，header 只作兜底。曾经读 header，结果是**创造模式的会话
在手机上显示成 "standard"** —— 这类 bug 不抛异常、只安静地显示错值，所以 `tools/web-test.mjs`
里专门有一组源码断言把它钉住。

模型同理：投影键叫 `modelSelection`（不是 `model`），而"下次请求会用哪个模型"的定义就是
`view.next = state.pending ?? state.lastUsed`，所以直接读 `modelSelection.next` 即可，
不需要在客户端复刻优先级逻辑。

### `GET /api/workspaces` · `POST /api/session` —— 新建会话

```jsonc
// GET /api/workspaces → 200
{ "workspaces": [
  { "id": "ws-1", "path": "D:\\proj\\alpha", "name": "alpha 项目", "title": "alpha 项目", "sessionCount": 3 },
  { "id": "",     "path": "D:\\proj\\loose", "name": "loose",      "title": "",           "sessionCount": 1 }
] }

// POST /api/session —— 三选一的定位方式
{ "workspaceId": "ws-1" }              // 已登记的工作区，宿主自己解析路径
{ "cwd": "D:\\proj\\brand-new" }        // 任意绝对路径（清单里没有的也行）
{ "cwd": "D:\\a", "preset": "cordis" }  // 可选：顺手指定模式
// → 200 { "sessionId": "session-…", "preset": "cordis" }
```

| 状态 | `error` | 含义 |
|---|---|---|
| 400 | `missing-location` | `cwd` 和 `workspaceId` 都没给 |
| 400 | `path-not-absolute` | `cwd` 不是绝对路径 |
| 400 | `path-too-long` | 路径超过 4096 字符 |
| 403 | `prompt-disabled` | 只读模式 |
| 415 | `unsupported-media-type` | 没带 `application/json` |
| 502 | `session-create-failed` | 上游报错，`code` 透传上游错误码 |
| 503 | `session-service-unavailable` | 会话服务未就绪 |

**清单从哪来。** `workspaceRegistry.list()` 给出 DSH 已登记的目录（**同步**返回，不读持久化），
再并上"已有会话的 `cwd`" —— 后者能覆盖"手动 cd 过去开过会话、但从没登记过"的目录。
两边按 `path` 去重，登记表优先（它带名字），最后再加一个手输绝对路径的入口，
这样**一个会话都没有的新文件夹也能开**。

**为什么不给新建会话加模式选择器。** 新建出来的是 `blank` 会话，DSH 只禁止**已开跑**的会话改模式
（见上面的 `preset-locked`）。所以进去以后头部那枚模式芯片本来就能点，建的时候再问一遍是多余的一步。
`preset` 字段留着是给"从别处跳过来、明确知道要什么模式"的场景用的。

**`workspaceRegistry` 是单独一次 `root.inject`。** Cordis 的 `inject` 要等**所有**依赖就绪才回调，
把它塞进 `agentPresets` / `agents` 那一批里，任何一个服务缺失都会连带饿死另外两个。
`tools/host-test.mjs` 里有一条断言专门盯着"没有把它混进那一批"。

### `GET /api/questions` · `POST /api/answer` · `GET /api/questions/stream` —— 手机回答提问

```jsonc
// GET /api/questions?id=<sessionId> → 200
{ "items": [{ "id": "q-1", "sessionId": "sess-1", "callId": "…", "createdAt": 1791350663634,
              "questions": [{ "id": "q1", "question": "要继续吗？", "header": "确认",
                              "detail": "会影响磁盘", "multiSelect": false,
                              "options": [{ "label": "继续", "description": "往下做" }] }] }] }

// POST /api/answer
{ "questionId": "q-1", "answers": [{ "id": "q1", "selected": ["继续"], "custom": "或者我自己写的" }] }
// → 200 { "accepted": true, "answers": [ … ] }
```

| 状态 | `error` | 含义 |
|---|---|---|
| 400 | `missing-question-id` / `bad-answers` / `empty-answer` / `answer-too-long` | 参数问题 |
| 404 | `question-not-found` | 已经答过、已被桌面端回答、或已经过期 |

**怎么接上去的。** `userQuestions.answer()` 这条路走不通：`ask_user_question` 是**无超时**的
（schema 里只有 `questions`，没有 `timeout`），所以 DSH 从不把它登记成"活动中的提问"，
`answer()` 会直接返回 `false`。改用 Host 侧的 `user-questions/request` waterfall：

```
root.on('user-questions/request', answerer, { prepend: true })
```

- **`prepend` 是必须的**：Remote 转发层那个 answerer 认出 agent 之后**不再调用 `next()`**，
  排在它后面就永远不会被执行。Cordis 的 `register` 用 `unshift` 处理 `prepend`，
  所以这样能插到最前。
- answerer 会**先同步调用 `next()`**（让桌面端的提问卡片照常出现），再
  `Promise.race([手机答案, 桌面答案])`：手机先答就用手机的，桌面先答就把手机侧的卡片收起来。
- 桌面那条路报错（GUI 没开）而手机还挂着时，继续等手机 —— 这正是这个功能存在的意义。
- 注册失败不影响任何现有功能：问题照常只在桌面回答，启动日志会明确写出来。

`GET /api/questions/stream` 是一条独立的 SSE（与 `/api/follow` 分开，因为它不绑定某个会话）：
连上时先补发一遍当前所有待答问题，之后实时推送 `{ "e": "question", … }` 与
`{ "e": "question-settled", … }`，另有 20 秒一次的心跳注释行。

---

## 桌面设置面板的数据通道

浏览器半侧在页面里**拿不到本机网卡信息**（WebRTC 那条路被 Chrome 的 mDNS 混淆挡掉，
不可靠），所以面板只能问主机。主机半侧在 DSH 自己的 GUI 服务上注册一条只读路由：

| 路径 | 认证要求 | 作用 |
|---|---|---|
| `GET /dsh-mirror/info.json` | **仅本机（回环）** | 设置面板的数据源（端口 / 协议 / 局域网地址 / 账号 / 口令状态 / 证书指纹） |

注意这条路由挂在 **DSH 的 GUI 服务**上，不是手机镜像自己的 19388。绕这一下是为了
**同源**：从 http 的 GUI 跨到 https 的 19388 会撞上自签证书（浏览器没访问过那个地址，
证书没被信任）与 CORS。鲸鱼插件的 `/dsh-whale/*.json` 走的也是这条路，是第三方插件
在 DSH 里给浏览器半侧送数据的既定做法。

这条路由是**只读**的，非回环来源一律 403；payload 只有上面列的展示字段，
**不含口令哈希、明文口令、请求统计、节流状态、证书文件路径**（都有断言钉住）。

拿不到 `webServer` 时只是面板显示「读不到主机信息」，手机镜像本身完全不受影响 ——
面板是便利功能，不该有能力拖垮插件。

> 浏览器半侧是手写的 `lib/client.js`（`window.__ModuleLoader__.load({ id, factory })`），
> 没有构建步骤：DSH 会把 `package.json` 里 `dsh.client` 声明的 `exports["./client"]`
> 原样当浏览器 bundle 发出去。**改它和改主机侧路由都需要重启 DSH**（bundle 与
> Loader 条目都在启动时扫描）。

---

## 安全边界

- **Host 校验**：只接受回环、私有网段 IPv4（10 / 172.16–31 / 192.168 / 169.254）
  或显式白名单，挡 DNS rebinding。
- **跨站一律拒**：`Sec-Fetch-Site: cross-site` 直接 403；带 `Origin` 时必须与 Host 同源。
- **口令**：scrypt 加盐哈希，异步实现（不阻塞宿主事件循环）；比较走 `timingSafeEqual`。
- **节流**：同来源连续失败指数退避（1s→30s），10 次后锁 5 分钟；
  节流在哈希之前生效，被锁的请求连 scrypt 都不跑，避免被刷成对 DSH 的拒绝服务。
- **会话**：HttpOnly + SameSite=Strict + Secure 的随机 Cookie，**不带 `Max-Age`**（关浏览器即失效）；
  改密码会注销所有旧会话。
- **静态资源白名单**：路径必须命中 `STATIC_FILES` 里的固定项，不做任何路径拼接，
  所以目录遍历天然不成立。唯一**无需登录**的资源是 `/font.css` 与两个 TTF ——
  字体不是机密（OFL 授权、谁都能下载），而登录页自己就要用它。
  白名单之外的 `/font/*` 路径会掉回"需要登录"，未登录者连"哪个文件存在"都问不出来。
- **SSE 背压**：客户端读得慢时 `await drain`，不会把事件无限堆在内存里；
  连接关闭时通过 `AbortController` 中止上游 `follow()`。
- **写操作的 CSRF 三道防线**：`SameSite=Strict` 的 Cookie、`Origin` 必须与 `Host` 同源、
  且强制 `Content-Type: application/json`（表单类简单请求打不进来，跨站必须走预检）。
- **写操作的输入约束**：正文去空白后非空且 ≤8000 字符；`requestId` 必须匹配
  `^[A-Za-z0-9_-]{1,128}$`；每会话 300ms 最小间隔；请求体上限 64KB。
- **只在局域网**：不做任何内网穿透。手机在外网时用不了 —— 这是刻意的。

---

## 自测

```bash
npm test    # 一次跑完下面八套，共 1589 项
```

八套都不需要启动 DSH，使用临时目录里的证书与配置，不碰 `$DSH_HOME`。

- `cert-test.mjs` 的关键一项是**真实 TLS 握手**：拿生成的证书起一个 HTTPS 服务，
  用 `rejectUnauthorized: true` + 指定 CA 连上去。能过就说明这张手写的证书在
  OpenSSL 眼里结构正确、签名有效、对该地址有效。另外验证了负向情况
  （不信任该 CA 时必须失败、域名不匹配时必须失败），确保它不是"碰巧能用"。
- `mirror-test.mjs` 用**伪造的 sessionController / agentPresets / agents** 驱动真实的
  HTTPS 服务，于是不用启动 DSH 就能端到端验证整条管道：SSE 响应头、快照与事件投影、
  逐字帧拼接、鉴权顺序、缺参 400、伪造 Host 403、静态资源分发与目录遍历 404，
  以及写操作——校验、幂等重放优先于节流、节流 429、`enablePrompt=false` 全拒，
  还有 P3 的模型目录缓存、切换模型/模式、提问中心与 answerer 竞速、问题流 SSE，
  以及 P4 的新建会话与内嵌字体（字体那条用**原始字节**比对，`req()` 会按 utf8 转字符串，
  读坏了也看不出来）、P5 的注入消息过滤（连"缺 `source` 时必须保留"的 fail-safe 方向都钉住了）。
- `host-test.mjs` 用一个极简的 Cordis 上下文替身**真的调用 `lib/index.js` 的 `apply()`**
  （真的起服务、真的登录），是唯一覆盖入口接线的一套。它按 Cordis 的 waterfall 语义
  手工组合处理器，正面验证"手机作答后 waterfall 拿到的就是手机的答案"，
  也反面验证"顺序反过来时手机根本答不上"—— 后者正是 `prepend: true` 的存在理由。
  另外用一个 `webServer` 替身接住桌面面板那条路由，直接调处理器验证：回环 200、
  非回环 403、IPv4-mapped 回环也算回环、payload 里**没有**口令哈希 / 统计 / 证书路径；
  再跑一遍**没有 webServer** 的 `apply()`，证明它只打日志、不抛错、不多占路由。
  顺带验证 dispose 之后端口真的不再接受连接（否则禁用插件会残留占用），
  以及 `workspaceRegistry` 是**单独一次 `inject`**（混进 `agentPresets` 那一批会互相饿死）。
- `web-dom-test.cjs` 用一个极简 fake DOM + fake fetch/EventSource 把 `app.js` 真跑一遍，
  是**唯一能覆盖页面行为**的一套（`boot()` 不抛错本身就证明 app.js 引用的 id 在
  index.html 里都存在）。它抓出过一个纯函数测试抓不到的真 bug：`tryJson` 返回的是
  `{ ok, value }` 而不是解析结果，把包装对象当帧传下去会让提问帧被静默丢弃。
  场景 F 还**故意**把旧宿主才会发的 `system/message` 灌进长连接，验证"新页面 + 旧宿主"
  这个半更新状态下也不会又冒出一堆英文。
- `web-test.mjs` 的第 ⑩ 节专门盯 `lib/client.js`（桌面设置面板）：bundle 包裹格式、
  `exports.inject`、槽注册的 id / order / label，以及**它与主机侧路由路径逐字一致**。
  这些都属于"写错了不报错、只会安静地少一页面板或显示『读不到主机信息』"的东西，
  只能靠源码断言钉住。另有一条断言检查面板样式**全部挂在 `.mm-` 前缀下**，
  不污染宿主界面。
- `client-test.mjs` 是唯一真正**执行** `lib/client.js` 的一套：用 `new Function` 把 bundle
  当脚本跑起来，喂假的 `window.__ModuleLoader__` / `document` / `navigator` / `fetch` / `react`，
  再真调 `apply()`，把注册的槽参数与组件抓下来。它同时钉住两件最容易出、又最难发现的错：
  ① bundle 包裹格式 / 导出形状 / 槽参数写错 —— 这些全都**不报错**，只是安静地少一页；
  ② 面板读的字段名与主机 payload 不一致 —— 面板会显示 `—` 或 `undefined`。
  第 ② 条是**双向**的：先用 `buildPanelInfo()` 生成主机真会发的那个对象，再用正则把面板
  读的每个 `info.*` / `tls.*` 抓出来逐个核对。它还带一个够用的 React 替身（含函数组件
  展开与函数式 setState），因此能断言"页面上到底会不会出现 `https://10.194.44.92:19388/`"
  这类**渲染结果**，而不只是"源码里有这个词"。

---

## 手机端的几个取舍

### 「记住我」被删掉了，不是修好了

登录会话存在**内存**里（`createSessionStore`），DSH 一重启就全没了 —— 跟 Cookie 上写不写
`Max-Age` 无关。原来那个"30 天记住我"复选框只是在骗人：重启 DSH 之后照样要重新登录。
既然要持久化就得把会话落盘（多一份凭据落盘面），用户选择了直接去掉。

现在 Cookie 不带 `Max-Age`，关掉浏览器就失效；服务端的 `sessionTtlDays` 只管"标签页一直开着"。
`tools/smoke.mjs` 里那条断言**故意仍然提交 `remember=on`**（模拟浏览器缓存的旧登录页），
验证服务端彻底忽略它 —— 防止这个字段被顺手接回去。

### 默认折叠工作区

会话多起来以后，展开的列表要滑很久才找得到目标，所以分组默认折叠、点组头展开。
折叠状态存在 `localStorage`（键 `dsh-mm-collapsed:<workspaceKey>`）。
**展开也要显式写 `'0'`**，不能靠 `removeItem` 表示展开 —— 否则"默认折叠"会让刷新后的展开状态弹回去。

### Markdown

`renderMarkdown` 是手写的（不引第三方包，省得给插件加运行时依赖）。支持：标题、段落、
`<br>` 换行、粗体 / 斜体 / 粗斜体 / 删除线、行内代码、围栏代码块（渲染后由
`decorateCodeBlocks` 包上头部条：语言名 + 复制键）、
引用、水平线、链接、图片、`<url>` 自动链接、有序/无序列表（含嵌套与 `start` 属性）、
任务列表、**GFM 表格（含对齐）**。

安全不变量：**先转义再替换**；链接与图片只放行 `http` / `https`（`javascript:` / `data:`
降级成纯文本）；行内代码与代码块的内容不参与任何标记解析。
`web-pure-test.cjs` 里有一组专门的用例，包括 `a **** b` 不该被凑成 `<em>`、
`foo_bar_baz` 不该被当成斜体。

### 字体：JetBrains Mono，只给代码

**字体是内嵌的，不是只写个名字。** 页面在**手机**上渲染，而 JetBrains Mono 只装在电脑上；
只写 `font-family: "JetBrains Mono"` 在手机上等于没写。所以仓库里带了两个 TTF
（Regular + Bold，约 538 KB），走 `/font.css` 的 `@font-face` 加载，`font-display: swap`
先拿回退字体渲染。首次加载多 538 KB（局域网内可忽略），之后浏览器长缓存。

作用范围**只有代码**：`.md code`、`pre.md-code`（含代码块头部条的语言名）、
工具调用摘要与参数、调试 JSON。正文与**思考过程**（`.reason-body`）保持系统等宽 ——
那是散文不是代码，等宽字体读起来更累。`tools/web-test.mjs` 里有对应断言把
"思考过程仍用 `--mono`"钉住。

字体按 SIL OFL 1.1 分发，`lib/web/fonts/OFL.txt` 是许可证全文。

---

## 界面：借鉴 DeepSeek 网页端

借的是**组件语言**，不是像素级复刻（也没搬 DeepSeek 的商标、图标或文案）：

| 借来的做法 | 为什么 |
|---|---|
| 助手消息**不带气泡**，只有用户消息有 | 回复是要读的正文；套气泡等于给它加了一圈没用的边框和缩进 |
| 代码块带**头部条**（语言名 + 复制键） | 手机上长按选代码很痛苦，点一下复制是刚需 |
| 助手消息元信息行里也有复制键 | 同上，复制整条回复（只取正文，不含思考过程） |
| **胶囊输入框**，发送键内嵌成圆形 | 发送是手机上最高频的动作，圆形键落在拇指自然位置 |
| 模式 / 模型芯片**紧贴输入框上方** | 原来在顶栏，单手够不到 |
| 会话列表**扁平行** + 时间靠右，分组标题用小号灰字 | 卡片式行在长列表里太吵，一条分隔线足够 |
| Markdown 排版放松（行高 1.75、段间距 13px） | 手机上密排的正文很难读 |

**没借的两样**（都考虑过，结论是弊大于利）：

- **「重新生成」**：DSH 的语义是"再发一次 prompt"，和网页端的"重跑这一轮"不是一回事，
  放上去会误导。
- **侧边抽屉式的会话栏**：手机上一页列表、一页会话的双页导航比抽屉更适合单手。

### 两套主题

配色收成 **48 个语义变量**（`--bg` / `--line` / `--fg` / `--code-head` …）。
深色写在 `:root`，浅色写在 `@media (prefers-color-scheme: light)` 里，
`<meta name="color-scheme" content="light dark">` 让浏览器原生控件（滚动条、输入框光标）
也跟着切。Android Chrome 的地址栏用两条带 `media` 的 `theme-color` 跟系统走。

登录页与设置页（`login.html` / `setup.html`）各有自己的小变量表，同样两套。

浅色那套的灰阶比深色压得更深一些：浅底上浅字更难读，直接用同一组灰会让
11px 的页脚文字掉到 2.4:1。现在两套的对比度是持平的（`--dim` 6.0 vs 7.4，
`--dim-3` 3.9 vs 4.0）。

`tools/web-test.mjs` 里有三条护栏钉住这件事：

1. **主题块之外不许出现任何颜色字面量** —— 漏一个不会报错，深色下看不出来，
   浅色下就是一块错色；
2. **`var()` 引用的变量必须有定义** —— 没有回退值时会退化成 `currentColor`
   （这次真踩到过一次：改名之后 `--ok-line` 悬空了）；
3. **浅色必须覆盖深色定义的所有颜色变量** —— 漏掉的那个会沿用深色值，
   同样是错色。

---

## 开发注意事项

**改 `lib/*.js`（宿主代码）需要重启 DSH。**
DSH 的宿主插件模块按 URL 缓存，`hmr` 服务只暴露 `watchConfig` / `getLinked`，
没有模块失效接口 —— 所以"禁用→启用"拿到的仍是旧代码。这是平台限制，不是插件问题。

**改 `lib/web/*.html` / `.js` / `.css` 即时生效**，不需要重启：页面是每次请求现读磁盘的。

---

## 路线图

- **P0（已完成）**：独立端口监听、HTTPS 自签证书、账号密码登录、设置页。
- **P1（已完成）**：会话列表、历史快照与翻页、实时逐字输出（SSE）、手机端界面。
- **P2（已完成）**：手机发消息（`sessionController.prompt`，幂等 + 节流）、
  停止当前轮（`cancel`，需二次确认）、`enablePrompt` 只读总开关。
- **P3（已完成）**：会话按工作区分组（可折叠、状态持久化）、切换会话的模型
  （含推理档位）、显示与切换模式（标准 / PTC / 极简 / 创造，已开跑的会话置灰）、
  在手机上回答 DSH 的提问（Host 侧 `user-questions/request` waterfall）。
- **P4（已完成）**：手机端新建会话（工作区清单 + 手输绝对路径）、分组默认折叠、
  Markdown 渲染补全（表格 / 嵌套列表 / 任务列表 / 删除线等）、内嵌 JetBrains Mono
  （仅代码）、去掉名不副实的「记住我」。
- **P5（已完成）**：隐藏系统消息 —— 注入的 `user/message`（AGENTS.md / 运行时上下文 /
  技能目录 / 审批通知）与 `system/message` / `developer/message` 全部在宿主侧丢弃，
  会话里只剩真人消息、助手回复、工具调用。
- **P6（已完成）**：界面按 DeepSeek 网页端的组件语言改造 —— 助手消息去气泡、
  代码块头部条（语言名 + 复制键）、助手消息复制键、胶囊输入框、模式/模型芯片下移到
  拇指区、会话列表扁平行 + 时间靠右；并拆出 48 个语义颜色变量，深/浅两套主题跟随系统。
- **桌面设置面板（已完成）**：DSH 设置里多一页「手机镜像」—— 手机访问地址（一键复制、
  按连通性排序、其他网卡可展开）、本机设置页直达链接，以及协议 / 端口 / 账号 /
  口令状态 / 证书指纹 / 有效期 / 在线会话；打开期间每 10 秒自动刷新。
  数据来自主机侧在 GUI 服务上注册的**只读、仅回环**路由 `GET /dsh-mirror/info.json`。
- **超级岛 APK（1.0）**：小米澎湃 OS 超级岛上的常驻状态 —— 后台聚合监控（有会话在跑就
  上岛，跑完显示绿色环 + 「已完成」）、岛上显示当前会话标题、出现提问时岛变色。
  计划与验证记录见 [apk-plan.md](apk-plan.md)，源码在 [`android/`](../android/)。
- **P7**：二维码配对、桌面内配对页、多网卡地址选择。
- **之后可做**：手机贴图（要走 `admitPromptContent` 准入管道）、
  会话重命名（`rename`）、消息队列管理（`updateQueue`）、附件下载端点。
