# 第三方声明

本仓库的源码（插件 `lib/`、手机页面 `lib/web/`、Android 外壳与原生客户端 `android/`、`tools/`）
均为本项目独立编写，**不含任何 GPL 代码**。下面列出随包分发的第三方资源，以及开发过程中查阅过的外部资料。

## 一、随包分发

| 组件 | 位置 | 许可证 | 说明 |
|---|---|---|---|
| JetBrains Mono（Regular / Bold） | `lib/web/fonts/` | SIL Open Font License 1.1 | **网页端**内嵌；许可全文 `lib/web/fonts/OFL.txt` |
| JetBrains Mono（Regular / SemiBold / Bold） | `android/client/src/main/res/font/` | SIL Open Font License 1.1 | **原生客户端**等宽档；许可全文 `android/client/src/main/assets/licenses/OFL-JetBrainsMono.txt` |
| 得意黑 Smiley Sans（Oblique） | `android/client/src/main/res/font/smiley_sans_oblique.ttf` | SIL Open Font License 1.1 | **原生客户端**界面档中文；© 2022–2024 atelierAnchor；许可全文 `.../licenses/OFL-SmileySans.txt` |
| 思源黑体 Noto Sans SC | `android/client/src/main/res/font/noto_sans_sc.ttf` | SIL Open Font License 1.1 | **原生客户端**正文档中文；© 2014–2021 Adobe（保留字体名 "Source"）；许可全文 `.../licenses/OFL-NotoSansSC.txt` |

三款字体的许可全文都已随原生 APK 分发（`assets/licenses/`），App 内也能从「字体 → 开源许可」看到
—— 这是 OFL 的要求（随包附版权声明与许可原文）。

除上表外，仓库内不含任何第三方代码或素材。

## 二、仅作「接口事实」对照，未使用其代码

| 项目 | 许可证 | 用途 |
|---|---|---|
| [ABK](https://github.com/xingguangcuican6666/ABK) | GPL-3.0 | 小米超级岛（焦点通知）的两个 extras 键名与 `param_v2` JSON 结构 |

`android/core/src/main/java/dsh/mirror/IslandSupport.java` 里的 extras 键名、`param_v2`
的字段名与层级，是 HyperOS 焦点通知的**接口事实**：任何想上岛的实现都得写成同一套键名，
写错系统就静默丢弃 extras。这类事实对照 ABK 的
`app/src/main/java/com/abk/kernel/utils/NotificationUtils.kt` 核对，逐条出处（含行号）见
`docs/apk-plan.md` §A3。

**未取用的部分**：该项目的 Kotlin 实现代码、注释、命名、常量取值与业务逻辑（内核编译进度、
`BuildKind` 分支、四个设备门槛的判定实现）均未被复制、翻译或改写引入。本项目对应实现是
独立编写的 Java —— 状态机、轮询分频、文本折叠与截断、JSON 组装结构都是本项目自己的写法。

**后续维护约定**：若将来需要恢复设备门槛之类的判定，请按 HyperOS 的公开行为自行实现，
不要从该项目引入代码。

## 三、界面与文案

- 手机端界面借用了 DeepSeek 网页端的**组件语言**（助手消息不带气泡、代码块头部条等），
  未使用其商标、图标或文案，也不含其代码。
