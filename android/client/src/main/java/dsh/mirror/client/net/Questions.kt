package dsh.mirror.client.net

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.net.SocketTimeoutException
import javax.net.ssl.HttpsURLConnection

/** 一个可选项（{@code options[]} 里的一项）。 */
class AskOption(val label: String, val description: String)

/** 一道题。答案要按 {@code id} 交回去。 */
class AskQuestion(
    val id: String,
    /** 题干上方的小标题（可能为空）。 */
    val header: String,
    val text: String,
    val options: List<AskOption>,
    /** true = 多选。 */
    val multiSelect: Boolean,
)

/**
 * 一次提问。
 *
 * <p>宿主一次 `ask_user_question` 可以带**多道题**，而 `/api/answer` 要求**一次交齐**
 * （{@code validateAnswers}：`answers.length` 必须等于题目数，少一道就 400）。
 * 所以卡片是按「一次提问」为单位提交的，不是按单道题。
 */
class AskBatch(
    val id: String,
    val sessionId: String,
    val createdAt: Long,
    val questions: List<AskQuestion>,
)

/** 一道题的答案：{@code selected} 与 {@code custom} 至少要有一个非空。 */
class AskAnswer(val id: String, val selected: List<String>, val custom: String?)

/** `/api/questions/stream` 上的一帧。 */
sealed class QuestionFrame {
    /** 连上了（含每次重连成功）。 */
    object Connected : QuestionFrame()

    /** 掉线了，正在退避重试。{@code attempt} 从 1 开始。 */
    class Disconnected(val attempt: Int, val reason: String) : QuestionFrame()

    /** 票根彻底失效：自动重登也没救回来，该回登录页了。 */
    object Expired : QuestionFrame()

    /** 一条待答提问。连上时宿主会先把**当前挂着的全部**补一遍，所以不会漏。 */
    class Ask(val batch: AskBatch) : QuestionFrame()

    /** 一条提问已经落定（别处答了 / 超时淘汰 / 轮次中止）。 */
    class Settled(val id: String, val sessionId: String, val outcome: String) : QuestionFrame()
}

/** 一次作答的结果。 */
sealed class AnswerOutcome {
    object Ok : AnswerOutcome()
    object Expired : AnswerOutcome()
    /** 服务端明确拒绝，{@code message} 是它写好的中文说明（比本地兜底准）。 */
    class Rejected(val message: String) : AnswerOutcome()
    object Unreachable : AnswerOutcome()
}

/**
 * 提问中心（0.11）。
 *
 * <p><b>为什么要单独一条流</b>：提问**不在会话事件流里** —— 它走宿主的
 * `user-questions/request` waterfall（`ctx.userQuestions.ask()`），所以 `/api/follow` 上看不到。
 * 插件把它单独暴露成 `/api/questions/stream`：连上先补一份当前快照，之后推 `question` /
 * `question-settled` 两种帧。
 *
 * <p>连接、心跳、401 自动重登、退避都在 {@link Sse} 里（与 `/api/follow` 共用一套）。
 */
object Questions {

    /** 常驻一条流，管**所有会话**的提问（与网页端一致）。 */
    fun stream(ctx: Context): Flow<QuestionFrame> = callbackFlow {
        val app = ctx.applicationContext
        var conn: HttpsURLConnection? = null

        val worker = launch(Dispatchers.IO) {
            var attempt = 0
            while (isActive) {
                if (!dsh.mirror.ServerPrefs(app).isConfigured()) {
                    trySend(QuestionFrame.Expired)
                    break
                }

                var reason = "连接断开"
                var retryNow = false
                try {
                    val c = Sse.open(app, "/api/questions/stream")
                    conn = c
                    when (val code = c.responseCode) {
                        401 -> {
                            if (Sse.relogin(app)) retryNow = true else {
                                trySend(QuestionFrame.Expired)
                                return@launch
                            }
                        }
                        200 -> {
                            attempt = 0
                            trySend(QuestionFrame.Connected)
                            Sse.read(c) { obj ->
                                val d = Sse.data(obj) ?: return@read
                                when (obj.optString("e")) {
                                    "question" -> parseBatch(d)?.let { trySend(QuestionFrame.Ask(it)) }
                                    "question-settled" -> trySend(
                                        QuestionFrame.Settled(
                                            d.optString("id"),
                                            d.optString("sessionId"),
                                            d.optString("outcome"),
                                        ),
                                    )
                                    else -> { }
                                }
                            }
                            reason = "电脑关闭了连接"
                        }
                        else -> reason = "电脑返回 HTTP " + code
                    }
                } catch (t: Throwable) {
                    reason = if (t is SocketTimeoutException) "电脑没有响应" else "连不上电脑"
                } finally {
                    try { conn?.disconnect() } catch (_: Throwable) { }
                    conn = null
                }

                if (!isActive) break
                if (retryNow) continue

                attempt += 1
                trySend(QuestionFrame.Disconnected(attempt, reason))
                delay(Sse.backoffMs(attempt))
            }
        }

        awaitClose {
            try { conn?.disconnect() } catch (_: Throwable) { }
            worker.cancel()
        }
    }

    /**
     * 交一次答案。**同一次提问的每道题都要给**（少一道宿主回 400 `bad-answers`）。
     */
    suspend fun answer(ctx: Context, questionId: String, answers: List<AskAnswer>): AnswerOutcome {
        return when (val r = MirrorSession.postJson(ctx, "/api/answer", answerPayload(questionId, answers))) {
            is Send.Ok -> AnswerOutcome.Ok
            is Send.Rejected -> AnswerOutcome.Rejected(errorMessage(r.code, r.body))
            is Send.Expired -> AnswerOutcome.Expired
            Send.Unreachable -> AnswerOutcome.Unreachable
        }
    }

    /**
     * 组装 `/api/answer` 的请求体。抽出来是为了能单测 —— 形状错了服务端会整批拒。
     *
     * <p>规则（见插件 `validateAnswers`）：每道题的 `id` 恰好一次；`selected` 里的空串会被丢掉；
     * `custom` 为空时**整个字段都不下发**（下发空串会被判成「既没选也没写」）。
     */
    fun answerPayload(questionId: String, answers: List<AskAnswer>): String {
        val arr = JSONArray()
        for (a in cleanAnswers(answers)) {
            val sel = JSONArray()
            for (s in a.selected) sel.put(s)
            val o = JSONObject().put("id", a.id).put("selected", sel)
            a.custom?.let { o.put("custom", it) }
            arr.put(o)
        }
        return JSONObject().put("questionId", questionId).put("answers", arr).toString()
    }

    /**
     * 把答案规整成「能下发的形状」：空串丢掉、`custom` 为空就是 null。
     *
     * <p>抽成纯函数是为了能单测 —— 序列化那一步（上面）只是照抄，没有判断。
     */
    fun cleanAnswers(answers: List<AskAnswer>): List<AskAnswer> = answers.map { a ->
        AskAnswer(
            id = a.id,
            selected = a.selected.filter { it.isNotBlank() }.map { it.trim() },
            custom = a.custom?.trim()?.takeIf { it.isNotEmpty() },
        )
    }

    /**
     * 认领 / 释放这条提问的等待。
     *
     * <p>认领后宿主不再跑自己的 120 秒倒计时 —— 手机上作答就永远是「时答」；
     * 手机一离开卡片就释放，宿主按原 deadline 决定，不会把 agent 卡住。
     *
     * @returns 服务端认了才为 true。失败不必打扰用户：认领只是优化。
     */
    suspend fun hold(ctx: Context, questionId: String, on: Boolean): Boolean {
        val payload = JSONObject().put("questionId", questionId).put("hold", on)
        return MirrorSession.postJson(ctx, "/api/questions/hold", payload.toString()) is Send.Ok
    }

    /**
     * 解析一条 `question` 帧（生产路径）。
     *
     * <p>字段名都在 {@link #parseBatch(FieldReader)} 里，这里只是把 `org.json` 套上 [FieldReader]。
     */
    fun parseBatch(d: JSONObject): AskBatch? = parseBatch(JsonReader(d))

    /**
     * 解析一条 `question` 帧。没有 id 的题目直接丢掉 —— 答案按 id 对齐，
     * 交不上去的题留着只会让整批答案被拒。
     *
     * <p>吃 [FieldReader] 而不是 JSONObject 是为了**可测**：Android 单测跑在桩 android.jar 上，
     * `org.json` 的方法一律抛 `Method … not mocked`，所以解析规则不能直接吃 JSONObject。
     *
     * @returns 一道题都解析不出来时给 null（这一帧就不该渲染）。
     */
    fun parseBatch(d: FieldReader): AskBatch? {
        val id = d.str("id")
        if (id.isEmpty()) return null
        val list = ArrayList<AskQuestion>(4)
        for (q in d.arr("questions")) {
            val qid = q.str("id")
            if (qid.isEmpty()) continue
            val opts = ArrayList<AskOption>(4)
            for (o in q.arr("options")) {
                val label = o.str("label")
                if (label.isEmpty()) continue
                opts.add(AskOption(label, o.str("description")))
            }
            list.add(
                AskQuestion(
                    id = qid,
                    header = q.str("header"),
                    text = q.str("question"),
                    options = opts,
                    multiSelect = q.bool("multiSelect", false),
                ),
            )
        }
        if (list.isEmpty()) return null
        return AskBatch(id, d.str("sessionId"), d.long("createdAt", 0L), list)
    }

    /** 服务端错误体 → 一句能给用户看的话（取不到说明就退回状态码）。 */
    fun errorMessage(code: Int, body: String): String = httpErrorText(code, jsonMessage(body))
}