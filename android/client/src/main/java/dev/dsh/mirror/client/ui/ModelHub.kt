package dev.dsh.mirror.client.ui

import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import dev.dsh.mirror.client.net.ModelCatalog
import dev.dsh.mirror.client.net.Models
import dev.dsh.mirror.client.net.PresetRow
import dev.dsh.mirror.client.net.ReadResult
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope

/**
 * 模型目录与模式清单的**进程内缓存**（0.12）。
 *
 * <p>为什么要有个东西拿着：目录要 3 处用（首页输入条、新建会话页、会话页胶囊），
 * 每次点开都拉一遍会明显发顿（插件侧 `buildModelCatalog()` 对每个 provider 都要一次上游往返，
 * 它自己带 60 秒 TTL，但手机这头也只需要拉一次）。
 *
 * <p>**不在构造时拉**：`/api/models` 要宿主控制器就绪，否则回 503 —— 让第一次点开时去拉，
 * 失败了还能再点一次重试。
 */
class ModelHub(private val app: Context) {

    var catalog by mutableStateOf<ModelCatalog?>(null)
        private set

    var presets by mutableStateOf<List<PresetRow>>(emptyList())
        private set

    /** 非空 = 上一次拉取失败的原因（卡片里红字显示）。 */
    var error by mutableStateOf("")
        private set

    var loading by mutableStateOf(false)
        private set

    /** 拉过一次就不再自动拉；失败或用户手点「重试」时才再拉。 */
    private var loaded = false

    /**
     * 需要时拉一次（目录 + 模式清单）。已经有目录就直接返回，不会重复打网络。
     *
     * <p>两个接口**并行**发：模式清单不需要控制器，目录要；一个失败不该拖住另一个。
     */
    suspend fun ensure() {
        if (loaded || loading) return
        load()
    }

    /** 强制重拉（失败后的「重试」）。 */
    suspend fun reload() = load()

    private suspend fun load() {
        if (loading) return
        loading = true
        error = ""
        // `finally` 不是装饰：调用方（`LaunchedEffect`）在用户离开页面时会被取消，
        // 少了它 `loading` 就永远停在 true，之后 `ensure()` 全部早退 —— 目录再也拉不出来。
        try {
            val (c, p) = coroutineScope {
                val cc = async { Models.catalog(app) }
                val pp = async { Models.presets(app) }
                cc.await() to pp.await()
            }
            when (c) {
                is ReadResult.Ok -> catalog = c.value
                is ReadResult.Failed -> error = c.message
            }
            when (p) {
                is ReadResult.Ok -> presets = p.value
                is ReadResult.Failed -> if (error.isEmpty()) error = p.message
            }
            // 目录拿不到就别锁死：下次点开还能再试
            loaded = catalog != null
        } finally {
            loading = false
        }
    }
}