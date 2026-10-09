package dev.dsh.mirror;

// 本类住在 :core 里，R 是 :core 自己的（android.nonTransitiveRClass=true）。
import dev.dsh.mirror.core.R;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

/**
 * 前台服务：保持进程存活 + 后台监控会话状态并驱动超级岛。
 *
 * <p><b>为什么通知不能靠 WebView 里的 JS</b>：App 切后台时 WebView 的定时器被节流，
 * 划掉最近任务时 Activity 销毁、JS 彻底停止。所以后台工作必须由服务独立完成 ——
 * 轮询在 {@link IslandMonitor} 里，用的是原生 {@link MirrorApi}。
 *
 * <p><b>岛挂在哪条通知上</b>：就是这条常驻的服务通知本身。0.1.2 的变体 D 已经证明
 * 「载体是普通通知还是前台服务通知」<b>无关紧要</b>，而常驻通知天然满足"持续上岛"。
 *
 * <p><b>空闲时怎么"收岛"</b>：重新发一条<b>不带 extras</b> 的同 id 通知，
 * 岛就没了 —— extras 是挂在 {@code Notification} 实例上的，换一个实例即可，
 * 不需要（也没有 API 可以）就地摘除。
 */
public class MirrorService extends Service {

    static final String CHANNEL_SERVICE = "service";
    static final int NOTIF_ID_SERVICE = 1;

    private IslandMonitor monitor;
    /** 最近一次状态。服务通知的内容和岛都由它决定。 */
    private volatile IslandMonitor.Snapshot snapshot = new IslandMonitor.Snapshot();

    @Override
    public void onCreate() {
        super.onCreate();
        ensureChannels(this);

        monitor = new IslandMonitor(this, s -> {
            snapshot = s;
            publish();
        });
        monitor.start();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Notification n = buildNotification();
        if (Build.VERSION.SDK_INT >= 34) {
            // Android 14+ 必须声明前台服务类型，且要和 manifest 里的一致
            startForeground(NOTIF_ID_SERVICE, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        } else {
            startForeground(NOTIF_ID_SERVICE, n);
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        if (monitor != null) monitor.stop();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    /**
     * 状态变了就重发同 id 的通知。
     *
     * <p>调用频率由 {@link IslandMonitor} 的<b>状态签名去重</b>控制 ——
     * 只有岛的内容真的变了才会走到这里。否则 3 秒一次的重发会让通知栏抖动，还费电。
     */
    private void publish() {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm == null) return;
        try {
            nm.notify(NOTIF_ID_SERVICE, buildNotification());
        } catch (Throwable ignored) {
            // 通知发不出去不该让服务崩掉
        }
    }

    /**
     * 建好通知渠道。
     *
     * <p>API 26+ 往**不存在的渠道**发通知会被系统直接丢掉，所以启动时先建好。
     */
    static void ensureChannels(Context ctx) {
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        if (nm == null) return;

        NotificationChannel svc = new NotificationChannel(
                CHANNEL_SERVICE,
                ctx.getString(R.string.notif_channel_service),
                NotificationManager.IMPORTANCE_LOW);   // 低调：不出声、不弹横幅
        svc.setDescription(ctx.getString(R.string.notif_channel_service_desc));
        svc.setShowBadge(false);
        nm.createNotificationChannel(svc);
    }

    private Notification buildNotification() {
        IslandMonitor.Snapshot s = snapshot;

        // 按包名解析入口 Activity，**不写死 MainActivity.class** —— 这个类在 :core 里，
        // 而两个 App（WebView 外壳 / 原生客户端）各有自己的入口 Activity。
        Intent open = getPackageManager().getLaunchIntentForPackage(getPackageName());
        if (open == null) {
            open = new Intent(Intent.ACTION_MAIN).setPackage(getPackageName());
        }
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pi = PendingIntent.getActivity(
                this, 0, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Notification n = new Notification.Builder(this, CHANNEL_SERVICE)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(getString(R.string.notif_service_title))
                .setContentText(s.notifText(this))
                .setContentIntent(pi)
                .setOngoing(true)
                .setOnlyAlertOnce(true)   // 状态变化时静默更新，不响不震（用户定的"只让岛变化"）
                .setShowWhen(false)
                .build();

        // 必须在 build() 之后挂 extras —— 参考实现就是这么做的。
        // toOpts() 返回 null（空闲）时不挂，岛自然收起。
        IslandSupport.Opts o = s.toOpts(this);
        if (o != null) {
            String json = IslandSupport.buildParamJsonEx(o);
            // 岛图标用全彩的 launcher 图标 —— 真机验证过它能完整显示。
            // 资源 id 从 ApplicationInfo 取，不写 R.mipmap.*：那是各 App 自己的图标
            // （外壳版是蓝底，原生版是黑底）。
            IslandSupport.attach(this, n, json, getApplicationInfo().icon);
        }
        return n;
    }
}
