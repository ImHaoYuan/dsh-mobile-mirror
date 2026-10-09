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

/**
 * 「工作过程」里的一步。
 *
 * 默认**只显示 [label]** —— 也就是 `run_code` 参数里那句简短解释；工具名与参数都藏起来
 * （会话里那串 `run_code  {"code":"const R=…"}` 太吵，手机上要滑很久）。
 * 设置里打开「显示详细工作过程」后才显示 [name] 与 [detail]（完整参数，含代码）。
 */
class WorkStep(val name: String, val label: String, val detail: String, val isError: Boolean)

/**
 * 电脑端挂在回复结尾的一个文件（`deliverables/presented`）。
 *
 * @param path 电脑上的绝对路径，点一下交给下载流程。
 * @param description 电脑端显示的那句说明（可能为空）。
 */
class Deliverable(val path: String, val description: String)

/** 会话页里的一行。 */
sealed class ChatRow {
    abstract val seq: Int

    /** 真人说的话（右侧气泡）。 */
    class User(override val seq: Int, val text: String) : ChatRow()

    /**
     * 助手回复。
     *
     * @param thinkChars 「思考」的字符数（展开工作过程时才显示一行）。
     * @param work 这一轮的工作过程 —— 与思考折进**同一张**「工作中 / 工作过程」卡，
     *   正文留在卡外（折叠的是过程，不是回答）。
     */
    class Assistant(
        override val seq: Int,
        val text: String,
        val thinkChars: Int,
        val work: List<WorkStep>,
        val interrupted: Boolean,
    ) : ChatRow()

    /**
     * 只有工作过程、没有正文的一条。
     *
     * 与网页端 1.2.1 的修正一致：正文为空的气泡不渲染（约 68% 的助手消息只有思考 + 命令）。
     * 但**工作过程要留着** —— 折成一行「工作过程 · N 步」，点了能看它刚才在干什么。
     */
    class Work(override val seq: Int, val steps: List<WorkStep>, val thinkChars: Int) : ChatRow()

    /**
     * 「文件」卡：电脑端把这一轮产出的文件挂在回复结尾（`present` 工具 → `deliverables/presented`）。
     *
     * 与电脑端放在**同一个位置**（事件所在处，也就是那条回复之后），不是钉在屏幕底部。
     */
    class Files(override val seq: Int, val files: List<Deliverable>) : ChatRow()

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
    var liveTools by mutableStateOf<List<WorkStep>>(emptyList())
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
    private val liveToolsByIndex = TreeMap<Int, WorkStep>()
    /** 这一轮累积的工作过程，落到下一条助手消息上（没有正文就单独成一条 [ChatRow.Work]）。 */
    private val workAcc = ArrayList<WorkStep>()
    /** 只有思考、没有正文的那些消息的思考字数，攒着并进工作过程。 */
    private var workThink = 0
    /**
     * 这一轮 [deliverables/presented] 带来的文件，攒着**等这一轮说完**再挂出去。
     *
     * <p>present 是工具调用，事件顺序上在总结文字**之前**；电脑端是特意把它挂到回复最末尾的。
     * 直接按事件顺序渲染的话，文件卡会跑到总结上面去（用户报的就是这个）。
     */
    private val filesAcc = ArrayList<Deliverable>()

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
                        val newRows = rowsOf(f.json, live = true)
                        rows = rows + newRows
                        val row = newRows.lastOrNull()
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

    /**
     * 往上翻一页更早的历史。
     *
     * <p>三条容易踩的坑，都在这儿挡住：
     * ① **只收更早的**（{@code seq < before}）—— 宿主理论上不会回重叠，但真重叠了就是
     * 两行撞同一个 key，LazyColumn 会直接崩；网页端 `app.js` 的 `loadOlder` 也是这么筛的。
     * ② **服务端没给新东西就停**（{@code hasMore = false}）—— 否则会拿着同一个 before 反复重试。
     * ③ 读取超时用 {@link Session#page} 里放宽过的 30 秒，不是默认的 6 秒。
     */
    fun loadOlder(scope: CoroutineScope) {
        if (loadingOlder || !hasMore || firstSeq == Int.MAX_VALUE) return
        val before = firstSeq
        loadingOlder = true
        status = app.getString(R.string.chat_loading_older)
        scope.launch {
            when (val r = Session.page(app, sessionId, before)) {
                is PageOutcome.Ok -> {
                    val fresh = r.records.filter { it.optInt("seq", 0) in 1 until before }
                    val older = ArrayList<ChatRow>(fresh.size)
                    for (ev in fresh) {
                        note(ev, live = false)
                        older.addAll(rowsOf(ev, live = false))
                    }
                    // 这一页最后一轮的文件卡别漏（它的总结可能在更早的一页里）
                    older.addAll(takeFiles(before))
                    rows = older + rows
                    hasMore = r.hasMore && fresh.isNotEmpty()
                    status = ""
                }
                PageOutcome.Expired -> {
                    status = ""
                    expired = true
                }
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
                out.addAll(rowsOf(ev, live = false))
            }
        }
        // 快照窗口的最后一轮如果有文件卡，别漏在窗口边界上
        out.addAll(takeFiles(lastSeq))
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
                val name = d.optString("name").ifEmpty { liveToolsByIndex[i]?.name.orEmpty() }
                if (name.isNotEmpty()) {
                    // 流式帧里只有工具名、没有参数，所以这一步拿不到 description，用中文名兜底
                    liveToolsByIndex[i] = WorkStep(name, toolLabel(name), "", false)
                    liveTools = liveToolsByIndex.values.toList()
                }
            }
            "finish" -> running = false
            "end" -> running = false
            else -> { }
        }
    }

    private fun clearLive() {
        filesAcc.clear()
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

    /**
     * 投影事件 → 可渲染的行。
     *
     * 返回**列表**：`turn/end` 收尾时可能既要补一条攒下的工作过程、又要补一条系统提示。
     *
     * 工具调用（`tool/call`）**不单独成行**，先攒进 [workAcc]，落到下一条助手消息上 ——
     * 这样「思考」与「命令」就住在同一张折叠卡里。网页端也是这么合的：
     * "它想了什么、动了什么"本来就是同一件事的两面，拆成两摊手机上要滑很久。
     */
    private fun rowsOf(ev: JSONObject, live: Boolean): List<ChatRow> {
        val seq = ev.optInt("seq", 0)
        val type = ev.optString("type")
        val data = ev.optJSONObject("data") ?: JSONObject()
        return when (type) {
            "user/message" -> {
                val text = textOf(data.optJSONArray("blocks"))
                listOf(ChatRow.User(seq, text.ifEmpty { app.getString(R.string.chat_attach) }))
            }
            "assistant/message" -> {
                val blocks = data.optJSONArray("blocks")
                val text = textOf(blocks)
                val think = thinkCharsOf(blocks)
                val work = drainWork()
                val base = if (text.isEmpty()) {
                    // 与网页端 1.2.1 的修正一致：约 68% 的助手消息只有思考 + 命令、没有正文，
                    // 这类整条不渲染（否则满屏空气泡）—— 但**工作过程要留下**，折成一行。
                    workThink += think
                    if (work.isEmpty()) {
                        emptyList()
                    } else {
                        val row = ChatRow.Work(seq, work, workThink)
                        workThink = 0
                        listOf(row)
                    }
                } else {
                    val row = ChatRow.Assistant(
                        seq, text, think + workThink, work,
                        data.optBoolean("interrupted", false),
                    )
                    workThink = 0
                    listOf(row)
                }
                // 文件卡挂在**这一轮的最末尾**（电脑端也是：总结写完才挂文件）
                base + takeFiles(seq)
            }
            "tool/call" -> {
                val name = data.optString("name").ifEmpty { app.getString(R.string.chat_tool) }
                val args = data.optString("args")
                workAcc.add(WorkStep(name, stepLabel(name, args), argsText(args), false))
                emptyList()
            }
            "tool/result" -> {
                // 成功的结果不显示（网页端折进「工作过程」里），只有报错值得留下
                if (!data.optBoolean("isError", false)) {
                    emptyList()
                } else {
                    workAcc.add(
                        WorkStep(
                            app.getString(R.string.chat_tool_error),
                            firstLine(textOf(data.optJSONArray("blocks"))),
                            "",
                            true,
                        ),
                    )
                    emptyList()
                }
            }
            // 电脑端「把文件挂在回复结尾」用的就是这个事件 —— 先攒着，等这一轮说完再挂
            "deliverables/presented" -> {
                val arr = data.optJSONArray("files")
                for (i in 0 until (arr?.length() ?: 0)) {
                    val o = arr?.optJSONObject(i) ?: continue
                    val p = o.optString("path").trim()
                    if (p.isEmpty()) continue
                    filesAcc.add(Deliverable(p, o.optString("description").trim()))
                }
                emptyList()
            }
            "turn/end" -> {
                val out = ArrayList<ChatRow>(2)
                val work = drainWork()
                if (work.isNotEmpty()) {
                    out.add(ChatRow.Work(seq, work, workThink))
                    workThink = 0
                }
                val err = data.optJSONObject("error")
                if (err != null) {
                    out.add(ChatRow.Notice(seq, err.optString("message").ifEmpty { app.getString(R.string.chat_turn_error) }, true))
                } else {
                    val label = when (data.optString("reason")) {
                        "aborted" -> app.getString(R.string.chat_end_aborted)
                        "interrupted" -> app.getString(R.string.chat_end_interrupted)
                        "max-tokens" -> app.getString(R.string.chat_end_maxtokens)
                        "blocked" -> app.getString(R.string.chat_end_blocked)
                        else -> ""
                    }
                    if (label.isNotEmpty()) out.add(ChatRow.Notice(seq, label, false))
                }
                // 兜底：这一轮没有落库的助手消息时，文件卡也得挂出去
                out.addAll(takeFiles(seq))
                out
            }
            else -> emptyList()
        }
    }

    /** 攒下的文件取走，变成「文件」卡（挂在当前这一轮最后）。 */
    private fun takeFiles(seq: Int): List<ChatRow> {
        if (filesAcc.isEmpty()) return emptyList()
        val row = ChatRow.Files(seq, ArrayList(filesAcc))
        filesAcc.clear()
        return listOf(row)
    }

    /** 攒下的工作过程取走并清空。 */
    private fun drainWork(): List<WorkStep> {
        if (workAcc.isEmpty()) return emptyList()
        val out = ArrayList<WorkStep>(workAcc)
        workAcc.clear()
        return out
    }

    /** 一步的默认文案：优先用参数里的 description（`run_code` 那句简短解释），否则退化成工具的中文名。 */
    private fun stepLabel(name: String, args: String): String {
        val d = try {
            JSONObject(args).optString("description")
        } catch (_: Exception) {
            ""
        }
        return d.trim().ifEmpty { toolLabel(name) }
    }

    /** 详细模式下的参数：压成一行并截断。 */
    private fun argsText(args: String): String = args.trim().replace(Regex("\\s+"), " ").take(240)

    /** 工具的中文名。默认模式不显示工具名，只有拿不到 description 时才用它兜底。 */
    private fun toolLabel(name: String): String = when (name) {
        "run_code" -> app.getString(R.string.tool_run_code)
        "read" -> app.getString(R.string.tool_read)
        "write" -> app.getString(R.string.tool_write)
        "edit" -> app.getString(R.string.tool_edit)
        "pwsh", "bash", "shell" -> app.getString(R.string.tool_shell)
        "glob", "grep" -> app.getString(R.string.tool_search)
        "web_search", "web_fetch" -> app.getString(R.string.tool_web)
        "todo_write" -> app.getString(R.string.tool_plan)
        else -> app.getString(R.string.chat_tool)
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

    private fun firstLine(s: String): String {
        val t = s.trim()
        if (t.isEmpty()) return ""
        val nl = t.indexOf('\n')
        val one = if (nl < 0) t else t.substring(0, nl)
        return if (one.length > 160) one.substring(0, 160) + "…" else one
    }
}
