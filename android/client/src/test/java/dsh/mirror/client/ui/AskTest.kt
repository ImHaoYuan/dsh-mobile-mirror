package dsh.mirror.client.ui

import dsh.mirror.client.net.AskAnswer
import dsh.mirror.client.net.AskQuestion
import dsh.mirror.client.net.Questions
import dsh.mirror.client.net.httpErrorText
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/*
 * 提问卡（0.11）的纯逻辑契约。
 *
 * 这里钉住三件会让答案被**整批拒掉**、或者卡片干脆不出现的事：
 *   ① 帧解析：题目 id / 选项 / 多选要认得对（认错 id，答案就对不上题目）；
 *   ② 「能不能提交」的判据（宿主要求每题要么选、要么写，否则 400 `empty-answer`）；
 *   ③ 下发形状（`custom` 为空时整个字段都不能出现，空串要丢掉）。
 *
 * 注意用的是 MapReader（TestJson.kt）而不是 JSONObject：Android 单测跑在桩 android.jar 上，
 * `org.json` 的方法一律抛 `Method … not mocked`（见 net/FieldReader.kt 的说明）。
 * 字段名本身仍然是被测到的 —— 名字写在 `Questions.parseBatch` 里，不在这里。
 */

private fun q(id: String, header: String = "", text: String = "问题", multi: Boolean = false) =
    AskQuestion(id, header, text, emptyList(), multi)

class AskTest {

    // —————————————————————— 帧解析 ——————————————————————

    @Test
    fun `解析一条 question 帧`() {
        val d = frame(
            "id" to "q1",
            "sessionId" to "s-1",
            "createdAt" to 123L,
            "questions" to listOf(
                mapOf(
                    "id" to "a",
                    "header" to "范围",
                    "question" to "选哪个？",
                    "multiSelect" to false,
                    "options" to listOf(
                        mapOf("label" to "小", "description" to "只改这一处"),
                        mapOf("label" to "大"),
                    ),
                ),
            ),
        )
        val b = Questions.parseBatch(d)!!
        assertEquals("q1", b.id)
        assertEquals("s-1", b.sessionId)
        assertEquals(123L, b.createdAt)
        assertEquals(1, b.questions.size)
        val one = b.questions[0]
        assertEquals("a", one.id)
        assertEquals("范围", one.header)
        assertEquals("选哪个？", one.text)
        assertFalse(one.multiSelect)
        assertEquals(2, one.options.size)
        assertEquals("小", one.options[0].label)
        assertEquals("只改这一处", one.options[0].description)
        // 没有 description 的选项给空串，不是 null —— 界面直接判 isEmpty
        assertEquals("", one.options[1].description)
    }

    @Test
    fun `多选标记认得出来`() {
        val d = frame("id" to "q", "questions" to listOf(mapOf("id" to "a", "multiSelect" to true)))
        assertTrue(Questions.parseBatch(d)!!.questions[0].multiSelect)
        // 缺字段时按单选
        val d2 = frame("id" to "q", "questions" to listOf(mapOf("id" to "a")))
        assertFalse(Questions.parseBatch(d2)!!.questions[0].multiSelect)
    }

    @Test
    fun `没有 id 的题目被丢掉`() {
        // 答案按 id 对齐，交不上去的题留着只会让整批答案被拒
        val d = frame(
            "id" to "q",
            "questions" to listOf(mapOf("question" to "没有 id"), mapOf("id" to "b")),
        )
        val b = Questions.parseBatch(d)!!
        assertEquals(1, b.questions.size)
        assertEquals("b", b.questions[0].id)
    }

    @Test
    fun `没有 label 的选项被丢掉`() {
        val d = frame(
            "id" to "q",
            "questions" to listOf(
                mapOf(
                    "id" to "a",
                    "options" to listOf(mapOf("description" to "没标签"), mapOf("label" to "好")),
                ),
            ),
        )
        val one = Questions.parseBatch(d)!!.questions[0]
        assertEquals(1, one.options.size)
        assertEquals("好", one.options[0].label)
    }

    @Test
    fun `一道题都解析不出来就整帧丢掉`() {
        assertNull(Questions.parseBatch(frame("sessionId" to "s")))
        assertNull(Questions.parseBatch(frame("id" to "q")))
        assertNull(
            Questions.parseBatch(
                frame("id" to "q", "questions" to listOf(mapOf("question" to "没有 id"))),
            ),
        )
    }

    @Test
    fun `没有选项的题目也能解析（纯自由问答）`() {
        val d = frame("id" to "q", "questions" to listOf(mapOf("id" to "a", "question" to "说吧")))
        val b = Questions.parseBatch(d)!!
        assertEquals(0, b.questions[0].options.size)
        assertEquals("说吧", b.questions[0].text)
    }

    // —————————————————————— 能不能提交 ——————————————————————

    @Test
    fun `选了选项就能提交`() {
        val qs = listOf(q("a"), q("b"))
        assertTrue(AskLogic.ready(qs, mapOf("a" to listOf("小"), "b" to listOf("大")), emptyMap()))
    }

    @Test
    fun `只写了自定义答案也能提交`() {
        assertTrue(AskLogic.ready(listOf(q("a")), emptyMap(), mapOf("a" to "我想想")))
    }

    @Test
    fun `漏掉一道题就不给提交`() {
        val qs = listOf(q("a"), q("b"))
        assertFalse(AskLogic.ready(qs, mapOf("a" to listOf("小")), emptyMap()))
    }

    @Test
    fun `只有空白字符不算答了`() {
        assertFalse(AskLogic.ready(listOf(q("a")), mapOf("a" to listOf("  ")), mapOf("a" to " \n ")))
    }

    @Test
    fun `一道题都没有时不给提交`() {
        assertFalse(AskLogic.ready(emptyList(), emptyMap(), emptyMap()))
    }

    // —————————————————————— 组装与下发形状 ——————————————————————

    @Test
    fun `答案按题目顺序组装`() {
        val qs = listOf(q("a"), q("b"))
        val out = AskLogic.answers(qs, mapOf("b" to listOf("2")), mapOf("a" to "手写"))
        assertEquals(2, out.size)
        assertEquals("a", out[0].id)
        assertEquals("手写", out[0].custom)
        assertEquals(0, out[0].selected.size)
        assertEquals("b", out[1].id)
        assertEquals(listOf("2"), out[1].selected)
        assertNull(out[1].custom)
    }

    @Test
    fun `自定义答案为空时置 null（下发时整个字段都不出现）`() {
        // 下发空串会被判成「既没选、也没写」（empty-answer）
        val out = Questions.cleanAnswers(listOf(AskAnswer("a", listOf("小"), "")))
        assertNull(out[0].custom)
        assertEquals(listOf("小"), out[0].selected)
    }

    @Test
    fun `空白的选项与自定义答案都被丢掉、两侧空白被剪掉`() {
        val out = Questions.cleanAnswers(listOf(AskAnswer("a", listOf(" ", "  小  "), "  手写  ")))
        assertEquals(listOf("小"), out[0].selected)
        assertEquals("手写", out[0].custom)
    }

    @Test
    fun `多选答案一项都不丢`() {
        val out = Questions.cleanAnswers(listOf(AskAnswer("a", listOf("一", "二", "三"), null)))
        assertEquals(listOf("一", "二", "三"), out[0].selected)
        assertNull(out[0].custom)
    }

    // —————————————————————— 错误文案 ——————————————————————

    @Test
    fun `服务端的中文说明优先`() {
        assertEquals(
            "题目 a 既没选选项、也没填自定义答案",
            httpErrorText(400, "题目 a 既没选选项、也没填自定义答案"),
        )
    }

    @Test
    fun `没有 message 时退回状态码`() {
        assertEquals("HTTP 502", httpErrorText(502, null))
        assertEquals("HTTP 500", httpErrorText(500, ""))
        assertEquals("HTTP 400", httpErrorText(400, "   "))
    }
}