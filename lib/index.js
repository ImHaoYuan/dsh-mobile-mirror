/**
 * dsh-mobile-mirror —— Host 半侧（Cordis 插件入口）。
 *
 * 这一层只做四件事：读配置、起服务、把服务挂到 fiber 上、把日志打清楚。
 * 真正的逻辑在 ./server.js（HTTP/HTTPS + 认证）、./auth.js（口令与会话）、
 * ./cert.js（自签证书），三者都不依赖任何 DSH 内部模块，可脱离宿主单测。
 *
 * 刻意**不**声明对象级 `inject`：本插件不消费任何 Host 服务（P1 之后会按需
 * `root.inject(['sessionController'], ...)`），现在就在 apply() 里起监听，
 * 免得因为等待某个服务而把监听时机推迟到不确定的时刻。
 */

import { createMirrorServer, loadConfig, finalizeConfig, configPath, certDir } from './server.js'

/** 插件名，与 cordis.patch.yml 里的 name 一致。 */
export const name = 'mobile-mirror'

/** 日志前缀，方便在宿主日志里 grep。 */
const TAG = '[mobile-mirror]'

/** 宿主日志可能被重定向或关闭，日志本身绝不能成为抛异常的原因。 */
function safeLog(...args) {
  try {
    console.log(...args)
  } catch {}
}

/**
 * 激活插件。
 *
 * 任何失败都必须被吞掉：插件 apply 抛异常会让宿主的整个 fiber 初始化失败，
 * 为了一个"手机看对话"的便利功能把 DSH 拖垮是不划算的。
 * @param root - Cordis 插件上下文。
 */
export function apply(root) {
  let config
  try {
    config = loadConfig(configPath(), safeLog)
  } catch (err) {
    safeLog(`${TAG} 配置加载失败，插件不启动：${err && err.message}`)
    return
  }

  let mirror
  try {
    mirror = createMirrorServer(config, { log: safeLog })
  } catch (err) {
    safeLog(`${TAG} 服务创建失败，插件不启动：${err && err.stack ? err.stack : err}`)
    return
  }

  let closed = false
  const dispose = () => {
    if (closed) return
    closed = true
    mirror.close().catch(() => {})
  }

  // 挂到 fiber 上：插件被禁用/热重载时端口会被真正释放，不会残留占用
  if (root && typeof root.effect === 'function') {
    root.effect(() => dispose)
  } else {
    safeLog(`${TAG} 上下文没有 effect()，服务将随宿主进程退出而释放`)
  }

  // 明文口令 → scrypt 哈希（异步，走线程池，不阻塞宿主），完成后再监听
  finalizeConfig(config, configPath(), safeLog)
    .catch((err) => {
      safeLog(`${TAG} 配置收敛失败（不影响启动）：${err && err.message}`)
      return config
    })
    .then(() => mirror.listen())
    .then((address) => {
      const port = address && typeof address === 'object' && address.port ? address.port : config.port
      const scheme = mirror.tlsInfo.enabled ? 'https' : 'http'
      safeLog(`${TAG} listening on 0.0.0.0:${port} (${scheme})`)

      if (!mirror.tlsInfo.enabled) {
        safeLog(`${TAG} ⚠️ 未启用 TLS：${mirror.tlsInfo.reason || '未知原因'}`)
      }

      const candidates = mirror.pairInfo()
      if (candidates.length === 0) {
        safeLog(`${TAG} 没找到局域网 IPv4 地址，手机可能无法直连`)
      }
      for (const entry of candidates) {
        safeLog(`${TAG}   ${entry.name.padEnd(12)} ${entry.url}`)
      }

      if (mirror.configured()) {
        safeLog(`${TAG} 账号：${config.username}（已配置口令哈希）`)
      } else {
        safeLog(`${TAG} ⚠️ 尚未设置账号密码，现在任何人都登录不了（fail closed）`)
        safeLog(`${TAG}    请在电脑上打开 ${scheme}://127.0.0.1:${port}/setup 设置`)
      }
      safeLog(`${TAG}   本机诊断信息：${scheme}://127.0.0.1:${port}/pair.json`)
      safeLog(`${TAG}   证书目录：${certDir(config)}`)
    })
    .catch((err) => {
      safeLog(`${TAG} 监听 0.0.0.0:${config.port} 失败：${err && err.message}`)
      if (err && err.code === 'EADDRINUSE') {
        safeLog(`${TAG} 端口被占用。改 ${configPath()} 里的 port 后重启 DSH 即可。`)
      }
    })
}

export default { name, apply }
