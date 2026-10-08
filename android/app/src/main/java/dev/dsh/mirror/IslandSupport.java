package dev.dsh.mirror;

import android.app.Notification;
import android.content.Context;
import android.graphics.drawable.Icon;

import android.os.Bundle;

import org.json.JSONException;
import org.json.JSONObject;

/**
 * 小米超级岛（焦点通知）支持。
 *
 * <p><b>这里取的是「接口事实」，不是别人的代码。</b> 两个 extras 的键名、{@code param_v2}
 * 的字段名与层级，都是 HyperOS 焦点通知的接口本身 —— 任何想上岛的实现都得写成同一套键名，
 * 写错系统就静默丢弃。这套键名的公开出处是第三方开源项目 ABK
 * （https://github.com/xingguangcuican6666/ABK，GPL-3.0）的
 * {@code app/src/main/java/com/abk/kernel/utils/NotificationUtils.kt}：本项目**只核对了
 * 键名与层级这类事实**，实现是独立编写的 Java，未使用其代码。
 * 协议整理与逐条出处见 {@code docs/apk-plan.md} §A3，许可声明见仓库根目录
 * {@code THIRD_PARTY_NOTICES.md}。
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

    /**
     * 进度环"未达到"那一段的轨道色：半透明黑。
     *
     * <p>纯外观取值，本项目自己定的 —— 环只来自 {@code bigIslandArea.progressTextInfo}
     * 里的确定值进度弧，而 {@link IslandMonitor} 的进度恒为满格，这一段宽度为 0、
     * 实际不可见。留一个合理值只为字段齐全（字段缺了系统会整条丢弃）。
     */
    private static final String COLOR_PROGRESS_UNREACHED = "#24000000";

    // ------------------------------------------------------------------
    // JSON
    // ------------------------------------------------------------------

    /**
     * 一次"岛上要显示什么"的完整描述。
     *
     * <p>存在的理由：超级岛的字段语义**没有公开文档**，只能靠真机试。
     * 把差异参数化，就能用一趟装机测多个假设，而不是一个假设装一次。
     *
     * <p>默认值就是"已知能出岛"的那一套（真机验证过），调用方只改要改的那一个字段。
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
     * <p>字段名与层级逐条对照 ABK 的 {@code NotificationUtils.kt:306-382}（只核这类接口事实），
     * 并用脚本核对过：
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

    /** 截断后缀。3 个 ASCII 点，保持系统侧已习惯的显示宽度。 */
    private static final String TAIL = "...";

    /**
     * 折叠空白 + 截断，一趟扫描做完；超长时用 {@code ...} 收尾。
     *
     * <p>规则：连续空白折成一个空格、首尾空白丢掉；折完不超过 {@code max} 就原样返回；
     * 否则正文只留 {@code max - 3} 个字符（长度按 UTF-16 计，与系统侧上限同口径），
     * 去掉截断处的尾随空格，再接 {@code ...}。
     *
     * <p>边扫边写、不造中间字符串：省一次分配，也顺带保证切点不会落在代理对中间
     * （会话标题里的 emoji 不会被劈成半个字符）。空白只有在后面确实还跟着非空白时
     * 才落笔，所以结果永远不会带尾随空格。
     *
     * @param max 含 {@code ...} 在内的上限；小于 1 时按 1 处理
     */
    private static String clip(String s, int max) {
        if (s == null) return "";
        int budget = Math.max(1, max);

        StringBuilder out = new StringBuilder(Math.min(budget, s.length()));
        boolean pendingSpace = false;
        boolean clipped = false;

        for (int i = 0; i < s.length(); ) {
            int cp = s.codePointAt(i);
            i += Character.charCount(cp);

            if (Character.isWhitespace(cp)) {
                pendingSpace = out.length() > 0;
                continue;
            }
            int width = Character.charCount(cp);
            int need = (pendingSpace ? 1 : 0) + width;
            if (out.length() + need > budget) {
                clipped = true;
                break;
            }
            if (pendingSpace) out.append(' ');
            pendingSpace = false;
            out.appendCodePoint(cp);
        }
        if (!clipped) return out.toString();

        // 超长：正文额度收紧到 budget - TAIL.length()，别切在半个代理对上
        out.setLength(Math.max(0, budget - TAIL.length()));
        while (out.length() > 0 && out.charAt(out.length() - 1) == ' ') {
            out.setLength(out.length() - 1);
        }
        if (out.length() > 0 && Character.isHighSurrogate(out.charAt(out.length() - 1))) {
            out.setLength(out.length() - 1);
        }
        return out.append(TAIL).toString();
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
     *   <li>区分"门槛不过"和"JSON 不对"要靠人看日志 —— 提前 return 会让后者失去信息。</li>
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
     * <p>实际调用方传的是 {@code R.mipmap.ic_launcher} —— 参考实现用的就是这个
     * （{@code NotificationUtils.kt:262}），且真机验证过它能完整显示。
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

}
