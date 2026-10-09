# 原生客户端方案（client-plan.md）

> 2026-10-08 立项。给 dsh-mobile-mirror 做一个**安卓原生**客户端（Kotlin + Compose）：
> 界面风格模仿 **DeepSeek 安卓客户端**；**提问卡**照 **DSH 桌面端**还原；
> **模型/模式选择**做成 DeepSeek 那种「深度思考」式的输入条胶囊 + 弹层。
>
> 用户已定的口径：App 名 **「DSH镜像原生」**、图标底色**由蓝改黑**、
> **只做浅色主题**（不跟随系统）、Markdown **与网页端完全一致**、特性**追平网页端全部**。

## 1. 边界（三条硬线）

1. `lib/web/*` **一行不改** —— 网页端继续可用，同时是原生侧的行为对照基准；
2. 宿主 `lib/*.js` **零改动** —— 原生只消费现有 REST 与两条 SSE；
3. 现有 WebView 外壳 APK **行为不变**（M0 已用二进制对照验证，见 §7）。

**原生客户端 = 同一份协议的第二个客户端。** 宿主侧投影（`lib/mirror.js`）已经把 DSH 的原始事件
变成 `snapshot` / `event` / `stream` 三类简单帧，所以原生侧**不需要理解 DSH 事件语义**，
只需要渲染。这是整个方案成立的前提。

## 2. 模块布局

```
android/
├── settings.gradle.kts        :app / :core / :client
├── build.gradle.kts           AGP 8.5.2 + Kotlin 2.0.21 + compose 编译器插件
├── core/                      **两个客户端共用**的平台层（纯 Java，零第三方依赖）
│   └── dev.dsh.mirror.{CertPinner, ServerPrefs, MirrorApi, MirrorService, IslandSupport, IslandMonitor}
├── app/                       WebView 外壳（界面仍全在网页侧）
└── client/                    原生 Compose 客户端
    └── dev.dsh.mirror.client.*
```

### 2.1 为什么全都叫 `client` 而不是 `native`

**`native` 是 Java 关键字**，做包名段会被 AGP 直接拒绝：

```
Namespace 'dev.dsh.mirror.native' is not a valid Java package name
```

一开始只有包名被迫改成 `.client`、模块仍叫 `:native`，于是出现 `:native` 与 `dev.dsh.mirror.client` 的错位。
后来**统一成 client**：模块 `:client`、目录 `android/client/`、包 `dev.dsh.mirror.client`、文档 `docs/client-plan.md`。
"原生客户端"只在中文叙述里保留 —— 那是产品概念，不是标识符。

### 2.2 `:core` 的两处解耦

搬进库模块时，`MirrorService` 有两处对 App 的硬依赖，改成了运行时解析：

| 原来 | 现在 | 为什么 |
|---|---|---|
| `new Intent(this, MainActivity.class)` | `getPackageManager().getLaunchIntentForPackage(getPackageName())` | 两个 App 的入口 Activity 不同 |
| `R.mipmap.ic_launcher`（岛图标） | `getApplicationInfo().icon` | 外壳版图标是蓝底、原生版是黑底，资源 id 由各 App 自己给 |

另外三个类里对 `R.string` / `R.drawable` 的引用改成 `:core` 自己的 `R`
（`android.nonTransitiveRClass=true`，每个模块只有自己的 R）。

**可见性**：`CertPinner` / `ServerPrefs` / `MirrorApi` 及其成员由包级私有改为 `public` ——
库的 API 要能被别的包（`.client`）调用。`IslandSupport` / `IslandMonitor` 保持包级私有（只有 `MirrorService` 用）。

### 2.3 依赖（**明确打破「零第三方依赖」**）

`:core` 仍然零依赖；第三方依赖只出现在 `:client`。版本**刻意钉死为本机 Gradle 缓存里已有的那套**，
免得构建依赖 `plugins.gradle.org` 的连通性（实测该域名 HEAD 超时，`dl.google.com` 与 `mavenCentral` 正常）：

| 用途 | 坐标 | 版本 |
|---|---|---|
| Kotlin | `org.jetbrains.kotlin.android` | 2.0.21 |
| Compose 编译器 | `org.jetbrains.kotlin.plugin.compose` | 2.0.21（随 Kotlin 版本走） |
| UI | `androidx.compose.ui:ui` / `foundation` | 1.7.3 |
| 组件 | `androidx.compose.material3:material3` | 1.3.0 |
| 骨架 | `androidx.core:core-ktx` / `activity-compose` / `lifecycle-runtime-compose` | 1.13.1 / 1.9.2 / 2.8.6 |
| 协程 | `kotlinx-coroutines-android` | 1.8.1 |

**不引**的：`compose-bom`（缓存里没有，直接钉版本）、`material-icons-extended`（图标自己画矢量）、
`androidx.security-crypto`（已废弃，密码用 AndroidKeyStore 手写 AES-GCM）、OkHttp（先沿用
`HttpURLConnection`，与 `:core` 的 `MirrorApi` 一致）、`kotlinx-serialization`（JSON 用平台自带的 `org.json`）。

## 3. 设计 token（浅色）

取值出处：**DSH 桌面端** `dsh-client-ui-theme` 的 `--dsw-static-*` / `--dsw-alias-*` / `--dsw-radius-*`，
以及参考截图（`screenshots/`，仅本机）的实测值。截图实测与 token 互相印证。

| 元素 | 值 | 出处 |
|---|---|---|
| 品牌蓝 | `#4D6BFE` | 截图鲸鱼 logo 实测 `#4E69EE`；DSH `deepseek-500`=`#4176E6`；项目网页端在用 `#4D6BFE` |
| 用户气泡底 | `#EDF3FE` | DSH `--dsw-specific-bubble`（=deepseek-50）；截图实测 `#EAECF8`（JPEG 偏移） |
| 正文 / 次级 / 三级 / caption | `#0F1115` / `#61666B` / `#81858C` / `#ADB2B8` | DSH `--dsw-alias-label-*` |
| 描边 l2 / l4 | `#0000001A` / `#00000029` | DSH token |
| 悬浮与选中底 | `#2631480F` | DSH token |
| 模块底 / 编号徽章底 | `#F5F6F7` / `#E9ECF2` | DSH token |
| 圆角阶梯 | 4 / 8 / 12 / 16 / 20 px | DSH `--dsw-radius-xs/sm/md/lg/xl` |
| 正文 | 14sp / 行高 22sp | DSH `--dsh-content-font-size` 默认值 |
| 输入条胶囊 | 底 `#E4F2FF` + 蓝字/蓝图标 `#5371D1` | 截图实测 |

## 4. 视觉规格

### 4.1 提问卡：照 DSH 桌面端 1:1

从 `dsh-client-ui-user-questions` 的 `QuestionComposer.module.css` 抄下来的关键数值：

- 卡片：圆角 20px、白底、`max-height: min(60vh, 520px)`、外框 `padding: 6px calc(composer 边距 + 16px) 10px`、底部 `padding: 0 0 10px`
- 头部：`padding: 20px 16px 0 24px`；眉标 11px 三级灰；标题 16px/22 字重 500
- 选项列：`gap: 1px; margin-top: 8px; padding: 4px 12px`
- 选项行：`min-height: 40px`、圆角 12px、`padding: 8px 12px 8px 8px`、`gap: 8px`、1px 透明描边
- 编号徽章：20×20、圆角 4px、底 `#E9ECF2`、12px/18px、次级灰
- 复选框：20×20 容器 + 14×14 方框、`0.5px` 描边 `#00000029`、圆角 4px
- 选中：底 `#2631480F` + 描边 `#0000001A`
- 自由输入块：`0.5px` 描边 `#00000029`、圆角 16px、底 `#F5F6F7`、`min-height: 64px`、左右 12px、聚焦变品牌蓝
- 底部条：`margin-top: 12px; padding: 0 10px 0 18px`
- 动效：`background-color .12s, border-color .12s`，带 `prefers-reduced-motion` 关闭分支

### 4.2 消息

- 用户：右侧、圆角 20px、底 `#EDF3FE`、`padding: 10px 16px`、最大宽 72%、`pre-wrap`（DSH `v1fjQa_bubble`）
- 助手：**通栏无气泡**，正文 14sp/22sp
- 思考/工具：收进「工作过程」折叠卡（网页端语义，见 README）

### 4.3 模型 / 模式选择

输入条上方一颗胶囊（显示当前模型 + 推理档位），点开底部弹层，内含：模型（含推理档位）/ 模式 / 新建会话路径。
触发键照 DSH 的 `wq12jW_trigger`：高 28px、圆角 8px、13px、chevron 展开时旋转 180°、`transition .12s`。

### 4.4 首页与抽屉（参考截图实测）

- 首页：白底，logo 居中在 **y≈44%**（实测 90×68px），底部输入区 **y≈88–97%**
- 抽屉：宽 **71.4% 屏宽**、白底；右侧遮罩 **≈32% 黑**

### 4.5 配对页与登录页的版式

两页共用 `DshCenteredPage`：**整组垂直居中**，内容装不下时自动滚动。

- 顶部是 App 图标（`DshAppMark`，80dp 黑底圆角 + 白色手机字形），
  **复用启动图标的前景矢量**（`ic_launcher_foreground`），不另画「页面版 logo」——
  否则以后改图标要改两处，迟早漂移
- 标题、说明、错误提示一律居中；输入框落在屏幕中线附近（按钮在它下方，故略偏上 30–40dp）
- 配对页的三个状态（输地址 / 核对指纹 / 证书不符）**各自成一屏、都带图标**，
  而不是堆在一页里 —— 避免出现两个同级标题
- 指纹展示每 4 组一行、整体居中
- **间距由 `DshCenteredPage` 用 `Arrangement.spacedBy(12.dp)` 统一给，页面里不手写 `Spacer`**：
  手写时「输入框 → 按钮」这类相邻关系极易漏掉（0.2.1 就漏了，两者贴在一起）；
  统一间距还有个好处 —— `DshHint` / `DshError` 没内容时是空节点、不占位，报错出现时不会多出空隙

## 5. 里程碑

| 阶段 | 内容 | 状态 |
|---|---|---|
| **M0** | `:core` 抽取 + `:client` 骨架 + 外壳 APK 回归对照 | ✅ 已完成（2026-10-08） |
| **M1** | 配对 + 原生登录 + Keystore 存密码 + 401→自动重登 | ✅ 已完成（2026-10-08，**0.2** → 界面调整 **0.2.1**） |
| **M2** | 会话列表（`/api/sessions` + `/api/workspaces`、按工作区分组、折叠记忆、子会话缩进、新建会话含手输路径） | ✅ 已完成（2026-10-08，**0.3**） |
| M3 | 会话页（`/api/page` 首屏 + `/api/follow` SSE 三类帧、seq 排序、断线重连、切后台补齐）+ 发送（`requestId` 幂等 + 300ms 节流）/ 停止（两段式确认） | 待做 |
| M4 | Markdown 渲染器（与网页端 `renderMarkdown` 逐条一致）+ 代码块语言名/复制 | 待做 |
| M5 | 工作过程折叠 / 提问卡（含 `hold` 认领）/ 模型与模式 / 右侧刻度条 / 浅色主题 | 待做 |
| M6 | 通知 + 超级岛接入（复用 `:core`）+ release 打包（**要开 R8**）+ 真机验收 | 待做 |

### 5.1 Markdown 的对齐口径

以网页端 `lib/web/app.js` 的 `renderMarkdown` 为唯一基准，逐条对齐：
围栏代码（语言名 + 复制键）、表格（含对齐）、h1–h6、分隔线、引用、有序/无序列表
（含嵌套、序号起始、列表项续行）、任务列表、段落内换行、递归行内强调、行内代码、
链接（仅 http/https）、HTML 转义。**不做语法高亮**（网页端也没有）。

## 6. 已知代价与风险

1. **APK 体积**：debug 版 **22.7 MB**（未开 R8）。外壳版 72 KB。M6 打包 release 必须开 R8，
   预期降到 4–6 MB。这是原生 + Compose 的固有代价。
2. **外壳 APK 变大 6.9 KB**（64,972 → 71,882）：M0 的 dex 切分与库 R 类 +5,138，M1 给 `MirrorApi`
   加通用请求方法 +1,772。**资源与清单逐字节未变、dex 类集合 0 增 0 减**（§7）。
   若哪天在意这几 KB，可改用「共享源码目录」而不是库模块。
3. **双实现漂移**：网页端以后每加一个特性，原生侧不跟就会落后。缓解：语义留在宿主投影里，
   客户端只做渲染；M4 起把网页端的 markdown 样本做成两边共用的夹具。
4. **只做浅色**与「追平网页端全部特性」有一处**刻意差异**：网页端跟随系统深浅色，原生端不跟随。
   token 是一套别名，将来要加深色只需补一份暗色取值。
5. **构建环境**：`JAVA_HOME` 必须指向 Zulu 21（本机默认是 jdk-26，AGP 8.5.2 会拒绝）。
6. **真机迭代慢**：本会话的模型**读不了图片**（`read_image` 报 model does not declare image input），
   视觉只能靠「截图数值化 + DSH token」推进，最终要用户看图反馈。

## 7. M0 验收证据（2026-10-08）

对照方式：`git archive HEAD android` 导出改动前的 `android/` 到临时目录，用同一个 JDK 干净构建，
再与新构建逐项对比。

| 项 | 改动前 | 改动后 | 结论 |
|---|---|---|---|
| `AndroidManifest.xml`（二进制） | SHA256 `6670D2A5…` | SHA256 `6670D2A5…` | **完全一致** |
| `resources.arsc` | 5,176 B | 5,176 B | 一致 |
| `res/*` 每个条目 | 12 项 | 12 项，逐条尺寸相同 | 一致 |
| dex 类定义集合 | 44 个类 | 47 个类 | **−0 个类，+3 个**：`dev.dsh.mirror.core.R` / `R$drawable` / `R$string` |
| `app-debug.apk` | 64,972 B | 70,110 B | +5,138 B（dex 切分 + 库 R 类） |
| `:client` 构建 | — | ✅ `client-debug.apk` 22,363,607 B | package `dev.dsh.mirror.client`、label `DSH镜像原生`、minSdk 29 / targetSdk 34、`color/icon_bg=#000000` |

命令：`JAVA_HOME=<zulu-21> ./gradlew clean :app:assembleDebug :client:assembleDebug` → `BUILD SUCCESSFUL`。

## 7.1 M1 验收证据（2026-10-08，0.2）

### 外壳回归（改 `:core` 的 `MirrorApi` 前后对照）

| 项 | 改动前 | 改动后 | 结论 |
|---|---|---|---|
| 所有非 dex 条目（manifest / resources.arsc / res/*） | — | — | **零差异** |
| dex 类定义集合 | 47 个类 | 47 个类 | **0 增 0 减** |
| `classes.dex` | 30,180 B | 31,952 B | +1,772 B（纯新增方法） |
| `app-debug.apk` | 70,110 B | 71,882 B | +1,772 B |

### 契约预演（不装手机、不用 adb，直接打本机插件）

| 复刻的请求 | 实测响应 | 说明 |
|---|---|---|
| `POST /login`，表单体 `username=…&password=…` | **303** `Location: /login?e=bad` | 回 `e=bad` 而不是 `e=missing`，说明**表单编码被正确解析** |
| 同上，密码含 `+ & = %`（已转义） | **303** `Location: /login?e=locked&s=1963` | 连发两次触发节流 → 正好命中代码里的 `Locked` 分支；`ceil(1963/1000)=2 秒` |
| `GET /api/sessions`（无 Cookie / 垃圾 Cookie） | **401** | 自动重登的触发信号 |
| `GET /health` / `GET /cert` | 200 | 配对探测用 |

### 产物

`client-debug.apk` 22,494,117 B，`versionCode=2` / `versionName=0.2`，
package `dev.dsh.mirror.client`，label `DSH镜像原生`。新类 `SecretVault` / `Pairing` /
`MirrorSession` / `LoginResult` / `Fetch` / `PairScreenKt` / `LoginScreenKt` /
`HomeScreenKt` / `ComponentsKt` 均已确认进包。

**0.2.1（同日，界面调整）**：配对页 / 登录页改成「图标 + 整组垂直居中」，配对页三个状态各自成一屏。
`client-debug.apk` 22,510,501 B，`versionCode=3` / `versionName=0.2.1`。
这次**只动 `:client`**，于是外壳 APK 可以拿 SHA256 直接比：改动前后都是
`78C3EF4C4405206D1719FBBB77DB02649E04BCB5C5B89C7D18D8E6DA4172ED39`，**逐字节一致**。

**0.2.2（同日，间距修正）**：用户真机发现三处「连在一起」—— 配对页输入框↔「连接」、
确认指纹页指纹块↔按钮、登录页密码框↔「登录」（还有账号框↔密码框，同一个毛病）。
改成由 `DshCenteredPage` 用 `Arrangement.spacedBy(12.dp)` 统一给间距。
`versionCode=4` / `versionName=0.2.2`，外壳 APK 仍 `78C3EF4C…` **逐字节一致**。
> 注意：`client-debug.apk` 尺寸与 0.2.1 **完全相同**（22,510,501 B），但 APK 级 SHA256 不同；
> dex 对照可证改动真的进包了 —— `classes5.dex` 94,096 → 97,168，且能查到 `Arrangement$SpacedAligned`。

## 7.2 M1 的设计要点

- **判登录成败只能看 `Location`，不能看状态码**：`lib/server.js` 的 `redirect()` 一律回 **303**，
  成功 `Location: /`、失败 `Location: /login?e=bad|locked|missing|unconfigured` —— 状态码完全一样。
- **票根直接从 `Set-Cookie` 拿**：原生没有 WebView，也不需要 —— `Set-Cookie` 是明文响应头，
  取「名字=值」存进 `ServerPrefs`，前台请求与后台服务共用同一份。
- **为什么非存密码不可**：宿主会话是**内存态**，DSH 一重启全清，票根必然频繁失效；
  存了密码才能在 401 时自动重登。密钥在 AndroidKeyStore 里不可导出，磁盘上只有 IV+密文。
- **自动重登只重试一次**：重登成功仍 401，说明密码已变，再循环只会把服务端的登录节流喂满。
- **`SecretVault` / `Pairing` 放 `:client` 而不是 `:core`**：外壳（WebView 版）用不到 ——
  它的配对在 `SetupActivity`、登录在网页表单、Cookie 由 `CookieManager` 管。放进共用模块只会给外壳白加体积。

## 7.3 M2 验收证据（2026-10-08，0.3）

### 契约（跑插件自己的代码路径，不是猜的）

用 `node` 直接调 `lib/mirror.js` 的 `normalizeSummary()` + `groupSessions()`，把真实输出打出来对照：

| 观察 | 结果 |
|---|---|
| item 字段 | `id / title / running / blank / agentAvailable / updatedAt / cwd / origin / parentSessionId / preset`（外加路由层补的 `pendingQuestion`） |
| **`title` / `preset` / `parentSessionId` / `cwd` 可能是真 `null`** | 是 —— `titleOf()` 读的是 `projections.values.title`，取不到就回 `null` |
| group 字段 | `key / name / path / items / updatedAt / running` |
| group 顺序 | 组内按 updatedAt 降序；组间按最新活动降序；**「无工作区」垫底** |
| `workspaceOf` | key 小写归一（`D:\Foo\` 与 `d:\foo` 同组）；`null`/`""` → 无工作区 |

**这条实测抓出一个真 bug**：Android 的 `JSONObject.optString()` 遇到 JSON `null` 会返回字符串
`"null"` 而不是空串 —— 那样每条无标题会话都会显示成「null」。已全部改走自带的 `str()` 判空。

### 产物与回归

| 项 | 结果 |
|---|---|
| 外壳 APK | `78C3EF4C…`，与 0.2.2 **逐字节一致**（M2 只动 `:client`） |
| `client-debug.apk` | 22,665,096 B，`versionCode=5` / `versionName=0.3` |
| 新增类 | `Sessions` / `SessionRow` / `SessionGroup` / `Workspace` / `SessionsResult` / `CreateResult` / `Send` / `Collapse` / `SessionListScreenKt` / `SheetsKt` 全部确认进包 |
| 删除 | `HomeScreenKt` 已从包里消失（M1 那个占位首页被会话列表取代） |

## 7.4 M2 的设计要点

- **排版数值逐条取自 `app.css` 的浅色那一套**（不是估的）：会话行 min 56dp、内距 12/10、
  圆点 9dp（上距 7）、标题 15.5sp/600 单行省略、相对时间靠右 12sp、标签 11.5sp 胶囊（间距 6）、
  子会话左缩进 30dp + 2dp 竖引导线；分组头 min 40dp、组名 12sp/650、数量 11sp、短路径右对齐 11sp。
  为此刻意在 `Dsh` 里另立了一组 `List*` token —— 列表要对齐的是**网页端**，
  与 DSH 桌面端的灰阶并不完全相同。
- **默认折叠**：照抄网页端 localStorage 语义（没记录 = 折叠），键 `dsh-mm-collapsed:<工作区key>`。
- **顺序**：父会话留在原位、子会话紧跟其后；末尾兜底循环保证跨工作区 / 父链缺失 / 成环时
  **任何一条都不会丢**（宁可位置不对，也不丢行）。
- **新建会话**：`workspaceId` 优先、`cwd` 兜底；文件夹清单拉不到也**不影响新建**（永远有手输绝对路径那一行）。
- **只读模式**：手机端**拿不到** `enablePrompt`（它只在 loopback 专享的 `/pair.json` 里，
  网页端是服务端渲染进 `<body data-enable-prompt>` 的）。所以不预判，撞上 403 就把服务端那句
  `message` 原样显示出来。
- **「连不上」与「服务端报错」分开**：新增 `Fetch.Failed` / `SessionsResult.Failed`。
  原来 500 会被归成「连不上电脑」—— 明明连上了，那是句假话。
- **M2 的边界**：会话页是 M3，所以点会话行只 toast 一句「会话页在下一步（M3）实现」，不假装能进去。

## 8. 待办

- [x] M1：配对 / 登录 / Keystore 存密码 / 自动重登（0.2）
- [x] M2：会话列表 / 工作区分组 / 折叠记忆 / 子会话缩进 / 新建会话（0.3）
- [ ] M2 的真机观感与交互待用户确认（列表密度、折叠手感、面板）
- [ ] M2 已知取舍：`/api/sessions` 的 500 会显示服务端 message；运行中圆点只做呼吸不做外发光（网页端有 box-shadow）
- [ ] `MirrorApi` 还需要补 **SSE 流读取**（M3 的 `/api/follow`）；POST 已经通用化，JSON 直接传 `contentType` 即可，不用再改 `:core`
- [ ] 真机验收 M1：登录成功 / 密码故意打错 / 重启 DSH 后自动重登（由用户装包验证）
- [ ] 通知重复问题：两个 App 并存时都会起前台服务轮询 → 装机只装原生版
- [ ] 视觉基准：`screenshots/` 已加入 `.gitignore`（用户指定），**README 不再引用这些图**
- [ ] M6 前决定 release 是否开 R8 与资源压缩
