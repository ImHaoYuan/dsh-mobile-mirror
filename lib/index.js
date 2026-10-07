/**
 * dsh-mobile-mirror —— Host 半侧（Cordis 插件入口）。
 *
 * 这一层只做四件事：读配置、起服务、把服务挂到 fiber 上、把日志打清楚。
 * 真正的逻辑在 ./server.js（HTTP/HTTPS + 认证 + 路由）、./mirror.js（会话数据层）、
 * ./auth.js（口令与会话）、./cert.js（自签证书），都不依赖任何 DSH 内部模块，可脱离宿主单测。
 *
 * 关于依赖注入：**先起监听，再装服务**。`sessionController` 通过可变 holder
 * （deps.controller）交给服务层，而不是在 apply() 里直接 await —— 这样监听时机
 * 不会被"某个服务什么时候就绪"拖后。服务未就绪时 /api/* 回 503，登录页与设置页照常可用。
 */

import { createMirrorServer, loadConfig, finalizeConfig, configPath, certDir } from './server.js'
import { createQuestionAnswerer } from './mirror.js'

/** 插件名，与 cordis.patch.yml 里的 name 一致。 */
export const name = 'mobile-mirror'

/** 日志前缀，方便在宿主日志里 grep。 */
const TAG = '[mobile-mirror]'

/**
 * 桌面设置面板读取主机信息的路由路径。
 * ⚠️ 必须与 lib/client.js 里的 INFO_PATH 逐字一致 —— 测试会钉住这一点。
 */
export const PANEL_ROUTE = '/dsh-mirror/info.json'

/**
 * 组装桌面设置面板要显示的内容。
 *
 * 只挑展示需要的字段：口令哈希、请求统计、登录节流状态、证书文件路径都不进来。
 * 这条路由虽然只对回环开放，但"少给"永远比"给多了再后悔"便宜。
 * @param mirror - createMirrorServer() 的返回值。
 * @param config - 归一化后的配置。
 * @returns 可直接 JSON 序列化的对象。
 */
export function buildPanelInfo(mirror, config) {
  const tls = (mirror && mirror.tlsInfo) || {}
  const scheme = tls.enabled ? 'https' : 'http'
  const port = Number(config && config.port) || 0
  const candidates = mirror && typeof mirror.pairInfo === 'function' ? mirror.pairInfo() : []
  const sessions = mirror && mirror.sessions
  return {
    ok: true,
    scheme,
    port,
    loopbackUrl: `${scheme}://127.0.0.1:${port}/`,
    setupUrl: `${scheme}://127.0.0.1:${port}/setup`,
    diagnosticsUrl: `${scheme}://127.0.0.1:${port}/pair.json`,
    username: (config && config.username) || '',
    configured: !!(mirror && typeof mirror.configured === 'function' && mirror.configured()),
    tls: {
      enabled: !!tls.enabled,
      reason: tls.reason || '',
      fingerprint: tls.fingerprint || '',
      validTo: tls.validTo || '',
      subjectAltName: tls.subjectAltName || '',
    },
    candidates: candidates.map((entry) => ({ name: entry.name, address: entry.address, url: entry.url })),
    activeSessions: sessions && typeof sessions.size === 'number' ? sessions.size : 0,
    sessionTtlDays: Number(config && config.sessionTtlDays) || 0,
    enablePrompt: !!(config && config.enablePrompt),
  }
}

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

  // 会话 / 模式 / agent 能力的可变持有者，交给服务层。见文件头注释。
  const deps = { controller: null, presets: null, agents: null, registry: null }

  let mirror
  try {
    mirror = createMirrorServer(config, { log: safeLog, deps })
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

  // 接入会话服务。这是可选依赖：拿不到也不影响服务启动，
  // 只是 /api/sessions、/api/follow、/api/page 会回 503。
  if (root && typeof root.inject === 'function') {
    try {
      root.inject(['sessionController'], (ctx) => {
        deps.controller = ctx.sessionController || null
        safeLog(`${TAG} 会话服务已接入，镜像接口可用`)
        return () => {
          deps.controller = null
          safeLog(`${TAG} 会话服务已断开，镜像接口暂时不可用`)
        }
      })
      // 兜底：若该实现只在"服务发生变化"时才回调，这里补一次立即读取，
      // 免得服务其实早就绪、却一直等不到回调而让 /api/* 一直 503。
      if (!deps.controller && typeof root.get === 'function') {
        deps.controller = root.get('sessionController') || null
        if (deps.controller) safeLog(`${TAG} 会话服务已接入（立即读取），镜像接口可用`)
      }
    } catch (err) {
      safeLog(`${TAG} 注入 sessionController 失败（不影响登录页）：${err && err.message}`)
    }
  } else {
    safeLog(`${TAG} 上下文没有 inject()，镜像接口将不可用（/api/* 返回 503）`)
  }

  // 接入模式与 agent 服务（P3）。同样是可选依赖：
  //   /api/presets 拿不到就回空清单，/api/preset 回 503，
  //   手机回答问题那条链路直接不启用（问题照常只在桌面回答）。
  if (root && typeof root.inject === 'function') {
    try {
      root.inject(['agentPresets', 'agents'], (ctx) => {
        deps.presets = ctx.agentPresets || null
        deps.agents = ctx.agents || null
        safeLog(`${TAG} 模式与 agent 服务已接入`)
        return () => {
          deps.presets = null
          deps.agents = null
          safeLog(`${TAG} 模式与 agent 服务已断开`)
        }
      })
      if (typeof root.get === 'function') {
        if (!deps.presets) deps.presets = root.get('agentPresets') || null
        if (!deps.agents) deps.agents = root.get('agents') || null
      }
    } catch (err) {
      safeLog(`${TAG} 注入 agentPresets/agents 失败（只影响切换模式）：${err && err.message}`)
    }
  }

  // 接入工作区登记表（P4）。同样是可选依赖：拿不到时 /api/workspaces 只会列出
  // "已有会话的目录"，新建会话本身完全不受影响（走 cwd 那条路）。
  //
  // 单独 inject 而不是并进上面那个数组：Cordis 的 inject 要等**全部**依赖就绪才回调，
  // 混在一起的话，只要有一个服务拿不到，另外两个也一起收不到。
  if (root && typeof root.inject === 'function') {
    try {
      root.inject(['workspaceRegistry'], (ctx) => {
        deps.registry = ctx.workspaceRegistry || null
        safeLog(`${TAG} 工作区登记表已接入，新建会话能列出已登记的目录`)
        return () => {
          deps.registry = null
          safeLog(`${TAG} 工作区登记表已断开`)
        }
      })
      if (!deps.registry && typeof root.get === 'function') {
        deps.registry = root.get('workspaceRegistry') || null
      }
    } catch (err) {
      safeLog(`${TAG} 注入 workspaceRegistry 失败（只影响新建会话的目录候选）：${err && err.message}`)
    }
  }

  // 桌面设置面板的数据源：在 DSH 自己的 GUI 服务上注册一条只读路由。
  //
  // 为什么非要有这条路由：浏览器半侧在页面里，**拿不到本机网卡信息**，面板要显示
  // "手机该访问哪个地址"就只能问主机。走 DSH 的 webServer 而不是手机镜像自己的
  // 19388，是为了**同源**：从 http 的 GUI 跨到 https 的 19388 会撞上自签证书
  // （浏览器没访问过那个地址，证书没被信任）与 CORS。鲸鱼插件的
  // /dsh-whale/*.json 走的也是这条路，是第三方插件的既定惯例。
  //
  // 这是对「Route B：不碰 webServer」的一次有边界的扩展：**只新增**一条
  // 只读、仅回环可访问的 JSON 路由，不改动 webServer 的 host / port / 任何既有行为。
  //
  // 可选依赖：拿不到 webServer 只是面板显示"读不到主机信息"，镜像本身照常工作。
  if (root && typeof root.inject === 'function') {
    try {
      root.inject(['webServer'], (ctx) => {
        const webServer = ctx && ctx.webServer
        if (!webServer || typeof webServer.register !== 'function') {
          safeLog(`${TAG} 宿主没有 webServer，桌面设置面板读不到主机信息（镜像不受影响）`)
          return
        }
        try {
          const dispose = webServer.register({
            kind: 'exact',
            path: PANEL_ROUTE,
            handler: (req, res) => {
              // 只给本机：这条路由会吐局域网地址与账号，不该在局域网里可达。
              if (!mirror.fromLoopback(req)) {
                res.statusCode = 403
                res.setHeader('content-type', 'text/plain; charset=utf-8')
                res.end('loopback only')
                return
              }
              res.statusCode = 200
              res.setHeader('content-type', 'application/json; charset=utf-8')
              res.setHeader('cache-control', 'no-store')
              res.end(`${JSON.stringify(buildPanelInfo(mirror, config))}\n`)
            },
          })
          safeLog(`${TAG} 桌面设置面板已接线：${PANEL_ROUTE}（仅回环）`)
          return () => {
            try {
              dispose()
            } catch {}
          }
        } catch (err) {
          safeLog(`${TAG} 注册 ${PANEL_ROUTE} 失败（只影响桌面设置面板）：${err && err.message}`)
        }
      })
    } catch (err) {
      safeLog(`${TAG} 注入 webServer 失败（只影响桌面设置面板）：${err && err.message}`)
    }
  }

  // P3-D：把 agent 的提问转给手机。
  //
  // 必须 prepend：Remote 转发层那个 answerer 认出 agent 之后就不再调用 next()
  // （app.asar 321570），排在它后面永远不会被执行 —— 而 Cordis 的 register 会用
  // unshift 处理 prepend（app.asar 275014），所以这样能插到最前。
  // 注册失败不影响任何现有功能：问题照常只在桌面回答。
  if (root && typeof root.on === 'function' && mirror.questionHub) {
    try {
      root.on('user-questions/request', createQuestionAnswerer(mirror.questionHub, { log: safeLog }), { prepend: true })
      safeLog(`${TAG} 已注册提问转发：手机上也能回答问题`)
    } catch (err) {
      safeLog(`${TAG} 注册提问转发失败（问题仍可在桌面回答）：${err && err.message}`)
    }
  } else {
    safeLog(`${TAG} 上下文没有 on()，手机端无法回答问题（其余功能不受影响）`)
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
