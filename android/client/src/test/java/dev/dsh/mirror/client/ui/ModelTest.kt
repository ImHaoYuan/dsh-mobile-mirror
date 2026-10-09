package dev.dsh.mirror.client.ui

import dev.dsh.mirror.client.net.ModelPick
import dev.dsh.mirror.client.net.Models
import dev.dsh.mirror.client.net.httpErrorText
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/*
 * 模型 / 模式（0.12）的纯逻辑契约。
 *
 * 这里钉住三类会**静默出错**的事：
 *   ① 目录解析：id / 名字 / 档位对不上，胶囊就会显示错的模型名，甚至把档位发给别的模型；
 *   ② 「点一个模型该带哪个档位」：带错了就是悄悄改掉用户的推理档；
 *   ③ 兜底：目录拉不到时不能空着、不能崩（`/api/models` 要控制器就绪，刚启动时可能 503）。
 *
 * 用 MapReader（TestJson.kt）而不是 JSONObject，原因见 net/FieldReader.kt。
 */
class ModelTest {

    /**
     * 一份**插件真实形状**的响应体。
     *
     * 两个地方必须照抄插件的输出，不能照抄上游 DSH 的形状 —— 0.12 就是照抄上游才出的错：
     *   ① 外壳 `{catalog:{…}}` 必须剥（`catalogOf`）；
     *   ② 档位是**拍平**的 `defaultEffort` / `efforts`，不是 `reasoning.defaultEffort` /
     *      `reasoning.efforts`（见 `normalizeModelCatalog`）。
     */
    private fun catalog() = Models.catalogOf(
        frame(
            "catalog" to mapOf(
                "default" to mapOf("provider" to "deepseek", "model" to "v4", "reasoningEffort" to "medium"),
                "groups" to listOf(
                    mapOf(
                        "id" to "deepseek",
                        "name" to "DeepSeek",
                        "models" to listOf(
                            mapOf(
                                "id" to "v4",
                                "name" to "V4",
                                "description" to "通用",
                                "defaultEffort" to "medium",
                                "efforts" to listOf(
                                    mapOf("id" to "low", "name" to "低", "description" to "快"),
                                    mapOf("id" to "high", "name" to "高"),
                                ),
                            ),
                            mapOf("id" to "v4-flash", "name" to "V4 Flash"),
                        ),
                    ),
                ),
                "failures" to listOf(mapOf("id" to "kimi", "name" to "Kimi", "message" to "鉴权失败")),
            ),
        ),
    )!!

    // —————————————————————— 目录解析 ——————————————————————

    @Test
    fun `解析模型目录`() {
        val c = catalog()
        assertEquals("deepseek", c.defaultProvider)
        assertEquals("v4", c.defaultModel)
        assertEquals("medium", c.defaultEffort)
        assertEquals(1, c.groups.size)
        val g = c.groups[0]
        assertEquals("deepseek", g.id)
        assertEquals("DeepSeek", g.name)
        assertEquals(2, g.models.size)
        val m = g.models[0]
        assertEquals("V4", m.name)
        assertEquals("通用", m.description)
        assertEquals("medium", m.defaultEffort)
        assertEquals(listOf("low", "high"), m.efforts.map { it.id })
        assertEquals("低", m.efforts[0].name)
        assertEquals("快", m.efforts[0].description)
        // 没有 efforts 的模型：档位空表，默认档空串（不是 null，界面不用再判一次）
        assertTrue(g.models[1].efforts.isEmpty())
        assertEquals("", g.models[1].defaultEffort)
        assertEquals(1, c.failures.size)
        assertEquals("Kimi", c.failures[0].name)
        assertEquals("鉴权失败", c.failures[0].message)
    }

    @Test
    fun `没有 id 的模型和没有模型的组都丢掉`() {
        val c = Models.parseCatalog(
            frame(
                "groups" to listOf(
                    mapOf("id" to "empty", "name" to "空组", "models" to emptyList<Any?>()),
                    mapOf("id" to "p", "models" to listOf(mapOf("name" to "没 id"), mapOf("id" to "ok"))),
                ),
            ),
        )
        // 空组不留标题；没有 id 的模型留着只会是个点不动的死条目
        assertEquals(1, c.groups.size)
        assertEquals(listOf("ok"), c.groups[0].models.map { it.id })
    }

    @Test
    fun `名字取不到就退回 id`() {
        val c = Models.parseCatalog(
            frame(
                "groups" to listOf(
                    mapOf("id" to "p", "models" to listOf(mapOf("id" to "m"))),
                ),
                "failures" to listOf(mapOf("id" to "x")),
            ),
        )
        assertEquals("p", c.groups[0].name)
        assertEquals("m", c.groups[0].models[0].name)
        assertEquals("x", c.failures[0].name)
        assertEquals("不可用", c.failures[0].message)
    }

    @Test
    fun `空响应不炸`() {
        val c = Models.parseCatalog(frame())
        assertEquals("", c.defaultProvider)
        assertEquals("", c.defaultModel)
        assertTrue(c.groups.isEmpty())
        assertTrue(c.failures.isEmpty())
        assertNull(c.find("a", "b"))
    }

    @Test
    fun `响应体外壳必须剥掉`() {
        // 真实响应是 {catalog:{…}}。0.12 把根对象直接当目录解析，根上没有 groups/default，
        // 于是得到一个空目录 —— 卡片里一个模型都不显示，看着像「选不了模型」。
        val wrapped = frame(
            "catalog" to mapOf(
                "groups" to listOf(mapOf("id" to "p", "models" to listOf(mapOf("id" to "m")))),
            ),
        )
        assertEquals(listOf("m"), Models.catalogOf(wrapped)!!.groups[0].models.map { it.id })
        // 没剥壳（或形状变了）就明说解析不了，不能悄悄给个空目录
        assertNull(Models.catalogOf(frame("groups" to listOf(mapOf("id" to "p")))))
        assertNull(Models.catalogOf(frame()))
    }

    @Test
    fun `null 字段退化成空串`() {
        // 插件对「没有」一律写 JSON null（loadPresetRoster 的 description / broken、
        // 模型描述、defaultEffort）。而 org.json 的 optString 会把 JSON null 变成
        // **字符串 "null"** —— 界面上就是每行底下写着 null。JsonReader 负责挡掉它
        // （那半边碰不了 org.json，只能靠注释钉住），这里钉住解析规则这一半。
        val rows = Models.parsePresets(
            frame(
                "presets" to listOf(
                    mapOf("id" to "standard", "label" to "标准", "description" to null, "broken" to null),
                ),
            ),
        )
        assertEquals("", rows[0].description)
        assertEquals("", rows[0].broken)

        val c = Models.parseCatalog(
            frame(
                "groups" to listOf(
                    mapOf(
                        "id" to "p",
                        "models" to listOf(
                            mapOf(
                                "id" to "m",
                                "description" to null,
                                "defaultEffort" to null,
                                "efforts" to listOf(mapOf("id" to "low", "name" to "低", "description" to null)),
                            ),
                        ),
                    ),
                ),
            ),
        )
        assertEquals("", c.groups[0].models[0].description)
        assertEquals("", c.groups[0].models[0].defaultEffort)
        assertEquals("", c.groups[0].models[0].efforts[0].description)
    }

    // —————————————————————— 模式清单 ——————————————————————

    @Test
    fun `解析模式清单`() {
        val rows = Models.parsePresets(
            frame(
                "presets" to listOf(
                    mapOf("id" to "standard", "label" to "标准", "description" to "默认", "broken" to ""),
                    mapOf("id" to "cordis", "label" to "创造", "broken" to "插件没装全"),
                ),
            ),
        )
        assertEquals(2, rows.size)
        assertEquals("标准", rows[0].label)
        assertEquals("", rows[0].broken)
        assertEquals("插件没装全", rows[1].broken)
    }

    @Test
    fun `模式清单里没有 id 的行丢掉`() {
        val rows = Models.parsePresets(frame("presets" to listOf(mapOf("label" to "孤儿"), mapOf("id" to "a"))))
        assertEquals(1, rows.size)
        assertEquals("a", rows[0].id)
        // label 缺失退回 id
        assertEquals("a", rows[0].label)
    }

    @Test
    fun `解析当前选中的模型`() {
        val p = Models.parseSelection(frame("provider" to "p", "model" to "m", "reasoningEffort" to "high"))
        assertEquals(ModelPick("p", "m", "high"), p)
        // 档位可以缺席（宿主没选过就是 null）
        assertEquals("", Models.parseSelection(frame("provider" to "p", "model" to "m")).effort)
    }

    // —————————————————————— 胶囊上的字 ——————————————————————

    @Test
    fun `胶囊文字拼模型名与档位`() {
        val c = catalog()
        assertEquals("V4 · 低", ModelLogic.capsuleText(c, ModelPick("deepseek", "v4", "low"), "模型"))
        assertEquals("V4 · 高", ModelLogic.capsuleText(c, ModelPick("deepseek", "v4", "high"), "模型"))
        // 没选档位就只显示模型名
        assertEquals("V4", ModelLogic.capsuleText(c, ModelPick("deepseek", "v4", ""), "模型"))
        assertEquals("V4 Flash", ModelLogic.capsuleText(c, ModelPick("deepseek", "v4-flash", ""), "模型"))
    }

    @Test
    fun `胶囊文字在目录没到手时退回 id`() {
        // 目录还没拉到：不能空着，也不能崩 —— 名字退回 id，档位退回 id
        assertEquals("v4 · high", ModelLogic.capsuleText(null, ModelPick("deepseek", "v4", "high"), "模型"))
        // 模型都没拿到（快照还没来）用兜底字
        assertEquals("模型", ModelLogic.capsuleText(null, ModelPick("", ""), "模型"))
    }

    @Test
    fun `目录里没有的模型名退回 id 档位退回原样`() {
        val c = catalog()
        assertEquals("ghost · high", ModelLogic.capsuleText(c, ModelPick("deepseek", "ghost", "high"), "模型"))
        // 模型在目录里、但档位不是它支持的：也照原样显示，不吞掉
        assertEquals("V4 · ultra", ModelLogic.capsuleText(c, ModelPick("deepseek", "v4", "ultra"), "模型"))
    }

    // —————————————————————— 点一个模型带哪个档位 ——————————————————————

    @Test
    fun `点当前模型沿用当前档位`() {
        val c = catalog()
        // 用户刚把档位调到 high，再点一次同一个模型不该把它打回默认的 medium
        assertEquals("high", ModelLogic.effortFor(c, ModelPick("deepseek", "v4", "high"), "deepseek", "v4"))
    }

    @Test
    fun `点别的模型用它自己的默认档`() {
        val c = catalog()
        // v4-flash 没有 reasoning，默认档是空串 → 不沿用 high，也不下发 reasoningEffort
        assertEquals("", ModelLogic.effortFor(c, ModelPick("deepseek", "v4", "high"), "deepseek", "v4-flash"))
        assertEquals("", ModelLogic.effortFor(null, ModelPick("a", "b", "high"), "p", "m"))
    }

    // —————————————————————— 模式名 ——————————————————————

    @Test
    fun `模式名按清单翻译`() {
        val labels = mapOf("standard" to "标准", "cordis" to "创造")
        assertEquals("标准", ModelLogic.presetText(labels, "standard", "默认模式"))
        // 清单里没有（刚建会话、或宿主换了新 id）：退回 id，不能显示空白
        assertEquals("brand-new", ModelLogic.presetText(labels, "brand-new", "默认模式"))
        assertEquals("默认模式", ModelLogic.presetText(labels, "", "默认模式"))
    }

    // —————————————————————— 错误文案 ——————————————————————

    @Test
    fun `错误文案服务端说明优先`() {
        assertEquals("这个会话已经不能改模式了", httpErrorText(409, "这个会话已经不能改模式了"))
        assertEquals("HTTP 503", httpErrorText(503, null))
        assertEquals("HTTP 400", httpErrorText(400, "  "))
    }
}
