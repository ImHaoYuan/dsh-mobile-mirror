package dsh.mirror.client.net

import android.content.Context
import dsh.mirror.MirrorApi
import dsh.mirror.ServerPrefs
import dsh.mirror.client.vault.SecretVault
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** 登录的结果。每一种都对应一句能给用户看的话。 */
sealed class LoginResult {
    object Ok : LoginResult()
    /** 账号或密码不对 —— 服务端刻意不区分这两者（不给枚举提示）。 */
    object BadCredentials : LoginResult()
    /** 尝试过于频繁，服务端要求等一会儿。 */
    class Locked(val seconds: Int) : LoginResult()
    object Missing : LoginResult()
    /** 电脑上还没设过账号密码。 */
    object Unconfigured : LoginResult()
    object Unreachable : LoginResult()
}

/** 一次带登录态的读取。 */
sealed class Fetch {
    class Ok(val body: String) : Fetch()
    /** 401，且自动重登也没救回来 —— 需要用户重新登录。 */
    object Expired : Fetch()
    /** 连上了但服务端报错（4xx/5xx）。与"连不上"必须分开：一个该重试、一个该查电脑。 */
    class Failed(val code: Int, val body: String) : Fetch()
    object Unreachable : Fetch()
}

/** 一次带登录态的写操作（JSON）。 */
sealed class Send {
    class Ok(val body: String) : Send()
    /** 服务端明确拒绝（4xx/5xx）；body 里通常带 {@code {error, message}}。 */
    class Rejected(val code: Int, val body: String) : Send()
    object Expired : Send()
    object Unreachable : Send()
}

/**
 * 登录与登录态维护。
 *
 * <p><b>为什么判成败只能看 Location</b>：{@code lib/server.js} 的 {@code redirect()} 一律回
 * <b>303</b>，成功是 {@code Location: /}，失败是 {@code Location: /login?e=…}。
 * 状态码在两种情况下完全一样，所以这里既不认 302 也不认 303，只看 Location。
 *
 * <p><b>为什么不用 WebView 那套 CookieManager</b>：原生客户端没有 WebView，
 * 也不需要 —— {@code Set-Cookie} 是明文响应头，登录成功后直接读出来存进
 * {@code ServerPrefs}，后台服务与前台请求共用同一份票根。
 */
object MirrorSession {

    /** 与 {@code lib/server.js} 的 SESSION_COOKIE 必须一致。 */
    private const val COOKIE_NAME = "dsh_mm_session"

    /**
     * 登录。成功时会做三件事：存 Cookie、把账号密码写进保险箱（供自动重登）、返回 Ok。
     *
     * <p>会阻塞（内部切到 IO 线程）。
     */
    suspend fun login(ctx: Context, username: String, password: String): LoginResult =
        withContext(Dispatchers.IO) {
            val r = MirrorApi.postForm(
                ctx, "/login",
                mapOf("username" to username, "password" to password),
                null,
            )
            if (r.code <= 0) return@withContext LoginResult.Unreachable
            if (!r.redirected()) return@withContext LoginResult.Unreachable

            val loc = r.location
            if (loc.isEmpty()) return@withContext LoginResult.Unreachable

            // 成功：Location 是 "/"（或带查询串的根路径）
            if (loc == "/" || loc.startsWith("/?")) {
                val cookie = cookieFrom(r.setCookie)
                if (cookie.isEmpty()) return@withContext LoginResult.Unreachable
                ServerPrefs(ctx).saveCookie(cookie)
                SecretVault.save(ctx, username, password)
                return@withContext LoginResult.Ok
            }

            when (param(loc, "e")) {
                "bad" -> LoginResult.BadCredentials
                "locked" -> LoginResult.Locked(secondsFrom(loc))
                "missing" -> LoginResult.Missing
                "unconfigured" -> LoginResult.Unconfigured
                else -> LoginResult.Unreachable
            }
        }

    /**
     * 带登录态读一个 API 路径，**撞 401 自动重登一次再重试一次**。
     *
     * <p>自动重登是「用 Keystore 存密码」的全部意义：宿主的会话存在内存里，DSH 一重启就清空，
     * 手机必然经常撞 401。重登用的是保险箱里的凭据，用户不用做任何事。
     *
     * <p>只重试<b>一次</b>：重登成功后仍然 401，说明密码已经变了（或电脑上重置了会话），
     * 再循环只会把服务端的登录节流喂满。
     */
    suspend fun fetch(ctx: Context, path: String): Fetch = fetch(ctx, path, 0)

    /**
     * 同 {@link #fetch(Context, String)}，但可以指定**读取**超时。
     *
     * <p>只给翻页用：宿主 {@code /api/page} 要现场读整个会话日志再往前扫，大会话上超过
     * 默认的 6 秒很常见 —— 超时会被收敛成 {@code Unreachable}，界面上就是「连不上电脑」。
     * {@code readTimeoutMs <= 0} 表示用 {@code MirrorApi} 的默认值。
     */
    suspend fun fetch(ctx: Context, path: String, readTimeoutMs: Int): Fetch = withContext(Dispatchers.IO) {
        fun once(): MirrorApi.Reply = if (readTimeoutMs > 0) {
            MirrorApi.get(ctx, path, ServerPrefs(ctx).cookie(), readTimeoutMs)
        } else {
            MirrorApi.get(ctx, path, ServerPrefs(ctx).cookie())
        }

        var r = once()

        if (r.unauthorized()) {
            val cred = SecretVault.load(ctx)
            if (cred != null && login(ctx, cred.first, cred.second) == LoginResult.Ok) {
                r = once()
            }
        }

        when {
            r.code <= 0 -> Fetch.Unreachable
            r.ok() -> Fetch.Ok(r.body)
            r.unauthorized() -> Fetch.Expired
            else -> Fetch.Failed(r.code, r.body)
        }
    }

    /**
     * 带登录态发一份 JSON，**与 {@link #fetch} 同一套 401 自愈**：撞 401 就用保险箱重登一次、
     * 再重发一次。
     *
     * <p>不把非 2xx 直接归成"失败" —— 4xx/5xx 的响应体里往往带着服务端写好的中文说明
     * （例如只读模式的 {@code prompt-disabled}），那比任何本地兜底文案都准。
     */
    suspend fun postJson(ctx: Context, path: String, json: String): Send = withContext(Dispatchers.IO) {
        val type = "application/json; charset=utf-8"
        var r = MirrorApi.request(ctx, "POST", path, type, json, ServerPrefs(ctx).cookie())

        if (r.unauthorized()) {
            val cred = SecretVault.load(ctx)
            if (cred != null && login(ctx, cred.first, cred.second) == LoginResult.Ok) {
                r = MirrorApi.request(ctx, "POST", path, type, json, ServerPrefs(ctx).cookie())
            }
        }

        when {
            r.code <= 0 -> Send.Unreachable
            r.unauthorized() -> Send.Expired
            r.ok() -> Send.Ok(r.body)
            else -> Send.Rejected(r.code, r.body)
        }
    }

    /** 保险箱里有没有凭据（决定"登录已失效"时能不能自动救回来）。 */
    fun hasSavedCredentials(ctx: Context): Boolean = SecretVault.exists(ctx)

    /** 从 {@code Set-Cookie} 里取出「名字=值」，丢掉 HttpOnly/Path/Secure 那些属性。 */
    private fun cookieFrom(setCookie: String): String {
        if (setCookie.isEmpty()) return ""
        val first = setCookie.substringBefore(';').trim()
        return if (first.startsWith(COOKIE_NAME + "=")) first else ""
    }

    private fun param(location: String, name: String): String {
        val q = location.indexOf('?')
        if (q < 0) return ""
        for (part in location.substring(q + 1).split('&')) {
            val eq = part.indexOf('=')
            if (eq > 0 && part.substring(0, eq) == name) return part.substring(eq + 1)
        }
        return ""
    }

    /** {@code s} 是毫秒，界面上说"秒"。 */
    private fun secondsFrom(location: String): Int {
        val raw = param(location, "s").toLongOrNull() ?: return 0
        return ((raw + 999) / 1000).toInt()
    }
}
