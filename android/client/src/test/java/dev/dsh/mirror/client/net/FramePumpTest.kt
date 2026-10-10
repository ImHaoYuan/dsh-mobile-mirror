package dev.dsh.mirror.client.net

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.buffer
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/*
 * SSE 帧泵的丢帧复现（0.15.3 那个「后台回来不刷新」的根因）。
 *
 * 现象（用户报）：会话页待着 → 放后台 → 通知弹出 → 回来发现
 *   ① 流式预览一直挂着、落库那条正文的 Markdown 不出现；
 *   ② apk 之类的文件卡没挂在会话最下面；③ 没有「正在重连」；
 *   ④ 退出会话重进就好了；⑤ 只有长消息才会中招。
 *
 * 根因：Follow.stream 是 callbackFlow + trySend(帧)，没有配 .buffer(...)。
 * callbackFlow（= channelFlow）默认缓冲只有 64 个元素，而 trySend 是非阻塞投递：
 * 缓冲满了直接返回失败、帧被静默丢掉。消费者侧是主线程（Compose 作用域），
 * 长消息的流式预览排版又重 —— 主线程一落后缓冲就满，后面那些帧（落库正文 /
 * deliverables/presented / turn/end）全被丢掉，于是预览永远不被替换、文件卡永远不挂；
 * 而连接本身是好的，所以既不会重连、也不会有任何提示。重进 = 新连接 + 全量 snapshot，
 * 所以一切都回来了。长消息只是因为「主线程更慢、更容易把 64 槽灌满」。
 *
 * 这个文件把机制钉成两条 A/B 单测：同样是「生产者一次灌 300 帧、消费者先卡住 200 毫秒」，
 * 默认配置必丢，buffer(Channel.UNLIMITED) 一帧不丢。
 * 修法就是把 Follow.stream 改成后者（并让投递走可挂起的 send）。
 */
class FramePumpTest {

    /** 与 Follow.stream 同形状的帧泵：callbackFlow + 非阻塞 trySend。 */
    private fun burstPump(sent: Int, unlimited: Boolean): Flow<Int> {
        val base = callbackFlow {
            launch(Dispatchers.Default) {
                for (i in 1..sent) trySend(i)
                close()
            }
            awaitClose { }
        }
        return if (unlimited) base.buffer(Channel.UNLIMITED) else base
    }

    @Test
    fun dropsWithDefaultBuffer() = runBlocking {
        val sent = 300
        val got = ArrayList<Int>()
        burstPump(sent, unlimited = false).collect { i ->
            // 消费者（真实场景里是主线程）先卡住一次，让生产者把 64 个槽灌满
            if (got.isEmpty()) delay(200)
            got.add(i)
        }
        assertTrue(
            got.size < sent,
            "预期丢帧：发了 " + sent + " 帧，只收到 " + got.size + " 帧 —— 这正是后台回来不刷新的机制",
        )
    }

    @Test
    fun keepsEveryFrameWithUnlimitedBuffer() = runBlocking {
        val sent = 300
        val got = ArrayList<Int>()
        // 消费者同样慢：消费者慢不该导致丢帧，只该导致排队
        burstPump(sent, unlimited = true).collect { i ->
            if (got.isEmpty()) delay(200)
            got.add(i)
        }
        assertEquals(sent, got.size, "配了 buffer(UNLIMITED) 之后不该再丢帧")
    }
}
