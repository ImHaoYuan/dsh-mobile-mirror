package dev.dsh.mirror;

import android.app.Activity;
import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.widget.TextView;
import android.widget.Toast;

/**
 * 超级岛验证版：把四个门槛的实际读数摊开，并提供六个岛外观实验的入口。
 *
 * <p>这是 {@code docs/apk-plan.md} §A3.7 第 14 步要求的「验证版」。存在的理由很实际：
 * 不能用 adb，调试只能"改一次 → 装一次 → 看一眼"，所以每趟装机必须把变量收敛到最少。
 *
 * <p><b>当前阶段（0.1.3）要回答的问题</b>：
 *
 * <ol>
 *   <li>收起时那段文字能不能放任意内容（「运行中」），而不只是 {@code "50%"}？</li>
 *   <li>进度弧能不能变成「转圈圈」（不确定进度）？—— 参考实现只演示了确定值进度，
 *       没有任何"加载中"的写法，只能试哨兵值。</li>
 *   <li>左边图标旁能不能再带一段文字（标题前几字）？</li>
 * </ol>
 *
 * <p>门槛不过时岛会**静默失败**（这是最难查的失败方式），所以诊断结果必须显式摊开，
 * 并且能一键复制粘回来。
 */
public class IslandTestActivity extends Activity {

    private static final int ID_TEST = 90;
    private static final int REQ_NOTIF_PERM = 90;

    private static final String BLUE = "#4C8DFF";

    /** 本包标记（普通构建为空串）。由 build.gradle.kts 的 resValue 注入。 */
    private String variant;

    private TextView reportView;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        setContentView(R.layout.activity_island_test);
        reportView = findViewById(R.id.island_report);

        findViewById(R.id.island_refresh).setOnClickListener(v -> refresh());
        findViewById(R.id.island_copy).setOnClickListener(v -> copyReport());
        findViewById(R.id.island_clear).setOnClickListener(v -> clearTests());
        findViewById(R.id.island_settings).setOnClickListener(v -> openNotifSettings());

        findViewById(R.id.island_t1).setOnClickListener(v -> test1Baseline());
        findViewById(R.id.island_t2).setOnClickListener(v -> test2NoV2Progress());
        findViewById(R.id.island_t3).setOnClickListener(v -> test3NoBigProgressText());
        findViewById(R.id.island_t4).setOnClickListener(v -> test4NoProgressAtAll());
        findViewById(R.id.island_t5).setOnClickListener(v -> test5NegativeProgress());
        findViewById(R.id.island_t6).setOnClickListener(v -> test6LeftText());

        findViewById(R.id.island_t7).setOnClickListener(v -> previewRunning());
        findViewById(R.id.island_t8).setOnClickListener(v -> previewDone());
        findViewById(R.id.island_t9).setOnClickListener(v -> previewWaiting());

        // 渠道必须先建好：API 26+ 往不存在的渠道发通知会被系统直接丢掉
        MirrorService.ensureChannels(this);
        requestNotifPermissionIfNeeded();
        refresh();
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] results) {
        super.onRequestPermissionsResult(code, perms, results);
        refresh();
    }

    // ------------------------------------------------------------------
    // 六个实验
    // ------------------------------------------------------------------

    /**
     * 基线：满环 + 自定义文字「运行中」。
     *
     * <p>这一条同时回答两件事：文字字段能不能放任意内容；以及满环长什么样
     * （对比 0.1.2 里 {@code progress=50} 时看到的半圈蓝弧）。
     */
    private void test1Baseline() {
        IslandSupport.Opts o = base();
        post("① 基线·运行中（满环 + 自定义文字）", o);
    }

    /** 去掉 v2 级的 {@code progressInfo} —— 看是不是转圈 / 空环 / 不出岛。 */
    private void test2NoV2Progress() {
        IslandSupport.Opts o = base();
        o.v2Progress = false;
        post("② 试转圈 · 去 v2 progressInfo", o);
    }

    /** 去掉 {@code bigIslandArea.progressTextInfo} —— 同上。 */
    private void test3NoBigProgressText() {
        IslandSupport.Opts o = base();
        o.bigProgressText = false;
        post("③ 试转圈 · 去 progressTextInfo", o);
    }

    /** 两个进度字段都去掉 —— 同上。 */
    private void test4NoProgressAtAll() {
        IslandSupport.Opts o = base();
        o.v2Progress = false;
        o.bigProgressText = false;
        post("④ 试转圈 · 两个都去", o);
    }

    /**
     * {@code progress = -1} 哨兵值。
     *
     * <p>参考实现把进度夹紧在 0..100，所以 -1 是"非法值"。
     * 如果系统对非法值回退到不确定进度，这就是转圈的写法。
     * 这里刻意**不夹紧**，让它原样传进去。
     */
    private void test5NegativeProgress() {
        IslandSupport.Opts o = base();
        o.progress = -1;
        post("⑤ 试转圈 · progress = -1", o);
    }

    /**
     * 给 {@code imageTextInfoLeft} 加 {@code textInfo}。
     *
     * <p>字段名是 "image<b>Text</b>InfoLeft"，但参考实现只放了 {@code picInfo}。
     * 如果它真支持文字，左边就能是「图标 + 标题前几字」。
     */
    private void test6LeftText() {
        IslandSupport.Opts o = base();
        o.leftText = true;
        o.leftTextValue = "DSH";
        post("⑥ 左图带字（试 DSH）", o);
    }

    // ------------------------------------------------------------------
    // 第 2 步的生产配方预览
    // ------------------------------------------------------------------

    /**
     * ⑦ 生产配方的「运行中」预览，<b>走服务渠道</b>（{@code IMPORTANCE_LOW}）。
     *
     * <p><b>为什么必须单测这一条</b>：第 2 步真正的岛就挂在服务那条常驻通知上，
     * 而它是低优先级渠道。0.1.1 试过 A（低）和 B（默认）两个渠道，但那时用的是
     * <b>最小 JSON</b>，两边都没出岛 —— 得不出"渠道有没有影响"的结论。
     * 0.1.2 的 C/E 出岛走的是默认渠道的测试通知。
     * 所以「低优先级渠道 + 全字段 JSON」这个组合<b>从没验证过</b>。
     * 如果它不出岛，第 2 步就得把服务渠道提优先级。
     */
    private void previewRunning() {
        postOn(MirrorService.CHANNEL_SERVICE, "⑦ 预览 · 运行中（蓝 · 服务渠道）",
                production("会话名", "运行中", "#4C8DFF"));
    }

    /** ⑧ 预览「已完成」—— 绿环，第 2 步里会话跑完时短暂显示的样子。 */
    private void previewDone() {
        postOn(MirrorService.CHANNEL_ISLAND_TEST, "⑧ 预览 · 已完成（绿环）",
                production("会话名", "已完成", "#2FBF71"));
    }

    /** ⑨ 预览「等你回答」—— 橙环。 */
    private void previewWaiting() {
        postOn(MirrorService.CHANNEL_ISLAND_TEST, "⑨ 预览 · 等你回答（橙环）",
                production("会话名", "等你回答", "#F5A524"));
    }

    /**
     * 与 {@code MirrorService} 里真正用的岛参数<b>完全一致</b>的配方。
     *
     * <p>左边图标 + 会话名前几字（{@code imageTextInfoLeft}），右边状态文字 + 满环
     * （{@code progressTextInfo}）。这正是 0.1.3 里 ⑥ 验证过能出岛的写法，
     * 也是 {@code Snapshot.toOpts()} 的取值 —— 两处必须保持一致，否则预览就没有意义。
     */
    private IslandSupport.Opts production(String left, String right, String color) {
        IslandSupport.Opts o = new IslandSupport.Opts();
        o.title = getString(R.string.notif_service_title);
        o.content = right;
        o.smallText = right;
        o.hintText = right;
        o.ticker = getString(R.string.notif_service_title) + " " + right;
        o.color = color;
        o.progress = 100;
        o.leftText = true;
        o.leftTextValue = left;
        return o;
    }

    // ------------------------------------------------------------------

    private IslandSupport.Opts base() {
        IslandSupport.Opts o = new IslandSupport.Opts();
        o.title = "DSH 镜像";
        o.content = "2 个会话进行中";
        o.smallText = "运行中";
        o.hintText = "运行中";
        o.ticker = "DSH 运行中";
        o.color = BLUE;
        o.progress = 100;
        return o;
    }

    /** 发一条测试岛通知（默认走测试渠道）。发之前先清掉上一条。 */
    private void post(String label, IslandSupport.Opts o) {
        postOn(MirrorService.CHANNEL_ISLAND_TEST, label, o);
    }

    /**
     * 发一条测试岛通知，可指定渠道。
     *
     * <p>发之前先清掉上一条 —— 同时存在两条「想上岛」的通知时系统行为未定义，
     * 结果就没法判读了。
     */
    private void postOn(String channel, String label, IslandSupport.Opts o) {
        cancelTestNotification();

        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pi = PendingIntent.getActivity(this, ID_TEST, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Notification n = new Notification.Builder(this, channel)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(label)
                .setContentText("DSH 超级岛外观实验")
                .setContentIntent(pi)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setShowWhen(false)
                .build();

        // 必须在 build() 之后挂 extras —— 参考实现就是这么做的
        String json = IslandSupport.buildParamJsonEx(o);
        boolean attached = IslandSupport.attach(this, n, json, R.mipmap.ic_launcher);

        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm != null) nm.notify(ID_TEST, n);

        toast(attached ? label + "\n已发出，请看屏幕顶部"
                       : label + "\n挂 extras 失败");
        refresh();
    }

    private void cancelTestNotification() {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm != null) nm.cancel(ID_TEST);
    }

    private void clearTests() {
        cancelTestNotification();
        toast("已清除测试通知");
    }

    // ------------------------------------------------------------------

    private String variantId() {
        if (variant == null) {
            variant = getString(R.string.variant_id).trim();
        }
        return variant;
    }

    private void refresh() {
        IslandSupport.Report r = IslandSupport.diagnose(this);
        r.channelUsed = MirrorService.CHANNEL_ISLAND_TEST + "（默认优先级）";

        // 第 2 步的岛不出现时，九成是这两个原因之一，所以摊在最前面
        ServerPrefs prefs = new ServerPrefs(this);
        String cookie = prefs.cookie();
        String cookieLine = cookie.isEmpty()
                ? "未登录 —— 先在网页里登录一次，否则岛不会出现"
                : "已抄到会话 Cookie（" + cookie.length() + " 字符）";

        reportView.setText("本包标记：" + (variantId().isEmpty() ? "无" : variantId()) + "\n\n"
                + r.toText()
                + "\n──────── 后台监控 ────────\n"
                + "登录态：" + cookieLine + "\n"
                + "会话列表：" + IslandMonitor.lastSessionsInfo + "\n"
                + "当前岛状态：\n      " + IslandMonitor.lastSummary + "\n");
    }

    private void copyReport() {
        try {
            ClipboardManager cm = getSystemService(ClipboardManager.class);
            if (cm == null) {
                toast("剪贴板不可用");
                return;
            }
            cm.setPrimaryClip(ClipData.newPlainText("超级岛诊断", reportView.getText()));
            toast("已复制，可直接粘贴回来");
        } catch (Throwable t) {
            toast("复制失败：" + t.getClass().getSimpleName());
        }
    }

    private void openNotifSettings() {
        try {
            Intent i = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS);
            i.putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName());
            startActivity(i);
        } catch (Throwable t) {
            toast("打不开系统通知设置，请手动前往");
        }
    }

    private void requestNotifPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT < 33) return;
        if (checkSelfPermission("android.permission.POST_NOTIFICATIONS")
                == PackageManager.PERMISSION_GRANTED) {
            return;
        }
        requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"}, REQ_NOTIF_PERM);
    }

    private void toast(String s) {
        Toast.makeText(this, s, Toast.LENGTH_LONG).show();
    }
}
