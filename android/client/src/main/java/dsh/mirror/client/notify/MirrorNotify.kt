package dsh.mirror.client.notify

import android.content.Context
import dsh.mirror.MirrorService
import dsh.mirror.client.net.Sessions
import dsh.mirror.client.net.SessionsResult
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * 通知 / 超级岛的门（0.15）。
 *
 * <p>服务本身在 `:core`（与 WebView 外壳共用实现），但**什么时候起停由客户端说了算** ——
 * 用户定的规矩：有会话在跑才监测，没会话就完全停（常驻通知与岛一起消失，
 * 刻意不做"空闲慢心跳"那种折中）。所以这里只干两件事：查一次有没有东西在跑、
 * 需要就把服务拉起来。
 *
 * <p>**停不用这里管**：`MirrorService` 在按需模式下空闲 30 秒会自己 `stopSelf()`。
 * 客户端要是也去停，两边就会打架（比如刚发出一条、服务刚起，客户端又反手把它停了）。
 */
object MirrorNotify {

    /**
     * 自己开一个 IO 作用域。
     *
     * <p>不借调用点的生命周期：这些调用来自 UI 回调与组合副作用，为了查一次会话列表
     * 去绑 Activity 的生命周期不值得 —— 查询本身很短，查完自己结束。
     */
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    /**
     * 已经知道有东西在跑（比如本地刚发出一条）—— 直接起，不再多查一次。
     *
     * <p>包一层 `runCatching`：Android 12+ 从**后台**起前台服务会被系统拒绝
     * （`ForegroundServiceStartNotAllowedException`）。这里的调用点全在 App 前台
     * （`ON_START` / 组合副作用 / 发送回调），但 [ensure] 是"查完再起"、中间隔着一次网络请求，
     * 用户完全可能在这几百毫秒里按 Home。真被拒了也只是**这一次没起监测**，
     * 不该把 App 崩掉 —— 下次回到前台会再试。
     */
    fun start(ctx: Context) {
        runCatching { MirrorService.startOnDemand(ctx.applicationContext) }
    }

    /**
     * 查一次再决定起不起。
     *
     * <p>判据与 `:core` 的 `IslandMonitor` 同款：**有会话在跑、或有问题在等**都算"有东西"。
     * 注意 `/api/sessions` 里的 `running` **不含**"等你回答"的会话 —— 那是另一个字段
     * `pendingQuestion`，两个都得看，否则 agent 提问等回答时反倒不会起监测。
     */
    fun ensure(ctx: Context) {
        val app = ctx.applicationContext
        scope.launch {
            // 查不到（没登录 / 连不上）就先不起：下次回到前台再试，不在这里弹错误
            val r = runCatching { Sessions.load(app) }.getOrNull()
            if (r !is SessionsResult.Ok) return@launch
            val active = r.groups.any { g -> g.items.any { it.running || it.pendingQuestion } }
            if (active) start(app)
        }
    }
}
