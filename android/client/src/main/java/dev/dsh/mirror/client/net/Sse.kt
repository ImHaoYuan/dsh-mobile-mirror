package dev.dsh.mirror.client.net

import android.content.Context
import dev.dsh.mirror.CertPinner
import dev.dsh.mirror.ServerPrefs
import dev.dsh.mirror.client.vault.SecretVault
import org.json.JSONObject
import java.net.URL
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager

/**
 * 两条 SSE（`/api/follow` 与 `/api/questions/stream`）共用的底座。
 *
 * <p><b>为什么不用 `:core` 的 MirrorApi</b>：它把响应体读满再返回（{@code Reply.body}），
 * 而 SSE 要的是**边到边读**。往 `:core` 加流式接口会改变外壳 APK 的 dex ——
 * 而 `CertPinner.trustManager()` 与 `ServerPrefs` 都是公开的，所以这里自己建连接，
 * 共用同一套指纹固定与票根，`:core` 一行都不用动（外壳 APK 因此继续逐字节一致）。
 *
 * <p>抽出来是因为 0.11 多了第二条流：证书固定、心跳跳过、401 自动重登、退避这几段
 * 抄第二遍就一定会漂移。
 */
internal object Sse {

    private const val CONNECT_MS = 8_000
    private const val READ_MS = 45_000
    private const val BACKOFF_MAX_MS = 10_000L

    /**
     * 建一条 SSE 连接（还没读）。调用方负责 {@code disconnect()}。
     *
     * <p>读超时 45 秒：宿主每 20 秒发一次 `: hb` 心跳。真断网时 socket 不一定立刻报错，
     * 光等 TCP 会让界面一直显示「已连接」却什么都不来。45 秒 ≈ 两个心跳没到就重连。
     */
    fun open(ctx: Context, path: String): HttpsURLConnection {
        val prefs = ServerPrefs(ctx)
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

    /**
     * 逐行读 SSE：空行分隔帧、`:` 开头是注释（心跳）、只认 `data:` 那一行。
     *
     * <p>阻塞读到流结束为止 —— 断开连接会让 {@code readLine()} 抛异常，调用方接住即可。
     */
    fun read(conn: HttpsURLConnection, onData: (JSONObject) -> Unit) {
        val reader = conn.inputStream.bufferedReader(Charsets.UTF_8)
        while (true) {
            val line = reader.readLine() ?: return
            if (line.isEmpty() || line[0] == ':') continue
            if (!line.startsWith("data:")) continue
            val payload = line.substring(5).trim()
            if (payload.isEmpty()) continue
            val obj = try { JSONObject(payload) } catch (_: Throwable) { continue }
            onData(obj)
        }
    }

    /**
     * 票根过期（宿主会话在内存里，DSH 一重启就清）→ 用保险箱里的凭据自动重登一次。
     *
     * @returns 重登成功才为 true；这时调用方应当**立刻重连**，不进退避。
     */
    suspend fun relogin(ctx: Context): Boolean {
        val cred = SecretVault.load(ctx) ?: return false
        return MirrorSession.login(ctx, cred.first, cred.second) == LoginResult.Ok
    }

    /** 退避：1s、2s、4s、8s，之后一直是 10s。 */
    fun backoffMs(attempt: Int): Long {
        if (attempt <= 1) return 1_000L
        if (attempt >= 5) return BACKOFF_MAX_MS
        return (1_000L shl (attempt - 1)).coerceAtMost(BACKOFF_MAX_MS)
    }

    /** 把 `d` 取出来（所有帧都是 `{e:..., d:{...}}` 形状）。 */
    fun data(obj: JSONObject): JSONObject? = obj.optJSONObject("d")
}