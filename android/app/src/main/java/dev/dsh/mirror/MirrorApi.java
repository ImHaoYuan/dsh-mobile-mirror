package dev.dsh.mirror;

import android.content.Context;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.X509TrustManager;

/**
 * 服务侧的<b>原生</b> HTTPS 客户端。
 *
 * <p><b>为什么服务不能像网页那样调 API</b>：网页跑在 WebView 里，登录态由 CookieManager
 * 自动带上。服务是纯原生的，没有 WebView，所以必须自己带 Cookie 头。
 *
 * <p><b>登录态从哪来</b>：见 {@link ServerPrefs#cookie()} —— MainActivity 在页面加载完后
 * 用 {@code CookieManager.getCookie()} 把会话 Cookie 抄进 SharedPreferences，服务直接读。
 * <b>不存密码、不重新登录</b>（docs/apk-plan.md §7.4）。会话 Cookie 是
 * {@code HttpOnly}（{@code lib/server.js:601}），JS 读不到，但原生
 * {@code CookieManager.getCookie()} 读得到 —— 这正是这条路可行的前提。
 *
 * <p><b>TLS 按指纹固定</b>：用 {@link CertPinner#trustManager}，指纹不符在<b>握手阶段</b>
 * 就失败，不存在"忘了校验从而静默放行"的可能。主机名校验关掉 —— 局域网 IP 与证书
 * CN 本来就可能对不上，而指纹一致是更强的保证（与 SetupActivity 的判断一致）。
 *
 * <p><b>为什么不跟随重定向</b>：未登录时服务端对 {@code /api/*} 直接返回 401
 * （{@code lib/server.js:813-817}），不重定向；而登录页的重定向我们不关心。
 * 关掉它才能干净地拿到 401 这个信号。
 */
final class MirrorApi {

    private static final int TIMEOUT_MS = 6000;
    private static final int MAX_BODY = 512 * 1024;

    /** 一次请求的结果。{@code code <= 0} 表示连接或握手失败。 */
    static final class Reply {
        final int code;
        final String body;

        Reply(int code, String body) {
            this.code = code;
            this.body = body == null ? "" : body;
        }

        boolean ok() { return code == 200; }

        /** 登录态失效。这是唯一需要让用户看见的失败。 */
        boolean unauthorized() { return code == 401; }
    }

    private MirrorApi() {}

    /**
     * GET 一个 API 路径（如 {@code /api/sessions}）。
     *
     * <p>本方法<b>会阻塞</b>，只能在后台线程调用。任何失败都收敛成
     * {@code code <= 0} 的 Reply，<b>不抛异常</b> —— 轮询循环里抛异常会把整条循环打断。
     */
    static Reply get(Context ctx, String path, String cookie) {
        ServerPrefs prefs = new ServerPrefs(ctx);
        if (!prefs.isConfigured()) return new Reply(-1, "");

        HttpURLConnection conn = null;
        try {
            URL url = new URL(prefs.baseUrl() + path);
            conn = (HttpURLConnection) url.openConnection();

            if (conn instanceof HttpsURLConnection) {
                HttpsURLConnection h = (HttpsURLConnection) conn;
                X509TrustManager tm = CertPinner.trustManager(prefs.fingerprint());
                SSLContext sc = SSLContext.getInstance("TLS");
                sc.init(null, new X509TrustManager[]{ tm }, null);
                h.setSSLSocketFactory(sc.getSocketFactory());
                h.setHostnameVerifier((hostname, session) -> true);
            }

            conn.setConnectTimeout(TIMEOUT_MS);
            conn.setReadTimeout(TIMEOUT_MS);
            conn.setInstanceFollowRedirects(false);
            conn.setRequestMethod("GET");
            conn.setRequestProperty("Accept", "application/json");
            if (cookie != null && !cookie.isEmpty()) {
                conn.setRequestProperty("Cookie", cookie);
            }

            int code = conn.getResponseCode();
            InputStream in = (code >= 200 && code < 300) ? conn.getInputStream()
                                                         : conn.getErrorStream();
            return new Reply(code, readAll(in));
        } catch (Throwable t) {
            // 连不上、握手失败、超时 —— 全部等价处理。PC 关机是常态，不是异常。
            return new Reply(-1, "");
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private static String readAll(InputStream in) {
        if (in == null) return "";
        try {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) {
                out.write(buf, 0, n);
                if (out.size() > MAX_BODY) break;   // 防御：API 响应不该这么大
            }
            return out.toString("UTF-8");
        } catch (Throwable t) {
            return "";
        } finally {
            try { in.close(); } catch (Throwable ignored) { }
        }
    }
}
