package dev.dsh.mirror.client.ui

import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import dev.dsh.mirror.client.R
import dev.dsh.mirror.client.net.Follow
import dev.dsh.mirror.client.net.FollowFrame
import dev.dsh.mirror.client.net.PageOutcome
import dev.dsh.mirror.client.net.SendOutcome
import dev.dsh.mirror.client.net.Session
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.util.TreeMap
import java.util.UUID

/** 打开会话页需要的东西。列表行与首页新建两条路都汇到这里。 */
class ChatTarget(
    val id: String,
    val title: String,
    val cwd: String?,
    val preset: String?,
    val running: Boolean,
    /** 首页新建会话时带过来的第一句话：连上（拿到第一帧 snapshot）之后再发。 */
    val initialPrompt: String? = null,
)

/** 会话页里的一行。 */
sealed class ChatRow {
    abstract val seq: Int

    /** 真人说的话（右侧气泡）。 */
    class User(override val seq: Int, val text: String) : ChatRow()

    /**
     * 助手回复。
     *
     * @param thinkChars 「思考」的字符数 —— 0.7 只显示一行"思考 · N 字"，
     *   真正的折叠卡片是 M5。与网页端一致：**只有思考、没有正文的整条不渲染**。
     * @param tools 这条消息里内嵌的工具调用名（通常是空的，工具调用有独立事件）。
     */
    class Assistant(
        override val seq: Int,
        val text: String,
        val thinkChars: Int,
        val tools: List<String>,
        val interrupted: Boolean,
    ) : ChatRow()

    /** 工具调用 / 报错结果，折成一行。 */
    class Tool(override val seq: Int, val name: String, val detail: String, val isError: Boolean) : ChatRow()

    /** 系统提示行（本轮出错、被中断等）。 */
    class Notice(override val seq: Int, val text: String, val isError: Boolean) : ChatRow()
}

/**
 * 一条会话的界面状态（0.7 只读）。
 *
 * <p>数据来源两处：首屏与增量都来自 `/api/follow`（宿主每次连接先发一份全量 snapshot），
 * 往上翻更早的历史来自 `/api/page`。**不做本地增量合并** —— 断线重连直接拿新 snapshot
 * 整体替换，这样不会错位，也不用维护"我收到了哪些 seq"的账。
 */
class ChatModel(
    private val app: Context,
    val sessionId: String,
    title: String,
    cwd: String?,
    preset: String?,
    running: Boolean,
    private val initialPrompt: String? = null,
) {

    var title by mutableStateOf(title)
        private set
    var cwd by mutableStateOf(cwd)
        private set
    var preset by mutableStateOf(preset)
        private set
    var model by mutableStateOf<String?>(null)
        private set

    var rows by mutableStateOf<List<ChatRow>>(emptyList())
        private set

    /** 正在流式输出、还没落库的那条。 */
    var liveText by mutableStateOf("")
        private set
    var liveThink by mutableStateOf(0)
        private set
    var liveTools by mutableStateOf<List<String>>(emptyList())
        private set

    val liveVisible: Boolean get() = liveText.isNotEmpty() || liveThink > 0 || liveTools.isNotEmpty()

    var running by mutableStateOf(running)
        private set

    /** 非空 = 顶部那条提示（正在重连、翻页失败…）。 */
    var status by mutableStateOf("")
        private set

    var hasMore by mutableStateOf(false)
        private set
    var loadingOlder by mutableStateOf(false)
        private set

    /** 票根彻底失效 —— 由界面接手回登录页。 */
    var expired by mutableStateOf(false)
        private set

    /**
     * 已经发出去、宿主还没回显的那几句（乐观回显）。
     *
     * <p>渲染在**所有已落库的行之下**（也就是屏幕最下方），所以宿主回显时它从 pending 挪进 rows、
     * 位置不变、看不出跳动。
     */
    var pending by mutableStateOf<List<Pending>>(emptyList())
        private set

    /** 一次 POST 还在飞 —— 与网页端一致："发送中连点不会再发"。 */
    var sending by mutableStateOf(false)
        private set

    /** 发送失败时要还给输入框的文本，界面取走即清空。 */
    var restore by mutableStateOf<String?>(null)
        private set

    /** 一句已经上屏、等宿主回显的话。 */
    class Pending(val text: String, val requestId: String)

    private var scope: CoroutineScope? = null
    private var lastSendAt = 0L
    private var sentInitial = false

    /** 上次发失败的那句与它的 requestId —— **重试必须复用同一个 id**，否则弱网下会真发两遍。 */
    private var retryText: String? = null
    private var retryId: String? = null

    /** 当前视图里最早那条的 seq，翻页要用它。 */
    private var firstSeq = Int.MAX_VALUE

    /**
     * 已收到的最新事件 seq。
     *
     * <p>两道用处：① 重连后 snapshot 会整体替换，这时要把水位重置；
     * ② **挡住重复事件** —— 行的 key 用的是 seq，撞 key 会让 LazyColumn 直接崩。
     */
    private var lastSeq = -1
    private var job: Job? = null

    /** 流式文本按块下标攒，最后按序拼 —— 不能直接追加，否则多块消息顺序会乱。 */
    private val liveTextByIndex = TreeMap<Int, StringBuilder>()
    private val liveToolsByIndex = TreeMap<Int, String>()

    fun connect(scope: CoroutineScope) {
        if (job != null) return
        this.scope = scope
        job = scope.launch {
            Follow.stream(app, sessionId).collect { f ->
                when (f) {
                    is FollowFrame.Connected -> status = ""
                    is FollowFrame.Disconnected ->
                        status = app.getString(R.string.chat_reconnecting, f.attempt) + " · " + f.reason
                    FollowFrame.Expired -> {
                        expired = true
                        status = app.getString(R.string.chat_expired)
                    }
                    is FollowFrame.ServerError -> status = f.message
                    is FollowFrame.Snapshot -> applySnapshot(f.json)
                    is FollowFrame.Event -> {
                        val type = f.json.optString("type")
                        // 重复的 seq 直接丢：它会让两个 item 撞 key
                        val seq = f.json.optInt("seq", 0)
                        if (seq in 1..lastSeq) return@collect
                        if (seq > lastSeq) lastSeq = seq
                        note(f.json, live = true)
                        val row = rowOf(f.json, live = true)
                        if (row != null) rows = rows + row
                        status = ""
                        // 宿主回显了我发的那句 → 把乐观那条撤掉（权威版本已经进了 rows，位置不变）
                        if (row is ChatRow.User) pending = pending.filterNot { it.text == row.text }
                        // 落库的正文到了，临时那条就该让位（不清的话会重复显示一遍）
                        if (type == "assistant/message") clearLive()
                    }
                    is FollowFrame.Stream -> applyStream(f.json)
                }
            }
        }
    }

    /** 往上翻一页更早的历史。 */
    fun loadOlder(scope: CoroutineScope) {
        if (loadingOlder || !hasMore || firstSeq == Int.MAX_VALUE) return
        val before = firstSeq
        loadingOlder = true
        scope.launch {
            when (val r = Session.page(app, sessionId, before)) {
                is PageOutcome.Ok -> {
                    val older = ArrayList<ChatRow>(r.records.size)
                    for (ev in r.records) {
                        note(ev, live = false)
                        rowOf(ev, live = false)?.let { older.add(it) }
                    }
                    rows = older + rows
                    hasMore = r.hasMore
                    status = ""
                }
                PageOutcome.Expired -> expired = true
                is PageOutcome.Failed -> status = app.getString(R.string.chat_page_failed, r.code)
                PageOutcome.Unreachable -> status = app.getString(R.string.chat_unreachable)
            }
            loadingOlder = false
        }
    }

    /**
     * 发一句话。**先乐观上屏，再把请求发出去**（用户选的做法）。
     *
     * <p>失败时把文本放进 {@link #restore} 让输入框取回去 —— 不用重打一遍；并且**复用同一个 requestId**，
     * 因为"发出去了但没收到响应"在弱网下是常态，换新 id 就会真的发第二遍。
     */
    suspend fun send(text: String) {
        val t = text.trim()
        if (t.isEmpty()) return
        if (sending) {
            // 正常路径上界面已经用 !sending 禁掉了按钮，这里是兜底：别把用户刚敲的字吞掉
            restore = t
            return
        }
        val now = System.currentTimeMillis()
        if (now - lastSendAt < 300L) {
            // 宿主 /api/prompt 有 300ms 节流（命中回 429 too-fast）；本地先挡一道，省一次往返
            status = app.getString(R.string.chat_too_fast)
            restore = t
            return
        }
        val id = if (retryText == t && retryId != null) retryId!! else UUID.randomUUID().toString()
        lastSendAt = now
        sending = true
        pending = pending + Pending(t, id)
        val r = Session.prompt(app, sessionId, id, t)
        sending = false
        when (r) {
            SendOutcome.Ok -> {
                retryText = null
                retryId = null
                status = ""
            }
            SendOutcome.TooFast -> fail(t, id, app.getString(R.string.chat_too_fast))
            SendOutcome.Expired -> {
                dropPending(id)
                expired = true
            }
            is SendOutcome.Failed -> fail(t, id, app.getString(R.string.chat_send_failed) + "（HTTP " + r.code + "）")
            SendOutcome.Unreachable -> fail(t, id, app.getString(R.string.chat_unreachable))
        }
    }

    private fun fail(text: String, id: String, message: String) {
        dropPending(id)
        retryText = text
        retryId = id
        status = message
        restore = text
    }

    private fun dropPending(id: String) {
        pending = pending.filterNot { it.requestId == id }
    }

    /** 取走"要还给输入框的文本"（取走即清空）。 */
    fun takeRestore(): String? {
        val r = restore
        restore = null
        return r
    }

    /** 停掉正在跑的这一轮。两段式确认由界面负责，这里只管发请求。 */
    fun cancel(scope: CoroutineScope) {
        scope.launch {
            when (val r = Session.cancel(app, sessionId)) {
                SendOutcome.Ok -> status = app.getString(R.string.chat_stopped)
                SendOutcome.Expired -> expired = true
                SendOutcome.TooFast -> status = app.getString(R.string.chat_too_fast)
                is SendOutcome.Failed -> status = app.getString(R.string.chat_send_failed) + "（HTTP " + r.code + "）"
                SendOutcome.Unreachable -> status = app.getString(R.string.chat_unreachable)
            }
        }
    }

    // ———————————————— 帧处理 ————————————————

    private fun applySnapshot(d: JSONObject) {
        val header = d.optJSONObject("header") ?: JSONObject()
        header.optString("cwd").takeIf { it.isNotEmpty() }?.let { cwd = it }
        val proj = d.optJSONObject("projections")?.optString("agentPreset").orEmpty()
        val ap = proj.ifEmpty { header.optString("agentPreset") }
        if (ap.isNotEmpty()) preset = ap

        hasMore = d.optBoolean("hasMore", false)
        val out = ArrayList<ChatRow>()
        var lastStart = -1
        var lastEnd = -1
        val recs = d.optJSONArray("records")
        if (recs != null) {
            for (i in 0 until recs.length()) {
                val ev = recs.optJSONObject(i) ?: continue
                ev.optInt("seq", 0).let { if (it > lastSeq) lastSeq = it }
                note(ev, live = false)
                when (ev.optString("type")) {
                    "turn/start" -> lastStart = ev.optInt("seq", 0)
                    "turn/end" -> lastEnd = ev.optInt("seq", 0)
                    else -> { }
                }
                rowOf(ev, live = false)?.let { out.add(it) }
            }
        }
        rows = out
        // 水位跟着快照走（不是清零）：清成 -1 会让快照里已有的 seq 之后被重复接受
        // 快照里没有"在不在跑"这个字段，靠最后一条 turn/start 与 turn/end 谁更靠后来判断
        running = lastStart > lastEnd
        clearLive()
        // 正在输出中的那条要**重放**，否则重连后"正在输出"会凭空消失
        val stream = d.optJSONObject("assistantStream")
            ?.optJSONObject("activeAttempt")
            ?.optJSONArray("stream")
        if (stream != null) {
            for (i in 0 until stream.length()) stream.optJSONObject(i)?.let { applyStream(it) }
        }

        // 重连后拿到新快照：已经在里面的那几句不必再乐观显示
        if (pending.isNotEmpty()) {
            val texts = HashSet<String>()
            for (r in out) if (r is ChatRow.User) texts.add(r.text)
            pending = pending.filterNot { texts.contains(it.text) }
        }

        // 首页新建会话带来的第一句话：等拿到第一帧快照（会话确实在了）再发
        if (!sentInitial && initialPrompt != null) {
            sentInitial = true
            val first = initialPrompt
            scope?.launch { send(first) }
        }
    }

    /** 逐字流式帧。键名被宿主压短了，见 `lib/mirror.js` 的 projectStreamFrame。 */
    private fun applyStream(d: JSONObject) {
        when (d.optString("k")) {
            "start" -> {
                clearLive()
                running = true
            }
            "text" -> {
                val t = d.optString("t")
                if (t.isNotEmpty()) {
                    val i = d.optInt("i", 0)
                    (liveTextByIndex[i] ?: StringBuilder().also { liveTextByIndex[i] = it }).append(t)
                    liveText = liveTextByIndex.values.joinToString("")
                }
            }
            "reason" -> liveThink += d.optString("t").length
            "tool" -> {
                val i = d.optInt("i", 0)
                val name = d.optString("name").ifEmpty { liveToolsByIndex[i].orEmpty() }
                if (name.isNotEmpty()) {
                    liveToolsByIndex[i] = name
                    liveTools = liveToolsByIndex.values.toList()
                }
            }
            "finish" -> running = false
            "end" -> running = false
            else -> { }
        }
    }

    private fun clearLive() {
        liveTextByIndex.clear()
        liveToolsByIndex.clear()
        liveText = ""
        liveThink = 0
        liveTools = emptyList()
    }

    /**
     * 记下这条事件对**界面状态**的影响（不是渲染）。
     *
     * @param live 只有连接期间实时收到的帧才允许改"在不在跑"与头部芯片 ——
     *   翻旧页时重放历史 turn/start 会把"运行中"错点亮。
     */
    private fun note(ev: JSONObject, live: Boolean) {
        val seq = ev.optInt("seq", 0)
        if (seq > 0 && seq < firstSeq) firstSeq = seq
        if (!live) return
        val data = ev.optJSONObject("data") ?: JSONObject()
        when (ev.optString("type")) {
            "turn/start" -> running = true
            "turn/end" -> {
                running = false
                if (status == app.getString(R.string.chat_stopped)) status = ""
            }
            "agent-preset/selected" -> data.optString("agentPreset").takeIf { it.isNotEmpty() }?.let { preset = it }
            "model/selection", "request/header" -> data.optString("model").takeIf { it.isNotEmpty() }?.let { model = it }
            else -> { }
        }
    }

    /** 投影事件 → 可渲染的行。返回 null 表示这条不下发（或手机上不显示）。 */
    private fun rowOf(ev: JSONObject, live: Boolean): ChatRow? {
        val seq = ev.optInt("seq", 0)
        val type = ev.optString("type")
        val data = ev.optJSONObject("data") ?: JSONObject()
        return when (type) {
            "user/message" -> {
                val text = textOf(data.optJSONArray("blocks"))
                ChatRow.User(seq, text.ifEmpty { app.getString(R.string.chat_attach) })
            }
            "assistant/message" -> {
                val blocks = data.optJSONArray("blocks")
                val text = textOf(blocks)
                // 与网页端 1.2.1 的修正一致：约 68% 的助手消息只有思考 + 命令、没有正文，
                // 这类整条不渲染（否则满屏空气泡）
                if (text.isEmpty()) null
                else ChatRow.Assistant(
                    seq, text, thinkCharsOf(blocks), toolNamesOf(blocks),
                    data.optBoolean("interrupted", false),
                )
            }
            "tool/call" -> ChatRow.Tool(
                seq,
                data.optString("name").ifEmpty { app.getString(R.string.chat_tool) },
                firstLine(data.optString("args")),
                false,
            )
            "tool/result" -> {
                // 成功的结果不显示（网页端折进「工作过程」里），只有报错值得单独一行
                if (!data.optBoolean("isError", false)) null
                else ChatRow.Tool(seq, app.getString(R.string.chat_tool_error), firstLine(textOf(data.optJSONArray("blocks"))), true)
            }
            "turn/end" -> {
                val err = data.optJSONObject("error")
                if (err != null) {
                    ChatRow.Notice(seq, err.optString("message").ifEmpty { app.getString(R.string.chat_turn_error) }, true)
                } else {
                    val label = when (data.optString("reason")) {
                        "aborted" -> app.getString(R.string.chat_end_aborted)
                        "interrupted" -> app.getString(R.string.chat_end_interrupted)
                        "max-tokens" -> app.getString(R.string.chat_end_maxtokens)
                        "blocked" -> app.getString(R.string.chat_end_blocked)
                        else -> ""
                    }
                    if (label.isEmpty()) null else ChatRow.Notice(seq, label, false)
                }
            }
            else -> null
        }
    }

    private fun textOf(blocks: JSONArray?): String {
        if (blocks == null) return ""
        val sb = StringBuilder()
        for (i in 0 until blocks.length()) {
            val b = blocks.optJSONObject(i) ?: continue
            if (b.optString("type") == "text") {
                val t = b.optString("text")
                if (t.isNotEmpty()) {
                    if (sb.isNotEmpty()) sb.append('\n')
                    sb.append(t)
                }
            }
        }
        return sb.toString()
    }

    private fun thinkCharsOf(blocks: JSONArray?): Int {
        if (blocks == null) return 0
        var n = 0
        for (i in 0 until blocks.length()) {
            val b = blocks.optJSONObject(i) ?: continue
            if (b.optString("type") == "reasoning") n += b.optString("text").length
        }
        return n
    }

    private fun toolNamesOf(blocks: JSONArray?): List<String> {
        if (blocks == null) return emptyList()
        val out = ArrayList<String>(2)
        for (i in 0 until blocks.length()) {
            val b = blocks.optJSONObject(i) ?: continue
            if (b.optString("type") == "tool-call") {
                b.optString("name").takeIf { it.isNotEmpty() }?.let { out.add(it) }
            }
        }
        return out
    }

    private fun firstLine(s: String): String {
        val t = s.trim()
        if (t.isEmpty()) return ""
        val nl = t.indexOf('\n')
        val one = if (nl < 0) t else t.substring(0, nl)
        return if (one.length > 160) one.substring(0, 160) + "…" else one
    }
}
