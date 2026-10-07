/**
 * dsh-mobile-mirror —— 自签服务端证书的生成与管理。
 *
 * 为什么需要：手机上的密码如果走明文 HTTP，同一 Wi-Fi 下抓包即可拿到。
 * 上 HTTPS 就必须有证书，而 node:crypto 只能**解析** X.509、不能**生成**，
 * 机器上也没有 openssl。所以这里用 ./asn1.js 手写 DER 组装一张证书。
 *
 * 关键简化：SubjectPublicKeyInfo 直接复用 node:crypto 导出的 SPKI DER，
 * 不需要自己编码公钥；RSA 签名用 crypto.sign('sha256', ...) 拿到的就是
 * PKCS#1 v1.5 的裸签名，正是 BIT STRING 里要放的东西。
 *
 * 选 RSA-2048 而不是 EC P-256：兼容性优先。手机端握手慢一点无所谓，
 * 但老 Android 对 ECDSA 证书有历史兼容问题，不值得为省一次握手去踩。
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { seq, set, int, octetString, bitString, bits, bool, utf8, oid, utcTime, contextTag, pem } from './asn1.js'

/** 用到的 OID。 */
const OID = {
  sha256WithRsa: '1.2.840.113549.1.1.11',
  commonName: '2.5.4.3',
  organization: '2.5.4.10',
  basicConstraints: '2.5.29.19',
  keyUsage: '2.5.29.15',
  extKeyUsage: '2.5.29.37',
  subjectAltName: '2.5.29.17',
  serverAuth: '1.3.6.1.5.5.7.3.1',
}

/** 默认有效期（天）。 */
export const DEFAULT_DAYS = 825

/** 剩余有效期低于这个值就提前换证，避免手机端突然报过期。 */
const RENEW_MARGIN_MS = 7 * 24 * 60 * 60 * 1000

/**
 * IPv4/IPv6 字面量 → SAN 里 iPAddress 的字节形式。
 * @param address - IP 字面量。
 * @returns 4 或 16 字节；无法解析时返回 null。
 */
function ipToBytes(address) {
  const text = String(address || '').trim()
  if (!text) return null
  if (text.includes(':')) {
    // IPv6：支持 "::" 缩写与结尾内嵌的 IPv4
    let head = text
    let tail = ''
    if (head.includes('::')) {
      const [left, right] = head.split('::')
      head = left
      tail = right || ''
    } else if (!head.includes('::') && head.split(':').length !== 8) {
      return null
    }
    const parseGroups = (part) => (part ? part.split(':').filter((s) => s.length > 0) : [])
    const headGroups = parseGroups(head)
    const tailGroups = parseGroups(tail)
    const groups = []
    const missing = 8 - headGroups.length - tailGroups.length
    if (missing < 0) return null
    for (const group of headGroups) groups.push(parseInt(group, 16))
    for (let i = 0; i < missing; i += 1) groups.push(0)
    for (const group of tailGroups) groups.push(parseInt(group, 16))
    if (groups.length !== 8 || groups.some((n) => !Number.isInteger(n) || n < 0 || n > 0xffff)) return null
    const out = Buffer.alloc(16)
    groups.forEach((value, index) => out.writeUInt16BE(value, index * 2))
    return out
  }
  const parts = text.split('.')
  if (parts.length !== 4) return null
  const numbers = parts.map((part) => Number(part))
  if (numbers.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null
  return Buffer.from(numbers)
}

/** RDNSequence：一组 [OID, 值] → Name。 */
function distinguishedName(pairs) {
  return seq(...pairs.map(([key, value]) => set(seq(oid(key), utf8(value)))))
}

/** 一个 Extension。 */
function extension(key, critical, value) {
  const parts = [oid(key)]
  if (critical) parts.push(bool(true))
  parts.push(octetString(value))
  return seq(...parts)
}

/**
 * 生成一张自签服务端证书。
 * @param options - commonName / organization / dnsNames / ipAddresses / days。
 * @returns certPem 与 keyPem。
 */
export function generateCert(options = {}) {
  const commonName = options.commonName || 'DSH Mobile Mirror'
  const organization = options.organization || 'dsh-mobile-mirror'
  const days = Number.isInteger(options.days) ? options.days : DEFAULT_DAYS
  const dnsNames = [...new Set(options.dnsNames || ['localhost'])]
  const ipAddresses = [...new Set(options.ipAddresses || ['127.0.0.1', '::1'])]

  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })

  const generalNames = [
    ...dnsNames.map((name) => contextTagBytes(2, Buffer.from(name, 'ascii'))),
    ...ipAddresses.map((address) => {
      const bytes = ipToBytes(address)
      if (!bytes) throw new Error(`非法 IP 地址：${address}`)
      return contextTagBytes(7, bytes)
    }),
  ]

  const extensions = seq(
    // CA:FALSE —— 必须 critical，否则这张证书可能被当成 CA 使用
    extension(OID.basicConstraints, true, seq(bool(false))),
    // digitalSignature(0) + keyEncipherment(2)
    extension(OID.keyUsage, true, bitString(bits([0, 2]))),
    // serverAuth
    extension(OID.extKeyUsage, false, seq(oid(OID.serverAuth))),
    // SAN：现代浏览器只看这里，CN 已被忽略
    extension(OID.subjectAltName, false, seq(...generalNames)),
  )

  const now = Date.now()
  const notBefore = new Date(now - 24 * 60 * 60 * 1000)
  const notAfter = new Date(now + days * 24 * 60 * 60 * 1000)

  const tbsCertificate = seq(
    contextTag(0, int(2)), // version v3
    int(crypto.randomBytes(16)), // serialNumber
    seq(oid(OID.sha256WithRsa)), // signature
    distinguishedName([[OID.commonName, commonName], [OID.organization, organization]]), // issuer
    seq(utcTime(notBefore), utcTime(notAfter)), // validity
    distinguishedName([[OID.commonName, commonName], [OID.organization, organization]]), // subject
    publicKey.export({ type: 'spki', format: 'der' }), // subjectPublicKeyInfo（已是 DER）
    contextTag(3, extensions), // [3] EXPLICIT Extensions
  )

  // RSA + sha256 默认就是 PKCS#1 v1.5，拿到的裸签名可直接进 BIT STRING
  const signature = crypto.sign('sha256', tbsCertificate, privateKey)

  const certificate = seq(
    tbsCertificate,
    seq(oid(OID.sha256WithRsa)),
    bitString(Buffer.concat([Buffer.from([0x00]), signature])),
  )

  return {
    certPem: pem('CERTIFICATE', certificate),
    keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  }
}

/** 上下文标签的**非构造**形式（GeneralName 用）。 */
function contextTagBytes(number, content) {
  const length = content.length
  let lengthBytes
  if (length < 0x80) lengthBytes = Buffer.from([length])
  else lengthBytes = Buffer.from([0x81, length])
  return Buffer.concat([Buffer.from([0x80 | number]), lengthBytes, content])
}

/**
 * 现有证书是否还能用：未过期、且覆盖全部要求的名字与地址。
 * @param certPem - 证书 PEM。
 * @param dnsNames - 必须覆盖的 DNS 名。
 * @param ipAddresses - 必须覆盖的 IP。
 * @returns 是否可继续使用。
 */
export function certUsable(certPem, dnsNames, ipAddresses) {
  let cert
  try {
    cert = new crypto.X509Certificate(certPem)
  } catch {
    return false
  }
  const notAfter = Date.parse(cert.validTo)
  if (!Number.isFinite(notAfter) || notAfter - Date.now() < RENEW_MARGIN_MS) return false
  for (const name of dnsNames) {
    try {
      if (!cert.checkHost(name)) return false
    } catch {
      return false
    }
  }
  for (const address of ipAddresses) {
    try {
      if (!cert.checkIP(address)) return false
    } catch {
      return false
    }
  }
  return true
}

/**
 * 确保证书目录里有一张可用证书，必要时重新生成。
 * @param directory - 证书目录。
 * @param options - dnsNames / ipAddresses / days / commonName / log。
 * @returns 证书与私钥 PEM，以及是否发生了重新生成。
 */
export function ensureCert(directory, options = {}) {
  const log = options.log || (() => {})
  const dnsNames = [...new Set(['localhost', ...(options.dnsNames || [])])]
  const ipAddresses = [...new Set(['127.0.0.1', '::1', ...(options.ipAddresses || [])])]
  const certFile = path.join(directory, 'cert.pem')
  const keyFile = path.join(directory, 'key.pem')

  try {
    const certPem = fs.readFileSync(certFile, 'utf8')
    const keyPem = fs.readFileSync(keyFile, 'utf8')
    if (certUsable(certPem, dnsNames, ipAddresses)) {
      return { certPem, keyPem, regenerated: false }
    }
    log('[mobile-mirror] 现有证书已过期或不覆盖当前地址，重新签发')
  } catch {
    // 不存在或读不出来 → 往下生成
  }

  const { certPem, keyPem } = generateCert({
    commonName: options.commonName,
    days: options.days,
    dnsNames,
    ipAddresses,
  })

  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(certFile, certPem, 'utf8')
  fs.writeFileSync(keyFile, keyPem, { encoding: 'utf8', mode: 0o600 })
  return { certPem, keyPem, regenerated: true }
}

/** 解析证书摘要，供诊断页展示。 */
export function describeCert(certPem) {
  try {
    const cert = new crypto.X509Certificate(certPem)
    return {
      subject: cert.subject.replace(/\n/g, ', '),
      issuer: cert.issuer.replace(/\n/g, ', '),
      validFrom: cert.validFrom,
      validTo: cert.validTo,
      fingerprint: cert.fingerprint256,
      subjectAltName: cert.subjectAltName || '',
      selfSigned: cert.subject === cert.issuer,
    }
  } catch (err) {
    return { error: String((err && err.message) || err) }
  }
}

/** 导出供测试使用。 */
export const internals = { ipToBytes, contextTagBytes }
