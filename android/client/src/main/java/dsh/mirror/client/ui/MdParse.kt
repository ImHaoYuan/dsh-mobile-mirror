package dsh.mirror.client.ui

/*
 * 精简 Markdown 解析器。
 *
 * **这是 lib/web/app.js 里 renderMarkdown / mdInline / mdEmphasis 的逐行移植**，不是"自己写一套
 * 更标准的 Markdown"。网页端那三个函数带着一堆踩坑注释（未闭合的 ** 要原样保留、snake_case 不能
 * 变斜体、a **** b 不能凑成一对、表格里的 \| 要转义……），而且有一份纯函数测试把行为钉死了
 * （tools/web-pure-test.cjs）。移植的目标就是让那份测试的每一条断言在原生端也成立。
 *
 * 与网页端的**唯一**结构差异：那边产出 HTML 字符串，这边产出树，由 MarkdownView 渲染成 Compose。
 * 为了保持"边界行为一致"，解析过程刻意保留了两个和那边一样的做法：
 *
 *  1. **在转义后的文本上解析**。网页端先 esc() 再匹配标记，所以 <b> 永远出不来、引号是 &quot;、
 *     自动链接靠找 &lt;。这里照做：树里存**原始**文本，只有匹配时才用转义后的形态。
 *  2. **行内代码先摘成占位符**（\u0000C<序号>\u0000），内容不参与任何标记解析，最后再还原。
 */

/** 表格单元格对齐：left / right / center，空串表示不指定（与网页端一致）。 */
typealias MdAlign = String

/** 行内节点。 */
sealed class MdInline {
    /** 纯文本（**未转义**的原始字符）。 */
    class T(val text: String) : MdInline()

    /** 行内代码，内容原样（不做任何标记替换）。 */
    class Code(val text: String) : MdInline()

    class Strong(val kids: List<MdInline>) : MdInline()
    class Em(val kids: List<MdInline>) : MdInline()
    class StrongEm(val kids: List<MdInline>) : MdInline()
    class Del(val kids: List<MdInline>) : MdInline()

    /**
     * 链接。只有两类能活到渲染层：
     *  - http/https → [file] = false，点击开系统浏览器；
     *  - **本地文件路径**（相对路径 / 盘符路径）→ [file] = true，渲染成蓝色文件芯片。
     * 其余带协议的（`javascript:` / `data:` / `mailto:` …）在解析期就降级成纯文本，不出节点。
     */
    class Link(val kids: List<MdInline>, val url: String, val title: String, val file: Boolean = false) :
        MdInline()

    /** 图片。M4 只渲染占位（真加载要解决附件鉴权）。 */
    class Img(val alt: String, val url: String, val title: String) : MdInline()
}

/** 块级节点。 */
sealed class MdBlock {
    class Heading(val level: Int, val inlines: List<MdInline>) : MdBlock()

    /** 段落。外层是行，内层是行内节点 —— 网页端把段落里的换行渲染成 <br>。 */
    class Para(val lines: List<List<MdInline>>) : MdBlock()

    /** 引用。同样按行。 */
    class Quote(val lines: List<List<MdInline>>) : MdBlock()

    /** 围栏代码块。lang 为空表示没写语言。 */
    class Code(val lang: String, val text: String) : MdBlock()

    object Rule : MdBlock()

    /**
     * 列表。缩进层级用 indent 表示（网页端用 padding-left 体现）。
     * text 里可能含 \n（列表项的续行），渲染时按换行处理。
     */
    class ListBlock(
        val ordered: Boolean,
        val indent: Int,
        val start: Int,
        val items: MutableList<Item>,
    ) : MdBlock() {
        class Item(val task: Boolean?, val text: String, val children: MutableList<ListBlock>)
    }

    /** GFM 表格。head / rows 的每个单元格是行内节点，aligns 与列一一对应。 */
    class Table(
        val head: List<List<MdInline>>,
        val aligns: List<MdAlign>,
        val rows: List<List<List<MdInline>>>,
    ) : MdBlock() {
        /**
         * 表头是否值得画。**全空表头不画** —— 写 markdown 时常用 `| | |` 这种空表头来避免出现表头行
         * （桌面端 DSH 客户端就是这么处理的：整行丢掉），照画会多出一排空的底色格子。
         */
        fun hasHeader(): Boolean = head.any { cell -> cell.any { it !is MdInline.T || it.text.isNotBlank() } }
    }
}

// —————————————————————— 基础工具（照抄 app.js 同名函数） ——————————————————————

/** HTML 实体转义。名字与网页端一样短，因为它在这份文件里出现得非常多。 */
internal fun mdEsc(value: String?): String {
    if (value == null) return ""
    return value
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace("\"", "&quot;")
        .replace("'", "&#39;")
}

/** 把 mdEsc 的五个实体解回字符。**& 必须最后**，否则 &amp;lt; 会被解成 <。 */
internal fun mdUnesc(value: String): String = value
    .replace("&lt;", "<")
    .replace("&gt;", ">")
    .replace("&quot;", "\"")
    .replace("&#39;", "'")
    .replace("&amp;", "&")

/** 强调定界符的边界字符：`_` 紧挨着这些字符时不算强调，免得 my_long_name 变斜体。 */
private val WORD_CHAR = Regex("[0-9A-Za-z\\u4e00-\\u9fa5]")

/** 链接目标的分类结果。 */
internal enum class UrlKind { Web, File, Reject }

/** `scheme:` 前缀（javascript:、data:、mailto:…）。 */
private val SCHEME = Regex("^[A-Za-z][A-Za-z0-9+.-]*:")

/** Windows 盘符路径（`D:/x`、`C:\\x`）—— 长得像 scheme，但其实是路径。 */
private val DRIVE = Regex("^[A-Za-z]:[\\/]")

/**
 * 链接目标分类：
 *  - http/https → [UrlKind.Web]（点击开浏览器）；
 *  - 带协议但不是 http(s) → [UrlKind.Reject]（javascript:/data: 这些**必须**降级成纯文本，是安全底线）；
 *  - 不带协议、也不是盘符 → [UrlKind.File]（本地文件，渲染成蓝色芯片）。
 */
internal fun classifyUrl(url: String?): UrlKind {
    val u = url ?: return UrlKind.Reject
    if (u.isEmpty()) return UrlKind.Reject
    if (Regex("^https?://", RegexOption.IGNORE_CASE).containsMatchIn(u)) return UrlKind.Web
    if (DRIVE.containsMatchIn(u)) return UrlKind.File
    if (SCHEME.containsMatchIn(u)) return UrlKind.Reject
    return UrlKind.File
}

private class Hit(val text: String, val end: Int)

/** 找闭合定界符；空内容或首尾带空白的候选不算（网页端 findClose）。 */
private fun findClose(text: String, from: Int, delim: String): Hit? {
    var at = from
    while (true) {
        val idx = text.indexOf(delim, at)
        if (idx < 0) return null
        val body = text.substring(from, idx)
        if (body.isNotEmpty() && !body[0].isWhitespace() && !body[body.length - 1].isWhitespace()) {
            return Hit(body, idx + delim.length)
        }
        at = idx + 1
    }
}

/** `_` / `__` / `___` 的闭合符是否落在词边界上。 */
private fun underscoreOk(text: String, openIdx: Int, closeIdx: Int, delimLen: Int): Boolean {
    val before = if (openIdx > 0) text[openIdx - 1].toString() else ""
    val after = if (closeIdx + delimLen < text.length) text[closeIdx + delimLen].toString() else ""
    return !WORD_CHAR.containsMatchIn(before) && !WORD_CHAR.containsMatchIn(after)
}

private class LinkHit(val label: String, val url: String, val title: String, val end: Int)

/** 从 start 处（text[start] === '['）解析 `[label](url "title")`；输入已转义，所以引号是 &quot;。 */
private fun matchLink(text: String, start: Int): LinkHit? {
    val close = text.indexOf(']', start + 1)
    if (close < 0 || close + 1 >= text.length || text[close + 1] != '(') return null
    val end = text.indexOf(')', close + 2)
    if (end < 0) return null
    val m = Regex("^(\\S+)(?:\\s+(&quot;|&#39;)([\\s\\S]*?)\\2)?$").find(text.substring(close + 2, end))
        ?: return null
    return LinkHit(text.substring(start + 1, close), m.groupValues[1], m.groupValues[3], end + 1)
}

private class EmHit(val node: MdInline, val end: Int)

/** 在 i 处尝试匹配一个行内强调标记，失败返回 null。 */
private fun matchEmphasis(text: String, i: Int): EmHit? {
    val kinds = arrayOf("***" to "se", "___" to "se", "**" to "s", "__" to "s", "~~" to "d")
    for ((delim, kind) in kinds) {
        if (!text.startsWith(delim, i)) continue
        val hit = findClose(text, i + delim.length, delim) ?: continue
        if (delim[0] == '_' && !underscoreOk(text, i, hit.end - delim.length, delim.length)) continue
        val kids = mdEmphasis(hit.text)
        val node = when (kind) {
            "se" -> MdInline.StrongEm(kids)
            "s" -> MdInline.Strong(kids)
            else -> MdInline.Del(kids)
        }
        return EmHit(node, hit.end)
    }
    val one = text[i]
    if (one == '*' || one == '_') {
        // 单字符定界符不能是更长一串定界符的一部分：a **** b 不是强调，
        // 否则中间那两个星号会被凑成一对，渲染出 <em>*</em>* 这种垃圾。
        if (i + 1 < text.length && text[i + 1] == one) return null
        var single = findClose(text, i + 1, one.toString())
        // 闭合符后面还紧跟着同字符，说明它属于更长的串，换下一个候选
        while (single != null && single.end < text.length && text[single.end] == one) {
            single = findClose(text, single.end + 1, one.toString())
        }
        if (single != null) {
            if (one == '_' && !underscoreOk(text, i, single.end - 1, 1)) return null
            return EmHit(MdInline.Em(mdEmphasis(single.text)), single.end)
        }
    }
    return null
}

/**
 * 行内标记 → 节点。输入是**原始**文本（内部先转义）。
 *
 * 强调用递归下降而不是一串 replace：只有递归才能正确嵌套（**粗 *斜* 粗**），
 * 顺序化的 replace 会让内层标记被外层抢先匹配。
 */
private fun mdEmphasis(text: String): List<MdInline> {
    val out = ArrayList<MdInline>()
    val plain = StringBuilder()
    fun flush() {
        if (plain.isNotEmpty()) {
            out.add(MdInline.T(mdUnesc(plain.toString())))
            plain.clear()
        }
    }

    var i = 0
    while (i < text.length) {
        val ch = text[i]

        // 图片 ![alt](url)
        if (ch == '!' && i + 1 < text.length && text[i + 1] == '[') {
            val img = matchLink(text, i + 1)
            if (img != null && classifyUrl(img.url) == UrlKind.Web) {
                flush()
                out.add(MdInline.Img(mdUnesc(img.label), mdUnesc(img.url), mdUnesc(img.title)))
                i = img.end
                continue
            }
        }

        // 链接 [label](url)
        if (ch == '[') {
            val link = matchLink(text, i)
            val kind = if (link != null) classifyUrl(link.url) else UrlKind.Reject
            if (link != null && kind != UrlKind.Reject) {
                flush()
                // url 也来自**转义后**的文本（& 已经变成 &amp;），必须解回去再存 ——
                // 否则渲染/序列化时会再转一次，变成 &amp;amp;
                out.add(
                    MdInline.Link(
                        mdEmphasis(link.label), mdUnesc(link.url), mdUnesc(link.title),
                        file = kind == UrlKind.File,
                    ),
                )
                i = link.end
                continue
            }
        }

        // 自动链接：<https://…> 已被转义成 &lt;https://…&gt;
        if (text.startsWith("&lt;", i)) {
            val gt = text.indexOf("&gt;", i + 4)
            if (gt > 0) {
                val bare = text.substring(i + 4, gt)
                if (Regex("^https?://\\S+$").containsMatchIn(bare)) {
                    flush()
                    out.add(MdInline.Link(listOf(MdInline.T(bare)), mdUnesc(bare), ""))
                    i = gt + 4
                    continue
                }
            }
        }

        val mark = matchEmphasis(text, i)
        if (mark != null) {
            flush()
            out.add(mark.node)
            i = mark.end
            continue
        }

        plain.append(ch)
        i++
    }
    flush()
    return out
}

private val CODE_SPAN = Regex("`([^`\\n]+)`")
private val CODE_PLACEHOLDER = Regex("\u0000C(\\d+)\u0000")

/** 把行内代码摘成占位符 → 走一遍强调解析 → 再把占位符还原成代码节点。 */
internal fun mdInline(raw: String?): List<MdInline> {
    var text = (raw ?: "").replace("\u0000", "")
    val codes = ArrayList<String>()
    text = CODE_SPAN.replace(text) { m ->
        codes.add(m.groupValues[1])
        "\u0000C" + (codes.size - 1) + "\u0000"
    }
    return restoreCodes(mdEmphasis(text), codes)
}

/** 占位符可能落在任何层级（粗体里、链接文字里），所以要递归还原。 */
private fun restoreCodes(nodes: List<MdInline>, codes: List<String>): List<MdInline> {
    val out = ArrayList<MdInline>(nodes.size)
    for (node in nodes) {
        when (node) {
            is MdInline.T -> {
                var last = 0
                for (m in CODE_PLACEHOLDER.findAll(node.text)) {
                    if (m.range.first > last) out.add(MdInline.T(node.text.substring(last, m.range.first)))
                    val idx = m.groupValues[1].toIntOrNull()
                    out.add(MdInline.Code(if (idx != null && idx < codes.size) mdUnesc(codes[idx]) else ""))
                    last = m.range.last + 1
                }
                if (last < node.text.length) out.add(MdInline.T(node.text.substring(last)))
            }
            is MdInline.Strong -> out.add(MdInline.Strong(restoreCodes(node.kids, codes)))
            is MdInline.Em -> out.add(MdInline.Em(restoreCodes(node.kids, codes)))
            is MdInline.StrongEm -> out.add(MdInline.StrongEm(restoreCodes(node.kids, codes)))
            is MdInline.Del -> out.add(MdInline.Del(restoreCodes(node.kids, codes)))
            is MdInline.Link ->
                out.add(MdInline.Link(restoreCodes(node.kids, codes), node.url, node.title, node.file))
            else -> out.add(node)
        }
    }
    return out
}

// ———————————————————————————— 表格工具 ————————————————————————————

/** 拆一行表格：去掉首尾竖线，\| 转义成占位符避免被当分隔符。 */
private fun splitRow(line: String): List<String> {
    var t = line.replace("\\|", "\u0000P\u0000").trim()
    if (t.startsWith("|")) t = t.substring(1)
    if (t.endsWith("|")) t = t.dropLast(1)
    return t.split("|").map { it.replace("\u0000P\u0000", "|").trim() }
}

/** 表格的分隔行：|---|---|、|:--|--:|:-:| 之类。 */
private fun isTableDelim(line: String): Boolean {
    val cells = splitRow(line)
    if (cells.isEmpty()) return false
    val re = Regex("^:?-{1,}:?$")
    return cells.all { re.matches(it) }
}

private fun tableAlign(cell: String): MdAlign {
    val left = cell.startsWith(":")
    val right = cell.endsWith(":")
    return when {
        left && right -> "center"
        right -> "right"
        left -> "left"
        else -> ""
    }
}

// ———————————————————————————— 块解析 ————————————————————————————

/**
 * Markdown → 块树。
 *
 * 扫行顺序**刻意与网页端完全一致**（围栏 → 空行 → 表格 → 标题 → 水平线 → 引用 → 列表 → 续行 → 段落），
 * 因为顺序本身就是语义：先判表格再判标题，表格行才不会被 `#` 之类的规则抢走。
 */
internal fun parseMarkdown(src: String?): List<MdBlock> {
    val lines = (src ?: "").replace("\r\n", "\n").replace("\r", "\n").split("\n")
    val out = ArrayList<MdBlock>()
    var para = ArrayList<String>()
    var quote = ArrayList<String>()
    var listRoots = ArrayList<MdBlock.ListBlock>()
    var listStack = ArrayList<MdBlock.ListBlock>()

    fun flushPara() {
        if (para.isEmpty()) return
        out.add(MdBlock.Para(para.map { mdInline(mdEsc(it)) }))
        para = ArrayList()
    }

    fun flushQuote() {
        if (quote.isEmpty()) return
        out.add(MdBlock.Quote(quote.map { mdInline(mdEsc(it)) }))
        quote = ArrayList()
    }

    fun flushList() {
        if (listRoots.isEmpty()) return
        out.addAll(listRoots)
        listRoots = ArrayList()
        listStack = ArrayList()
    }

    fun flushAll() {
        flushPara()
        flushList()
        flushQuote()
    }

    /** 列表项：task 为 null 表示普通项，true/false 表示勾选状态。 */
    fun makeItem(text: String): MdBlock.ListBlock.Item {
        val task = Regex("^\\[([ xX])\\]\\s+(.*)$").find(text)
        return if (task != null) {
            MdBlock.ListBlock.Item(task.groupValues[1] != " ", task.groupValues[2], ArrayList())
        } else {
            MdBlock.ListBlock.Item(null, text, ArrayList())
        }
    }

    /** 按缩进把一项挂到正确层级：更深 → 子列表，同级 → 同列表，更浅 → 退栈。 */
    fun pushListItem(indent: Int, ordered: Boolean, text: String, startNo: Int) {
        while (listStack.size > 1 && indent < listStack[listStack.size - 1].indent) {
            listStack.removeAt(listStack.size - 1)
        }
        var top = listStack.lastOrNull()

        if (top == null || indent < top.indent) {
            top = MdBlock.ListBlock(ordered, indent, startNo, ArrayList())
            listRoots.add(top)
            listStack = arrayListOf(top)
        } else if (indent > top.indent) {
            val parent = top.items.lastOrNull()
            if (parent == null) {
                top.items.add(makeItem(text))
                return
            }
            val child = MdBlock.ListBlock(ordered, indent, startNo, ArrayList())
            parent.children.add(child)
            listStack.add(child)
            top = child
        } else if (top.ordered != ordered) {
            // 同缩进但类型变了（有序 ↔ 无序）：同级另起一个列表
            val sibling = MdBlock.ListBlock(ordered, indent, startNo, ArrayList())
            val host = if (listStack.size > 1) listStack[listStack.size - 2].items.lastOrNull() else null
            if (host != null) host.children.add(sibling) else listRoots.add(sibling)
            listStack[listStack.size - 1] = sibling
            top = sibling
        }

        top.items.add(makeItem(text))
    }

    var i = 0
    while (i < lines.size) {
        val line = lines[i]

        // 围栏代码块：内容整段原样保留
        val fence = Regex("^\\s*```(.*)$").find(line)
        if (fence != null) {
            flushAll()
            val lang = fence.groupValues[1].trim().split(Regex("\\s+")).firstOrNull().orEmpty()
            val buf = ArrayList<String>()
            i++
            while (i < lines.size) {
                if (Regex("^\\s*```\\s*$").matches(lines[i])) break
                buf.add(lines[i])
                i++
            }
            out.add(MdBlock.Code(lang, buf.joinToString("\n")))
            i++
            continue
        }

        if (line.isBlank()) {
            flushAll()
            i++
            continue
        }

        // 表格：本行有竖线，且下一行是分隔行
        if (line.contains('|') && i + 1 < lines.size && isTableDelim(lines[i + 1])) {
            flushAll()
            val head = splitRow(line).map { mdInline(mdEsc(it)) }
            val aligns = splitRow(lines[i + 1]).map { tableAlign(it) }
            val rows = ArrayList<List<List<MdInline>>>()
            i += 2
            while (i < lines.size && lines[i].isNotBlank() && lines[i].contains('|')) {
                rows.add(splitRow(lines[i]).map { mdInline(mdEsc(it)) })
                i++
            }
            out.add(MdBlock.Table(head, aligns, rows))
            continue
        }

        val heading = Regex("^(#{1,6})\\s+(.*)$").find(line)
        if (heading != null) {
            flushAll()
            val level = heading.groupValues[1].length
            val title = heading.groupValues[2].replace(Regex("\\s+#+\\s*$"), "")
            out.add(MdBlock.Heading(level, mdInline(mdEsc(title))))
            i++
            continue
        }

        if (Regex("^\\s*(?:-{3,}|\\*{3,}|_{3,})\\s*$").matches(line)) {
            flushAll()
            out.add(MdBlock.Rule)
            i++
            continue
        }

        val bq = Regex("^\\s*>\\s?(.*)$").find(line)
        if (bq != null) {
            flushPara()
            flushList()
            quote.add(bq.groupValues[1])
            i++
            continue
        }

        val ul = Regex("^(\\s*)[-*+]\\s+(.*)$").find(line)
        val ol = if (ul == null) Regex("^(\\s*)(\\d+)[.)]\\s+(.*)$").find(line) else null
        if (ul != null || ol != null) {
            flushPara()
            flushQuote()
            val indent = (if (ul != null) ul.groupValues[1] else ol!!.groupValues[1]).replace("\t", "    ").length
            pushListItem(
                indent,
                ol != null,
                if (ul != null) ul.groupValues[2] else ol!!.groupValues[3],
                if (ol != null) ol.groupValues[2].toIntOrNull() ?: 1 else 1,
            )
            i++
            continue
        }

        // 列表项的续行：有缩进、又不是新标记、且当前确实在列表里 → 并进上一项
        if (listStack.isNotEmpty() && Regex("^\\s+\\S").containsMatchIn(line)) {
            val cur = listStack[listStack.size - 1].items.lastOrNull()
            if (cur != null) {
                val merged = MdBlock.ListBlock.Item(cur.task, cur.text + "\n" + line.trim(), cur.children)
                listStack[listStack.size - 1].items[listStack[listStack.size - 1].items.size - 1] = merged
                i++
                continue
            }
        }

        flushList()
        flushQuote()
        para.add(line)
        i++
    }
    flushAll()
    return out
}
