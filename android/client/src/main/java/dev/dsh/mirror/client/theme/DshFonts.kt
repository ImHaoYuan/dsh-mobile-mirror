package dev.dsh.mirror.client.theme

import android.content.Context
import android.graphics.Typeface
import android.graphics.fonts.Font as PlatformFont
import android.graphics.fonts.FontFamily as PlatformFontFamily
import android.net.Uri
import android.os.Build
import androidx.compose.runtime.Composable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import dev.dsh.mirror.client.R
import java.io.File

/** 一档字体的来源。 */
enum class FontChoice { Builtin, System, Custom }

/** 一档字体的设置；{@code file} 只在 {@link FontChoice#Custom} 时有意义。 */
data class FontSlot(val choice: FontChoice = FontChoice.Builtin, val file: String? = null)

/** 三档字体设置（用户可改，存在 SharedPreferences 里）。 */
data class FontPrefs(
    val ui: FontSlot = FontSlot(),
    val body: FontSlot = FontSlot(),
    val mono: FontSlot = FontSlot(),
)

/**
 * 三档最终产物：Compose 直接可用的字体族。
 *
 * <p>粗体**单独一档**：链式字体族（{@code CustomFallbackBuilder}）只有一个字面，
 * 自带不了粗体字面，而 Android 的合成粗体在它上面不生效 —— 所以粗体必须由调用点显式选用。
 */
data class FontSet(
    val ui: FontFamily,
    val uiBold: FontFamily,
    val body: FontFamily,
    val bodyBold: FontFamily,
    val mono: FontFamily,
) {
    companion object {
        /** CompositionLocal 的兜底值：不碰 Context，纯静态。 */
        val Fallback = FontSet(
            FontFamily.SansSerif, FontFamily.SansSerif,
            FontFamily.SansSerif, FontFamily.SansSerif,
            FontFamily.Monospace,
        )
    }
}

/** 当前生效的字体。任何 composable 都能取，不必层层传参。 */
val LocalDshFonts = staticCompositionLocalOf { FontSet.Fallback }

/**
 * 字体：三档（界面 / 正文 / 等宽），每档都能选 内置 / 系统 / 自定义文件。
 *
 * <p>**为什么要自建 fallback 链**：用户要的是「英文走 JetBrains Mono、中文走另一个字体」。
 * Compose 的 FontFamily **不会**按语种挑字体 —— 一个 FontFamily 里塞多个字体，它只按**字重**挑，
 * 缺字就直接落到系统字体。要让这件事真的成立，只能用 {@code Typeface.CustomFallbackBuilder}
 * 把「拉丁打底 + 中文兜底 + 系统兜底」串成一条链。
 *
 * <p>这条路经的 API 全部是 **API 29**（正好等于 minSdk，已在 {@code api-versions.xml} 里核对）：
 * {@code CustomFallbackBuilder(android.graphics.fonts.FontFamily)}、
 * {@code Font.Builder(Resources, int)}、{@code Font.Builder(File)}。所以不需要任何版本分支，
 * 也不需要反射去够那些在旧 SDK 里才公开的重载。
 *
 * <p>**粗体从哪来**：链式字体族只有一个字面，而 **Android 的合成粗体在这条链上不生效** ——
 * 用户报的「Markdown 粗体看不出来」就是这个。所以每档的粗体必须是一条指向**真粗体字面**的链；
 * Compose 1.7 又没有 {@code Font(typeface, weight)} 重载，只能由调用点显式换族
 * （{@code FontSet.uiBold} / {@code bodyBold}）。两条真粗体的来源不同：
 * <ul>
 *   <li>拉丁：JBM 自带 Regular / Bold 两个字面，直接用。</li>
 *   <li>中文：**思源黑体是可变字体**（{@code wght 100–900}），用
 *       {@code Font.Builder.setFontVariationSettings("'wght' 700")} 现取一个真 700 —— 不额外占体积。
 *       顺带把正常档钉在 400：它的默认实例是 {@code wght=100}（Thin），不钉就偏细。</li>
 *   <li>得意黑（界面档的中文）**只有一个字面**，造不出真粗体。0.10.2 试过轮廓外扩硬造，
 *       笔画直接糊成一团（用户反馈），0.10.3 放弃：界面档的粗体与正常是同一个字面，
 *       回到 0.10.1 的观感。</li>
 * </ul>
 */
object DshFonts {

    fun build(ctx: Context, prefs: FontPrefs): FontSet {
        // 界面：拉丁 JetBrains Mono，中文得意黑（单字面，粗体也只能是它 —— 见类注释）
        val ui = chain(ctx, prefs.ui, R.font.smiley_sans_oblique, R.font.smiley_sans_oblique)
        // 正文：拉丁 JetBrains Mono，中文思源黑体（可变字体：400 正常 / 700 真粗体）
        val body = chain(
            ctx, prefs.body, R.font.noto_sans_sc, R.font.noto_sans_sc,
            wght = 400, boldWght = 700,
        )
        return FontSet(ui.normal, ui.bold, body.normal, body.bold, mono(ctx, prefs.mono))
    }

    /** 一档字体的正常与粗体两条族。 */
    private class Chain(val normal: FontFamily, val bold: FontFamily)

    /**
     * 拉丁打底 + 中文兜底 + 系统兜底，正常与粗体各拼一条。
     *
     * <p>为什么要显式给粗体族：这条链是 {@code CustomFallbackBuilder} 拼出来的**单个字面**，
     * 合成粗体在自定义族上不生效 —— 用户报的「Markdown 粗体看不出来」就是它。
     * Compose 1.7 没有 {@code Font(typeface, weight)} 重载，粗体只能由调用点显式换族。
     *
     * @param wght 中文正常档的 {@code wght} 轴（可变字体才有意义，静态字体传 null）。
     * @param boldWght 中文粗体档的 {@code wght} 轴。
     */
    private fun chain(
        ctx: Context,
        slot: FontSlot,
        builtinCjk: Int,
        builtinCjkBold: Int,
        wght: Int? = null,
        boldWght: Int? = null,
    ): Chain {
        when (slot.choice) {
            // 「系统」直接交给 Compose 的 SansSerif：系统字体自带全套语种回落，
            // 再套一层自建链只会把系统的回落顺序弄丢
            FontChoice.System -> return Chain(FontFamily.SansSerif, FontFamily.SansSerif)
            // 用户导入的字体只有一个字面，运行时造不出粗体 —— 粗体退回同一条
            FontChoice.Custom -> {
                val one = chainOf(listOfNotNull(customFamily(ctx, slot.file))) ?: return Chain(
                    FontFamily.SansSerif, FontFamily.SansSerif,
                )
                val fam = FontFamily(one)
                return Chain(fam, fam)
            }
            FontChoice.Builtin -> Unit
        }
        val normal = chainOf(
            listOfNotNull(resFamily(ctx, R.font.jbm_regular), resFamily(ctx, builtinCjk, wght)),
        )
        val bold = chainOf(
            listOfNotNull(resFamily(ctx, R.font.jbm_bold), resFamily(ctx, builtinCjkBold, boldWght)),
        )
        val n = normal?.let { FontFamily(it) } ?: FontFamily.SansSerif
        val b = bold?.let { FontFamily(it) } ?: n
        return Chain(n, b)
    }

    /** 拼一条「拉丁打底 + 中文兜底 + emoji 兜底 + 系统兜底」的链，返回底层 Typeface。 */
    private fun chainOf(families: List<PlatformFontFamily>): Typeface? {
        if (families.isEmpty()) return null
        return runCatching {
            val builder = Typeface.CustomFallbackBuilder(families.first())
            for (i in 1 until families.size) builder.addCustomFallback(families[i])
            // emoji 必须显式挂上，理由见 emojiFamily()
            emojiFamily()?.let { builder.addCustomFallback(it) }
            builder.setSystemFallback("sans-serif")
            builder.build()
        }.getOrNull()
    }

    /**
     * 系统里那个**彩色 emoji 字体族**（0.15.2）。
     *
     * <p>为什么非挂不可：{@code CustomFallbackBuilder} 只会用「自己 addCustomFallback 进来的族」
     * 加最后 {@code setSystemFallback} 指定的那一个族名，而 Android 的彩色 emoji 是**单独一个族**
     * （系统 fonts.xml 里的 {@code emoji}）—— 只给 {@code "sans-serif"} 是**拿不到它的**：
     * 用户报的「消息里的 ✅ 在手机上是一片黑色马赛克」就是这么来的（缺字形）。
     *
     * <p>做法上不往包里塞字体：直接问系统要那个字体文件（{@code SystemFonts.getAvailableFonts()}，
     * API 29+ —— 客户端 minSdk 正好是 29）。想塞的话 Noto Color Emoji 要 ~10 MB，还得在
     * 开源许可里补一条 OFL，代价完全不成比例。
     *
     * <p>**认文件、不认族名**：{@code android.graphics.fonts.Font} 只暴露文件 / 字重 / 变体轴，
     * 没有族名（我第一版写了 {@code familyName}，编译期直接 Unresolved）。
     * 系统自带的彩色 emoji 字体文件名都含 "moji"：{@code NotoColorEmoji.ttf}、
     * {@code NotoColorEmojiLegacy.ttf}，小米这边是 MIUIEmoji / XiaomiEmoji 一类。
     *
     * @return 找到了就返回那个族；**找不到（或系统版本低）返回 null**，此时行为与 0.15.1 一致
     *         （即：宁可没有 emoji，也不能因为找不到而崩或整个字体链失效）。
     */
    private fun emojiFamily(): PlatformFontFamily? {
        val f = emojiFontFile() ?: return null
        return runCatching { PlatformFontFamily.Builder(f).build() }.getOrNull()
    }

    /**
     * 挑出那个**彩色** emoji 字体文件（0.15.7：修「又变回黑块」）。
     *
     * <p>0.15.2 的第一版只写了 {@code firstOrNull { 名字含 "moji" }}，这在有的系统上会**挑错**：
     * 黑白老字体 {@code NotoEmoji-Regular.ttf} 的名字里同样含 "moji"，而
     * {@code SystemFonts.getAvailableFonts()} 的返回顺序**没有任何保证** —— 挑到黑白那条，
     * 用户看到的就是又一次「黑色马赛克」。所以改成**按颜色优先排序后取第一个**：
     *
     * <ol>
     *   <li>名字含 {@code color}：{@code NotoColorEmoji.ttf} / {@code ColorEmoji.ttf} / MIUI 那类；</li>
     *   <li>其它含 {@code emoji} / {@code moji} 的；</li>
     *   <li>最后才是 {@code NotoEmoji-*} 这种黑白兜底。</li>
     * </ol>
     *
     * <p>再兜一层「直接扫 {@code /system/fonts} 目录」：极少数系统不把它登记进
     * {@code SystemFonts}（或登记的条目拿不到文件），按文件名扫目录仍能找到。
     *
     * @return 找到的字体；都找不到返回 {@code null}（行为与 0.15.1 相同：没有 emoji 而已，不崩）。
     */
    private fun emojiFontFile(): PlatformFont? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return null
        val listed = runCatching {
            android.graphics.fonts.SystemFonts.getAvailableFonts()
                .filter { matchesEmojiName(it.file?.name) }
                .minByOrNull { emojiRank(it.file?.name) }
        }.getOrNull()
        if (listed != null) return listed
        return runCatching {
            File("/system/fonts").listFiles()
                ?.filter { matchesEmojiName(it.name) }
                ?.minByOrNull { emojiRank(it.name) }
                ?.let { PlatformFont.Builder(it).build() }
        }.getOrNull()
    }

    /** 名字像不像 emoji 字体。 */
    private fun matchesEmojiName(name: String?): Boolean = name != null &&
        (name.contains("emoji", ignoreCase = true) || name.contains("moji", ignoreCase = true))

    /** 越小越优先：彩色 &gt; 名字普通 &gt; 黑白老字体（见 [emojiFontFile]）。 */
    private fun emojiRank(name: String?): Int {
        val n = name.orEmpty().lowercase()
        return when {
            n.contains("color") -> 0
            n.contains("notoemoji") -> 2
            else -> 1
        }
    }

    /**
     * 「emoji 兜底到底挑中了谁」—— 字体面板里那行小字用它自证（0.15.7 临时加的，诊断完就删）。
     *
     * <p>为什么要它：这条 bug 只在你手机上能看见，而我读不了截图。把 App 实际挑中的文件名
     * 显示出来，一眼就能分清是「没找到彩色 emoji 字体」还是「找到了但没生效」。
     */
    fun emojiFontName(): String? = emojiFontFile()?.file?.name

    /**
     * 把一个字体资源包成平台字体族。
     *
     * <p>{@code wght} 非空时用 {@code Font.Builder.setFontVariationSettings} 取**可变字体的某个字重**：
     * 思源黑体的默认实例是 {@code wght=100}（Thin），不指定就偏细；真粗体也只能这么取
     * （造一个静态字面要多花 14 MB）。静态字体传 null，走原样。
     */
    private fun resFamily(ctx: Context, id: Int, wght: Int? = null): PlatformFontFamily? {
        val font = runCatching {
            val b = PlatformFont.Builder(ctx.resources, id)
            if (wght != null) b.setFontVariationSettings("'wght' " + wght)
            b.build()
        }.getOrNull() ?: return null
        return runCatching { PlatformFontFamily.Builder(font).build() }.getOrNull()
    }

    private fun customFamily(ctx: Context, name: String?): PlatformFontFamily? {
        val f = customFile(ctx, name) ?: return null
        return runCatching { PlatformFontFamily.Builder(PlatformFont.Builder(f).build()).build() }.getOrNull()
    }

    private fun mono(ctx: Context, slot: FontSlot): FontFamily = when (slot.choice) {
        FontChoice.Builtin -> FontFamily(
            Font(R.font.jbm_regular, FontWeight.Normal),
            Font(R.font.jbm_semibold, FontWeight.SemiBold),
            Font(R.font.jbm_bold, FontWeight.Bold),
        )
        FontChoice.System -> FontFamily.Monospace
        FontChoice.Custom -> customFile(ctx, slot.file)
            ?.let { f -> runCatching { FontFamily(Font(f)) }.getOrNull() }
            ?: FontFamily.Monospace
    }

    private fun customFile(ctx: Context, name: String?): File? {
        if (name.isNullOrEmpty()) return null
        val f = File(DshFontStore.dir(ctx), name)
        return if (f.isFile && f.length() > 0L) f else null
    }
}

/** 字体设置与用户导入的字体文件。 */
object DshFontStore {

    private const val PREFS = "dsh_mm_fonts"
    private const val KEY_UI = "ui"
    private const val KEY_BODY = "body"
    private const val KEY_MONO = "mono"
    private const val DIR = "fonts"

    fun load(ctx: Context): FontPrefs {
        val sp = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        return FontPrefs(
            ui = read(sp.getString(KEY_UI, null)),
            body = read(sp.getString(KEY_BODY, null)),
            mono = read(sp.getString(KEY_MONO, null)),
        )
    }

    fun save(ctx: Context, prefs: FontPrefs) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString(KEY_UI, write(prefs.ui))
            .putString(KEY_BODY, write(prefs.body))
            .putString(KEY_MONO, write(prefs.mono))
            .apply()
    }

    private fun read(v: String?): FontSlot = when {
        v == "system" -> FontSlot(FontChoice.System)
        v != null && v.startsWith("file:") -> FontSlot(FontChoice.Custom, v.removePrefix("file:"))
        else -> FontSlot(FontChoice.Builtin)
    }

    private fun write(s: FontSlot): String = when (s.choice) {
        FontChoice.Builtin -> "builtin"
        FontChoice.System -> "system"
        FontChoice.Custom -> "file:" + (s.file ?: "")
    }

    /** 用户导入字体的存放目录（App 私有，卸载即清）。 */
    fun dir(ctx: Context): File = File(ctx.filesDir, DIR).apply { if (!exists()) mkdirs() }

    /**
     * 把用户挑的文件复制进私有目录，**当场校验能不能当字体用**。
     *
     * <p>选到非字体文件、或者 Android 吃不下的格式（例如 TTC 字体集合），这里立刻就发现：
     * 删掉副本、回 null，界面上一句「这个文件读不出字体」就完了 ——
     * 总好过让用户回头发现「选了但没生效」。
     */
    fun import(ctx: Context, uri: Uri): String? {
        val name = "custom-" + System.currentTimeMillis() + ext(ctx, uri)
        val out = File(dir(ctx), name)
        return try {
            val input = ctx.contentResolver.openInputStream(uri) ?: return null
            input.use { src -> out.outputStream().use { dst -> src.copyTo(dst) } }
            Typeface.Builder(out).build()
            name
        } catch (t: Throwable) {
            runCatching { out.delete() }
            null
        }
    }

    /** 删掉一个导入的字体文件（面板的「删除」与「恢复默认」用）。 */
    fun delete(ctx: Context, name: String) {
        if (name.isNotEmpty()) runCatching { File(dir(ctx), name).delete() }
    }

    private fun ext(ctx: Context, uri: Uri): String =
        if ((ctx.contentResolver.getType(uri) ?: "").contains("otf")) ".otf" else ".ttf"
}
