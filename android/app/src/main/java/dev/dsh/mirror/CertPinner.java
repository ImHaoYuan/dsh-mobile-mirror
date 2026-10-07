package dev.dsh.mirror;

import java.security.MessageDigest;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;
import java.util.Locale;

import javax.net.ssl.X509TrustManager;

/**
 * 证书指纹固定（TOFU）。
 *
 * 为什么不装系统 CA：装 CA 是<b>系统级</b>信任 —— 所有 App 都信，系统还会常驻一条
 * "网络可能受到监控"。指纹固定把信任限制在本 App 内。见 docs/apk-plan.md §6.3。
 */
final class CertPinner {

    private CertPinner() {}

    /** 证书 DER 的 SHA-256，小写十六进制、无分隔符。失败返回空串。 */
    static String fingerprint(X509Certificate cert) {
        if (cert == null) return "";
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] digest = md.digest(cert.getEncoded());
            StringBuilder sb = new StringBuilder(digest.length * 2);
            for (byte b : digest) {
                sb.append(Character.forDigit((b >> 4) & 0xF, 16));
                sb.append(Character.forDigit(b & 0xF, 16));
            }
            return sb.toString();
        } catch (Exception e) {
            return "";
        }
    }

    /** 与已记录的指纹比对。未记录指纹时返回 false。 */
    static boolean matches(String pinned, X509Certificate cert) {
        if (pinned == null || pinned.isEmpty()) return false;
        String actual = fingerprint(cert);
        return !actual.isEmpty() && actual.equalsIgnoreCase(pinned);
    }

    /** 界面展示用：AA:BB:CC:… 大写、按字节分隔。 */
    static String pretty(String hex) {
        if (hex == null || hex.isEmpty()) return "";
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < hex.length(); i += 2) {
            if (sb.length() > 0) sb.append(':');
            sb.append(hex, i, Math.min(i + 2, hex.length()));
        }
        return sb.toString().toUpperCase(Locale.US);
    }

    /**
     * 只信任指定指纹的 TrustManager，供 MirrorService 的 HttpsURLConnection 使用。
     *
     * 指纹不符时在<b>握手阶段</b>就抛异常 —— 比 WebView 的 onReceivedSslError 更干净，
     * 不存在"忘了 cancel"从而静默放行的可能。
     *
     * 注意这里只接受入参指纹，<b>不持有 Context</b>，避免长期引用泄漏。
     */
    static X509TrustManager trustManager(final String pinnedFingerprint) {
        return new X509TrustManager() {
            @Override
            public void checkClientTrusted(X509Certificate[] chain, String authType) {
                // 本 App 只做客户端，不校验对端的客户端证书
            }

            @Override
            public void checkServerTrusted(X509Certificate[] chain, String authType)
                    throws CertificateException {
                if (chain == null || chain.length == 0) {
                    throw new CertificateException("空证书链");
                }
                if (!matches(pinnedFingerprint, chain[0])) {
                    throw new CertificateException("证书指纹与记录不符");
                }
            }

            @Override
            public X509Certificate[] getAcceptedIssuers() {
                return new X509Certificate[0];
            }
        };
    }
}
