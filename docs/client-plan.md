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

### 4.3 模型 / 模式选择（**0.12 已实现**，见 §4.20）

输入条上方一颗胶囊（显示当前模型 + 推理档位），点开底部弹层，内含：模型（含推理档位）/ 模式。
触发键照 DSH 的 `wq12jW_trigger`：高 28px、圆角 8px、13px、chevron 展开时旋转 180°、`transition .12s`。

（草案里的「新建会话路径」没有并进这张卡：手机端选路径在首页文件夹行与「新建会话」页，不重复一遍。）

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
- **文件夹胶囊**：`文件夹 · <当前>` + 展开箭头（点开就地展开工作区清单，**最多半个窗口高**、超出自己滚动）。
  **0.12.2 起手输路径不再单列一个入口** —— 它是清单**末尾**的一行「其他路径…」（原来在胶囊右边是一行独立的蓝字）。
  两个入口本来就指向同一件事，摆成两处只会让人猜哪个是哪个；清单拉不到时那一行照样在，保住「清单挂了也能新建」
- **0.12.2 起底部是「胶囊 → 输入框」**（胶囊原来在输入框**下面**，挪到上面是为了与会话页一致）；
  **0.12.3 起三颗胶囊并排**：模型 / 模式 / 文件夹，见 §4.23
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

> 这一版**只把思考的字符数**折进卡里，正文并没有留下（展开只有一行「思考 N 字」）。
> 0.13 补上，见 §4.24。

### 4.15 下载文件（**0.10 已实现**）

用户提：**电脑端每次编译都会贴出文件，手机要能把它拿到本地**。拍板的四点：插件可以改；
范围 = **工作区目录内都可以**；单个文件上限 **1 GB**；交互 = **点一次先问「是否下载文件（文件名）？」，
再点才真的下**，存进系统的**「下载」目录**。

**插件侧（1.3.0）新增只读路由 `GET/HEAD /api/file?id=&path=`**：

- 绝对路径直接用；**相对路径按该会话的 cwd 解析**（不信手机传来的基准路径，只认会话 id）。
- 允许的根 = **登记过的工作区 ∪ 所有会话的 cwd** —— 与 `normalizeWorkspaces` 同一口径，
  正是用户说的"工作区目录内"。落不进去 → **403**。
- 目录 / 不存在 → 404；超过 **1 GB** → 413（截一半的文件比报错更糟）；缺 path、相对路径缺会话 id → 400。
- 支持 **Range**（206 / 416）与 HEAD —— 42 MB 的 APK 断点续传用得上；`Content-Disposition` 同时给
  ASCII 回退名与 `filename*=UTF-8''…`，中文文件名不会变成问号。
- **只读操作，所以不受 enablePrompt（只读模式）约束** —— 它不改变宿主状态。
- **软链接/目录联接防护**：根目录与目标都取 `realpathSync`，目标按真实路径**再查一次**包含关系
  （前缀判断挡不住指到工作区外面的联接）。

**客户端侧（0.10）**：

- 新增 `net/Download.kt`：与 `Follow` 同一套证书钉扎 + Cookie，流式写进
  `MediaStore.Downloads`（API 29+，正好是本应用下限）—— **不需要任何存储权限**，
  用 `IS_PENDING` 保证别的应用看不到半成品，失败时把半成品删掉。
- 文件芯片原来的动作是"复制路径"，现在改成**下载**（`MarkdownView(onFile = …)` 一路透到
  `ChatRowView`；用户自己发的气泡里不给下载动作）。设置里其它地方的预览仍保持复制路径。
- 对话框四态：**问** → **下载中（每 1% 刷一次进度）** → **完成（可"打开"）** / **失败（给中文原因）**。
  插件回的 `{error,message}` 里的中文直接显示，网络类错误另给友好文案。

### 4.16 「文件」卡与详细开关真正生效（**0.10.1 已实现**）

用户反馈两件事：① 电脑端（DSH 桌面端）会把这一轮产出的文件**挂在回复结尾**方便下载，
手机端没有；② 设置里的「显示详细工作过程」开关「是坏的」—— 打开后进正在工作的会话，工作过程还是收起的。

**① 文件卡（与电脑端同源）**：电脑端挂文件卡用的是 `deliverables/presented` 事件
（`present` 工具产生），形状是 `data.files = [{ path, description }]`。
镜像插件的 `projectEvent` 原来把它丢进 `default` 分支走「有界浅拷贝」—— 那个拷贝
**只抄一层、嵌套数组只报形状**，于是 `files` 变成 `[array]`，路径与说明全丢，
手机端既没数据也没渲染。

- 插件加 `deliverables/presented` 显式分支：只下发 `files: [{path, description}]`，
  条数封顶 20、路径 512 字符、说明 200 字符；**空清单整条不下发**（没有文件的 present
  不该在会话里留一行空气）。
- 客户端加 `ChatRow.Files`，渲染成「文件」卡：**一行一个文件**（文件名 + 电脑端那句说明），
  点一下走已有的下载流程（先问 → 再下 → 完成可打开）。位置就是**事件所在处**，
  与电脑端一致，不钉在屏幕底部。

**② 开关为什么「坏」**：它原来只控制**每一步显示什么文案**（简短解释 ↔ 工具名+参数），
**不控制折叠卡展不展开** —— 卡片永远默认收起，所以打开开关看不到任何变化。
另外 `var open by remember { mutableStateOf(false) }` **只读一次**，
在会话里现开开关，已经渲染出来的卡片也不会变。

- 改成 `remember { mutableStateOf(detail) }` + `LaunchedEffect(detail) { open = detail }`：
  开关打开 → 默认展开（仍可手动收起，用户拍板）；关闭 → 默认收起；会话里切换**立即生效**。
- 开关说明文案同步改成「打开后，工作过程默认展开，并显示工具名与完整参数」。

### 4.17 粗体字面、文件卡归位、翻页修复（**0.10.2 已实现**）

**① 粗体看不出来 —— 是字体的锅，不是解析的锅**

`MdParse` 正确产出 `Strong`、`MarkdownView` 也确实给了 `FontWeight.W700`，问题在字体：
界面/正文走的是 `Typeface.CustomFallbackBuilder` 串起来的**单字面链**，而
**Android 的合成粗体在自定义族上不生效**（代码注释里原本就写着「粗体是 Android 合成的」）。
等宽档用的是多字面 `FontFamily(Font(...))`，那里是真字重，所以一直没事。

- **造字**：新增 `tools/make-bold-font.py`，两条路：得意黑是**静态**字体（只有一个字面），
  用轮廓外扩（每点沿外法线推 20/1000 em）造粗体；思源黑体是**可变字体**（`wght 100-900`），
  直接 `instantiateVariableFont(..., {wght: 700})` 实例化 —— 那是**真字重**，比描边模拟正统得多。
  两者都按 OFL 的 **Reserved Font Name** 要求改名（`DSH Hei Bold` / `DSH Sans Bold`），版权与许可原样保留。
  产出 `dsh_hei_bold.ttf`（3.03 MB）+ `dsh_sans_bold.ttf`（13.51 MB）。
- **接线**：Compose 1.7 **没有** `Font(typeface, weight)` 重载，所以粗体只能由调用点显式换族：
  `FontSet` 增加 `uiBold` / `bodyBold`，`MarkdownView` 的标题、表头、`Strong`、`StrongEm` 与
  各面板的 `SemiBold` 文案都改成用粗体族。
- 代价：APK 42.4 MB → **58.93 MB**（两个粗体字面 +16.5 MB）。

**② 文件卡跑到总结上面去了**

`present` 是**工具调用**，事件顺序上在总结文字**之前**；电脑端是特意把文件挂到回复最末尾的。
手机端原来严格按事件顺序渲染，于是卡片落在总结上方。改法：文件先攒进 `filesAcc`，
等这一轮的 `assistant/message` 到了再作为**最后一行**发出（`turn/end` 兜底，快照/翻页收尾各补一次），
与电脑端位置一致。

**③ 往上翻就「连不上电脑」**

宿主 `sessionController.page` 的 `throughSeq` 是**会话头部游标**，不是「当前视图最早那条」：
官方用法是 `{ throughSeq: snapshot.cursor, beforeSeq: page.records[0].seq }`，且 `throughSeq === -1`
明确表示会话头。插件 1.3.1 及以前把两者都传成 `beforeSeq` —— 语义错了，大会话上读窗口又大又慢，
手机侧等超时 → `Unreachable` → 界面显示「连不上电脑」。当时改成 `throughSeq: -1`，并补了三条单测钉住参数。

> **0.10.3 更正：这一段的结论是错的，`-1` 那条改动把翻页彻底改死了。** 详见 §4.18①。

### 4.18 真字重、翻页参数与超时、输入法收起、长按选中（**0.10.3 已实现**）

**① 翻页：`-1` 不是「会话头」，是「什么都不返回」**

宿主 `paginate()` 的实现是：

```js
const end = SessionLogOffset(Math.min(throughSeq + 1, beforeSeq ?? throughSeq + 1));
return { events: events.slice(cut, end), hasMore: cut > 0 };
```

`throughSeq: -1` → `end = min(0, beforeSeq) = 0` → `slice(cut, 0)` **恒为空**，`hasMore` 恒为 false。
校验（`validatePageRequest`）只保证 `throughSeq >= -1`，它并不是「无上界」的哨兵值 ——
0.10.2 把它当会话头，结果是**不报错、没有内容，而且客户端把 `hasMore` 置 false 后再也不会请求**。

而 0.10.1 及以前的 `throughSeq: beforeSeq` 其实是对的（`end = min(before+1, before) = before`）。
当时「连不上电脑」的真凶在**客户端超时**：`MirrorApi.TIMEOUT_MS = 6000`（连接与读取共用），
宿主现场读整个会话日志再往前扫，大会话超过 6 秒 → `code <= 0` → `Fetch.Unreachable`。

- 插件：`throughSeq` 回到 `beforeSeq`，注释里把 `paginate()` 的公式写清楚，免得再有人把 `-1` 当哨兵。
- 客户端：`MirrorApi` 增加「按请求指定读取超时」的重载，`PAGE_TIMEOUT_MS = 30000` 只给 `/api/page`；
  连接超时仍是 6 秒。`MirrorSession.fetch(ctx, path, readTimeoutMs)` 走同一条 401 自愈路径。
- 客户端：翻页时顶部显示「正在读取更早的消息…」；按 `seq < before` 去重（重叠会撞 key 让 LazyColumn 崩）；
  服务端没给新记录就置 `hasMore = false`（否则会拿同一个 `before` 反复重试）。

**② 假粗体糊成一团 —— 换掉，改成可变字体真字重**

0.10.2 的粗体是「另造一个字面」：得意黑走轮廓外扩、思源黑体走 `wght=700` 实例化。
**思源黑体那个是真字重，没问题；得意黑那个糊了** —— 它笔画密、字腔小，外扩 20/1000 em 直接把笔画并到一起。
顺带查清了一件事：**会话正文一直是思源黑体**（`MarkdownView` 用 `LocalDshFonts.current.body`），
所以当初「正文粗体看不出来」的锅在思源黑体那条单字面链上，与得意黑无关。

- 删掉 `dsh_hei_bold.ttf`（3.17 MB）、`dsh_sans_bold.ttf`（14.16 MB）与 `tools/make-bold-font.py`。
- 正文改走**可变字体真字重**：`Font.Builder(res, R.font.noto_sans_sc).setFontVariationSettings("'wght' 400 / 700")`，
  真 400 与真 700，**不额外占体积**；顺带治好「正文偏细」（该字体默认实例是 `wght=100`）。
- 界面档的中文（得意黑）只有一个字面，粗体与正常共用它 —— 回到 0.10.1 的观感；
  界面里的英文/数字走 JBM Bold，是真粗体。
- 收益：APK 58.93 MB → **约 41.7 MB**。

**③ 输入法不收**

`ModalNavigationDrawer` 不会自己夺焦，首页输入框一直持有焦点，抽屉开着、键盘也开着。
改法：`MainActivity` 里取 `LocalFocusManager`，在**开抽屉、切抽屉页、进会话页**三处 `clearFocus()`。

**④ 长按选中与复制**

消息正文包 `SelectionContainer` —— 长按出系统那两个选择手柄 + 浮动工具条，拖手柄选任意范围；
用户气泡同样处理。

> **0.10.4 回退：另外加的那个「长按行留白 → 复制整条消息」是错的，已删掉。** 真机一测就露馅 ——
> 两个弹层**同时**冒出来（系统的选择工具条 + 我们的 `DropdownMenu`），而且行级 `pointerInput`
> 会吃掉点击，**点别处关不掉系统的选择工具条**；助手的正文里那个 `DropdownMenu` 还因为锚点在长
> `Column` 里被挤到屏幕左上角。原先的假设「长按文字时选择手势先消费按下事件」不成立。
> 现在只有 `SelectionContainer`，长按就是纯系统行为。代价：选择范围跨不过段落
>（一条消息在渲染上是多个 `Text`），要跨段得另想办法。

### 4.19 提问卡与 `hold` 认领（**0.11 已实现**）

M5 的第一块。宿主一次 `ask_user_question` 可以带**多道题**，而 `/api/answer` 要求
**一次交齐**（`validateAnswers`：`answers.length` 必须等于题目数），所以卡片是按「一次提问」
为单位提交的，不是按单道题。

**为什么单独一条流**：提问**不在会话事件流里** —— 宿主把它走 `user-questions/request` waterfall
（`ctx.userQuestions.ask()`），`/api/follow` 上看不到。插件单独开了 `GET /api/questions/stream`
（SSE）：连上先补一份**当前挂着的全部**，之后推 `question` / `question-settled` 两种帧。
客户端为它常开一条流（`net/Questions.kt`），连接、心跳、401 自动重登、退避全部复用 `/api/follow`
那套 `Sse`（0.11 顺手把它抽成了 `net/Sse.kt`）。

**形态：底部弹出的卡片**（用户 0.10.4 时选的，不是在消息流里插一行）。

| 元素 | 规格 |
|---|---|
| 卡片 | 贴底、上圆角 20dp、`heightIn(max = 520.dp)` 可滚，`BgPage` 底 |
| 遮罩 | 黑 32% 全屏，点一下 = 稍后再答（提问不丢，底部留胶囊） |
| 标题行 | 「需要你回答」（16sp SemiBold 界面档）+ 右侧「稍后」 |
| 多题提示 | 还有别的提问等着时：「还有 N 个问题等着」 |
| 题头 | `header` 非空时画一个小胶囊（`Sel` 底 / `AccentFg` 字） |
| 选项 | 一整行：左边**画出来的**指示器（单选圆 / 多选方 + 对勾），选中 `Sel` 底；`description` 12.5sp 三级灰 |
| 自定义 | 多行 `BasicTextField`（46–120dp），样式同底部输入框 |
| 提交 | `DshPrimaryButton`；**每道题**要么选了、要么写了才可点 |
| 胶囊 | 卡片关掉后留「有 N 个问题待回答」，点一下叫回来 |

**`hold` 认领**：卡片一开就 `POST /api/questions/hold {hold:true}`，宿主不再跑它自己的 120 秒
倒计时（手机上作答就永远是「时答」）；关卡片 / 点遮罩 / `ON_STOP`（退到后台）立刻 `hold:false`，
宿主按原 deadline 决定 —— 不会把 agent 卡住。释放是**即发即忘**，走 `QuestionHub` 自带的 IO
作用域：`rememberCoroutineScope()` 在组合离开时就取消了，那一下根本发不出去。

**会话列表角标**：服务端的 `SessionRow.pendingQuestion` 要等下一次刷新才更新，所以列表行改成
`row.pendingQuestion || questions.countFor(id) > 0` —— 那条流一推，角标立刻亮。

**取舍**：

- 消息流里**不插「已答」行**：提问不在事件流里，本地塞一行要自己编 seq，重连快照一来就会重复或错位；
  agent 的续写就是反馈。
- 别的会话来的提问只做**角标**，不弹卡片（用户选的）。系统通知与超级岛留到 M6。
- 卡片是**派生状态**（`pending.firstOrNull { it.id !in dismissed }`），所以新提问会自动弹；
  点掉的那些记在每会话一份 `dismissed` 里。
- 不用 `ModalBottomSheet`：它是独立窗口，卡片里那个多行输入框与输入法 / `adjustResize` 在它上面
  容易错位。自己画「遮罩 + 贴底卡片」放在同一个窗口里，`adjustResize` 直接就能用。

**为什么解析要绕过 `org.json`**：Android 单测跑在桩 `android.jar` 上，`org.json` 的方法一律抛
`Method … not mocked`。所以解析规则吃一个 `FieldReader` 接口（`net/Questions.kt`），生产路径套
`JsonReader`，单测给一张 Map —— **字段名写在 `parseBatch` 里**，所以仍然是被测到的；
`JsonReader` 只剩转发。同一原因，`errorMessage` 也拆成了「取 message」+「纯拼文案」。
### 4.20 模型 / 模式胶囊（**0.12 已实现**）

M5 的第二块，§4.3 草案落地。**插件零改动** —— 四个接口 1.3.x 就有。

| 接口 | 形状 / 语义 |
|---|---|
| `GET /api/models` | `{catalog:{default:{provider,model,reasoningEffort}, groups:[{id,name,models:[{id,name,description,efforts:[{id,name,description}],defaultEffort}]}], failures:[{id,name,message}]}}`；插件侧 60 秒 TTL 缓存。**注意两件事**（0.12.1 就是踩了这两条）：① 目录在 `catalog` 键**里面**，要剥一层壳；② 档位是**拍平**的 —— 插件 `normalizeModelCatalog` 把上游的 `reasoning.efforts` / `reasoning.defaultEffort` 提到了模型自己身上 |
| `POST /api/model` | `{sessionId, provider, model, reasoningEffort?}` → `{selected}`；**会话级**、对**下一次请求**生效，正在跑的轮次不受影响，所以不加锁 |
| `GET /api/presets` | `{presets:[{id,label,description,broken}]}`（**不需要控制器**，只读模式也能看） |
| `POST /api/preset` | `{sessionId, preset}` → `{selected,label}`；**409 `preset-locked`** —— 会话只要跑过一轮就锁死；`preset-invalid` / `agent-not-live` / `preset-not-found` 同理 |

**当前值从哪来**：模型取快照 `projections.modelSelection.next`（顶层与 `request/header` 都推不动它），
长连接期间跟 `model/selection` 事件，都没有就退回 `catalog.default`。模式取 `projections.agentPreset`
（0.7 起就在跟），锁定信号是会话行的 `blank`（与网页端 `canSwitchPreset = !(row && row.blank === false)` 同款）。

| 元素 | 规格 |
|---|---|
| 胶囊 | 输入条**上方**：会话页两颗（「模型 · 档位」「模式」），`Chip` 底、圆角 8dp、13sp、高 28dp；chevron 展开转 180°、`tween(120)` |
| 卡片 | 复用 0.11 的「遮罩 + 贴底卡片」：上圆角 20dp、`heightIn(max = 560.dp)` 可滚、`BgPage` 底 |
| 模型 | 按 provider 分组（组名 12sp 三级灰）；行内 14.5sp 名字 + 12.5sp 描述；当前项 `Sel` 底 + 画出来的对勾 |
| 档位 | **只在当前选中的那个模型下面展开**一排小胶囊（每个模型都铺会长到没法用，与网页端 `modelOption` 同款判断） |
| 模式 | `label` + `description`；`broken` 非空的行红字显示原因并置灰 |
| `failures` | 底部单列「读不到的 provider」，不挡选别的 |
| 反馈 | 成功在卡片底部显示「已切换为 X」；失败显示服务端原话（`preset-locked` 时把整段模式置灰） |

**点一个模型带哪个档位**（`ModelLogic.effortFor`）：点**正在用的**那个就沿用当前档位（用户可能刚调过），
点别的用那个模型自己的 `defaultEffort` —— 不沿用，否则会把 A 模型的档位塞给 B。

**建会话时就要选**：`/api/session` **不吃模型**，只吃 `agentPreset`。首页输入条与抽屉里的「新建会话」
共用**同一份** pre-session 状态（`ModelHub` + `preModel` / `prePreset`），卡片画在 MainActivity 的根 `Box`
那一层 —— 画在抽屉里只能盖住抽屉那一栏，画在首页里则盖不住抽屉。建完会话立刻补一发 `POST /api/model` 再交给会话页。

**取舍**：

- 选模型 / 档位**不关卡片**（档位就在模型下面展开，换完要能接着调）；换模式是决定性动作，成功即关。
- 目录在客户端也缓存一份（`ModelHub`，进程内一次）：插件侧虽有 60 秒 TTL，但每个 provider 都要一次上游往返。
- `/api/models` 要控制器就绪（没就绪回 503），所以**不在构造时拉** —— 首次进页面 / 首次点开时拉，失败留「重试」。
- 建会话后那次 `POST /api/model` 失败**不提示**：会话页胶囊显示的是宿主实际在用的模型，一眼能看出没生效。

### 4.21 三处修正 + 长按删除空白会话（**0.12.1 已实现**）

0.12 装机后用户报了四件事：三件是 bug、一件是间距，外加一个新需求。

#### 4.21.1 三个 bug（都是「接口 200 但界面不对」）

| # | 现象 | 根因 |
|---|---|---|
| ① | 模式每一行下面都写着字面的 `null` | 插件对「没有」一律写 **JSON null**（`loadPresetRoster` 的 `description` / `broken`），而 `JsonReader.str` 用的 `org.json` 的 `optString` 对 JSON null 返回的是**字符串 `"null"`**，不是空串。改成 `if (o.isNull(name)) "" else o.optString(name)` |
| ② | 卡片里一个模型都没有 → 「选不了模型」 | `Models.catalog` 把**根对象** `{catalog:{…}}` 直接喂给了 `parseCatalog`，而它要的是里面那个 `catalog`。根上没有 `groups` / `default`，解析出一个**空目录**。剥壳抽成 `Models.catalogOf`，这样**能被单测钉住** |
| ③ | （还没暴露出来）档位行永远是空的 | 插件把上游的 `reasoning.efforts` / `reasoning.defaultEffort` **拍平**到了 `models[].efforts` / `models[].defaultEffort`，客户端按嵌套形状找，永远找不到 |

**为什么三个都没被 0.12 的单测挡住**：0.12 的 `ModelTest` 照抄的是**上游 DSH 的形状**，不是**我们插件的输出形状** —— 实现和测试一起错了，所以对得上。夹具已改成插件真实形状（`catalog` 外壳 + 拍平档位），并补三条：外壳必须剥、`null` 字段退化成空串、拍平档位解析。

> `JsonReader.str` 那半边**碰不了 `org.json`**（Android 单测跑在桩 `android.jar` 上，方法一律 not mocked），所以它由**两侧合围**：客户端 `ModelTest` 钉「解析规则把 null 当空串」，插件 `mirror-test` 钉「没有描述的行发出去就是 JSON null」。两边任一改动，另一边会红。

#### 4.21.2 首页胶囊上下间隔不等

输入条是 `height(52.dp)` 的盒子、底边就是它的下沿；而 `FolderRow` 自带 `top = 8.dp`。
所以胶囊行 `vertical = 2.dp` 时，**上间隔 2dp、下间隔 2 + 8 = 10dp**。改成 `top = 10 / bottom = 2` → 上下都是 10dp。
（抽屉里那行是 `vertical = 6`，本来就对称，没动。）

#### 4.21.3 长按删除空白会话（插件 **1.3.4**）

DSH **没有真删会话的接口**。桌面端自己那个「从列表里去掉」用的就是**归档**：

> 对静止的 Session，Archive **不经确认对话框直接提交**，并保留 Session 的记账位置。
> 仍有工作在跑的 Session 是唯一会先询问的情形。
> —— `@deepseek-ai/dsh-client-ui-workspace/README.zh.md`

宿主接口 `ctx.workspaceRegistry.archiveSession(sessionId, {stopActivity?})`：

| 情况 | 宿主行为 |
|---|---|
| 已经归档过 | 直接成功，不写盘、不询问 |
| 会话既不在活的、也不在持久化的里面 | `WorkspaceUnknownSessionError` |
| 还有工作在跑、且没给 `stopActivity` | `WorkspaceActiveSessionError`，带 `activity` 名单（在跑的是什么） |

**插件侧**（`lib/mirror.js` 的 `archiveSession` / `archivedSessionIdsOf`）：

| 接口 | 形状 |
|---|---|
| `POST /api/session/archive` | `{sessionId}` → `{archived:true}`；404 `session-not-found` / 409 `session-active`（带 `activity`）/ 503 `workspace-service-unavailable` / 400 `missing-session-id` |
| `GET /api/sessions` | **减掉 `archivedSessionIds`** —— 宿主的 `controller.list()` 不知道归档这件事（桌面侧栏自己过滤），不减的话手机上删了行还在 |

**不传 `stopActivity`**：手机上要删的只有空白会话，那种会话不可能有工作在跑；真碰上有活的，把名单原话交给用户，比悄悄把 agent 打断更合适。插件早就 inject 了 `workspaceRegistry`（`lib/index.js`），所以这次**没碰 `:core`、也没碰外壳**。

**客户端侧**：会话列表行长按（`combinedClickable`）→ 只放行 `blank` 行，非空白行给一句 toast
「只有空白会话能长按删除」→ 确认框 → 归档成功后**本地立刻摘掉那一行**（空掉的分组一并收走），不等下一次刷新。
桌面端对静止会话不弹确认，这里仍弹一次：**手机上没有「撤销」入口**，只有电脑端的「已归档」里找得回来。

#### 4.21.4 新建会话后直接进会话

`NewSessionPanel.onCreated` 从 `() -> Unit` 改成 `(sessionId, cwd) -> Unit`，建完**直接打开那个会话**
（顶栏先显示目录名，宿主的标题投影到了再换）。以前只 toast + 回列表，看着像「点了没反应」——
用户连点了 4 次，`~/.dsh/sessions` 里 17 秒多了 4 个空白会话。

#### 4.21.5 「电脑上没有这个会话」不是 bug

用户报「手机建了『未命名会话』，电脑上没有」。查证：

- 手机建的那个会话**真的落盘了**：`~/.dsh/sessions/<cwd 编码>/session-89a7f411-…/session.v4.jsonl.zstd` 里就是
  `{"type":"session","version":4,"id":"…","cwd":"D:\\VibeCoding\\Plugin","agentPreset":"ptc"}`，只有这一条记录（纯空白）。
- 桌面端**刻意隐藏**空白会话：`dsh-client-ui-workspace/README.zh.md` 写着「当前空会话仍显示「新会话」，
  **其他空会话仍隐藏**」。

所以电脑上看不见是设计如此；等它跑完第一句话、有了标题就会出现在电脑上。

### 4.22 首页微调（**0.12.2 已实现**）

用户 0.12.1 装机后的两点要求，**纯客户端改动**（插件与外壳都没碰）。

#### 4.22.1 「选择新的文件夹」并进「选择文件夹」

原来输入框下面一行两个东西：左边灰胶囊显示当前文件夹，右边一行蓝字「选择新的文件夹」（手输绝对路径）。
两个入口指向同一件事，合并：

- `FolderRow` 只剩那颗胶囊（**保留原来的双色**：浅灰「文件夹」+ 深一点的文件夹名），尾巴上加 `▾`；
- 手输路径变成**清单末尾的一行**「其他路径…（必须是绝对路径）」（复用现成的 `new_other`），点它才切到手输框；
- 清单拉不到 / 一个工作区都没有时这一行**照样在** —— 「清单挂了也能新建」这条性质不能丢；
- 胶囊**跟着内容长**（`weight(1f, fill = false)`），不铺满整行，太长时又能在行内截断。

箭头是手画的（`DshChevron`，0.12.2 从 `ModelCapsule` 里抽到 `Components.kt` 两处共用）：
内置字体没有 `⌄` / `▾` 这类字形，用字符会掉到设备系统字体，各家 ROM 的粗细与基线都不一样。

#### 4.22.2 胶囊移到输入框上方

底部从 `输入框 → 胶囊 → 文件夹` 改成 **`胶囊 → 输入框 → 文件夹`**，与会话页一致（会话页本来就是胶囊在输入条上方）。

间距：输入框是 52dp 的盒子、上下都没有内距，所以**胶囊行的 `bottom` 就是它与输入框的间隔**，
**`FolderRow` 的 `top` 就是它与输入框的间隔** —— 两处都取 **10dp**，两段相等。
（胶囊上方是弹性的 `weight` 区域，不给固定上距：那不是「两个组件之间」。）

### 4.23 三颗胶囊并排 + 模型 / 模式拆成就地展开的面板（**0.12.3 已实现**）

用户 0.12.2 装机后的要求，**纯客户端改动**（插件与外壳都没碰）：

> 让主页的选择文件夹放在和选择模型和模式并排。另外把选择模型和模式的胶囊也做成选择文件夹一样圆圆的
> ……选择模型和选择模式分开来，然后分别仿照之前选择文件夹一样从下往上划出来……当然会话页也一起修改

#### 4.23.1 一行三颗，样式统一

| 项 | 0.12 / 0.12.2 | 0.12.3 |
|---|---|---|
| 位置 | 首页：胶囊在输入框上、文件夹在输入框下；会话页：输入条上方两颗 | **两页都是同一行（会话页两颗），在输入框上方** |
| 形状 | 模型 / 模式圆角 8dp；文件夹全圆 | **三颗统一全圆 `RoundedCornerShape(999.dp)`** |
| 字号 / 内距 | 模型 / 模式 13sp + 横 10dp 竖 5dp；文件夹 12.5sp + 横 12dp 竖 7dp | **统一 12.5sp + 横 12dp 竖 7dp** |
| 宽度 | 跟着内容长 | **各占一份 `weight(1f, fill = false)`**：字短按内容宽、字长截断加省略号，谁也不挤谁 |

模型 / 模式那套尺寸原本照 DSH 桌面端 `wq12jW_trigger` 抄，并排之后不统一会显得没对齐，于是统一到文件夹那一套。
文件夹胶囊保留**双色**（浅灰「文件夹」+ 深一点的文件夹名），前缀小字现在由 `ModelCapsule(prefix = …)` 统一画。

#### 4.23.2 模型与模式拆成两块，就地展开

原来是一张盖住整屏的贴底大卡（32% 黑遮罩 + `Column` 贴底 + 上圆角 20dp，两小节塞在同一个 `verticalScroll` 里）。
0.12.3 拆成 `ModelPanel` / `PresetPanel`，形态与首页文件夹清单**完全一致**：

- **没有遮罩、没有卡片底**：面板长在页面里，页面还是亮的；
- 位置固定在**胶囊行与输入框之间**（`AnimatedVisibility` + `expandVertically` / `fadeIn`，`tween(220)`，与首页清单同款）；
- 最高**半个窗口**（`LocalConfiguration.screenHeightDp * 0.5f`），超了自己滚 —— 三处面板与文件夹清单共用 `PanelBody`；
- 收起动画期间 `panel` 已经是 `None`，所以单独留一份 `lastPanel` 给内容用，否则内容先变空、动画只剩一片空白在缩；
- 再点一下那颗胶囊收起；首页 / 抽屉页点输入框也会收起（面板要地方，也顺手把 logo 放回中心）。

行为保持不变：**选模型 / 档位不关面板**（档位只在当前模型下面展开，换完要接着调），**换模式成功才收起**；
`preset-locked`（会话跑过至少一轮）把整段模式置灰并给一句解释；`/api/models` 未就绪时留「重试」；
模式段独立于目录（`/api/presets` 不需要控制器），目录 503 时模式照样能换。

#### 4.23.3 三处入口一起改

`ChipPanel { None, Model, Preset, Folder, Path }` 取代了首页的 `FolderPick` 与会话页的 `sheet: Boolean`，
三处胶囊行共用同一个「面板槽」：

| 页面 | 胶囊 | 面板状态 |
|---|---|---|
| 首页 `HomeScreen` | 模型 / 模式 / 文件夹 | 本地 `panel` |
| 会话页 `ChatScreen` | 模型 / 模式 | 本地 `panel`（按 `target.id` remember） |
| 抽屉「新建会话」`NewSessionPanel` | 模型 / 模式 | 本地 `panel` |

首页与抽屉页的模型 / 模式**仍然只是「先记住」**（会话还没建，没有网络请求），状态还在 `MainActivity`
（`preModel` / `prePreset`），只是 0.12 那个画在根 Box 上的 `ModelSheet` 与 `preSheet` 一起没了。

**首页的文件夹清单也跟着挪到输入框上方**（0.12.2 它在输入框**下面**）：三颗胶囊既然并排在同一行、
   共用同一个面板槽，清单再留在输入框下面就成了「点上面的胶囊、东西长在下面」，而且那一段间距会算两遍。

间距（用户要求「记得保持组件之间的间距」）：胶囊行 `bottom = 10dp` 就是它与面板的间隔，
`PanelBody` 自己的 `bottom = 10dp` 就是面板与输入框的间隔 —— 面板收起时两者相邻，也是 10dp；
输入框现在是**最下面那一个**，屏幕底边的 12dp 留白归它（原来在文件夹行上）。

`ModelSheet.kt` 随之改名 `ModelPanels.kt`（里面已经没有「sheet」了）；卡片时代的
`model_title` / `model_close` / `model_section_model` / `model_section_preset` 四个字符串删掉。

### 4.24 工作过程「完整」折叠（**0.13 已实现**）

M5 剩下的两块之一。0.9.3 把思考与工具合成了折叠卡，但**思考本身被丢了**：
`thinkCharsOf()` 只累加 `reasoning` 块的 `text.length`，流式 `reason` 帧同样只 `+= length`
（`ChatModel.kt`）。于是展开卡片只有一行「思考 N 字」—— 用户看不到 agent 想了什么。

网页端不是这样：`workReasonEl()` 往卡里放的是**完整思考正文**（`.reason-body`，
`max-height:40vh` 自己滚），而且**每段思考都算一件**（`app.js` 里每段思考都 `bumpWork()`）。

改法**只在 `:client`** —— 文本本来就在发（快照的 `blocks[].type == "reasoning".text` 与
流式的 `{k:"reason", t}` 都在），插件与外壳零改动：

| 项 | 0.9.3–0.12 | 0.13 |
|---|---|---|
| 模型里存什么 | `thinkChars: Int` | `think: String` |
| 快照解析 | `thinkCharsOf()` 数字数 | `thinkOf()` 拼正文（段间空一行） |
| 流式 | `liveThink += t.length` | `liveThink += t` |
| 卡片展开后 | 一行「思考 N 字」+ 步骤 | **「思考」小节 + 完整正文**（限高窗口 40%，自己滚）+ 步骤 |
| 件数 | 只数工具 | **思考也算一件**（用户拍板，对齐网页端的「N 项」） |
| 只思考、没动手的轮次 | 卡片直接丢掉 | **留下**（思考也是工作过程） |

细节：

- 思考正文是**纯文本**（网页端也是 `textContent`），不上 Markdown；字体用**正文档**而不是
  网页端那里的 mono —— 思考是中文自然语言，等宽档的中文会掉回设备系统字体，观感更差
  （沿用「只要好看，可以不一致」）。
- 同一张卡里**思考正文在前、工具步骤在后**。网页端是**按事件顺序交错**的
  （思考 → 命令 → 思考 → 命令），我们保持 0.9.3 的分组形状 —— 刻意的小偏差。
- 标题仍是「工作中 / 工作过程 · N 步」（单位没跟着改成网页端的「项」）。
- 顺手修了一处顺序：原来是 `think + workThink`（这一条的思考排在**更早**攒下的前面），
  改成攒下的在前 —— 按发生顺序。

### 4.25 右侧刻度条 → 改成「我的话」清单（**0.14 已实现**，0.14.1 改名「已发消息」，见 §4.26.3）

M5 剩下的最后一块。原计划是照搬网页端那条右侧刻度条（`app.js:2921` + `app.css:973`），
**动手前先否掉了** —— 用户也觉得「和网页框架 APK 一样的话效果有点不好」。读完网页端实现后
结论一致：照搬到原生只会更差，四条硬理由：

1. **右边沿在安卓上是系统返回手势区。** 网页端没这个问题（浏览器有自己的手势规则），
   原生 App 里把一条贴着右边沿的触摸带做进去，会跟「从右往左划 = 返回」打架。
2. **3px 的点 + 12×12 的触摸目标，手机上本来就勉强。** 网页端靠「按住先看预览」兜底，
   但那是"按下去 → 看 → 松手"三段动作，在原生里还得跟**长按选中文字**抢手势。
3. **它按比例映射，不按条数。** 30 句自己的话挤在 `min(58%, 380px)` 里，点会叠在一起，
   跳对基本靠运气。
4. **Compose 拿不到离屏 item 的 offset。** 网页端一行 `offsetTop / scrollHeight` 就够，
   `LazyColumn` 只有可见项的 `layoutInfo`，其余得估 —— 流式输出时比例会一直抖。

**改成两份东西（用户拍板：A 为主、B 兜底）：**

**A.「我的话」清单** —— 顶栏右侧一个入口（有话说才显示），点开是**就地展开的面板**
（0.12.3 那一套 `PanelBody`）：一行一句我说过的话、超长省略号、**由新到旧**、
我正在看的那句高亮（`Dsh.Sel` 底 + 亮字）；点一行就跳过去，面板收起。

**B. 右下角「↑ 上一句」浮键** —— 只在**往上翻**（`!stick`）时和原有的「↓ 回到底部」
叠着出现：点一下跳到我当前视口**之上**最近的那句，连点一路往回；上面没有了整颗不显示
（灰键在手机上只会让人反复戳）。

**关键实现点：**

- 会话列表是**倒排**的（`reverseLayout = true`，index 0 在屏幕最下），前面还压着
  「正在输出」与「乐观回显」两块 → 我的每一句的 item 下标 = `前缀 + 倒排行里的位置`。
  乐观回显**不算**（还没落库，位置随后会跳一次，与网页端同款判据）。
- 跳转落点：倒排列表里 `scrollToItem` 会把目标放在**底边**，而"回头看"要的是它落在
  **顶边附近**（下面紧接着就是当轮的回复）。做法是补一个
  `scrollOffset = 视口高 − 目标高`：看得见的目标直接量高度，看不见的按字数估，
  **宁可估高**（估低了会把长提示词的开头顶出屏幕）。
- 「我正在看哪一句」：取视口可见 item 的**中位**那条，再取离它最近的「我的话」
  （打平取更新的那条 —— 与网页端"视口中线落在哪两条之间"同款判据）。
  这个值走 `snapshotFlow` 算，**不在 composition 里直接读 `layoutInfo`**：
  否则整屏会跟着滚动每一帧重组。算出来的值只在**跨过一条消息**时才变。
- 「↑ 上一句」的可用状态放在它自己的小组件里，视口一变只有它重组。

**已知取舍**（都留给真机看）：

- 面板里**不会自动滚到"我正在看的那句"** —— 清单由新到旧，视口停在很旧的地方时
  高亮可能在面板下方看不见。这种情形正好由 B（↑ 浮键）兜住。
- 「↑」与「↓」并排，含义要靠点一次才知道；顶栏入口是**新画的对话气泡图标**
  （`ic_words.xml`）—— 字库里没有合适的字形（见 `Components.kt` 里 `DshGlyphButton` 的说明）。
- 只列**已经落库**的消息，且只列**已经加载进内存**的那部分（往上翻会加载更早的，
  清单跟着变长）—— 与网页端刻度条同一个边界。

### 4.26 工作过程一卡一轮 + 翻页不再自动重发（**0.14.1 已实现**）

用户装机后报的两个问题，外加一个改名要求。

#### 4.26.1 一屏全是「工作过程 2 步」

**现象**：一轮里冒出很多行「工作过程 · N 步」，每行只装一小段。

**根因**：`tool/call` 先攒进 `workAcc`，**下一条助手消息**一来就把它倒出来单独成一行
（`ChatModel.rowsOf` 的 `assistant/message` 分支）。而约 68% 的助手消息只有思考 + 命令、
没有正文 —— 于是 5 条这样的消息就是 **5 行「工作过程」**。网页端不是这样：
`ensureWork()` 一轮只有一张卡，后面的思考 / 命令都往里追加。

**改法**：追加新行时，**上一行也是「工作过程」卡就并进去**（`appendRows`）——
步骤按发生顺序接在后面、思考同理。合并时保留**先出现那条的 `seq`**：
LazyColumn 的 key 里带着 seq（`"s" + seq + 类名`），换了 key 列表会跳。

三处追加点全部改用它：快照（`applySnapshot`）、实时帧（`connect`）、翻旧页（`loadOlder`）。
`run_code` 那些步骤**一条不少**，只是从"分五张卡"变成"一张卡里五段"。

**取舍**：跨「文件」卡不合并 —— 一轮里文件卡本来就在最末尾。

#### 4.26.2 往上翻：一直「正在读取」，然后「连不上电脑」

**现象**：滑到顶 → 一直显示「正在读取更早的消息…」→ 之后变成「连不上电脑」；
切后台再回来也是这个。

**查到的硬事实**：

- 翻页走 `GET /api/page`，客户端读取超时 **30 秒**（`:core` 的 `MirrorApi.PAGE_TIMEOUT_MS`），
  超时被收敛成 `Unreachable` → 界面就是「连不上电脑」（`chat_unreachable`）。
- 宿主 `/api/page` 是**现场读整个会话日志再往前扫**（§7.21 的注记：上一轮就是因为它慢，
  才把默认 6 秒放宽到 30 秒）。而本会话的日志已经是 **12,584,316 B（12.5 MB，zstd 压缩后）** ——
  30 秒很可能已经不够。
- 客户端**只要滑到顶就自动发一次**，失败后 `hasMore` 仍是 true，再滑又发一次 ——
  等于拿这个重活反复捶宿主。

**改法（全在 `:client`）**：

1. 加载中**不再写 `status`**（那条是红底错误条）—— 列表顶部本来就有一行提示，够了。
2. 失败**不再自动重发**：新增 `olderError`，非空时 `auto = true` 那条路直接返回；
   顶部换成**可点的**「读取更早的消息失败：… · 点这里重试」（`retryOlder`）。
3. 失败信息带上**等了多久**：30 秒整基本就是超时，几秒就是连接断了 —— 这个数下次不用再猜。
4. 加载中那行显示**已经等了几秒**。
5. 读取超时 30 → **90 秒**，但常量写在 `:client`（`Session.PAGE_TIMEOUT_MS`）而不是改
   `:core` 里那个：`:core` 一动，**外壳 APK 就不再逐字节一致**，而那条不变量正是
   每次都能证明"外壳没被动过"的依据。
6. 翻页结果的投影挪到 **IO 线程**（`withContext(Dispatchers.IO)` + `projectLock`）：
   一页 200 条里有大会话的巨型正文，在主线程上会把界面卡住、「正在读取」迟迟不落地。
   锁是必须的 —— 实时帧与翻页共用 `workAcc` / `workThink` / `filesAcc` 这几份攒着的状态。

**没解决的**：如果宿主对这个 12.5 MB 的会话真的需要 90 秒以上，那还是读不出来。
这一版能保证的是**不再自己捶自己、不再把"加载中"画成错误、失败给得出能点的出口**，
并且把"等了多久"摆到界面上 —— 下一轮就不必再靠猜。

#### 4.26.3 「我的话」→「已发消息」

用户要求改名。改的是**用户可见的文案**（顶栏入口的无障碍名、面板标题、条数单位
「句」→「条」、空态），顺手把代码里的名字也对齐：`WordsPanel.kt` → `SentPanel.kt`、
`WordEntry` → `SentEntry`、`MyWordsPanel` → `SentPanel`、`PrevWordButton` → `PrevSentButton`、
`ic_words.xml` → `ic_sent.xml`、`words_*` → `sent_*`。

### 4.27 通知 + 超级岛（**0.15 已实现**）

M6 的主体：把 `:core` 里现成的前台服务 / 超级岛接进原生客户端，并按用户定的规矩把
「什么时候监测」改成**按需**。

#### 4.27.1 起停规则（用户选的 A：没会话 = 完全停）

- **有会话在跑、或有问题在等 → 才起**：登录进主页、每次回到前台、以及流里一看到
  `turn/start`（本机发的，或电脑上开跑而手机正看着的）都会查一次。判据是 `/api/sessions`
  里的 `running` **或** `pendingQuestion` —— 后者不是前者的子集（`lib/server.js` 的
  `waiting` 集合单独打标），两个都得看，否则"agent 提问等回答"时反倒不会起监测。
- **没会话 → 完全停**：`:core` 的 `MirrorService` 走「按需模式」（起服务时带
  `EXTRA_ON_DEMAND = dev.dsh.mirror.onDemand`），空闲满 **30 秒**就自己 `stopSelf()`，
  常驻通知与超级岛一起消失。刻意**不做**"空闲慢心跳"那种折中。
- 代价（用户已知并接受）：**手机 App 不打开时**，电脑上新开的会话在手机上不会有通知与岛
  —— 服务根本没在跑。
- 分工：**客户端只管起**（`client/notify/MirrorNotify.kt`），**服务只管停**。
  两边都去停会打架（刚发出一条、服务刚起，客户端又反手把它停了）。

#### 4.27.2 第二条通知（提问 / 完成）

- 走新渠道 `alert`（**IMPORTANCE_HIGH**，会响会弹）—— 常驻那条仍是 `service` / LOW，
  互不影响。用户要的就是"额外弹一条出来"。
- **有提问** → 「等你回答 · 会话名」+ **题面正文**（`BigTextStyle`，通知栏里直接看得到在问
  什么）；答完（或问题没了）自动撤掉。
- **会话刚跑完** → 「会话名 已完成」，**不撤**，留着等用户看到（岛只停 8 秒，通知不该也只有 8 秒）。
- 去重靠 `lastAlertKey`（`state|标题|题面`）：3 秒一次的轮询不能每次都弹。
- 题面是这一版顺手在 `IslandMonitor` 里抄下来的（`Snapshot.questionText`），并且**进了
  状态签名** —— 同一会话换一道题会重新提醒。

#### 4.27.3 外壳为什么"字节变了、行为没变"

`:core` 动了（新 extra + 新渠道 + 空闲自停），所以外壳 APK **必须重出一版 1.1.2**。
但外壳的 `MainActivity` 起服务时**不传 extra** → `onDemand=false` → 常驻、
`START_STICKY`、不发第二条通知，与 1.1.1 完全一致。也就是说这一轮"外壳没被动过"这条
不变量换成了：**外壳只被动到 `:core` 的共用部分，且那部分对它不可见**。

#### 4.27.4 release 打开 R8（用户拍板：开）

- `:client` release：`isMinifyEnabled = true` + `isShrinkResources = true` +
  自己的 `proguard-rules.pro`（只有两条"保命"规则，见文件里的注释）。
- 结果：**44.80 MB → 23.83 MB（-46.8%）**。字体那 ~20.2 MB 压不动 —— 在 `res/font` 里、
  被 `noCompress` 排除。
- 资源压缩为什么安全：字体虽然在资源里，但代码用的是 `R.font.*` **常量**而不是按名字查
  （全模块没有一处 `getIdentifier`），压缩器认得它们。R8 后实测 5 个 ttf 全在。
- 已核对 R8 没改掉清单引用的类名：`classes.dex` 里 `dev/dsh/mirror/MirrorService` 与
  `dev/dsh/mirror/client/MainActivity` 仍是原名（改了名服务就起不来）。
- **真机验证是必需的**：R8 的坑全在运行时，构建永远成功。

### 4.28 0.15.1（2026-10-10）：焦点收口 + 岛进度 + 检测通知

用户在 0.15 装包后连着报了几件事，这一版一次做完。

#### 4.28.1 焦点 bug（"点会话输入框，字却进了首页那个看不见的输入框"）

**现象**：点首页输入框 → 点侧栏进一个会话 → 点会话页输入框，**有概率**会话页没有光标，
而这时敲进去的字跑到了首页那个（已经看不见的）输入框里。**R8 包与 debug 包都有** → 与 R8 无关。

**根因（结构，代码可证）**：

1. 首页 + 抽屉**永远留在组合里**（这是 §4.4 起就定的：返回会话列表时不重拉、滚动位置不丢），
   会话页只是同一个 `Box` 里的**同级覆盖物** —— 首页输入框一直活着、随时能持有焦点。
2. `:client` 里**一处 `requestFocus` / `FocusRequester` 都没有**：会话页输入框能不能拿到焦点，
   完全取决于"点得中不中"。
3. 两个输入框在屏幕上**几乎同一位置**（都在底部、都是 52dp 圆角条），所以焦点一旦漏交接，
   用户看到的是"我点了输入框"，实际持有焦点的是底下那个看不见的 —— **没光标 + 字进首页是同一件事**。

另外证实了三处缺口：① 抽屉唯一会 `clearFocus()` 的入口是汉堡按钮，而 `ModalNavigationDrawer`
没传 `gesturesEnabled`（默认允许**从左缘滑出**）→ 手势路径无 `clearFocus()`；
② `NewSessionPanel.onCreated` 建完直接进会话、漏了 `clearFocus()`（旁边"从列表进会话"是有的）；
③ `ChatScreen` 里没有 `LocalFocusManager` → 它的面板盖住输入框时也不收键盘。

**改法（用户选的 B：按结构堵住整类问题）**，5 处，全在 `:client`：

1. `ChatComposer` 挂 `FocusRequester`，进会话 `delay(120)` 后 `requestFocus()`（`runCatching` 包住）；
2. `LaunchedEffect(drawerState.isOpen)` 收焦点 —— 兜住**手势开抽屉**那条路；
3. `NewSessionPanel.onCreated` 补 `clearFocus()`；
4. `ChatScreen` 补 `LocalFocusManager`，面板打开时 `clearFocus()`；
5. 首页输入框加 `focusProperties { canFocus = focusEnabled }`，
   `focusEnabled = chat == null && !drawerState.isOpen` —— 被盖住时连"能拿焦点"都关掉。
   （参数**故意不叫 `canFocus`**：那是 `FocusProperties` 的接收者属性名，同名会变成自己赋给自己。）

**没钉死的部分**：具体是哪一帧、哪个事件造成的漏交接，静态读代码做不到 —— 这类焦点 / 输入法竞态
要真机时序日志。所以改法是从结构上堵整类问题，而不是"修那一帧"。

#### 4.28.2 岛的进度环：运行中 50%，其余 100%（用户定的）

`Snapshot.progress` **从来没被赋过值**（一直是字段默认的 100），所以环**只会变色**、看不出"在跑"。
现在 `RUNNING → 50`，`EXPIRED / WAITING / DONE → 100`。`progress` 本来就在状态签名里，
所以比例变化同颜色变化一样会重发通知。用户对"绿环不变绿"的判断是**岛的参数没法自动刷新** ——
这一版按他的判断先试（真要还不行，下一步再试"完成时 cancel + 重发换 id 强制重建岛"）。

#### 4.28.3 设置面板加「检测通知」

用户报"第二条提醒通知没出来"，**最后确认是他自己在系统里把本应用的通知关了**（不是代码 bug）。
既然如此，就该有个当场能自证的地方：抽屉 → 设置（更多）里多一行 **「检测通知」** ——
权限没给先要权限，给了就直接走 `alert` 渠道发一条测试提醒，**发不出去就如实说发不出去**
（`:core` 新增 `MirrorService.notifyTest()`，用 `areNotificationsEnabled()` 判定并返回 boolean）。

#### 4.28.4 外壳 1.1.3（这一版岛的行为**确实变了**）

`:core` 改了（进度环 50% + `notifyTest`），所以外壳跟随重出 **1.1.3**。
与 1.1.2 不同的是：**这一次不是"只有 dex 变"** —— 运行中的岛会显示 50% 的进度环
（用户要求；两个 App 共用 `:core`，所以外壳一起变）。以前那条"外壳字节变、行为不变"的说法
**本版不适用**。

#### 4.28.5 emoji（用户新报，**本版未改，先出方案**）

用户说消息里的 ✅ 在手机上显示成**黑色马赛克**。查了字体链：`theme/DshFonts.kt` 的 `chainOf()`
用 `Typeface.CustomFallbackBuilder`，只 `setSystemFallback("sans-serif")` —— 而 Android 的彩色 emoji
是**独立的字体族**（emoji），这样拿不到 → 缺字形。

**方案（未实施）**：用 `android.graphics.fonts.SystemFonts.getAvailableFonts()`（API 29+，
客户端 minSdk 正好是 29）找 `familyName` 里含 `emoji` 的那个族，`addCustomFallback` 到链上
—— **0 MB、不用下载、不涉许可**；不行再考虑内置 Noto Color Emoji（约 10 MB，且要在开源许可页
补一条 OFL 声明）。

### 4.29 0.15.2（2026-10-10）：emoji 兜底

用户报：消息里的 ✅ 在手机上显示成**一片黑色马赛克**。

**根因**：`theme/DshFonts.kt` 的 `chainOf()` 用 `Typeface.CustomFallbackBuilder`，而
`CustomFallbackBuilder` **只会用"自己 addCustomFallback 进来的族"加最后 `setSystemFallback` 指定的
那一个族名**；Android 的彩色 emoji 是系统里**单独一个族**（`fonts.xml` 里的 `emoji`），
只给 `"sans-serif"` 是拿不到它的 → 缺字形。

**改法（不往包里塞字体）**：`SystemFonts.getAvailableFonts()`（API 29+，客户端 minSdk 正好是 29）
里**按文件名**挑出系统那个彩色 emoji 字体（文件名都含 `moji`：`NotoColorEmoji.ttf`、
`NotoColorEmojiLegacy.ttf`，小米这边是 MIUIEmoji / XiaomiEmoji 一类），
`addCustomFallback` 挂到链上。**0 MB、不下载、不涉许可**；`runCatching` 包住，
找不到就返回 null（行为与 0.15.1 一致，不崩、不会连带整条字体链失效）。

**两次编译失败（都是 API 记错，值得记下来）**：

1. 第一版写 `it.familyName` → `Unresolved reference 'familyName'`：
   `android.graphics.fonts.Font` **没有族名**，只暴露文件 / 字重 / 变体轴 → 改成认文件名。
2. 改成 `it.file.name` → `Only safe (?.) or non-null asserted (!!.) calls are allowed on a nullable
   receiver of type 'java.io.File?'`：`Font.getFile()` 可空 → 改成 `it.file?.name?.contains(...) == true`。

**只动 `:client`** → **外壳不用重出**（`:core` 没变）。

### 4.30 0.15.3（2026-10-10）：修「后台回来不刷新」—— SSE 帧泵静默丢帧

**用户报的现象**（会话页待着 → 放后台 → 通知弹出 → 回来）：

1. 流式预览一直挂着，**落库那条正文的 Markdown 不出现**；
2. `apk` 之类的**文件卡没挂在会话最下面**；
3. 会话页**没有**「正在重连」提示；
4. **退出会话重进**就全好了；
5. **只有长消息**才会中招（短消息正常）。

**排查过程与排除项**：

- "流式时没有 Markdown"**是设计**：`ChatScreen.LiveRow` 用的就是纯 `Text`（不是 MarkdownView），
  落库后才换成渲染过的正文。所以真症状是**落库那条 `assistant/message` 没到**，
  于是文件卡的挂载点（助手消息结尾 / `turn/end`）也一个都没跑到。
- 插件侧正常：`projectEvent` 对 `deliverables/presented` 有专门分支（`lib/mirror.js`，
  空清单整条不下发）、`projectSnapshot` / `encodeFollowFrame` 都会带上它、
  文本只在 `MAX_TEXT = 100000` 处截断；`/api/page` 与 `/api/follow` 共用同一套投影。
- 客户端读流侧正常：`Sse` 有 45 秒读超时看门狗（"两个心跳没到就重连"），
  `Follow.stream` 在 `Dispatchers.IO` 上读。

**根因（`net/Follow.kt`）**：`stream()` 是 `callbackFlow { … trySend(帧) … }`，**没配 `.buffer(…)`**。

- `callbackFlow` = `channelFlow`，默认缓冲**只有 64 个元素**；
- 而所有投递都走 **`trySend`** —— 非阻塞：**缓冲满了直接返回失败、帧被静默丢掉**；
- 消费者是本流的 `collect` 方，也就是 `ChatModel.connect` 所在的 **Compose 作用域 = 主线程**；
- 长消息的**流式预览排版很重**（一个不断变长的 `Text`），主线程一落后 → 64 槽满 →
  后面那些帧（落库正文 / `deliverables/presented` / `turn/end`）**全被丢掉**；
- **连接本身是健康的**（socket 没断），所以既不会重连、也没有任何提示 ——
  这正好解释"等 45~60 秒也不会自己好"：看门狗管的是 socket，没有东西可触发。
- **只有长消息**中招，只是因为它更容易把主线程拖慢、把 64 槽灌满。

**复现（单测，`src/test/.../net/FramePumpTest.kt`）**：同形状的帧泵 + "消费者先卡 200 毫秒"的 A/B：

| 测试 | 结果 |
|---|---|
| `dropsWithDefaultBuffer`（现在 `Follow.stream` 的形状） | ✅ passed —— 发 300 帧，收到的明显少于 300（**丢帧复现**） |
| `keepsEveryFrameWithUnlimitedBuffer`（`.buffer(Channel.UNLIMITED)`） | ✅ passed —— 同样慢的消费者，**一帧不丢** |

唯一变量就是缓冲区配置 —— 机制被钉死，不是靠猜。

**改法（0.15.3）**：

1. **治本**：`Follow.stream` 加 `.buffer(Channel.UNLIMITED)`。`channelFlow` 会与下游 `buffer`
   **融合**成同一个通道，所以这里写的容量就是它的容量 —— 无上限之后 `trySend` 不再失败，
   消费者慢只该导致排队，不该导致丢数据。
2. **兜底**：`ChatModel.resync()`（丢掉旧连接重开一条，宿主每次连接先发全量 snapshot）
   + `ChatScreen` 挂 `LifecycleEventEffect(ON_START)` —— 等于**自动替用户做"退出会话重进"**。
   首次进入仍由原来的 `LaunchedEffect` 负责，`resync()` 在 job 为空时直接返回。
3. **回归测试**：保留 `FramePumpTest`。

**只动 `:client`** → 外壳不用重出。

### 4.31 0.15.4（2026-10-10）：抽屉里两行「不像按钮」的改成按钮

**用户诉求**：侧栏的「检测通知」看不出是个按钮，要用框框起来、和其他按钮一致；「详细模式」一并改。

**现状**：这两行都是 `Modifier.clickable` 的**裸 `Row`**（「检测通知」= 标题 + 说明两行；
「详细模式」= 标题 + 说明 + `Switch`），**没有底色也没有描边**；而同一面板里的
「字体 / 许可 / 修复」都是 `DshSecondaryButton`（`OutlinedButton`：**1dp `Dsh.BorderL4` 描边、
圆角 `Dsh.RadiusMd`、高 44**）。所以"看不出是按钮"是结构问题，不是颜色问题。

**改法**：

1. **新增 `Components.DshSecondarySwitch(text, checked, onCheckedChange)`** —— 与
   `DshSecondaryButton` **同款**：同描边、同圆角、同高 44，只是右侧换成 `Switch`，整行可点。
2. **`MorePanel`**：
   - 「详细模式」→ `PanelNote(说明)` + `DshSecondarySwitch`；
   - 「检测通知」→ `PanelNote(说明)` + `DshSecondaryButton`（原 `NotifyTestRow` 改名
     `NotifyTestButton(text)`，**权限申请与 Toast 逻辑一行没动**）；
   - 说明文字从行内**上移成 `PanelNote`** —— 这个结构是**照抄同面板「修复」那条**的，
     所以改完以后整个面板的按钮结构完全一致。
3. 清掉 `Panels.kt` 里因此不再使用的 `import androidx.compose.material3.Switch`。

**范围**：`:client` 的 `ui/Components.kt` / `ui/Panels.kt` / `build.gradle.kts`（版本号）；
**`:core` 不动 → 外壳不用重出**。

**诚实说明**：纯 UI 改动，**我没有设备截图能自证**（要跑 adb 得先跟用户说）；这里的一致性
是"结构上用同一个组件、同一套数值"保证的，**最终观感请用户在抽屉里看一眼**。

### 4.32 0.15.5（2026-10-10）：抽屉文案返工 + 主页刷新后拉起监测（修「点刷新也不出岛」）

**① 抽屉（0.15.4 的 bug）**

0.15.4 把「检测通知」改成 `DshSecondaryButton` 时**传错了参数**：写成
`NotifyTestButton(tTitle)`，而 `tTitle` 是**面板标题** `more_title` = 「设置」——
所以按钮上显示的是「设置」，用户报的正是这个。改法：

- 新增 `val tNotify = stringResource(R.string.more_notify_test)`，按钮改用 `tNotify`；
- `more_notify_test` 由「检测通知」改为「**检验通知权限**」；
- **说明文字从控件上面挪到控件下面**（0.15.4 套的是「修复」那条"说明在上"的结构，用户要求改）：
  「检验通知权限」「显示详细工作过程」「重新配对」三条都改成"控件 + 说明"；
- 面板最终顺序：**字体 → 检验通知权限（+说明）→ 显示详细工作过程（+说明）→ 许可 → 重新配对（+说明）**。

**② 主页点刷新也不出岛（偶发）—— 根因链路**

1. 客户端**只在两个时机**拉起 `:core` 的监测服务：`ON_START`（回前台）与**进入主页那一下**
   （`MainActivity` 的 `LaunchedEffect(screen)`）。
2. `MirrorNotify.ensure()` 是"**先查 `/api/sessions`，查到有在跑 / 等回答的才起**"——
   查到没有就**不起**。
3. 服务在按需模式下**空闲 30 秒自己停**（`IDLE_STOP_MS`）。

于是：停在主页不动 → 进主页那一次查询往往正好"没会话在跑" → **服务根本没起** →
之后电脑上新开一个会话，手机上既不会自动刷新列表、也**没有任何监测在跑** → 不会有岛；
而**刷新这条路只重拉列表，没有任何代码去起服务** → 怎么点刷新都不出岛。
这也解释了"偶发"：**进主页那一刻恰好有会话在跑，服务就是活的，于是有岛**。

修法：`SessionListScreen` 的 `SessionsResult.Ok` 分支里加一句 —— 列表里只要有
`running || pendingQuestion` 就 `MirrorNotify.start(app)`（不用再查一次，
`start` 就是 `startOnDemand`）。点一下刷新，1~2 秒内出岛。

**没做的（用户若要可再提）**：主页在前台时周期查询（能"完全不碰手机也出岛"，但与用户定的
"没会话就完全停"冲突）；列表自动刷新（用户明确说"不自动刷新就算了"）。

**范围**：`:client` 的 `ui/Panels.kt` / `ui/SessionListScreen.kt` / `res/values/strings.xml` /
`build.gradle.kts`；**`:core` 不动 → 外壳不用重出**。

### 4.33 0.15.6（2026-10-10）：文件卡挂错位置 —— 挂点改成「本轮结束」

**用户报**：同一条回复，电脑端文件卡挂在最下面，手机端不是。

**先取证**（没有真机日志也能定性）：把本会话的真实事件日志解出来（
`~/.dsh/sessions/--D-VibeCoding-Plugin--/session-<id>/session.v4.jsonl.zstd` —— 它是
**多帧 zstd 拼接**，一次 `zstdDecompressSync` 只出第一帧（197 字符），必须自己按 `28 B5 2F FD`
切帧逐帧解；6204 帧 → 15779 条记录），再用插件自己的 `projectEvent` 投影出问题的那一轮（第 100 轮）：

| seq | 事件 | 手机端渲染成 |
|---|---|---|
| 15616 | 助手消息「先补挂文件（又忘了，抱歉）…」 | 正文 |
| 15619 | `deliverables/presented`（两个 APK） | 攒进 `filesAcc` |
| **15626** | 助手消息「DSH 自身代码：`Test-Path` 是 False…」 | 正文 **+ 文件卡 ← 挂在这儿** |
| 15633 | 助手消息「提交完成 ✓。补记哈希进记忆：」 | 正文（在卡片**下面**） |
| 15642 | 助手消息「## 文件已补挂 ✓ …」（最终长报告） | 正文（卡片还在它上面） |

**根因不是"没下发"**（0.10.1 就显式投影了这个事件），是**挂点**：0.10.1–0.15.5 把它挂在
"present 之后的第一条助手消息"下面。对"present 就是最后一步"的轮次这样看着没问题
（正好落在最末尾）；而那一轮 **present 完我还在继续干活**（补记忆、写总结），卡片就落到中途。
实测：这份日志里 35 次 `present`，**34 次**天然落在该轮最后一条助手消息，只有那一轮落在中途。

**改法（用户批准方案 A）**：唯一挂点改成 `turn/end` —— 删掉 `assistant/message` 分支里那次
`takeFiles(seq)`（`ChatModel.rowsOf`），保留 `turn/end` 那一处；`applySnapshot` / `loadOlder`
里那两处 `takeFiles` 是**窗口边界兜底**，不动。语义与电脑端一致：一轮的正文全部写完之后才挂文件。

**代价（有意接受）**：本轮结束前看不到文件卡（原来 present 之后的下一条助手消息就出现）。
反面方案 B（先挂、随后往最新一条"搬"）能让轮次进行中就看见卡，但要 `ChatModel` 记住 Files 行的
seq 并在 `appendRows` 后搬移，LazyColumn 会在轮次中重排一次 —— 收益不抵复杂度。

**这条规则没有单测锁**：它在 `ChatModel.rowsOf` 里，依赖 `Context` 与 `org.json`
（单测里 `org.json` 是桩，见 §4.21 的教训），只能靠本次真实事件回放 + 真机复看。

**范围**：`:client` 的 `ui/ChatModel.kt` / `build.gradle.kts`；**`:core` 不动 → 外壳不用重出**。

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
| M3 | 会话页（`/api/page` 首屏 + `/api/follow` SSE 三类帧、seq 排序、断线重连、切后台补齐）+ 发送（`requestId` 幂等 + 300ms 节流）/ 停止（两段式确认） | ✅ 已完成（2026-10-09，**0.7 / 0.7.1 / 0.8** —— 见上一行拆档） |
| M4 | Markdown 渲染器（与网页端 `renderMarkdown` 逐条一致）+ 代码块语言名/复制 | ✅ 已完成（2026-10-09，**0.9**，单测 9/9） |
| M5 | 工作过程折叠 / 提问卡（含 `hold` 认领）/ 模型与模式 / 右侧刻度条 / 浅色主题 | ✅ 已完成（2026-10-10）：**提问卡 + `hold` 认领 ✅（0.11）**、**模型与模式 ✅（0.12 → 修 bug + 长按删除 ✅ 0.12.1）**、**工作过程完整折叠 ✅（0.13）**、**右侧刻度条 → 改形态为「我的话」清单 ✅（0.14）** |
| M6 | 通知 + 超级岛接入（复用 `:core`）+ release 打包（**要开 R8**）+ 真机验收 | ✅ 已完成（2026-10-10，**0.15**；按需监测 + 第二条提醒通知；R8 后 **22.72 MB**；外壳跟随出 **1.1.2**），真机验收待用户装包 |

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

## 7.17 0.10 验收证据（下载文件，2026-10-09）

| 项 | 结果 |
|---|---|
| 插件单测 | **545 / 545 通过**（新增 20 条：相对/绝对路径、MIME、Content-Disposition、HEAD、Range 206/416/后缀、越界 403、穿越 403、不存在 404、目录 404、缺参 400、中文内容） |
| 客户端单测 | **11 / 11**（本次没动解析层） |
| 外壳 APK | `78C3EF4C…`（71,882 B），仍逐字节一致 |
| `client-debug.apk` | 44,439,073 B（42.38 MB），`versionCode=18` / `versionName=0.10`（干净构建） |
| 权限 | **没有新增任何存储权限**（MediaStore 落盘不需要）；仍是 INTERNET / 网络状态 / 通知 / 前台服务 |
| 插件版本 | `package.json` 1.2.1 → **1.3.0** |
| 交付 | `out/dsh-mobile-mirror-client-0.10.apk`，SHA256 `37741EE6F84710226963C0E0A08D0F5BFAB45C69382E41F25F71B5B626E13458` |
| **未验证** | 真机：点芯片是否弹问句、再点是否真的下、进度、完成后「打开」、以及**插件要先更新到 1.3.0**（改的是插件，手机端不更新插件就没有这个路由） |

> 真机验收前必须**重启插件**（或热重载）让 1.3.0 的路由生效 —— 否则手机端会拿到 404。

## 7.18 0.10.1 验收证据（文件卡 + 开关修复，2026-10-09）

| 项 | 结果 |
|---|---|
| 插件单测 | **552 / 552 通过**（新增 7 条：presented 清单/路径/说明/不再走未知分支/空清单不下发/条数封顶/路径截断） |
| 客户端单测 | **11 / 11** |
| 外壳 APK | `78C3EF4C…`（71,882 B），仍逐字节一致 |
| `client-debug.apk` | 44,456,269 B（42.40 MB），`versionCode=19` / `versionName=0.10.1`（干净构建） |
| 插件版本 | `package.json` 1.3.0 → **1.3.1** |
| 交付 | `out/dsh-mobile-mirror-client-0.10.1.apk`，SHA256 `0DBE0BBBB271B013C32E1701A2C8DC4468BB811FC46DD2316E0FE0BF7AF21E93` |
| **未验证** | 真机：文件卡是否出现在回复末尾、点一下是否走下载；开关打开后折叠卡是否默认展开、会话里切换是否立即生效 |

> 仍然要**先重启插件到 1.3.1**，手机端才收得到文件清单。

## 7.19 0.10.2 验收证据（粗体字面 + 文件卡归位 + 翻页修复，2026-10-09）

| 项 | 结果 |
|---|---|
| 插件单测 | **555 / 555 通过**（新增 3 条翻页参数：throughSeq=-1 / beforeSeq / maxMessages 夹到 200） |
| 客户端单测 | **11 / 11** |
| 外壳 APK | `78C3EF4C…`（71,882 B），仍逐字节一致 |
| `client-debug.apk` | 61,794,556 B（58.93 MB），`versionCode=20` / `versionName=0.10.2`（干净构建） |
| 新字体 | `dsh_hei_bold.ttf` 3.03 MB（轮廓外扩）/ `dsh_sans_bold.ttf` 13.51 MB（wght=700 实例化），均 `usWeightClass=700`、改名合规 |
| 插件版本 | `package.json` 1.3.1 → **1.3.2** |
| 交付 | `out/dsh-mobile-mirror-client-0.10.2.apk`，SHA256 `33C69A45F97BDA426B009374F82ABC33791088589D34A030B6BF06B1C3FCE0E2` |
| **未验证** | 真机：粗体是否真的变粗（含标题/表头/设置页）、文件卡是否落在回复末尾、往上翻是否不再断 |

> 插件需**重启到 1.3.2**，翻页修复才生效。

## 7.20 0.10.3 验收证据（真字重 + 翻页参数与超时 + 输入法 + 长按选中，2026-10-09）

| 项 | 结果 |
|---|---|
| 插件单测 | **556 / 556 通过**（翻页三条断言改写：throughSeq 是上界、与 beforeSeq 相同、maxMessages 夹到 200） |
| 客户端单测 | **11 / 11** |
| 干净构建 | `BUILD SUCCESSFUL`，96 tasks，0 错误 0 警告 |
| 客户端 APK | 44,473,065 B（42.41 MB），`versionCode=21` / `versionName=0.10.3` |
| 字体 | 删 `dsh_hei_bold.ttf`（3.17 MB）、`dsh_sans_bold.ttf`（14.16 MB）、`tools/make-bold-font.py`；正文改运行时 `wght 400/700`，**不额外占体积** |
| 体积 | 58.93 MB → **42.41 MB**（−16.52 MB） |
| 外壳 APK | **这一版变了**：71,882 B（`78C3EF4C…`）→ 72,190 B（`B0ADD090…`）。原因：`:core` 的 `MirrorApi` 多了「按请求指定读取超时」的重载，外壳与客户端共用 `:core`。**`:app` 自身源码一个字没动**，6 参路径传的仍是 `TIMEOUT_MS`，行为逐字等价 |
| 插件版本 | `package.json` 1.3.2 → **1.3.3** |
| 交付 | `out/dsh-mobile-mirror-client-0.10.3.apk`，SHA256 `1830FAE2F78D65BA79CB1936126F903BD6491EA4A83C0D3A62595CC679C2D9F9` |
| **未验证** | 真机：正文粗体是否真变粗、正文是否不再偏细、界面（得意黑）是否不再糊、往上翻能否真的加载出历史、开抽屉/切面板时键盘是否收起、长按是否出选择手柄与工具条 |

> 插件需**重启到 1.3.3**（翻页参数回到 `beforeSeq`）。客户端超时放宽只在客户端，插件版本号变化只是为了配套发布。

## 7.21 0.10.4 验收证据（去掉自加的长按菜单 + 外壳跟随重建，2026-10-09）

用户真机反馈：长按消息会出现**两个**弹层（系统的复制工具条 + 我们加的「复制整条消息」），
而且**点别处关不掉系统的选择工具条**。结论：行级长按菜单这个设计不成立，删掉。

| 项 | 结果 |
|---|---|
| 插件单测 | **556 / 556**（本轮插件零改动，只是复跑确认） |
| 客户端单测 | **11 / 11**；干净构建 `BUILD SUCCESSFUL`（173 tasks） |
| 客户端 APK | 44,472,653 B（42.41 MB），`versionCode=22` / `versionName=0.10.4` |
| 客户端交付 | `out/dsh-mobile-mirror-client-0.10.4.apk`，SHA256 `FCBFFB1CA86F8E0174C08ADC50A7E2151A6577629F3D732AC05D19FBA4C7C849` |
| **外壳交付** | `out/dsh-mobile-mirror-1.1.1.apk`，**72,186 B**，`versionCode=9` / `versionName=1.1.1`，SHA256 `0A4E2424C62D2FACBBCAD1828930E313CBFE4D41ABEB01AE53A7FC40858EA487` |
| 外壳改了什么 | `:app` 自身只动 `versionCode`/`versionName`；`:core` 的 `MirrorApi` 是**纯增**（26 增 1 改，改的那行只是把 `setReadTimeout(TIMEOUT_MS)` 变成传参，6 参路径仍传 `TIMEOUT_MS`）—— **行为与 1.1 一致**，只是 dex 变了，所以跟着出一版 |
| 未验证 | 真机：长按只剩系统选择工具条、**点别处能关掉**；以及 0.10.3 那一批（正文真粗体 / 正文不再偏细 / 得意黑不再糊 / 往上翻能加载出历史 / 键盘收起） |

## 7.22 0.11 验收证据（提问卡 + `hold` 认领，2026-10-09）

M5 的第一块。用户 0.10.4 时拍板的形态是**底部弹出的卡片**（不是消息流里插一行），
`hold` 认领语义也一并同意。本轮**只动 `:client`**。

| 项 | 结果 |
|---|---|
| 插件单测 | **556 / 556**（本轮插件零改动，只是复跑确认） |
| 客户端单测 | **28 / 28**（11 原有 + **17 新增**：帧解析 6、提交判据 5、组装与下发形状 3、错误文案 2、1 个多选兜底） |
| 客户端 APK | 44,558,733 B（42.49 MB），`versionCode=23` / `versionName=0.11`，标签仍是「DSH镜像原生」 |
| 客户端交付 | `out/native-client/dsh-mobile-mirror-client-0.11.apk`，SHA256 `444BFC163B19FE1FA6E4D880A6F5A6804044CA74B6D58D5BDB1692026C4ED20D` |
| **外壳** | `app-debug.apk` **仍是 72,186 B / SHA256 `0A4E2424…`** —— 与 1.1.1 **逐字节相同**（本轮没碰 `:core`，§4.18 那次的外壳重建没有反复） |
| 干净构建 | `BUILD SUCCESSFUL`，173 tasks（`:app:assembleRelease` + `:app:assembleDebug` + `:client:assembleDebug` + `:client:testDebugUnitTest`） |
| `out/` 整理 | 根目录只剩 `out/web-shell/`（10 个外壳 APK）与 `out/native-client/`（23 个原生 APK）；以后产物各归各的目录 |
| 未验证 | 真机：提问卡会不会自动弹、多题一次交齐、自定义答案、提交后卡片消失、关掉后的胶囊能叫回来、`hold` 期间电脑端倒计时是否真的停、退到后台是否释放、会话列表角标是否立刻亮 |

**为什么新增的 17 个单测不能直接吃 JSON**：Android 单测的 `android.jar` 是桩，
`org.json.JSONObject.optString` 直接抛 `Method optString in org.json.JSONObject not mocked`
（实测）。所以解析规则改吃 `FieldReader`，单测给一张 Map；字段名留在 `parseBatch` 里，仍被覆盖。
## 7.23 0.12 验收证据（模型 / 模式胶囊，2026-10-09）

M5 的第二块，§4.3 草案落地。**插件零改动**（四个接口 1.3.x 就有），本轮只动 `:client`。

| 项 | 结果 |
|---|---|
| 插件单测 | **556 / 556**（本轮插件零改动，复跑确认） |
| 客户端单测 | **42 / 42**（11 Markdown + 17 提问 + **14 新增**：目录解析 4、模式清单 2、当前选择 1、胶囊文案 3、档位归属 2、模式名 1、错误文案 1） |
| 客户端 APK | 44,678,345 B（42.61 MB），`versionCode=24` / `versionName=0.12`，标签仍是「DSH镜像原生」 |
| 客户端交付 | `out/native-client/dsh-mobile-mirror-client-0.12.apk`，SHA256 `7F307516AACDB6964F292DCD162FD1C5E9939D2130B74C1D8113DCB63464C116` |
| **外壳** | `app-debug.apk` **仍是 72,186 B / SHA256 `0A4E2424…`** —— 与 1.1.1 **逐字节相同**（本轮没碰 `:core`） |
| 干净构建 | `BUILD SUCCESSFUL`，173 tasks |
| 未验证 | 真机：胶囊显示当前模型与档位、点开卡片、换模型立刻作用于下一轮、档位只在当前模型下展开、换模式、跑过一轮后模式整段置灰、建会话时带上模式与模型 |

**为什么把 `FieldReader` 从 `Questions.kt` 挪出来**：0.12 的目录解析要处理**嵌套对象**（`default` / `reasoning`），
所以在 `net/FieldReader.kt` 里补了 `obj()` 并把它变成独立文件；`errorText` / `messageOf` 也顺势提成顶层的
`httpErrorText` / `jsonMessage`（两边都在用）。单测那个 Map 假体同样从 `AskTest.kt` 挪进 `TestJson.kt`。
## 7.24 0.12.1 验收证据（三处修正 + 长按删除空白会话，2026-10-09）

用户 0.12 装机后的四条反馈（诊断见 §4.21）。**本轮插件首次改动**（1.3.3 → **1.3.4**：加归档接口 + 会话列表过滤归档）。

| 项 | 结果 |
|---|---|
| 插件单测 | **586 / 586**（556 → **+30**：归档 27 条 + 模式清单形状 3 条） |
| 客户端单测 | **44 / 44**（11 Markdown + 17 提问 + **16 模型**；比 0.12 多 2 条 —— 外壳必须剥、`null` 字段退化成空串） |
| 干净构建 | `BUILD SUCCESSFUL`，173 tasks |
| 客户端 APK | 44,712,805 B（42.64 MB），`versionCode=25` / `versionName=0.12.1`，标签仍是「DSH镜像原生」 |
| 客户端交付 | `out/native-client/dsh-mobile-mirror-client-0.12.1.apk`，SHA256 `B905F4164332B0A30B65F9CE1B2F333B6EEC3793CFDB8317E96AAC8F5E72827C` |
| **外壳** | `app-debug.apk` **仍是 72,186 B / SHA256 `0A4E2424…`** —— 与 1.1.1 **逐字节相同**（插件只动 `lib/`，`:core` / `:app` 一个字没碰） |
| 插件版本 | `package.json` 1.3.3 → **1.3.4** |
| **未验证** | 真机项见 §8；**长按删除必须先重启 DSH**（宿主侧改动）—— 没重启时 `POST /api/session/archive` 落到旧插件的兜底，回 `text/plain` 的 404，界面会显示「删除失败（HTTP 404）」 |

**这一轮最该记住的教训**：0.12 的单测**照抄了上游 DSH 的形状，而不是我们插件的输出形状**，于是实现和测试一起错，三个 bug 全绿通过。夹具改成插件真实形状后，同样的三条断言立刻能抓住。

## 7.25 0.12.2 验收证据（首页微调，2026-10-09）

用户 0.12.1 装机后的两点要求（见 §4.22）。**只动 `:client`**。

| 项 | 结果 |
|---|---|
| 插件单测 | **586 / 586**（本轮插件零改动，复跑确认） |
| 客户端单测 | **44 / 44**（本轮**没有新增断言** —— 改的是纯版式，没有可断言的解析规则） |
| 干净构建 | `BUILD SUCCESSFUL`，173 tasks |
| 客户端 APK | 44,712,389 B（42.64 MB），`versionCode=26` / `versionName=0.12.2` |
| 客户端交付 | `out/native-client/dsh-mobile-mirror-client-0.12.2.apk`，SHA256 `3B27A870537175B94692EF4798F62FD85857571E0B902C512E89797CCDF7438D` |
| **外壳** | `app-debug.apk` **仍是 72,186 B / SHA256 `0A4E2424…`**，与 1.1.1 **逐字节相同** |
| 未验证 | 真机：胶囊在输入框上方、两段间隔看着一样、文件夹胶囊跟着内容长、点开清单末尾有「其他路径…」、清单拉不到时它还在、`▾` 展开时转 180° |

## 7.26 0.12.3 验收证据（三颗胶囊并排 + 就地展开的面板，2026-10-09）

用户 0.12.2 装机后的要求（见 §4.23）。**只动 `:client`**。

| 项 | 结果 |
|---|---|
| 插件单测 | **586 / 586**（本轮插件零改动，复跑确认） |
| 客户端单测 | **44 / 44**（本轮**没有新增断言** —— 改的是纯版式与交互，没有可断言的解析规则） |
| 干净构建 | `BUILD SUCCESSFUL`，173 tasks |
| 客户端 APK | 44,727,193 B（42.65 MB），`versionCode=27` / `versionName=0.12.3` |
| 客户端交付 | `out/native-client/dsh-mobile-mirror-client-0.12.3.apk`，SHA256 `150E24C8A13083EBF57F125677FCB516A8D24F0E3BFE7A6E6A8BC56617A7BB2A` |
| **外壳** | `app-debug.apk` **仍是 72,186 B / SHA256 `0A4E2424…`**，与 1.1.1 **逐字节相同** |
| 未验证 | 真机：三颗并排且同高同圆角、字长了是省略号而不是挤邻居、面板就地长在胶囊与输入框之间（页面还是亮的）、再点一下收起、选模型/档位不收起、换模式收起、跑过一轮后模式整段置灰、目录 503 时「重试」还在且模式照样能换、会话页与抽屉页行为一致 |

## 7.27 0.13 验收证据（工作过程完整折叠，2026-10-09）

用户拍板「从 0.13 开始」+「思考也算（一件）」（见 §4.24）。**只动 `:client`**。

| 项 | 结果 |
|---|---|
| 插件单测 | **586 / 586**（本轮插件零改动） |
| 客户端单测 | **44 / 44**（本轮没有新增断言 —— `ChatModel` 走 `org.json`，Android 单测里是桩，跑不了） |
| 干净构建 | `BUILD SUCCESSFUL`，173 tasks，0 错误 0 警告 |
| 客户端 APK | 44,727,185 B（42.65 MB），`versionCode=28` / `versionName=0.13` |
| 客户端交付 | `out/native-client/dsh-mobile-mirror-client-0.13.apk`，SHA256 `6CC64F4D626AEF3379E1B903EBE0B8907B1F8152213EE52DD61773DA9C7888B8` |
| **外壳** | `app-debug.apk` **仍是 72,186 B / SHA256 `0A4E2424…`**，与 1.1.1 **逐字节相同** |
| 未验证 | 真机：展开卡片能看到**完整思考正文**、长思考在卡内滚（限高 40% 窗口）、件数把思考也算一件（只思考的轮次也留一张卡）、流式过程中思考正文实时长出来、详细开关仍只控「默认展开 + 工具名/参数」 |

## 7.28 0.14 验收证据（「我的话」清单 + 上一句浮键，2026-10-09）

用户拍板「用你的方案，a为主，b兜底」。**只动 `:client`**。

| 项 | 结果 |
|---|---|
| 插件单测 | **586 / 586**（本轮插件零改动） |
| 客户端单测 | **44 / 44**（没有新增断言 —— 新代码都在 Compose 侧，Android 单测里跑不了） |
| 干净构建 | `BUILD SUCCESSFUL`，173 tasks，0 错误 0 警告 |
| 客户端 APK | 44,762,164 B（42.69 MB），`versionCode=29` / `versionName=0.14` |
| 客户端交付 | `out/native-client/dsh-mobile-mirror-client-0.14.apk`，SHA256 `C7DEBE83C9DE75DCD7DDCC27876B159D53FEE60FECB7E2C36E3AF00A2A60E70B` |
| **外壳** | `app-debug.apk` **仍是 72,186 B / SHA256 `0A4E2424…`**，与 1.1.1 **逐字节相同** |
| 未验证 | 真机：顶栏入口的出现时机（说过话才出现）、面板里点一句能否跳到**顶边附近**且下面紧接着就是当轮回复、当前那句的高亮、长提示词的落点、↑ 浮键连点往回走、走到最早一句时 ↑ 消失、与模型/模式面板互斥、面板很高时要不要自动滚到当前句 |

## 7.29 0.14.1 验收证据（工作过程一卡一轮 + 翻页可重试 + 改名，2026-10-10）

用户报了两个问题 + 一个改名要求，方案经确认后实施。**只动 `:client` 与文档**。

| 项 | 结果 |
|---|---|
| 插件单测 | **586 / 586**（本轮插件零改动） |
| 客户端单测 | **44 / 44**（3 个测试类，0 失败 0 错误 0 跳过 —— 新代码全在 Compose 侧，Android 单测里跑不了） |
| 干净构建 | `BUILD SUCCESSFUL`，173 tasks，**0 错误 0 警告** |
| 客户端 APK | 44,779,419 B（42.71 MB），`versionCode=30` / `versionName=0.14.1` |
| 客户端交付 | `out/native-client/dsh-mobile-mirror-client-0.14.1.apk`，SHA256 `909328F0482D7912A79FDEF0B6870E32F92204A4BE2C712D6044CA00A37DFAA4` |
| **外壳** | `app-debug.apk` **仍是 72,186 B / SHA256 `0A4E2424…`**，与 1.1.1 **逐字节相同** |
| 未验证 | 真机：一轮只留一张「工作过程」卡且步骤一条不少、卡里步骤顺序、跨轮不误合并；滑到顶的自动加载、失败后不再自动重发、顶部可点的「点这里重试」、加载中秒数在涨、失败文案里的秒数；「已发消息」入口与面板新名字 |

**本轮查到的关键事实**（写在这里，免得下轮重新挖）：

- 会话日志 `session-ef8c37dc-…\session.v4.jsonl.zstd` = **12,584,316 B**，
  是**多帧 zstd 拼接**（`zlib.zstdDecompressSync` 只解得开第一帧 197 B，第二帧报
  `Unknown frame descriptor`）—— 也就是说宿主每翻一页都要把整个文件读一遍。
- 宿主自己的历史翻页用的是 `HISTORY_PAGE_OPTIONS = {maxMessages: 500, turnWindow:{minMessages:50, minTurns:2}}`
  （在 `app.asar` 里扫到 `session-controller` 的实现），而插件 `/api/page` 只传
  `maxMessages`、**不传 turnWindow** —— 两边不是同一条路径。
- 客户端「连不上电脑」有**三个**来源：翻页 `Unreachable`、发送 `Unreachable`、
  另一处发送路径。长连接断开走的是「连接断开，正在重连（第 N 次）」，**不是**这一句 ——
  所以用户看到「连不上电脑」时，出问题的确实是翻页那条路。

## 7.30 0.15 验收证据（通知 + 超级岛 + R8，2026-10-10）

M6 主体。方案先给用户拍板（三个决策点：起停规则选 **A（没会话 = 完全停）**、**R8 开**、
**外壳出 1.1.2**），确认后实施。**动了 `:core`（共用层）与 `:client`，外壳跟着重建 1.1.2**。

| 项 | 结果 |
|---|---|
| 插件单测 | **586 / 586**（本轮插件零改动） |
| 客户端单测 | **44 / 44** |
| 干净构建 | `BUILD SUCCESSFUL`，223 actionable tasks，**0 错误 0 警告** |
| 客户端 0.15（R8 release，**交付这个**） | 23,828,254 B（22.72 MB），`versionCode=31` / `versionName=0.15`，SHA256 `A4D04256DD43218710E622593428D0FF4F05F9C2313C10D95AE16F6B0FAFC859` |
| 客户端 0.15（debug 对照） | 44,798,366 B（42.72 MB），SHA256 `5E7A83FE056BBC144488FAFB409C3178A907446CCD0691579ABE367005A8E354` |
| **外壳 1.1.2** | 76,094 B（1.1.1 是 72,186 B —— 涨的 3.9 KB 就是 `:core` 新增的那点代码），`versionCode=10` / `versionName=1.1.2`，SHA256 `A4F28DD72253E021FB7279FEFA87E72FC3CA419F61E341030E1478A506D11D50` |
| R8 效果 | release 比 debug **小 20,970,112 B（-46.8%）**；预估"20 MB 上下"落在 22.72 MB |
| 「体积不能当证据」第 4 次 | 补后台起服务的兜底后重建，release **仍是 23,828,254 B**，SHA 却从 `C2BA12DE…` 变成 `A4D04256…`。而外壳两次构建**逐字节相同**（debug 可复现这条依然成立） |
| R8 后的 dex | 单个 `classes.dex` 2,307,428 B；`dev/dsh/mirror/MirrorService`、`dev/dsh/mirror/client/MainActivity` **仍是原名** |
| R8 后的资源 | `resources.arsc` 里 `ic_notification`、`notif_channel_alert` 都在；5 个 ttf 全在（`res/*.ttf`，文件名被优化改名，合计 21,219,888 B ≈ 20.2 MB） |
| 未验证 | 真机：常驻通知与岛的出现/消失时机、第二条提醒通知（响不响 / 题面 / 完成是否留存）、空闲 30 秒自停、Android 13+ 权限弹窗、**R8 包能不能正常跑** |

**为什么外壳"字节变了但行为没变"**：`MirrorService.onStartCommand` 只在 intent 带
`EXTRA_ON_DEMAND` 时才进入按需模式，而外壳 `MainActivity.startForegroundService()` 起的是
`new Intent(this, MirrorService.class)` —— 一个 extra 都不带（1.1.2 之前与之后都没带）。

**这轮建立的事实**（免得下轮重新挖）：

- `IslandMonitor` 早就把五种状态算好了（EXPIRED / WAITING / RUNNING / DONE / IDLE，
  DONE 只停 8 秒），**而且只在状态签名变化时才回调** —— 所以"第二条通知"只是在**状态跳变**时
  多发一条，不用重写监测。
- `/api/sessions` 每一项里 `running` 与 `pendingQuestion` 是**两个字段**：`running` 不含
  "等你回答"（`lib/server.js` 单独用 `waiting` 集合打标）。客户端判"要不要起监测"两个都得看。
- `/api/questions` 的条目形状：
  `{id, sessionId, callId, createdAt, questions:[{id, header, question, options, label/description, multiSelect}]}`
  —— 题面在 `questions[0].question`，0.15 就是从这里抄的。
- 内置字体在 `client/src/main/res/font/`（**不是 assets**），全靠 `R.font.*` 常量引用 ——
  这是"开资源压缩也安全"的依据；若哪天改成按名字查（`getIdentifier`），必须补 `keep.xml`。

## 7.32 0.15.2 验收证据（emoji 兜底，2026-10-10）

| 项 | 结果 |
|---|---|
| `:client:assembleDebug :client:assembleRelease :client:testDebugUnitTest` | `BUILD SUCCESSFUL`（142 actionable tasks；前两次失败见 §4.29 的两条 API 记错） |
| 客户端单测 | **44 / 44**（AskTest 17 / MarkdownTest 11 / ModelTest 16） |
| 客户端 **0.15.2**（R8 release，**交付这个**） | `out/native-client/dsh-mobile-mirror-client-0.15.2.apk`，**23,830,986 B（22.73 MB）**，versionCode 33，SHA256 `E3653CA782B07F36DA9954F2386A582C71E434BFC0DBC9D2CA3F5CED7C570C93` |
| 客户端 0.15.2 debug（对照） | 44,801,090 B，SHA256 `967005A09B1646528B0A6A8C98355246A5C5301CE055EEE96398F6790427D2AB` |
| R8 包自检 | 解包后 `classes.dex` 里能搜到判定字符串 `moji` → 兜底逻辑确实进了 R8 产物（没被裁掉） |
| 外壳 | **不用重出**（`:core` 未变；1.1.3 仍是当前外壳） |
| **体积警告（第 5 次）** | 0.15.2 release **与 0.15.1 同为 23,830,986 B**、debug 同为 44,801,090 B —— 体积一模一样，但 SHA256 不同。「体积不能当证据」再次成立，凭证只认哈希 |
| 真机验收 | ✅ **用户 2026-10-10 确认：符号正常了**（✅ 等 emoji 显示正常） |

## 7.31 0.15.1 验收证据（焦点收口 + 岛进度 + 检测通知，2026-10-10）

| 项 | 结果 |
|---|---|
| `:client:compileDebugKotlin` | ✅（中途一次 `Unresolved reference: inputFocus` —— 见 §4.28.1 第 1 条，改对归属后通过） |
| 干净构建（clean + 5 个 target） | `BUILD SUCCESSFUL`，223 actionable tasks（164 executed / 47 from cache / 12 up-to-date） |
| 客户端单测 | **44 / 44**（AskTest 17 / MarkdownTest 11 / ModelTest 16；failures 0、errors 0） |
| 客户端 **0.15.1**（R8 release，**交付这个**） | `out/native-client/dsh-mobile-mirror-client-0.15.1.apk`，**23,830,986 B（22.73 MB）**，versionCode 32，SHA256 `DEDFE893A8E163468D3D98CA5D528069BBBF3BD125A4A1641FD1ECE46EE2E940` |
| 客户端 0.15.1 debug（对照） | 44,801,090 B（42.73 MB），SHA256 `9FFB11BB8CD0A4158232ACB075FC90FC9335445A57A481DDD31DB07460DABD91` |
| **外壳 1.1.3** | `out/web-shell/dsh-mobile-mirror-1.1.3.apk`，**77,006 B**，versionCode 11，SHA256 `00268755C59D604ED2A791E986F101738E07BC98AEE3CB8CE2780C4C5BEF8B78`（1.1.2 是 76,094 B） |
| R8 包自检（`aapt2 dump resources`） | `notif_test_title` / `notif_test_text` / `more_notify_test` 等 6 条新字符串都在 resources.arsc 里 |
| 与上一版的体积差 | 23,830,986 − 23,828,254 = **+2,732 B**（版本号 + 3 条字符串 + 进度赋值 + `notifyTest()` 的净增量）—— 又一次印证"体积不能当证据"，所以哈希才是凭证 |
| 真机验收（部分） | ✅ **用户 2026-10-10 确认：岛的 50% 方案正确 —— 有了进度变化，颜色就跟着更新了**。这条顺带**排除**了之前那个猜测（"HyperOS 只在岛创建时读颜色、之后不刷"）：只要每次状态变化都重发通知，颜色是会更新的。<br>⏳ 仍待复看：焦点 bug 是否还复现、设置里「检测通知」能否收到 |

## 7.33 0.15.3 验收证据（SSE 帧泵丢帧修复，2026-10-10）

| 项 | 结果 |
|---|---|
| 构建 | `BUILD SUCCESSFUL`，142 actionable tasks |
| 单测 | **46 / 46**（**FramePumpTest 2** / AskTest 17 / MarkdownTest 11 / ModelTest 16；failures 0、errors 0）—— 新增的两条正是丢帧机制本身的 A/B 对照 |
| 客户端 **0.15.3**（R8 release，**交付这个**） | `out/native-client/dsh-mobile-mirror-client-0.15.3.apk`，**23,830,982 B**，versionCode 34，versionName **0.15.3**（`aapt2 dump badging` 已核对），SHA256 `CA4777E95B48712A21EEE9B7EA37E82C9DAB56FB8F2D892475BE24DD75F91EBD` |
| 客户端 0.15.3 debug（对照） | 44,817,474 B，SHA256 `17452F87DDF31D84BEA1F86A3E6025453176A443F1416C1C8FE14BA8495D31A7` |
| 与 0.15.2 的体积差 | 23,830,982 − 23,830,986 = **−4 B**（加了缓冲配置与 resync，release 反而小了 4 字节）—— 凭证仍只认哈希 |
| 外壳 | **不用重出**（`:core` 未变） |
| 诚实说明 | 这次的改动是**行为**（缓冲容量 / 重连时机），**没有可 grep 的字符串能自证** —— 所以真机复现验证比包内自检更重要 |
| 真机验收（**已完成**） | ✅ **用户真机确认有效**（2026-10-10）：长消息 → 切后台 → 通知弹出 → 回来，正文 Markdown 与文件卡**立刻就在**，不用退出重进 —— 这条 bug 闭环 |

## 7.34 0.15.4 验收证据（抽屉按钮统一，2026-10-10）

| 项 | 结果 |
|---|---|
| 构建 | `BUILD SUCCESSFUL`（改完 import 又重建一次，142 actionable tasks） |
| 单测 | **46 / 46**（FramePumpTest 2 / AskTest 17 / MarkdownTest 11 / ModelTest 16；failures+errors = 0）—— 本轮没动逻辑，单测是回归确认 |
| 客户端 **0.15.4**（R8 release，**交付这个**） | `out/native-client/dsh-mobile-mirror-client-0.15.4.apk`，**23,830,934 B**，versionCode **35**，versionName **0.15.4**（`aapt2 dump badging` 已核对），SHA256 `FA53CDF504D9205EFB2757E5816120593D78FEBEBF955475D14EBF905B7A9297` |
| 客户端 0.15.4 debug（对照） | **45,658,618 B**，SHA256 `37044F3AF9D41CFBDF4831A5F8D1761BBE641658F0597061E71760D657896C50` |
| 体积 / 哈希注意 | 本轮**同一份源码**（仅差一行未使用的 import）连编两次：release 体积**完全相同**（23,830,934 B）但 **SHA256 不同**；debug 体积还差了 **857,528 B**。第 6 次印证「体积不能当证据」，debug 尤其不能当参照 |
| 外壳 | **不用重出**（`:core` 未变） |
| 真机验收 | **待用户看一眼**：抽屉里「检测通知」「详细模式」是否和「字体 / 许可 / 修复」长得一样（描边 / 圆角 / 高度），点「检测通知」是否照常发测试通知 |

## 7.35 0.15.5 验收证据（抽屉文案返工 + 主页刷新拉起监测，2026-10-10）

| 项 | 结果 |
|---|---|
| 构建 | `BUILD SUCCESSFUL`（142 actionable tasks） |
| 单测 | **46 / 46**（FramePumpTest 2 / AskTest 17 / MarkdownTest 11 / ModelTest 16；failures+errors = 0） |
| 客户端 **0.15.5**（R8 release，**交付这个**） | `out/native-client/dsh-mobile-mirror-client-0.15.5.apk`，**23,830,990 B**，versionCode **36**，versionName **0.15.5**（`aapt2 dump badging` 已核对），SHA256 `099C0A3702FEF092564A0EA63704A4551E38874CAD0B2FA530E1C827763F6A0B` |
| 客户端 0.15.5 debug（对照） | 44,801,094 B，SHA256 `50401EEDB9466F42A466FA46606C92BC8DA2E081CFA62F935EA47876214015FD` |
| **包内自检（这次能做）** | `aapt2 dump strings` 在 release 包里查到「**检验通知权限**」（String #143）—— 文案改动**可以**包内自证。（同包里另有「检测通知」，那是 `:core` 里**测试通知自身**的标题 `notif_test_title` = 「检测通知 · 测试」，不是抽屉按钮，未改。） |
| 外壳 | **不用重出**（`:core` 未变） |
| 真机验收 | **待用户**：① 抽屉里按钮是否显示「检验通知权限」、三条说明是否都在**控件下面**、顺序是否为 字体 → 检验通知权限 → 显示详细工作过程 → 许可 → 重新配对；② **停在主页** → 电脑开新会话 → 点刷新 → 岛是否 1~2 秒内出现（这是本轮主修，偶发 bug 要连试几次） |

## 7.36 0.15.6 验收证据（文件卡挂点改「本轮结束」，2026-10-10）

| 项 | 结果 |
|---|---|
| 构建 | `BUILD SUCCESSFUL in 1m 10s`（142 actionable tasks：33 executed / 109 up-to-date） |
| 单测 | **46 / 46**（FramePumpTest 2 / AskTest 17 / MarkdownTest 11 / ModelTest 16；failures + errors = 0） |
| 客户端 **0.15.6**（R8 release，**交付这个**） | `out/native-client/dsh-mobile-mirror-client-0.15.6.apk`，**23,830,990 B**，versionCode **37**，versionName **0.15.6**（`aapt2 dump badging` 已核对），SHA256 `21C9E76EBE7B20C840723423530458F29C9369994889097FD709D6A566ABA1B9` |
| 客户端 0.15.6 debug（对照） | 44,801,094 B，SHA256 `994A24322FED9FC67A3255CCEE694F24E6AA8A28769BA325AEF940F6FCC4DD98` |
| **体积不能当证据（第 7 次）** | release 与 0.15.5 **同为 23,830,990 B**、debug 也同为 44,801,094 B，而两个 SHA256 都变了 —— 判据只能是哈希 |
| 代码自证 | 这次改的是**挂点逻辑**，没有可做包内自检的字符串 —— 依据只有 §4.33 那份真实事件回放 + 真机复看；`ChatModel.rowsOf` 依赖 `Context`/`org.json`，单测锁不住 |
| 外壳 | **不用重出**（`:core` 未变，1.1.3 继续有效） |
| 真机复看 | **待用户**：找一条"present 之后还继续写了几段"的回复，确认手机端文件卡挂在**最末尾**（与电脑端一致） |

## 8. 待办

- [x] **0.11：提问卡（底部弹出）+ `hold` 认领 + 会话列表实时角标**（2026-10-09，见 §4.19 / §7.22）
- [ ] **0.11 待真机确认**：提问卡自动弹出、一次提问里多道题一次交齐、自定义答案、提交后卡片消失、关掉后胶囊能叫回来、`hold` 期间电脑端倒计时是否真的停、退到后台是否释放、会话列表角标是否立刻亮
- [ ] 0.11 已知取舍：消息流里不插「已答」行（agent 的续写就是反馈）；别的会话来的提问只做角标（通知/超级岛留 M6）；`org.json` 在单测里是桩，解析规则走 `FieldReader`
- [x] **0.12：模型 / 模式胶囊**（`/api/models` + `/api/model` + `/api/presets` + `/api/preset`，2026-10-09，见 §4.20 / §7.23）
- [x] ~~0.12 待真机确认~~：**用户装机后报了三个 bug + 一处间距**（见 §4.21）—— 那一版的模型 / 模式其实完全没工作：目录没剥壳解析成空、档位键找错、模式描述显示字面 `null`
- [ ] 0.12 已知取舍：选模型/档位不关卡片（换模式才关）；`/api/models` 未就绪时留「重试」；建会话后补的那发 `POST /api/model` 失败不提示
- [x] **0.12.1：修三处（JSON null / 目录没剥壳 / 档位拍平）+ 首页胶囊间距 + 长按删除空白会话 + 新建会话直接进会话**（插件 **1.3.4**，2026-10-09，见 §4.21 / §7.24）
- [ ] **0.12.1 待真机确认**：胶囊里模型与档位都在、模式名下面不再有 `null`、换模型作用于下一轮、档位只在当前模型下展开、跑过一轮后模式整段置灰；首页胶囊上下间隔一致；长按空白会话能删（**插件要先重启到 1.3.4**）、非空白行给一句提示；抽屉里新建会话后直接进会话
- [ ] 0.12.1 已知取舍：归档是**软删除**（手机上没有「已归档」入口，只能去电脑端找回来）；新建会话直接进会话后抽屉保持打开（返回时看到的是列表）
- [x] **0.12.2：首页微调 —— 「选择新的文件夹」并进文件夹清单末尾；模型 / 模式胶囊移到输入框上方（两段间隔都是 10dp）**（2026-10-09，见 §4.22 / §7.25）
- [ ] **0.12.2 待真机确认**：胶囊在输入框上方且两段间隔相等、文件夹胶囊跟着内容长（不铺满整行）、点开清单末尾有「其他路径…」、清单拉不到时那一行还在、箭头展开时转 180°
- [x] ~~0.12.2 已知取舍：文件夹胶囊留在输入框**下面**~~ —— **0.12.3 已作废**：三颗并排在同一行（见 §4.23）
- [x] **0.12.3：三颗胶囊并排（模型 / 模式 / 文件夹）+ 统一全圆胶囊；模型与模式拆成两块就地展开的面板（无遮罩、页面仍亮），会话页与抽屉页一起改**（2026-10-09，见 §4.23 / §7.26）
- [ ] **0.12.3 待真机确认**：三颗并排且同高同圆角、字长了是省略号而不是把邻居挤出去、点开面板就地长在胶囊与输入框之间（页面还是亮的）、再点一下收起、选模型 / 档位不收起、换模式收起、跑过一轮后模式整段置灰、目录 503 时「重试」还在且模式照样能换、会话页与抽屉页行为一致
- [ ] 0.12.3 已知取舍：面板展开时**点面板外面不会收起**（方案 A 的代价 —— 没有遮罩就没有「点外面」这个手势）；长模型清单得在半屏里滚；抽屉「新建会话」页里面板的滚动是嵌在页面滚动里的
- [x] **0.13：工作过程「完整」折叠 —— 思考存正文（不再是「思考 N 字」）+ 卡片里 40% 窗口高的滚动区 + 件数把思考也算一件**（2026-10-09，见 §4.24 / §7.27）
- [ ] **0.13 待真机确认**：展开卡片能看到完整思考正文、长思考在卡内滚、件数含思考、只思考没动手的轮次也留一张卡、流式时正文实时长出来
- [ ] 0.13 已知取舍：同一张卡里思考在前、工具步骤在后（网页端是按事件顺序交错的）；标题单位仍是「步」而不是网页端的「项」；思考正文用正文档而不是网页端的 mono
- [x] **0.14：右侧刻度条 → 改成「我的话」清单（顶栏入口 + 就地展开的面板，点一句跳过去）+ 右下角「↑ 上一句」兜底浮键**（2026-10-09，见 §4.25 / §7.28）—— 网页端那条贴右边沿的刻度条会跟系统返回手势打架，**主动否掉**（用户也认同）
- [ ] **0.14 待真机确认**：顶栏入口时机、点一句跳到顶边附近且回复紧随其后、当前句高亮、长提示词落点、↑ 连点往回、到最早一句时 ↑ 消失
- [ ] 0.14 已知取舍：面板不自动滚到"正在看的那句"（视口停在很旧的地方时高亮可能在面板下方）；「↑」的含义要靠点一次才知道
- [x] **0.14.1：相邻「工作过程」卡合成一张（一轮一卡，`run_code` 步骤一条不少）+ 翻页失败不再自动重发（顶部改成可点的「点这里重试」并显示等了多久，读取超时 30 → 90 秒）+ 「我的话」改名「已发消息」**（2026-10-10，见 §4.26 / §7.29）
- [ ] **0.14.1 待真机确认**：一轮只留一张「工作过程」卡、卡里步骤一条不少且顺序对、跨轮不误合并；滑到顶能自动加载、失败后不再自动重发、顶部那行能点着重试、加载中的秒数在涨、失败文案里的秒数合理
- [ ] 0.14.1 已知取舍：跨「文件」卡不合并（一轮里文件卡本来就在末尾）；90 秒仍读不出来就没辙（宿主对 12.5 MB 会话的扫描速度不是客户端能改的）；加载中**没有取消键**（HttpURLConnection 的阻塞读打断不了）
- [x] 之后 M6：通知 + 超级岛（复用 `:core`）+ release 打包（要开 R8）→ **0.15 已完成**（见 §4.27 / §7.30）；**只剩真机验收**
- [x] 0.9：Markdown 渲染与网页端逐条一致（2026-10-09）
- [ ] 0.9 待真机确认：标题层级与间距、表格横向滚动、代码块头部条与复制键、任务列表勾选框、链接点击、图片占位
- [ ] 0.9 已知取舍：行内代码无描边/padding；图片只占位；表格按内容宽度（非 width:100%）
- [x] 会话页贴底跟随（用户 2026-10-09 报，**0.9.1** 已修，见 §4.12）
- [x] 0.9.1 会话页贴底跟随（已实现，真机待确认）
- [ ] 0.9.2 待真机确认：表格列对齐 / 只画横线 / 空表头消失 / 文件蓝色芯片 / 行内代码留白
- [x] ~~0.10.2 待真机确认~~：**已作废** —— 那一版的假粗体（得意黑轮廓外扩）糊成一团，文件卡归位有效，翻页参数改错（见 §4.18①）
- [x] 思源黑体默认实例是 wght=100（Thin）导致正文偏细 —— **0.10.3 已在客户端钉到 400**
- [ ] **0.10.3 / 0.10.4 待真机确认**：正文粗体（标题/表头/`Strong`）是否真变粗、正文是否不再偏细、界面得意黑是否不再糊、往上翻能否加载出历史（插件需先重启到 1.3.3）、开抽屉/切面板/进会话时键盘是否收起、长按正文与气泡是否出选择手柄与工具条、**点别处能否关掉选择工具条**（0.10.4 修的就是这个）
- [ ] 0.10.3 已知取舍：界面档中文（得意黑）**没有真粗体**（它只有一个字面），界面里的英文/数字有 JBM Bold；选择范围跨不过段落（一条消息是多个 `Text`）
- [ ] 外壳 APK 因 `:core` 变更而变化（0.10.3 首次）—— 若要求外壳逐字节不变，需把「按请求指定超时」挪出 `:core`（客户端自建请求），代价是重复一遍证书固定与 401 自愈
- [ ] **0.10.1 待真机确认**：回复末尾的「文件」卡、点卡下载；「显示详细工作过程」打开后折叠卡默认展开、会话内切换立即生效（插件需先重启到 1.3.1）
- [ ] 网页端要不要也渲染 `deliverables/presented`（现在只有手机端与电脑端有文件卡）：文件芯片 → 问句 → 下载 → 「下载」目录里能看到文件；插件需先更新到 1.3.0
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
- [x] M6 前决定 release 是否开 R8 与资源压缩 → **开了**（0.15，见 §4.27.4：44.80 → 23.83 MB）
- [x] **0.15（M6）：通知 + 超级岛接进原生客户端 + release 开 R8**（2026-10-10，见 §4.27 / §7.30）
- [x] **0.15.1：焦点收口（用户选的 B）+ 岛的进度环 50%/100% + 设置面板「检测通知」**（2026-10-10，见 §4.28 / §7.31；`:core` 变了 → 外壳跟随出 **1.1.3**）
- [x] 0.15.1 真机验收：焦点 bug **未复现**、运行中的岛显示 50%、设置里「检验通知权限」能收到测试通知（用户 2026-10-10 一并确认「都没问题」）
- [x] **0.15.2：emoji 兜底**（2026-10-10，见 §4.29 / §7.32）：按文件名从 `SystemFonts` 里挑系统那个彩色 emoji 字体当 custom fallback（**0 MB**）；**待真机验证 ✅ 是否正常显示**
- [ ] 内置 Noto Color Emoji 的退路（**仅在** 0.15.2 的 `SystemFonts` 方案真机不生效时才考虑：~10 MB + 开源许可页补 OFL）
- [x] **0.15.3：修「后台回来不刷新 / 文件卡丢失」**（2026-10-10，见 §4.30 / §7.33）：根因是 `Follow.stream` 的 `callbackFlow` 只有 64 槽且用 `trySend` **静默丢帧** → 加 `.buffer(Channel.UNLIMITED)` 治本 + `resync()`/`ON_START` 兜底 + `FramePumpTest` 回归测试
- [x] **0.15.4：抽屉里「检测通知」「详细模式」改成和其他按钮同款**（2026-10-10，见 §4.31 / §7.34）：新增 `DshSecondarySwitch`，说明文字上移成 `PanelNote`（照抄「修复」那条的结构）
- [x] **0.15.5**（2026-10-10，见 §4.32 / §7.35）：① 修 0.15.4 把**面板标题**当按钮文案传进去的 bug（按钮显示成了「设置」）→ 改名「检验通知权限」+ 说明文字挪到控件**下面**；② 主页刷新出"有会话在跑 / 等回答"时 `MirrorNotify.start` 拉起监测 —— 修「停在主页 → 电脑开新会话 → 点刷新也不出岛」
- [x] 0.15.5 真机验收：抽屉文案「检验通知权限」与三条说明的位置**都对**；**停在主页点刷新能出岛**（用户 2026-10-10 确认）
- [x] 0.15.4 真机看一眼：已被 0.15.5 覆盖，用户 2026-10-10 确认没问题
- [x] 0.15.3 真机确认（用户 2026-10-10）：放后台 → 通知 → 回来，正文 Markdown 与文件卡**立刻**在（长消息也正常）
- [ ] 「App 在前台时不弹岛 / 不发第二条提醒」（用户提，**方案已给待做**）：`:core` 静态 `appVisible` + `buildNotification()` 不挂岛参数 + `alert()` 提前 return；`:client` 用 `LifecycleEventEffect` 上报；外壳不调 → 行为不变，但 `:core` 变 → 外壳要出 **1.1.4**
- [ ] 用户定的「下一轮」：点通知 / 点岛**跳到对应会话**（`PendingIntent` 带 sessionId，要动 `:core`）
- [x] **0.15 真机确认**（用户 2026-10-10）：① 有会话在跑时出现常驻通知与超级岛；② 岛的标题显示**会话名**（不是「DSH 镜像」）；③ 跑完 8 秒绿岛后连同通知一起消失；④ **R8 包能正常跑**
- [ ] 0.15 剩下没专门确认的（用户没提，按"都没问题"从宽理解，先留个记录）：提问那条"额外弹"的通知响不响 / 通知栏里有没有题面 / 答完是否自动撤；跑完那条「已完成」是否留在通知栏；Android 13+ 首次进 App 的通知权限弹窗
- [ ] 0.15 已知取舍（用户确认过的）：手机 App 不打开时，电脑上新开的会话在手机上不会有通知与岛（"没会话 = 完全停"的必然结果）；点通知/点岛只打开 App，**不落到对应会话**（用户定的下一轮做）
- [ ] 通知重复问题：两个 App 并存时都会起前台服务轮询 → 装机只装原生版。0.15 起原生版是**按需**起（有会话在跑才起），所以这条在原生版这边轻了一些，但两个 App 同时开着且都有会话在跑时仍会看到两条常驻通知
- [x] **0.15.6：文件卡挂点改成「本轮结束」**（用户批准方案 A，2026-10-10，见 §4.33 / §7.36）：0.10.1–0.15.5 挂在"present 之后的第一条助手消息"下面 → present 完还继续干活的轮次会挂到中途
- [ ] 0.15.6 真机复看：**同一条回复在电脑端与手机端文件卡都在最下面**（重点试"present 之后我还继续写了几段"的轮次）
- [x] 真机验收欠账用户 2026-10-10 总确认：除我误写的一个含混词（「Run」）外**都确认没问题** —— 0.15.5 抽屉按钮与说明位置、停在主页点刷新出岛、0.15.1 焦点 bug 未复发、岛的标题是会话名、跑完 8 秒连通知一起收；0.12–0.14 的观感项也一并确认
