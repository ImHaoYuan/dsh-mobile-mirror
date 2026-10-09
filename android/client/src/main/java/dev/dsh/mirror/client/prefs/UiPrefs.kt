package dev.dsh.mirror.client.prefs

import android.content.Context

/**
 * 界面偏好。
 *
 * <p>0.9.3 只有一个键：「显示详细工作过程」。关（默认）时，会话里的「工作过程」折叠卡
 * 每一步只显示简短解释（`run_code` 参数里的 description），工具名与参数都藏起来；
 * 打开后显示「工具名 + 完整参数」，用来排查它到底跑了什么。
 *
 * <p>用独立的 SharedPreferences 文件，和字体设置互不影响。
 */
object UiPrefs {
    private const val FILE = "dsh_mm_ui"
    private const val KEY_DETAIL = "detail_work"

    fun detailWork(ctx: Context): Boolean = sp(ctx).getBoolean(KEY_DETAIL, false)

    fun setDetailWork(ctx: Context, on: Boolean) {
        sp(ctx).edit().putBoolean(KEY_DETAIL, on).apply()
    }

    private fun sp(ctx: Context) = ctx.getSharedPreferences(FILE, Context.MODE_PRIVATE)
}
