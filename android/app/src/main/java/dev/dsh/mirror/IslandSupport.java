package dev.dsh.mirror;

import android.app.Notification;
import android.content.Context;
import android.graphics.drawable.Icon;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;

import org.json.JSONException;
import org.json.JSONObject;

import java.lang.reflect.Method;
import java.util.Locale;

/**
 * 小米超级岛（焦点通知）支持。
 *
 * <p>键名与 JSON 结构全部来自真实参考实现，不是推测：
 * {@code reference/ABK/app/src/main/java/com/abk/kernel/utils/NotificationUtils.kt}（418 行）。
 * 详见 {@code docs/apk-plan.md} §A3。
 *
 * <p><b>核心约束：超级岛是「通知」的渲染目标，不是界面渲染方式。</b>
 * 所以这里只碰 {@link Notification}，不碰 WebView、不碰网页资源。
 *
 * <p><b>失败安全是硬要求</b>：{@link #attach} 绝不抛异常、绝不丢弃通知。
 * 最坏情况只是系统忽略了那两个 extras —— 通知照常显示。
 */
final class IslandSupport {

    private IslandSupport() {}

    /** {@code notification.extras} 顶层：JSON 字符串，外层单键 {@code param_v2}。 */
    static final String EXTRA_PARAM = "miui.focus.param";
    /** {@code notification.extras} 顶层：Bundle，自定义名 → Icon。 */
    static final String EXTRA_PICS = "miui.focus.pics";

    /** {@code pics} 里的键名；JSON 的 {@code pic} / {@code picDark} 引用它。 */
    private static final String PIC_KEY = "miui.focus.pic_icon";

    /** 系统属性：设备是否支持岛。 */
    private static final String PROP_ISLAND = "persist.sys.feature.island";
    /** 系统设置：焦点通知协议版本。参考实现要求恰好等于 3（只支持 OS3）。 */
    private static final String SETTING_FOCUS_PROTOCOL = "notification_focus_protocol";
    /** 焦点通知权限的 ContentProvider。 */
    private static final String FOCUS_AUTHORITY = "content://miui.statusbar.notification.public";

    /** 参考实现里进度条"未达到"部分的颜色，逐字照抄。 */
    private static final String COLOR_PROGRESS_UNREACHED = "#1A000000";

    // ------------------------------------------------------------------
    // 四个门槛
    // ------------------------------------------------------------------

    /** 门槛 ①：厂商或品牌含 xiaomi / redmi / poco。 */
    static boolean isXiaomiDevice() {
        return brandHit(Build.MANUFACTURER) || brandHit(Build.BRAND);
    }

    private static boolean brandHit(String raw) {
        if (raw == null) return false;
        String s = raw.toLowerCase(Locale.US);
        return s.contains("xiaomi") || s.contains("redmi") || s.contains("poco");
    }

    /**
     * 门槛 ②：反射读 {@code SystemProperties.getBoolean("persist.sys.feature.island")}。
     *
     * <p>用反射是因为 {@code android.os.SystemProperties} 不是公开 API。
     * 任何失败（类不存在、方法签名变了、抛异常）一律返回 false —— 失败安全。
     */
    static boolean hasIslandSystemProperty() {
        Object v = readSystemProperty();
        return v instanceof Boolean && (Boolean) v;
    }

    /** 返回 Boolean（读到了）或 String（读不到的原因），供诊断显示。 */
    static Object readSystemProperty() {
        try {
            Class<?> cls = Class.forName("android.os.SystemProperties");
            Method getBoolean = cls.getMethod("getBoolean", String.class, boolean.class);
            return getBoolean.invoke(null, PROP_ISLAND, false);
        } catch (Throwable t) {
            return t.getClass().getSimpleName() + ": " + t.getMessage();
        }
    }

    /** 门槛 ③：{@code notification_focus_protocol} 的值。读不到返回 -1。 */
    static int focusProtocol(Context ctx) {
        try {
            return Settings.System.getInt(
                    ctx.getContentResolver(), SETTING_FOCUS_PROTOCOL, 0);
        } catch (Throwable t) {
            return -1;
        }
    }

    /**
     * 门槛 ④：运行时按包名裁定「能否上岛」。
     *
     * <p>这不是向小米申请的白名单，是系统按包名裁定的权限。用户需在
     * HyperOS 设置里为本 App 打开「焦点通知」。
     *
     * @return Boolean.TRUE / Boolean.FALSE（查到了），或 String（查询本身失败）
     */
    static Object queryFocusPermission(Context ctx) {
        try {
            Bundle args = new Bundle();
            args.putString("package", ctx.getPackageName());
            Bundle r = ctx.getContentResolver().call(
                    Uri.parse(FOCUS_AUTHORITY), "canShowFocus", null, args);
            if (r == null) return "provider 返回 null";
            return r.getBoolean("canShowFocus", false);
        } catch (Throwable t) {
            return t.getClass().getSimpleName() + ": " + t.getMessage();
        }
    }

    static boolean hasFocusPermission(Context ctx) {
        Object v = queryFocusPermission(ctx);
        return v instanceof Boolean && (Boolean) v;
    }

    /** 四个门槛全过。注意：这只是「应该能上岛」，实际能否渲染仍需真机看。 */
    static boolean canUse(Context ctx) {
        return isXiaomiDevice()
                && hasIslandSystemProperty()
                && focusProtocol(ctx) == 3
                && hasFocusPermission(ctx);
    }

    // ------------------------------------------------------------------
    // JSON
    // ------------------------------------------------------------------

    /**
     * 一次"岛上要显示什么"的完整描述。
     *
     * <p>存在的理由：超级岛的字段语义**没有公开文档**，只能靠真机试。
     * 把差异参数化，就能用一趟装机测多个假设，而不是一个假设装一次。
     *
     * <p>默认值就是"已知能出岛"的那一套（0.1.2 的变体 C / E 验证过），
     * 调用方只改要测的那一个变量。
     */
    static final class Opts {
        String title = "DSH 镜像";
        String content = "";
        /** {@code smallIslandArea.textInfo.title} —— 收起时图标旁边那段文字。 */
        String smallText = "";
        /** {@code hintInfo.title}。 */
        String hintText = "";
        String ticker = "";
        String color = "#4C8DFF";
        /** 进度值。**刻意不夹紧** —— 试哨兵值（如 -1）时要能原样传进去。 */
        int progress = 100;
        /** 是否给 v2 级挂 {@code progressInfo}。 */
        boolean v2Progress = true;
        /** 是否给 {@code bigIslandArea} 挂 {@code progressTextInfo}。 */
        boolean bigProgressText = true;
        /** 是否给 {@code imageTextInfoLeft} 加 {@code textInfo}（左边图标旁能不能带文字）。 */
        boolean leftText = false;
        String leftTextValue = "DSH";
    }

    /**
     * 按 {@link Opts} 构造 {@code miui.focus.param}。
     *
     * <p><b>0.1.1 的教训写在这里</b>：我当初省掉了 {@code progressInfo} /
     * {@code bigIslandArea} / {@code hintInfo} / {@code shareData}，理由是
     * "参考实现带进度条是因为它是编译进度场景，我们没有百分比"。
     * 真机结果是**四门槛全过、通知正常、岛完全不渲染** —— 系统解析 extras 后**静默丢弃**。
     * 0.1.2 补齐全字段后 C 和 E 都出岛了。
     * <b>那些字段不是装饰，是岛渲染的必需输入。</b>
     *
     * <p>字段名与层级逐条对照
     * {@code reference/ABK/.../NotificationUtils.kt:306-382}，并用脚本核对过：
     * <b>35 个字段名、36 条树形路径，双向零差异</b>。
     *
     * @return JSON 字符串；构造失败返回 null（调用方应放弃上岛，但通知照发）
     */
    static String buildParamJsonEx(Opts o) {
        try {
            String t = clip(o.title, 24);
            String body = clip(o.content, 48);
            int p = o.progress;

            JSONObject baseInfo = new JSONObject();
            baseInfo.put("type", 1);
            baseInfo.put("title", t);
            baseInfo.put("content", body);
            baseInfo.put("colorTitle", o.color);

            JSONObject picInfo = new JSONObject();
            picInfo.put("type", 1);
            picInfo.put("pic", PIC_KEY);
            picInfo.put("picDark", PIC_KEY);

            JSONObject smallTextInfo = new JSONObject();
            smallTextInfo.put("title", clip(o.smallText, 24));
            smallTextInfo.put("narrowFont", true);
            smallTextInfo.put("showHighlightColor", false);

            JSONObject bigIslandIconInfo = new JSONObject();
            bigIslandIconInfo.put("type", 1);
            bigIslandIconInfo.put("picInfo", picInfo);
            if (o.leftText) {
                // 实验：imageTextInfoLeft 名字里带 "Text"，
                // 但参考实现只放了 picInfo。这里试它能不能同时带文字。
                JSONObject leftTextInfo = new JSONObject();
                leftTextInfo.put("title", clip(o.leftTextValue, 24));
                leftTextInfo.put("narrowFont", true);
                leftTextInfo.put("showHighlightColor", false);
                bigIslandIconInfo.put("textInfo", leftTextInfo);
            }

            JSONObject bigIslandArea = new JSONObject();
            bigIslandArea.put("imageTextInfoLeft", bigIslandIconInfo);
            if (o.bigProgressText) {
                JSONObject barInfo = new JSONObject();
                barInfo.put("progress", p);
                barInfo.put("colorReach", o.color);
                barInfo.put("colorUnReach", COLOR_PROGRESS_UNREACHED);

                JSONObject progressTextInfo = new JSONObject();
                progressTextInfo.put("progressInfo", barInfo);
                progressTextInfo.put("textInfo", smallTextInfo);
                bigIslandArea.put("progressTextInfo", progressTextInfo);
            }

            JSONObject smallIslandArea = new JSONObject();
            smallIslandArea.put("picInfo", picInfo);
            smallIslandArea.put("textInfo", smallTextInfo);

            JSONObject shareData = new JSONObject();
            shareData.put("title", t);

            JSONObject paramIsland = new JSONObject();
            paramIsland.put("islandProperty", 1);
            paramIsland.put("highlightColor", o.color);
            paramIsland.put("bigIslandArea", bigIslandArea);
            paramIsland.put("smallIslandArea", smallIslandArea);
            paramIsland.put("shareData", shareData);

            JSONObject hintInfo = new JSONObject();
            hintInfo.put("type", 1);
            hintInfo.put("title", clip(o.hintText, 24));

            JSONObject v2 = new JSONObject();
            v2.put("protocol", 1);
            v2.put("business", "dsh-mirror");
            v2.put("islandFirstFloat", false);
            v2.put("enableFloat", false);
            v2.put("updatable", true);
            v2.put("filterWhenNoPermission", false);
            v2.put("ticker", clip(o.ticker, 32));
            v2.put("aodTitle", t);
            v2.put("baseInfo", baseInfo);
            v2.put("param_island", paramIsland);
            if (o.v2Progress) {
                JSONObject progressInfo = new JSONObject();
                progressInfo.put("progress", p);
                progressInfo.put("colorProgress", o.color);
                progressInfo.put("colorProgressEnd", o.color);
                v2.put("progressInfo", progressInfo);
            }
            v2.put("hintInfo", hintInfo);

            JSONObject root = new JSONObject();
            root.put("param_v2", v2);
            return root.toString();
        } catch (JSONException e) {
            return null;
        }
    }

    /**
     * 折叠空白后截断；超出加 {@code ...}。
     *
     * <p>逐字对齐参考实现的 {@code cleanIslandText}：
     * {@code trim().replace(Regex("\\s+"), " ")}，超长则取 {@code maxLength - 3} 个字符、
     * <b>去掉尾部空白</b>再加 {@code ...}。
     * 那个 {@code trimEnd} 不是可选项 —— 少了它会产出 {@code "abc ..."} 这种双空格。
     */
    private static String clip(String s, int max) {
        if (s == null) return "";
        String cleaned = s.trim().replaceAll("\\s+", " ");
        if (cleaned.length() <= max) return cleaned;

        int take = Math.min(Math.max(1, max - 3), cleaned.length());
        int end = take;
        while (end > 0 && Character.isWhitespace(cleaned.charAt(end - 1))) end--;
        return cleaned.substring(0, end) + "...";
    }

    // ------------------------------------------------------------------
    // 附加 extras
    // ------------------------------------------------------------------

    /**
     * 给已构建好的通知挂上岛 extras。
     *
     * <p><b>必须在 {@code builder.build()} 之后调用</b> —— 参考实现就是直接改
     * {@code notification.extras} 的顶层。
     *
     * <p><b>这里刻意不检查四个门槛</b>，参考实现是 {@code if (!canUse) return}。两个理由：
     *
     * <ol>
     *   <li>验证阶段需要区分"门槛不过"和"JSON 不对" —— 提前 return 会让后者失去信息。</li>
     *   <li>更要紧的是：四个门槛是从第三方实现反推的**启发式**。只要其中任何一条是
     *       误判（比如小米改了属性名），加门槛就会把**本来能用**的岛静默关掉；
     *       不加门槛则最坏只是多挂两个被系统忽略的 extras。收益不对称。</li>
     * </ol>
     *
     * @return true = extras 已挂上；false = 挂载本身失败（不影响通知正常显示）
     */
    static boolean attach(Context ctx, Notification n, String json) {
        return attach(ctx, n, json, R.drawable.ic_notification);
    }

    /**
     * 同 {@link #attach(Context, Notification, String)}，但可指定岛图标资源。
     *
     * <p>验证变体 C 需要换成 {@code R.mipmap.ic_launcher} —— 参考实现用的就是这个
     * （{@code NotificationUtils.kt:262}）。我们第一版用的是自己的 vector drawable，
     * 这一条也在嫌疑名单上。
     */
    static boolean attach(Context ctx, Notification n, String json, int islandIconRes) {
        if (ctx == null || n == null || n.extras == null) return false;
        if (json == null || json.isEmpty()) return false;
        try {
            n.extras.putString(EXTRA_PARAM, json);

            Bundle pics = new Bundle();
            pics.putParcelable(PIC_KEY, Icon.createWithResource(ctx, islandIconRes));
            n.extras.putBundle(EXTRA_PICS, pics);
            return true;
        } catch (Throwable t) {
            // 挂 extras 失败绝不能影响通知本身
            return false;
        }
    }

    // ------------------------------------------------------------------
    // 诊断报告
    // ------------------------------------------------------------------

    /** 一次诊断的完整快照。字段都是原始的，报告里不做判断，方便直接粘回来。 */
    static final class Report {
        boolean xiaomi;
        String manufacturer = "";
        String brand = "";
        Object prop;
        int protocol;
        Object focus;
        boolean notifGranted;
        String channelUsed = "";

        boolean passProp() { return prop instanceof Boolean && (Boolean) prop; }
        boolean passProtocol() { return protocol == 3; }
        boolean passFocus() { return focus instanceof Boolean && (Boolean) focus; }

        boolean canUse() {
            return xiaomi && passProp() && passProtocol() && passFocus();
        }

        String toText() {
            StringBuilder sb = new StringBuilder();
            sb.append("DSH 镜像 · 超级岛诊断\n");
            sb.append("Android ").append(Build.VERSION.RELEASE)
              .append(" (API ").append(Build.VERSION.SDK_INT).append(")\n");
            sb.append("──────────────────\n");
            sb.append(mark(xiaomi)).append(" ① 厂商/品牌\n");
            sb.append("      MANUFACTURER=").append(manufacturer)
              .append("  BRAND=").append(brand).append('\n');
            sb.append(mark(passProp())).append(" ② 系统属性 ").append(PROP_ISLAND).append('\n');
            sb.append("      读到：").append(prop).append('\n');
            sb.append(mark(passProtocol())).append(" ③ 焦点协议 ").append(SETTING_FOCUS_PROTOCOL).append('\n');
            sb.append("      读到：").append(protocol < 0 ? "读不到" : String.valueOf(protocol))
              .append("   （需要 = 3，即 OS3 协议）\n");
            sb.append(mark(passFocus())).append(" ④ 焦点通知权限 canShowFocus\n");
            sb.append("      读到：").append(focus).append('\n');
            sb.append("──────────────────\n");
            sb.append(mark(notifGranted)).append(" 通知权限 POST_NOTIFICATIONS\n");
            sb.append("      测试用渠道：").append(channelUsed).append('\n');
            sb.append("──────────────────\n");
            sb.append("四门槛结论：").append(canUse() ? "全过（应该能上岛）" : "有未通过项").append('\n');
            sb.append(hint());
            return sb.toString();
        }

        private String hint() {
            if (!xiaomi) return "→ 非小米/红米/POCO 设备，岛不可用。\n";
            if (!passProp()) return "→ 系统属性未开启：这台设备的系统不支持岛。\n";
            if (!passProtocol()) {
                return "→ 协议不是 3：本实现只支持 OS3 协议。"
                        + "若是 HyperOS 1/2，需要另找旧协议格式。\n";
            }
            if (!passFocus()) {
                return "→ 缺「焦点通知」权限：去 系统设置 → 通知 → 本应用 → 打开「焦点通知」。\n";
            }
            if (!notifGranted) return "→ 四门槛全过，但通知权限没给，通知发不出来。\n";
            return "→ 四门槛全过。若岛仍不出现，问题在 JSON 结构（见下方说明）。\n";
        }

        private static String mark(boolean ok) { return ok ? "[✓]" : "[✗]"; }
    }

    /** 采集一次诊断快照。 */
    static Report diagnose(Context ctx) {
        Report r = new Report();
        r.manufacturer = String.valueOf(Build.MANUFACTURER);
        r.brand = String.valueOf(Build.BRAND);
        r.xiaomi = isXiaomiDevice();
        r.prop = readSystemProperty();
        r.protocol = focusProtocol(ctx);
        r.focus = queryFocusPermission(ctx);
        r.notifGranted = notificationsEnabled(ctx);
        return r;
    }

    /**
     * 通知总开关是否打开。
     *
     * <p>用平台的 {@code NotificationManager.areNotificationsEnabled()}（API 24+），
     * 不用 AndroidX 的 {@code NotificationManagerCompat} —— 本工程零依赖。
     */
    static boolean notificationsEnabled(Context ctx) {
        try {
            android.app.NotificationManager nm =
                    ctx.getSystemService(android.app.NotificationManager.class);
            return nm != null && nm.areNotificationsEnabled();
        } catch (Throwable t) {
            return false;
        }
    }
}
