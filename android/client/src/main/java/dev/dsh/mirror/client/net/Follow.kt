package dev.dsh.mirror.client.net

import android.content.Context
import dev.dsh.mirror.ServerPrefs
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.net.SocketTimeoutException
import javax.net.ssl.HttpsURLConnection

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
 * <p>连接、心跳跳过、401 自动重登与退避都在 {@link Sse} 里（0.11 起与提问流共用）。
 *
 * <p><b>重连即重建</b>：宿主每次连接都**先发一份全量 snapshot**，而且没有 `id:` 行可以续传，
 * 所以断线之后最省事也最不会错位的做法就是：重连 → 拿新 snapshot 整体替换。不做增量补齐。
 */
object Follow {

    /** 与网页端的 `PAGE_SIZE` 对齐。 */
    const val MAX = 200

    fun stream(ctx: Context, sessionId: String): Flow<FollowFrame> = callbackFlow {
        val app = ctx.applicationContext
        var conn: HttpsURLConnection? = null

        val worker = launch(Dispatchers.IO) {
            var attempt = 0
            while (isActive) {
                if (!ServerPrefs(app).isConfigured()) {
                    trySend(FollowFrame.Expired)
                    break
                }

                var reason = "连接断开"
                var retryNow = false
                try {
                    val c = Sse.open(app, "/api/follow?id=" + enc(sessionId) + "&max=" + MAX)
                    conn = c
                    when (val code = c.responseCode) {
                        401 -> {
                            if (Sse.relogin(app)) retryNow = true else {
                                trySend(FollowFrame.Expired)
                                return@launch
                            }
                        }
                        200 -> {
                            attempt = 0
                            trySend(FollowFrame.Connected)
                            Sse.read(c) { obj ->
                                val d = Sse.data(obj)
                                when (obj.optString("e")) {
                                    "snapshot" -> if (d != null) trySend(FollowFrame.Snapshot(d))
                                    "event" -> if (d != null) trySend(FollowFrame.Event(d))
                                    "stream" -> if (d != null) trySend(FollowFrame.Stream(d))
                                    "error" -> trySend(
                                        FollowFrame.ServerError(
                                            d?.optString("message").orEmpty().ifEmpty { "电脑报错" },
                                        ),
                                    )
                                    else -> { }
                                }
                            }
                            reason = "电脑关闭了连接"
                        }
                        else -> reason = "电脑返回 HTTP " + code
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
                delay(Sse.backoffMs(attempt))
            }
        }

        awaitClose {
            // disconnect() 会让阻塞中的 readLine() 抛异常，worker 随即退出 ——
            // 否则取消要等到下一行数据（心跳最坏 20 秒）才生效。
            try { conn?.disconnect() } catch (_: Throwable) { }
            worker.cancel()
        }
    }
}