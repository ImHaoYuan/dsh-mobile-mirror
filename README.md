# dsh-mobile-mirror

在局域网里用手机镜像 DSH 的会话：看会话列表、看历史、看**实时逐字输出**，
以及**发消息**和**停止当前轮**。
**桌面端行为完全不变** —— 不注入 UI、不遮挡、不改布局、不碰现有 webServer。

当前进度：**P2 完成**。剩余：二维码配对与桌面内配对页（P3）。

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

## 安装（本地 link 方式）

profile 的 `package.json`：

```json
{
  "dependencies": {
    "dsh-mobile-mirror": "link:D:/VibeCoding/Plugin/dsh-mobile-mirror"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "...",
        "dsh-mobile-mirror"
      ]
    }
  }
}
```

更省事的等价做法（实测可用）：

```
plugin_manager install_bundle  target = link:D:/VibeCoding/Plugin/dsh-mobile-mirror
```

它会自动改好 `package.json`、建好 `node_modules` 链接，并**热应用**到运行中的 profile。

## 首次使用：设置账号密码

1. 在**电脑上**打开 `https://127.0.0.1:19388/setup`
   （本机自签证书，浏览器会先警告一次，点"继续访问"即可）
2. 填账号和密码（至少 6 位），保存。

没设置之前**任何人都登录不了**（fail closed），不存在"没配密码所以谁都能进"。

也可以直接编辑 `~/.dsh/mobile-mirror.json` 填明文 `password`，
下次启动会自动转成 scrypt 哈希并把明文从文件里删掉。

## 手机访问

1. 手机连**同一个 Wi-Fi**
2. 打开 `https://<电脑局域网IP>:19388/`
   （地址见 `/setup` 页面的"手机访问地址"，按最可能连得上排序）
3. 首次会看到证书警告 —— 自签证书的正常表现：
   - **iOS Safari**：「显示详细信息」→「访问此网站」
   - **Android Chrome**：「高级」→「继续前往」
4. 用刚设的账号密码登录

**想消掉警告**：在电脑上 `/setup` 页面下载 `cert.pem`，装到手机上：

- **iOS**：安装描述文件（设置 → 通用 → VPN与设备管理），再到「关于本机 → 证书信任设置」打开完全信任
- **Android**：设置 → 安全 → 加密与凭据 → 安装证书 → CA 证书

不装也能用，只是每次会先看到一个警告页。

## 配置

`$DSH_HOME/mobile-mirror.json`（首次启动自动生成，每次启动会归一化重写）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `port` | `19388` | 监听端口 |
| `username` | `dsh` | 登录账号 |
| `passwordHash` | `null` | scrypt 加盐哈希，由 `/setup` 写入 |
| `password` | — | 只用于手写明文，加载后转哈希并删除 |
| `sessionTtlDays` | `30` | 登录有效期 |
| `tls` | `true` | 关掉会退回明文 HTTP（不推荐） |
| `certDir` | `null` | 证书目录，默认 `$DSH_HOME/mobile-mirror-cert` |
| `allowedHosts` | `[]` | 额外的 Host 白名单（一般不需要） |
| `enablePrompt` | `true` | **写操作总开关**。设 `false` 即只读模式：发消息与停止轮次都返回 403 |

## 路由与认证边界

| 路径 | 认证要求 | 作用 |
|---|---|---|
| `GET /health` | 无 | 存活探测（无任何数据） |
| `GET /cert` | 无 | 下载证书（公钥信息，登录前就得能拿到） |
| `GET /login` · `POST /login` | 无，但**有节流** | 登录页与登录 |
| `GET/POST /setup` | **仅本机（回环）** | 设置账号密码 |
| `GET /pair.json` | **仅本机（回环）** | 诊断信息 |
| `GET /logout` | 需登录 | 退出 |
| `GET /` | 需登录 | 手机主页（会话列表 + 对话） |
| `GET /api/sessions` | 需登录 | 会话列表，按最近活动降序 |
| `GET /api/follow?id=&max=` | 需登录 | **SSE**：实时跟随一个会话 |
| `GET /api/page?id=&before=&max=` | 需登录 | 往上翻更早的历史 |
| `POST /api/prompt` | 需登录 + JSON | 发送一条文本消息 |
| `POST /api/cancel` | 需登录 + JSON | 停止当前轮 |

回环判定看 **socket 的真实来源地址**，不看 Host 头，所以伪造 Host 绕不过去。
鉴权在"会话服务是否就绪"之前 —— 未登录者拿到的是 401，不会因为 503 而得知服务状态。

## 镜像协议

### `GET /api/sessions`

```json
{ "items": [
  { "id": "session-abc", "title": "标题或 null", "running": true, "blank": false,
    "agentAvailable": true, "updatedAt": 1791350663634, "cwd": "D:\\x",
    "origin": null, "parentSessionId": null }
] }
```

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
| `system/message` | 带**整个系统提示** → 只留一行"已省略"标记 |
| `developer/message` | 同上 |
| `assistant/message` | 额外带一份 `stream` 原始记录（逐字内容已单独推送）→ 丢弃该字段 |
| `assistant/attempt` | 与 `assistant/message` 重复 → **整条丢弃** |
| 未知类型 | 只下发 `type` + `seq`，不透传 `data`（调试视图能看到"这里有个没处理的事件"） |

文本块截断到 4000 字符、工具参数 2000 字符，截断处留可见标记。

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

## 安全边界

- **Host 校验**：只接受回环、私有网段 IPv4（10 / 172.16–31 / 192.168 / 169.254）
  或显式白名单，挡 DNS rebinding。
- **跨站一律拒**：`Sec-Fetch-Site: cross-site` 直接 403；带 `Origin` 时必须与 Host 同源。
- **口令**：scrypt 加盐哈希，异步实现（不阻塞宿主事件循环）；比较走 `timingSafeEqual`。
- **节流**：同来源连续失败指数退避（1s→30s），10 次后锁 5 分钟；
  节流在哈希之前生效，被锁的请求连 scrypt 都不跑，避免被刷成对 DSH 的拒绝服务。
- **会话**：HttpOnly + SameSite=Strict + Secure 的随机 Cookie；改密码会注销所有旧会话。
- **SSE 背压**：客户端读得慢时 `await drain`，不会把事件无限堆在内存里；
  连接关闭时通过 `AbortController` 中止上游 `follow()`。
- **写操作的 CSRF 三道防线**：`SameSite=Strict` 的 Cookie、`Origin` 必须与 `Host` 同源、
  且强制 `Content-Type: application/json`（表单类简单请求打不进来，跨站必须走预检）。
- **写操作的输入约束**：正文去空白后非空且 ≤8000 字符；`requestId` 必须匹配
  `^[A-Za-z0-9_-]{1,128}$`；每会话 300ms 最小间隔；请求体上限 64KB。
- **只在局域网**：不做任何内网穿透。手机在外网时用不了 —— 这是刻意的。

## 自测

```bash
node tools/cert-test.mjs     # 证书层：27 项
node tools/smoke.mjs         # HTTPS + 认证集成：32 项
node tools/mirror-test.mjs   # 数据层 + 五条路由：156 项
```

三套都不需要启动 DSH，使用临时目录里的证书与配置，不碰 `$DSH_HOME`。

- `cert-test.mjs` 的关键一项是**真实 TLS 握手**：拿生成的证书起一个 HTTPS 服务，
  用 `rejectUnauthorized: true` + 指定 CA 连上去。能过就说明这张手写的证书在
  OpenSSL 眼里结构正确、签名有效、对该地址有效。另外验证了负向情况
  （不信任该 CA 时必须失败、域名不匹配时必须失败），确保它不是"碰巧能用"。
- `mirror-test.mjs` 用**伪造的 sessionController** 驱动真实的 HTTPS 服务，
  于是不用启动 DSH 就能端到端验证整条管道：SSE 响应头、快照与事件投影、
  逐字帧拼接、鉴权顺序、缺参 400、伪造 Host 403、静态资源分发与目录遍历 404，
  以及 P2 的写操作——校验、幂等重放优先于节流、节流 429、`enablePrompt=false` 全拒。

## 开发注意事项

**改 `lib/*.js`（宿主代码）需要重启 DSH。**
DSH 的宿主插件模块按 URL 缓存，`hmr` 服务只暴露 `watchConfig` / `getLinked`，
没有模块失效接口 —— 所以"禁用→启用"拿到的仍是旧代码。这是平台限制，不是插件问题。

**改 `lib/web/*.html` / `.js` / `.css` 即时生效**，不需要重启：页面是每次请求现读磁盘的。

## 路线图

- **P0（已完成）**：独立端口监听、HTTPS 自签证书、账号密码登录、设置页。
- **P1（已完成）**：会话列表、历史快照与翻页、实时逐字输出（SSE）、手机端界面。
- **P2（已完成）**：手机发消息（`sessionController.prompt`，幂等 + 节流）、
  停止当前轮（`cancel`，需二次确认）、`enablePrompt` 只读总开关。
- **P3**：二维码配对、桌面内配对页、多网卡地址选择。
- **之后可做**：手机贴图（要走 `admitPromptContent` 准入管道）、
  会话重命名（`rename`）、消息队列管理（`updateQueue`）、附件下载端点。
