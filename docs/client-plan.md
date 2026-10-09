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

### 4.4 首页与抽屉（参考截图实测）—— **0.4 已实现**

- 首页：白底，logo 居中在 **y≈44%**（实测 90×68px），底部输入区 **y≈88–97%**
- 抽屉：宽 **71.4% 屏宽**、白底；右侧遮罩 **≈32% 黑**

实现口径（0.4）：

- 44% **不是写死 padding**，而是上下两个 `weight`（0.44 / 0.56）分配剩余空间 ——
  换任何屏幕比例，logo 的视觉重心都还在那儿
- 首页顶栏**只有一个 `☰`**（DeepSeek 首页没有标题）；标题、`⟳`、`⋯` 全搬进抽屉头部，
  抽屉里另有一行「＋ 新建会话」
- logo 用**我们自己的**图标（`DshAppMark`：黑底圆角 + 手机字形，与启动图标同一份矢量），
  首页尺寸 88dp；DeepSeek 那只鲸鱼不复刻
- 抽屉用 material3 `ModalNavigationDrawer` + `ModalDrawerSheet`：`drawerShape = RectangleShape`
  （直角白板，不是 material 默认圆角）、遮罩 32% 黑、`fillMaxWidth(0.714f)`；返回键关抽屉
- **底部输入条 0.4 时是按钮，不是输入框**（点整条 = 开「新建会话」面板，右侧发送键刻意做成灰色禁用态）——
  **0.6 已改成真输入框**，见 §4.7：`BasicTextField`，有字时发送键变品牌蓝；但**真发**仍留给 M3
- 已知上限：`ModalDrawerSheet` 自带 `maxWidth = 360dp`，屏幕宽超过 ≈504dp 的设备上
  抽屉会被卡在 360dp（手机不受影响）
- 代价（做之前已与用户确认）：App 落地页不再是会话列表，看一眼「电脑在跑什么」
  要多一步（`☰` 或边缘滑一下）

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

### 4.6 字体（**0.5 已实现**）

三档，每档都能选 **内置 / 系统 / 从文件添加…**（入口在 `⋯ → 字体`）：

| 档 | 拉丁 | 中文 | 用在哪 |
|---|---|---|---|
| **界面** | JetBrains Mono | 得意黑 Smiley Sans | 标题、按钮、标签、分组名、配对页、登录页 |
| **正文** | JetBrains Mono | 思源黑体 Noto Sans SC | 会话长内容（**M3 起才有效果**，现在没有可见位置） |
| **等宽** | JetBrains Mono（三个真字重） | — | 代码块、证书指纹、路径 |

**为什么必须自建 fallback 链**：Compose 的 `FontFamily` **不按语种挑字体** —— 一个 `FontFamily`
里塞多个字体，它只按**字重**挑，缺字直接落到系统字体。要做到「英文走 JBM、汉字走得意黑」，
只能用 `Typeface.CustomFallbackBuilder` 把「拉丁打底 + 中文兜底 + 系统兜底」串成一条链，
再交给 Compose 的 `FontFamily(Typeface)`。这条路经用到的 API 全部是 **API 29**（= minSdk，
已在 SDK 的 `api-versions.xml` 里逐条核对）：`CustomFallbackBuilder(android.graphics.fonts.FontFamily)`、
`Font.Builder(Resources, int)`、`Font.Builder(File)` —— 不需要版本分支，也不需要反射。

- 字体体系与设置存储：`theme/DshFonts.kt`；把界面档铺到**全部 15 个**排版样式：`theme/DshTheme.kt`
  （逐个样式 copy，漏一个就会出现「大部分文字是新字体、个别地方还是系统字体」）
- 面板：`ui/FontSheet.kt`。导入走系统文件选择器，复制进 `filesDir/fonts/` 后**当场建一次 Typeface 校验**，
  读不出就当没选 —— 避免「选了但没生效」这种最难查的失败
- 「开源许可」面板读 `assets/licenses/` 下三份 OFL 原文。这是**合规动作**（OFL 要求随包附版权与许可全文），
  不是顺手加的附赠页
- 自定义字体**整档替换**：同一份文件同时顶替拉丁与中文两路，缺字回落系统。
  想做「拉丁用 A、中文用 B」的分语种指定，得再拆一层，等有需要再说
- **覆盖实测**（解析 `cmap` 逐字核对，见 §7.6）：界面用到的 509 个汉字/全角标点里，得意黑覆盖 505、
  思源黑体覆盖 507；缺的是 `☰ ⟳ ⋯ ▼` 这四个**当图标用的符号**，两者都没有 → 走系统兜底
  （0.4 已在真机上证明这台设备渲染得了 `⟳ ⋯`）。JBM 覆盖全部 ASCII

### 4.7 抽屉四级页 + 首页真输入框（**0.6 已实现**）

**抽屉变成一个页面栈**（0.6 之前「新建会话 / 更多 / 字体 / 开源许可」都是底部弹层）：

```
会话列表 ──⋯──▶ 更多 ──┬──▶ 字体 ──▶ 开源许可
   └──＋新建会话──▶ 新建会话（工作区清单 + 手输绝对路径）
```

- 每层头部统一 `DrawerPanel`：左边 `←`（U+2190，JBM 有该字形，**不靠系统字体兜底**）+ 19sp/600 标题；
  **头部留在滚动区外面** —— 弹层有拖柄可以下滑关掉，抽屉页没有，返回键跟着正文滚上去就等于没了
- 返回键**分层**：先回上一层，已经在会话列表那一层才关抽屉；许可页从哪进来就回哪一层（`licensesFrom`）
- 抽屉一关就复位到会话列表（`LaunchedEffect(drawerState.currentValue)`）
- **会话列表常驻，面板盖在它上面**（`Box` + 不透明面板 + 面板根部 `clickable` 吞点击）：
  否则每次从设置页返回都要重建列表 —— 重拉一次清单（闪一下「正在读取」）、滚动位置也回到顶部
- 0.6 之后 `ModalBottomSheet` 在客户端里**没有任何使用者**，`DshSheet` 随之删除（不留死代码）

**首页底部条从「按钮」变成真输入框**：

- `BasicTextField`，点一下聚焦、出键盘；右侧 `↑` 无字时灰、**有字变品牌蓝**
- 键盘靠清单里本来就有的 `windowSoftInputMode="adjustResize"` 把窗口缩短 —— 输入框自然贴到键盘上方，
  logo 被顶上去；**展开文件夹选择器**时 logo 额外缩到 56dp 并压到顶部给它腾地方
- **输入框下面一行**是文件夹：左边 `文件夹 · <当前>`（点开就地展开工作区清单，**最多半个窗口高**、超出自己滚动）、
  右边「选择新的文件夹」（展开手输绝对路径）。两个都在首页就地展开，不跳抽屉
- **0.6.1 修的两点**：① logo 缩不缩**只看选择器是否展开**，不再看输入框焦点 ——
  点文件夹按钮时输入框的焦点不一定被清掉，把焦点算进来会让选完文件夹后 logo 回不到中心；
  打开选择器时主动 `clearFocus()` 收键盘（半屏清单也需要地方）。② 清单高度从 132dp 改成「半个窗口」，
  `LocalConfiguration.screenHeightDp * 0.5f`（按**当前窗口**算而不是物理屏幕：万一键盘还在，
  按物理屏幕算会得出比可见区域还高的清单，直接顶出屏幕）
- 输入框里的字用**正文档**字体（JBM + 思源黑体）：打进去的就是会话内容，理应用会话内容的字体 ——
  顺带让正文档在 M3 之前就有个能看见的地方
- 文件夹是**必选**：宿主 `validateSessionCreate` 要求 `cwd` 与 `workspaceId` 至少给一个，两个都不给直接 400。
  默认值取**上次用过的**（`prefs/Composer.kt`，键 `dsh_mm_composer`），第一次用取清单里最新的那个
- **0.6 的边界（用户选定方案 ii）**：发送键**不真发**，只 toast「会话页在下一步（M3）实现」。
  输入框与文件夹选择先按 M3 的形状做好，等聊天页接上再打开开关。真发是两步：
  `POST /api/session` 建会话 → `POST /api/prompt {sessionId, requestId, text, timeZone}`
  —— **`/api/session` 不吃 prompt**（查过宿主 `createSession`，只认 `{cwd|workspaceId, preset}`）
- 已知上限：输入框**单行**（多行留给 M3 的正式输入框）；没加 `imePadding()` —— `adjustResize` 下窗口已经缩了，
  再加一次会把输入框顶高一整个键盘

### 4.8 顶栏图标与首页动画（**0.6.2 已实现**）

**为什么手画矢量图标**：`material-icons` 没进本机 Gradle 缓存（`plugins.gradle.org` 连不上），
`Icons.Filled.Refresh` 拿不到。更根本的问题是：`⟳`(U+27F3)、`⋯`(U+22EF)、`☰`(U+2630)
**三个内置字体里都没有**（0.5 的 cmap 核对已证），只能由**设备系统字体**兜底 ——
各家 ROM 的粗细、大小、圆角都不一样，观感不可控，也不是调字号能解决的。

所以 `res/drawable/` 下自建三个矢量（24dp viewport，零依赖）：

| 图标 | 画法 | 关键数值 |
|---|---|---|
| `ic_refresh` | 描边圆弧 + 圆头折线箭头 | 圆心 (12,12)、半径 6.5、**扫过 270°、右侧缺口 90°**；箭头落在弧的终点上、顺着顺时针方向；`strokeWidth=2` + `strokeLineCap/Join="round"` |
| `ic_more` | 三个实心圆点 | 半径 2.1，圆心 x = 6 / 12 / 18 —— 横向占 16.2 单位，与刷新图标视觉同高 |
| `ic_menu` | 三条圆头横线 | y = 7 / 12 / 17，x 从 4 到 20 |

`DshIconButton(icon, onClick, contentDescription, size = 40.dp, iconSize = 20.dp, color)`：
**所有图标共用 `iconSize`**，所以"省略号和刷新一样大"是同一行代码保证的，不靠眼调。
字形键 `DshGlyphButton` 只留给**内置字体确实有**的 `←`(U+2190) 与 `↑`(ASCII)。

**首页动画**：logo 的"移动 + 缩放"是同一段过渡的两个分量 —— 位置由上下两个 weight 的比值决定
（0.44/0.56 ↔ 0.06/0.94），所以**权重本身可以动画**，不必改成绝对坐标。配合
`animateDpAsState`（88dp ↔ 56dp）与选择器容器的 `AnimatedVisibility`，统一 `tween(220ms, FastOutSlowIn)`。
收起时 `pick` 已经是 `None`，所以另存一份"最后展开的是哪个"给内容用，否则内容先变空、动画只剩一片空白在缩。

### 4.9 会话页（**0.7 只读已实现**）

**首屏不走 `/api/page`**：它的 `before` 是**必填**（缺了 400 `missing-before`）。
网页端也是拿 `/api/follow?id=&max=200` 的**第一帧 snapshot** 当首屏，`/api/page?before=<最早 seq>`
只用来往上翻更早。原生侧照抄这个口径。

**契约**（读 `lib/mirror.js` 得到的，不是猜的）：

| 帧 | 载荷 |
|---|---|
| `snapshot` | `{header{id,cwd,createdAt,agentPreset}, cursor, hasMore, records[], projections, assistantStream{revision,activeAttempt{turn,step,nextIndex,stream[]}}}` |
| `event` | `{type,seq,time,data}` —— `user/message` / `assistant/message` / `tool/call` / `tool/result` / `turn/end`（**错误正文在 `data.error.message`**）等 |
| `stream` | 键名被压短：`k` = `start/text/reason/tool/block-start/block-end/usage/finish/end`，配 `i`（块下标）`t`（增量文本） |
| 心跳 | `": hb"`（20 秒一次），忽略 |

**断线重连 = 重新拿 snapshot 整体替换**：宿主没有 `id:` 行可续传，但每次连接都先发全量快照，
所以不需要维护"我收到了哪些 seq"的账，也不会错位。「切后台补齐」用同一招。

**列表倒着排**（`reverseLayout = true`，屏幕最下是 index 0）：新消息天然出现在底部、
不用手动滚到底；往上翻就是列表末端，翻页触发条件因此是"最后一个可见项接近末端"。

**重复 seq 必须挡掉**：行的 key 用 seq，撞 key 会让 LazyColumn 直接崩。

**渲染边界（0.7）**：纯文本 + ``` 围栏代码块（等宽 + 代码底色 + 横向滚动）；
思考与工具折成一行暗色摘要；**只有思考没有正文的助手消息整条不渲染**（与网页端 1.2.1 的修正一致）；
成功工具结果不显示、报错才占一行；`turn/end` 的错误正文单独一行红字。
完整 Markdown 是 M4，「工作过程」折叠卡是 M5。

**底部不做假输入框**：0.8 才接发送/停止，一条状态条（运行中 / 只读说明）比"按了没反应的输入框"诚实。

### 4.10 发送 / 停止 / 乐观回显（**0.8 已实现**）

**契约**（读 `lib/mirror.js` + `lib/server.js` 得到的）：

| 接口 | 请求体 | 要点 |
|---|---|---|
| `POST /api/prompt` | `{sessionId, requestId, text, timeZone?}` | `requestId` 形状 `[A-Za-z0-9_-]{1,128}`（**会被上游当幂等键**）；宿主**先查幂等台账、再看节流**，所以同一个 id 重发不会被 429 挡；300ms 内第二次发 → **429 `too-fast`**；只支持纯文本（图片要 base64 走准入管道、文件要先上传，都不在这一版） |
| `POST /api/cancel` | `{sessionId}` —— **只有这一个字段** | 与网页端逐字一致 |

**乐观回显**（用户选定）：发送时先把这句话上屏（`pending`），宿主回显的权威版本到达时按**文本**撤掉乐观那条。
`pending` 渲染在所有已落库的行**之下**（也就是屏幕更靠下），所以撤换那一刻位置不变、看不出跳动。

**重试必须复用同一个 requestId**：弱网下"发出去了但没收到响应"是常态，换新 id 就会真发两遍。
失败时把文本还给输入框（`restore`），下一次发送沿用原 id。

**停止是两段式**：第一下只把按钮点亮成红的"再点一次停止"（3 秒没跟上自动复位），第二下才真发 `/api/cancel`。
网页端当初这么做是因为 `window.confirm` 在 WebView 里恒为 false；手机上误触停止的代价（整轮白跑）也确实比多一次点击大。

**首页真发是两步**：宿主 `/api/session` **不吃 prompt** → 先建会话拿 id → 进会话页 → 拿到第一帧快照后再 `/api/prompt` 发首句
（`ChatTarget.initialPrompt`）。这样乐观回显与宿主回显落在同一个地方。

**Enter 保持换行、不发送**（与网页端一致）；输入框最多 5 行 / 120dp。

### 4.11 Markdown 渲染（**0.9 已实现**）

**口径：与网页端 `renderMarkdown` 逐条一致** —— 不是"自己写一套更标准的 Markdown"。
`ui/MdParse.kt` 是 `lib/web/app.js` 里 `renderMarkdown` / `mdInline` / `mdEmphasis` 的**逐行移植**，
连两个反直觉的做法都照搬：

1. **在"已转义"的文本上解析**（网页端先 `esc()` 再匹配标记）。所以 `<b>` 永远出不来、引号是 `&quot;`、
   自动链接靠找 `&lt;`。树里存**原始**文本，只有匹配时才用转义形态 —— 这条不做，`&amp;` 就会被转两次。
2. **行内代码先摘成占位符**（`\u0000C<序号>\u0000`），内容不参与任何标记解析，最后递归还原
   （占位符可能落在粗体里、链接文字里）。

块扫描顺序也刻意与那边一致：围栏 → 空行 → 表格 → 标题 → 水平线 → 引用 → 列表 → 续行 → 段落。

**支持**：六级标题、段落硬换行、无序/有序列表（三层嵌套、认起始号、续行并进同一项）、引用、水平线、
围栏代码块（语言名 + 复制键）、GFM 表格（对齐、`\|` 转义、横向滚动）、任务列表、行内
粗/斜/粗斜/删除/代码/链接/图片/自动链接；`javascript:` 与 `data:` 链接**降级成纯文本**，裸 HTML 一律转义。

**渲染数值全部照抄 `lib/web/app.css` 的 `.md` 段**（px 直接当 dp / sp，因为网页端气泡基准就是 14px、
与本模块 `Dsh.BodySize` 相同）：h1 21 / h2 19 / h3 17.5 / h4-6 16.5、行高 1.75、段间距 13、
列表缩进 24（嵌套 18）、表格 13.5sp + 表头 `--chip` 底 + 偶数行 `--row-alt`、
代码块 12.5sp + 头部条 `--code-head`、引用左侧 3px `--me-line` 竖条。
**外边距按 CSS 的折叠规则**处理（相邻取较大者，首块上边距与末块下边距不补）。
为此给 `Dsh` 补了 7 个网页端有、原先缺的色：`FgStrong / FgSoft / FgMuted / Dim2 / CodeHead / MeLine / RowAlt`。

**三处有意不同**（都写进代码注释）：
1. 行内代码只给底色 + 等宽，没有 1px 描边与左右 padding —— Compose 的 `SpanStyle` 画不了；
2. **图片渲染成占位** `[图片 alt]`（真加载要解决宿主附件的地址与鉴权，用户同意留到后面单独一版）；
3. 表格按内容宽度排（网页端是 `width:100%`），窄表不会撑满整行；宽表一样横向滚动。

**落点**：用户气泡与助手正文都走 `MarkdownView`（网页端同一个 `renderBlocksInto` 入口，两种角色都渲染）；
**流式气泡仍是纯文本**（网页端 `live-text` 也不渲染 markdown，最终消息到达时整条替换）。

**验证方式**：`tools/web-pure-test.cjs` 里那批断言**逐条搬成 JUnit 5 用例**
（`client/src/test/.../MarkdownTest.kt`，9 个用例 ≈40 条断言）：测试里用手写的 `toHtml()`
把块树序列化成与网页端**一模一样**的 HTML 形态再比对 —— 所以"两边一致"是机器钉住的，不靠肉眼。
单测依赖 `junit-jupiter 5.10.2`（**本机 Gradle 缓存里已有**，`--offline` 可跑，不需要联网）。

### 4.12 贴底跟随（**0.9.1 已实现**）

用户报"会话页不会随着思考与工具调用自动滚到最下" —— 查证结论：**是漏了，不是设计取舍**。
网页端有整套 `state.stick`（`STICK_GAP = 80`、`if (state.stick) stickToBottom(false)`、
右下角 `btnBottom` 键、上翻加载更早时 `stick = false` 并保持视觉位置），0.7 只搬了"上翻加载更早"那半。

**判定的时机与判据（这里有个坑，值得单独记）**

判定**只在滚动停止的那一刻**做：

```kotlin
snapshotFlow { listState.isScrollInProgress }.collect { scrolling ->
    if (!scrolling) stick = listState.firstVisibleItemIndex == 0 &&
        listState.firstVisibleItemScrollOffset <= stickGap   // 80dp，对齐网页端 STICK_GAP
}
```

**不能**直接盯着 `firstVisibleItemIndex`：新内容插进倒排列表的 index 0 时，Compose 会按 item key
**重锚定** —— 上一刻还贴着底，插入后 `firstVisibleItemIndex` 就变成 1 了，跟着判定就会把"正在跟随"
误判成"用户滚走了"，于是跟随自己把自己关掉（越修越不跟随）。所以判据只能是"用户的手停下来时，
视口是不是还在底部附近"。

内容变化（`rows.size` / `pending.size` / `liveText.length` / `liveThink` / `liveTools.size`）时：

```kotlin
if (stick && !listState.isScrollInProgress) listState.scrollToItem(0)   // 不加动画
```

不加动画是因为网页端也是 `stickToBottom(false)`：流式输出几十毫秒变一次，动画会互相打架。
`!isScrollInProgress` 保证用户手指按着拖的时候不去抢滚动位置。

不贴底时右下角浮出"回到底部"键（对齐网页端 `btnBottom`），点了 `animateScrollToItem(0)` 并恢复跟随；
上翻加载更早之后因为视口已不在底部，`stick` 会自然保持 false（视觉位置由 Compose 按 key 锚定保住）。

### 4.13 表格与文件芯片重写（**0.9.2 已实现**）

用户报「markdown 显示有问题」，附真机截图。查证结论（**不是解析错，是排版错**）：

| 现象 | 根因 |
|---|---|
| 最上面两个空的灰色小格子、跟下面不对齐 | 消息里那张表的表头原文就是 `| | |`（两个空单元格）。**桌面端 DSH 会把整行空表头丢掉**，我的渲染器照画了 |
| 手机上「都是格子」 | 每个单元格都画了四边边框；桌面端只有横线 |
| 「其他的也没对齐」 | 表格是**每行一个独立 Row**、单元格按各自内容定宽 → 每行算出的列宽都不同，列根本对不上 |
| `[0.9.1](相对路径)` 露出裸 markdown、被右边缘裁掉 | ① 解析器只认 http(s)，相对路径降级成纯文本；② 单元格在横向滚动容器里**最大宽度无限** → 不换行、直接溢出 |
| 行内代码挤在一起 | 只给底色，没有左右内边距 |

**改法（用户拍板：好看优先，可以不一致 → 向桌面端观感看齐）**

1. **表格重写**：先用 `rememberTextMeasurer()` 量出每列的**自然宽度**（表头 + 所有行取最大），
   **全表共用同一组列宽** → 列严格对齐、单元格有界所以内容正常换行；窄表把富余按比例分掉撑满整行，
   宽表按比例压缩、压到 44dp 最小宽还超才横向滚动；边框**只画横线**（上/行间/下）；
   **整行全空的表头不画**（`MdBlock.Table.hasHeader()`）。
2. **本地文件链接** → 蓝色芯片（`Dsh.BrandChipBg` 底 + `Dsh.BrandChipFg` 字），点击复制路径
   （真正的下载见 §8 待办里的 0.10）。解析器相应扩展：`classifyUrl()` 把目标分成 Web / File / Reject ——
   带协议但不是 http(s) 的一律 Reject（`javascript:` / `data:` / `mailto:` 继续降级成纯文本，安全底线不变），
   不带协议的相对路径与盘符路径（`D:/x`）算 File。
3. **行内代码**：底色 + 两侧各垫一个**不换行空格**当内边距（`SpanStyle` 画不了 padding，
   垫 nbsp 是唯一能在底色内部做出留白的办法；nbsp 不换行，所以代码块边缘不会被拆开）。
4. 为了能在 composable 之外量文字宽度，行内构建改成**普通函数** + 一个 `MdCtx`（等宽字体 / 图片占位文案 /
   文件芯片点击回调）。

### 4.14 「工作过程」合并与设置面板（**0.9.3 已实现**）

用户报：会话里 `run_code` 那些卡片太吵 —— 「`run_code` 后面跟着中文字符（那句简短解释）」，
再后面还有 `run_code {"code":"const R=…"}`（参数原文）。诉求：**只留那句解释**，工具名与参数都藏起来，
并且**和思考合成一条折叠块，标题叫「工作中」**；侧栏加**设置**，把字体设置收进去，并在设置里加
**「显示详细工作过程」**开关。

**改法**（对齐网页端的「工作过程」卡：*"它想了什么、动了什么"本来就是同一件事的两面*）：

1. **模型层**：`tool/call` 不再单独成行，先攒进 `workAcc`，落到下一条助手消息上
   （`ChatRow.Assistant.work`）；正文为空的那种（约 68%，网页端 1.2.1 起就不渲染气泡）改成发一条
   `ChatRow.Work` —— 气泡仍然没有，但工作过程以一行「工作过程 · N 步」留下。
   `rowsOf()` 从返回单行改成返回**列表**：`turn/end` 收尾时可能既要补一条攒下的工作过程、
   又要补一条系统提示。
2. **一步的文案**：优先取参数里的 `description`（`run_code` 那句简短解释），拿不到才退化成
   工具的中文名（`tool_run_code` 等 8 个新字符串）。**默认只显示这句**；设置里打开详细模式才显示
   「工具名 + 完整参数」。流式帧（`applyStream` 的 `tool`）里只有工具名、没有参数，
   所以那一步只能用中文名兜底。
3. **渲染**：`WorkBlock` 一条折叠卡 —— 收起时一行「工作中 · N 步」/「工作过程 · N 步」（带一个**画的**
   三角折叠标记，项目里不用字形箭头），展开后是「思考 N 字」+ 每步一句解释。流式那条走同一个
   `WorkBlock`，只是标题是「工作中」；落库的行一律「工作过程」（它们的过程确实结束了）。
4. **设置面板**：抽屉里的「更多」改名**设置**，「字体」→**字体设置**，新增「显示详细工作过程」开关
   （`Switch` + 可点整行），落盘在 `prefs/UiPrefs.kt`（独立 SharedPreferences 文件）。
   状态提到 `HomeWithDrawer` 里（设置面板改、会话页读，共同父级才只有一个实例）。

**顺手修的隐患**：LazyColumn 的 key 原来是 `"s" + seq`，而一条 `turn/end` 现在可能同时产出
`Work` 与 `Notice` 两条、seq 相同 → **key 会撞（撞了会崩）**。改成带上行的类型。

## 5. 里程碑

| 阶段 | 内容 | 状态 |
|---|---|---|
| **M0** | `:core` 抽取 + `:client` 骨架 + 外壳 APK 回归对照 | ✅ 已完成（2026-10-08） |
| **M1** | 配对 + 原生登录 + Keystore 存密码 + 401→自动重登 | ✅ 已完成（2026-10-08，**0.2** → 界面调整 **0.2.1**） |
| **M2** | 会话列表（`/api/sessions` + `/api/workspaces`、按工作区分组、折叠记忆、子会话缩进、新建会话含手输路径） | ✅ 已完成（2026-10-08，**0.3**） |
| **M2.5** | 首页（logo + 底部输入区）+ 左侧抽屉（会话列表搬入，方案 §4.4）—— 用户当场选了 B 方案，提前补上「像 DeepSeek」 | ✅ 已完成（2026-10-08，**0.4**） |
| **0.5** | 字体体系（三档 + 内置 JBM / 得意黑 / 思源黑体 + 自定义导入 + 开源许可，方案 §4.6）—— 刻意排在 M3 之前：M3/M4/M5 的排版都建立在它上面，M4 的代码块还要认领等宽档 | ✅ 已完成（2026-10-09，**0.5**） |
| **0.7 / 0.8** | M3 拆两档（用户选）：**0.7 = 会话页只读**（`/api/follow` 首帧 snapshot 当首屏 + 实时流 + 重连 + 上翻更早）；**0.8 = 发送 / 停止 + 乐观回显 + 首页真发** | 0.7 ✅ / 0.7.1 ✅（图标修正）/ 0.8 ✅（2026-10-09） |
| **0.6** | 抽屉四级页（新建会话 / 更多 / 字体 / 开源许可 全部搬进抽屉）+ 首页真输入框（含文件夹选择，方案 §4.7） | ✅ 已完成（2026-10-09，**0.6** → 修正 **0.6.1** → 图标/动画 **0.6.2**） |
| M3 | 会话页（`/api/page` 首屏 + `/api/follow` SSE 三类帧、seq 排序、断线重连、切后台补齐）+ 发送（`requestId` 幂等 + 300ms 节流）/ 停止（两段式确认） | 待做 |
| M4 | Markdown 渲染器（与网页端 `renderMarkdown` 逐条一致）+ 代码块语言名/复制 | ✅ 已完成（2026-10-09，**0.9**，单测 9/9） |
| M5 | 工作过程折叠 / 提问卡（含 `hold` 认领）/ 模型与模式 / 右侧刻度条 / 浅色主题 | 待做 |
| M6 | 通知 + 超级岛接入（复用 `:core`）+ release 打包（**要开 R8**）+ 真机验收 | 待做 |

### 5.1 Markdown 的对齐口径

以网页端 `lib/web/app.js` 的 `renderMarkdown` 为唯一基准，逐条对齐：
围栏代码（语言名 + 复制键）、表格（含对齐）、h1–h6、分隔线、引用、有序/无序列表
（含嵌套、序号起始、列表项续行）、任务列表、段落内换行、递归行内强调、行内代码、
链接（仅 http/https）、HTML 转义。**不做语法高亮**（网页端也没有）。

## 6. 已知代价与风险

1. **APK 体积**：debug 版 **42.0 MB**（0.5 起内置 20.24 MB 字体；0.4 是 22.7 MB）。外壳版 72 KB。
   M6 打包 release 要开 R8，但**字体压不掉**，release 大概 20 MB 上下。这是「内置字体 + 原生 + Compose」的固有代价。
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
7. **字体是原样内置的**：`res/font` 下 5 个文件（JBM 三个字重 0.8 MB + 得意黑 2.5 MB + 思源黑体 16.95 MB）
   刻意**不压缩**（`androidResources.noCompress`）—— 压缩条目拿不到 fd，`Font.Builder` 就只能整份读进内存
   （思源黑体那 17 MB 会变成一份 18 MB 的常驻 ByteBuffer）；不压缩就能 mmap，零堆占用，代价是 APK 大 6.8 MB。
   三份 OFL 要求随包附版权与许可全文，所以「开源许可」面板是合规动作而非附赠。
8. **合成粗体**：走 fallback 链的字体族只有一个字面，粗体是 Android 合成的
   （得意黑本来也只有 Oblique 一个字面）。等宽档是纯拉丁场景，用多字面 `FontFamily(Font(...))`，那里是真字重。
9. **字体面板这一版每档只能整体换一个字体**，不能分语种指定（见 §4.6）。
10. **0.6 的发送键不真发**：首页输入框与文件夹选择已按 M3 的形状做好，但按发送只提示「会话页在下一步（M3）实现」
    （用户选定方案 ii）。真发要两步（`/api/session` 建会话 → `/api/prompt`），M3 打开开关即可 ——
    `MirrorSession` 已有通用 POST，不用动 `:core`。
11. **抽屉的页面切换是「盖」而不是「换」**：会话列表一直留在组合里，面板盖在上面。代价是列表在后台继续跑它的
    生命周期刷新（`ON_RESUME` 自动刷新一次），收益是返回时不重拉、不丢滚动位置。面板根部那一下 `clickable` 是**必需的** ——
    没有它，面板空白处的点击会穿到下面的会话行。
12. **输入框没加 `imePadding()`**：`targetSdk 34` + `adjustResize` 下窗口自己会缩，再加 `imePadding` 会重复计算
    （输入框被顶高一整个键盘）。真机上若出现「输入框被键盘挡住」，才需要改成
    `setDecorFitsSystemWindows(false)` + `imePadding`。

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

## 7.5 0.4 验收证据（首页 + 抽屉，2026-10-08）

| 项 | 结果 |
|---|---|
| 外壳 APK | `78C3EF4C…`，仍与 0.2.2 / 0.3 **逐字节一致**（只动 `:client`） |
| `client-debug.apk` | 22,681,904 B，`versionCode=6` / `versionName=0.4` |
| 新增/变化符号 | `HomeScreenKt` / `HomeComposer` / `NewSessionRow` / `DshGlyphButton` / `ModalDrawerSheet` 确认进包 |
| 结构变化 | `SessionListScreen` 从「整页」改成「抽屉内容」；`reloadKey` 与两个面板上提到 `HomeWithDrawer`（首页输入条与抽屉「＋」共用同一个面板实例） |
| 交付 | `out/dsh-mobile-mirror-client-0.4.apk`，SHA256 `FA210CDD…` |

## 7.6 0.5 验收证据（字体，2026-10-09）

| 项 | 结果 |
|---|---|
| 外壳 APK | `78C3EF4C…`，仍与 0.2.2 / 0.3 / 0.4 **逐字节一致**（只动 `:client`） |
| `client-debug.apk` | 44,017,396 B（41.98 MB），`versionCode=7` / `versionName=0.5`（**干净构建**） |
| 字体入包 | `res/font/` 5 个条目**全部 store（未压缩）**、可 mmap：JBM 270,224 / 274,096 / 273,504 B、得意黑 2,629,764 B、思源黑体 17,772,300 B |
| 许可入包 | `assets/licenses/` 三份 OFL 原文（4,399 / 4,422 / 4,388 B） |
| 覆盖实测 | 解析三个字体的 `cmap`，与界面源码 + `strings.xml` 里用到的 525 个非 ASCII 字符比对：得意黑缺 4（`⋯ ▼ ☰ ⟳`）、思源黑体缺 2（`☰ ⟳`）、JBM 缺 511（全是汉字，符合预期）；**三者 ASCII 均 0 缺** |
| 接线检查 | 全模块 `grep` 字体族引用：全部集中在 `DshFonts.kt`，两处等宽用法走 `LocalDshFonts.current.mono`，无硬编码残留 |
| 交付 | `out/dsh-mobile-mirror-client-0.5.apk`，SHA256 `4D1CC614…`（**干净构建**；增量构建会多出 ~256 KB 页对齐填充 —— 项目里早有这条规矩） |
| **未验证** | 链式 fallback 的**运行时行为与观感只能真机看**（本会话不能跑 adb、读不了图）：JBM 是否真的接管拉丁、得意黑是否真的接管汉字、合成粗体能否接受 |

字体来源与校验（全部取自官方仓库 / Release，**未做任何裁剪或改名**，遵守 OFL 的保留字体名条款）：

| 文件 | 字节 | SHA256（前 16） |
|---|---|---|
| `jbm_regular.ttf` | 270,224 | `E6FD0D7E91550B3E` |
| `jbm_bold.ttf` | 274,096 | `D22C4F3821D725EB` |
| `jbm_semibold.ttf` | 273,504 | `12D4B18FE6E1AF52` |
| `smiley_sans_oblique.ttf` | 2,629,764 | `B447D7E781F08BC9` |
| `noto_sans_sc.ttf` | 17,772,300 | `A3041811A78C361B` |

## 7.7 0.6 验收证据（抽屉四级页 + 首页真输入框，2026-10-09）

| 项 | 结果 |
|---|---|
| 外壳 APK | `78C3EF4C…`，仍与 0.2.2 / 0.3 / 0.4 / 0.5 **逐字节一致**（只动 `:client`） |
| `client-debug.apk` | 44,069,096 B（42.03 MB），`versionCode=8` / `versionName=0.6`（**干净构建**） |
| 体积增量 | 比 0.5 只多 51,700 B（纯代码 + 字符串）；字体 5 个条目仍**全部 store**、共 21,219,888 B |
| 结构变化 | 删 `ui/Sheets.kt` 与 `ui/FontSheet.kt` → 新增 `ui/Panels.kt`（`DrawerPanel` / `PanelNote` / `PanelOption` / `MorePanel` / `NewSessionPanel`）+ `ui/FontPanel.kt`（`FontPanel` / `LicensePanel`，正文一字未改）；`ui/HomeScreen.kt` 重写底部条；新增 `prefs/Composer.kt` |
| 死代码清理 | `DshSheet` / `SheetNote` / `SheetOption` / `MoreSheet` / `NewSessionSheet` / `FontSheet` / `LicenseSheet` 全模块 grep **0 残留**；`ModalBottomSheet` 只剩注释里一处提及 |
| 构建告警 | `gradlew` 输出里 `e:` / `w:` 均为 0 |
| 交付 | `out/dsh-mobile-mirror-client-0.6.apk`，SHA256 `D58621420C4F0BEDE830D5FE936BE36D41026AF8BF58F77A7BCFE92DDB814D78` |
| **未验证** | 抽屉层级切换手感、返回键分层、键盘弹出后 logo 上移与输入框位置、文件夹就地展开是否顺手 —— 都要真机看（本会话不能跑 adb、读不了图） |

> 注意：**体积不能当改动的证据**。`licensesFrom` 那处修正前后，APK 字节数一模一样（44,069,096 B），
> SHA256 从 `42A36236…` 变成 `D5862142…` —— 只有哈希能证明内容变了。

## 7.8 0.6.1 验收证据（两处修正，2026-10-09）

用户真机试 0.6 后报的两点，都改在 `:client`：

| 问题 | 根因 | 修法 |
|---|---|---|
| 选完文件夹后 logo 回不到中心 | `compact`（logo 缩小上移）同时看「输入框有焦点」；点文件夹按钮时输入框焦点没被清掉，键盘还开着，所以 `compact` 一直是 true | `compact` 只看 `pick != None`；打开选择器时 `focus.clearFocus()` 收键盘；选中后也清一次 |
| 工作区清单太短（只有两行高） | 高度写死 `heightIn(max = 132.dp)` | 改成 `LocalConfiguration.screenHeightDp.dp * 0.5f`，**跟着内容长、最多半个窗口**，超出自己滚动 |

| 项 | 结果 |
|---|---|
| 外壳 APK | `78C3EF4C…`（71,882 B），仍与 0.2.2 / 0.3 / 0.4 / 0.5 / 0.6 **逐字节一致** |
| `client-debug.apk` | 44,069,104 B（42.03 MB），`versionCode=9` / `versionName=0.6.1`（**干净构建**） |
| 构建告警 | `gradlew` 输出里 `e:` / `w:` 均为 0 |
| 交付 | `out/dsh-mobile-mirror-client-0.6.1.apk`，SHA256 `10E33A44CB3F135BC060480CA2AF5E67B0CEF7215BE74BF87AE030D580506E22` |
| **未验证** | 修完的观感仍要真机看：选完文件夹 logo 是否回中心、半屏清单是否够用、键盘与清单不再打架 |

> 又一条体积陷阱：0.6 是 44,069,096 B、0.6.1 是 44,069,104 B —— **只差 8 字节**，内容却改了两处。哈希：`D5862142…` → `10E33A44…`。

## 7.9 0.6.2 验收证据（图标 + 动画，2026-10-09）

| 项 | 结果 |
|---|---|
| 外壳 APK | `78C3EF4C…`（71,882 B），仍与 0.2.2 / 0.3 / 0.4 / 0.5 / 0.6 / 0.6.1 **逐字节一致** |
| `client-debug.apk` | 44,072,101 B（42.03 MB），`versionCode=10` / `versionName=0.6.2`（**干净构建**） |
| 三个矢量入包 | `res/drawable/ic_refresh.xml` / `ic_more.xml` / `ic_menu.xml` 均在 APK 内 |
| 几何自检 | 把路径数据**自己栅格化成 ASCII** 核对（本会话看不到图片）：刷新弧圆心 (12.01,12.00)、半径 6.50、扫过 **269.9°**、右侧缺口 **90.1°**，箭头终点与弧终点同为 (16.6,7.4)；点与横线全部落在 24×24 视口内 |
| 构建告警 | `gradlew` 输出里 `e:` / `w:` 均为 0 |
| 交付 | `out/dsh-mobile-mirror-client-0.6.2.apk`，SHA256 `72CCFA416B256A56A4403F7110982904A2CEAECFB79FF72FE664D5A6FB589ACA` |
| **未验证** | 图标在真机上的粗细观感、动画是否够顺 —— 只能真机看 |

> 栅格化脚本踩的坑：SVG 弧的角度公式里第一项是 `(x1' - cx')/rx`（中点坐标系），
> 我误写成 `(x0 - cx')/rx`，导致扫过角度算成 277°（正确是 270°）。**圆心与半径是对的**，
> 所以只看这两个数不会发现 —— 这也是"自检脚本本身也要有可证伪的点"的例子。

## 7.10 0.7 验收证据（会话页只读，2026-10-09）

| 项 | 结果 |
|---|---|
| 外壳 APK | `78C3EF4C…`（71,882 B），仍与 0.2.2 / 0.3 / 0.4 / 0.5 / 0.6 / 0.6.1 / 0.6.2 **逐字节一致** |
| `client-debug.apk` | 44,210,961 B（42.16 MB），`versionCode=11` / `versionName=0.7`（**干净构建**） |
| 新增 | `net/Follow.kt`（SSE：自建 pinned 连接 + 逐行解析 + 指数退避重连 + 401 自动重登）、`net/Session.kt`（`/api/page` 翻页）、`ui/ChatModel.kt`（帧 → 行）、`ui/ChatScreen.kt`、`ui/MessageRow.kt` |
| 改动 | `MainActivity`（会话页盖在首页与抽屉之上，两者保持组合）、`SessionListScreen`（点会话真跳转，不再是 toast）、`strings.xml`（20 条）、`DshTheme`（`Err`/`ErrBg`） |
| **`:core` 零改动** | SSE 用的是 `:core` 的**公开** `CertPinner.trustManager()` 与 `ServerPrefs`，没有给 `:core` 加流式接口 —— 这正是外壳 APK 还能逐字节一致的原因 |
| 构建告警 | `gradlew` 输出里 `e:` / `w:` 均为 0 |
| 交付 | `out/dsh-mobile-mirror-client-0.7.apk`，SHA256 `4CC5E4158E6C7B76AF2A0FCD22A88F30CFB19C3FA498082F1C6C1E5EAB47D34F` |
| **未验证** | 真机上的实时跟随、断线重连、上翻加载、键盘/滚动手感 —— 都要真机看（本会话跑不了 adb、读不了图） |

> 静态自查抓到并当场修掉的一处：重复 seq 会让两个 item 撞 key，LazyColumn 会直接崩 ——
> 加了"水位"防线（`lastSeq`），并且快照到达时把水位设成快照里的最大 seq（不是清零）。

## 7.11 0.7.1 验收证据（刷新图标修正，2026-10-09）

用户真机反馈：顶栏刷新图标的**箭头有一部分和圆环重合**。

**根因（栅格化量出来的，不是观感）**：弧 `M16.6,16.6 A6.5,6.5 0 1 1 16.6,7.4` 圆心 (12.005,12)、
半径 6.5、覆盖 **45°–315°**（右侧留 90° 缺口），描边 2 → 环带占半径 **5.5–7.5**，两端圆头端帽再外扩 1。
旧箭头 `M12.6,6.6 L16.6,7.4 L15.8,3.4` 的起点距圆心只有 **5.43** —— 在环带**里面**，终点又是弧末端，
于是这一段从环内穿到环上，穿过环带时落在 **276°–292°**，而这段角度正是环本体（缺口只在 −45°–45°）
→ 尾巴实实在在压在环上，量得 **4.00 u²**。

**修法**：只换箭头那一条 path，**弧一个数字不动**。新箭头
`M18.23,7.14 L18.62,9.75 L16.18,8.74` —— 沿顺时针切线（指向右下，与弧走向一致）、整个落在 90° 缺口里，
三点距圆心 7.70 / 7.22 / 5.13，压在环上的面积 **0**，只在弧末端圆头处相接（本来就该连的地方）。

**为什么把约束写进 XML 注释**：不写下来，下次调这个图标的人一定会再踩一次。

| 项 | 结果 |
|---|---|
| 外壳 APK | `78C3EF4C…`（71,882 B），仍逐字节一致 |
| `client-debug.apk` | 44,210,977 B（42.16 MB），`versionCode=12` / `versionName=0.7.1` |
| 图标复核 | 解包读 `res/drawable/ic_refresh.xml`：弧仍是 `M16.6,16.6 A6.5,6.5 0 1 1 16.6,7.4`，箭头已是新的，旧路径 `M12.6,6.6…` 消失 |
| 交付 | `out/dsh-mobile-mirror-client-0.7.1.apk`，SHA256 `06EBD4DA30E69790C67A40CCE79D4602C52C2DA5E34C7F9ABCB8CA87181252A7` |

> 注意：**不能**用「APK 里搜路径字符串」来验矢量 —— `res/**.xml` 在 APK 里是 deflate 压缩的，
> 原始字节搜不到（只有 `resources.arsc` 里的字符串能直接搜到）。要解包或 `aapt2 dump xmltree`。

## 7.12 0.8 验收证据（发送 / 停止 / 乐观回显，2026-10-09）

| 项 | 结果 |
|---|---|
| 外壳 APK | `78C3EF4C…`（71,882 B），仍逐字节一致（`:core` / `:app` 零改动） |
| `client-debug.apk` | 44,246,981 B（42.20 MB），`versionCode=13` / `versionName=0.8`（干净构建） |
| 新增 | `net/Session.kt` 的 `prompt()` / `cancel()`（+ `SendOutcome`，429 → `TooFast`）、`ChatTarget`、`ChatModel.send/cancel/restore`、`ChatComposer` |
| 改动 | `ChatScreen`（真输入框 + 两段式停止 + 乐观条）、`HomeScreen`（占位 toast → 真发，签名加 `onSend`）、`MainActivity`（建会话 → 进会话页 → 发首句）、`strings.xml`（+8） |
| 构建告警 | `e:` / `w:` 均为 0 |
| 交付 | `out/dsh-mobile-mirror-client-0.8.apk`，SHA256 `E65E0144426C0F4B9B773F684D2AF49AE5550F2805EA38C56D3D616E1A10FF55` |
| **未验证** | 真机上的发送/停止/乐观回显、键盘弹起后输入框位置、Enter 换行、连点与节流提示 |

> 0.8 **包含 0.7.1 的刷新图标修正**（图标在 `:client` 里，两条路一起出）。0.7.1 单独出过一版
> （`out/dsh-mobile-mirror-client-0.7.1.apk`），装了 0.7 的人直接上 0.8 即可。

## 7.13 0.9 验收证据（Markdown，2026-10-09）

| 项 | 结果 |
|---|---|
| 单测 | `:client:testDebugUnitTest` **9 个用例 / 0 失败**（≈40 条断言搬自 `web-pure-test.cjs`） |
| 外壳 APK | `78C3EF4C…`（71,882 B），仍逐字节一致 |
| `client-debug.apk` | 44,330,469 B（42.28 MB），`versionCode=14` / `versionName=0.9`（干净构建） |
| 构建告警 | `e:` / `w:` 均为 0 |
| 新增 | `ui/MdParse.kt`（解析器，504 行）、`ui/MarkdownView.kt`（渲染，约 400 行）、`src/test/.../MarkdownTest.kt` |
| 改动 | `ui/MessageRow.kt`（`SegmentedText`/围栏切段删除，正文换 `MarkdownView`）、`theme/DshTheme.kt`（+7 色）、`strings.xml`（+4）、`client/build.gradle.kts`（JUnit 5 + `useJUnitPlatform`） |
| 交付 | `out/dsh-mobile-mirror-client-0.9.apk`，SHA256 `7962781A20359E5FF01C8405FD25AD5E15DE1D8D2667153BB2C9AC81859FAE7C` |
| **未验证** | 真机观感（标题层级、表格横滚、代码块头部条与复制、任务列表勾选框、链接点击跳浏览器、图片占位） |

> 移植期唯一被测试抓到的问题：链接/图片的 `url` 忘了 `mdUnesc`，序列化时二次转义成 `&amp;amp;`。
> 这正是"把网页端的断言搬过来"的价值 —— 肉眼比对这个几乎不可能发现。

## 7.14 0.9.1 验收证据（贴底跟随，2026-10-09）

| 项 | 结果 |
|---|---|
| 单测 | 9 用例 / 0 失败（Markdown 那批不受影响） |
| 外壳 APK | `78C3EF4C…`（71,882 B），仍逐字节一致 |
| `client-debug.apk` | 44,346,857 B（42.29 MB），`versionCode=15` / `versionName=0.9.1`（干净构建） |
| 改动 | 只动 `ui/ChatScreen.kt`（+ 一个 `border`/`LocalDensity` import）与 `build.gradle.kts` 版本号 |
| 交付 | `out/dsh-mobile-mirror-client-0.9.1.apk`，SHA256 `3C43E3DFF76C89258BFC868AC535B89BB962802D52C7FC0CBBFA3D00BE850350` |
| **未验证** | 真机手势（跑不了 adb）：流式时是否始终贴底、上翻是否真的停住、回到底部键的浮出/收起时机 |

> 滚动这块**没法单测**（要真机手势），逻辑只能保证与网页端一一对应 —— 验收还得靠手。

## 7.15 0.9.2 验收证据（表格与文件芯片，2026-10-09）

| 项 | 结果 |
|---|---|
| 单测 | **11 用例 / 0 失败**（新增 `fileLinksBecomeChips`、`emptyHeaderRowIsDetected`） |
| 外壳 APK | `78C3EF4C…`（71,882 B），仍逐字节一致 |
| `client-debug.apk` | 44,363,653 B（42.31 MB），`versionCode=16` / `versionName=0.9.2`（干净构建） |
| 改动 | `ui/MarkdownView.kt`（表格重写 + 文件芯片 + 代码留白 + `MdCtx`）、`ui/MdParse.kt`（`classifyUrl` / `Link.file` / `Table.hasHeader`）、`strings.xml`、测试 |
| 交付 | `out/dsh-mobile-mirror-client-0.9.2.apk`，SHA256 `05A43756864DFC51260B24B07E30B3F67C127A3EB20F9252A5FF20791ED7FBE1` |
| **未验证** | 真机观感：列对齐、横线、空表头消失、文件芯片配色、行内代码留白 |

> 截图里那两条症状（空表头小格子、列不对齐）都能从**截图本身**量出来：表头两个格子只有 padding 宽、
> 与下面各行的单元格边界全不一致。表格这种「布局类」问题单测锁不住，只能靠真机图。

## 7.16 0.9.3 验收证据（工作过程合并 + 设置面板，2026-10-09）

| 项 | 结果 |
|---|---|
| 单测 | **11 用例 / 0 失败**（本次没动解析层，断言不变） |
| 外壳 APK | `78C3EF4C…`（71,882 B），仍逐字节一致 |
| `client-debug.apk` | 44,385,425 B（42.33 MB），`versionCode=17` / `versionName=0.9.3`（干净构建） |
| 改动 | `ui/ChatModel.kt`（WorkStep / rowsOf / 攒工作过程）、`ui/MessageRow.kt`（WorkBlock / 折叠标记）、`ui/ChatScreen.kt`（传 detail / live 块 / key 修隐患）、`ui/Panels.kt`（设置面板 + 开关）、`MainActivity.kt`、`prefs/UiPrefs.kt`（新）、`strings.xml` |
| 交付 | `out/dsh-mobile-mirror-client-0.9.3.apk`，SHA256 `7D35D627E35A9ECD6C7EFFDE58E3A3B57E13D57D6706293EECD5DABE845F0417` |
| **未验证** | 真机：折叠卡收起/展开、标题「工作中 → 工作过程」的切换、设置开关是否真的切换显示、字体设置是否还在设置里进得去 |

> 这一版全是**交互与排版**，单测锁不住（`rowsOf` 要 Context 才能跑，项目里没有 Robolectric）。
> 关键点只能真机看：跑一轮带 `run_code` 的对话，确认收起时只有一行、展开时每步只有一句中文解释。

## 8. 待办

- [x] 0.9：Markdown 渲染与网页端逐条一致（2026-10-09）
- [ ] 0.9 待真机确认：标题层级与间距、表格横向滚动、代码块头部条与复制键、任务列表勾选框、链接点击、图片占位
- [ ] 0.9 已知取舍：行内代码无描边/padding；图片只占位；表格按内容宽度（非 width:100%）
- [x] 会话页贴底跟随（用户 2026-10-09 报，**0.9.1** 已修，见 §4.12）
- [x] 0.9.1 会话页贴底跟随（已实现，真机待确认）
- [ ] 0.9.2 待真机确认：表格列对齐 / 只画横线 / 空表头消失 / 文件蓝色芯片 / 行内代码留白
- [ ] 0.9.3 待真机确认：工作过程折叠卡（收起/展开、标题切换）、设置里的开关与字体入口
- [ ] **0.10 文件下载**（用户 2026-10-09 提）：需要给插件加 `GET /api/file` 只读路由，见 §4.14 方案
- [x] 0.8：发送 / 停止 / 乐观回显 / 首页真发（2026-10-09）
- [ ] 0.8 待真机确认：发送与乐观回显、两段式停止、300ms 节流提示、Enter 换行、键盘弹起后输入框与列表位置、首页建会话→进会话页这条链
- [ ] 0.8 已知取舍：首页建会话不带 preset（宿主用默认）；`/api/prompt` 只支持纯文本，发图与附件要等准入管道
- [x] 0.7：会话页只读（首帧 snapshot 当首屏 + 实时流 + 重连 + 上翻更早）（2026-10-09）
- [ ] 0.7 待真机确认：实时跟随是否跟手、断线重连提示是否正常、上翻能否加载更早、长会话滚动性能
- [ ] 0.7 已知取舍：重连后只有最近 200 条（上翻出来的更早历史会被快照替换掉）；思考/工具还是一行摘要，完整折叠是 M5
- [x] 0.6.2：顶栏三个字形换成手画矢量（刷新 / 更多 / 菜单）+ 首页 logo 移动缩放与选择器展开收起加动画（2026-10-09）
- [ ] 0.6.2 待真机复看：三个图标的粗细观感、logo 动画是否顺、选择器展开收起是否自然
- [x] 0.6：抽屉四级页（新建会话 / 更多 / 字体 / 开源许可 全搬进抽屉）+ 首页真输入框 + 文件夹选择（2026-10-09）
- [ ] 0.6 的真机观感待用户确认：抽屉层级切换与返回键分层、键盘弹出后 logo 上移与输入框贴键盘的位置、文件夹就地展开
- [x] 0.6.1：修「选完文件夹 logo 不回中心」（`compact` 不再看焦点 + 打开选择器清焦点）与「清单太短」（132dp → 半个窗口）（2026-10-09）
- [ ] 0.6.1 待真机复看：选完文件夹 logo 是否回中心、半屏清单够不够用
- [ ] 0.6 的发送键是**占位**（只 toast）：M3 做聊天页时接上真发（`/api/session` → `/api/prompt`），并把输入框改成多行
- [x] 0.5：字体体系（三档 / 内置 JBM + 得意黑 + 思源黑体 / 自定义导入 / 开源许可）（2026-10-09）
- [ ] 0.5 的真机观感待用户确认：界面拉丁是否确实是 JBM、汉字是否确实是得意黑、合成粗体能否接受、字体面板与导入流程是否顺手
- [ ] 正文档**现在没有可见位置**（会话内容要等 M3）；M3 做聊天页时直接用 `LocalDshFonts.current.body`
- [ ] 字体面板的已知上限：每档只能整体换一个字体，不能分语种指定（要再拆一层，见 §4.6）
- [x] M1：配对 / 登录 / Keystore 存密码 / 自动重登（0.2）
- [x] M2：会话列表 / 工作区分组 / 折叠记忆 / 子会话缩进 / 新建会话（0.3）
- [ ] M2 的真机观感与交互待用户确认（列表密度、折叠手感、面板）
- [ ] 0.4 的首页/抽屉观感待用户确认：logo 是否落在 44%、抽屉宽度 71.4% 手感、遮罩深浅、底部条看起来像不像输入框
- [x] 首页底部条已换成真输入框（0.6：`BasicTextField` + 有字变品牌蓝）；**剩下「真发」这一步留给 M3**
- [ ] M2 已知取舍：`/api/sessions` 的 500 会显示服务端 message；运行中圆点只做呼吸不做外发光（网页端有 box-shadow）
- [ ] `MirrorApi` 还需要补 **SSE 流读取**（M3 的 `/api/follow`）；POST 已经通用化，JSON 直接传 `contentType` 即可，不用再改 `:core`
- [ ] 真机验收 M1：登录成功 / 密码故意打错 / 重启 DSH 后自动重登（由用户装包验证）
- [ ] 通知重复问题：两个 App 并存时都会起前台服务轮询 → 装机只装原生版
- [ ] 视觉基准：`screenshots/` 已加入 `.gitignore`（用户指定），**README 不再引用这些图**
- [ ] M6 前决定 release 是否开 R8 与资源压缩
