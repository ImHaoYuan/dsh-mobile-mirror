package dev.dsh.mirror.client.prefs

import android.content.Context

/** 新建会话用的定位：工作区 id 优先（宿主自己解析路径），没有 id 就退回绝对路径。 */
data class ComposerLocation(val workspaceId: String?, val cwd: String?)

/**
 * 首页输入框记住的「上次用的文件夹」。
 *
 * <p>为什么要记：宿主 {@code validateSessionCreate} 要求 {@code cwd} 与 {@code workspaceId}
 * **至少给一个**，两个都不给直接 400。所以首页开对话必须有个文件夹，默认值就取上次用过的那个；
 * 第一次用（没记过）时退回工作区清单里最新的那个。
 */
class Composer(ctx: Context) {
    private val sp = ctx.getSharedPreferences("dsh_mm_composer", Context.MODE_PRIVATE)

    fun location(): ComposerLocation? {
        val kind = sp.getString("kind", null) ?: return null
        val value = sp.getString("value", null)?.takeIf { it.isNotEmpty() } ?: return null
        return if (kind == "id") ComposerLocation(value, null) else ComposerLocation(null, value)
    }

    fun remember(workspaceId: String?, cwd: String?) {
        val id = workspaceId?.takeIf { it.isNotEmpty() }
        sp.edit().apply {
            if (id != null) {
                putString("kind", "id")
                putString("value", id)
            } else {
                putString("kind", "cwd")
                putString("value", cwd.orEmpty())
            }
        }.apply()
    }
}
