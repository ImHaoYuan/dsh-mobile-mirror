package dsh.mirror.client.net

import org.json.JSONObject

/**
 * 从一份 JSON 里取字段的最小接口。
 *
 * <p>存在的唯一理由是**可测**：Android 单测跑在桩 `android.jar` 上，
 * `org.json.JSONObject` 的方法一律抛 `Method … not mocked`，所以解析规则
 * （{@link Questions#parseBatch(FieldReader)}、{@link Models#parseCatalog(FieldReader)} 等）
 * 不能直接吃 JSONObject。生产路径用 [JsonReader]，测试给一张 Map 就够了。
 *
 * <p>字段名写在各个 `parse*` 里，所以「键名对不对」这件事仍然是被单测覆盖的；
 * [JsonReader] 只剩转发。
 */
interface FieldReader {
    fun str(name: String): String

    fun bool(name: String, def: Boolean): Boolean

    fun long(name: String, def: Long): Long

    /** 名字对不上、或不是对象时给 null。 */
    fun obj(name: String): FieldReader?

    /** 名字对不上、或不是数组时给空表；数组里的非对象项直接跳过。 */
    fun arr(name: String): List<FieldReader>
}

/** [FieldReader] 的 `org.json` 实现（只是转发，判断都在各自的 parse 里）。 */
internal class JsonReader(private val o: JSONObject) : FieldReader {

    // 必须挡 JSON null：org.json 的 `optString` 对 JSON null 返回的是**字符串 "null"**，
    // 不是空串。插件里凡是"没有就写 null"的字段（模式描述、broken、模型描述、
    // defaultEffort）都会因此显示成字面的 null。`isNull` 对"键不存在"也返回 true，
    // 两种情况都该退化成空串。
    override fun str(name: String): String = if (o.isNull(name)) "" else o.optString(name)

    override fun bool(name: String, def: Boolean): Boolean = o.optBoolean(name, def)

    override fun long(name: String, def: Long): Long = o.optLong(name, def)

    override fun obj(name: String): FieldReader? = o.optJSONObject(name)?.let { JsonReader(it) }

    override fun arr(name: String): List<FieldReader> {
        val a = o.optJSONArray(name) ?: return emptyList()
        val out = ArrayList<FieldReader>(a.length())
        for (i in 0 until a.length()) {
            val item = a.optJSONObject(i) ?: continue
            out.add(JsonReader(item))
        }
        return out
    }
}

/** 把一段响应体包成 [FieldReader]（不是 JSON 就给 null）。 */
internal fun jsonReader(body: String): FieldReader? =
    try { JsonReader(JSONObject(body)) } catch (_: Throwable) { null }

/** 从错误体里抠出服务端那句中文说明；不是 JSON、或没这个字段，都给 null。 */
fun jsonMessage(body: String): String? = try {
    JSONObject(body).optString("message").takeIf { it.isNotEmpty() }
} catch (_: Throwable) {
    null
}

/** 从错误体里抠出 `error` 代码（`preset-locked` 这类要靠它决定界面怎么反应）。 */
fun jsonErrorCode(body: String): String =
    try { JSONObject(body).optString("error") } catch (_: Throwable) { "" }

/** 服务端写好的说明优先，没有就退回状态码（纯函数，可测）。 */
fun httpErrorText(code: Int, message: String?): String =
    message?.takeIf { it.isNotBlank() } ?: ("HTTP " + code)