package dev.dsh.mirror.client.ui

import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import dev.dsh.mirror.client.R
import dev.dsh.mirror.client.net.AnswerOutcome
import dev.dsh.mirror.client.net.AskAnswer
import dev.dsh.mirror.client.net.AskBatch
import dev.dsh.mirror.client.net.QuestionFrame
import dev.dsh.mirror.client.net.Questions
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * 全App的待答提问（0.11）。
 *
 * <p><b>为什么是全局而不是挂在 ChatModel 上</b>：提问流管的是**所有会话**，
 * 会话列表要拿它打「待回答」角标、会话页要拿它弹卡片、`hold` 认领又跟「现在在看哪条会话」有关。
 * 放在共同父级（{@code HomeWithDrawer}）才只有一个实例、一条连接。
 *
 * <p>生命周期：跟着首页的组合走。App 退到后台时 Compose 还在，连接就还开着（能收到新提问）；
 * 真正的系统通知是 M6 的事。
 */
class QuestionHub(private val app: Context) {

    /** 当前挂着的全部提问，按到达顺序。 */
    var items by mutableStateOf<List<AskBatch>>(emptyList())
        private set

    /** 非空 = 提问通道有问题（正在重连）。它不该盖掉会话页自己的状态条。 */
    var status by mutableStateOf("")
        private set

    /** 票根彻底失效 —— 由界面接手回登录页。 */
    var expired by mutableStateOf(false)
        private set

    /** 即发即忘的 IO 作用域：{@code hold} 的释放调用常常发生在组合已经离开之后。 */
    private val io = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var job: Job? = null

    fun connect(scope: CoroutineScope) {
        if (job != null) return
        job = scope.launch {
            Questions.stream(app).collect { f ->
                when (f) {
                    is QuestionFrame.Connected -> status = ""
                    is QuestionFrame.Disconnected ->
                        status = app.getString(R.string.ask_reconnecting, f.attempt)
                    QuestionFrame.Expired -> expired = true
                    is QuestionFrame.Ask -> upsert(f.batch)
                    is QuestionFrame.Settled -> remove(f.id)
                }
            }
        }
    }

    /** 这条会话上等着我回答的提问。 */
    fun forSession(sessionId: String): List<AskBatch> = items.filter { it.sessionId == sessionId }

    /** 会话列表角标用：服务端的 `pendingQuestion` 要等下一次刷新，这里立刻就有。 */
    fun countFor(sessionId: String): Int = items.count { it.sessionId == sessionId }

    /**
     * 交一次答案。
     *
     * @returns 出错时的中文说明；成功给 null（成功时这条提问已经从 {@link #items} 里摘掉了）。
     */
    suspend fun submit(batch: AskBatch, answers: List<AskAnswer>): String? {
        return when (val r = Questions.answer(app, batch.id, answers)) {
            AnswerOutcome.Ok -> {
                remove(batch.id)
                null
            }
            is AnswerOutcome.Rejected -> r.message
            AnswerOutcome.Expired -> {
                expired = true
                app.getString(R.string.chat_expired)
            }
            AnswerOutcome.Unreachable -> app.getString(R.string.net_unreachable)
        }
    }

    /** 认领 / 释放等待。失败不打扰用户 —— 认领只是「别让宿主 120 秒超时」的优化。 */
    fun holdAsync(questionId: String, on: Boolean) {
        if (questionId.isEmpty()) return
        io.launch { runCatching { Questions.hold(app, questionId, on) } }
    }

    private fun upsert(b: AskBatch) {
        items = items.filterNot { it.id == b.id } + b
    }

    private fun remove(id: String) {
        items = items.filterNot { it.id == id }
    }
}