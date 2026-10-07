/**
 * dsh-mobile-mirror —— 极简 DER 编码器。
 *
 * 只实现生成一张自签服务端证书所需要的那几个类型。刻意不引入
 * `selfsigned` / `node-forge`：插件要保持零依赖（`link:` 即用，不必再跑
 * pnpm install），也不想让第三方包进到安全边界上。
 *
 * 正确性靠外部验证，不靠"看起来对"：
 *   tools/cert-test.mjs 会用 node:crypto 的 X509Certificate 解析生成结果，
 *   并完成一次真实 TLS 握手（rejectUnauthorized: true + 指定 CA + checkHost）。
 */

/** DER 长度字段。 */
function derLength(length) {
  if (length < 0x80) return Buffer.from([length])
  const bytes = []
  let rest = length
  while (rest > 0) {
    bytes.unshift(rest & 0xff)
    rest = Math.floor(rest / 256)
  }
  return Buffer.from([0x80 | bytes.length, ...bytes])
}

/** 组装一个 TLV。 */
export function tlv(tag, content) {
  return Buffer.concat([Buffer.from([tag]), derLength(content.length), content])
}

/** SEQUENCE。 */
export function seq(...items) {
  return tlv(0x30, Buffer.concat(items))
}

/** SET。 */
export function set(...items) {
  return tlv(0x31, Buffer.concat(items))
}

/**
 * INTEGER。接受数字或正整数字节。
 * 内容高位为 1 时补一个 0x00，否则会被当成负数。
 */
export function int(value) {
  let bytes
  if (typeof value === 'number') {
    bytes = []
    let rest = value
    if (rest === 0) bytes = [0]
    while (rest > 0) {
      bytes.unshift(rest & 0xff)
      rest = Math.floor(rest / 256)
    }
  } else {
    bytes = [...value]
    while (bytes.length > 1 && bytes[0] === 0 && (bytes[1] & 0x80) === 0) bytes.shift()
  }
  if (bytes.length === 0) bytes = [0]
  if (bytes[0] & 0x80) bytes.unshift(0x00)
  return tlv(0x02, Buffer.from(bytes))
}

/** OCTET STRING。 */
export function octetString(content) {
  return tlv(0x04, content)
}

/** BIT STRING。content 需自带"未使用位数"首字节。 */
export function bitString(content) {
  return tlv(0x03, content)
}

/**
 * 由置位的 bit 下标生成 BIT STRING 内容（含未使用位数首字节）。
 * 例如 [0, 2] → 0b10100000，末位之后剩 5 位未使用。
 * @param indexes - 置位的 bit 下标（从 0 起，高位在前）。
 * @returns 可直接交给 bitString() 的内容。
 */
export function bits(indexes) {
  const max = indexes.length ? Math.max(...indexes) : -1
  const byteCount = Math.floor(max / 8) + 1
  const data = new Uint8Array(byteCount)
  for (const index of indexes) data[Math.floor(index / 8)] |= 0x80 >> (index % 8)
  const unused = byteCount === 0 ? 0 : byteCount * 8 - (max + 1)
  return Buffer.from([unused, ...data])
}

/** NULL。 */
export function nullValue() {
  return tlv(0x05, Buffer.alloc(0))
}

/** BOOLEAN。 */
export function bool(value) {
  return tlv(0x01, Buffer.from([value ? 0xff : 0x00]))
}

/** UTF8String。 */
export function utf8(text) {
  return tlv(0x0c, Buffer.from(String(text), 'utf8'))
}

/** IA5String（用于 DNS 名）。 */
export function ia5(text) {
  return tlv(0x16, Buffer.from(String(text), 'ascii'))
}

/**
 * OBJECT IDENTIFIER。点分十进制字符串 → DER。
 * @param dotted - 形如 "2.5.29.19"。
 */
export function oid(dotted) {
  const arcs = String(dotted).split('.').map((part) => Number(part))
  if (arcs.length < 2 || arcs.some((n) => !Number.isInteger(n) || n < 0)) {
    throw new Error(`非法 OID: ${dotted}`)
  }
  const bytes = [arcs[0] * 40 + arcs[1]]
  for (const arc of arcs.slice(2)) {
    const chunk = []
    let rest = arc
    chunk.unshift(rest & 0x7f)
    rest = Math.floor(rest / 128)
    while (rest > 0) {
      chunk.unshift((rest & 0x7f) | 0x80)
      rest = Math.floor(rest / 128)
    }
    bytes.push(...chunk)
  }
  return tlv(0x06, Buffer.from(bytes))
}

/** UTCTime（YYMMDDHHMMSSZ）。有效期到 2050 年前都用它。 */
export function utcTime(date) {
  const pad = (n) => String(n).padStart(2, '0')
  const text = pad(date.getUTCFullYear() % 100)
    + pad(date.getUTCMonth() + 1)
    + pad(date.getUTCDate())
    + pad(date.getUTCHours())
    + pad(date.getUTCMinutes())
    + pad(date.getUTCSeconds())
    + 'Z'
  return tlv(0x17, Buffer.from(text, 'ascii'))
}

/** 上下文相关标签（构造型，如 [0] / [3]）。 */
export function contextTag(number, content) {
  return tlv(0xa0 | number, content)
}

/** PEM 包装。 */
export function pem(label, der) {
  const body = der.toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n$/, '')
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`
}
