package dsh.mirror.client.ui

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/*
 * Markdown 渲染的**行为契约**测试。
 *
 * 断言是从网页端的 tools/web-pure-test.cjs **逐条搬过来的**（同样的输入、同样的期望输出）。
 * 那边期望的是 HTML 字符串，所以这里先用手写的 toHtml() 把块树序列化成与那边**一模一样**的
 * HTML 形态，再照抄断言 —— 这样"原生端与网页端渲染一致"这件事是被机器钉住的，不是靠肉眼比。
 *
 * 注意 toHtml() **只存在于测试里**：它是比对工具，不是渲染路径（渲染走 MarkdownView）。
 */

// —————————————————————— 比对用的 HTML 序列化（形状与 app.js 完全一致） ——————————————————————

private fun toHtml(blocks: List<MdBlock>): String = blocks.joinToString("\n") { blk(it) }

private fun blk(b: MdBlock): String = when (b) {
    is MdBlock.Heading -> "<h" + b.level + ">" + inl(b.inlines) + "</h" + b.level + ">"
    is MdBlock.Para -> "<p>" + b.lines.joinToString("<br>") { inl(it) } + "</p>"
    is MdBlock.Quote -> "<blockquote>" + b.lines.joinToString("<br>") { inl(it) } + "</blockquote>"
    is MdBlock.Code ->
        "<pre class=\"md-code\"" + (if (b.lang.isNotEmpty()) " data-lang=\"" + mdEsc(b.lang) + "\"" else "") +
            "><code>" + mdEsc(b.text) + "</code></pre>"
    MdBlock.Rule -> "<hr>"
    is MdBlock.ListBlock -> list(b)
    is MdBlock.Table -> {
        val head = b.head.mapIndexed { i, c -> cell("th", c, b.aligns, i) }.joinToString("")
        val body = b.rows.joinToString("") { row ->
            "<tr>" + b.head.indices.joinToString("") { k ->
                cell("td", row.getOrElse(k) { emptyList() }, b.aligns, k)
            } + "</tr>"
        }
        "<div class=\"md-table\"><table><thead><tr>" + head + "</tr></thead><tbody>" + body + "</tbody></table></div>"
    }
}

private fun cell(tag: String, nodes: List<MdInline>, aligns: List<String>, idx: Int): String {
    val a = aligns.getOrElse(idx) { "" }
    val style = if (a.isNotEmpty()) " style=\"text-align:" + a + "\"" else ""
    return "<" + tag + style + ">" + inl(nodes) + "</" + tag + ">"
}

private fun list(b: MdBlock.ListBlock): String {
    val tag = if (b.ordered) "ol" else "ul"
    val start = if (b.ordered && b.start > 1) " start=\"" + b.start + "\"" else ""
    val items = b.items.joinToString("") { item ->
        var inner = item.text.split("\n").joinToString("<br>") { inl(mdInline(mdEsc(it))) }
        if (item.task == true) inner = "<span class=\"md-check on\" aria-hidden=\"true\"></span>" + inner
        else if (item.task == false) inner = "<span class=\"md-check\" aria-hidden=\"true\"></span>" + inner
        if (item.children.isNotEmpty()) inner += item.children.joinToString("") { list(it) }
        "<li" + (if (item.task == null) "" else " class=\"md-task\"") + ">" + inner + "</li>"
    }
    return "<" + tag + start + ">" + items + "</" + tag + ">"
}

private fun inl(nodes: List<MdInline>): String = nodes.joinToString("") { n ->
    when (n) {
        is MdInline.T -> mdEsc(n.text)
        is MdInline.Code -> "<code>" + mdEsc(n.text) + "</code>"
        is MdInline.Strong -> "<strong>" + inl(n.kids) + "</strong>"
        is MdInline.Em -> "<em>" + inl(n.kids) + "</em>"
        is MdInline.StrongEm -> "<strong><em>" + inl(n.kids) + "</em></strong>"
        is MdInline.Del -> "<del>" + inl(n.kids) + "</del>"
        // 本地文件链接：网页端 renderMarkdown 只认 http(s)，其余一律当纯文本 → 这里序列化成原文，
        // 保持"和网页端同形"的口径（真机上它是蓝色芯片，那是 0.9.2 起有意偏离网页端的地方）
        is MdInline.Link -> if (n.file) {
            "[" + inl(n.kids) + "](" + mdEsc(n.url) + ")"
        } else {
            "<a href=\"" + mdEsc(n.url) + "\" target=\"_blank\" rel=\"noopener noreferrer\"" +
                (if (n.title.isNotEmpty()) " title=\"" + mdEsc(n.title) + "\"" else "") +
                ">" + inl(n.kids) + "</a>"
        }
        is MdInline.Img ->
            "<img src=\"" + mdEsc(n.url) + "\" alt=\"" + mdEsc(n.alt) + "\"" +
                (if (n.title.isNotEmpty()) " title=\"" + mdEsc(n.title) + "\"" else "") +
                " loading=\"lazy\">"
    }
}

private fun md(text: String): String = toHtml(parseMarkdown(text))

private fun eq(what: String, actual: String, expected: String) = assertEquals(expected, actual, what)
private fun has(what: String, actual: String, part: String) = assertTrue(actual.contains(part), what + " —— 实际：" + actual)
private fun hasNot(what: String, actual: String, part: String) = assertFalse(actual.contains(part), what + " —— 实际：" + actual)

// JUnit 5 的 assertEquals 参数顺序是 (expected, actual)，这里包一层让调用点读起来是 (实际, 期望)

// —————————————————————————————— 断言（搬自 web-pure-test.cjs） ——————————————————————————————

class MarkdownTest {

    @Test
    fun codeFence() {
        val code = md("```\n<b>bold</b>\n```")
        has("代码块: <b> 保持字面", code, "&lt;b&gt;bold&lt;/b&gt;")
        hasNot("代码块: 不产生真实 <b> 元素", code, "<b>")
        has("代码块: 包在 pre.md-code 里", code, "<pre class=\"md-code\"")

        val js = md("```js\nconst a = 1 < 2 && 3 > 2;\n```")
        has("代码块: lang 保留", js, "data-lang=\"js\"")
        has("代码块: < 保持字面", js, "1 &lt; 2 &amp;&amp; 3 &gt; 2")
    }

    @Test
    fun inlineCode() {
        val out = md("看 `a < b **not bold**` 这里")
        has("行内代码: 保持字面", out, "<code>a &lt; b **not bold**</code>")
        hasNot("行内代码: 内部不做标记替换", out, "<strong>")
    }

    @Test
    fun blocksFixture() {
        val out = md(
            listOf(
                "# 一级标题",
                "## 二级 **粗**",
                "",
                "段落一行",
                "段落二行",
                "",
                "- 项目 A",
                "- 项目 B",
                "",
                "1. 第一",
                "2. 第二",
                "",
                "> 引用内容",
                "",
                "---",
                "",
                "链接 [文档](https://example.com/a?b=1&c=2) 与 *斜体* 与 `code`",
            ).joinToString("\n"),
        )
        has("标题 h1", out, "<h1>一级标题</h1>")
        has("标题 h2 + 粗体", out, "<h2>二级 <strong>粗</strong></h2>")
        has("段落换行 → <br>", out, "<p>段落一行<br>段落二行</p>")
        has("无序列表", out, "<ul><li>项目 A</li><li>项目 B</li></ul>")
        has("有序列表", out, "<ol><li>第一</li><li>第二</li></ol>")
        has("引用", out, "<blockquote>引用内容</blockquote>")
        has("水平线", out, "<hr>")
        has("https 链接可用", out, "<a href=\"https://example.com/a?b=1&amp;c=2\"")
        has("斜体", out, "<em>斜体</em>")
        has("行内代码", out, "<code>code</code>")
    }

    @Test
    fun security() {
        val bad = md("[点我](javascript:alert(1))")
        hasNot("javascript: 链接降级（无 <a）", bad, "<a")
        has("javascript: 链接降级为纯文本", bad, "[点我](javascript:alert(1))")
        hasNot("data: 链接降级", md("[x](data:text/html,<script>1</script>)"), "<a")

        val xss = md("<script>alert(1)</script>")
        hasNot("Markdown 里的 script 被转义", xss, "<script>")
        has("Markdown 里的 script 转义结果", xss, "&lt;script&gt;")
    }

    @Test
    fun tables() {
        val t = md(
            listOf(
                "| 名称 | 值 | 说明 |",
                "|:-----|----:|:----:|",
                "| a | 1 | 左对齐 |",
                "| b | 2 | 居中 |",
            ).joinToString("\n"),
        )
        has("表格: 生成 table", t, "<table>")
        has("表格: 表头左对齐", t, "<th style=\"text-align:left\">名称</th>")
        has("表格: 表头右对齐", t, "<th style=\"text-align:right\">值</th>")
        has("表格: 表头居中", t, "<th style=\"text-align:center\">说明</th>")
        has("表格: 表体单元格", t, "<td style=\"text-align:left\">a</td>")
        has("表格: 外层容器可横向滚动", t, "<div class=\"md-table\">")
        hasNot("表格: 不再退化成裸竖线文本", t, "| 名称 |")

        has("表格: 转义的 \\| 不当分隔符", md("| a | b |\n|---|---|\n| x\\|y | 2 |"), "<td>x|y</td>")
        has("表格: 后面的段落正常收尾", md("| a |\n|---|\n| 1 |\n\n正文"), "</table></div>\n<p>正文</p>")
    }

    @Test
    fun nestedLists() {
        eq(
            "嵌套列表: 三层结构完整",
            md("- 一级\n  - 二级\n    - 三级\n- 又一级"),
            "<ul><li>一级<ul><li>二级<ul><li>三级</li></ul></li></ul></li><li>又一级</li></ul>",
        )
        eq(
            "列表续行并进同一项",
            md("- 第一项\n  继续说明\n- 第二项"),
            "<ul><li>第一项<br>继续说明</li><li>第二项</li></ul>",
        )
        eq("有序列表认起始号", md("3. 三\n4. 四"), "<ol start=\"3\"><li>三</li><li>四</li></ol>")
    }

    @Test
    fun taskLists() {
        val tasks = md("- [ ] 没做\n- [x] 做了")
        has("任务列表: 未勾选", tasks, "<li class=\"md-task\"><span class=\"md-check\" aria-hidden=\"true\"></span>没做</li>")
        has("任务列表: 已勾选", tasks, "<span class=\"md-check on\" aria-hidden=\"true\"></span>做了")
    }

    @Test
    fun emphasisEdges() {
        eq("粗体里套斜体（以前解析错乱）", md("**粗 *斜* 粗**"), "<p><strong>粗 <em>斜</em> 粗</strong></p>")
        eq("粗斜体三连星", md("***又粗又斜***"), "<p><strong><em>又粗又斜</em></strong></p>")
        eq("删除线", md("这是 ~~删掉~~ 的字"), "<p>这是 <del>删掉</del> 的字</p>")
        eq("下划线斜体", md("这是 _斜体_ 的字"), "<p>这是 <em>斜体</em> 的字</p>")
        eq("snake_case 不被当斜体", md("变量 my_long_name 在这"), "<p>变量 my_long_name 在这</p>")
        eq("未闭合的 ** 原样保留", md("这里有 ** 两个星号"), "<p>这里有 ** 两个星号</p>")
        eq("空内容的 ** 不成对", md("a **** b"), "<p>a **** b</p>")
    }

    /** 收集整棵树里的链接节点，用来断言"某段文本被解析成了什么链接"。 */
    private fun links(blocks: List<MdBlock>): List<MdInline.Link> {
        val out = ArrayList<MdInline.Link>()
        fun walk(ns: List<MdInline>) {
            for (n in ns) {
                when (n) {
                    is MdInline.Link -> { out.add(n); walk(n.kids) }
                    is MdInline.Strong -> walk(n.kids)
                    is MdInline.Em -> walk(n.kids)
                    is MdInline.StrongEm -> walk(n.kids)
                    is MdInline.Del -> walk(n.kids)
                    else -> Unit
                }
            }
        }
        blocks.forEach { b ->
            when (b) {
                is MdBlock.Heading -> walk(b.inlines)
                is MdBlock.Para -> b.lines.forEach { walk(it) }
                is MdBlock.Quote -> b.lines.forEach { walk(it) }
                is MdBlock.ListBlock -> b.items.forEach { walk(mdInline(mdEsc(it.text))) }
                is MdBlock.Table -> {
                    b.head.forEach { walk(it) }
                    b.rows.forEach { r -> r.forEach { walk(it) } }
                }
                else -> Unit
            }
        }
        return out
    }

    @Test
    fun fileLinksBecomeChips() {
        val apk = links(parseMarkdown("[0.9.1](dsh-mobile-mirror/out/dsh-mobile-mirror-client-0.9.1.apk)"))
        eq("相对路径 → 本地文件链接", apk.size.toString(), "1")
        eq("相对路径: 标为 file", apk[0].file.toString(), "true")
        eq("相对路径: url 原样", apk[0].url, "dsh-mobile-mirror/out/dsh-mobile-mirror-client-0.9.1.apk")

        val drive = links(parseMarkdown("[x](C:/build/app.apk)"))
        eq("盘符路径 → 本地文件链接", drive.size.toString(), "1")
        eq("盘符路径: 标为 file", drive[0].file.toString(), "true")

        val web = links(parseMarkdown("[x](https://a.com/b)"))
        eq("https → 网页链接", web[0].file.toString(), "false")

        // 安全底线：带协议的一律降级成纯文本，绝不出链接节点
        eq("javascript: 不成链接", links(parseMarkdown("[x](javascript:alert(1))")).size.toString(), "0")
        eq("data: 不成链接", links(parseMarkdown("[x](data:text/html,<b>1</b>)")).size.toString(), "0")
        eq("mailto: 不成链接", links(parseMarkdown("[x](mailto:a@b.com)")).size.toString(), "0")
    }

    @Test
    fun emptyHeaderRowIsDetected() {
        val empty = parseMarkdown("| | |\n|---|---|\n| 单测 | 9 用例 |").first() as MdBlock.Table
        eq("全空表头: 识别为不需要画", empty.hasHeader().toString(), "false")
        eq("全空表头: 内容行还在", empty.rows.size.toString(), "1")

        val real = parseMarkdown("| 项 | 结果 |\n|---|---|\n| a | b |").first() as MdBlock.Table
        eq("有内容的表头: 照画", real.hasHeader().toString(), "true")

        val spaces = parseMarkdown("|   |   |\n|---|---|\n| a | b |").first() as MdBlock.Table
        eq("只有空白的表头: 也算空", spaces.hasHeader().toString(), "false")
    }

    @Test
    fun linksAndImages() {
        has("图片", md("![图](https://x.com/a.png)"), "<img src=\"https://x.com/a.png\" alt=\"图\" loading=\"lazy\">")
        hasNot("javascript: 图片降级（无 <img）", md("![x](javascript:alert(1))"), "<img")
        has(
            "带标题的链接",
            md("[点我](https://a.com \"标题\")"),
            "<a href=\"https://a.com\" target=\"_blank\" rel=\"noopener noreferrer\" title=\"标题\">点我</a>",
        )
        has(
            "自动链接 <url>",
            md("见 <https://a.com/x>"),
            "<a href=\"https://a.com/x\" target=\"_blank\" rel=\"noopener noreferrer\">https://a.com/x</a>",
        )
        hasNot("非 http 的尖括号不自动链接", md("<foo@bar.com>"), "<a")
        has("代码块语言属性仍在", md("```python\nx=1\n```"), "data-lang=\"python\"")
    }
}
