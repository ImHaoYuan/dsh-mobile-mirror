# dsh-mobile-mirror

在局域网里用手机镜像 DSH 的会话：看对话、看实时输出、回复消息、停止当前轮。
**桌面端行为完全不变** —— 不注入 UI、不遮挡、不改布局、不碰现有 webServer。

当前进度：**P0 完成**（独立端口 + HTTPS + 账号密码登录）。会话镜像在 P1。

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
| `enablePrompt` | `true` | 是否允许手机发消息（P2 生效） |

## 路由与认证边界

| 路径 | 认证要求 | 作用 |
|---|---|---|
| `GET /health` | 无 | 存活探测（无任何数据） |
| `GET /cert` | 无 | 下载证书（公钥信息，登录前就得能拿到） |
| `GET /login` · `POST /login` | 无，但**有节流** | 登录页与登录 |
| `GET/POST /setup` | **仅本机（回环）** | 设置账号密码 |
| `GET /pair.json` | **仅本机（回环）** | 诊断信息 |
| `GET /logout` | 需登录 | 退出 |
| `GET /` | 需登录 | 手机主页 |

回环判定看 **socket 的真实来源地址**，不看 Host 头，所以伪造 Host 绕不过去。

## 安全边界

- **Host 校验**：只接受回环、私有网段 IPv4（10 / 172.16–31 / 192.168 / 169.254）
  或显式白名单，挡 DNS rebinding。
- **跨站一律拒**：`Sec-Fetch-Site: cross-site` 直接 403；带 `Origin` 时必须与 Host 同源。
- **口令**：scrypt 加盐哈希，异步实现（不阻塞宿主事件循环）；比较走 `timingSafeEqual`。
- **节流**：同来源连续失败指数退避（1s→30s），10 次后锁 5 分钟；
  节流在哈希之前生效，被锁的请求连 scrypt 都不跑，避免被刷成对 DSH 的拒绝服务。
- **会话**：HttpOnly + SameSite=Strict + Secure 的随机 Cookie；改密码会注销所有旧会话。
- **只在局域网**：不做任何内网穿透。手机在外网时用不了 —— 这是刻意的。

## 自测

```bash
node tools/cert-test.mjs    # 证书层：27 项
node tools/smoke.mjs        # 集成：HTTPS + 认证 32 项
```

都不需要启动 DSH，使用临时目录里的证书与配置，不碰 `$DSH_HOME`。

`cert-test.mjs` 的关键一项是**真实 TLS 握手**：拿生成的证书起一个 HTTPS 服务，
用 `rejectUnauthorized: true` + 指定 CA 连上去。能过就说明这张手写的证书在
OpenSSL 眼里结构正确、签名有效、对该地址有效。另外还验证了负向情况
（不信任该 CA 时必须失败、域名不匹配时必须失败），确保它不是"碰巧能用"。

## 开发注意事项

**改 `lib/*.js`（宿主代码）需要重启 DSH。**
DSH 的宿主插件模块按 URL 缓存，`hmr` 服务只暴露 `watchConfig` / `getLinked`，
没有模块失效接口 —— 所以"禁用→启用"拿到的仍是旧代码。这是平台限制，不是插件问题。

**改 `lib/web/*.html` 即时生效**，不需要重启：页面是每次请求现读磁盘的。

## 路线图

- **P0（已完成）**：独立端口监听、HTTPS 自签证书、账号密码登录、设置页。
- **P1**：会话列表、历史快照、实时逐字输出（`sessionController.follow`）。
- **P2**：手机发消息（`prompt`）、停止当前轮（`cancel`）。
- **P3**：二维码配对、桌面内配对页、多网卡地址选择。
