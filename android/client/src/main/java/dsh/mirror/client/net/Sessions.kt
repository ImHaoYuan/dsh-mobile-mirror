package dsh.mirror.client.net

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/**
 * 一条会话。字段与服务端 {@code lib/mirror.js} 的 {@code normalizeSummary()} 一一对应。
 */
data class SessionRow(
    val id: String,
    val title: String,
    val running: Boolean,
    val blank: Boolean,
    val agentAvailable: Boolean,
    val updatedAt: Long,
    val cwd: String?,
    val origin: String?,
    val parentSessionId: String?,
    val pendingQuestion: Boolean,
    val preset: String?,
) {
    /**
     * 分组视图里的行标题。
     *
     * <p>分组头已经写着文件夹名，所以无标题的行**不必再把文件夹名重复一遍** ——
     * 那样同一个分组里的每一行都会长得一模一样（网页端 {@code groupedLabel} 同义）。
     */
    val label: String get() = title.trim().ifEmpty { "未命名会话" }

    /** 子智能体：{@code origin} 或 {@code parentSessionId} 任一命中就算（宁可多标，不可漏标）。 */
    val isChild: Boolean get() = origin == "subagent" || !parentSessionId.isNullOrEmpty()
}

/** 一个工作区分组（服务端 {@code groupSessions()} 的输出）。 */
data class SessionGroup(
    val key: String,
    val name: String,
    val path: String?,
    val items: List<SessionRow>,
    val running: Boolean,
)

/** {@code /api/workspaces} 的一行（新建会话的候选文件夹）。 */
data class Workspace(
    val id: String,
    val path: String,
    val name: String,
    val sessionCount: Int,
)

sealed class SessionsResult {
    class Ok(val groups: List<SessionGroup>) : SessionsResult()
    object Expired : SessionsResult()
    object Unreachable : SessionsResult()
    /** 连上了但服务端报错（4xx/5xx）；message 是服务端写好的中文。 */
    class Failed(val message: String) : SessionsResult()
    /** 连上了、但响应体解析不了 —— 多半是插件与客户端版本不一致，说实话比说"连不上"有用。 */
    object Broken : SessionsResult()
}

/** 归档（= 手机上的「长按删除」）的结果。 */
sealed class ArchiveResult {
    object Ok : ArchiveResult()
    /** 服务端明确拒绝：会话已经不在了 / 还有工作在跑 / 只读模式；message 能直接给用户看。 */
    class Rejected(val message: String) : ArchiveResult()
    object Expired : ArchiveResult()
    object Unreachable : ArchiveResult()
}

sealed class CreateResult {
    class Ok(val sessionId: String) : CreateResult()
    /** 服务端明确拒绝；message 已经是能直接给用户看的中文。 */
    class Rejected(val message: String) : CreateResult()
    object Expired : CreateResult()
    object Unreachable : CreateResult()
}

/**
 * 会话列表 / 工作区 / 新建会话。
 *
 * <p>排序与派生字段全部**逐条照抄网页端**（{@code lib/web/app.js} + {@code lib/mirror.js}）——
 * 那几个函数都带着踩坑注释，自己"顺手优化"一遍必然走样。
 */
object Sessions {

    suspend fun load(ctx: Context): SessionsResult =
        when (val f = MirrorSession.fetch(ctx, "/api/sessions")) {
            is Fetch.Ok -> try {
                SessionsResult.Ok(parseGroups(f.body))
            } catch (t: Throwable) {
                SessionsResult.Broken
            }
            is Fetch.Failed -> SessionsResult.Failed(
                messageOf(f.body) ?: ("载入会话失败（HTTP " + f.code + "）")
            )
            Fetch.Expired -> SessionsResult.Expired
            Fetch.Unreachable -> SessionsResult.Unreachable
        }

    /** 拉候选文件夹。**失败一律返回空表** —— 新建会话不依赖这个接口（还能手输路径）。 */
    suspend fun workspaces(ctx: Context): List<Workspace> {
        val f = MirrorSession.fetch(ctx, "/api/workspaces")
        if (f !is Fetch.Ok) return emptyList()
        return try {
            val arr = JSONObject(f.body).optJSONArray("workspaces") ?: return emptyList()
            val out = ArrayList<Workspace>(arr.length())
            for (i in 0 until arr.length()) {
                val o = arr.optJSONObject(i) ?: continue
                val path = str(o, "path") ?: ""
                if (path.isEmpty()) continue
                out.add(
                    Workspace(
                        id = str(o, "id") ?: "",
                        path = path,
                        name = (str(o, "name") ?: "").ifEmpty { workspaceOf(path).second },
                        sessionCount = o.optInt("sessionCount", 0),
                    )
                )
            }
            out
        } catch (t: Throwable) {
            emptyList()
        }
    }

    /**
     * 新建会话。{@code workspaceId} 优先（宿主自己解析路径），没有登记 id 就退回 {@code cwd}。
     *
     * <p>只读模式（{@code enablePrompt=false}）由服务端的统一前置守卫拦下，回 403 ——
     * 手机端**拿不到**这个开关（它只在 loopback 专享的 /pair.json 里），所以不预判，
     * 撞上了就把服务端那句 message 原样显示出来。
     */
    suspend fun create(
        ctx: Context,
        workspaceId: String?,
        cwd: String?,
        /** 模式 id；空 = 用宿主默认。对应宿主的 `agentPreset`（0.12 起首页/新建页可选）。 */
        preset: String? = null,
    ): CreateResult {
        val payload = JSONObject()
        when {
            !workspaceId.isNullOrEmpty() -> payload.put("workspaceId", workspaceId)
            !cwd.isNullOrEmpty() -> payload.put("cwd", cwd)
            else -> return CreateResult.Rejected("缺少工作区或目录")
        }
        if (!preset.isNullOrEmpty()) payload.put("agentPreset", preset)
        return when (val r = MirrorSession.postJson(ctx, "/api/session", payload.toString())) {
            is Send.Ok -> {
                val id = try {
                    str(JSONObject(r.body), "sessionId") ?: ""
                } catch (t: Throwable) {
                    ""
                }
                if (id.isEmpty()) CreateResult.Rejected("宿主端没有返回新会话 id")
                else CreateResult.Ok(id)
            }
            is Send.Rejected -> CreateResult.Rejected(
                messageOf(r.body) ?: "新建会话失败（HTTP " + r.code + "）"
            )
            Send.Expired -> CreateResult.Expired
            Send.Unreachable -> CreateResult.Unreachable
        }
    }

    /**
     * 归档（= 手机上「长按删除」）一个会话。
     *
     * <p>DSH **没有真删会话的接口** —— 桌面端自己那个「从列表里去掉」用的就是归档
     * （{@code dsh-client-ui-workspace}：「对静止的 Session，Archive 不经确认对话框直接提交，
     * 并保留 Session 的记账位置」）。语义是**软删除**：会话文件还在磁盘上，
     * 电脑端的「已归档」里找得回来。
     *
     * <p>服务端把「还有工作在跑」单独回 409 并列出在跑的东西，这里原样带出来给用户看。
     */
    suspend fun archive(ctx: Context, sessionId: String): ArchiveResult {
        val payload = JSONObject().put("sessionId", sessionId)
        return when (val r = MirrorSession.postJson(ctx, "/api/session/archive", payload.toString())) {
            is Send.Ok -> ArchiveResult.Ok
            is Send.Rejected -> ArchiveResult.Rejected(
                messageOf(r.body) ?: ("删除失败（HTTP " + r.code + "）")
            )
            Send.Expired -> ArchiveResult.Expired
            Send.Unreachable -> ArchiveResult.Unreachable
        }
    }

    /** 从 {@code {error, message}} 里取能给人看的那句。 */
    private fun messageOf(body: String): String? {
        if (body.isEmpty()) return null
        return try {
            (str(JSONObject(body), "message") ?: "").ifEmpty { null }
        } catch (t: Throwable) {
            null
        }
    }

    /** 服务端给了 {@code groups} 就用它；没有（版本不一致）就在本地兜一份，与网页端同义。 */
    fun parseGroups(body: String): List<SessionGroup> {
        val root = JSONObject(body)
        val arr = root.optJSONArray("groups")
        if (arr != null) {
            val out = ArrayList<SessionGroup>(arr.length())
            for (i in 0 until arr.length()) {
                val g = arr.optJSONObject(i) ?: continue
                out.add(
                    SessionGroup(
                        key = str(g, "key") ?: "",
                        name = (str(g, "name") ?: "").ifEmpty { "无工作区" },
                        path = str(g, "path"),
                        items = parseItems(g.optJSONArray("items")),
                        running = g.optBoolean("running", false),
                    )
                )
            }
            return out
        }
        return groupLocally(parseItems(root.optJSONArray("items")))
    }

    private fun parseItems(arr: JSONArray?): List<SessionRow> {
        if (arr == null) return emptyList()
        val out = ArrayList<SessionRow>(arr.length())
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            // 一律走 str()：Android 的 optString 对 JSON null 会返回字符串 "null"，
            // 而服务端的 title/preset/cwd/origin/parentSessionId 都可能是真 null
            val id = str(o, "id") ?: ""
            if (id.isEmpty()) continue
            out.add(
                SessionRow(
                    id = id,
                    title = str(o, "title") ?: "",
                    running = o.optBoolean("running", false),
                    blank = o.optBoolean("blank", false),
                    // 与服务端 normalizeSummary 的 `=== true` 同义：字段缺失按 false 算
                    agentAvailable = o.optBoolean("agentAvailable", false),
                    updatedAt = o.optLong("updatedAt", 0L),
                    cwd = str(o, "cwd"),
                    origin = str(o, "origin"),
                    parentSessionId = str(o, "parentSessionId"),
                    pendingQuestion = o.optBoolean("pendingQuestion", false),
                    preset = str(o, "preset"),
                )
            )
        }
        return out.sortedByDescending { it.updatedAt }
    }

    /**
     * {@code optString} 对 JSON null 会返回字符串 "null"（Android 的实现细节），
     * 所以可空字段一律先过这道判断。
     */
    private fun str(o: JSONObject, key: String): String? {
        if (o.isNull(key)) return null
        return o.optString(key, "").ifEmpty { null }
    }

    /**
     * 侧栏里**彻底不显示子智能体**（用户要求，0.15.8）。
     *
     * <p>判据就是 {@code SessionRow.isChild}（{@code origin == "subagent"}，或带着
     * {@code parentSessionId}）。过滤完**空的分组整块丢掉** —— 否则会留下一个只写着
     * 工作区名和 "0" 的分组头。分组的 {@code running} 圆点按**看得见的行**重算：
     * 圆点点亮却找不到哪一行在跑，比不亮更让人困惑。
     *
     * <p>为什么放在数据层而不是渲染处：分组头的会话数（{@code group.items.size}）和
     * "空列表"判断都得用同一份数据，两份数据必然走样。
     *
     * <p><b>监测不受影响</b>："有会话在跑就拉起服务"仍按服务端返回的**全量**数据判断
     * （{@code SessionsResult.Ok.groups}），不因子会话被隐藏而丢掉超级岛与提醒。
     */
    fun withoutChildren(groups: List<SessionGroup>): List<SessionGroup> =
        groups.mapNotNull { g ->
            val items = g.items.filterNot { it.isChild }
            when {
                items.isEmpty() -> null
                else -> g.copy(items = items, running = items.any { it.running })
            }
        }

    /** 本地兜底分组（服务端没给 groups 时用）。 */
    private fun groupLocally(items: List<SessionRow>): List<SessionGroup> {
        val order = ArrayList<String>()
        val map = HashMap<String, MutableList<SessionRow>>()
        for (it in items) {
            val key = workspaceOf(it.cwd).first
            if (!map.containsKey(key)) {
                order.add(key)
                map[key] = ArrayList()
            }
            map[key]!!.add(it)
        }
        val out = ArrayList<SessionGroup>(order.size)
        for (key in order) {
            val rows = map[key]!!.sortedByDescending { it.updatedAt }
            val w = workspaceOf(rows.firstOrNull()?.cwd)
            out.add(
                SessionGroup(
                    key = key,
                    name = w.second,
                    path = w.third,
                    items = rows,
                    running = rows.any { it.running },
                )
            )
        }
        return out.sortedWith(compareBy({ it.key.isEmpty() }, { -it.items.maxOfOrNull { r -> r.updatedAt }!! }))
    }

    /**
     * 从 cwd 抽出工作区标识（网页端 {@code workspaceOf} 的移植）。
     *
     * <p>key 统一小写：Windows 路径大小写不敏感，{@code D:\Foo} 与 {@code d:\foo} 是同一个
     * 文件夹，不归一化会把同一个工作区拆成两组。空 cwd 归到"无工作区"（key 为空串），保证它排在最后。
     */
    private fun workspaceOf(cwd: String?): Triple<String, String, String?> {
        val raw = cwd?.trim().orEmpty()
        if (raw.isEmpty()) return Triple("", "无工作区", null)
        val normalized = raw.trimEnd('\\', '/').ifEmpty { raw }
        val parts = normalized.split('\\', '/').filter { it.isNotEmpty() }
        val name = parts.lastOrNull() ?: normalized
        return Triple(normalized.lowercase(), name, normalized)
    }

    /**
     * 路径缩短：保留首段与末段，中间省略（网页端 {@code shortPath}）。
     * 长路径会把分组头撑爆。
     */
    fun shortPath(p: String?): String {
        val s = p?.trimEnd('\\', '/').orEmpty()
        if (s.isEmpty()) return ""
        val parts = s.split('\\', '/').filter { it.isNotEmpty() }
        if (parts.size <= 2) return s
        return parts.first() + "\\…\\" + parts.last()
    }

    /** 相对时间（网页端 {@code relTime} 的移植，含 30 天/12 个月的换算）。 */
    fun relTime(ts: Long, now: Long = System.currentTimeMillis()): String {
        if (ts <= 0L) return ""
        var sec = (now - ts) / 1000
        if (sec < 0) sec = 0
        if (sec < 60) return "刚刚"
        val min = sec / 60
        if (min < 60) return min.toString() + " 分钟前"
        val hour = sec / 3600
        if (hour < 24) return hour.toString() + " 小时前"
        val day = sec / 86400
        if (day < 30) return day.toString() + " 天前"
        val month = day / 30
        if (month < 12) return month.toString() + " 个月前"
        return (day / 365).toString() + " 年前"
    }
}
