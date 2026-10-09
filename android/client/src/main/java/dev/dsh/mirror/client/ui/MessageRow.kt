package dev.dsh.mirror.client.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
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
 */
@Composable
fun ChatRowView(row: ChatRow) {
    when (row) {
        is ChatRow.User -> UserRow(row)
        is ChatRow.Assistant -> AssistantRow(row)
        is ChatRow.Tool -> ToolRow(row)
        is ChatRow.Notice -> NoticeRow(row)
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
            MarkdownView(row.text)
        }
    }
}

@Composable
private fun AssistantRow(row: ChatRow.Assistant) {
    Column(modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)) {
        if (row.thinkChars > 0) {
            Summary(stringResource(R.string.chat_think, row.thinkChars), Dsh.ListDim3)
        }
        row.tools.forEach { name -> Summary(name, Dsh.ListDim3) }
        MarkdownView(row.text)
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

@Composable
private fun ToolRow(row: ChatRow.Tool) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 3.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Dot(if (row.isError) Dsh.Err else Dsh.LabelCaption)
        Spacer(Modifier.width(7.dp))
        Text(
            text = if (row.detail.isEmpty()) row.name else row.name + "  " + row.detail,
            fontSize = 12.5.sp,
            color = if (row.isError) Dsh.Err else Dsh.ListDim3,
            fontFamily = LocalDshFonts.current.mono,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

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


