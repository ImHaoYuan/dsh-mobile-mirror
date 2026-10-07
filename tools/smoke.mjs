/**
 * dsh-mobile-mirror —— 集成冒烟测试（HTTPS + 账号密码）。
 *
 * 脱离 DSH 运行，但走的是**真实链路**：真 TLS、真证书、真 Cookie、真节流。
 * 覆盖 P0 遗留的三道闸门 + 认证改造的全部验收标准。
 *
 * 全程使用临时目录里的证书与配置文件，绝不触碰 $DSH_HOME。
 *
 * 运行：node tools/smoke.mjs
 */

import https from 'node:https'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createMirrorServer, lanCandidates } from '../lib/server.js'

const PORT = Number(process.env.SMOKE_PORT || 19399)
const USER = 'tester'
const PASS = 'secret-123'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mm-smoke-'))
const CONFIG_FILE = path.join(TMP, 'config.json')

const config = {
  port: PORT,
  username: USER,
  passwordHash: null,
  password: null,
  sessionTtlDays: 30,
  tls: true,
  certDir: path.join(TMP, 'cert'),
  allowedHosts: [],
  enablePrompt: true,
}

const mirror = createMirrorServer(config, { log: () => {}, configFile: CONFIG_FILE })
const address = await mirror.listen()
const certPem = mirror.certPem

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

/**
 * 发请求：真 TLS 校验（ca + rejectUnauthorized），可完全控制 Host 头。
 *
 * skipNameCheck：TLS 客户端默认会拿 Host 头去比对证书 SAN，而下面有几个用例
 * 就是要**故意伪造 Host** 来测服务端的闸门 —— 那种情况下名称校验会把请求
 * 提前打死在客户端。此时只跳过名称比对，证书链仍然验证。
 */
function request(pathname, {
  method = 'GET', headers = {}, body, host = `127.0.0.1:${PORT}`, skipNameCheck = false,
} = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? new URLSearchParams(body).toString() : null
    const req = https.request({
      host: '127.0.0.1',
      port: PORT,
      path: pathname,
      method,
      ca: certPem,
      rejectUnauthorized: true,
      ...(skipNameCheck ? { checkServerIdentity: () => undefined } : {}),
      headers: {
        Host: host,
        ...(payload
          ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(payload) }
          : {}),
        ...headers,
      },
    }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

console.log(`listening on ${address.address}:${address.port} (https)\n`)

// —— 基础：TLS 与监听 ——
check('监听地址是 0.0.0.0（局域网可达）', address.address === '0.0.0.0', address.address)
check('TLS 已启用', mirror.tlsInfo.enabled === true, mirror.tlsInfo.reason || '')
check('用生成的证书做严格校验握手成功', certPem.includes('BEGIN CERTIFICATE'))

// —— 三道闸门 ——
const health = await request('/health')
check('GET /health → 200 OK', health.status === 200 && health.body === 'OK', `${health.status} ${health.body}`)

const healthLan = await request('/health', { host: `10.194.44.92:${PORT}`, skipNameCheck: true })
check('Host 为私有网段 → 放行', healthLan.status === 200, String(healthLan.status))

const healthSpoof = await request('/health', { host: 'evil.example.com', skipNameCheck: true })
check('Host 为外部域名 → 403（挡 DNS rebinding）', healthSpoof.status === 403, String(healthSpoof.status))

const healthCross = await request('/health', { headers: { 'Sec-Fetch-Site': 'cross-site' } })
check('Sec-Fetch-Site: cross-site → 403', healthCross.status === 403, String(healthCross.status))

const healthOrigin = await request('/health', { headers: { Origin: 'http://attacker.example' } })
check('Origin 与 Host 不同源 → 403', healthOrigin.status === 403, String(healthOrigin.status))

// —— 未登录 ——
const rootAnon = await request('/')
check('未登录访问 / → 303 跳登录页',
  rootAnon.status === 303 && String(rootAnon.headers.location).startsWith('/login'),
  `${rootAnon.status} ${rootAnon.headers.location}`)

const loginPage = await request('/login')
check('GET /login → 200 且是登录页', loginPage.status === 200 && loginPage.body.includes('账号'), String(loginPage.status))

const loginPageErr = await request('/login?e=bad')
check('登录失败提示会渲染出来', loginPageErr.body.includes('账号或密码不正确'))

const apiAnon = await request('/pair.json', { host: `10.194.44.92:${PORT}`, skipNameCheck: true })
check('/pair.json 按 socket 判定回环（本机访问、Host 是局域网 IP 也放行）', apiAnon.status === 200, String(apiAnon.status))

// —— 设置页（本机专享） ——
const setupPage = await request('/setup')
check('GET /setup（本机）→ 200', setupPage.status === 200 && setupPage.body.includes('设置'), String(setupPage.status))
check('设置页显示"未配置"（fail closed）', setupPage.body.includes('未配置'))

const setupShort = await request('/setup', { method: 'POST', body: { username: USER, password: 'abc', confirm: 'abc' } })
check('设置页：密码过短被拒', setupShort.body.includes('密码至少'), '')

const setupMismatch = await request('/setup', { method: 'POST', body: { username: USER, password: PASS, confirm: 'other-123' } })
check('设置页：两次密码不一致被拒', setupMismatch.body.includes('不一致'))

const setupBadUser = await request('/setup', { method: 'POST', body: { username: '坏 名字', password: PASS, confirm: PASS } })
check('设置页：非法账号被拒', setupBadUser.body.includes('账号只能包含'))

const setupOk = await request('/setup', { method: 'POST', body: { username: USER, password: PASS, confirm: PASS } })
check('设置页：合法账号密码保存成功', setupOk.status === 200 && setupOk.body.includes('已保存'))

check('口令以 scrypt 哈希落盘，明文不落盘',
  typeof config.passwordHash === 'string'
  && config.passwordHash.startsWith('scrypt$')
  && !fs.readFileSync(CONFIG_FILE, 'utf8').includes(PASS),
  String(config.passwordHash).slice(0, 24) + '…')

const pairAfterSetup = await request('/pair.json')
const pairJson = JSON.parse(pairAfterSetup.body)
check('/pair.json 报告已配置', pairJson.configured === true)
check('/pair.json 不再泄露任何口令材料', !JSON.stringify(pairJson).includes(PASS))

// —— 登录 ——
const wrongUser = await request('/login', { method: 'POST', body: { username: 'nobody', password: PASS } })
check('错账号 → 303 且报错码统一为 bad',
  wrongUser.status === 303 && String(wrongUser.headers.location).includes('e=bad'),
  String(wrongUser.headers.location))

// 上一步已经触发了一次失败退避，等它过去再登录
await sleep(1200)

const good = await request('/login', { method: 'POST', body: { username: USER, password: PASS, remember: 'on' } })
const setCookie = String(good.headers['set-cookie'] || '')
check('对账号密码 → 303 跳 /', good.status === 303 && good.headers.location === '/', `${good.status} ${good.headers.location}`)
check('下发会话 Cookie 且带 HttpOnly / SameSite=Strict / Secure',
  /HttpOnly/.test(setCookie) && /SameSite=Strict/.test(setCookie) && /Secure/.test(setCookie),
  setCookie.slice(0, 80))
check('记住我 → Cookie 带 Max-Age',
  /Max-Age=\d+/.test(setCookie), (setCookie.match(/Max-Age=\d+/) || [''])[0])

const cookie = setCookie.split(';')[0]

const rootAuth = await request('/', { headers: { Cookie: cookie } })
check('已登录访问 / → 200 主页', rootAuth.status === 200 && rootAuth.body.includes('DSH 手机镜像'), String(rootAuth.status))
check('主页显示当前账号', rootAuth.body.includes(USER))

const certDownload = await request('/cert')
check('GET /cert → 200 且是 PEM 证书',
  certDownload.status === 200 && certDownload.body.includes('BEGIN CERTIFICATE'),
  String(certDownload.status))

// —— 退出 ——
const logout = await request('/logout', { headers: { Cookie: cookie } })
check('退出 → 303 跳登录页并清除 Cookie',
  logout.status === 303 && /Max-Age=0/.test(String(logout.headers['set-cookie'] || '')),
  String(logout.headers['set-cookie'] || '').slice(0, 60))

const rootAfterLogout = await request('/', { headers: { Cookie: cookie } })
check('旧 Cookie 已失效', rootAfterLogout.status === 303 && String(rootAfterLogout.headers.location).startsWith('/login'))

// —— 节流 ——
const fail1 = await request('/login', { method: 'POST', body: { username: USER, password: 'definitely-wrong' } })
const fail2 = await request('/login', { method: 'POST', body: { username: USER, password: 'definitely-wrong' } })
check('首次失败 → e=bad', String(fail1.headers.location).includes('e=bad'), String(fail1.headers.location))
check('紧接着再试 → 被节流挡下（e=locked）',
  String(fail2.headers.location).includes('e=locked'),
  String(fail2.headers.location))

// —— 清理 ——
await mirror.close()
fs.rmSync(TMP, { recursive: true, force: true })

console.log('\n局域网候选地址（手机应该连第一个）：')
for (const entry of lanCandidates()) console.log(`  ${entry.name}  ${entry.address}  https://${entry.address}:${PORT}/`)

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
process.exit(failed.length === 0 ? 0 : 1)
