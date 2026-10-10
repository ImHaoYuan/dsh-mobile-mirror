package dsh.mirror;

import android.app.Activity;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.SslErrorHandler;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import java.security.cert.X509Certificate;

/**
 * WebView 宿主。界面完全由网页承担，原生只管四件事：
 * 证书指纹、导航边界、返回键、Cookie 持久化。
 */
public class MainActivity extends Activity {

    private static final long BACK_EXIT_WINDOW_MS = 2000L;

    private WebView web;
    private View loading;
    private ServerPrefs prefs;

    private long lastBackAt = 0L;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        prefs = new ServerPrefs(this);
        if (!prefs.isConfigured()) {
            startActivity(new Intent(this, SetupActivity.class));
            finish();
            return;
        }

        setContentView(R.layout.activity_main);
        web = findViewById(R.id.web);
        loading = findViewById(R.id.loading);

        configureWebView();

        if (isDebuggable()) {
            WebView.setWebContentsDebuggingEnabled(true);
        }

        web.loadUrl(prefs.baseUrl() + "/");

        startForegroundService();
    }

    private boolean isDebuggable() {
        return (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
    }

    private void configureWebView() {
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);          // 页面用 localStorage 存折叠状态
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setSupportZoom(false);
        s.setMediaPlaybackRequiresUserGesture(true);
        // 固定文本缩放：页面已按手机宽度调好，跟随系统字体放大会把排版撑坏
        s.setTextZoom(100);

        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        cm.setAcceptThirdPartyCookies(web, false);

        web.setWebViewClient(new WebViewClient() {

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if ("https".equals(uri.getScheme()) && isSameOrigin(uri)) {
                    return false;   // 同源，留在 App 内
                }
                // 其余一律交给系统浏览器，绝不在 WebView 里打开外部站点
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                } catch (Exception ignored) {
                }
                return true;
            }

            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                X509Certificate cert = null;
                try {
                    if (Build.VERSION.SDK_INT >= 29) {
                        cert = error.getCertificate().getX509Certificate();
                    }
                } catch (Throwable ignored) {
                }

                // proceed() 只有这一条出口：指纹与记录一致。
                // 其余一律 cancel —— 绝不出现无条件的 proceed。
                if (cert != null && CertPinner.matches(prefs.fingerprint(), cert)) {
                    handler.proceed();
                    return;
                }
                handler.cancel();

                String shown = cert == null ? "" : CertPinner.pretty(CertPinner.fingerprint(cert));
                new android.app.AlertDialog.Builder(MainActivity.this)
                        .setTitle(R.string.setup_err_cert)
                        .setMessage("连接被拒绝：证书指纹与记录不符。\n\n本次：\n" + shown
                                + "\n\n如果电脑上重新生成过证书，请回到设置重新配对。")
                        .setPositiveButton("重新配对", (d, w) -> {
                            prefs.saveFingerprint("");
                            goSetup();
                        })
                        .setNegativeButton(R.string.cert_cancel, null)
                        .show();
            }

            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                loading.setVisibility(View.VISIBLE);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                loading.setVisibility(View.GONE);
                // 登录页跳回来时 Cookie 才刚种下，这里抄一次最及时
                captureCookie();
            }
        });
    }

    /**
     * 把 WebView 的会话 Cookie 抄进 SharedPreferences，供 {@link MirrorService} 使用。
     *
     * <p><b>为什么需要这一步</b>：服务是纯原生的，没有 WebView，调 API 时必须自己带
     * {@code Cookie} 头。而会话 Cookie 是 {@code HttpOnly} 的（{@code lib/server.js:601}），
     * JS 读不到 —— 只能由原生 {@code CookieManager.getCookie()} 抄出来。
     *
     * <p><b>只在拿到非空值时写入</b>：页面刚加载时 Cookie 可能还没种下，
     * 用空值覆盖会把上一次的登录态抹掉。真正的失效由服务侧的 401 判定。
     */
    private void captureCookie() {
        try {
            String cookie = CookieManager.getInstance().getCookie(prefs.baseUrl());
            if (cookie != null && !cookie.isEmpty()) {
                prefs.saveCookie(cookie);
            }
        } catch (Throwable ignored) {
            // 抄不到就算了 —— 服务侧会按"未登录"处理，不会误报
        }
    }

    private boolean isSameOrigin(Uri uri) {
        String host = uri.getHost();
        if (host == null || !host.equalsIgnoreCase(prefs.host())) return false;
        int p = uri.getPort();
        // 页面从 https://host:port 加载，同源链接会带端口；-1 防御性接受
        return p == -1 || p == prefs.port();
    }

    private void startForegroundService() {
        Intent svc = new Intent(this, MirrorService.class);
        if (Build.VERSION.SDK_INT >= 26) {
            startForegroundService(svc);
        } else {
            startService(svc);
        }
    }

    /** 回设置页重新配对，带上与 SetupActivity 一致的转场。 */
    @SuppressWarnings("deprecation")   // overridePendingTransition 在 API 34 废弃但仍有效
    private void goSetup() {
        startActivity(new Intent(this, SetupActivity.class));
        overridePendingTransition(R.anim.slide_in_right, R.anim.slide_out_left);
    }

    /**
     * 返回键两级：聊天页 → 触发页面自己的 ‹ 返回按钮；已在列表页 → 双击退出。
     *
     * 判断的是 {@code #view-list}（视图容器），<b>不是</b> {@code #list}（列表内层容器，
     * 从不隐藏）。写成 #list 的话判断永远为假，返回键会退化成"永远直接退出"。
     * 这两个 id 已被 tools/web-test.mjs 的断言钉住。
     */
    private void handleBack() {
        web.evaluateJavascript(
                "(function(){var v=document.getElementById('view-list');"
                        + "var b=document.getElementById('btn-back');"
                        + "if(v&&v.hidden&&b){b.click();return 'back';}return 'exit';})()",
                value -> {
                    if (value != null && value.contains("back")) return;
                    confirmExit();
                });
    }

    private void confirmExit() {
        long now = System.currentTimeMillis();
        if (now - lastBackAt < BACK_EXIT_WINDOW_MS) {
            finish();
            return;
        }
        lastBackAt = now;
        Toast.makeText(this, "再按一次退出", Toast.LENGTH_SHORT).show();
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            handleBack();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    protected void onPause() {
        super.onPause();
        // 不 flush 的话进程被杀会丢登录态
        CookieManager.getInstance().flush();
        // 再抄一次：用户可能在这次会话里刚登录
        captureCookie();
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.setWebViewClient(new WebViewClient());
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
