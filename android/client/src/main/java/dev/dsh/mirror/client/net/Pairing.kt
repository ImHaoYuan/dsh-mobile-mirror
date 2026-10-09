package dev.dsh.mirror.client.net

import dev.dsh.mirror.CertPinner
import java.net.HttpURLConnection
import java.net.URL
import java.security.cert.X509Certificate
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager

/**
 * 首次配对：连一次电脑，把对端证书"看一眼"拿回来算指纹。
 *
 * <p>这是整个原生客户端里**唯一**会临时接受未知证书的地方，而且接受的目的只是把指纹
 * 显示给你核对 —— 真正的放行发生在你点"指纹一致"之后：指纹写进 {@code ServerPrefs}，
 * 此后所有连接都按指纹固定走（{@link CertPinner}）。
 *
 * <p>语义与外壳版的 SetupActivity.probe 一致（那边是 Java + 弹窗，这边是 Kotlin + 整页）。
 */
object Pairing {

    /** 探测结果。{@code code <= 0} 或 {@code fingerprint} 为空都表示没连上。 */
    class Probe(val code: Int, val fingerprint: String)

    /** 会阻塞，必须在后台线程调用。 */
    fun probe(host: String, port: Int): Probe {
        val capture = Capture()
        var conn: HttpURLConnection? = null
        var code = -1
        try {
            conn = URL("https://" + host + ":" + port + "/login").openConnection() as HttpURLConnection
            if (conn is HttpsURLConnection) {
                val sc = SSLContext.getInstance("TLS")
                sc.init(null, arrayOf<X509TrustManager>(capture), null)
                conn.sslSocketFactory = sc.socketFactory
                // 证书的 CN/SAN 未必与局域网 IP 对得上，而我们是按指纹固定的，
                // 主机名校验在这里没有增量价值 —— 指纹一致本身就是更强的保证。
                conn.hostnameVerifier = javax.net.ssl.HostnameVerifier { _, _ -> true }
            }
            conn.connectTimeout = 6000
            conn.readTimeout = 6000
            conn.instanceFollowRedirects = false
            conn.requestMethod = "GET"
            code = conn.responseCode
        } catch (t: Throwable) {
            // 失败在下面统一处理
        } finally {
            conn?.disconnect()
        }
        val cert = capture.seen
        return Probe(code, if (cert == null) "" else CertPinner.fingerprint(cert))
    }

    /** 只为"看一眼"证书而存在，本身不做任何校验 —— 所以只用在探测请求上。 */
    private class Capture : X509TrustManager {
        @Volatile var seen: X509Certificate? = null

        override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {}

        override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
            if (!chain.isNullOrEmpty()) seen = chain[0]
        }

        override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
    }
}
