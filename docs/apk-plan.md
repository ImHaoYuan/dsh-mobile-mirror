# APK 方案：WebView 外壳

> **状态：已实现并真机验证。** 外壳（A1）、通知（A2）、小米超级岛（A3）均已落地，
> APK 版本 **1.1.1**（`versionCode 9`）。1.1 清掉了验证脚手架；**1.1.1 是跟随 `:core` 的重建** ——
> 平台层给原生客户端加了「按请求指定读取超时」的重载，外壳与客户端共用 `:core`，dex 因此变了，
> 行为与 1.1 完全一致。源码在 `android/`。
>
> 本文档是**当初的施工依据与设计记录**，保留下来说明「为什么这么做」。
> 其中 §4「构建环境要求」、§11「分步计划」里带有作者本机当时的痕迹；
> 复现构建请看仓库 README 的「构建 APK（可选）」一节。
>
> 记录时间：2026-10-07。方案经用户逐项确认（见 §3）。

---

## 1. 为什么要做 APK

手机端网页（`https://<电脑>:19388`）已经可用，也能"添加到主屏幕"变全屏。
所以 APK 的价值必须落在**网页做不到的事**上，否则就是白做一份要维护两份的东西。

网页真正的缺口只有三个：

| # | 缺口 | 现状 | APK 怎么解决 |
|---|---|---|---|
| ① | **自签证书** | 必须装 CA，而装 CA 是**系统级**信任：所有 App 都信，系统还常驻一条"网络可能受到监控" | 指纹固定，信任**只限本 App** |
| ② | **通知** | DSH 在电脑上提问、或一轮跑完，手机锁屏时**完全不知道** | 前台服务轮询两个只读端点 |
| ③ | **配对** | 要手打 `https://192.168.x.x:19388` + 账号密码 | 手输地址一次，之后记住 |

②是 APK 最大的价值。PWA 的 Web Push 需要公网推送服务，**局域网内不可能实现**，通知只能靠 APK。

---

## 2. 方案选型：为什么是 WebView 外壳，不是原生客户端

| | **A. WebView 外壳（选定）** | B. Kotlin + Compose 原生 | C. PWA | D. TWA |
|---|---|---|---|---|
| 界面代码 | **0 行新写** | 整套重写 | 0 行 | 0 行 |
| 刚做完的 DeepSeek 风格改造 | 直接就有 | 要在 Compose 里再做一遍 | 直接就有 | 直接就有 |
| 以后改 UI | 改网页，**APK 不用重编** | 改两处 + 重新发版 | 改网页 | 改网页 |
| 第三方依赖 | **零** | Compose BOM + Material3 + activity-compose + lifecycle + coroutines… | — | — |
| 代码量 | 约 500–700 行 Java | 数千行 Kotlin | 0 | — |
| 通知 | 前台服务轮询 | 前台服务轮询（**代码几乎相同**） | **做不到** | 做不到 |
| 证书 | 指纹固定，只限本 App | 同左 | 仍要装系统 CA | — |
| 手感 | WebView（够用） | 原生（更好） | 浏览器 | — |
| 可行性 | 可行 | 可行 | 可行 | **不可行**：要求公网可信证书 + Digital Asset Links 校验，局域网自签直接出局 |

### 关于"通知在外壳里是不是更麻烦"

**不是。** 通知之所以麻烦，是 **Android 的后台限制**造成的，跟外壳无关。拆开看：

| 通知要做的环节 | WebView 外壳 | Kotlin + Compose | 差别 |
|---|---|---|---|
| 前台服务保活进程 | 写一遍 | 写一遍 | **无** |
| 通知渠道 / 权限 / `dataSync` 类型声明 | 写一遍 | 写一遍 | **无** |
| 判断"有人提问 / 一轮跑完" | 轮询两个 HTTP 端点 | 轮询两个 HTTP 端点 | **无** |
| 发通知 | `Notification.Builder` | `Notification.Builder` | **无** |
| TLS 校验 | WebView 一处 **+ 服务一处** | 服务一处 | **外壳多一处（约 20 行）** |

原生客户端唯一能省的是"UI 和通知共用同一个数据源"，那是代码组织上的小便利，不是难度差异。

### 唯一诚实的让步

手感不是原生。但界面本来就是为手机设计的网页，且深浅两套主题已在真机上确认可用。
**为了手感把整套 UI 维护两份，不划算。**

---

## 3. 已确认的参数

用户逐项确认过，施工时不要再改：

| 项 | 取值 |
|---|---|
| 形态 | 纯 Java WebView 外壳，**零第三方依赖** |
| 签名 | **debug 签名**（自用足够，无需保管密钥） |
| 首次配置 | **手输 `主机:端口`**（不做二维码，以保持零依赖） |
| minSdk | **29**（Android 10+） |
| compileSdk / targetSdk | 36 |
| 通知 | **完整**（前台服务常驻） |
| 交付 | APK 放到 `out/` |
| `lib/web/*` | **零改动**（见 §7.5） |

### 用户的硬约束

**不要使用 adb。** 用户明确要求过（adb 操作需事先告知并征得同意）。
安装到手机由用户自己完成（从 `out/` 取文件）。

---

## 4. 构建环境要求

**先看这张表；作者本机当时的调查记录附在表后。**

| 项 | 要求 |
|---|---|
| JDK | **17 或 21**。AGP 8.5.2 不支持过新的 JDK（作者的验证环境是 Zulu 21） |
| Gradle | 8.9，由 wrapper 自动下载。`android/gradle/wrapper/gradle-wrapper.jar` **已随仓库提交**，无需自备 |
| AGP | 8.5.2（见 `android/build.gradle.kts`） |
| Android SDK | 需装 **Platform 36** 与 **Build-Tools 36**；用 `android/local.properties` 的 `sdk.dir` 或 `ANDROID_HOME` 指到 SDK 根 |
| 网络 | 首次构建需访问 `dl.google.com` 与 `repo.maven.apache.org` |
| 第三方依赖 | **零依赖** —— `app/build.gradle.kts` 刻意不写 `dependencies {}` |
| 平台 | 作者在 Windows 上验证；`gradlew` 与 `gradlew.bat` 都已提交，macOS / Linux 用 `./gradlew` |

> **作者本机当时的状态（2026-10-07，仅作参考）**：Gradle 8.9 与 AGP 8.5.2 已在 Gradle 缓存；
> SDK 只装了 android-36（没有 34/35），因此 `gradle.properties` 里写了
> `android.suppressUnsupportedCompileSdk=36`；`ANDROID_HOME` 为空，所以必须写 `local.properties`；
> `JAVA_HOME` 当时指向 jdk-26（AGP 不支持），构建前手动覆盖成 Zulu 21。

---

## 5. 目录结构

```
dsh-mobile-mirror/
├── android/                                    ← 全部新增
│   ├── settings.gradle.kts
│   ├── build.gradle.kts                        根：只声明插件
│   ├── gradle.properties
│   ├── local.properties                        sdk.dir=... （本机路径，已 gitignore）
│   ├── gradlew  gradlew.bat                    ← 随仓库提交
│   ├── gradle/wrapper/gradle-wrapper.jar       ← 随仓库提交（43,504 字节）
│   ├── gradle/wrapper/gradle-wrapper.properties
│   └── app/
│       ├── build.gradle.kts
│       └── src/main/
│           ├── AndroidManifest.xml
│           ├── java/dev/dsh/mirror/
│           │   ├── MainActivity.java           WebView 宿主、返回键、生命周期
│           │   ├── ServerPrefs.java            地址持久化 + 首次配置界面
│           │   ├── CertPinner.java             证书 SHA-256 指纹固定（两处共用）
│           │   ├── MirrorService.java          前台服务 + 轮询 + 通知
│           │   └── Notifications.java          通知渠道与发送（可并入 MirrorService）
│           └── res/
│               ├── layout/activity_main.xml
│               ├── layout/activity_setup.xml
│               ├── values/strings.xml
│               ├── values/themes.xml
│               ├── xml/network_security_config.xml
│               ├── drawable/ic_launcher_foreground.xml   （矢量，不用 PNG）
│               └── mipmap-anydpi-v26/ic_launcher.xml     （自适应图标，minSdk 29 全支持）
├── lib/web/                                    ← 零改动
├── docs/apk-plan.md                            ← 本文档
├── out/                                        ← 新增，构建产物
│   └── dsh-mobile-mirror.apk
└── .gitignore                                  ← 需新增 out/ 与 android/local.properties
```

---

## 6. 原生部分设计

### 6.1 MainActivity —— WebView 宿主

**WebView 配置**

```java
settings.setJavaScriptEnabled(true);
settings.setDomStorageEnabled(true);        // 页面用 localStorage 存折叠状态
settings.setAllowFileAccess(false);
settings.setAllowContentAccess(false);
settings.setMixedContentMode(MIXED_CONTENT_NEVER_ALLOW);
settings.setBuiltInZoomControls(false);
settings.setDisplayZoomControls(false);
```

**Cookie**：`CookieManager.setAcceptCookie(true)`、`setAcceptThirdPartyCookies(view, false)`；
在 `onPause` 里 `CookieManager.getInstance().flush()`（否则进程被杀会丢登录态）。

**导航限制**：`shouldOverrideUrlLoading` 里比对 origin —— 同源在 App 内加载，其余交给系统浏览器。
这是防止页面被诱导跳去外部站点的关键一环。

**返回键**（两级）：

```java
// 在聊天页 → 等同于点页面自己的 ‹ 返回按钮；已在列表页 → 双击退出
String js = "(function(){var v=document.getElementById('view-list');"
          + "var b=document.getElementById('btn-back');"
          + "if(v&&v.hidden&&b){b.click();return 'back';}return 'exit';})()";
```

> ⚠️ **判断的必须是 `#view-list`，不是 `#list`。**
> `setView()` 切换的是外层 `<section id="view-list">`（`app.js:1135`），而 `#list`
> 只是它内部的会话列表容器（`index.html:42`），**从不被隐藏**。写成 `#list` 的话判断
> 永远为假，返回键会退化成"永远直接退出"，永远回不到列表 —— 而且不会报任何错。

这两个 id 目前**没有**被 `web-test.mjs` 断言钉住（`#btn-back` 只在 `web-dom-test.cjs`
里被点击过 3 次，`#view-list` 完全没被引用）。所以 **A1 要顺带在 `web-test.mjs` 里补两条
断言**把 `id="view-list"` / `id="btn-back"` 钉住 —— 否则以后改 HTML 把 id 改掉，
原生侧会静默退化成一个没反应的返回键。

**不调用任何闭包内部函数**，所以 `app.js` 无需改动。

**其他**：`android:configChanges="orientation|screenSize|keyboardHidden"` 避免旋转时 WebView 重载；
`WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)` 便于调试。

### 6.2 ServerPrefs —— 地址配置

- 首次启动没有地址 → 进配置界面，输入 `主机:端口`（默认端口 19388），或完整 `https://主机:端口`
- 存 `SharedPreferences`
- 提供「测试连接」：请求 `/login`，把结果（可达 / 证书指纹不符 / 401）如实显示
- 校验：只接受 host + 可选 port，**拒绝带路径的输入**

### 6.3 CertPinner —— 指纹固定（TOFU）

`onReceivedSslError(view, handler, error)`：

```java
X509Certificate cert = error.getCertificate().getX509Certificate();   // API 29+，minSdk 29 正好可用
String fp = sha256Hex(cert.getEncoded());
```

**`handler.proceed()` 只有两条路径能到达：**

1. 命中已存的指纹
2. 首次连接，用户核对指纹（分组显示、大写十六进制）后明确点了「信任」→ 存指纹 + proceed

其余一律 `handler.cancel()`。

**⚠️ 安全要点**：绝不能出现无条件的 `proceed()`。这个函数是本次改动里唯一"写错也照样能跑、但会静默拆掉 TLS 校验"的地方，必须让它只有上述两条出口。

**服务侧复用同一个指纹比对**：`MirrorService` 用自定义 `X509TrustManager`，指纹不符时在握手阶段抛异常。
这比 `onReceivedSslError` 更干净 —— 连接根本建立不起来，不存在"忘了 cancel"的可能。

> 指纹固定有个副作用：**插件重新生成证书后（比如局域网 IP 变了）App 会拒绝连接**，
> 需要用户重新核对指纹。这是正确行为，但要在界面上给出清楚的提示，而不是只报"连接失败"。

### 6.4 MirrorService —— 前台服务 + 通知

见 §7。

### 6.5 清单与权限

```xml
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />          <!-- 13+ 运行时申请 -->
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_DATA_SYNC" /> <!-- 14+ 必须 -->

<application
    android:usesCleartextTraffic="false"
    android:networkSecurityConfig="@xml/network_security_config">
    <activity android:name=".MainActivity" android:exported="true"
              android:configChanges="orientation|screenSize|keyboardHidden" />
    <service android:name=".MirrorService"
             android:exported="false"
             android:foregroundServiceType="dataSync" />
</application>
```

---

## 7. 通知机制

### 7.1 为什么不能靠 WebView 里的 JS

| 场景 | 页面 JS 的状态 |
|---|---|
| App 切到后台 | Activity `onStop`，WebView 的 JS 定时器被系统节流 |
| 划掉最近任务 | Activity 销毁，WebView 连带没了，**JS 彻底停** |
| 锁屏久了 | 进程可能被回收 |

所以通知必须由**前台服务独立完成**，不依赖 WebView。

### 7.2 最终方案：轮询两个只读端点

原计划是让服务自己开一条 `/api/follow` SSE。勘察后发现**页面没有把会话 id 写进 URL**
（没有 `location.hash`、没有 `pushState`），服务无从得知要盯哪个会话 —— 那就得在 `app.js`
里加 `setWatch(sessionId)`。

但插件已经有这两个端点，不需要 SSE：

```
GET /api/questions       不带 id 时返回【所有会话】的待答问题
                         （lib/server.js:1080 → questionHub.list(null)）

GET /api/sessions        每个会话带 running 标记
                         （lib/mirror.js:195）
```

**服务直接轮询它们。**

```
MirrorService（前台服务）
  ┌─ 循环 ────────────────────────────────────────────┐
  │ 1. GET /api/questions                            │
  │      有待答问题 → 高优先级通知（响铃 + 震动）        │
  │ 2. GET /api/sessions                             │
  │      running 由真转假 → 普通通知"一轮跑完了"        │
  │ 3. 决定下次间隔：                                  │
  │      有会话在跑 → 4 秒                             │
  │      什么都没跑 → 20 秒（省电）                     │
  │ 4. 去重：同一个问题 id 只响一次                      │
  └──────────────────────────────────────────────────┘
```

### 7.3 为什么轮询比 SSE 好

| | 轮询两个端点 | 服务里维护 SSE |
|---|---|---|
| 覆盖范围 | **所有会话** —— 在电脑上别的会话里提问也能收到 | 只有知道 id 的那一个 |
| **页面改动** | **0 行** | 要加 `setWatch(sessionId)` |
| 切网 / 息屏 / Doze | 每次都是独立短请求，自动恢复 | 要自己写重连 + 退避 + 心跳 |
| Java 代码量 | 少（两个 GET + `org.json`） | 多（SSE 行解析、断线重连状态机） |
| 延迟 | 4 秒 | 近实时 |
| 耗电 | 极低（空闲 20 秒一次） | 长连接要保活 |

延迟 4 秒对"有人等你回答"完全够用。而**"所有会话都能通知"**是 SSE 方案给不了的。

### 7.4 登录态与 TLS

**登录态**：`CookieManager.getCookie("https://<host>:<port>")` 取 `dsh_mm_session`
（Cookie 名见 `lib/server.js:52`），服务直接用。**不存密码、不重新登录。**

**TLS**：`HttpsURLConnection` + 自定义 `X509TrustManager`，只接受固定的那个指纹（复用 `CertPinner`）。

### 7.5 页面侧：零改动

用轮询后，`addJavascriptInterface` **完全不需要**了：

| 原本需要 bridge 的事 | 现在怎么解决 |
|---|---|
| 服务知道该盯哪个会话 | 不需要知道 —— 轮询覆盖所有会话 |
| 页面把登录态传给服务 | `CookieManager.getCookie()` 直接读 |
| 点通知回到对应会话 | `PendingIntent` 回 MainActivity |

**所以 `lib/web/*` 一行都不用改，`app.js` 零回归风险。**
原本方案里专门讲 `addJavascriptInterface` 安全风险的那一节，因此整段作废。

### 7.6 通知渠道

| channel | importance | 用途 |
|---|---|---|
| `questions` | `IMPORTANCE_HIGH` | 有人提问 —— 响铃 + 震动 |
| `turn` | `IMPORTANCE_DEFAULT` | 一轮跑完 |
| `service` | `IMPORTANCE_LOW` | 前台服务常驻（Android 硬性要求） |

**去重**：已通知过的 question id 存 `SharedPreferences`。
只放内存的话，服务重启会把还挂着的旧问题**再响一遍**。

---

## 8. 安全设计

| 面 | 措施 |
|---|---|
| TLS | 指纹固定。WebView 侧只有两条 `proceed()` 出口；服务侧指纹不符直接握手失败 |
| 导航 | `shouldOverrideUrlLoading` 只允许同源，其余交给系统浏览器 |
| WebView 沙箱 | `allowFileAccess=false`、`allowContentAccess=false`、`MIXED_CONTENT_NEVER_ALLOW` |
| JS 桥 | **不使用** `addJavascriptInterface`（见 §7.5） |
| 明文 | `usesCleartextTraffic="false"` |
| 凭据 | 服务不存密码，只读 Cookie；地址存 `SharedPreferences` |
| 导出 | `MainActivity` exported（启动器需要）；`MirrorService` `exported="false"` |

---

## 9. 诚实的限制

1. **前台服务必须常驻一条通知** —— Android 硬性要求，去不掉，只能做得低调
2. 需要 `POST_NOTIFICATIONS` 权限（Android 13+），首次要用户点授权
3. 需要声明前台服务类型 `dataSync`（Android 14+ 硬性要求）
4. **息屏 / Doze 下轮询会被推迟** —— 前台服务保住了进程，但定时器可能不准。
   想要更准时得上 `AlarmManager.setExactAndAllowWhileIdle`，复杂度和耗电都上一个台阶。
   先按普通循环做，实测不够再升级。
5. 极端内存压力下进程被杀 → 通知断到用户重开 App
6. **证书重新生成后 App 会拒绝连接**（见 §6.3），需要重新核对指纹
7. 延迟 4 秒（可调到 2 秒，代价是耗电）
8. 手感不是原生

---

## 10. 构建与交付

### 10.1 构建命令

```powershell
# JDK 用 17 或 21（AGP 8.5.2 不支持过新的 JDK，例如 26 会直接失败）
$env:JAVA_HOME = 'C:\\Program Files\\Zulu\\zulu-21'
cd <仓库路径>\android
.\gradlew.bat assembleDebug        # macOS / Linux 用 ./gradlew assembleDebug
```

`android/local.properties`（不进版本库，各人不同）：

```properties
sdk.dir=D\:\\AndroidStudio\\SDK
```

也可以不写这个文件，改为设置 `ANDROID_HOME` 环境变量，二者有一个即可。

### 10.2 交付

构建产物 `android/app/build/outputs/apk/debug/app-debug.apk` → 复制到 `out/`（已 gitignore）。

**交付包一律从干净构建取**：`gradlew clean assembleDebug`。增量构建会在 ZIP 里留几十 KB
**页对齐填充**（假本地头 + 纯零），体积虚高。

**用户自己装到手机**（不用 adb）：从 `out/` 取文件，用微信 / USB 传到手机。
手机需允许「安装未知来源应用」。

### 10.3 .gitignore

构建产物与本地配置不进版本库，**已落地**，见仓库根目录的 `.gitignore`：
`out/`、`android/local.properties`、`android/.gradle/`、`android/build/`、`android/app/build/`、
`android/app/release/`、`android/.cxx/`、`android/.idea/`、`*.iml`。

---

## 11. 分步计划

### A1 —— 外壳（先交付这个）

1. 准备 `gradlew`、`gradlew.bat`、`gradle/wrapper/gradle-wrapper.jar`（**已随仓库提交**，无需自备）
2. 写 `settings.gradle.kts` / 根 `build.gradle.kts` / `gradle.properties` / `local.properties`
   —— 版本坐标取已验证的组合：AGP 8.5.2、Gradle 8.9
3. `app/build.gradle.kts`：`namespace dev.dsh.mirror`、minSdk 29、compileSdk/targetSdk 36、
   **零 dependencies**
4. `AndroidManifest.xml` + 矢量图标 + 主题
5. `ServerPrefs` + `activity_setup.xml`：首次配置界面 + 测试连接
6. `CertPinner`：指纹比对（WebView 侧）
7. `MainActivity`：WebView 配置、导航限制、返回键（判断 `#view-list`）、Cookie 持久化
   —— 同时在 `tools/web-test.mjs` 补两条断言钉住 `id="view-list"` / `id="btn-back"`
   （原生侧依赖这两个 id，目前无人看守）
8. `MirrorService` 先只做**前台服务保活**（不含轮询），验证常驻通知与进程存活
9. 构建 → 复制到 `out/` → 交给用户真机验证

**A1 的验收标准**：能装、能连、不弹证书警告、界面正常、返回键行为正确、切后台再回来登录态还在。

### A2 —— 通知

10. `Notifications`：三个渠道 + 权限申请
11. `MirrorService` 轮询循环 + 去重 + 自适应间隔
12. 点通知回到 App（`PendingIntent`）
13. 构建 → 更新 `out/` → 真机验证

### A3 —— 小米超级岛（焦点通知）

> 协议出处：[`github.com/xingguangcuican6666/ABK`](https://github.com/xingguangcuican6666/ABK)（GPL-3.0），
> 相关实现集中在 `app/src/main/java/com/abk/kernel/utils/NotificationUtils.kt`（418 行）。
> **下面的键名与结构取自该文件 —— 它们是 HyperOS 焦点通知的接口事实，不是推测**。
> 本项目只核对这些键名与层级，代码为独立编写的 Java，未使用其代码
> （声明见仓库根目录 `THIRD_PARTY_NOTICES.md`）。

#### A3.1 结论：不需要原生客户端

超级岛是**通知的一个渲染目标**，不是界面渲染方式。做法就是给已有的 `Notification`
附加两个 extras。WebView 外壳的 `MirrorService` 本来就在发通知 —— 所以只改通知层，
**不动 WebView、不动 `lib/web/*`、不动 A1/A2 的任何设计**。

参考实现用 Kotlin，但用到的全是原生 API（`Bundle` / `Icon` / `Settings.System` /
`contentResolver.call` / `JSONObject` / 反射读 `SystemProperties`）。
**它引的 `NotificationCompat` 只是书写方便，可以换成原生 `Notification.Builder`（API 26+）**
—— 零依赖的约束不受影响。

#### A3.2 四个门槛（当时反推出来的启发式）

> ⚠️ **这四条是第三方实现里出现过的启发式，不是官方接口说明**；任何一条误判，都会把
> 本来能用的岛静默关掉。1.1 起本项目**不再检查它们**（理由见 `IslandSupport.attach` 的注释），
> 这里只留作协议备查。

| # | 判据 | 取值 |
|---|---|---|
| ① | 厂商 / 品牌 | `Build.MANUFACTURER`、`Build.BRAND` 含 `xiaomi` / `redmi` / `poco` |
| ② | 系统属性（非公开 API，需反射读） | `persist.sys.feature.island` 为 true |
| ③ | 系统设置 | `notification_focus_protocol` 恰为 `3`（即只支持 OS3 协议） |
| ④ | 焦点通知权限 | 见下 |

权限是**运行时按包名查询**，不是向小米申请白名单：向 ContentProvider
`content://miui.statusbar.notification.public` 调 `canShowFocus`，入参带本包名，
返回的 Bundle 里 `canShowFocus` 为 true 即通过。

> ✅ **这一条解答了之前的疑问**：第三方 App 能否上岛由系统按包名裁定，
> 不需要开发者资质审核。用户需在 HyperOS 设置里为本 App 打开「焦点通知」。

> ⚠️ **只支持 OS3 协议**：门槛 ③ 要求系统设置**恰好等于 3**。若用户设备是
> HyperOS 1/2，这段代码直接不生效。届时需要另找旧协议的格式。

#### A3.3 两个 extras（加在 `notification.extras` 顶层）

```java
// 在 builder.build() 之后改 notification.extras
notification.extras.putString("miui.focus.param", json);
Bundle pics = new Bundle();
pics.putParcelable("miui.focus.pic_<name>", Icon.createWithResource(ctx, R.mipmap.ic_launcher));
notification.extras.putBundle("miui.focus.pics", pics);
```

JSON 里的 `pic` / `picDark` 填的就是 `pics` 里的那个键名。

#### A3.4 JSON 结构（`miui.focus.param` 的值）

外层是**单键** `param_v2`：

```json
{ "param_v2": {
    "protocol": 1,
    "business": "<自定义标识>",
    "islandFirstFloat": false,
    "enableFloat": false,
    "updatable": true,
    "filterWhenNoPermission": false,
    "ticker": "...",
    "aodTitle": "...",
    "baseInfo": { "type": 1, "title": "...", "content": "...", "colorTitle": "#RRGGBB" },
    "param_island": {
      "islandProperty": 1,
      "highlightColor": "#RRGGBB",
      "bigIslandArea": {
        "imageTextInfoLeft": { "type": 1, "picInfo": { "type": 1, "pic": "<name>", "picDark": "<name>" } },
        "progressTextInfo": {
          "progressInfo": { "progress": 50, "colorReach": "#RRGGBB", "colorUnReach": "#AARRGGBB" },
          "textInfo": { "title": "50%", "narrowFont": true, "showHighlightColor": false }
        }
      },
      "smallIslandArea": {
        "picInfo": { "type": 1, "pic": "<name>", "picDark": "<name>" },
        "textInfo": { "title": "50%", "narrowFont": true, "showHighlightColor": false }
      },
      "shareData": { "title": "..." }
    },
    "progressInfo": { "progress": 50, "colorProgress": "#RRGGBB", "colorProgressEnd": "#RRGGBB" },
    "hintInfo": { "type": 1, "title": "50%" }
} }
```

- 颜色是 `#RRGGBB` 或 `#AARRGGBB`（如 `#24000000` = 15% 黑）
- 文本先折叠空白再截断：**title ≤ 24、content ≤ 48、ticker ≤ 32**，超出加 `...`

#### A3.5 我们的适配点（与那份实现的差异）

参考实现是**编译进度条**（有 0–100%），我们的两个场景**都没有百分比**：

| 场景 | 岛里显示 | 用哪部分 |
|---|---|---|
| 运行中 | "DSH 正在思考" + 计时器 | `baseInfo` + `smallIslandArea.textInfo` |
| 等你回答 | "DSH 在等你回答" | 同上，配高优先级通知 |

> ⚠️ **未验证**：参考实现**始终**带 `progressInfo` / `progressTextInfo`。
> 去掉这些字段后岛是否照常渲染，**没有依据，必须真机试**。
> 这是 A3 第一个要试的东西。

#### A3.6 失败安全（硬要求）

挂 extras 这一步**绝不能影响通知本身**：JSON 构造失败、`extras` 为 null、系统不认这套字段，
结果都只是"这条通知没有岛"，通知照常以普通形式发出。
**绝不能因为超级岛不可用而丢通知。**

1.1 起也不再预先检查 A3.2 那四条门槛 —— 理由见 `IslandSupport.attach` 的注释：
门槛是反推的启发式，误判会把本来能用的岛静默关掉；不设门槛最坏只是多挂两个被忽略的 extras。

#### A3.7 施工顺序

14. **先做"测试超级岛"按钮的验证版** —— App 里一个按钮，只发一条纯测试通知
    （固定文本、无业务逻辑），快速确认四门槛与 JSON 是否被接受
15. 确认后再接进 `MirrorService` 的真实通知
16. 去重/更新用 `setOnlyAlertOnce(true)` + `setOngoing(true)`，避免进度更新反复打扰

> **调试循环慢**：不能用 adb，只能"改一次 → 装一次 → 看一眼"。
> 所以第 1 步要尽量把变量收敛到最少。

### 收尾

17. 更新 `README.md`（新增 APK 一节）
18. 更新 `.gitignore`
19. 跑全套测试确认 `lib/web/*` 零回归

---

## 12. 待确认 / 风险

| # | 事项 | 说明 |
|---|---|---|
| 1 | 首次构建耗时 | AGP 与其依赖已在缓存，但新项目仍可能拉少量新构件。网络可达，预计几分钟 |
| 2 | compileSdk 36 + AGP 8.5.2 | 该组合已构建成功，但 AGP 8.5.2 官方支持上限是 34，会出警告（已用 `android.suppressUnsupportedCompileSdk=36` 消掉）。若报错，退到 compileSdk 34 或升级 AGP（需同步升 Gradle） |
| 3 | 图标 | 用矢量自适应图标，不需要 PNG，也不需要额外工具 |
| 4 | 用户手机 Android 版本 | 已确认 ≥ 10（选了 minSdk 29）。若实际更低需回退 minSdk，届时指纹固定要补老 API 回退 |
| 5 | 息屏轮询准时性 | 见 §9.4，先按普通循环做 |
| 6 | `out/` 是否进版本库 | 计划 gitignore 掉（构建产物）。若用户希望留档可改为提交 |

---

## 13. 关键参考（施工时直接查这里）

| 事实 | 位置 |
|---|---|
| Cookie 名 `dsh_mm_session` | `lib/server.js:52` |
| `GET /api/questions`（无 id = 全部） | `lib/server.js:1080` |
| `GET /api/sessions`（带 running） | `lib/server.js:830`、`lib/mirror.js:195` |
| `GET /api/follow`（SSE，本方案不用） | 路由 `lib/server.js:1150`，帧写入 `:1207` |
| SSE 帧格式 `data: {e,d}\n\n` | `lib/server.js:1207` |
| 帧类型 `snapshot` / `event` / `question` / `error` | `lib/mirror.js:635,638,1469`、`lib/server.js:1137` |
| 页面返回列表的按钮 `#btn-back` | `lib/web/index.html:54`，绑定见 `lib/web/app.js:1094` |
| **视图容器 `#view-list`（返回键要判断的就是它）** | `lib/web/index.html:25`，切换见 `lib/web/app.js:1135` |
| 会话列表容器 `#list`（`#view-list` 的内层，**从不隐藏**） | `lib/web/index.html:42` |
| 视图切换 `setView('list'|'chat')` | `lib/web/app.js:1133` |
| 已验证的 Gradle/AGP 组合 | `android/build.gradle.kts`（AGP 8.5.2）、`android/gradle/wrapper/gradle-wrapper.properties`（Gradle 8.9） |

### 超级岛（A3）协议出处

| 事实 | 位置 |
|---|---|
| **参考项目** | [`github.com/xingguangcuican6666/ABK`](https://github.com/xingguangcuican6666/ABK)（第三方开源项目，GPL-3.0）。**只取键名与结构这类接口事实，实现为独立编写的 Java，未使用其代码**；声明见 `THIRD_PARTY_NOTICES.md` |
| 超级岛完整实现（418 行，全仓仅此一处） | 上述仓库的 `app/src/main/java/com/abk/kernel/utils/NotificationUtils.kt` |
| 四个门槛 `canUseMiuiSuperIsland` | 同上 `:267-272` |
| 权限查询 `canShowFocus` | 同上 `:295-304` |
| 两个 extras 的键名 | 同上 `:40-42` |
| 附加 extras 的位置 | 同上 `:253-265`（`builder.build()` 之后改 `notification.extras`） |
| JSON 构造 `buildMiuiBuildIslandParams` | 同上 `:306-382` |
| 文本截断规则 | 同上 `:384-388`（title 24 / content 48 / ticker 32） |

> ⚠️ 参考项目是**别人写的**（GPL-3.0），只作协议事实的对照。里面的业务逻辑（内核编译进度）
> 与我们无关，**不要引入它的任何代码**，只取 extras 键名与 JSON 结构这类接口事实。
