package dsh.mirror.client.net

import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.provider.MediaStore
import dsh.mirror.CertPinner
import dsh.mirror.ServerPrefs
import java.net.SocketTimeoutException
import java.net.URL
import java.net.URLDecoder
import java.net.URLEncoder
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLException
import javax.net.ssl.X509TrustManager

/**
 * 从电脑下载工作区里的文件，存进系统的「下载」目录。
 *
 * <p>电脑端每次编译都会贴出文件，手机端点一下文件芯片就能拿到手。插件侧（1.3.0 起）
 * 只允许**工作区目录内**的文件，单个文件不超过 1 GB；这里是**只读**操作，
 * 所以只读模式（enablePrompt=false）下也能用。
 *
 * <p>落盘走 MediaStore.Downloads（API 29+，正好是本应用的下限），**不需要任何存储权限**。
 */
object Download {
    private const val CONNECT_MS = 15_000

    /** 读超时给大文件留余地，但也不能无限等。 */
    private const val READ_MS = 60_000

    private const val BUF = 64 * 1024

    sealed class Result {
        /** @param uri MediaStore 地址，「打开」按钮要用。 */
        data class Ok(val name: String, val bytes: Long, val uri: Uri) : Result()

        data class Fail(val message: String) : Result()
    }

    /**
     * 下载并落盘。**必须在 IO 线程调用**（会阻塞）。
     *
     * @param sessionId 会话 id：相对路径由插件按这个会话的工作目录解析。
     * @param onProgress (已下载字节, 总字节)；总字节未知时给 -1。
     */
    fun run(
        ctx: Context,
        prefs: ServerPrefs,
        sessionId: String,
        path: String,
        onProgress: (Long, Long) -> Unit,
    ): Result {
        var conn: HttpsURLConnection? = null
        var uri: Uri? = null
        try {
            val query = "/api/file?id=" + URLEncoder.encode(sessionId, "UTF-8") +
                "&path=" + URLEncoder.encode(path, "UTF-8")
            conn = open(prefs, query)
            val code = conn.responseCode
            if (code != 200 && code != 206) return Result.Fail(errorOf(conn, code))

            val total = conn.contentLengthLong
            val name = nameOf(conn.getHeaderField("Content-Disposition"), path)
            val type = conn.contentType?.substringBefore(';')?.trim().orEmpty()

            val values = ContentValues().apply {
                put(MediaStore.Downloads.DISPLAY_NAME, name)
                put(MediaStore.Downloads.MIME_TYPE, type.ifEmpty { "application/octet-stream" })
                // IS_PENDING：写完之前别的应用看不到这个半成品
                put(MediaStore.Downloads.IS_PENDING, 1)
            }
            val resolver = ctx.contentResolver
            val target = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                ?: return Result.Fail("写不进系统「下载」目录")
            uri = target

            var done = 0L
            var wrote = false
            resolver.openOutputStream(target)?.use { out ->
                conn.inputStream.use { input ->
                    val buf = ByteArray(BUF)
                    while (true) {
                        val n = input.read(buf)
                        if (n <= 0) break
                        out.write(buf, 0, n)
                        done += n
                        wrote = true
                        onProgress(done, total)
                    }
                }
            }
            if (!wrote) return Result.Fail("系统「下载」目录不可写")

            resolver.update(target, ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }, null, null)
            return Result.Ok(name, done, target)
        } catch (e: Exception) {
            // 半成品要删掉，别在用户的下载目录里留垃圾
            uri?.let { runCatching { ctx.contentResolver.delete(it, null, null) } }
            return Result.Fail(friendly(e))
        } finally {
            runCatching { conn?.disconnect() }
        }
    }

    /** 与 Follow 同一套：只信这台电脑的证书指纹（配对时钉下来的）。 */
    private fun open(prefs: ServerPrefs, query: String): HttpsURLConnection {
        val conn = URL(prefs.baseUrl() + query).openConnection() as HttpsURLConnection
        val tm: X509TrustManager = CertPinner.trustManager(prefs.fingerprint())
        val sc = SSLContext.getInstance("TLS")
        sc.init(null, arrayOf(tm), null)
        conn.sslSocketFactory = sc.socketFactory
        conn.hostnameVerifier = javax.net.ssl.HostnameVerifier { _, _ -> true }
        conn.connectTimeout = CONNECT_MS
        conn.readTimeout = READ_MS
        conn.instanceFollowRedirects = false
        val cookie = prefs.cookie()
        if (cookie.isNotEmpty()) conn.setRequestProperty("Cookie", cookie)
        return conn
    }

    /** 插件出错时回的是 JSON `{ error, message }`：把 message 抠出来给用户看。 */
    private fun errorOf(conn: HttpsURLConnection, code: Int): String {
        val body = try {
            (conn.errorStream ?: conn.inputStream)?.bufferedReader(Charsets.UTF_8)?.use { it.readText() }
        } catch (_: Exception) {
            null
        }
        val msg = body?.let { Regex("\"message\"\\s*:\\s*\"([^\"]*)\"").find(it)?.groupValues?.get(1) }
        if (!msg.isNullOrBlank()) return msg
        return when (code) {
            401 -> "登录状态已失效，请重新登录"
            403 -> "只能下载工作区目录里的文件"
            404 -> "文件不存在（可能已经被删了）"
            413 -> "文件超过 1 GB 上限"
            else -> "下载失败（HTTP " + code + "）"
        }
    }

    /** 文件名优先取 Content-Disposition 里的，取不到就用路径最后一段。 */
    private fun nameOf(header: String?, path: String): String {
        val fallback = path.substringAfterLast('/').substringAfterLast('\\').ifEmpty { "download.bin" }
        if (header == null) return fallback
        val star = Regex("filename\\*=UTF-8''([^;]+)").find(header)?.groupValues?.get(1)
        if (!star.isNullOrBlank()) {
            val decoded = try {
                URLDecoder.decode(star, "UTF-8")
            } catch (_: Exception) {
                star
            }
            if (decoded.isNotBlank()) return decoded.substringAfterLast('/').substringAfterLast('\\')
        }
        val plain = Regex("filename=\"([^\"]*)\"").find(header)?.groupValues?.get(1)
        if (!plain.isNullOrBlank()) return plain
        return fallback
    }

    private fun friendly(e: Exception): String = when (e) {
        is SSLException -> "连不上电脑（证书或网络变了），重新配对一次"
        is SocketTimeoutException -> "下载超时"
        is java.io.IOException -> "网络中断：" + (e.message ?: "未知原因")
        else -> e.message ?: "下载失败"
    }
}
