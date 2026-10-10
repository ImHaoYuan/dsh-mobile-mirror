package dev.dsh.mirror.client.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
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
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.dsh.mirror.client.R
import dev.dsh.mirror.client.theme.Dsh
import dev.dsh.mirror.client.theme.LocalDshFonts

/**
 * 一条消息行（0.7：只读）。
 *
 * <p>版式取自网页端 `app.css` 浅色那套：我发的话是右侧浅蓝气泡（`--me:#e8efff`）、
 * 助手回复左侧无气泡、思考与工具折成一行暗色摘要。**Markdown 与完整的「工作过程」折叠卡是 M4/M5**，
 * 这里只做纯文本 + 围栏代码块（等宽 + 代码底色）。
 *
 * <p><b>0.10.4：不要再给消息行挂长按菜单。</b>0.10.3 试过「长按行里的留白 → 复制整条消息」，
 * 结果与系统选择直接打架：两个弹层同时冒出来；行级 `pointerInput` 还会吃掉点击，导致
 * **点别处关不掉系统的选择工具条**。现在只有 {@link SelectionContainer}，长按就是纯系统行为。
 * 代价是选择范围跨不过段落（一条消息在渲染上是多个 `Text`），要跨段得另想办法。
 */
@Composable
fun ChatRowView(row: ChatRow, detail: Boolean, running: Boolean, onFile: ((String) -> Unit)? = null) {
    when (row) {
        is ChatRow.User -> UserRow(row)
        is ChatRow.Assistant -> AssistantRow(row, detail, running, onFile)
        is ChatRow.Work -> WorkRow(row, detail, running)
        is ChatRow.Notice -> NoticeRow(row)
        is ChatRow.Files -> FilesRow(row, onFile)
    }
}

@Composable
private fun UserRow(row: ChatRow.User) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp),
        horizontalArrangement = Arrangement.End,
    ) {
        // weight(1f, fill = false)：气泡贴着文字长，但最多占满整行 ——
        // 比 fillMaxWidth(0.86f) 好，后者会让短句也撑成一整块。
        Box(
            modifier = Modifier
                .weight(1f, fill = false)
                .clip(RoundedCornerShape(16.dp))
                .background(Dsh.Bubble)
                .padding(horizontal = 12.dp, vertical = 9.dp),
        ) {
            // 与网页端一致：用户气泡里的正文也走 Markdown（同一个 renderMarkdown 入口）
            // 用户自己发的话里没有"电脑上的文件"，所以不给下载动作
            // SelectionContainer = 系统那套：长按出两个手柄 + 浮动工具条，拖手柄选任意范围
            SelectionContainer { MarkdownView(row.text) }
        }
    }
}

@Composable
private fun AssistantRow(
    row: ChatRow.Assistant,
    detail: Boolean,
    running: Boolean,
    onFile: ((String) -> Unit)? = null,
) {
    Column(modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)) {
        if (row.work.isNotEmpty() || row.think.isNotBlank()) {
            WorkBlock(row.think, row.work, detail, running)
            Spacer(Modifier.size(6.dp))
        }
        // 正文可选中（系统手势 + 手柄 + 工具条）
        SelectionContainer { MarkdownView(row.text, onFile = onFile) }
        if (row.interrupted) {
            Spacer(Modifier.size(4.dp))
            Text(
                stringResource(R.string.chat_interrupted),
                fontSize = 12.5.sp,
                color = Dsh.ListDim3,
                fontFamily = LocalDshFonts.current.ui,
            )
        }
    }
}

/** 只有工作过程、没有正文的一条（正文为空的气泡不渲染，见 ChatModel 里的说明）。 */
@Composable
private fun WorkRow(row: ChatRow.Work, detail: Boolean, running: Boolean) {
    Column(modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp)) {
        WorkBlock(row.think, row.steps, detail, running)
    }
}

/**
 * 「工作过程」折叠卡：**思考与工具调用合成一条**。
 *
 * <p>默认收起（用户指定），收起时只占一行「工作中 · N 步」（跑完变「工作过程 · N 步」）。
 * 展开后是**思考正文** + 每一步的**简短解释**；工具名与参数默认不显示 —— 会话里那串
 * `run_code {"code":"…"}` 就是这么藏起来的。设置里打开「显示详细工作过程」后才显示。
 *
 * <p>0.13 起思考存的是**正文**（0.9.3–0.12 只有「思考 N 字」那一行，等于把思考丢了），
 * 而且**思考也算一件** —— 件数与网页端的「N 项」同口径（`app.js` 每段思考都 bumpWork）。
 */
@Composable
internal fun WorkBlock(think: String, steps: List<WorkStep>, detail: Boolean, running: Boolean) {
    // 展开状态**跟随设置**：开关打开就默认展开（用户要的正是这个），关着就默认收起。
    // 只 remember 一次是不够的 —— 在会话里现开开关时，已经渲染出来的卡片不会变，
    // 那正是"开关看着像坏了"的原因。
    var open by remember { mutableStateOf(detail) }
    LaunchedEffect(detail) { open = detail }
    val tRun = stringResource(R.string.chat_work_running)
    val tDone = stringResource(R.string.chat_work_done)
    val tThink = stringResource(R.string.chat_think)
    // 件数 = 工具步骤 + 思考（**思考也算一件**，与网页端的「N 项」同口径）
    val n = steps.size + if (think.isNotBlank()) 1 else 0
    val tSteps = if (n == 0) "" else stringResource(R.string.chat_work_steps, n)
    val title = (if (running) tRun else tDone) + (if (tSteps.isEmpty()) "" else " · " + tSteps)
    // 思考正文的限高：窗口的 40%（等价于网页端 `.work-reason .reason-body { max-height:40vh }`）
    val thinkMax = LocalConfiguration.current.screenHeightDp.dp * 0.4f

    Column(modifier = Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier.fillMaxWidth().clickable { open = !open },
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Dot(if (steps.any { it.isError }) Dsh.Err else Dsh.LabelCaption)
            Spacer(Modifier.width(7.dp))
            Text(
                text = title,
                fontSize = 12.5.sp,
                color = Dsh.ListDim3,
                fontFamily = LocalDshFonts.current.ui,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            FoldMark(open)
        }
        if (open) {
            if (think.isNotBlank()) {
                Text(
                    tThink,
                    fontSize = 11.5.sp,
                    color = Dsh.ListDim3,
                    fontFamily = LocalDshFonts.current.ui,
                    modifier = Modifier.padding(start = 12.dp, top = 4.dp, bottom = 2.dp),
                )
                // 思考正文：纯文本（网页端也是 textContent，不走 Markdown），太长时自己滚。
                // 字体用**正文档**而不是等宽档 —— 网页端那里是 mono，但思考是中文自然语言，
                // 等宽档的中文会掉回设备系统字体，观感反而更差（"只要好看，可以不一致"）。
                Text(
                    think,
                    fontSize = 12.5.sp,
                    lineHeight = 20.sp,
                    color = Dsh.ListDim,
                    fontFamily = LocalDshFonts.current.body,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(start = 12.dp, end = 4.dp, bottom = 2.dp)
                        .heightIn(max = thinkMax)
                        .verticalScroll(rememberScrollState()),
                )
            }
            steps.forEach { step ->
                Row(
                    modifier = Modifier.fillMaxWidth().padding(start = 12.dp, top = 3.dp, bottom = 3.dp),
                    verticalAlignment = Alignment.Top,
                ) {
                    Text(
                        "•",
                        fontSize = 12.5.sp,
                        lineHeight = 19.sp,
                        color = Dsh.ListDim3,
                        fontFamily = LocalDshFonts.current.mono,
                    )
                    Spacer(Modifier.width(6.dp))
                    Text(
                        // 默认只给那句简短解释；详细模式才给「工具名 + 完整参数」
                        text = (if (detail) step.name + "  " + step.detail else step.label).trim().ifEmpty { step.name },
                        fontSize = 12.5.sp,
                        lineHeight = 19.sp,
                        color = if (step.isError) Dsh.Err else Dsh.ListDim,
                        fontFamily = if (detail) LocalDshFonts.current.mono else LocalDshFonts.current.ui,
                    )
                }
            }
        }
    }
}

/** 折叠标记：**画的三角形**（内置字体里没有可靠的箭头字形，项目里一直是这个规矩）。 */
@Composable
private fun FoldMark(open: Boolean) {
    Canvas(modifier = Modifier.size(9.dp)) {
        val path = Path().apply {
            moveTo(size.width * 0.2f, 0f)
            lineTo(size.width * 0.8f, size.height / 2f)
            lineTo(size.width * 0.2f, size.height)
            close()
        }
        if (open) rotate(90f) { drawPath(path, Dsh.ListDim3) } else drawPath(path, Dsh.ListDim3)
    }
}

@Composable
private fun FilesRow(row: ChatRow.Files, onFile: ((String) -> Unit)?) {
    Column(modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp)) {
        Text(
            stringResource(R.string.files_title),
            fontSize = 12.5.sp,
            color = Dsh.ListDim3,
            fontFamily = LocalDshFonts.current.ui,
            modifier = Modifier.padding(bottom = 4.dp),
        )
        row.files.forEach { f ->
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(bottom = 6.dp)
                    .clip(RoundedCornerShape(12.dp))
                    .background(Dsh.Chip)
                    .clickable(enabled = onFile != null) { onFile?.invoke(f.path) }
                    .padding(horizontal = 12.dp, vertical = 9.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        fileNameOf(f.path),
                        fontSize = 13.5.sp,
                        color = Dsh.ListFg,
                        fontFamily = LocalDshFonts.current.ui,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    if (f.description.isNotEmpty()) {
                        Spacer(Modifier.size(2.dp))
                        Text(
                            f.description,
                            fontSize = 12.sp,
                            lineHeight = 17.sp,
                            color = Dsh.ListDim,
                            fontFamily = LocalDshFonts.current.ui,
                            maxLines = 2,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
                Spacer(Modifier.width(10.dp))
                Text(
                    stringResource(R.string.files_download),
                    fontSize = 12.5.sp,
                    color = Dsh.Brand,
                    fontFamily = LocalDshFonts.current.ui,
                )
            }
        }
    }
}

/** 路径最后一段当文件名（电脑端卡片上显示的也是文件名）。 */
private fun fileNameOf(path: String): String =
    path.substringAfterLast('/').substringAfterLast('\\').ifEmpty { path }

@Composable
private fun NoticeRow(row: ChatRow.Notice) {
    Row(modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp)) {
        Box(
            modifier = Modifier
                .clip(RoundedCornerShape(Dsh.RadiusSm))
                .background(if (row.isError) Dsh.ErrBg else Dsh.BgModule)
                .padding(horizontal = 10.dp, vertical = 7.dp),
        ) {
            Text(
                row.text,
                fontSize = 13.sp,
                color = if (row.isError) Dsh.Err else Dsh.ListDim,
                fontFamily = LocalDshFonts.current.body,
            )
        }
    }
}

/** 思考 / 工具名那种一行摘要。**用画的圆点而不是字形**：内置字体里没有可靠的圆点字符。 */
@Composable
private fun Summary(text: String, color: androidx.compose.ui.graphics.Color) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(bottom = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Dot(color)
        Spacer(Modifier.width(7.dp))
        Text(
            text,
            fontSize = 12.5.sp,
            color = color,
            fontFamily = LocalDshFonts.current.ui,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun Dot(color: androidx.compose.ui.graphics.Color) {
    Box(modifier = Modifier.size(5.dp).clip(CircleShape).background(color))
}


