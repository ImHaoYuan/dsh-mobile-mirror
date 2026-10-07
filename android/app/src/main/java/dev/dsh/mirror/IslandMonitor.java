package dev.dsh.mirror;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * 后台监控 + 岛状态机。
 *
 * <p>在 {@link MirrorService} 里常驻，按分频轮询插件的 API，算出"岛现在该显示什么"，
 * 通过 {@link Sink} 回调给服务去更新通知。
 *
 * <p><b>三种状态 + 一个错误态，优先级从高到低</b>：
 * <ol>
 *   <li>{@link State#WAITING} 等你回答 —— 最高，橙</li>
 *   <li>{@link State#RUNNING} 运行中 —— 蓝</li>
 *   <li>{@link State#DONE} 已完成 —— 绿，<b>只持续 {@value #DONE_HOLD_MS} 毫秒</b></li>
 *   <li>{@link State#IDLE} 空闲 —— 摘掉 extras，岛收起</li>
 * </ol>
 * 错误态 {@link State#EXPIRED} 优先级最高：会话 Cookie 失效时显示「登录失效」。
 *
 * <p><b>为什么要专门做一个「登录失效」态</b>：登录态是靠 Cookie 承担的
 * （见 {@link MirrorApi}），而 Cookie 有 30 天有效期。失效后轮询会一直拿到 401，
 * 岛就会<b>静默消失</b> —— 用户完全无从判断是"没会话"还是"掉登录"。
 * 把 401 显式画到岛上，这个静默失败就变成了看得见的。
 *
 * <p><b>轮询分频</b>（用户批准的"按方案分频"）：{@code /api/questions} 固定 3 秒
 * （便宜，内存里取）；{@code /api/sessions} 有活动时 5 秒、空闲时 20 秒
 * （它会打宿主控制器，比较贵）。"有活动" = 有会话在跑 <b>或</b> 有问题在等。
 */
final class IslandMonitor {

    /** 岛的状态，按优先级从高到低。 */
    enum State { EXPIRED, WAITING, RUNNING, DONE, IDLE }

    /** 一次"岛该显示什么"的完整描述。 */
    static final class Snapshot {
        State state = State.IDLE;
        /**
         * 岛展开后的标题 —— <b>当前状态对应的那个会话的名字</b>。
         *
         * <p>用户反馈：点开岛显示的是「DSH 镜像」（App 名），不是对话标题。原因是这里
         * 之前写死成 {@code notif_service_title}。这个值同时喂给 {@code baseInfo.title}
         * / {@code shareData.title} / {@code aodTitle} 三处，所以它就是点开后看到的那行。
         *
         * <p>空串表示"没有具体会话可归"（空闲 / 登录失效），此时回退成 App 名。
         */
        String title = "";
        /** 左边图标旁的文字（会话名前几字）。 */
        String left = "";
        /** 右边文字（运行中 / 等你回答 / 已完成）。 */
        String right = "";
        int progress = 100;
        String color = IslandMonitor.BLUE;
        /** 诊断页用的一句话。 */
        String note = "（还没开始轮询）";

        /**
         * 转成 {@link IslandSupport.Opts}；返回 {@code null} 表示<b>不该上岛</b>。
         *
         * <p>字段取值全部沿用真机验证过的配方（0.1.3 的 ① 与 ⑥）：
         * 左边 {@code imageTextInfoLeft} 同时带图标和文字，右边 {@code progressTextInfo}
         * 带文字和进度环。<b>刻意不动</b> {@code v2Progress} / {@code bigProgressText}
         * 两个开关 —— 保持"已知能出岛"的形状，只换内容和颜色。
         */
        IslandSupport.Opts toOpts(Context ctx) {
            if (state == State.IDLE) return null;

            String shownTitle = title == null || title.trim().isEmpty()
                    ? ctx.getString(R.string.notif_service_title)
                    : title.trim();

            IslandSupport.Opts o = new IslandSupport.Opts();
            o.title = shownTitle;
            o.content = notifText(ctx);
            o.smallText = right;
            o.hintText = right;
            o.ticker = shownTitle + " " + right;
            o.color = color;
            o.progress = progress;
            o.leftText = true;
            o.leftTextValue = left;
            return o;
        }

        /** 通知栏里那句正文，也跟着状态走。 */
        String notifText(Context ctx) {
            switch (state) {
                case EXPIRED: return ctx.getString(R.string.island_notif_expired);
                case WAITING: return ctx.getString(R.string.island_notif_waiting);
                case RUNNING: return ctx.getString(R.string.island_notif_running);
                case DONE:    return ctx.getString(R.string.island_notif_done);
                default:      return ctx.getString(R.string.notif_service_text);
            }
        }

        /** 岛上的文字，给诊断页看。 */
        String describe() {
            return state + (left.isEmpty() ? "" : " · " + left) + " · " + right;
        }
    }

    /** 状态变化时的回调。在<b>主线程</b>触发。 */
    interface Sink {
        void onSnapshot(Snapshot s);
    }

    private static final String BLUE = "#4C8DFF";
    private static final String ORANGE = "#F5A524";
    private static final String GREEN = "#2FBF71";
    private static final String RED = "#E5484D";

    private static final long QUESTION_MS = 3000L;
    private static final long SESSIONS_ACTIVE_MS = 5000L;
    private static final long SESSIONS_IDLE_MS = 20000L;
    /** 「已完成」在岛上停留多久。用户定的 8 秒。 */
    private static final long DONE_HOLD_MS = 8000L;
    /** 左边显示会话名前几个字符。用户定的 4 个。 */
    private static final int LEFT_CHARS = 4;
    /**
     * 多久没有一次<b>成功</b>的轮询，就认为手上的数据不可信，把岛收起。
     *
     * <p>没有这道闸的话，电脑一关机、或者手机切走 Wi-Fi，请求会一直失败，
     * 而失败的轮询<b>刻意不清空</b>已采集的状态（否则一次网络抖动就会把"运行中"抹掉）。
     * 两者合起来会让岛永远停在最后一次的旧状态上 —— 用户看到的是一条撒谎的岛。
     * 90 秒足够容忍几次抖动和 Doze 下的延迟。
     */
    private static final long STALE_MS = 90000L;

    /**
     * 最近一次状态的文字描述，供 {@link IslandTestActivity} 读取。
     *
     * <p>服务里的状态 Activity 拿不到，用静态字段最省事 —— 它只用于诊断展示，
     * 没有并发正确性的要求。
     */
    static volatile String lastSummary = "（还没开始轮询）";

    /**
     * 最近一次会话列表的统计，给诊断页看。
     *
     * <p><b>为什么要单独统计子智能体</b>：用户报告"手机镜像看不到子智能体"，但逆向
     * DSH 的 {@code sessionController.list()} 后，源码上<b>没有任何过滤子会话的逻辑</b>
     * （只对"冷会话"要求有 {@code cwd}），而实测两个子智能体会话的 {@code cwd} 都是有值的。
     * 也就是说 —— <b>按源码它们应该会出现</b>。这个计数就是为了在真机上把真相钉死：
     * 如果这里显示"其中子智能体 2 个"，那问题在网页端渲染；如果显示 0，
     * 那问题在 DSH 返回的数据里，得换 {@code listChildren} 那条路。
     */
    static volatile String lastSessionsInfo = "（还没读到会话列表）";

    private final Context ctx;
    private final ServerPrefs prefs;
    private final Sink sink;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private final ExecutorService io = Executors.newSingleThreadExecutor();

    private final AtomicBoolean questionsInFlight = new AtomicBoolean(false);
    private final AtomicBoolean sessionsInFlight = new AtomicBoolean(false);

    // —— 采集到的原始状态。只在主线程读写，避免加锁 ——
    private List<String> waitingIds = Collections.emptyList();
    private List<String> runningIds = Collections.emptyList();
    private final Map<String, String> titles = new HashMap<>();
    private final Set<String> prevRunning = new HashSet<>();

    private long doneUntil = 0L;
    private String doneTitle = "";
    /** 第一轮只记录基线，不判定"刚结束" —— 否则一开 App 就误报「已完成」。 */
    private boolean primed = false;
    private boolean expired = false;
    private boolean sawQuestionBefore = false;
    /** 最近一次<b>成功</b>轮询的时刻。见 {@link #STALE_MS}。 */
    private long lastOkAt = 0L;

    private String lastSignature = "";
    private volatile boolean started = false;

    IslandMonitor(Context ctx, Sink sink) {
        this.ctx = ctx.getApplicationContext();
        this.prefs = new ServerPrefs(ctx);
        this.sink = sink;
    }

    void start() {
        if (started) return;
        started = true;
        // 先算一次初始状态：没登录时轮询会直接返回，不先算的话诊断页会一直停在
        // 「还没开始轮询」，看不出到底是没登录还是轮询坏了。
        recompute();
        ui.post(questionsTick);
        ui.post(sessionsTick);
    }

    void stop() {
        started = false;
        ui.removeCallbacks(questionsTick);
        ui.removeCallbacks(sessionsTick);
        io.shutdownNow();
    }

    // ------------------------------------------------------------------
    // 轮询
    // ------------------------------------------------------------------

    private final Runnable questionsTick = new Runnable() {
        @Override public void run() {
            if (!started) return;
            pollQuestions();
            ui.postDelayed(this, QUESTION_MS);
        }
    };

    private final Runnable sessionsTick = new Runnable() {
        @Override public void run() {
            if (!started) return;
            pollSessions();
            ui.postDelayed(this, isActive() ? SESSIONS_ACTIVE_MS : SESSIONS_IDLE_MS);
        }
    };

    /** 有会话在跑、或有问题在等 —— 决定 `/api/sessions` 用哪个频率。 */
    private boolean isActive() {
        return !runningIds.isEmpty() || !waitingIds.isEmpty();
    }

    private void pollQuestions() {
        final String cookie = prefs.cookie();
        if (cookie.isEmpty()) {
            // 还没登录过（首次安装、或还没在网页里登录）—— 不上岛，也不报错
            return;
        }
        if (!questionsInFlight.compareAndSet(false, true)) return;

        io.execute(() -> {
            final MirrorApi.Reply r = MirrorApi.get(ctx, "/api/questions", cookie);
            final List<String> ids = new ArrayList<>();
            if (r.ok()) {
                try {
                    JSONArray items = new JSONObject(r.body).optJSONArray("items");
                    if (items != null) {
                        for (int i = 0; i < items.length(); i++) {
                            JSONObject q = items.optJSONObject(i);
                            if (q == null) continue;
                            String sid = q.optString("sessionId", "");
                            if (!sid.isEmpty()) ids.add(sid);
                        }
                    }
                } catch (Throwable ignored) {
                    // 解析失败按"没有问题"处理，下一轮重试
                }
            }
            ui.post(() -> {
                questionsInFlight.set(false);
                applyAuth(r);
                if (r.ok()) {
                    waitingIds = ids;
                    // 从"没问题"变成"有问题"时，立刻补一次会话列表 ——
                    // 否则会话名要等到下一个 sessions tick 才拿得到（空闲时最长 20 秒）
                    if (!ids.isEmpty() && !sawQuestionBefore) {
                        sawQuestionBefore = true;
                        ui.removeCallbacks(sessionsTick);
                        ui.post(sessionsTick);
                    } else if (ids.isEmpty()) {
                        sawQuestionBefore = false;
                    }
                }
                recompute();
            });
        });
    }

    private void pollSessions() {
        final String cookie = prefs.cookie();
        if (cookie.isEmpty()) return;
        if (!sessionsInFlight.compareAndSet(false, true)) return;

        io.execute(() -> {
            final MirrorApi.Reply r = MirrorApi.get(ctx, "/api/sessions", cookie);
            final List<String> running = new ArrayList<>();
            final Map<String, String> found = new HashMap<>();
            int total = 0;
            int subs = 0;
            if (r.ok()) {
                try {
                    JSONArray items = new JSONObject(r.body).optJSONArray("items");
                    if (items != null) {
                        for (int i = 0; i < items.length(); i++) {
                            JSONObject it = items.optJSONObject(i);
                            if (it == null) continue;
                            String id = it.optString("id", "");
                            if (id.isEmpty()) continue;
                            total++;
                            if (isSubagent(it)) subs++;
                            String title = it.optString("title", "");
                            if (!title.isEmpty()) found.put(id, title);
                            if (it.optBoolean("running", false)) running.add(id);
                        }
                    }
                } catch (Throwable ignored) {
                }
            }
            final int fTotal = total;
            final int fSubs = subs;
            ui.post(() -> {
                sessionsInFlight.set(false);
                applyAuth(r);
                if (r.ok()) {
                    titles.putAll(found);
                    runningIds = running;
                    detectFinished();
                    lastSessionsInfo = fTotal + " 个会话"
                            + (fSubs > 0
                               ? "，其中子智能体 " + fSubs + " 个"
                               : "，子智能体 0 个（DSH 没返回带 origin=subagent 的项）");
                } else {
                    lastSessionsInfo = "读取失败（code=" + r.code + "）";
                }
                recompute();
            });
        });
    }

    /**
     * 判断一条会话是不是子智能体。
     *
     * <p>两个判据都认：DSH 的摘要在子会话上会带 {@code origin:"subagent"}（实测确认），
     * 以及 {@code parentSessionId}（{@code mirror.js} 的 {@code normalizeSummary()}
     * 会把它原样透传出来）。任一条命中就算 —— 宁可多标，不可漏标。
     */
    private static boolean isSubagent(JSONObject it) {
        if (!it.isNull("origin") && "subagent".equals(it.optString("origin", ""))) return true;
        return !it.isNull("parentSessionId") && !it.optString("parentSessionId", "").isEmpty();
    }

    /**
     * 记录 401 / 从 401 恢复。
     *
     * <p>只在拿到明确结果时改状态：连接失败（{@code code <= 0}）<b>不动</b>它 ——
     * PC 关机、手机切网都会让请求失败，那不是登录失效。
     */
    private void applyAuth(MirrorApi.Reply r) {
        if (r.unauthorized()) expired = true;
        else if (r.ok()) {
            expired = false;
            lastOkAt = System.currentTimeMillis();
        }
    }

    /**
     * 判定"某个会话刚跑完"。
     *
     * <p>做法是记住上一轮在跑的 id 集合，本轮里消失了就算刚结束。
     * <b>第一轮不算</b>（{@link #primed}）—— 否则服务一启动、集合从空变成有，
     * 或从有变成空，都会误报。
     */
    private void detectFinished() {
        Set<String> now = new HashSet<>(runningIds);
        if (primed) {
            for (String id : prevRunning) {
                if (now.contains(id)) continue;
                String t = titles.get(id);
                doneTitle = t == null ? "" : t;
                doneUntil = System.currentTimeMillis() + DONE_HOLD_MS;
                break;   // 一次只报一个，避免多个同时结束时报花
            }
        }
        prevRunning.clear();
        prevRunning.addAll(now);
        primed = true;
    }

    // ------------------------------------------------------------------
    // 状态机
    // ------------------------------------------------------------------

    private void recompute() {
        Snapshot s = new Snapshot();
        long now = System.currentTimeMillis();

        if (expired) {
            s.state = State.EXPIRED;
            s.right = ctx.getString(R.string.island_state_expired);
            s.color = RED;
            s.note = "登录态失效（401）。打开 App 重新登录即可恢复。";
        } else if (lastOkAt == 0 || now - lastOkAt > STALE_MS) {
            // 数据不可信（没登录 / 连不上）—— 一律收岛，绝不让岛显示陈旧状态
            s.state = State.IDLE;
            if (prefs.cookie().isEmpty()) {
                s.note = "未登录（还没在网页里登录过）—— 不上岛";
            } else if (lastOkAt == 0) {
                s.note = "还没成功轮询过 —— 连不上电脑？";
            } else {
                s.note = "连不上电脑（已 " + ((now - lastOkAt) / 1000) + " 秒没有成功轮询）—— 岛收起";
            }
        } else if (!waitingIds.isEmpty()) {
            s.state = State.WAITING;
            s.title = titleOf(waitingIds.get(0));
            s.left = shortTitle(titleOf(waitingIds.get(0)));
            s.right = ctx.getString(R.string.island_state_waiting);
            s.color = ORANGE;
            s.note = "有 " + waitingIds.size() + " 个会话在等你回答";
        } else if (!runningIds.isEmpty()) {
            s.state = State.RUNNING;
            s.title = titleOf(runningIds.get(0));
            s.left = shortTitle(titleOf(runningIds.get(0)));
            s.right = ctx.getString(R.string.island_state_running);
            s.color = BLUE;
            s.note = "有 " + runningIds.size() + " 个会话在运行";
        } else if (System.currentTimeMillis() < doneUntil) {
            s.state = State.DONE;
            s.title = doneTitle;
            s.left = shortTitle(doneTitle);
            s.right = ctx.getString(R.string.island_state_done);
            s.color = GREEN;
            s.note = "会话已完成，绿环保持 " + (DONE_HOLD_MS / 1000) + " 秒";
        } else {
            s.state = State.IDLE;
            s.note = "空闲 —— 岛收起";
        }

        // 标题也进签名：同一个状态换了会话（比如另一个会话开始跑）也要重发，
        // 否则岛上会一直挂着上一个会话的名字。
        String sig = s.state + "|" + s.title + "|" + s.left + "|" + s.right + "|" + s.progress + "|" + s.color;
        lastSummary = s.describe() + "\n      " + s.note
                + (s.title.isEmpty() ? "" : "\n      标题：" + s.title);

        // 状态签名没变就不重发通知。3 秒一次的重发会让通知栏抖，还费电。
        if (sig.equals(lastSignature)) return;
        lastSignature = sig;
        sink.onSnapshot(s);
    }

    private String titleOf(String id) {
        String t = titles.get(id);
        return t == null ? "" : t;
    }

    /**
     * 取前 {@value #LEFT_CHARS} 个<b>字符</b>（不是 char）。
     *
     * <p>用 {@code codePointCount} 而不是 {@code substring} —— 会话标题里可能有 emoji，
     * 按 char 切会把代理对劈成两半，显示成乱码方块。
     */
    private static String shortTitle(String t) {
        if (t == null) return "";
        String s = t.trim();
        if (s.isEmpty()) return "";
        int count = s.codePointCount(0, s.length());
        if (count <= LEFT_CHARS) return s;
        return s.substring(0, s.offsetByCodePoints(0, LEFT_CHARS));
    }
}
