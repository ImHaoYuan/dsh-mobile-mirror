package dev.dsh.mirror.client.ui

import dev.dsh.mirror.client.net.FieldReader

/**
 * 测试用的假 JSON：**一张 Map 当一份响应体**。
 *
 * <p>为什么不直接用 `JSONObject`：Android 单测跑在桩 `android.jar` 上，`org.json` 的方法
 * 一律抛 `Method … not mocked`（见 `net/FieldReader.kt` 的说明）。字段名本身仍然被覆盖 ——
 * 名字写在各个 `parse*` 里，这里只负责把 Map 递进去。
 *
 * <p>`mapOf("id" to "q1", "questions" to listOf(mapOf(...)))` 这样用。
 */
class MapReader(private val m: Map<String, Any?>) : FieldReader {

    override fun str(name: String): String = m[name] as? String ?: ""

    override fun bool(name: String, def: Boolean): Boolean = m[name] as? Boolean ?: def

    override fun long(name: String, def: Long): Long = (m[name] as? Number)?.toLong() ?: def

    override fun obj(name: String): FieldReader? {
        @Suppress("UNCHECKED_CAST")
        val map = m[name] as? Map<String, Any?> ?: return null
        return MapReader(map)
    }

    override fun arr(name: String): List<FieldReader> {
        val list = m[name] as? List<*> ?: return emptyList()
        val out = ArrayList<FieldReader>(list.size)
        for (item in list) {
            @Suppress("UNCHECKED_CAST")
            val map = item as? Map<String, Any?> ?: continue
            out.add(MapReader(map))
        }
        return out
    }
}

/** 顶层的 Map 当帧用（省掉每次 `MapReader(mapOf(…))`）。 */
fun frame(vararg pairs: Pair<String, Any?>): FieldReader = MapReader(mapOf(*pairs))
