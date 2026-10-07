/**
 * dsh-mobile-mirror —— 手机镜像服务（与 Cordis 解耦的纯 Node 实现）。
 *
 * 设计约束（方案 v2 + 认证改造）：
 *   1. **独立端口、独立监听**：不注册到 DSH 现有 webServer，不碰它的 host/port，
 *      因此桌面 GUI 与 /api 的暴露面完全不变。关掉插件即彻底消失。
 *   2. **只面向局域网**：默认监听 0.0.0.0，但所有响应都先过一道 Host 校验
 *      （回环 / 私有网段 / 显式白名单），挡住 DNS rebinding。
 *   3. **HTTPS（自签）**：局域网明文 HTTP 会让同网段抓包者拿到密码，
 *      所以默认走 TLS；证书由 ./cert.js 现场签发，不需要 openssl、不引依赖。
 *   4. **账号密码**：口令以 scrypt 加盐哈希存储；会话走 HttpOnly Cookie。
 *   5. **可脱离 DSH 测试**：不 import 任何 DSH 内部模块。
 */

import http from 'node:http'
import https from 'node:https'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

import { ensureCert, describeCert } from './cert.js'
import {
  hashPassword, verifyPassword, safeEqual, validUsername, validPassword,
  createSessionStore, createThrottle, MIN_PASSWORD_LENGTH,
} from './auth.js'
import { listSessions, openFollow, encodeFollowFrame, pageBack, sendPrompt, cancelTurn, validatePrompt, createPromptLedger, createRateGate } from './mirror.js'

/** 包根目录：lib/server.js -> 包根。 */
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 静态资源目录（手机页面）。 */
export const WEB_ROOT = path.join(PACKAGE_ROOT, 'lib', 'web')

/** 默认监听端口。19387 是 DSH 自己的 Web 端口，刻意错开。 */
export const DEFAULT_PORT = 19388

/** 配置文件放在 $DSH_HOME 下，node_modules 可能只读或被更新清掉。 */
export const CONFIG_NAME = 'mobile-mirror.json'

/** 自签证书目录。 */
export const CERT_DIR_NAME = 'mobile-mirror-cert'

/** 会话 Cookie 名。 */
export const SESSION_COOKIE = 'dsh_mm_session'

/** POST 请求体上限。 */
const MAX_BODY_BYTES = 16 * 1024

/** JSON 请求体上限。比表单宽松：一条消息最多 8000 字符，加上 JSON 包装与转义。 */
const MAX_JSON_BYTES = 64 * 1024

/** 允许直接下发的静态文件（白名单，不做目录遍历）。 */
const STATIC_FILES = new Map([
  ['/', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/index.html', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/login', { file: 'login.html', type: 'text/html; charset=utf-8' }],
  ['/setup', { file: 'setup.html', type: 'text/html; charset=utf-8' }],
  // 资源文件走 raw：不做 {{}} 模板替换。JS/CSS 里出现的 {{ 只可能是代码本身，
  // 替换会把它改坏（而且每次请求重读重替换纯属浪费）。
  ['/app.css', { file: 'app.css', type: 'text/css; charset=utf-8', raw: true }],
  ['/app.js', { file: 'app.js', type: 'text/javascript; charset=utf-8', raw: true }],
])

/** DSH 主目录。 */
export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

/** 配置文件绝对路径。 */
export function configPath() {
  return path.join(dshHome(), CONFIG_NAME)
}

/** 证书目录绝对路径。 */
export function certDir(config = {}) {
  return config.certDir || path.join(dshHome(), CERT_DIR_NAME)
}

/**
 * 读取（必要时创建）插件配置。同步，不含任何 CPU 密集工作。
 * 读失败不抛异常：插件加载失败会连带拖垮宿主，这里一律降级到内存默认值。
 * @param file - 配置文件路径。
 * @param log - 日志函数。
 * @returns 归一化后的配置。
 */
export function loadConfig(file = configPath(), log = console.log) {
  let raw = {}
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    if (err && err.code !== 'ENOENT') {
      log(`[mobile-mirror] 配置文件读取失败，将按默认值重建：${err && err.message}`)
    }
  }

  const config = {
    port: Number.isInteger(raw.port) && raw.port > 0 && raw.port < 65536 ? raw.port : DEFAULT_PORT,
    username: typeof raw.username === 'string' && raw.username ? raw.username : 'dsh',
    passwordHash: typeof raw.passwordHash === 'string' && raw.passwordHash ? raw.passwordHash : null,
    // 手写明文的口令：finalizeConfig() 会把它转成哈希并从文件里删掉
    password: typeof raw.password === 'string' && raw.password ? raw.password : null,
    sessionTtlDays: Number.isFinite(raw.sessionTtlDays) && raw.sessionTtlDays > 0
      ? Math.min(raw.sessionTtlDays, 365)
      : 30,
    tls: raw.tls !== false,
    certDir: typeof raw.certDir === 'string' && raw.certDir ? raw.certDir : null,
    allowedHosts: Array.isArray(raw.allowedHosts) ? raw.allowedHosts.map((x) => String(x)) : [],
    enablePrompt: raw.enablePrompt !== false,
  }

  return config
}

/** 写回配置文件（去掉不该落盘的字段）。 */
export function writeConfig(config, file = configPath(), log = console.log) {
  const onDisk = {
    port: config.port,
    username: config.username,
    passwordHash: config.passwordHash,
    sessionTtlDays: config.sessionTtlDays,
    tls: config.tls,
    certDir: config.certDir,
    allowedHosts: config.allowedHosts,
    enablePrompt: config.enablePrompt,
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `${JSON.stringify(onDisk, null, 2)}\n`, 'utf8')
    return true
  } catch (err) {
    log(`[mobile-mirror] 配置文件写入失败：${err && err.message}`)
    return false
  }
}

/**
 * 把配置收敛成可用状态：手写明文口令 → scrypt 哈希并落盘。
 * 这是唯一一处异步的初始化工作（scrypt 走线程池，不阻塞宿主）。
 * @param config - loadConfig() 的结果。
 * @param file - 配置文件路径。
 * @param log - 日志函数。
 * @returns 同一个 config 对象（已就地更新）。
 */
export async function finalizeConfig(config, file = configPath(), log = console.log) {
  if (config.password) {
    if (!validPassword(config.password)) {
      log(`[mobile-mirror] 配置文件里的 password 太短（至少 ${MIN_PASSWORD_LENGTH} 位），已忽略`)
      config.password = null
    } else {
      config.passwordHash = await hashPassword(config.password)
      config.password = null
      log('[mobile-mirror] 已把配置文件里的明文 password 转为 scrypt 哈希并移除明文')
    }
  }
  // 每次启动都把归一化后的配置写回：首次运行据此生成出文件，同时顺手清掉
  // 旧版本残留的字段（例如早期基于 token 的认证留下的 token）。
  writeConfig(config, file, log)
  return config
}

/**
 * 枚举本机可用的局域网 IPv4 地址，并按"手机最可能连得上"排序。
 *
 * 为什么需要排序：这台机器同时有 VMware、cfw-tap、169.254 自动地址等多张网卡，
 * 直接取第一个几乎必然取错。
 * @returns 排序后的候选地址列表。
 */
export function lanCandidates() {
  const out = []
  const interfaces = os.networkInterfaces()
  for (const [name, addresses] of Object.entries(interfaces)) {
    for (const address of addresses || []) {
      if (address.family !== 'IPv4' || address.internal) continue
      out.push({ name, address: address.address, netmask: address.netmask })
    }
  }

  const score = (entry) => {
    let value = 0
    if (/vmware|virtualbox|vethernet|hyper-v|wsl|cfw-tap|loopback|tailscale|zerotier|clash|tun|tap/i.test(entry.name)) {
      value -= 100
    }
    if (entry.address.startsWith('192.168.')) value += 30
    else if (entry.address.startsWith('10.')) value += 20
    else if (entry.address.startsWith('172.')) value += 10
    if (entry.address.startsWith('169.254.')) value -= 50
    return value
  }

  return out.sort((a, b) => score(b) - score(a))
}

/**
 * 是否为私有网段 IPv4（含回环与链路本地）。
 * @param host - 主机名。
 * @returns 是否为私有/回环 IPv4 字面量。
 */
export function isPrivateIPv4(host) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(host || ''))
  if (!match) return false
  const [a, b] = match.slice(1).map(Number)
  if ([a, b, Number(match[3]), Number(match[4])].some((n) => n > 255)) return false
  if (a === 127) return true
  if (a === 10) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 169 && b === 254) return true
  return false
}

/**
 * 主机名是否属于回环。
 * 逐段校验，避免 `127.0.0.1.evil.com` 这类相似域名蒙混过关。
 * @param host - Host 头里的主机名（不含端口）。
 * @returns 是否为回环。
 */
export function isLoopbackHostname(host) {
  const name = String(host || '').toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  if (!name) return false
  if (name === 'localhost' || name.endsWith('.localhost')) return true
  if (name === '::1') return true
  return isPrivateIPv4(name) && name.startsWith('127.')
}

/** 从 Cookie 头里取出某个 Cookie 的值。 */
function readCookie(header, name) {
  const text = String(header || '')
  for (const part of text.split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    if (part.slice(0, index).trim() !== name) continue
    return decodeURIComponent(part.slice(index + 1).trim())
  }
  return undefined
}

/** 读取并解析 POST 表单体。 */
function readForm(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      const params = new URLSearchParams(text)
      const out = {}
      for (const [key, value] of params) out[key] = value
      resolve(out)
    })
    req.on('error', reject)
  })
}

/**
 * 读取并解析 JSON 请求体（P2 写操作用）。
 * 刻意不复用 readForm：JSON 需要更大的上限，而且这里必须拒绝非对象顶层值。
 * @param req - 请求。
 * @returns 解析后的对象；空体返回 {}。
 * @throws 体积超限、非法 JSON、顶层不是对象时抛错。
 */
function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_JSON_BYTES) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (!text.trim()) return resolve({})
      let parsed
      try {
        parsed = JSON.parse(text)
      } catch {
        return reject(new Error('invalid json'))
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return reject(new Error('invalid json'))
      }
      resolve(parsed)
    })
    req.on('error', reject)
  })
}

/** HTML 转义，防止把用户输入原样插进页面。 */function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** 读模板并做 {{KEY}} 替换。 */
function renderTemplate(webRoot, file, vars) {
  const html = fs.readFileSync(path.join(webRoot, file), 'utf8')
  return html.replace(/\{\{([A-Z0-9_]+)\}\}/g, (whole, key) => (
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : whole
  ))
}

/** 登录失败原因的展示文案。 */
const LOGIN_ERRORS = {
  missing: '请填写账号和密码',
  bad: '账号或密码不正确',
  unconfigured: '尚未设置账号密码 —— 请先在电脑上打开 /setup 完成设置',
}

/**
 * 创建手机镜像服务。
 * @param config - finalizeConfig() 的结果。
 * @param options - log / webRoot / host 覆盖项（测试用）。
 * @returns 服务句柄：listen() / close() / 诊断信息。
 */
export function createMirrorServer(config, options = {}) {
  const log = options.log || ((...args) => console.log(...args))
  const webRoot = options.webRoot || WEB_ROOT
  const bindHost = options.host || '0.0.0.0'
  // 设置页保存口令时要写回配置文件。做成可覆盖项，测试才不会写坏真实配置。
  const configFile = options.configFile || configPath()
  const startedAt = Date.now()
  const stats = { requests: 0, rejected: 0, unauthorized: 0, logins: 0, loginFailures: 0 }

  const sessions = createSessionStore({ ttlMs: config.sessionTtlDays * 24 * 60 * 60 * 1000 })
  const throttle = createThrottle({})

  // P2 写操作的两道本地保险：
  //   ledger —— 弱网重发时的幂等兜底（不把正确性全押在"上游按 requestId 去重"上）
  //   gate   —— 每会话最小发送间隔，防手机端误触连点
  const promptLedger = createPromptLedger({})
  const promptGate = createRateGate({ minIntervalMs: 300 })

  // 会话能力的持有者。刻意用**可变对象**而不是直接捕获 controller：
  // 宿主侧需要先起监听、再由 root.inject 把 sessionController 装进来，
  // 这样监听时机不会被"某个服务什么时候就绪"拖后。服务未就绪时相关接口回 503。
  const deps = options.deps || { controller: null }

  // —— TLS：默认开。证书签发失败就降级到 HTTP，并大声警告 ——
  let tlsInfo = { enabled: false, reason: 'disabled by config' }
  let certPem = null
  let keyPem = null
  if (config.tls) {
    try {
      const ips = lanCandidates().map((entry) => entry.address)
      const ensured = ensureCert(certDir(config), { ipAddresses: ips, log })
      certPem = ensured.certPem
      keyPem = ensured.keyPem
      tlsInfo = {
        enabled: true,
        regenerated: ensured.regenerated,
        ...describeCert(ensured.certPem),
      }
      if (ensured.regenerated) log('[mobile-mirror] 已签发新的自签证书')
    } catch (err) {
      tlsInfo = { enabled: false, reason: `证书签发失败：${err && err.message}` }
      log(`[mobile-mirror] ⚠️ ${tlsInfo.reason}`)
      log('[mobile-mirror] ⚠️ 已降级为明文 HTTP —— 局域网内密码可被抓包，请尽快排查磁盘写入权限')
    }
  } else {
    log('[mobile-mirror] ⚠️ 配置里 tls=false，正在使用明文 HTTP，局域网内密码可被抓包')
  }

  /** 已配置账号密码？没有就谁都不放行（fail closed）。 */
  function configured() {
    return typeof config.passwordHash === 'string' && config.passwordHash.length > 0
  }

  /** Host 头是否被接受。任何响应之前先过这一关。 */
  function hostAccepted(hostHeader) {
    const raw = String(hostHeader || '')
    if (!raw) return false
    let hostname
    try {
      hostname = new URL(`http://${raw}`).hostname
    } catch {
      return false
    }
    const name = hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
    if (name === 'localhost' || name.endsWith('.localhost')) return true
    if (name === '::1') return true
    if (isPrivateIPv4(name)) return true
    return config.allowedHosts.some((entry) => {
      const expected = String(entry).toLowerCase()
      return expected === name || expected === raw.toLowerCase()
    })
  }

  /** 请求是否来自本机（回环）。管理页（setup / pair）靠它把关。 */
  function fromLoopback(req) {
    const address = String((req.socket && req.socket.remoteAddress) || '')
    const normalized = address.replace(/^::ffff:/, '')
    return normalized === '::1' || normalized.startsWith('127.')
  }

  /** 请求来源标识，用于节流。 */
  function clientKey(req) {
    return String((req.socket && req.socket.remoteAddress) || 'unknown')
  }

  /** 当前登录会话，未登录返回 undefined。 */
  function currentSession(req) {
    const id = readCookie(req.headers.cookie, SESSION_COOKIE)
    if (!id) return undefined
    return sessions.get(id)
  }

  /** 统一响应。 */
  function send(res, status, type, body, extraHeaders) {
    const payload = typeof body === 'string' ? Buffer.from(body, 'utf8') : body
    res.writeHead(status, {
      'Content-Type': type,
      'Content-Length': payload.length,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      ...(extraHeaders || {}),
    })
    res.end(payload)
  }

  /** 重定向（303 让 POST 之后变成 GET，刷新不会重复提交）。 */
  function redirect(res, location, extraHeaders) {
    res.writeHead(303, { Location: location, 'Cache-Control': 'no-store', ...(extraHeaders || {}) })
    res.end()
  }

  /** 发送 JSON。 */
  function sendJson(res, status, value) {
    return send(res, status, 'application/json; charset=utf-8', `${JSON.stringify(value)}\n`)
  }

  /**
   * 取会话能力；未就绪则回 503 并返回 null。
   * 不抛异常 —— 插件在会话服务可用之前也必须能正常提供登录页与设置页。
   */
  function requireController(res) {
    if (deps.controller) return deps.controller
    sendJson(res, 503, {
      error: 'session-controller-unavailable',
      message: '会话服务尚未就绪，请稍后重试',
    })
    return null
  }

  /** 安全序列化：环形引用等异常情况不能让整个流挂掉。 */
  function safeJson(value) {
    try {
      return JSON.stringify(value)
    } catch (err) {
      return JSON.stringify({ e: 'error', d: { message: `序列化失败：${err && err.message}` } })
    }
  }

  /**
   * 写操作强制 JSON。
   * 表单类"简单请求"打不进来；跨站要发这种请求就必须走预检。
   * 配合 SameSite=Strict 的 Cookie 与 Origin 同源校验，构成 CSRF 的三道防线。
   */
  function isJsonRequest(req) {
    return /^application\/json\b/i.test(String(req.headers['content-type'] || '').trim())
  }

  /**
   * 写操作是否被配置禁用。禁用时回 403 并返回 true。
   * enablePrompt=false 视为"只读模式"：发消息和停止轮次一起关掉。
   */
  function promptDisabled(res) {
    if (config.enablePrompt) return false
    sendJson(res, 403, {
      error: 'prompt-disabled',
      message: '配置里 enablePrompt=false，手机端的写操作（发消息、停止轮次）已禁用',
    })
    return true
  }

  /**
   * 取上游错误的 code 透给手机。
   * RemoteError 带 code（如 session/not-found）；DSH 内部的 TypeError 之类没有。
   * 把它带上，手机端才分得清"业务拒绝"和"DSH 代码缺陷"——只透传 message 的话，
   * 这两种情况在手机上长得一模一样，排查时只能靠猜。
   * @param err - 上游抛出的错误。
   * @returns code 字符串，没有则 undefined（JSON 序列化时会被丢掉）。
   */
  function upstreamCode(err) {
    const code = err && typeof err.code === 'string' ? err.code.trim() : ''
    return code || undefined
  }

  /** 当前可用的配对地址。 */
  function pairInfo() {
    const scheme = tlsInfo.enabled ? 'https' : 'http'
    return lanCandidates().map((entry) => ({
      name: entry.name,
      address: entry.address,
      url: `${scheme}://${entry.address}:${config.port}/`,
    }))
  }

  /** 下发会话 Cookie。remember 为 false 时不带 Max-Age（浏览器关闭即失效）。 */
  function sessionCookieHeader(id, remember) {
    const parts = [`${SESSION_COOKIE}=${id}`, 'HttpOnly', 'SameSite=Strict', 'Path=/']
    if (tlsInfo.enabled) parts.push('Secure')
    if (remember) parts.push(`Max-Age=${Math.floor(sessions.ttlMs / 1000)}`)
    return parts.join('; ')
  }

  /** 渲染登录页。 */
  function loginPage(vars = {}) {
    return renderTemplate(webRoot, 'login.html', {
      ERROR: vars.error ? `<div class="err">${escapeHtml(vars.error)}</div>` : '',
      USERNAME: escapeHtml(vars.username || config.username || ''),
      SECURE: tlsInfo.enabled ? 'yes' : 'no',
      ...vars.extra,
    })
  }

  /** 渲染设置页。 */
  function setupPage(vars = {}) {
    const cert = tlsInfo.enabled ? tlsInfo : null
    return renderTemplate(webRoot, 'setup.html', {
      ERROR: vars.error ? `<div class="err">${escapeHtml(vars.error)}</div>` : '',
      OK: vars.ok ? `<div class="ok">${escapeHtml(vars.ok)}</div>` : '',
      USERNAME: escapeHtml(config.username || ''),
      CONFIGURED: configured() ? '已配置' : '未配置（当前无人能登录）',
      CONFIGURED_CLASS: configured() ? 'good' : 'warn',
      TLS_STATE: tlsInfo.enabled ? '已启用（自签证书）' : `未启用 —— ${escapeHtml(tlsInfo.reason || '')}`,
      TLS_CLASS: tlsInfo.enabled ? 'good' : 'bad',
      CERT_FINGERPRINT: cert ? escapeHtml(cert.fingerprint || '') : '—',
      CERT_VALID_TO: cert ? escapeHtml(cert.validTo || '') : '—',
      CERT_SAN: cert ? escapeHtml(cert.subjectAltName || '') : '—',
      CERT_LINK: cert ? '<p><a href="/cert">下载证书（cert.pem）</a> —— 装到手机上可以消掉浏览器警告</p>' : '',
      PORT: String(config.port),
      SCHEME: tlsInfo.enabled ? 'https' : 'http',
      URLS: pairInfo().map((entry) => `<li><code>${escapeHtml(entry.url)}</code><span class="dim"> ${escapeHtml(entry.name)}</span></li>`).join(''),
      MIN_PASSWORD: String(MIN_PASSWORD_LENGTH),
      SESSIONS: String(sessions.size),
      ...vars.extra,
    })
  }

  /** 主请求处理。 */
  async function handle(req, res) {
    stats.requests += 1
    const method = String(req.method || 'GET').toUpperCase()
    let url
    try {
      url = new URL(req.url || '/', `${tlsInfo.enabled ? 'https' : 'http'}://${req.headers.host || 'localhost'}`)
    } catch {
      stats.rejected += 1
      return send(res, 400, 'text/plain; charset=utf-8', 'bad request')
    }

    // ① 反 DNS rebinding
    if (!hostAccepted(req.headers.host)) {
      stats.rejected += 1
      return send(res, 403, 'text/plain; charset=utf-8', 'host not allowed')
    }
    // ② 跨站标记一律拒
    if (String(req.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') {
      stats.rejected += 1
      return send(res, 403, 'text/plain; charset=utf-8', 'cross-site request rejected')
    }
    // ③ Origin 必须与 Host 同源（POST 的 CSRF 防线之一）
    const origin = req.headers.origin
    if (typeof origin === 'string' && origin && origin !== 'null') {
      let originHost
      try {
        originHost = new URL(origin).host.toLowerCase()
      } catch {
        stats.rejected += 1
        return send(res, 403, 'text/plain; charset=utf-8', 'bad origin')
      }
      if (originHost !== String(req.headers.host || '').toLowerCase()) {
        stats.rejected += 1
        return send(res, 403, 'text/plain; charset=utf-8', 'origin mismatch')
      }
    }

    // —— 无需认证：存活探测（不含任何数据） ——
    if (url.pathname === '/health') {
      return send(res, 200, 'text/plain; charset=utf-8', 'OK')
    }

    // —— 无需认证：证书下载（公钥信息，且手机必须能在登录前拿到它） ——
    if (url.pathname === '/cert' && tlsInfo.enabled && certPem) {
      return send(res, 200, 'application/x-pem-file', certPem, {
        'Content-Disposition': 'attachment; filename="dsh-mobile-mirror-cert.pem"',
      })
    }

    // —— 本机专享：设置页 ——
    if (url.pathname === '/setup') {
      if (!fromLoopback(req)) {
        stats.unauthorized += 1
        return send(res, 403, 'text/plain; charset=utf-8', 'loopback only')
      }
      if (method === 'GET') return send(res, 200, 'text/html; charset=utf-8', setupPage())
      if (method === 'POST') {
        let form
        try {
          form = await readForm(req)
        } catch {
          return send(res, 200, 'text/html; charset=utf-8', setupPage({ error: '提交内容过大' }))
        }
        const username = String(form.username || '').trim()
        const password = String(form.password || '')
        const confirm = String(form.confirm || '')
        if (!validUsername(username)) {
          return send(res, 200, 'text/html; charset=utf-8', setupPage({ error: '账号只能包含字母、数字、_ . @ -，长度 1–32' }))
        }
        if (!validPassword(password)) {
          return send(res, 200, 'text/html; charset=utf-8', setupPage({ error: `密码至少 ${MIN_PASSWORD_LENGTH} 位` }))
        }
        if (password !== confirm) {
          return send(res, 200, 'text/html; charset=utf-8', setupPage({ error: '两次输入的密码不一致' }))
        }
        config.username = username
        config.passwordHash = await hashPassword(password)
        config.password = null
        writeConfig(config, configFile, log)
        const killed = sessions.destroyAll()
        log(`[mobile-mirror] 账号密码已更新（用户 ${username}），已注销 ${killed} 个旧会话`)
        return send(res, 200, 'text/html; charset=utf-8', setupPage({
          ok: `已保存。账号：${username}；${killed} 个旧会话已失效，请用新密码重新登录。`,
        }))
      }
      return send(res, 405, 'text/plain; charset=utf-8', 'method not allowed')
    }

    // —— 本机专享：配对信息 ——
    if (url.pathname === '/pair.json') {
      if (!fromLoopback(req)) {
        stats.unauthorized += 1
        return send(res, 401, 'text/plain; charset=utf-8', 'loopback only')
      }
      return send(res, 200, 'application/json; charset=utf-8', `${JSON.stringify({
        port: config.port,
        scheme: tlsInfo.enabled ? 'https' : 'http',
        username: config.username,
        configured: configured(),
        tls: tlsInfo,
        sessionTtlDays: config.sessionTtlDays,
        enablePrompt: config.enablePrompt,
        startedAt,
        stats,
        activeSessions: sessions.size,
        throttle: throttle.snapshot(),
        candidates: pairInfo(),
      }, null, 2)}\n`)
    }

    // —— 登录页（GET） ——
    if (url.pathname === '/login' && method === 'GET') {
      if (currentSession(req)) return redirect(res, '/')
      const code = url.searchParams.get('e')
      let error = LOGIN_ERRORS[code] || ''
      if (code === 'locked') {
        const seconds = Math.ceil(Number(url.searchParams.get('s') || 0) / 1000)
        error = `尝试过于频繁，请 ${seconds} 秒后重试`
      }
      return send(res, 200, 'text/html; charset=utf-8', loginPage({ error }))
    }

    // —— 登录（POST） ——
    if (url.pathname === '/login' && method === 'POST') {
      const key = clientKey(req)
      // 节流在哈希之前：被锁的请求连 scrypt 都不跑
      const gate = throttle.check(key)
      if (!gate.allowed) {
        stats.loginFailures += 1
        return redirect(res, `/login?e=locked&s=${gate.retryAfterMs}`)
      }
      let form
      try {
        form = await readForm(req)
      } catch {
        return redirect(res, '/login?e=missing')
      }
      const username = String(form.username || '')
      const password = String(form.password || '')
      const remember = form.remember === 'on' || form.remember === 'true'
      if (!username || !password) {
        throttle.recordFailure(key)
        return redirect(res, '/login?e=missing')
      }
      if (!configured()) {
        throttle.recordFailure(key)
        return redirect(res, '/login?e=unconfigured')
      }
      const userOk = safeEqual(username, config.username)
      const passOk = await verifyPassword(password, config.passwordHash)
      if (!userOk || !passOk) {
        stats.loginFailures += 1
        throttle.recordFailure(key)
        // 统一报错，不区分是账号错还是密码错（不给枚举提示）
        return redirect(res, '/login?e=bad')
      }
      throttle.reset(key)
      stats.logins += 1
      const id = sessions.create({ ip: key, agent: String(req.headers['user-agent'] || '').slice(0, 120) })
      return redirect(res, '/', { 'Set-Cookie': sessionCookieHeader(id, remember) })
    }

    // —— 以下全部需要登录 ——
    const session = currentSession(req)
    if (!session) {
      stats.unauthorized += 1
      if (url.pathname === '/') return redirect(res, '/login')
      return send(res, 401, 'text/plain; charset=utf-8', 'unauthorized')
    }

    if (url.pathname === '/logout') {
      const id = readCookie(req.headers.cookie, SESSION_COOKIE)
      if (id) sessions.destroy(id)
      return redirect(res, '/login', {
        'Set-Cookie': `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
      })
    }

    // ================= P1：会话镜像接口 =================

    // —— 会话列表 ——
    if (url.pathname === '/api/sessions' && method === 'GET') {
      const controller = requireController(res)
      if (!controller) return
      const abort = new AbortController()
      res.on('close', () => abort.abort())
      try {
        const items = await listSessions(controller, abort.signal)
        if (abort.signal.aborted) return
        return sendJson(res, 200, { items })
      } catch (err) {
        if (abort.signal.aborted) return
        log(`[mobile-mirror] 读取会话列表失败：${err && err.message}`)
        return sendJson(res, 500, { error: 'list-failed', message: String((err && err.message) || err) })
      }
    }

    // —— 往上翻历史 ——
    if (url.pathname === '/api/page' && method === 'GET') {
      const controller = requireController(res)
      if (!controller) return
      const sessionId = url.searchParams.get('id')
      // 注意：不能直接 Number(searchParams.get('before')) —— 缺参时 get() 返回 null，
      // Number(null) === 0 是有限数，会被当成合法的 before=0 放过去。
      const beforeRaw = url.searchParams.get('before')
      const beforeSeq = beforeRaw === null ? NaN : Number(beforeRaw)
      if (!sessionId) return sendJson(res, 400, { error: 'missing-id' })
      if (!Number.isFinite(beforeSeq)) return sendJson(res, 400, { error: 'missing-before' })
      const abort = new AbortController()
      res.on('close', () => abort.abort())
      try {
        const page = await pageBack(controller, sessionId, beforeSeq, Number(url.searchParams.get('max')), abort.signal)
        if (abort.signal.aborted) return
        return sendJson(res, 200, page)
      } catch (err) {
        if (abort.signal.aborted) return
        log(`[mobile-mirror] 翻页失败：${err && err.message}`)
        return sendJson(res, 500, { error: 'page-failed', message: String((err && err.message) || err) })
      }
    }

    // —— 发消息（P2，写操作） ——
    if (url.pathname === '/api/prompt' && method === 'POST') {
      const controller = requireController(res)
      if (!controller) return
      if (promptDisabled(res)) return
      if (!isJsonRequest(req)) {
        return sendJson(res, 415, { error: 'unsupported-media-type', message: '需要 Content-Type: application/json' })
      }
      let body
      try {
        body = await readJson(req)
      } catch (err) {
        return sendJson(res, 400, { error: 'bad-body', message: `请求体无法解析：${err && err.message}` })
      }
      // 先校验：格式错误应该拿到精确的 400，而不是被节流吞成 429。
      const checked = validatePrompt(body)
      if (checked.error) return sendJson(res, 400, { error: checked.error, message: checked.message })
      const { sessionId, requestId } = checked.value

      // 幂等重放优先于节流：弱网重试可能几百毫秒内就发生，
      // 那时该回"已受理"，而不是"发送太快了"。
      if (promptLedger.has(requestId)) {
        log('[mobile-mirror] 收到重复的 requestId，按幂等处理（没有重复发送）')
        return sendJson(res, 200, { accepted: true, duplicate: true })
      }

      if (!promptGate.allow(sessionId)) {
        return sendJson(res, 429, { error: 'too-fast', message: '发送太快了，稍等一下' })
      }
      try {
        const result = await sendPrompt(controller, checked.value, { ledger: promptLedger })
        if (!result.ok) return sendJson(res, result.status, { error: result.error, message: result.message })
        return sendJson(res, 200, { accepted: result.accepted, duplicate: result.duplicate === true })
      } catch (err) {
        log(`[mobile-mirror] 发送失败：${err && err.message}`)
        return sendJson(res, 502, {
          error: 'prompt-failed',
          code: upstreamCode(err),
          message: String((err && err.message) || err),
        })
      }
    }

    // —— 停止当前轮（P2，写操作） ——
    if (url.pathname === '/api/cancel' && method === 'POST') {
      const controller = requireController(res)
      if (!controller) return
      if (promptDisabled(res)) return
      if (!isJsonRequest(req)) {
        return sendJson(res, 415, { error: 'unsupported-media-type', message: '需要 Content-Type: application/json' })
      }
      let body
      try {
        body = await readJson(req)
      } catch (err) {
        return sendJson(res, 400, { error: 'bad-body', message: `请求体无法解析：${err && err.message}` })
      }
      try {
        const result = await cancelTurn(controller, body.sessionId)
        if (!result.ok) return sendJson(res, result.status, { error: result.error, message: result.message })
        return sendJson(res, 200, { accepted: result.accepted })
      } catch (err) {
        log(`[mobile-mirror] 停止失败：${err && err.message}`)
        return sendJson(res, 502, {
          error: 'cancel-failed',
          code: upstreamCode(err),
          message: String((err && err.message) || err),
        })
      }
    }

    // —— 实时跟随（SSE） ——
    if (url.pathname === '/api/follow' && method === 'GET') {
      const controller = requireController(res)
      if (!controller) return
      const sessionId = url.searchParams.get('id')
      if (!sessionId) return sendJson(res, 400, { error: 'missing-id' })

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      })

      const abort = new AbortController()
      let heartbeat = null
      let closed = false

      /** 收尾：保证只执行一次。 */
      const finish = () => {
        if (closed) return
        closed = true
        abort.abort()
        if (heartbeat) clearInterval(heartbeat)
        try { res.end() } catch {}
      }

      // 刻意挂在 res 上而不是 req 上：GET 的 req 在请求体读完后立刻 emit 'close'，
      // 挂在 req 上会让流刚建立就被自己掐断。
      res.on('close', finish)

      // 心跳：手机浏览器与中间的 AP 会掐掉长时间静默的连接
      heartbeat = setInterval(() => {
        if (closed) return
        try { res.write(': hb\n\n') } catch { finish() }
      }, 20000)

      /**
       * 写入并尊重背压：手机读得慢时等 drain，而不是把事件无限堆在内存里。
       * @returns 是否还应继续推送。
       */
      const write = (text) => new Promise((resolve) => {
        if (closed) return resolve(false)
        let ok
        try { ok = res.write(text) } catch { finish(); return resolve(false) }
        if (ok) return resolve(true)
        const onDrain = () => { cleanup(); resolve(true) }
        const onClose = () => { cleanup(); resolve(false) }
        const cleanup = () => { res.off('drain', onDrain); res.off('close', onClose) }
        res.once('drain', onDrain)
        res.once('close', onClose)
      })

      try {
        for await (const frame of openFollow(controller, sessionId, { maxMessages: Number(url.searchParams.get('max')) }, abort.signal)) {
          if (closed) break
          const payload = encodeFollowFrame(frame)
          if (!payload) continue
          if (!await write(`data: ${safeJson(payload)}\n\n`)) break
        }
      } catch (err) {
        if (!closed) {
          log(`[mobile-mirror] follow 流中断：${err && err.message}`)
          await write(`data: ${safeJson({ e: 'error', d: { message: String((err && err.message) || err) } })}\n\n`)
        }
      } finally {
        finish()
      }
      return
    }

    // ==================================================

    // 静态页面与资源
    const asset = STATIC_FILES.get(url.pathname)
    if (asset) {
      try {
        const body = asset.raw
          ? fs.readFileSync(path.join(webRoot, asset.file), 'utf8')
          : renderTemplate(webRoot, asset.file, {
            USERNAME: escapeHtml(config.username || ''),
            SCHEME: tlsInfo.enabled ? 'https' : 'http',
            PORT: String(config.port),
            SECURE: tlsInfo.enabled ? 'yes' : 'no',
            ENABLE_PROMPT: config.enablePrompt ? 'yes' : 'no',
          })
        return send(res, 200, asset.type, body)
      } catch (err) {
        return send(res, 500, 'text/plain; charset=utf-8', `asset missing: ${asset.file}`)
      }
    }

    return send(res, 404, 'text/plain; charset=utf-8', 'not found')
  }

  const listener = (req, res) => {
    handle(req, res).catch((err) => {
      log(`[mobile-mirror] 请求处理异常：${err && err.stack ? err.stack : err}`)
      try {
        if (!res.headersSent) send(res, 500, 'text/plain; charset=utf-8', 'internal error')
        else res.end()
      } catch {}
    })
  }

  const server = tlsInfo.enabled
    ? https.createServer({ key: keyPem, cert: certPem }, listener)
    : http.createServer(listener)

  // SSE 是长连接，关掉 Node 默认的请求超时，否则手机端流会被周期性掐断
  server.requestTimeout = 0
  server.headersTimeout = 60_000
  server.keepAliveTimeout = 120_000

  return {
    server,
    config,
    stats,
    tlsInfo,
    sessions,
    throttle,
    configured,
    /** 开始监听。失败时 reject，由调用方决定是否致命。 */
    listen() {
      return new Promise((resolve, reject) => {
        const onError = (err) => {
          server.removeListener('listening', onListening)
          reject(err)
        }
        const onListening = () => {
          server.removeListener('error', onError)
          resolve(server.address())
        }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(config.port, bindHost)
      })
    },
    /** 幂等关闭。 */
    close() {
      return new Promise((resolve) => {
        if (!server.listening) return resolve()
        server.close(() => resolve())
        try {
          server.closeAllConnections()
        } catch {}
      })
    },
    pairInfo,
    fromLoopback,
    certPem,
  }
}
