# dsh-mobile-mirror

在局域网里用**手机镜像 DSH（DeepSeek Harness）的会话**：看会话列表（按工作区分组）、看历史、
看**实时逐字输出**，以及**发消息**、**停止当前轮**、**新建会话**、**切换会话的模型与模式**、
**在手机上回答 DSH 的提问**。

**桌面端行为完全不变** —— 不注入 UI、不遮挡、不改布局。手机页面走自己的端口，
DSH 现有 webServer 的 host / port / 既有行为一律不动（只额外挂一条**只读、仅回环**的
JSON 路由给桌面设置面板取地址）。

> 当前版本 **1.1**。
> 仅测试运行DSH Windows桌面端0.2.0-rc.2与HyperOS3

---

## 特性

### 手机端（`https://<电脑局域网IP>:19388/`）

| 能力 | 说明 |
|---|---|
| 会话列表 | 按工作区分组、可折叠（折叠状态记在 `localStorage`）、子智能体会话紧跟父会话 |
| 实时输出 | SSE 逐字推送；切后台回来自动补齐，不丢不重 |
| 发消息 | 幂等（`requestId`）+ 每会话 300ms 节流；弱网重发不会重复发出 |
| 停止当前轮 | 需二次确认 |
| 新建会话 | 从工作区清单里选，或手输任意绝对路径（一个会话都没有的新文件夹也能开） |
| 模型 / 模式 | 切换会话的模型（含推理档位）与模式（标准 / PTC / 极简 / 创造 + 自建） |
| 回答提问 | 手机与桌面谁先答谁生效；桌面 GUI 没开时手机照样能答 |
| Markdown | 标题 / 列表 / 表格 / 任务列表 / 引用 / 代码块（带语言名与复制键），手写实现 |
| 主题 | 深浅两套跟随系统；内嵌 JetBrains Mono（**只用于代码**） |
| 干净的消息流 | AGENTS.md、运行时上下文、技能目录等**注入内容在宿主侧就被丢掉**，手机上只剩真人说的话 |

### 桌面设置面板

DSH 设置里多一页「手机镜像」：手机访问地址（一键复制、按连通性排序、其他网卡可展开）、
本机设置页直达链接，以及协议 / 端口 / 账号 / 口令状态 / 证书指纹 / 有效期 / 在线会话数。
打开期间每 10 秒自动刷新，换 Wi-Fi 导致 IP 变了会自己跟上。

### APK

`android/` 里是一个纯 Java、零第三方依赖的 **WebView 外壳**，把手机页面装进 App 并做三件
网页做不到的事：

1. **证书指纹固定（TOFU）** —— 不用装系统 CA，信任只限本 App；
2. **通知** —— 前台服务轮询两个只读端点，DSH 提问或一轮跑完时手机锁屏也能知道；
3. **小米超级岛** —— 有会话在跑就上岛、岛上显示会话标题、出现提问时变色。（仅测试HyperOS3）

详见 [docs/apk-plan.md](docs/apk-plan.md)。

---

## 为什么是独立端口 / 为什么有 HTTPS

DSH 自己的 Web 服务只监听 `127.0.0.1`。把它的 `host` 改成 `0.0.0.0` 虽然一行配置就能让
手机打开完整 GUI，但那等于把**整个 GUI 和全部 `/api` 暴露到局域网**。

本插件换一条路：自己起一个只服务手机页面的小 HTTPS 服务（默认 `0.0.0.0:19388`），
只放行手机页面需要的接口，自带独立凭据。桌面 GUI 与 `/api` 的暴露面保持不变，
关掉插件就彻底消失。

局域网明文 HTTP 下，同一个 Wi-Fi 里任何能抓包的人都能拿到你的密码，所以默认走 TLS。
证书是**现场签发的自签证书**，不依赖 openssl、不引第三方包 —— `lib/asn1.js` + `lib/cert.js`
手写 DER 组装 X.509，`node:crypto` 生成密钥与签名。

---

## 环境要求

| 项 | 要求 |
|---|---|
| DSH | 桌面端0.2.0-rc.2。插件接口用 `dsh.bundle.patch` + `dsh.client`（桌面设置面板需要后者） |
| Node.js | **>= 20** |
| npm 依赖 | **无**。宿主侧、页面、测试全部零第三方依赖 |
| 手机 | 与电脑在**同一局域网**；iOS Safari / Android Chrome 均可 |
| 构建 APK（可选） | JDK **17 或 21**、Android SDK **Platform 36** + **Build-Tools 36** |

---

## 安装

本插件是 DSH bundle 插件，通过 profile 的 `package.json` 注册。
**把下面所有 `<路径>` 换成你克隆本仓库的实际绝对路径。**

### 1. 克隆

```bash
git clone https://github.com/ImHaoYuan/dsh-mobile-mirror.git
```

### 2A. 手动 link

编辑 DSH profile 的 `package.json`（默认 `~/.dsh/profiles/desktop/package.json`）：

```json
{
  "dependencies": {
    "dsh-mobile-mirror": "link:<你克隆到的绝对路径>"
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

然后在 profile 目录里建好链接（`npm install` / `pnpm install`），**重启 DSH**。

> Windows 上路径写成正斜杠或双反斜杠，例如 `link:D:/plugins/dsh-mobile-mirror`。

### 2B. 用 DSH 的插件管理器

```
plugin_manager install_bundle  target = link:<你克隆到的绝对路径>
```

它会自动改好 `package.json`、建好 `node_modules` 链接，并**热应用**到运行中的 profile。

### 装好了怎么确认

启动日志里会出现 `listening on 0.0.0.0:19388`；或者打开 DSH 的**设置**，能看到「手机镜像」那一页。

---

## 首次使用：设置账号密码

1. 在**电脑上**打开 `https://127.0.0.1:19388/setup`
   （自签证书，浏览器会先警告一次，点"继续访问"即可）
2. 填账号和密码（至少 6 位），保存。

没设置之前**任何人都登录不了**（fail closed），不存在"没配密码所以谁都能进"。

也可以直接编辑 `$DSH_HOME/mobile-mirror.json` 填明文 `password`，
下次启动会自动转成 scrypt 哈希并把明文从文件里删掉。

---

## 手机访问

1. 手机连**同一个 Wi-Fi**
2. 打开 `https://<电脑局域网IP>:19388/`
   （地址看桌面 **设置 → 手机镜像** 那一页，或 `/setup` 页面的"手机访问地址"）
3. 首次会看到证书警告 —— 自签证书的正常表现：
   - **iOS Safari**：「显示详细信息」→「访问此网站」
   - **Android Chrome**：「高级」→「继续前往」
4. 用刚设的账号密码登录

**想消掉警告**：在电脑上 `/setup` 页面下载 `cert.pem`，装到手机上：

- **iOS**：安装描述文件（设置 → 通用 → VPN与设备管理），再到「关于本机 → 证书信任设置」打开完全信任
- **Android**：设置 → 安全 → 加密与凭据 → 安装证书 → CA 证书

不装也能用，只是每次会先看到一个警告页。

**加到主屏幕**：页面已带 `apple-mobile-web-app-capable`，iOS 上"添加到主屏幕"后是全屏、无地址栏。

---

## 桌面设置面板

DSH 界面左下角头像 → 设置，里面会多一页「手机镜像」（排在「智能体预设」之后）：

- **手机访问地址** —— 当前该用哪个 `https://<IP>:19388/`，按最可能连得上排序，一键复制；
  其他网卡（VMware、虚拟网卡、`169.254` 之类）折在「其他网卡」里。
- **本机设置页（回环）** —— `https://127.0.0.1:19388/setup` 的直达链接。
- **状态** —— 协议、端口、账号、口令是否已配置、证书指纹、有效期、在线会话数。

数据来自主机侧在 DSH GUI 服务上注册的**只读、仅回环**路由 `GET /dsh-mirror/info.json`；
拿不到 `webServer` 时只是面板显示「读不到主机信息」，手机镜像本身完全不受影响。
细节与理由见 [docs/design.md](docs/design.md#桌面设置面板的数据通道)。

> 改 `lib/client.js`（浏览器 bundle）与主机侧路由都需要**重启 DSH**。

---

## APK（可选）

只有想用通知 / 超级岛才需要。**本仓库不提交构建产物**，需要自行构建；
在 Releases 页面附了预编译 APK，也可以直接下载安装。

```powershell
# JDK 用 17 或 21（AGP 8.5.2 不支持过新的 JDK，例如 26 会直接失败）
$env:JAVA_HOME = 'C:\Program Files\Zulu\zulu-21'
cd <仓库路径>\android
.\gradlew.bat assembleDebug        # macOS / Linux 用 ./gradlew assembleDebug
```

Android SDK 的定位方式二选一：设 `ANDROID_HOME` 环境变量，或写 `android/local.properties`
（该文件已 gitignore，各人不同）：

```properties
sdk.dir=D\:\\AndroidStudio\\SDK
```

产物在 `android/app/build/outputs/apk/debug/app-debug.apk`，自己传到手机安装
（手机需允许「安装未知来源应用」）。**交付包请从干净构建取**（`gradlew clean assembleDebug`）：
增量构建会在 ZIP 里留几十 KB 页对齐填充，体积虚高。

首次打开 App 要填电脑的 `https://<IP>:19388` 与证书指纹（设置页里能看到），
之后走 TOFU 指纹固定。超级岛还需要在 HyperOS 设置里为本 App 打开「焦点通知」。

---

## 配置

`$DSH_HOME/mobile-mirror.json`（首次启动自动生成，每次启动会归一化重写）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `port` | `19388` | 监听端口 |
| `username` | `dsh` | 登录账号 |
| `passwordHash` | `null` | scrypt 加盐哈希，由 `/setup` 写入 |
| `password` | — | 只用于手写明文，加载后转哈希并删除 |
| `sessionTtlDays` | `30` | 登录会话在**服务端**的有效期。Cookie 不带 `Max-Age`，关掉浏览器就失效，所以这个值只约束"标签页一直开着"的情形 |
| `tls` | `true` | 关掉会退回明文 HTTP（不推荐） |
| `certDir` | `null` | 证书目录，默认 `$DSH_HOME/mobile-mirror-cert` |
| `allowedHosts` | `[]` | 额外的 Host 白名单（一般不需要） |
| `enablePrompt` | `true` | **写操作总开关**。设 `false` 即只读模式：发消息、停止轮次、切换模型、切换模式、回答问题全部返回 403 |

---

## 安全边界（摘要）

- **只在局域网**：不做任何内网穿透。手机在外网时用不了 —— 这是刻意的。
- **Host 校验**：只接受回环、私有网段 IPv4（10 / 172.16–31 / 192.168 / 169.254）或显式白名单，挡 DNS rebinding；回环判定看 socket 真实来源地址，不看 Host 头。
- **跨站一律拒**：`Sec-Fetch-Site: cross-site` 直接 403；带 `Origin` 时必须与 Host 同源。
- **口令**：scrypt 加盐哈希 + `timingSafeEqual`；连续失败指数退避，10 次后锁 5 分钟（锁定期连 scrypt 都不跑）。
- **会话**：HttpOnly + SameSite=Strict + Secure 的随机 Cookie，不带 `Max-Age`；改密码会注销所有旧会话。
- **写操作三道防线**：SameSite=Strict Cookie、Origin 同源、强制 `Content-Type: application/json`。
- **静态资源白名单**：路径必须命中固定表，不做路径拼接，目录遍历天然不成立。

完整清单（含每条路由的认证要求）见 [docs/design.md](docs/design.md#安全边界)。

---

## 开发与测试

```bash
npm test     # 一次跑完八套，共 1589 项
```

| 命令 | 覆盖 | 项数 |
|---|---|---|
| `node tools/cert-test.mjs` | 证书层（含真实 TLS 握手） | 27 |
| `node tools/smoke.mjs` | HTTPS + 认证集成 | 32 |
| `node tools/mirror-test.mjs` | 数据层 + 全部路由（含 P3 / P4 / P5） | 478 |
| `node tools/host-test.mjs` | 入口层：真跑一遍 `apply()`，含桌面面板路由 | 83 |
| `node tools/web-test.mjs` | 页面静态资源断言 + 纯函数 + 接线 + 客户端 bundle | 369 |
| `node tools/client-test.mjs` | 桌面设置面板：bundle 格式、槽注册、字段名耦合 | 61 |
| `node tools/web-pure-test.cjs` | `app.js` 导出的纯函数（重点是 Markdown） | 188 |
| `node tools/web-dom-test.cjs` | 用 fake DOM 真跑一遍页面行为 | 351 |

八套都**不需要启动 DSH**，使用临时目录里的证书与配置，不碰 `$DSH_HOME`。
每套覆盖什么、抓到过什么 bug，见 [docs/design.md](docs/design.md#自测)。

**改代码后要不要重启 DSH：**

| 改哪里 | 生效方式 |
|---|---|
| `lib/web/*.html` / `.js` / `.css` | **即时生效**（每次请求现读磁盘），刷新手机页面即可 |
| `lib/*.js`（宿主侧）、`lib/client.js`、路由 | **必须重启 DSH** |

宿主插件模块按 URL 缓存，`hmr` 只暴露 `watchConfig` / `getLinked`，没有模块失效接口 ——
所以"禁用→启用"拿到的仍是旧代码。这是平台限制，不是插件问题。

---

## 常见问题

**手机打不开页面 / 一直转圈**
先确认手机和电脑在同一个 Wi-Fi（不是访客网络、不是手机热点），再确认地址里的 IP 是**电脑**的
局域网 IP（桌面设置面板里那一串）。电脑防火墙可能拦了 19388 —— 放行入站 TCP 19388 即可。

**浏览器说"不是私密连接"**
自签证书的正常表现。点"继续访问"，或按上面的步骤把 `cert.pem` 装到手机上消掉警告。

**忘了密码**
在电脑上重新打开 `https://127.0.0.1:19388/setup` 重设（回环访问不需要登录）。
也可以在 `mobile-mirror.json` 里写明文 `password` 后重启 DSH。

**模式芯片是灰的**
DSH 的规则：会话一旦跑过至少一轮，模式就锁死了（`preset-locked`）。新建的空白会话才能换。

**端口 19388 被占用**
启动日志会写 `监听 0.0.0.0:19388 失败`。改 `mobile-mirror.json` 的 `port`，重启 DSH。

**超级岛不出现**
先在 HyperOS 设置里为本 App 打开「焦点通知」（超级岛不是申请白名单，而是运行时按包名裁定）；
另外「转圈」做不到 —— 环只来自确定值进度弧，颜色才承担状态语义。

**手机上少了几条消息**
AGENTS.md、运行时上下文、技能目录、审批通知这些注入内容被**故意**丢掉了，只保留真人说的话。
判定用白名单（只认 `source.kind === 'user'`），取不到来源时按真人消息处理 —— 宁可多显示，不会吞掉你说的话。

---

## 目录结构

```
dsh-mobile-mirror/
├── lib/                    宿主侧（Node）
│   ├── index.js            入口：apply()、配置加载、服务启停、桌面面板路由
│   ├── server.js           HTTP(S) 服务、路由、认证、静态资源
│   ├── mirror.js           会话数据 → 镜像协议（事件投影、SSE、注入内容过滤）
│   ├── auth.js             scrypt 口令哈希与会话存储
│   ├── cert.js             自签证书签发与复用
│   ├── asn1.js             手写 DER 组装（不引第三方包）
│   ├── client.js           桌面设置面板的浏览器 bundle（手写，无构建步骤）
│   └── web/                手机页面：index / login / setup + app.js / app.css + 内嵌字体
├── tools/                  八套自测（不需要启动 DSH）
├── android/                WebView 外壳 APK（纯 Java，零第三方依赖）
├── docs/                   design.md（设计说明）、apk-plan.md（APK 方案与施工记录）
├── cordis.patch.yml        DSH bundle patch
├── package.json
└── LICENSE
```

---

## 许可证与致谢

[MIT](LICENSE) © 2026 ImHaoYuan

- 内嵌字体 **JetBrains Mono**（Regular + Bold），SIL Open Font License 1.1，
  许可证全文见 `lib/web/fonts/OFL.txt`。
- 小米超级岛的通知 extras 协议参考了开源项目 [ABK](https://github.com/xingguangcuican6666/ABK)，
  **仅作协议参考，未复制其代码**。
- 界面借用了 DeepSeek 网页端的**组件语言**（助手消息不带气泡、代码块头部条等），
  未使用其商标、图标或文案。

## 更多文档

- [docs/design.md](docs/design.md) —— 镜像协议、事件投影、安全边界、每一项取舍的理由
- [docs/apk-plan.md](docs/apk-plan.md) —— APK 方案选型、超级岛字段与施工记录
