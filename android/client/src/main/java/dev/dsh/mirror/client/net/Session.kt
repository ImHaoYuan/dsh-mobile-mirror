package dev.dsh.mirror.client.net

import android.content.Context
import dev.dsh.mirror.MirrorApi
import org.json.JSONObject
import java.net.URLEncoder
import java.util.TimeZone

/** 一次翻页的结果。 */
sealed class PageOutcome {
    class Ok(val records: List<JSONObject>, val hasMore: Boolean) : PageOutcome()
    object Expired : PageOutcome()
    class Failed(val code: Int, val body: String) : PageOutcome()
    object Unreachable : PageOutcome()
}

/** 一次发送 / 停止的结果。 */
sealed class SendOutcome {
    object Ok : SendOutcome()

    /**
     * 发得太快 —— 宿主 `/api/prompt` 有 300ms 节流，命中时返回 429 `too-fast`。
     *
     * <p>注意宿主的顺序是**先查幂等台账、再看节流**，所以同一个 `requestId` 重发不会被节流挡。
     */
    object TooFast : SendOutcome()

    object Expired : SendOutcome()
    class Failed(val code: Int, val body: String) : SendOutcome()
    object Unreachable : SendOutcome()
}

/**
 * 会话页要用的接口。
 *
 * <p>发送与停止属于 0.8，这里刻意不提前放进来 —— 没接上的写操作比没有更糟。
 *
 * <p><b>首屏不走这里</b>：{@code /api/page} 的 `before` 是**必填**（缺了 400 missing-before），
 * 所以首屏只能靠 `/api/follow` 的第一帧 snapshot。这个接口只用来**往上翻更早的历史**。
 *
 * <p><b>读取超时单独放宽</b>（{@link MirrorApi#PAGE_TIMEOUT_MS}）：宿主是现场读整个会话日志
 * 再往前扫的，大会话上超过默认 6 秒很常见。
 */
object Session {

    /** 与网页端 `PAGE_SIZE` 对齐。 */
    const val PAGE = 200

    /**
     * 取 `before` 之前的一页历史。
     *
     * @param before 当前视图里**最早那条**的 seq —— 严格小于它的事件才会返回。
     */
    suspend fun page(ctx: Context, sessionId: String, before: Int, max: Int = PAGE): PageOutcome {
        val path = "/api/page?id=" + enc(sessionId) + "&before=" + before + "&max=" + max
        return when (val r = MirrorSession.fetch(ctx, path, MirrorApi.PAGE_TIMEOUT_MS)) {
            is Fetch.Ok -> {
                val o = try { JSONObject(r.body) } catch (_: Throwable) { return PageOutcome.Unreachable }
                val arr = o.optJSONArray("records")
                val list = ArrayList<JSONObject>(arr?.length() ?: 0)
                if (arr != null) {
                    for (i in 0 until arr.length()) arr.optJSONObject(i)?.let { list.add(it) }
                }
                PageOutcome.Ok(list, o.optBoolean("hasMore", false))
            }
            is Fetch.Expired -> PageOutcome.Expired
            is Fetch.Failed -> PageOutcome.Failed(r.code, r.body)
            Fetch.Unreachable -> PageOutcome.Unreachable
        }
    }

    /**
     * 发一条纯文本消息。
     *
     * @param requestId 幂等键，形状 `[A-Za-z0-9_-]{1,128}`（宿主会先查幂等台账）。
     *   **重试必须复用同一个 requestId** —— 弱网下"发出去了但没收到响应"是常态，
     *   换了新 id 就会真的发第二遍。
     */
    suspend fun prompt(ctx: Context, sessionId: String, requestId: String, text: String): SendOutcome {
        val payload = JSONObject()
            .put("sessionId", sessionId)
            .put("requestId", requestId)
            .put("text", text)
            // 宿主上限 64 字符；手机时区给模型一个"现在几点"的锚
            .put("timeZone", TimeZone.getDefault().id)
        return when (val r = MirrorSession.postJson(ctx, "/api/prompt", payload.toString())) {
            is Send.Ok -> SendOutcome.Ok
            is Send.Rejected -> if (r.code == 429) SendOutcome.TooFast else SendOutcome.Failed(r.code, r.body)
            is Send.Expired -> SendOutcome.Expired
            Send.Unreachable -> SendOutcome.Unreachable
        }
    }

    /** 停掉正在跑的这一轮。请求体**只有 sessionId**（与网页端一致）。 */
    suspend fun cancel(ctx: Context, sessionId: String): SendOutcome {
        val payload = JSONObject().put("sessionId", sessionId)
        return when (val r = MirrorSession.postJson(ctx, "/api/cancel", payload.toString())) {
            is Send.Ok -> SendOutcome.Ok
            is Send.Rejected -> SendOutcome.Failed(r.code, r.body)
            is Send.Expired -> SendOutcome.Expired
            Send.Unreachable -> SendOutcome.Unreachable
        }
    }
}

/** 查询串里的值要转义（会话 id 是 UUID，但别指望它永远是）。 */
internal fun enc(s: String): String = try {
    URLEncoder.encode(s, "UTF-8")
} catch (_: Throwable) {
    s
}
