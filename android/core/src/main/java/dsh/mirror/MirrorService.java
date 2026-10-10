package dsh.mirror;

// 本类住在 :core 里，R 是 :core 自己的（android.nonTransitiveRClass=true）。
import dsh.mirror.core.R;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;

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
 *
 * <p><b>0.15 的「按需模式」</b>（{@link #EXTRA_ON_DEMAND}，只有原生客户端会传）：
 * 没会话在跑就不再监测 —— 空闲满 {@value #IDLE_STOP_MS} 毫秒就自己 {@code stopSelf()}，
 * 常驻通知与岛一起消失。"空闲时保留一个慢速心跳"这种折中是<b>刻意不做</b>的
 * （用户选的 A：没会话 = 完全停）。
 *
 * <p><b>外壳不传这个 extra，行为与 0.1.x 一模一样</b>：常驻、{@code START_STICKY}、
 * 不发第二条通知。新加的第二个渠道也就不会被它用到。
 *
 * <p>按需模式下会多发<b>第二条</b>通知（走 {@link #CHANNEL_ALERT}，会响会弹）：
 * 有提问 → 「等你回答 · 会话名」+ 题面；某个会话刚跑完 → 「会话名 已完成」。
 */
public class MirrorService extends Service {

    static final String CHANNEL_SERVICE = "service";
    /** 0.15：第二条「提醒」通知的渠道。与常驻通知分开，因为这条要响要弹。 */
    static final String CHANNEL_ALERT = "alert";
    static final int NOTIF_ID_SERVICE = 1;
    static final int NOTIF_ID_ASK = 2;
    static final int NOTIF_ID_DONE = 3;
    /** 「检测通知」发的那条（设置面板点一下就有）。 */
    static final int NOTIF_ID_TEST = 4;

    /**
     * 「按需模式」开关：客户端传 {@code true} = 没会话在跑就自己停；外壳不传 = 常驻。
     *
     * <p>放在 :core 里当常量，免得两个 App 各写一份字符串对不上。
     */
    public static final String EXTRA_ON_DEMAND = "dsh.mirror.onDemand";

    /**
     * 点通知 / 点岛要落到哪个会话（0.15.7）。
     *
     * <p>缺省不传 = 只打开 App（外壳版就是这个行为，一点不变）。
     */
    public static final String EXTRA_SESSION_ID = "dsh.mirror.sessionId";

    /** 同一个会话的标题；只让会话页顶栏在首帧快照到达前有字可显示。 */
    public static final String EXTRA_SESSION_TITLE = "dsh.mirror.sessionTitle";

    /**
     * 「App 正在前台」（0.15.7）。
     *
     * <p>用户要求：**在 App 内就不弹超级岛、也不发第二条提醒** —— 人都已经在看着了，
     * 再飘一条到屏幕顶上没有意义，切出去还得手动划掉。
     *
     * <p>为什么用**进程级静态**：上报的是 Activity，拿不到 Service 实例；而两个 App
     * 各跑各的进程，静态字段不会互相串。默认 {@code false} = 老行为（照旧弹岛、照旧提醒），
     * 所以**不调这个方法的 WebView 外壳版行为一点不变**。
     */
    private static volatile boolean appVisible = false;

    /**
     * 当前活着的服务实例（进程内）。
     *
     * <p>存在的唯一理由：{@link #setAppVisible} 是**静态**的（上报方是 Activity，
     * 拿不到 Service 实例），而"前台变了"必须**当场重发一次通知**才有效果 ——
     * 岛参数是挂在某个 {@link Notification} 实例上的，不重发就永远是上一次那一份。
     */
    private static volatile MirrorService instance;

    /**
     * 客户端在 {@code ON_START} / {@code ON_STOP} 上报是否在前台，见 {@link #appVisible}。
     *
     * <p><b>为什么"值变了"必须重发通知（0.15.8 修的坑）</b>：0.15.7 只把这个标志读进
     * {@link #buildNotification()}，却忘了通知**什么时候重发**是由 {@link IslandMonitor}
     * 的状态签名去重决定的。于是前台时状态一变，重发出去的是不带岛参数的通知；退到后台
     * 若没有新的状态跳变，就再没有一次重发 —— <b>岛彻底不出现</b>。反向同理：后台挂着岛
     * 回到 App，岛也收不回去。所以可见性一变就自己补一次重发。
     *
     * <p>值没变直接返回：外壳版从不调这个方法，静态量恒为 {@code false}，
     * <b>外壳行为因此与 1.1.x 完全一致</b>。
     */
    public static void setAppVisible(boolean visible) {
        if (appVisible == visible) return;
        appVisible = visible;
        final MirrorService s = instance;
        if (s != null) s.ui.post(s::publish);
    }

    /**
     * 空闲持续这么久就自己停（只在按需模式）。
     *
     * <p>为什么要留 30 秒：8 秒的绿岛刚走完就停服，会让"已完成"那条提醒还没被看见
     * 就从通知栏消失（前台服务通知随服务一起走）。留一段宽限，既不长期占着通知，
     * 又能让收尾（发完成通知、收岛）跑完。
     */
    private static final long IDLE_STOP_MS = 30000L;

    private IslandMonitor monitor;
    /** 最近一次状态。服务通知的内容和岛都由它决定。 */
    private volatile IslandMonitor.Snapshot snapshot = new IslandMonitor.Snapshot();

    /** 是不是"按需模式"。{@code onStartCommand} 里按 extra 更新。 */
    private boolean onDemand;
    /**
     * 上一次为哪条状态发过提醒。
     *
     * <p>轮询 3 秒一次，但"提问"和"已完成"各自只该提醒一次 —— 靠这个键去重。
     * 回到运行中/空闲时清空，这样同一会话的<b>下一次</b>完成还会再提醒。
     */
    private String lastAlertKey = "";
    private final Handler ui = new Handler(Looper.getMainLooper());
    private final Runnable idleStop = new Runnable() {
        @Override public void run() {
            if (!onDemand) return;
            if (snapshot.state != IslandMonitor.State.IDLE) return;
            // 显式摘掉前台通知再停：不靠系统"顺手清理"的默认行为
            if (Build.VERSION.SDK_INT >= 24) stopForeground(STOP_FOREGROUND_REMOVE);
            stopSelf();
        }
    };

    /**
     * 客户端用：按需起服务。
     *
     * <p>幂等 —— 已经在跑了再调一次只是又走一遍 {@code onStartCommand}，
     * 通知内容重算一遍而已。
     */
    public static void startOnDemand(Context ctx) {
        Intent i = new Intent(ctx, MirrorService.class).putExtra(EXTRA_ON_DEMAND, true);
        if (Build.VERSION.SDK_INT >= 26) {
            ctx.startForegroundService(i);
        } else {
            ctx.startService(i);
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        ensureChannels(this);

        monitor = new IslandMonitor(this, s -> {
            snapshot = s;
            publish();
            alert(s);
            trackIdle(s);
        });
        monitor.start();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // START_STICKY 被系统重启时 intent 是 null —— 那时沿用上一次的模式
        if (intent != null && intent.hasExtra(EXTRA_ON_DEMAND)) {
            onDemand = intent.getBooleanExtra(EXTRA_ON_DEMAND, false);
        }
        Notification n = buildNotification();
        if (Build.VERSION.SDK_INT >= 34) {
            // Android 14+ 必须声明前台服务类型，且要和 manifest 里的一致
            startForeground(NOTIF_ID_SERVICE, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        } else {
            startForeground(NOTIF_ID_SERVICE, n);
        }
        // 按需模式不粘：被系统杀掉不用自己爬起来，客户端下次需要时会再起。
        // 常驻模式维持 0.1.x 的 START_STICKY。
        return onDemand ? START_NOT_STICKY : START_STICKY;
    }

    @Override
    public void onDestroy() {
        if (instance == this) instance = null;
        if (monitor != null) monitor.stop();
        ui.removeCallbacks(idleStop);
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
     * 按需模式下的第二条通知。
     *
     * <p>只在<b>状态跳变</b>时发一次（{@link #lastAlertKey} 去重）。离开「等你回答」时
     * 把提问那条撤掉 —— 已经答完了就不该继续挂在通知栏里。
     *
     * <p>完成那条<b>不撤</b>：它就该留在通知栏等用户看到（岛只停 8 秒，通知不该也只有 8 秒）。
     */
    private void alert(IslandMonitor.Snapshot s) {
        if (!onDemand) return;
        // 0.15.7：App 正开着就不发第二条提醒 —— 人都已经在看着了。
        // **刻意不动 lastAlertKey**：在前台"看过"不等于"知道"，切回后台后同样的状态
        // 还该再提醒一次（要求原话：在 app 内就不弹，检测当前在 app 内就不弹）。
        if (appVisible) return;
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm == null) return;

        String name = s.title == null ? "" : s.title.trim();

        if (s.state == IslandMonitor.State.WAITING) {
            String key = "ask|" + s.title + "|" + s.questionText;
            if (!key.equals(lastAlertKey)) {
                lastAlertKey = key;
                String title = name.isEmpty()
                        ? getString(R.string.island_state_waiting)
                        : getString(R.string.notif_alert_waiting_title, name);
                String text = s.questionText == null || s.questionText.trim().isEmpty()
                        ? getString(R.string.notif_alert_waiting_text)
                        : s.questionText.trim();
                try {
                    nm.notify(NOTIF_ID_ASK, buildAlert(title, text, false, s.sessionId));
                } catch (Throwable ignored) {
                    // 弹不出来不该让服务崩掉
                }
            }
            return;
        }

        // 不在"等你回答"了：把提问那条撤掉
        nm.cancel(NOTIF_ID_ASK);

        if (s.state == IslandMonitor.State.DONE) {
            String key = "done|" + s.title;
            if (!key.equals(lastAlertKey)) {
                lastAlertKey = key;
                String title = name.isEmpty()
                        ? getString(R.string.island_state_done)
                        : getString(R.string.notif_alert_done_title, name);
                try {
                    nm.notify(NOTIF_ID_DONE, buildAlert(title, getString(R.string.notif_alert_done_text), true, s.sessionId));
                } catch (Throwable ignored) {
                    // 同上
                }
            }
            return;
        }

        // 回到运行中 / 空闲：允许同样的状态下次再提醒一次
        lastAlertKey = "";
    }

    /**
     * 一条「提醒」通知。{@code autoCancel} = 点一下自己消失（完成那条就该这样）。
     *
     * @param sessionId 这条提醒归属的会话；带上它，点通知就**直接进那个会话**（0.15.7）。
     */
    private Notification buildAlert(String title, String text, boolean autoCancel, String sessionId) {
        return new Notification.Builder(this, CHANNEL_ALERT)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(title)
                .setContentText(text)
                .setStyle(new Notification.BigTextStyle().bigText(text))
                .setContentIntent(openIntent(sessionId, title, "alert"))
                .setAutoCancel(autoCancel)
                .setShowWhen(false)
                .build();
    }

    /**
     * 空闲就排一个"自己停"的闹钟，一忙起来就撤掉。
     *
     * <p>这是「没会话就不监测」的落点：8 秒的绿岛走完 → 空闲 → 再宽限
     * {@value #IDLE_STOP_MS} 毫秒 → 停服，常驻通知与岛一起消失。
     */
    private void trackIdle(IslandMonitor.Snapshot s) {
        ui.removeCallbacks(idleStop);
        if (onDemand && s.state == IslandMonitor.State.IDLE) {
            ui.postDelayed(idleStop, IDLE_STOP_MS);
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

        // 0.15：第二条「提醒」通知。刻意用 HIGH —— 用户要的就是"弹一条出来"，
        // 提问和完成都得让人当场看见。常驻那条仍是 LOW，两者互不影响。
        NotificationChannel alert = new NotificationChannel(
                CHANNEL_ALERT,
                ctx.getString(R.string.notif_channel_alert),
                NotificationManager.IMPORTANCE_HIGH);
        alert.setDescription(ctx.getString(R.string.notif_channel_alert_desc));
        alert.setShowBadge(true);
        nm.createNotificationChannel(alert);
    }

    /**
     * 「检测通知」：给设置面板用 —— 建好渠道后按 {@link #CHANNEL_ALERT} 发一条测试提醒。
     *
     * <p>返回**是否真的发出去了**：通知权限被系统关掉时如实返回 false，
     * 让界面能说"发不出去"，而不是假装成功（0.15.1：用户报"第二条提醒没出来"，
     * 最后确认是系统里把本应用的通知关了 —— 得给个当场能自证的地方）。
     */
    public static boolean notifyTest(Context ctx) {
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        if (nm == null) return false;
        ensureChannels(ctx);
        if (Build.VERSION.SDK_INT >= 24 && !nm.areNotificationsEnabled()) return false;

        Intent open = ctx.getPackageManager().getLaunchIntentForPackage(ctx.getPackageName());
        if (open == null) open = new Intent(Intent.ACTION_MAIN).setPackage(ctx.getPackageName());
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pi = PendingIntent.getActivity(
                ctx, openRequestCode(null, "test"), open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Notification.Builder b = new Notification.Builder(ctx, CHANNEL_ALERT)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(ctx.getString(R.string.notif_test_title))
                .setContentText(ctx.getString(R.string.notif_test_text))
                .setStyle(new Notification.BigTextStyle().bigText(ctx.getString(R.string.notif_test_text)))
                .setContentIntent(pi)
                .setAutoCancel(true);
        try {
            nm.notify(NOTIF_ID_TEST, b.build());
            return true;
        } catch (Throwable t) {
            return false;
        }
    }

    private Notification buildNotification() {
        IslandMonitor.Snapshot s = snapshot;

        Notification n = new Notification.Builder(this, CHANNEL_SERVICE)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(getString(R.string.notif_service_title))
                .setContentText(s.notifText(this))
                .setContentIntent(openIntent(s.sessionId, s.title, "svc"))
                .setOngoing(true)
                .setOnlyAlertOnce(true)   // 状态变化时静默更新，不响不震（用户定的"只让岛变化"）
                .setShowWhen(false)
                .build();

        // 必须在 build() 之后挂 extras —— 参考实现就是这么做的。
        // toOpts() 返回 null（空闲）时不挂，岛自然收起。
        // 0.15.7：App 在前台时不挂岛参数 —— 常驻通知照旧（它是前台服务的载体，
        // 撤掉系统会立刻补回来），只是不再往屏幕顶上飘。
        IslandSupport.Opts o = appVisible ? null : s.toOpts(this);
        if (o != null) {
            String json = IslandSupport.buildParamJsonEx(o);
            // 岛图标用全彩的 launcher 图标 —— 真机验证过它能完整显示。
            // 资源 id 从 ApplicationInfo 取，不写 R.mipmap.*：那是各 App 自己的图标
            // （外壳版是蓝底，原生版是黑底）。
            IslandSupport.attach(this, n, json, getApplicationInfo().icon);
        }
        return n;
    }

    /**
     * 点通知 / 点岛 → 打开本 App（能带会话就顺带把会话带上，0.15.7）。
     *
     * <p>按包名解析入口 Activity，**不写死 MainActivity.class** —— 这个类在 :core 里，
     * 而两个 App（WebView 外壳 / 原生客户端）各有自己的入口 Activity。外壳版的
     * MainActivity 不读这个 extra，所以它只会"打开 App"，与 0.15 之前完全一样。
     *
     * <p><b>请求码必须按通知分开</b>：{@code PendingIntent} 的 {@code filterEquals} 只比
     * 组件 / action / data / category，**不比 extras** —— 同一个请求码 + 同一个入口 Activity
     * 会**复用同一个 PendingIntent 并覆盖 extras**，于是后面那条通知会偷走前面那条的会话。
     * 所以按 (用途, 会话) 生成请求码。
     *
     * @param sessionId 目标会话；null / 空 = 只打开 App。
     * @param title 会话标题（顶栏在快照到达前的占位）。
     * @param slot 用途标识，避免同会话的常驻 / 提问 / 完成三条互相覆盖。
     */
    private PendingIntent openIntent(String sessionId, String title, String slot) {
        Intent open = getPackageManager().getLaunchIntentForPackage(getPackageName());
        if (open == null) {
            open = new Intent(Intent.ACTION_MAIN).setPackage(getPackageName());
        }
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        if (sessionId != null && !sessionId.isEmpty()) {
            open.putExtra(EXTRA_SESSION_ID, sessionId);
            if (title != null && !title.isEmpty()) open.putExtra(EXTRA_SESSION_TITLE, title);
        }
        return PendingIntent.getActivity(
                this, openRequestCode(sessionId, slot), open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /** (用途, 会话) → PendingIntent 请求码。见 {@link #openIntent(String, String, String)} 的理由。 */
    static int openRequestCode(String sessionId, String slot) {
        int h = ((slot == null ? "" : slot) + "#" + (sessionId == null ? "" : sessionId)).hashCode();
        return h == 0 ? 1 : h;
    }
}
