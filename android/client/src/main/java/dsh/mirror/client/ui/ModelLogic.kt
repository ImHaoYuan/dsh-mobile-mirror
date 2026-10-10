package dsh.mirror.client.ui

import dsh.mirror.client.net.ModelCatalog
import dsh.mirror.client.net.ModelPick

/**
 * 模型 / 模式胶囊的**纯逻辑**（抽出来是为了能单测：档位挑错了会静默换掉用户的推理档）。
 *
 * <p>判断口径与网页端 `app.js` 的 `modelOption` / `selectionOf` 一致。
 */
object ModelLogic {

    /**
     * 胶囊上的字：`模型名 · 档位名`。
     *
     * <p>目录还没拉到时退回 id（拉不到目录不该让胶囊空着）；模型都没拿到时用
     * [fallback]（会话页给「模型」，首页给目录默认值）。
     */
    fun capsuleText(catalog: ModelCatalog?, pick: ModelPick, fallback: String): String {
        val name = when {
            pick.model.isEmpty() -> fallback
            catalog == null -> pick.model
            else -> catalog.label(pick.provider, pick.model)
        }
        val effort = if (pick.effort.isEmpty()) "" else effortLabel(catalog, pick, pick.effort)
        return if (effort.isEmpty()) name else name + " · " + effort
    }

    /** 档位的显示名（目录里找不到就给 id 本身）。 */
    fun effortLabel(catalog: ModelCatalog?, pick: ModelPick, effort: String): String =
        if (catalog == null) effort else catalog.effortLabel(pick.provider, pick.model, effort)

    /**
     * 点一个模型时该带上哪个档位。
     *
     * <p>网页端同款：点**正在用的**那个就沿用当前档位（用户可能刚调过），
     * 点别的就用那个模型自己的默认档 —— 不沿用，否则会把 A 模型的档位塞给 B。
     */
    fun effortFor(catalog: ModelCatalog?, current: ModelPick, provider: String, model: String): String {
        if (current.provider == provider && current.model == model) return current.effort
        return catalog?.find(provider, model)?.defaultEffort.orEmpty()
    }

    /** 模式的名字：清单里有就用 `label`，没有就退回 id。 */
    fun presetText(labels: Map<String, String>, id: String, fallback: String): String =
        when {
            id.isEmpty() -> fallback
            else -> labels[id] ?: id
        }
}