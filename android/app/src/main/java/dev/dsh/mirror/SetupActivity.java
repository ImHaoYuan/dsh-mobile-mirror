package dev.dsh.mirror;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.TextUtils;
import android.widget.Button;
import android.widget.EditText;
import android.widget.TextView;

import java.net.HttpURLConnection;
import java.net.URL;
import java.security.cert.X509Certificate;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.X509TrustManager;

/**
 * 首次配置：输入电脑地址，核对证书指纹，建立信任。
 *
 * 这是整个 App 里<b>唯一</b>会临时接受未知证书的地方，且接受的目的只是"看一眼"证书
 * 好把指纹展示给用户。真正的放行发生在用户点"信任"之后 —— 指纹被记下，
 * 此后所有连接都按指纹固定走（见 {@link CertPinner}）。
 */
public class SetupActivity extends Activity {

    private EditText field;
    private Button connect;
    private TextView status;

    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final Handler ui = new Handler(Looper.getMainLooper());

    private ServerPrefs prefs;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_setup);

        prefs = new ServerPrefs(this);

        field = findViewById(R.id.setup_host);
        connect = findViewById(R.id.setup_connect);
        status = findViewById(R.id.setup_status);

        if (prefs.isConfigured()) {
            field.setText(prefs.host() + ":" + prefs.port());
        }

        connect.setOnClickListener(v -> attempt());
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        io.shutdownNow();
    }

    private void attempt() {
        String raw = field.getText().toString();
        String[] parsed = ServerPrefs.normalize(raw);
        if (parsed == null) {
            if (TextUtils.isEmpty(raw.trim())) {
                setStatus(getString(R.string.setup_err_empty));
                return;
            }
            // 全角字符已由 normalize() 折过；走到这里说明还有别的非法字符。
            // 把码位打出来，用户才能看出是哪个字符不对（全角半角肉眼难辨）。
            String detail = ServerPrefs.describeNonAscii(raw);
            setStatus(detail.isEmpty()
                    ? getString(R.string.setup_err_format)
                    : getString(R.string.setup_err_format) + "\n\n地址里有非 ASCII 字符：\n" + detail);
            return;
        }
        final String host = parsed[0];
        final int port = Integer.parseInt(parsed[1]);

        setBusy(true);
        setStatus(getString(R.string.setup_testing));
        io.execute(() -> probe(host, port));
    }

    /** 在后台线程做一次 HTTPS 探测：既验证可达性，也顺手把对端证书拿回来。 */
    private void probe(String host, int port) {
        final Capture capture = new Capture();
        HttpURLConnection conn = null;
        int code = -1;
        try {
            URL url = new URL("https://" + host + ":" + port + "/login");
            conn = (HttpURLConnection) url.openConnection();

            if (conn instanceof HttpsURLConnection) {
                HttpsURLConnection h = (HttpsURLConnection) conn;
                SSLContext sc = SSLContext.getInstance("TLS");
                sc.init(null, new X509TrustManager[]{ capture }, null);
                h.setSSLSocketFactory(sc.getSocketFactory());
                // 证书的 CN/SAN 未必与局域网 IP 对得上，而我们是按指纹固定的，
                // 主机名校验在这里没有增量价值 —— 指纹一致本身就是更强的保证。
                h.setHostnameVerifier((h2, session) -> true);
            }

            conn.setConnectTimeout(6000);
            conn.setReadTimeout(6000);
            conn.setInstanceFollowRedirects(false);
            conn.setRequestMethod("GET");
            code = conn.getResponseCode();
        } catch (Exception ignored) {
            // 失败在下面统一处理（cert 为 null 或 code <= 0）
        } finally {
            if (conn != null) conn.disconnect();
        }

        final X509Certificate cert = capture.seen;
        final int fCode = code;
        ui.post(() -> onProbeResult(host, port, cert, fCode));
    }

    private void onProbeResult(String host, int port, X509Certificate cert, int code) {
        if (isFinishing() || isDestroyed()) return;
        setBusy(false);

        if (cert == null || code <= 0) {
            setStatus(getString(R.string.setup_err_unreachable));
            return;
        }

        final String actual = CertPinner.fingerprint(cert);
        final String pinned = prefs.fingerprint();
        final boolean sameTarget = host.equalsIgnoreCase(prefs.host()) && port == prefs.port();

        if (pinned.isEmpty() || !sameTarget) {
            // 尚未建立信任，或换了地址 —— 需要用户核对指纹
            confirmNewCert(host, port, actual, !sameTarget);
        } else if (pinned.equalsIgnoreCase(actual)) {
            finishOk(host, port);
        } else {
            // 同一个地址，但证书换了。这才是真正可疑的情况，不自动放行。
            showMismatch(host, port, actual);
        }
    }

    private void confirmNewCert(String host, int port, String fingerprint, boolean changed) {
        String msg = getString(R.string.cert_message)
                + (changed ? "\n\n（地址已变更）" : "")
                + "\n\n" + CertPinner.pretty(fingerprint);
        new AlertDialog.Builder(this)
                .setTitle(R.string.cert_title)
                .setMessage(msg)
                .setPositiveButton(R.string.cert_trust, (d, w) -> {
                    prefs.saveFingerprint(fingerprint);
                    finishOk(host, port);
                })
                .setNegativeButton(R.string.cert_cancel, null)
                .show();
    }

    private void showMismatch(String host, int port, String actual) {
        setStatus(getString(R.string.setup_err_cert) + "\n\n" + CertPinner.pretty(actual));
        new AlertDialog.Builder(this)
                .setTitle(R.string.setup_err_cert)
                .setMessage("电脑上记录的指纹是：\n" + CertPinner.pretty(prefs.fingerprint())
                        + "\n\n这次拿到的指纹是：\n" + CertPinner.pretty(actual)
                        + "\n\n如果电脑上重新生成过证书（例如局域网 IP 变了），"
                        + "需要清除记录并重新配对。")
                .setPositiveButton("重新配对", (d, w) -> {
                    prefs.saveFingerprint("");
                    setStatus("");
                    attempt();
                })
                .setNegativeButton(R.string.cert_cancel, null)
                .show();
    }

    @SuppressWarnings("deprecation")   // overridePendingTransition，理由见方法内注释
    private void finishOk(String host, int port) {
        prefs.save(host, port);
        startActivity(new Intent(this, MainActivity.class));
        // API 34 起推荐 overrideActivityTransition，但 overridePendingTransition 至今有效，
        // 一条就能覆盖 minSdk 29 到最新版。只在这处用，不值得为 34+ 再写一条分支。
        overridePendingTransition(R.anim.slide_in_right, R.anim.slide_out_left);
        finish();
    }

    private void setBusy(boolean busy) {
        connect.setEnabled(!busy);
        field.setEnabled(!busy);
    }

    private void setStatus(String text) {
        status.setText(text);
    }

    /**
     * 只为"看一眼"对端证书而存在，<b>本身不做任何校验</b>。
     *
     * 因此它只被用在 SetupActivity 的探测请求上，且响应体从不渲染 ——
     * 拿到的证书必须先经用户核对指纹、写入 {@link ServerPrefs} 之后，
     * 才会由 {@link CertPinner#trustManager} 在真正的连接上生效。
     */
    private static final class Capture implements X509TrustManager {
        volatile X509Certificate seen;

        @Override
        public void checkClientTrusted(X509Certificate[] chain, String authType) {
        }

        @Override
        public void checkServerTrusted(X509Certificate[] chain, String authType) {
            if (chain != null && chain.length > 0) seen = chain[0];
        }

        @Override
        public X509Certificate[] getAcceptedIssuers() {
            return new X509Certificate[0];
        }
    }
}
