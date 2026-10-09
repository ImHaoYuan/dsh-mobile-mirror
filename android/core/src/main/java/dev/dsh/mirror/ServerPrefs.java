package dev.dsh.mirror;

import android.content.Context;
import android.content.SharedPreferences;

import java.util.Locale;

/**
 * 服务器地址、证书指纹与会话 Cookie 的持久化。
 *
 * <b>不存账号密码</b> —— 登录态由 WebView 的 Cookie 承担：
 * MainActivity 在页面加载完后用 {@code CookieManager.getCookie()} 把会话 Cookie
 * 抄进这里（{@link #saveCookie}），{@link MirrorService} 的原生请求直接带上它
 * （{@link #cookie()}）。见 docs/apk-plan.md §7.4。
 *
 * <p>会话 Cookie 是 {@code HttpOnly}，JS 读不到，但原生 {@code CookieManager}
 * 读得到 —— 这正是这条路可行的前提。代价是 Cookie 有 30 天有效期，
 * 失效后由 {@link IslandMonitor} 在岛上显示「登录失效」，把静默失败变成看得见的。
 */
public final class ServerPrefs {

    private static final String FILE = "dsh_mirror";
    private static final String KEY_HOST = "host";
    private static final String KEY_PORT = "port";
    private static final String KEY_FP = "cert_fingerprint";
    private static final String KEY_COOKIE = "session_cookie";

    public static final int DEFAULT_PORT = 19388;

    private final SharedPreferences prefs;

    public ServerPrefs(Context ctx) {
        this.prefs = ctx.getApplicationContext().getSharedPreferences(FILE, Context.MODE_PRIVATE);
    }

    public boolean isConfigured() {
        return !host().isEmpty();
    }

    public String host() {
        return prefs.getString(KEY_HOST, "");
    }

    public int port() {
        return prefs.getInt(KEY_PORT, DEFAULT_PORT);
    }

    /** 形如 https://192.168.1.5:19388，无尾斜杠。 */
    public String baseUrl() {
        return "https://" + host() + ":" + port();
    }

    public void save(String host, int port) {
        prefs.edit().putString(KEY_HOST, host).putInt(KEY_PORT, port).apply();
    }

    /** 小写十六进制，无分隔符。空字符串表示尚未建立信任。 */
    public String fingerprint() {
        return prefs.getString(KEY_FP, "");
    }

    public void saveFingerprint(String hex) {
        prefs.edit().putString(KEY_FP, hex == null ? "" : hex).apply();
    }

    /**
     * 会话 Cookie 的原始串（形如 {@code dsh_mm_session=xxxx}），空串表示还没登录过。
     *
     * <p>由 MainActivity 从 {@code CookieManager} 抄来。服务侧直接把它塞进
     * {@code Cookie} 请求头，不解析、不重组 —— 服务端认的是原串。
     */
    public String cookie() {
        return prefs.getString(KEY_COOKIE, "");
    }

    public void saveCookie(String cookie) {
        prefs.edit().putString(KEY_COOKIE, cookie == null ? "" : cookie).apply();
    }

    public void clear() {
        prefs.edit().clear().apply();
    }

    /**
     * 把用户输入解析成 {host, port}。返回 null 表示格式不合法。
     *
     * 接受这些写法：
     *   192.168.1.5:19388
     *   192.168.1.5              （用默认端口）
     *   https://192.168.1.5:19388
     *   https://192.168.1.5:19388/login   （多余路径被丢掉）
     *   [fe80::1]:19388          （IPv6 字面量）
     *   １０.０.０.１：１９３８８             （全角，中文输入法下很常见）
     */
    public static String[] normalize(String raw) {
        if (raw == null) return null;
        String s = toHalfWidth(raw).trim();
        if (s.isEmpty()) return null;

        if (s.startsWith("https://")) s = s.substring(8);
        else if (s.startsWith("http://")) s = s.substring(7);

        // 丢掉路径 / 查询 / 锚点
        int cut = s.length();
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '/' || c == '?' || c == '#') { cut = i; break; }
        }
        s = s.substring(0, cut);
        if (s.isEmpty()) return null;

        String host;
        String portPart = null;

        if (s.startsWith("[")) {
            int close = s.indexOf(']');
            if (close < 0) return null;
            host = s.substring(1, close);
            if (close + 1 < s.length()) {
                if (s.charAt(close + 1) != ':') return null;
                portPart = s.substring(close + 2);
            }
        } else {
            int colon = s.lastIndexOf(':');
            if (colon >= 0) {
                host = s.substring(0, colon);
                portPart = s.substring(colon + 1);
            } else {
                host = s;
            }
        }

        if (host.isEmpty()) return null;
        for (int i = 0; i < host.length(); i++) {
            char c = host.charAt(i);
            boolean ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
                    || (c >= '0' && c <= '9')
                    || c == '.' || c == '-' || c == '_' || c == ':';
            if (!ok) return null;
        }

        int port = DEFAULT_PORT;
        if (portPart != null && !portPart.isEmpty()) {
            try {
                port = Integer.parseInt(portPart);
            } catch (NumberFormatException e) {
                return null;
            }
            if (port < 1 || port > 65535) return null;
        }

        return new String[]{ host, String.valueOf(port) };
    }

    /**
     * 全角折半角，并把各种"看起来像空格"的字符折成普通空格。
     *
     * <b>为什么需要这个</b>：中文输入法下很容易打出全角冒号（：U+FF1A）、全角句点
     * （．U+FF0E）、全角数字（０-９）和全角空格（　U+3000）。它们与半角字符是
     * <b>不同的码位</b>，肉眼几乎看不出差别，却会被字符校验拒掉 ——
     * 用户看到的现象是"我明明打对了"。
     *
     * 实测过：全角冒号 / 全角句点 / 全角数字 / U+3000 空格都会导致解析失败。
     *
     * U+FF01..U+FF5E 这一段是 ASCII 可打印区整体平移 0xFEE0，减回去就是半角，
     * 一次覆盖冒号、句点、数字、字母、连字符等全部情况。
     *
     * 注意：<b>不能用 String.strip()</b> —— 它是 API 33+ 才有的，minSdk 29 在
     * Android 10~12 上会 NoSuchMethodError。所以自己折，折完用 trim()。
     */
    private static String toHalfWidth(String s) {
        StringBuilder sb = new StringBuilder(s.length());
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '\u3000' || c == '\u00A0') {
                sb.append(' ');                       // 全角空格、不换行空格
            } else if (c >= '\uFF01' && c <= '\uFF5E') {
                sb.append((char) (c - 0xFEE0));       // 全角 ASCII 区
            } else {
                sb.append(c);
            }
        }
        return sb.toString();
    }

    /**
     * 列出字符串里所有非 ASCII 字符及其码位，供报错信息使用。
     * 返回空串表示全是 ASCII。
     *
     * 全角字符与半角肉眼难辨，把码位打出来用户才能自己定位是哪个字符不对。
     */
    public static String describeNonAscii(String s) {
        if (s == null) return "";
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c > 0x7F) {
                if (sb.length() > 0) sb.append("、");
                sb.append('\'').append(c).append("' U+")
                  .append(String.format(Locale.US, "%04X", (int) c));
            }
        }
        return sb.toString();
    }
}
