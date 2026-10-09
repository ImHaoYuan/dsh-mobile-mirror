package dev.dsh.mirror.client.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import android.widget.Toast
import dev.dsh.mirror.client.R
import dev.dsh.mirror.client.theme.Dsh
import dev.dsh.mirror.client.theme.LocalDshFonts
import kotlinx.coroutines.delay

/*
 * 把 MdParse 的块树渲染成 Compose。
 *
 * **数值全部照抄网页端 lib/web/app.css 的 .md 段**（px 直接当 dp / sp 用，因为网页端气泡
 * 的基准字号就是 14px、与本模块的 Dsh.BodySize 一致）。外边距按 CSS 的**折叠**规则处理：
 * 相邻两块之间取两者外边距的较大者，首块上边距、末块下边距都不补。
 *
 * 0.9.2 起**不再以"与网页端逐像素一致"为目标**（用户拍板：好看优先，可以不一致），改为向
 * **桌面端 DSH 客户端的观感**看齐。与网页端有意不同的地方：
 *  1. 行内代码用「底色 + 两侧垫一个不换行空格」做留白 —— Compose 的 SpanStyle 画不了 padding，
 *     垫 nbsp 是唯一能在底色内部做出内边距的办法；
 *  2. 图片渲染成占位（真加载要解决宿主附件的地址与鉴权，留到后面单独一版）；
 *  3. 表格**只画横线、不画竖线**，且全空表头不画 —— 与桌面端一致；
 *  4. 本地文件链接渲染成蓝色芯片（桌面端也是芯片，只是它用了 emoji 图标，内置字体没有，就不放图标）。
 */

/** Markdown 正文。source 变了才重新解析（流式那条路走的是纯文本，不经过这里）。 */
@Composable
internal fun MarkdownView(
    source: String,
    modifier: Modifier = Modifier,
    /** 文件芯片被点时的动作。给 null 就退回旧行为（复制路径）。 */
    onFile: ((String) -> Unit)? = null,
) {
    val blocks = remember(source) { parseMarkdown(source) }
    if (blocks.isEmpty()) return
    val body = LocalDshFonts.current.body
    val ctx = mdCtx(onFile)

    Column(modifier = modifier) {
        blocks.forEachIndexed { i, block ->
            if (i > 0) {
                // CSS 外边距折叠：相邻两块之间取较大的那个
                val gap = maxOf(bottomMargin(blocks[i - 1]), topMargin(block))
                if (gap > 0.dp) Spacer(Modifier.height(gap))
            }
            BlockView(block, body, ctx)
        }
    }
}

private fun topMargin(b: MdBlock): Dp = when (b) {
    is MdBlock.Heading -> 20.dp
    MdBlock.Rule -> 16.dp
    else -> 0.dp
}

private fun bottomMargin(b: MdBlock): Dp = when (b) {
    is MdBlock.Heading -> 10.dp
    is MdBlock.Para, is MdBlock.Quote, is MdBlock.ListBlock -> 13.dp
    is MdBlock.Code, is MdBlock.Table -> 9.dp
    MdBlock.Rule -> 16.dp
}

@Composable
private fun BlockView(b: MdBlock, body: FontFamily, ctx: MdCtx) {
    when (b) {
        is MdBlock.Heading -> Text(
            text = inline(b.inlines, ctx),
            fontSize = when (b.level) {
                1 -> 21.sp
                2 -> 19.sp
                3 -> 17.5.sp
                else -> 16.5.sp
            },
            // .md h1..h6 { line-height:1.4 }；h4-h6 用暗色
            lineHeight = (when (b.level) {
                1 -> 21f
                2 -> 19f
                3 -> 17.5f
                else -> 16.5f
            } * 1.4f).sp,
            fontWeight = FontWeight.W700,
            color = if (b.level >= 4) Dsh.FgSoft else Dsh.ListFg,
            fontFamily = ctx.bodyBold,
        )

        is MdBlock.Para -> Text(
            text = lines(b.lines, ctx),
            fontSize = 14.sp,
            lineHeight = 24.5.sp,
            color = Dsh.ListFg,
            fontFamily = body,
        )

        // .md blockquote { padding:2px 0 2px 11px; border-left:3px solid var(--me-line) }
        // IntrinsicSize.Min 让竖条跟着内容长（CSS 里 border-left 天然就是这样）
        is MdBlock.Quote -> Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(vertical = 2.dp)
                .height(IntrinsicSize.Min),
        ) {
            Box(Modifier.fillMaxHeight().width(3.dp).background(Dsh.MeLine))
            Spacer(Modifier.width(11.dp))
            Text(
                text = lines(b.lines, ctx),
                fontSize = 14.sp,
                lineHeight = 24.5.sp,
                color = Dsh.FgMuted,
                fontFamily = body,
            )
        }

        is MdBlock.Code -> CodeBlock(b)

        MdBlock.Rule -> Box(
            Modifier
                .fillMaxWidth()
                .height(1.dp)
                .background(Dsh.ListLine),
        )

        is MdBlock.ListBlock -> ListView(b, depth = 0, body = body, ctx = ctx)

        is MdBlock.Table -> TableView(b, body, ctx)
    }
}

@Composable
private fun CodeBlock(b: MdBlock.Code) {
    val mono = LocalDshFonts.current.mono
    val clipboard = LocalClipboardManager.current
    var copied by remember { mutableStateOf(false) }
    LaunchedEffect(copied) {
        if (copied) {
            delay(1600)
            copied = false
        }
    }
    val shape = RoundedCornerShape(10.dp)

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(Dsh.Code)
            .border(1.dp, Dsh.ListLine, shape),
    ) {
        // .code-head：语言名 + 复制键（网页端是渲染完再套上去的，这里直接就是一体）
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .background(Dsh.CodeHead)
                .padding(start = 11.dp, end = 6.dp, top = 4.dp, bottom = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = b.lang.ifEmpty { stringResource(R.string.md_code) },
                modifier = Modifier.weight(1f),
                fontSize = 11.sp,
                lineHeight = 15.sp,
                color = Dsh.Dim2,
                fontFamily = mono,
                letterSpacing = 0.5.sp,
                maxLines = 1,
            )
            Box(
                modifier = Modifier
                    .height(28.dp)
                    .clip(RoundedCornerShape(7.dp))
                    .background(if (copied) Dsh.OkBg else Color.Transparent)
                    .border(1.dp, if (copied) Dsh.LineOk else Dsh.ListLine, RoundedCornerShape(7.dp))
                    .clickable {
                        clipboard.setText(AnnotatedString(b.text))
                        copied = true
                    }
                    .padding(horizontal = 10.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = stringResource(if (copied) R.string.md_copied else R.string.md_copy),
                    fontSize = 12.sp,
                    lineHeight = 12.sp,
                    color = if (copied) Dsh.Ok else Dsh.ListDim,
                    fontFamily = mono,
                )
            }
        }

        Box(
            modifier = Modifier
                .fillMaxWidth()
                .horizontalScroll(rememberScrollState())
                .padding(horizontal = 11.dp, vertical = 10.dp),
        ) {
            // white-space:pre —— 不折行，靠横向滚动
            Text(
                text = b.text,
                fontSize = 12.5.sp,
                lineHeight = 20.sp,
                color = Dsh.ListFg,
                fontFamily = mono,
                softWrap = false,
            )
        }
    }
}

@Composable
private fun ListView(b: MdBlock.ListBlock, depth: Int, body: FontFamily, ctx: MdCtx) {
    val mono = ctx.mono
    Column(modifier = Modifier.padding(start = if (depth == 0) 24.dp else 18.dp)) {
        b.items.forEachIndexed { idx, item ->
            Row(modifier = Modifier.padding(vertical = 4.dp)) {
                when (item.task) {
                    null -> Text(
                        text = if (b.ordered) (b.start + idx).toString() + "." else "•",
                        modifier = Modifier.width(if (b.ordered) 20.dp else 14.dp),
                        fontSize = 14.sp,
                        lineHeight = 24.5.sp,
                        color = Dsh.ListDim,
                        fontFamily = if (b.ordered) body else mono,
                    )
                    else -> TaskBox(item.task)
                }
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = lines(item.text.split("\n").map { mdInline(mdEsc(it)) }, ctx),
                        fontSize = 14.sp,
                        lineHeight = 24.5.sp,
                        color = Dsh.ListFg,
                        fontFamily = body,
                    )
                    item.children.forEach { child -> ListView(child, depth + 1, body, ctx) }
                }
            }
        }
    }
}

/** 任务列表的勾选框：网页端用 span 画的 14px 方框，已勾选时填品牌蓝加一个勾。 */
@Composable
private fun TaskBox(on: Boolean) {
    Box(
        modifier = Modifier
            .padding(top = 5.dp, end = 7.dp)
            .size(14.dp)
            .clip(RoundedCornerShape(4.dp))
            .background(if (on) Dsh.Brand else Color.Transparent)
            .border(1.5.dp, if (on) Dsh.Brand else Dsh.ListLine2, RoundedCornerShape(4.dp)),
        contentAlignment = Alignment.Center,
    ) {
        if (on) {
            Text(
                text = "✓",
                fontSize = 10.sp,
                lineHeight = 10.sp,
                color = Color.White,
                fontFamily = LocalDshFonts.current.ui,
            )
        }
    }
}

private val CellFont = 13.5.sp
private val CellLine = 20.sp

/**
 * 表格。
 *
 * **列宽必须先量再画**。0.9.1 及以前是「每行一个独立 Row、单元格按各自内容定宽」，
 * 于是每行算出来的列宽都不一样 —— 真机上就是列与列完全错开、一格一格对不上。
 * 现在先用 [rememberTextMeasurer] 量出每列的**自然宽度**（表头 + 所有行取最大），
 * 全表共用同一组列宽：列严格对齐，单元格宽度有界所以内容会正常换行（不再溢出被裁）。
 *
 * 窄表把富余宽度按比例分掉、撑满整行；宽表按比例压缩，压到最小宽还超才横向滚动。
 * 边框只画**横线**（上、行间、下），不画竖线 —— 与桌面端 DSH 客户端一致。
 * 整行全空的表头不画（见 [MdBlock.Table.hasHeader]）。
 */
@Composable
private fun TableView(b: MdBlock.Table, body: FontFamily, ctx: MdCtx) {
    val measurer = rememberTextMeasurer()
    val density = LocalDensity.current
    val hasHeader = b.hasHeader()
    val cols = maxOf(if (hasHeader) b.head.size else 0, b.rows.maxOfOrNull { it.size } ?: 0)
    if (cols == 0) return

    val cellStyle = TextStyle(fontSize = CellFont, lineHeight = CellLine, fontFamily = body)
    val headerStyle = cellStyle.copy(fontWeight = FontWeight.W700, fontFamily = ctx.bodyBold, color = Dsh.FgStrong)
    val padH = 9.dp

    BoxWithConstraints(modifier = Modifier.fillMaxWidth()) {
        val avail = constraints.maxWidth
        val padPx = with(density) { (padH * 2).roundToPx() }
        val minPx = with(density) { 44.dp.roundToPx() }

        val widthsPx = remember(b, avail, hasHeader) {
            val natural = IntArray(cols)
            for (k in 0 until cols) {
                var w = 0
                if (hasHeader) {
                    val cell = b.head.getOrElse(k) { emptyList() }
                    if (cell.isNotEmpty()) {
                        w = maxOf(w, measurer.measure(inline(cell, ctx, SpanStyle()), headerStyle).size.width)
                    }
                }
                b.rows.forEach { row ->
                    val cell = row.getOrElse(k) { emptyList() }
                    if (cell.isNotEmpty()) {
                        w = maxOf(w, measurer.measure(inline(cell, ctx, SpanStyle()), cellStyle).size.width)
                    }
                }
                natural[k] = w + padPx
            }
            val total = natural.sum()
            if (total <= avail) {
                val extra = avail - total
                IntArray(cols) { k -> natural[k] + (extra.toLong() * natural[k] / total).toInt() }
            } else {
                val scale = avail.toFloat() / total
                IntArray(cols) { k -> maxOf(minPx, (natural[k] * scale).toInt()) }
            }
        }
        val widths = widthsPx.map { with(density) { it.toDp() } }
        val tableWidth = widths.fold(0.dp) { acc, w -> acc + w }

        if (widthsPx.sum() > avail) {
            Row(modifier = Modifier.horizontalScroll(rememberScrollState())) {
                TableGrid(b, hasHeader, widths, tableWidth, body, ctx)
            }
        } else {
            TableGrid(b, hasHeader, widths, tableWidth, body, ctx)
        }
    }
}

@Composable
private fun TableGrid(
    b: MdBlock.Table,
    hasHeader: Boolean,
    widths: List<Dp>,
    tableWidth: Dp,
    body: FontFamily,
    ctx: MdCtx,
) {
    Column(modifier = Modifier.width(tableWidth)) {
        TableRule()
        if (hasHeader) {
            Row(verticalAlignment = Alignment.Top) {
                b.head.forEachIndexed { k, cell ->
                    Cell(cell, widths.getOrElse(k) { 0.dp }, true, b.aligns.getOrElse(k) { "" }, body, ctx)
                }
            }
            TableRule()
        }
        b.rows.forEach { row ->
            Row(verticalAlignment = Alignment.Top) {
                widths.indices.forEach { k ->
                    Cell(row.getOrElse(k) { emptyList() }, widths[k], false, b.aligns.getOrElse(k) { "" }, body, ctx)
                }
            }
            TableRule()
        }
    }
}

/** 表格的行分隔线 —— 桌面端就是这种「只有横线」的样子。 */
@Composable
private fun TableRule() {
    Box(Modifier.fillMaxWidth().height(1.dp).background(Dsh.ListLine))
}

@Composable
private fun Cell(
    nodes: List<MdInline>,
    width: Dp,
    header: Boolean,
    align: String,
    body: FontFamily,
    ctx: MdCtx,
) {
    Box(modifier = Modifier.width(width).background(if (header) Dsh.Chip else Color.Transparent)) {
        Text(
            text = inline(
                nodes, ctx,
                if (header) SpanStyle(fontWeight = FontWeight.W700, fontFamily = ctx.bodyBold, color = Dsh.FgStrong) else null,
            ),
            modifier = Modifier.fillMaxWidth().padding(horizontal = 9.dp, vertical = 6.dp),
            fontSize = CellFont,
            lineHeight = CellLine,
            color = if (header) Dsh.FgStrong else Dsh.ListFg,
            fontFamily = body,
            textAlign = when (align) {
                "right" -> TextAlign.End
                "center" -> TextAlign.Center
                else -> TextAlign.Start
            },
        )
    }
}

// ———————————————————————————————— 行内 ————————————————————————————————

/**
 * 行内渲染要用的东西：等宽字体、图片占位文案、以及「点了文件芯片要干什么」。
 *
 * 做成一个上下文对象是因为行内构建必须是**普通函数**（表格要先量文字宽度才能定列宽，
 * 量宽发生在 composable 之外），而字体与资源只能在 composable 里取。
 */
private class MdCtx(
    val mono: FontFamily,
    /** 正文的粗体族：链式字体族自带不了粗体字面，加粗的块与行内节点都得显式用它。 */
    val bodyBold: FontFamily,
    val imgLabel: String,
    val onFile: (String) -> Unit,
)

@Composable
private fun mdCtx(onFile: ((String) -> Unit)? = null): MdCtx {
    val mono = LocalDshFonts.current.mono
    // CompositionLocal 只能在 composable 里读，remember 的 lambda 里读不到 —— 先取出来
    val bodyBold = LocalDshFonts.current.bodyBold
    val imgLabel = stringResource(R.string.md_image)
    val clipboard = LocalClipboardManager.current
    val context = LocalContext.current
    val copied = stringResource(R.string.md_path_copied)
    return remember(mono, bodyBold, imgLabel, copied, clipboard, context, onFile) {
        MdCtx(mono, bodyBold, imgLabel) { path ->
            // 会话页给了下载动作就走下载；其它地方（比如设置里的预览）保持"复制路径"
            if (onFile != null) {
                onFile(path)
            } else {
                clipboard.setText(AnnotatedString(path))
                Toast.makeText(context, copied + "：" + path, Toast.LENGTH_SHORT).show()
            }
        }
    }
}

/** 一个段落 / 引用 / 列表项：按行拼，行间是换行（网页端的 <br>）。 */
private fun lines(rows: List<List<MdInline>>, ctx: MdCtx): AnnotatedString = buildAnnotatedString {
    rows.forEachIndexed { i, nodes ->
        if (i > 0) append("\n")
        appendInline(nodes, ctx, SpanStyle(color = Dsh.ListFg))
    }
}

private fun inline(nodes: List<MdInline>, ctx: MdCtx, base: SpanStyle? = null): AnnotatedString =
    buildAnnotatedString { appendInline(nodes, ctx, base ?: SpanStyle(color = Dsh.ListFg)) }

/** 递归展开行内节点。强调可以任意嵌套（**粗 *斜* 粗**），所以这里也是递归的。 */
private fun androidx.compose.ui.text.AnnotatedString.Builder.appendInline(
    nodes: List<MdInline>,
    ctx: MdCtx,
    style: SpanStyle,
) {
    for (n in nodes) {
        when (n) {
            is MdInline.T -> withStyle(style) { append(n.text) }
            // 行内代码：底色 + 等宽，两侧各垫一个**不换行空格**当内边距
            // （SpanStyle 画不了 padding，垫 nbsp 是唯一能在底色内部做出留白的办法；
            //   nbsp 不换行，所以代码块边缘不会被拆开，内部该断行还是能断）
            is MdInline.Code -> withStyle(
                style.merge(SpanStyle(background = Dsh.Code, fontFamily = ctx.mono, fontSize = 13.sp)),
            ) {
                append("\u00A0")
                append(n.text)
                append("\u00A0")
            }
            is MdInline.Strong -> appendInline(
                n.kids, ctx,
                style.merge(SpanStyle(fontWeight = FontWeight.W700, fontFamily = ctx.bodyBold, color = Dsh.FgStrong)),
            )
            is MdInline.Em -> appendInline(
                n.kids, ctx, style.merge(SpanStyle(fontStyle = FontStyle.Italic, color = Dsh.FgSoft)),
            )
            is MdInline.StrongEm -> appendInline(
                n.kids,
                ctx,
                style.merge(
                    SpanStyle(
                        fontWeight = FontWeight.W700,
                        fontFamily = ctx.bodyBold,
                        fontStyle = FontStyle.Italic,
                        color = Dsh.FgStrong,
                    ),
                ),
            )
            is MdInline.Del -> appendInline(
                n.kids, ctx, style.merge(SpanStyle(textDecoration = TextDecoration.LineThrough, color = Dsh.Dim2)),
            )
            // 本地文件：蓝色芯片（桌面端也是这样，只是它带 emoji 图标，内置字体没有就不放图标）。
            // 点一下复制路径 —— 真正的「下载到手机」是后面单独一版的功能。
            is MdInline.Link -> if (n.file) {
                withLink(
                    LinkAnnotation.Clickable(
                        tag = "file:" + n.url,
                        styles = TextLinkStyles(SpanStyle(color = Dsh.BrandChipFg, background = Dsh.BrandChipBg)),
                    ) { ctx.onFile(n.url) },
                ) {
                    withStyle(SpanStyle(color = Dsh.BrandChipFg)) { appendInline(n.kids, ctx, style) }
                }
            } else {
                withLink(
                    LinkAnnotation.Url(
                        n.url,
                        TextLinkStyles(SpanStyle(color = Dsh.AccentFg, textDecoration = TextDecoration.Underline)),
                    ),
                ) { appendInline(n.kids, ctx, style) }
            }
            // 图片：只给占位（真加载要解决附件地址与鉴权）
            is MdInline.Img -> withStyle(style.merge(SpanStyle(background = Dsh.Chip, color = Dsh.ListDim))) {
                append("[" + ctx.imgLabel + (if (n.alt.isNotEmpty()) " " + n.alt else "") + "]")
            }
        }
    }
}
