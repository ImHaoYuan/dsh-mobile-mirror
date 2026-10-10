package dsh.mirror;

import android.content.Context;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.util.Map;

import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.X509TrustManager;

/**
 * 服务侧的<b>原生</b> HTTPS 客户端。
 *
 * <p><b>为什么服务不能像网页那样调 API</b>：网页跑在 WebView 里，登录态由 CookieManager
 * 自动带上。服务是纯原生的，没有 WebView，所以必须自己带 Cookie 头。
 *
 * <p><b>登录态从哪来</b>：见 {@link ServerPrefs#cookie()}。WebView 外壳由 MainActivity 在
 * 页面加载完后用 {@code CookieManager.getCookie()} 抄进 SharedPreferences；原生客户端
 * （:client）则在 {@code POST /login} 时直接读响应的 {@code Set-Cookie}。
 *
 * <p><b>TLS 按指纹固定</b>：用 {@link CertPinner#trustManager}，指纹不符在<b>握手阶段</b>
 * 就失败，不存在"忘了校验从而静默放行"的可能。主机名校验关掉 —— 局域网 IP 与证书
 * CN 本来就可能对不上，而指纹一致是更强的保证（与 SetupActivity 的判断一致）。
 *
 * <p><b>为什么不跟随重定向</b>：未登录时服务端对 {@code /api/*} 直接返回 401
 * （{@code lib/server.js:867}），不重定向；而登录的成败<b>恰恰写在重定向里</b>
 * （见 {@link Reply#location}）。关掉它才能干净地拿到这两个信号。
 */
public final class MirrorApi {

    private static final int TIMEOUT_MS = 6000;

    /**
     * 翻页（{@code /api/page}）的读取超时。
     *
     * <p>宿主是**现场读整个会话日志再往前扫**的，大会话上超过 6 秒很常见 —— 用默认超时
     * 会让「往上翻」被收敛成 {@code code <= 0}，界面上就是「连不上电脑」。
     * 连接超时仍用 {@link #TIMEOUT_MS}：连不上就是连不上，等 30 秒没有意义。
     */
    public static final int PAGE_TIMEOUT_MS = 30000;
    private static final int MAX_BODY = 512 * 1024;

    /** 一次请求的结果。{@code code <= 0} 表示连接或握手失败。 */
    public static final class Reply {
        public final int code;
        public final String body;

        /**
         * 响应的 {@code Location} 头，没有则为空串。
         *
         * <p><b>登录的成败就藏在这里</b>：{@code lib/server.js} 的 {@code redirect()} 一律用
         * <b>303</b>（不是 302），成功回 {@code Location: /}，失败回
         * {@code Location: /login?e=bad|locked|missing|unconfigured}。
         * 所以判成败只能看 Location，不能只看状态码。
         */
        public final String location;

        /**
         * 响应的 {@code Set-Cookie} 头，没有则为空串。登录成功时它是会话票根
         * （{@code dsh_mm_session=…}，HttpOnly，所以只有原生能直接拿到）。
         */
        public final String setCookie;

        Reply(int code, String body, String location, String setCookie) {
            this.code = code;
            this.body = body == null ? "" : body;
            this.location = location == null ? "" : location;
            this.setCookie = setCookie == null ? "" : setCookie;
        }

        public boolean ok() { return code == 200; }

        /** 登录态失效。这是唯一需要让用户看见的失败。 */
        public boolean unauthorized() { return code == 401; }

        /** 3xx：服务端的 {@code redirect()} 用的都是 303。 */
        public boolean redirected() { return code >= 300 && code < 400; }
    }

    private MirrorApi() {}

    /**
     * GET 一个 API 路径（如 {@code /api/sessions}）。
     *
     * <p>本方法<b>会阻塞</b>，只能在后台线程调用。任何失败都收敛成
     * {@code code <= 0} 的 Reply，<b>不抛异常</b> —— 轮询循环里抛异常会把整条循环打断。
     */
    public static Reply get(Context ctx, String path, String cookie) {
        return request(ctx, "GET", path, null, null, cookie);
    }

    /** 同 {@link #get(Context, String, String)}，但读取超时可指定（翻页用 {@link #PAGE_TIMEOUT_MS}）。 */
    public static Reply get(Context ctx, String path, String cookie, int readTimeoutMs) {
        return request(ctx, "GET", path, null, null, cookie, readTimeoutMs);
    }

    /**
     * POST 一份表单（{@code application/x-www-form-urlencoded}），目前只用于登录。
     *
     * <p><b>刻意不跟随重定向</b>：成功与失败都是 303，区别只在 {@code Location}。
     * 跟随了就只会看到登录页的 HTML，反而分不清发生了什么。
     */
    public static Reply postForm(Context ctx, String path, Map<String, String> fields, String cookie) {
        return request(ctx, "POST", path, "application/x-www-form-urlencoded", encodeForm(fields), cookie);
    }

    /**
     * 通用请求。<b>刻意做成通用而不是每处一个方法</b>：JSON 的 POST
     * （{@code /api/prompt}、{@code /api/answer}、{@code /api/model}）直接传
     * {@code contentType = "application/json"} 即可，不必再改这个共用模块 ——
     * 每改一次都要重做一遍外壳 APK 的回归对照。
     *
     * <p>{@code contentType} 与 {@code body} 都为 null 时不带请求体。
     */
    public static Reply request(Context ctx, String method, String path,
                                String contentType, String body, String cookie) {
        return request(ctx, method, path, contentType, body, cookie, TIMEOUT_MS);
    }

    /**
     * 通用请求，读取超时可指定。
     *
     * <p>{@code readTimeoutMs} 只作用于**读取**；连接超时恒为 {@link #TIMEOUT_MS}。
     */
    public static Reply request(Context ctx, String method, String path,
                                String contentType, String body, String cookie,
                                int readTimeoutMs) {
        ServerPrefs prefs = new ServerPrefs(ctx);
        if (!prefs.isConfigured()) return new Reply(-1, "", "", "");

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
            conn.setReadTimeout(readTimeoutMs);
            conn.setInstanceFollowRedirects(false);
            conn.setRequestMethod(method);
            conn.setRequestProperty("Accept", "application/json");
            if (cookie != null && !cookie.isEmpty()) {
                conn.setRequestProperty("Cookie", cookie);
            }

            if (contentType != null && body != null) {
                byte[] raw = body.getBytes("UTF-8");
                conn.setDoOutput(true);
                conn.setRequestProperty("Content-Type", contentType);
                conn.setFixedLengthStreamingMode(raw.length);
                OutputStream os = conn.getOutputStream();
                try {
                    os.write(raw);
                } finally {
                    try { os.close(); } catch (Throwable ignored) { }
                }
            }

            int code = conn.getResponseCode();
            // 2xx 用输入流，其余（含 3xx/4xx/5xx）走错误流 —— 3xx 的 body 本来就是空的。
            InputStream in = (code >= 200 && code < 300) ? conn.getInputStream()
                                                         : conn.getErrorStream();
            return new Reply(code, readAll(in),
                    conn.getHeaderField("Location"),
                    conn.getHeaderField("Set-Cookie"));
        } catch (Throwable t) {
            // 连不上、握手失败、超时 —— 全部等价处理。PC 关机是常态，不是异常。
            return new Reply(-1, "", "", "");
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    /** 表单编码。密码里的 {@code + & = %} 必须转义，否则会被服务端解析歪。 */
    private static String encodeForm(Map<String, String> fields) {
        StringBuilder sb = new StringBuilder();
        for (Map.Entry<String, String> e : fields.entrySet()) {
            if (sb.length() > 0) sb.append('&');
            sb.append(urlEncode(e.getKey())).append('=').append(urlEncode(e.getValue()));
        }
        return sb.toString();
    }

    private static String urlEncode(String s) {
        if (s == null) return "";
        try {
            return URLEncoder.encode(s, "UTF-8");
        } catch (Throwable t) {
            return "";
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
