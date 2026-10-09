package dev.dsh.mirror.client.net

import android.content.Context
import dev.dsh.mirror.CertPinner
import dev.dsh.mirror.ServerPrefs
import dev.dsh.mirror.client.vault.SecretVault
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.net.SocketTimeoutException
import java.net.URL
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager

/** `/api/follow` 流上的一帧。 */
sealed class FollowFrame {
    /** 连上了（含每次重连成功）。 */
    object Connected : FollowFrame()

    /** 掉线了，正在退避重试。{@code attempt} 从 1 开始。 */
    class Disconnected(val attempt: Int, val reason: String) : FollowFrame()

    /** 票根彻底失效：自动重登也没救回来，该回登录页了。 */
    object Expired : FollowFrame()

    /** 首帧 —— 整段视图（每次连接都会重发）。 */
    class Snapshot(val json: JSONObject) : FollowFrame()

    /** 一条已落库的投影事件。 */
    class Event(val json: JSONObject) : FollowFrame()

    /** 逐字流式帧。键名被宿主压短了（{@code k/i/t/…}），见 `lib/mirror.js` 的 `projectStreamFrame`。 */
    class Stream(val json: JSONObject) : FollowFrame()

    /** 宿主自己报的错（流中断），随后它会关掉连接。 */
    class ServerError(val message: String) : FollowFrame()
}

/**
 * 实时跟随一条会话（Server-Sent Events）。
 *
 * <p><b>为什么不用 `:core` 的 MirrorApi</b>：它把响应体读满再返回（{@code Reply.body}），
 * 而 SSE 要的是**边到边读**。往 `:core` 加流式接口会改变外壳 APK 的 dex ——
 * 而 `CertPinner.trustManager()` 与 `ServerPrefs` 都是公开的，所以这里自己建连接，
 * 共用同一套指纹固定与票根，`:core` 一行都不用动（外壳 APK 因此继续逐字节一致）。
 *
 * <p><b>重连即重建</b>：宿主每次连接都**先发一份全量 snapshot**，而且没有 `id:` 行可以续传，
 * 所以断线之后最省事也最不会错位的做法就是：重连 → 拿新 snapshot 整体替换。
 * 不做增量补齐。
 *
 * <p><b>为什么要 45 秒读超时</b>：宿主每 20 秒发一次 `: hb` 心跳。真断网时 socket 不一定
 * 立刻报错，光等 TCP 会让界面一直显示"已连接"却什么都不来。45 秒 ≈ 两个心跳没到就重连。
 */
object Follow {

    /** 与网页端的 `PAGE_SIZE` 对齐。 */
    const val MAX = 200

    private const val CONNECT_MS = 8_000
    private const val READ_MS = 45_000
    private const val BACKOFF_MAX_MS = 10_000L

    fun stream(ctx: Context, sessionId: String): Flow<FollowFrame> = callbackFlow {
        val app = ctx.applicationContext
        var conn: HttpsURLConnection? = null

        val worker = launch(Dispatchers.IO) {
            var attempt = 0
            while (isActive) {
                val prefs = ServerPrefs(app)
                if (!prefs.isConfigured()) {
                    trySend(FollowFrame.Expired)
                    break
                }

                var reason = "连接断开"
                var retryNow = false
                try {
                    val c = open(app, prefs, "/api/follow?id=" + enc(sessionId) + "&max=" + MAX)
                    conn = c
                    val code = c.responseCode
                    when {
                        code == 401 -> {
                            // 票根过期是常态（宿主会话在内存里，DSH 一重启就清）。
                            // 用保险箱里的凭据自动重登一次，成功就立刻重连，不进退避。
                            if (relogin(app)) {
                                retryNow = true
                            } else {
                                trySend(FollowFrame.Expired)
                                return@launch
                            }
                        }
                        code != 200 -> reason = "电脑返回 HTTP " + code
                        else -> {
                            attempt = 0
                            trySend(FollowFrame.Connected)
                            readFrames(c) { trySend(it) }
                            reason = "电脑关闭了连接"
                        }
                    }
                } catch (t: Throwable) {
                    reason = if (t is SocketTimeoutException) "电脑没有响应" else "连不上电脑"
                } finally {
                    try { conn?.disconnect() } catch (_: Throwable) { }
                    conn = null
                }

                if (!isActive) break
                if (retryNow) continue

                attempt += 1
                trySend(FollowFrame.Disconnected(attempt, reason))
                delay(backoffMs(attempt))
            }
        }

        awaitClose {
            // disconnect() 会让阻塞中的 readLine() 抛异常，worker 随即退出 ——
            // 否则取消要等到下一行数据（心跳最坏 20 秒）才生效。
            try { conn?.disconnect() } catch (_: Throwable) { }
            worker.cancel()
        }
    }

    /** 退避：1s、2s、4s、8s，之后一直是 10s。 */
    private fun backoffMs(attempt: Int): Long {
        if (attempt <= 1) return 1_000L
        if (attempt >= 5) return BACKOFF_MAX_MS
        return (1_000L shl (attempt - 1)).coerceAtMost(BACKOFF_MAX_MS)
    }

    private suspend fun relogin(ctx: Context): Boolean {
        val cred = SecretVault.load(ctx) ?: return false
        return MirrorSession.login(ctx, cred.first, cred.second) == LoginResult.Ok
    }

    private fun open(ctx: Context, prefs: ServerPrefs, path: String): HttpsURLConnection {
        val conn = URL(prefs.baseUrl() + path).openConnection() as HttpsURLConnection
        val tm: X509TrustManager = CertPinner.trustManager(prefs.fingerprint())
        val sc = SSLContext.getInstance("TLS")
        sc.init(null, arrayOf(tm), null)
        conn.sslSocketFactory = sc.socketFactory
        conn.hostnameVerifier = HostnameVerifier { _, _ -> true }
        conn.connectTimeout = CONNECT_MS
        conn.readTimeout = READ_MS
        conn.instanceFollowRedirects = false
        conn.setRequestProperty("Accept", "text/event-stream")
        val cookie = prefs.cookie()
        if (cookie.isNotEmpty()) conn.setRequestProperty("Cookie", cookie)
        return conn
    }

    /** 逐行读 SSE：空行分隔帧、`:` 开头是注释（心跳）、只认 `data:` 那一行。 */
    private fun readFrames(conn: HttpsURLConnection, emit: (FollowFrame) -> Unit) {
        val reader = conn.inputStream.bufferedReader(Charsets.UTF_8)
        while (true) {
            val line = reader.readLine() ?: return
            if (line.isEmpty() || line[0] == ':') continue
            if (!line.startsWith("data:")) continue
            val payload = line.substring(5).trim()
            if (payload.isEmpty()) continue
            val obj = try { JSONObject(payload) } catch (_: Throwable) { continue }
            val d = obj.optJSONObject("d")
            when (obj.optString("e")) {
                "snapshot" -> if (d != null) emit(FollowFrame.Snapshot(d))
                "event" -> if (d != null) emit(FollowFrame.Event(d))
                "stream" -> if (d != null) emit(FollowFrame.Stream(d))
                "error" -> emit(FollowFrame.ServerError(d?.optString("message").orEmpty().ifEmpty { "电脑报错" }))
                else -> { }
            }
        }
    }
}
