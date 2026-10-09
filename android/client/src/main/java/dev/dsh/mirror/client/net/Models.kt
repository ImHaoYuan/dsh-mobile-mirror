package dev.dsh.mirror.client.net

import android.content.Context
import org.json.JSONObject

/** 一个推理档位（插件拍平后的 `models[].efforts[]`）。 */
class ModelEffort(val id: String, val name: String, val description: String)

/** 一个模型。 */
class ModelInfo(
    val id: String,
    val name: String,
    val description: String,
    val efforts: List<ModelEffort>,
    /** 没选过档位时用它（插件拍平后的 `models[].defaultEffort`）。 */
    val defaultEffort: String,
)

/** 一组模型（一个 provider）。 */
class ModelGroup(val id: String, val name: String, val models: List<ModelInfo>)

/** 拉不动的 provider：列出来让人知道为什么少了东西，但不可选。 */
class ModelFailure(val id: String, val name: String, val message: String)

/** `GET /api/models` 的目录。 */
class ModelCatalog(
    val defaultProvider: String,
    val defaultModel: String,
    val defaultEffort: String,
    val groups: List<ModelGroup>,
    val failures: List<ModelFailure>,
) {

    fun find(provider: String, model: String): ModelInfo? {
        for (g in groups) {
            if (g.id != provider) continue
            for (m in g.models) if (m.id == model) return m
        }
        return null
    }

    /** 界面上显示的名字：目录里有就用目录的，没有（或还没拉到目录）就退回 id。 */
    fun label(provider: String, model: String): String = find(provider, model)?.name ?: model

    /** 档位的显示名；找不到就给 id。 */
    fun effortLabel(provider: String, model: String, effort: String): String {
        if (effort.isEmpty()) return ""
        val row = find(provider, model) ?: return effort
        for (e in row.efforts) if (e.id == effort) return e.name
        return effort
    }
}

/** `GET /api/presets` 的一行。`broken` 非空表示这个模式当前不可用（自带原因）。 */
class PresetRow(val id: String, val label: String, val description: String, val broken: String)

/** 会话级选中的模型。`effort` 为空 = 用该模型的默认档。 */
data class ModelPick(val provider: String, val model: String, val effort: String = "")

/** 一次读取（目录 / 模式清单）。 */
sealed class ReadResult<out T> {
    class Ok<T>(val value: T) : ReadResult<T>()
    /** 拿不到，{@code message} 是能给用户看的话。 */
    class Failed(val message: String) : ReadResult<Nothing>()
}

/** 一次切换的结果。 */
sealed class PickOutcome {
    /** 成功。切模式时 {@code label} 是服务端回的中文名（切模型时为空）。 */
    class Ok(val label: String = "") : PickOutcome()
    object Expired : PickOutcome()
    /**
     * 服务端明确拒绝 —— 尤其是 409 `preset-locked`（跑过一轮就锁死）。
     *
     * @param code 服务端的 `error` 代码（`preset-locked` / `preset-invalid` / `agent-not-live`…），
     *             界面靠它决定是「置灰这一整段」还是只报个错。
     */
    class Rejected(val message: String, val code: String = "") : PickOutcome()
    object Unreachable : PickOutcome()
}

/**
 * 模型目录与模式清单（0.12）。
 *
 * <p>契约（`lib/server.js` + `lib/mirror.js`）：
 * `GET /api/models` 要控制器就绪（没就绪回 503），插件侧带 60 秒 TTL 缓存；
 * `POST /api/model` 是**会话级**选择、对**下一次请求**生效（正在跑的轮次不受影响）；
 * `POST /api/preset` 只在**还没跑过轮次**的会话上放行，否则 409 `preset-locked`。
 */
object Models {

    /** 拉模型目录。 */
    suspend fun catalog(ctx: Context): ReadResult<ModelCatalog> =
        when (val r = MirrorSession.fetch(ctx, "/api/models")) {
            is Fetch.Ok -> jsonReader(r.body)?.let { catalogOf(it) }?.let { ReadResult.Ok(it) }
                ?: ReadResult.Failed("模型目录看不懂")
            is Fetch.Failed -> ReadResult.Failed(errText(r.code, r.body))
            Fetch.Expired -> ReadResult.Failed("登录已失效")
            Fetch.Unreachable -> ReadResult.Failed("连不上电脑")
        }

    /** 拉模式清单。**不需要控制器**，只读模式也能看。 */
    suspend fun presets(ctx: Context): ReadResult<List<PresetRow>> =
        when (val r = MirrorSession.fetch(ctx, "/api/presets")) {
            is Fetch.Ok -> jsonReader(r.body)?.let { ReadResult.Ok(parsePresets(it)) }
                ?: ReadResult.Failed("模式清单看不懂")
            is Fetch.Failed -> ReadResult.Failed(errText(r.code, r.body))
            Fetch.Expired -> ReadResult.Failed("登录已失效")
            Fetch.Unreachable -> ReadResult.Failed("连不上电脑")
        }

    /** 切某个会话的模型。`effort` 为空就不下发 `reasoningEffort`（用宿主默认）。 */
    suspend fun select(ctx: Context, sessionId: String, pick: ModelPick): PickOutcome {
        val payload = JSONObject()
            .put("sessionId", sessionId)
            .put("provider", pick.provider)
            .put("model", pick.model)
        if (pick.effort.isNotEmpty()) payload.put("reasoningEffort", pick.effort)
        return when (val r = MirrorSession.postJson(ctx, "/api/model", payload.toString())) {
            is Send.Ok -> PickOutcome.Ok()
            is Send.Rejected -> PickOutcome.Rejected(errText(r.code, r.body), jsonErrorCode(r.body))
            Send.Expired -> PickOutcome.Expired
            Send.Unreachable -> PickOutcome.Unreachable
        }
    }

    /** 切某个会话的模式。成功时把服务端回的中文名一起带出来。 */
    suspend fun selectPreset(ctx: Context, sessionId: String, preset: String): PickOutcome {
        val payload = JSONObject().put("sessionId", sessionId).put("preset", preset)
        return when (val r = MirrorSession.postJson(ctx, "/api/preset", payload.toString())) {
            is Send.Ok -> PickOutcome.Ok(parseSelectedLabel(r.body))
            is Send.Rejected -> PickOutcome.Rejected(errText(r.code, r.body), jsonErrorCode(r.body))
            Send.Expired -> PickOutcome.Expired
            Send.Unreachable -> PickOutcome.Unreachable
        }
    }

    /**
     * 剥掉 `GET /api/models` 的 `{catalog:{…}}` 外壳。
     *
     * <p>单独抽出来是为了**能被单测钉住**：0.12 就是把根对象直接喂给了 [parseCatalog]，
     * 根上没有 `groups` / `default`，于是解析出一个空目录 —— 卡片里一个模型都没有，
     * 表现是"选不了模型"，而接口明明 200。
     *
     * @return 目录对象；没有 `catalog` 这个键（形状变了）就给 null。
     */
    fun catalogOf(r: FieldReader): ModelCatalog? = r.obj("catalog")?.let { parseCatalog(it) }

    /**
     * 解析目录对象本体（壳见 [catalogOf]）。
     *
     * <p>**档位是拍平的**：插件侧 `normalizeModelCatalog` 把上游的
     * `reasoning.efforts` / `reasoning.defaultEffort` 提到了模型自己的
     * `efforts` / `defaultEffort` 上（`lib/mirror.js` 的 models.push）。
     * 0.12 按 `reasoning.efforts` 找，永远找不到 —— 档位行一直是空的。
     *
     * <p>空组过滤（上游 `buildModelCatalog` 也这么做，免得面板出现空标题）；
     * `name` 缺失一律退回 id —— 上游 `resolveModelInfo` 失败时就是没名字。
     */
    fun parseCatalog(r: FieldReader): ModelCatalog {
        val def = r.obj("default")
        val groups = ArrayList<ModelGroup>(4)
        for (g in r.arr("groups")) {
            val models = ArrayList<ModelInfo>(8)
            for (m in g.arr("models")) {
                val id = m.str("id")
                if (id.isEmpty()) continue
                val efforts = ArrayList<ModelEffort>(4)
                for (e in m.arr("efforts")) {
                    val eid = e.str("id")
                    if (eid.isEmpty()) continue
                    efforts.add(ModelEffort(eid, e.str("name").ifEmpty { eid }, e.str("description")))
                }
                models.add(
                    ModelInfo(
                        id = id,
                        name = m.str("name").ifEmpty { id },
                        description = m.str("description"),
                        efforts = efforts,
                        defaultEffort = m.str("defaultEffort"),
                    ),
                )
            }
            if (models.isEmpty()) continue
            val gid = g.str("id")
            groups.add(ModelGroup(gid, g.str("name").ifEmpty { gid }.ifEmpty { "其他" }, models))
        }
        val failures = ArrayList<ModelFailure>(2)
        for (f in r.arr("failures")) {
            val fid = f.str("id")
            failures.add(
                ModelFailure(
                    id = fid,
                    name = f.str("name").ifEmpty { fid }.ifEmpty { "未知 provider" },
                    message = f.str("message").ifEmpty { "不可用" },
                ),
            )
        }
        return ModelCatalog(
            defaultProvider = def?.str("provider").orEmpty(),
            defaultModel = def?.str("model").orEmpty(),
            defaultEffort = def?.str("reasoningEffort").orEmpty(),
            groups = groups,
            failures = failures,
        )
    }

    /** 解析 `{presets:[…]}`。没有 id 的行直接丢掉。 */
    fun parsePresets(r: FieldReader): List<PresetRow> {
        val out = ArrayList<PresetRow>(4)
        for (p in r.arr("presets")) {
            val id = p.str("id")
            if (id.isEmpty()) continue
            out.add(PresetRow(id, p.str("label").ifEmpty { id }, p.str("description"), p.str("broken")))
        }
        return out
    }

    /**
     * 解析「当前选中的模型」。
     *
     * <p>同一份形状有两个来源：快照投影里的 `modelSelection.next`，
     * 以及长连接期间的 `model/selection` 事件 —— 所以只写一个解析。
     */
    fun parseSelection(r: FieldReader): ModelPick =
        ModelPick(r.str("provider"), r.str("model"), r.str("reasoningEffort"))

    /** 错误体 → 一句能给用户看的话（服务端那句中文说明优先，没有就退回状态码）。 */
    private fun errText(code: Int, body: String): String = httpErrorText(code, jsonMessage(body))

    /** 从 `{selected, label}` 里取中文名（取不到给空串，界面会退回 id）。 */
    private fun parseSelectedLabel(body: String): String =
        try { JSONObject(body).optString("label") } catch (_: Throwable) { "" }
}