/**
 * dsh-mobile-mirror —— 自签证书的端到端验证。
 *
 * 手写 ASN.1 最怕"看起来对"。所以这里不靠肉眼，靠三件事：
 *   ① node:crypto 的 X509Certificate（OpenSSL 解析器）能不能解析；
 *   ② checkHost / checkIP 对每个 SAN 是否成立、对不该覆盖的是否拒绝；
 *   ③ 拿它起一个真实的 HTTPS 服务，用 rejectUnauthorized: true 完成握手。
 * 第 ③ 条是决定性的：能过，说明这张证书在 OpenSSL 眼里是结构正确、
 * 签名有效、且对该地址有效的服务端证书。
 *
 * 运行：node tools/cert-test.mjs
 */

import tls from 'node:tls'
import https from 'node:https'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { generateCert, ensureCert, certUsable, describeCert, internals } from '../lib/cert.js'

const LAN_IP = '10.194.44.92'
const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

// —— ① IP 字面量编码 ——
check('ipToBytes 127.0.0.1', internals.ipToBytes('127.0.0.1').toString('hex') === '7f000001')
check('ipToBytes ::1', internals.ipToBytes('::1').toString('hex') === '00000000000000000000000000000001')
check('ipToBytes 10.194.44.92', internals.ipToBytes('10.194.44.92').toString('hex') === '0ac22c5c')
check('ipToBytes 拒绝非法输入', internals.ipToBytes('999.1.1.1') === null)

// —— ② 生成与解析 ——
const { certPem, keyPem } = generateCert({
  commonName: 'DSH Mobile Mirror',
  dnsNames: ['localhost'],
  ipAddresses: ['127.0.0.1', '::1', LAN_IP],
  days: 30,
})

let cert
try {
  cert = new crypto.X509Certificate(certPem)
  check('OpenSSL 能解析生成的证书', true)
} catch (err) {
  check('OpenSSL 能解析生成的证书', false, String(err && err.message))
  process.exit(1)
}

check('自签（subject == issuer）', cert.subject === cert.issuer)
check('CN 正确', /CN=DSH Mobile Mirror/.test(cert.subject), cert.subject.replace(/\n/g, ', '))
check('O 正确', /O=dsh-mobile-mirror/.test(cert.subject))
check('有效期未过期', Date.parse(cert.validTo) > Date.now(), `validTo=${cert.validTo}`)
// 注意语义：checkHost / checkIP 返回**命中的 SAN 条目字符串**，未命中返回 undefined。
// 不是布尔 —— 这里用真值判断，避免把返回值语义写死成某个 Node 版本的形状。
check('SAN 含 DNS:localhost', Boolean(cert.checkHost('localhost')))
check('SAN 含 IP 127.0.0.1', Boolean(cert.checkIP('127.0.0.1')))
check('SAN 含 IP ::1', Boolean(cert.checkIP('::1')))
check(`SAN 含 IP ${LAN_IP}`, Boolean(cert.checkIP(LAN_IP)))
check('SAN 不含未声明的 IP（负向）', !cert.checkIP('192.168.1.99'))
check('SAN 不含未声明的域名（负向）', !cert.checkHost('evil.example.com'))
check('subjectAltName 列出了全部地址',
  /DNS:localhost/.test(cert.subjectAltName)
  && cert.subjectAltName.includes('127.0.0.1')
  && cert.subjectAltName.includes(LAN_IP),
  cert.subjectAltName)

const described = describeCert(certPem)
check('describeCert 能读出指纹', typeof described.fingerprint === 'string' && described.fingerprint.length > 0)
check('describeCert 标记为自签', described.selfSigned === true)

// —— ③ 真实 TLS 握手 ——
const server = https.createServer({ key: keyPem, cert: certPem }, (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' })
  res.end('hello-over-tls')
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port

/** 用给定选项连一次，返回 { ok, error, body }。 */
function handshake(options) {
  return new Promise((resolve) => {
    const socket = tls.connect({ port, ...options }, () => {
      socket.write('GET / HTTP/1.0\r\n\r\n')
    })
    let body = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk) => { body += chunk })
    socket.on('error', (err) => resolve({ ok: false, error: err.code || err.message }))
    socket.on('end', () => resolve({ ok: true, body }))
  })
}

const trustedByName = await handshake({ host: '127.0.0.1', servername: 'localhost', ca: certPem, rejectUnauthorized: true })
check('TLS 握手成功（按域名 localhost 校验）', trustedByName.ok && trustedByName.body.includes('hello-over-tls'), trustedByName.error || '')

const trustedByIp = await handshake({ host: '127.0.0.1', ca: certPem, rejectUnauthorized: true })
check('TLS 握手成功（按 IP 127.0.0.1 校验）', trustedByIp.ok && trustedByIp.body.includes('hello-over-tls'), trustedByIp.error || '')

const untrusted = await handshake({ host: '127.0.0.1', servername: 'localhost', rejectUnauthorized: true })
check('不信任该 CA 时握手失败（证明确实是自签、未被误认为可信链）',
  untrusted.ok === false && /SELF_SIGNED|UNABLE_TO_VERIFY|DEPTH_ZERO/.test(String(untrusted.error)),
  String(untrusted.error))

const wrongName = await handshake({ host: '127.0.0.1', servername: 'wrong.example.com', ca: certPem, rejectUnauthorized: true })
check('域名不匹配时握手失败（SAN 真的在生效）', wrongName.ok === false, String(wrongName.error))

await new Promise((resolve) => server.close(resolve))

// —— ④ ensureCert 的复用与重签策略 ——
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mm-cert-'))
const first = ensureCert(tmpDir, { ipAddresses: [LAN_IP], days: 30, log: () => {} })
check('首次 ensureCert 生成证书', first.regenerated === true)
const second = ensureCert(tmpDir, { ipAddresses: [LAN_IP], days: 30, log: () => {} })
check('地址未变时复用现有证书', second.regenerated === false)
const third = ensureCert(tmpDir, { ipAddresses: [LAN_IP, '192.168.77.7'], days: 30, log: () => {} })
check('新增地址触发重签', third.regenerated === true)
check('重签后覆盖新地址', certUsable(third.certPem, ['localhost'], ['127.0.0.1', '::1', LAN_IP, '192.168.77.7']))
check('certUsable 对缺失地址返回 false', certUsable(third.certPem, ['localhost'], ['10.9.9.9']) === false)
fs.rmSync(tmpDir, { recursive: true, force: true })

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
process.exit(failed.length === 0 ? 0 : 1)
