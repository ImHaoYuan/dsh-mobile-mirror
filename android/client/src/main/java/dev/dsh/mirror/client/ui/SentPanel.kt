package dev.dsh.mirror.client.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.dsh.mirror.client.R
import dev.dsh.mirror.client.theme.Dsh
import dev.dsh.mirror.client.theme.LocalDshFonts
import kotlin.math.abs

/**
 * 「已发消息」清单里的一行。
 *
 * @param text 我发出去的那一句（面板里只显示一行，超长省略号）。
 * @param item 这句在会话列表里的 item 下标 —— 点它就用它跳。
 */
class SentEntry(val text: String, val item: Int)

/**
 * 视口中线附近的那条 item 下标。
 *
 * <p>会话列表是**倒排**的（`reverseLayout = true`，index 0 在屏幕最下），而且
 * `visibleItemsInfo` 的顺序不保证，所以先按 index 排一遍再取中位。
 *
 * <p>读的是 `layoutInfo`：**只能在 composition 之外、或专门的子作用域里调**。
 * 在 ChatScreen 主体里直接读会让整屏跟着滚动每一帧重组。
 */
internal fun centerItemOf(state: LazyListState): Int {
    val idx = state.layoutInfo.visibleItemsInfo.map { it.index }.sorted()
    if (idx.isEmpty()) return 0
    return idx[idx.size / 2]
}

/**
 * 离 [center] 最近的一条「已发消息」（= 我正在看的那条）。
 *
 * <p>打平时取**更新**的那条：`items` 按由新到旧给，而 `<` 保留先遇到的那个。
 * 与网页端「视口中线落在哪两条消息之间 → 高亮最近的那条」同款判据。
 */
internal fun anchorOf(items: List<Int>, center: Int): Int {
    var best = -1
    var bestD = Int.MAX_VALUE
    for (i in items) {
        val d = abs(i - center)
        if (d < bestD) {
            bestD = d
            best = i
        }
    }
    return best
}

/**
 * 「已发消息」面板（0.14，0.14.1 改名）：把我自己发出去的消息列成清单，点一条就跳过去。
 *
 * <p>为什么不是网页端那条右侧刻度条（见 docs/client-plan.md §4.25）：刻度条贴在右边沿，
 * 在安卓上会跟**系统返回手势**打架；3px 的点在手机上本来就难戳；而"找我发过的那句"
 * 靠**认字**比靠猜点靠谱得多 —— 所以换成一份带原文的清单。
 *
 * <p>只列**我自己**的消息（助手每轮说一大段，全列出来等于没列），也不列乐观回显
 * （还没落库，位置随后会跳一次）。
 *
 * @param entries 由新到旧（最近发的排最上面 —— 要找的通常是刚发的那条）。
 * @param listState 用来算「我正在看哪一条」。
 * @param onJump 点某一行：把它的 item 下标交给调用方去跳。
 */
@Composable
fun SentPanel(
    entries: List<SentEntry>,
    listState: LazyListState,
    maxHeight: Dp,
    onJump: (Int) -> Unit,
) {
    // 高亮「我正在看的那条」。走 snapshotFlow 而不是在 composition 里直接读 layoutInfo：
    // 值只在**跨过一条消息**时才变，所以滚动过程中不会每帧重组。
    var cur by remember(entries) { mutableStateOf(-1) }
    LaunchedEffect(listState, entries) {
        val items = entries.map { it.item }
        snapshotFlow { centerItemOf(listState) }.collect { c -> cur = anchorOf(items, c) }
    }

    PanelBody(maxHeight) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                stringResource(R.string.sent_title),
                fontSize = 13.sp,
                fontWeight = FontWeight.SemiBold,
                color = Dsh.ListFg,
                fontFamily = LocalDshFonts.current.uiBold,
            )
            if (entries.isNotEmpty()) {
                Spacer(Modifier.width(6.dp))
                Text(
                    stringResource(R.string.sent_count, entries.size),
                    fontSize = 11.5.sp,
                    color = Dsh.ListDim3,
                    fontFamily = LocalDshFonts.current.ui,
                )
            }
        }
        if (entries.isEmpty()) {
            Text(
                stringResource(R.string.sent_empty),
                fontSize = 12.5.sp,
                color = Dsh.ListDim3,
                fontFamily = LocalDshFonts.current.ui,
                modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
            )
        }
        entries.forEach { e ->
            val on = e.item == cur
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(Dsh.RadiusMd))
                    .background(if (on) Dsh.Sel else Color.Transparent)
                    .clickable { onJump(e.item) }
                    .padding(horizontal = 12.dp, vertical = 9.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    e.text,
                    fontSize = 13.sp,
                    lineHeight = 19.sp,
                    color = if (on) Dsh.ListFg else Dsh.ListDim,
                    fontFamily = LocalDshFonts.current.ui,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
            }
        }
    }
}
