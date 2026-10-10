package dsh.mirror.client.prefs

import android.content.Context

/**
 * 分组折叠记忆。
 *
 * <p>键与语义**照抄网页端的 localStorage**：{@code dsh-mm-collapsed:<工作区key>}，
 * 折叠存 {@code '1'}、展开存 {@code '0'}。
 *
 * <p><b>没记录时算折叠</b> —— 与网页端 {@code localStorage.getItem(key) !== '0'} 一致，
 * 所以第一次打开只看到分组头（用户已确认按网页端行为来）。
 */
class Collapse(ctx: Context) {

    private val sp = ctx.getSharedPreferences("dsh_mm_list", Context.MODE_PRIVATE)

    fun isCollapsed(key: String): Boolean = sp.getString(name(key), null) != "0"

    fun set(key: String, collapsed: Boolean) {
        sp.edit().putString(name(key), if (collapsed) "1" else "0").apply()
    }

    private fun name(key: String) = "dsh-mm-collapsed:" + key
}
