/**
 * dsh-mobile-mirror —— 认证：口令哈希、会话表、失败节流。
 *
 * 三个刻意的决定：
 *
 * 1. **用异步 scrypt，不用 scryptSync。**
 *    scryptSync 会阻塞宿主的事件循环 ~100ms。登录本身很少发生，无所谓；
 *    但一旦有人对着登录接口刷，阻塞就变成了对 DSH 本体的拒绝服务。
 *    async 版本走 libuv 线程池，宿主不受影响。
 *
 * 2. **哈希参数写进存储串**（`scrypt$N$r$p$salt$hash`），
 *    以后调参不会让老密码失效。
 *
 * 3. **节流在哈希之前生效。** 被锁的请求直接返回，连 scrypt 都不跑，
 *    否则节流挡不住 CPU 消耗，只挡住了结果。
 */

import crypto from 'node:crypto'

/** 当前默认的 scrypt 参数。 */
export const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 }

/** 存储串前缀，用于识别与未来迁移。 */
const PREFIX = 'scrypt'

/** 口令最小长度。太短的密码在局域网里等于没有。 */
export const MIN_PASSWORD_LENGTH = 6

/** 用户名允许的形状。 */
const USERNAME_PATTERN = /^[A-Za-z0-9_.@-]{1,32}$/

const scrypt = (password, salt, keylen, params) => new Promise((resolve, reject) => {
  crypto.scrypt(password, salt, keylen, params, (err, derived) => {
    if (err) reject(err)
    else resolve(derived)
  })
})

/**
 * 计算口令哈希。
 * @param password - 明文口令。
 * @param params - scrypt 参数覆盖。
 * @returns 形如 `scrypt$N$r$p$salt$hash` 的存储串。
 */
export async function hashPassword(password, params = SCRYPT) {
  const { N, r, p, keylen } = { ...SCRYPT, ...params }
  const salt = crypto.randomBytes(16)
  const derived = await scrypt(String(password), salt, keylen, { N, r, p })
  return [PREFIX, N, r, p, salt.toString('hex'), derived.toString('hex')].join('$')
}

/**
 * 校验口令。
 * @param password - 明文口令。
 * @param stored - hashPassword() 的产物。
 * @returns 是否匹配。存储串畸形一律返回 false（fail closed）。
 */
export async function verifyPassword(password, stored) {
  if (typeof stored !== 'string' || !stored) return false
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== PREFIX) return false
  const N = Number(parts[1])
  const r = Number(parts[2])
  const p = Number(parts[3])
  if (![N, r, p].every((n) => Number.isInteger(n) && n > 0)) return false
  let salt
  let expected
  try {
    salt = Buffer.from(parts[4], 'hex')
    expected = Buffer.from(parts[5], 'hex')
  } catch {
    return false
  }
  if (salt.length === 0 || expected.length === 0) return false
  let derived
  try {
    derived = await scrypt(String(password), salt, expected.length, { N, r, p })
  } catch {
    return false
  }
  return derived.length === expected.length && crypto.timingSafeEqual(derived, expected)
}

/**
 * 定长比较（用于用户名这类短字符串）。
 * @param a - 左侧。
 * @param b - 右侧。
 * @returns 是否相等。
 */
export function safeEqual(a, b) {
  const left = Buffer.from(String(a ?? ''), 'utf8')
  const right = Buffer.from(String(b ?? ''), 'utf8')
  if (left.length !== right.length) return false
  return crypto.timingSafeEqual(left, right)
}

/**
 * 校验用户名是否合法。
 * @param username - 待校验用户名。
 * @returns 是否合法。
 */
export function validUsername(username) {
  return typeof username === 'string' && USERNAME_PATTERN.test(username)
}

/**
 * 校验口令强度（只查长度，不搞复杂度教条）。
 * @param password - 待校验口令。
 * @returns 是否可接受。
 */
export function validPassword(password) {
  return typeof password === 'string' && password.length >= MIN_PASSWORD_LENGTH && password.length <= 256
}

/**
 * 会话表。纯内存：DSH 重启后手机会要求重新登录一次。
 * @param options - ttlMs 会话有效期。
 * @returns 会话表操作。
 */
export function createSessionStore(options = {}) {
  const ttlMs = Number.isFinite(options.ttlMs) ? options.ttlMs : 30 * 24 * 60 * 60 * 1000
  const sessions = new Map()

  /** 清掉过期项。每次访问顺手做，不需要定时器。 */
  function sweep(now) {
    for (const [id, session] of sessions) {
      if (now - session.createdAt > ttlMs) sessions.delete(id)
    }
  }

  return {
    /** 新建会话，返回会话 id。 */
    create(meta = {}) {
      const id = crypto.randomBytes(32).toString('hex')
      sessions.set(id, { createdAt: Date.now(), lastSeenAt: Date.now(), ...meta })
      return id
    },
    /** 取会话；不存在或过期返回 undefined。 */
    get(id) {
      if (typeof id !== 'string' || !id) return undefined
      const now = Date.now()
      const session = sessions.get(id)
      if (!session) return undefined
      if (now - session.createdAt > ttlMs) {
        sessions.delete(id)
        return undefined
      }
      session.lastSeenAt = now
      if (sessions.size > 64) sweep(now)
      return session
    },
    /** 销毁单个会话。 */
    destroy(id) {
      return sessions.delete(id)
    },
    /** 销毁全部会话（改密码后调用）。 */
    destroyAll() {
      const count = sessions.size
      sessions.clear()
      return count
    },
    /** 当前会话数。 */
    get size() {
      return sessions.size
    },
    /** 有效期（毫秒）。 */
    get ttlMs() {
      return ttlMs
    },
  }
}

/**
 * 登录失败节流：指数退避 + 连续失败达上限后锁定。
 * @param options - maxFailures 触发锁定的失败次数；lockMs 锁定时长。
 * @returns 节流操作。
 */
export function createThrottle(options = {}) {
  const maxFailures = Number.isFinite(options.maxFailures) ? options.maxFailures : 10
  const lockMs = Number.isFinite(options.lockMs) ? options.lockMs : 5 * 60 * 1000
  const maxDelayMs = Number.isFinite(options.maxDelayMs) ? options.maxDelayMs : 30_000
  const entries = new Map()

  return {
    /**
     * 该来源现在能否尝试登录。
     * @param key - 来源标识（IP）。
     * @returns { allowed, retryAfterMs }。
     */
    check(key) {
      const entry = entries.get(key)
      if (!entry) return { allowed: true, retryAfterMs: 0 }
      const now = Date.now()
      if (entry.lockedUntil && now < entry.lockedUntil) {
        return { allowed: false, retryAfterMs: entry.lockedUntil - now }
      }
      if (entry.nextAllowedAt && now < entry.nextAllowedAt) {
        return { allowed: false, retryAfterMs: entry.nextAllowedAt - now }
      }
      return { allowed: true, retryAfterMs: 0 }
    },
    /**
     * 记一次失败，返回本次施加的延迟。
     * @param key - 来源标识。
     * @returns 距离下次可尝试的毫秒数。
     */
    recordFailure(key) {
      const entry = entries.get(key) || { failures: 0, lockedUntil: 0, nextAllowedAt: 0 }
      entry.failures += 1
      const now = Date.now()
      if (entry.failures >= maxFailures) {
        entry.lockedUntil = now + lockMs
        entry.nextAllowedAt = entry.lockedUntil
      } else {
        // 1s、2s、4s … 封顶 30s
        const delay = Math.min(1000 * 2 ** (entry.failures - 1), maxDelayMs)
        entry.nextAllowedAt = now + delay
      }
      entries.set(key, entry)
      return Math.max(0, entry.nextAllowedAt - now)
    },
    /** 登录成功，清掉该来源的失败记录。 */
    reset(key) {
      entries.delete(key)
    },
    /** 供诊断展示。 */
    snapshot() {
      return [...entries.entries()].map(([key, entry]) => ({
        key,
        failures: entry.failures,
        locked: entry.lockedUntil > Date.now(),
      }))
    },
  }
}
