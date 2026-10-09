package dev.dsh.mirror.client.theme

import android.content.Context
import android.graphics.Typeface
import android.graphics.fonts.Font as PlatformFont
import android.graphics.fonts.FontFamily as PlatformFontFamily
import android.net.Uri
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

/** 三档最终产物：Compose 直接可用的字体族。 */
data class FontSet(val ui: FontFamily, val body: FontFamily, val mono: FontFamily) {
    companion object {
        /** CompositionLocal 的兜底值：不碰 Context，纯静态。 */
        val Fallback = FontSet(FontFamily.SansSerif, FontFamily.SansSerif, FontFamily.Monospace)
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
 * <p>代价：链式字体族只有一个字面，**粗体是 Android 合成的**。等宽档是纯拉丁场景，
 * 走 {@code FontFamily(Font(...))} 的多字面，那里是**真字重**。
 */
object DshFonts {

    fun build(ctx: Context, prefs: FontPrefs): FontSet = FontSet(
        // 界面：拉丁 JetBrains Mono，中文得意黑
        ui = chain(ctx, prefs.ui, R.font.smiley_sans_oblique),
        // 正文：拉丁 JetBrains Mono，中文思源黑体
        body = chain(ctx, prefs.body, R.font.noto_sans_sc),
        mono = mono(ctx, prefs.mono),
    )

    /** 拉丁打底 + 中文兜底 + 系统兜底。 */
    private fun chain(ctx: Context, slot: FontSlot, builtinCjk: Int): FontFamily {
        when (slot.choice) {
            // 「系统」直接交给 Compose 的 SansSerif：系统字体自带全套语种回落，
            // 再套一层自建链只会把系统的回落顺序弄丢
            FontChoice.System -> return FontFamily.SansSerif
            FontChoice.Custom -> customFamily(ctx, slot.file)?.let { return chainOf(listOf(it)) }
            FontChoice.Builtin -> Unit
        }
        val builtin = listOfNotNull(resFamily(ctx, R.font.jbm_regular), resFamily(ctx, builtinCjk))
        return if (builtin.isEmpty()) FontFamily.SansSerif else chainOf(builtin)
    }

    private fun chainOf(families: List<PlatformFontFamily>): FontFamily = runCatching {
        val builder = Typeface.CustomFallbackBuilder(families.first())
        for (i in 1 until families.size) builder.addCustomFallback(families[i])
        builder.setSystemFallback("sans-serif")
        FontFamily(builder.build())
    }.getOrDefault(FontFamily.SansSerif)

    private fun resFamily(ctx: Context, id: Int): PlatformFontFamily? = runCatching {
        PlatformFontFamily.Builder(PlatformFont.Builder(ctx.resources, id).build()).build()
    }.getOrNull()

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
