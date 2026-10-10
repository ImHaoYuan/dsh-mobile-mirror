package dsh.mirror.client.net

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/*
 * 「侧栏彻底不显示子智能体」（0.15.8）的纯逻辑契约。
 *
 * 这里钉住四件会**看得见但说不通**的事：
 *   ① 子会话（origin=subagent，或带 parentSessionId）不出现在列表里；
 *   ② 过滤后为空的分组整块丢掉 —— 否则会留下一个只写着工作区名和 "0" 的分组头；
 *   ③ 分组的运行圆点按**看得见的行**重算（圆点点亮却找不到谁在跑，比不亮更困惑）；
 *   ④ 普通会话与分组的名字 / 路径原样保留。
 *
 * 边界：父会话不在本组的"孤儿子会话"同样要滤掉 —— 判据只看它自己
 * （groups 是按工作区分组的，父子跨工作区是真会发生的）。
 */
class SessionsTest {

    private fun row(
        id: String,
        running: Boolean = false,
        origin: String? = null,
        parent: String? = null,
        question: Boolean = false,
    ) = SessionRow(
        id = id,
        title = id,
        running = running,
        blank = false,
        agentAvailable = true,
        updatedAt = 0L,
        cwd = "D:\\proj\\alpha",
        origin = origin,
        parentSessionId = parent,
        pendingQuestion = question,
        preset = null,
    )

    private fun group(key: String, name: String, running: Boolean, items: List<SessionRow>) =
        SessionGroup(key = key, name = name, path = "D:\\proj\\" + name, items = items, running = running)

    @Test
    fun dropsChildrenByOriginAndByParent() {
        val plain = row("plain")
        val byOrigin = row("child-origin", origin = "subagent")
        val byParent = row("child-parent", parent = "parent")
        val parent = row("parent")
        val groups = listOf(group("a", "alpha", false, listOf(plain, byOrigin, byParent, parent)))

        val out = Sessions.withoutChildren(groups)

        assertEquals(1, out.size)
        assertEquals(listOf("plain", "parent"), out[0].items.map { it.id })
    }

    @Test
    fun dropsOrphanChildWhoseParentIsElsewhere() {
        // 父会话不在本组（跨工作区）也不能漏过去：判据只看它自己
        val orphan = row("orphan", parent = "not-in-this-group")
        val plain = row("plain")
        val groups = listOf(group("a", "alpha", false, listOf(orphan, plain)))

        val out = Sessions.withoutChildren(groups)

        assertEquals(listOf("plain"), out[0].items.map { it.id })
    }

    @Test
    fun dropsGroupThatBecomesEmpty() {
        val onlyChildren = listOf(row("c1", origin = "subagent"), row("c2", parent = "p1"))
        val groups = listOf(
            group("only-kids", "kidsonly", true, onlyChildren),
            group("normal", "normal", false, listOf(row("plain"))),
        )

        val out = Sessions.withoutChildren(groups)

        assertEquals(listOf("normal"), out.map { it.key })
    }

    @Test
    fun recomputesGroupRunningFromVisibleRows() {
        // 跑着的只有子会话 → 过滤后这一组没有在跑的行，圆点不该亮
        val kidsRunning = listOf(row("c1", running = true, origin = "subagent"), row("plain"))
        // 可见的行自己在跑 → 圆点亮
        val plainRunning = listOf(row("p1", running = true))
        val groups = listOf(
            group("a", "alpha", true, kidsRunning),
            group("b", "beta", false, plainRunning),
        )

        val out = Sessions.withoutChildren(groups)

        assertEquals(false, out[0].running)
        assertEquals(true, out[1].running)
    }

    @Test
    fun keepsGroupMetaAndPendingQuestionFlag() {
        val plain = row("plain", question = true)
        val groups = listOf(group("a", "alpha", false, listOf(plain, row("c", origin = "subagent"))))

        val out = Sessions.withoutChildren(groups)

        val g = out[0]
        assertEquals("a", g.key)
        assertEquals("alpha", g.name)
        assertEquals("D:\\proj\\alpha", g.path)
        assertTrue(g.items[0].pendingQuestion)
    }

    @Test
    fun noChildrenMeansNothingChanges() {
        val groups = listOf(
            group("a", "alpha", true, listOf(row("p1", running = true), row("p2"))),
            group("b", "beta", false, listOf(row("p3"))),
        )

        val out = Sessions.withoutChildren(groups)

        assertEquals(2, out.size)
        assertEquals(listOf("p1", "p2", "p3"), out.flatMap { g -> g.items.map { it.id } })
        assertEquals(true, out[0].running)
    }
}
