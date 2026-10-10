package dev.dsh.mirror.client.ui

import android.content.Context
import android.widget.Toast
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import dev.dsh.mirror.client.R
import dev.dsh.mirror.client.net.ArchiveResult
import dev.dsh.mirror.client.net.SessionGroup
import dev.dsh.mirror.client.net.SessionRow
import dev.dsh.mirror.client.net.Sessions
import dev.dsh.mirror.client.net.SessionsResult
import dev.dsh.mirror.client.notify.MirrorNotify
import dev.dsh.mirror.client.prefs.Collapse
import dev.dsh.mirror.client.theme.LocalDshFonts
import dev.dsh.mirror.client.theme.Dsh
import kotlinx.coroutines.launch

/**
 * 会话列表（M2）。
 *
 * <p>版式数值全部来自网页端 {@code lib/web/app.css} 的**浅色**那一套：会话行 min 56dp、
 * 内距 12/10、圆点 9dp（上距 7）、标题 15.5sp/600、相对时间靠右 12sp、标签 11.5sp 胶囊、
 * 子会话左缩进 30dp + 2dp 竖引导线。分组头 40dp、组名 12sp/650、数量 11sp、短路径右对齐 11sp。
 *
 * <p><b>默认折叠</b>：网页端 localStorage 没记录时算折叠，这里照抄（用户已确认）。
 */
@Composable
fun SessionListScreen(
    app: Context,
    username: String,
    /** 待答提问中心：服务端的 `pendingQuestion` 要等下一次刷新，这里能立刻变。 */
    questions: QuestionHub,
    reloadKey: Int,
    onRefresh: () -> Unit,
    onNew: () -> Unit,
    onMore: () -> Unit,
    onExpired: () -> Unit,
    onOpenSession: (SessionRow) -> Unit,
) {
    val collapse = remember { Collapse(app) }
    val scope = rememberCoroutineScope()
    val collapsed = remember { mutableStateMapOf<String, Boolean>() }
    var groups by remember { mutableStateOf<List<SessionGroup>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    var loadedOnce by remember { mutableStateOf(false) }
    var lastAt by remember { mutableStateOf(0L) }
    var error by remember { mutableStateOf("") }

    val tTitle = stringResource(R.string.list_title)
    val tLoading = stringResource(R.string.list_loading)
    val tUnreachable = stringResource(R.string.net_unreachable)
    val tBroken = stringResource(R.string.list_broken)
    val tRetry = stringResource(R.string.list_retry)
    val tEmptyTitle = stringResource(R.string.list_empty_title)
    val tEmptyNote = stringResource(R.string.list_empty_note)
    val tTagAsk = stringResource(R.string.tag_ask)
    val tTagOn = stringResource(R.string.tag_on)
    val tTagNoAgent = stringResource(R.string.tag_no_agent)
    val tTagBlank = stringResource(R.string.tag_blank)

    LaunchedEffect(reloadKey) {
        loading = true
        error = ""
        when (val r = Sessions.load(app)) {
            is SessionsResult.Ok -> {
                groups = r.groups
                loadedOnce = true
                lastAt = System.currentTimeMillis()
                // 0.15.5：列表里有"在跑 / 等回答"的会话，就把 :core 的监测服务拉起来。
                //
                // 原先只有"回到前台"和"进主页那一下"会去 ensure()，而 ensure 是"**先查、查到有才起**"：
                // 停在主页那一刻往往正好没有会话在跑 → 服务根本没起 → 之后电脑上新开一个会话，
                // 手机上既不会自动刷新列表、也没有任何监测在跑，于是**怎么点刷新都不出岛**。
                // 刷新这条路是"用户明确要看最新状态"，顺手把监测拉起来最自然。
                if (r.groups.any { g -> g.items.any { it.running || it.pendingQuestion } }) {
                    MirrorNotify.start(app)
                }
            }
            is SessionsResult.Failed -> error = r.message
            SessionsResult.Expired -> onExpired()
            SessionsResult.Unreachable -> error = tUnreachable
            SessionsResult.Broken -> error = tBroken
        }
        loading = false
    }

    // 回到前台且距上次成功刷新超过 10 秒就自动刷一次（网页端 visibilitychange 的同义实现）
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) {
        if (loadedOnce && System.currentTimeMillis() - lastAt > 10_000) onRefresh()
    }

    // —— 长按删除（归档）——
    // 只放行空白会话：那种会话没有任何工作在跑，归档一定成功；也正好挡住"长按误删
    // 正在聊的会话"。归档是**软删除** —— 会话文件还在磁盘上，电脑端「已归档」里找得回来，
    // 所以桌面端对静止会话也是不弹确认直接提交的；这里仍弹一次，因为手机上没有"撤销"入口。
    var pending by remember { mutableStateOf<SessionRow?>(null) }
    var deleting by remember { mutableStateOf(false) }
    val tBlankOnly = stringResource(R.string.del_blank_only)
    val tDelTitle = stringResource(R.string.del_title)
    val tDelNote = stringResource(R.string.del_note)
    val tDelConfirm = stringResource(R.string.del_confirm)
    val tDelCancel = stringResource(R.string.del_cancel)

    fun askDelete(row: SessionRow) {
        if (!row.blank) {
            Toast.makeText(app, tBlankOnly, Toast.LENGTH_SHORT).show()
            return
        }
        pending = row
    }

    fun doDelete(row: SessionRow) {
        if (deleting) return
        deleting = true
        scope.launch {
            val r = Sessions.archive(app, row.id)
            deleting = false
            pending = null
            when (r) {
                is ArchiveResult.Ok -> {
                    // 本地立刻摘掉，不等下一次刷新 —— 否则行会在屏幕上多留几秒，
                    // 看着像"点了没反应"。空掉的分组一并收走（服务端也是这么分组的）。
                    groups = groups.mapNotNull { g ->
                        val items = g.items.filter { it.id != row.id }
                        if (items.isEmpty()) null else g.copy(items = items)
                    }
                }
                is ArchiveResult.Rejected -> Toast.makeText(app, r.message, Toast.LENGTH_LONG).show()
                ArchiveResult.Expired -> onExpired()
                ArchiveResult.Unreachable -> Toast.makeText(app, tUnreachable, Toast.LENGTH_LONG).show()
            }
        }
    }

    fun isCollapsed(key: String): Boolean = collapsed[key] ?: collapse.isCollapsed(key)

    fun toggle(key: String) {
        val next = !isCollapsed(key)
        collapsed[key] = next
        collapse.set(key, next)
    }

    // 子智能体在侧栏里彻底不显示（0.15.8）。分组头的会话数、"空列表"、运行圆点都用这一份。
    val visible = Sessions.withoutChildren(groups)

    Column(modifier = Modifier.fillMaxSize().background(Dsh.BgPage)) {
        // 抽屉头部：标题 + 账号名 + 刷新 + 更多（首页把这三个键都让给了抽屉）
        TopBar(title = tTitle, sub = username, onRefresh = onRefresh, onMore = onMore)
        NewSessionRow(onNew)

        if (error.isNotEmpty()) {
            Column(modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 10.dp)) {
                DshError(error)
                Spacer(Modifier.height(10.dp))
                DshSecondaryButton(tRetry) { onRefresh() }
            }
        }

        LazyColumn(modifier = Modifier.weight(1f)) {
            if (visible.isEmpty() && error.isEmpty()) {
                item {
                    if (loading) HintLine(tLoading)
                    else EmptyState(tEmptyTitle, tEmptyNote)
                }
            }
            for (g in visible) {
                item(key = "group:" + g.key) {
                    GroupHead(group = g, collapsed = isCollapsed(g.key)) { toggle(g.key) }
                }
                if (!isCollapsed(g.key)) {
                    // 服务端已按 updatedAt 排好序；子智能体在上面 withoutChildren 里就滤掉了
                    items(g.items, key = { it.id }) { row ->
                        SessionRowView(
                            row = row,
                            ask = row.pendingQuestion || questions.countFor(row.id) > 0,
                            tAsk = tTagAsk,
                            tOn = tTagOn,
                            tNoAgent = tTagNoAgent,
                            tBlank = tTagBlank,
                            onClick = { onOpenSession(row) },
                            onLongClick = { askDelete(row) },
                        )
                    }
                }
            }
        }
    }

    pending?.let { row ->
        AlertDialog(
            onDismissRequest = { if (!deleting) pending = null },
            title = { Text(tDelTitle) },
            text = { Text(tDelNote) },
            confirmButton = {
                TextButton(onClick = { doDelete(row) }, enabled = !deleting) { Text(tDelConfirm) }
            },
            dismissButton = {
                TextButton(onClick = { pending = null }, enabled = !deleting) { Text(tDelCancel) }
            },
        )
    }
}

/** 抽屉里的「＋ 新建会话」一行（DeepSeek 抽屉顶部也有这么一个入口）。 */
@Composable
private fun NewSessionRow(onNew: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onNew)
            .padding(horizontal = 20.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text("＋", fontSize = 16.sp, fontWeight = FontWeight.Medium, color = Dsh.Brand)
        Spacer(Modifier.width(10.dp))
        Text(
            stringResource(R.string.new_title),
            fontSize = 14.5f.sp,
            fontWeight = FontWeight.SemiBold, fontFamily = LocalDshFonts.current.uiBold,
            color = Dsh.ListFg,
        )
    }
    Box(Modifier.fillMaxWidth().height(1.dp).background(Dsh.ListLine))
}

@Composable
private fun TopBar(
    title: String,
    sub: String,
    onRefresh: () -> Unit,
    onMore: () -> Unit,
) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(start = 20.dp, end = 6.dp, top = 14.dp, bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(title, fontSize = 19.sp, fontWeight = FontWeight.SemiBold, fontFamily = LocalDshFonts.current.uiBold, color = Dsh.ListFg)
            if (sub.isNotEmpty()) Text(sub, fontSize = 12.sp, color = Dsh.ListDim3)
        }
        DshIconButton(R.drawable.ic_refresh, onRefresh, stringResource(R.string.cd_refresh))
        DshIconButton(R.drawable.ic_more, onMore, stringResource(R.string.cd_more))
    }
}

@Composable
private fun GroupHead(group: SessionGroup, collapsed: Boolean, onToggle: () -> Unit) {
    val angle by animateFloatAsState(
        targetValue = if (collapsed) -90f else 0f,
        label = "caret",
    )
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 40.dp)
            .clickable(onClick = onToggle)
            .padding(start = 20.dp, end = 20.dp, top = 6.dp, bottom = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text("▼", modifier = Modifier.width(11.dp).rotate(angle), fontSize = 9.sp, color = Dsh.ListDim)
        Spacer(Modifier.width(8.dp))
        Text(
            group.name,
            fontSize = 12.sp,
            fontWeight = FontWeight(650),
            letterSpacing = 0.4.sp,
            color = Dsh.ListDim,
            maxLines = 1,
        )
        Spacer(Modifier.width(8.dp))
        Text(group.items.size.toString(), fontSize = 11.sp, color = Dsh.ListDim3)
        Text(
            Sessions.shortPath(group.path),
            modifier = Modifier.weight(1f),
            fontSize = 11.sp,
            color = Dsh.ListDim3,
            textAlign = TextAlign.End,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        if (group.running) {
            Spacer(Modifier.width(6.dp))
            Dot(on = true)
        }
    }
}

/** 运行中的圆点：带一点呼吸感（网页端是 box-shadow + pulse 动画）。 */
@Composable
private fun Dot(on: Boolean) {
    val transition = rememberInfiniteTransition(label = "dot")
    val alpha by transition.animateFloat(
        initialValue = 1f,
        targetValue = 0.35f,
        animationSpec = infiniteRepeatable(tween(1500), RepeatMode.Reverse),
        label = "dot-alpha",
    )
    Box(
        modifier = Modifier
            .size(9.dp)
            .clip(CircleShape)
            .background(if (on) Dsh.Ok.copy(alpha = alpha) else Dsh.ListLine2),
    )
}

private data class RowTag(val text: String, val fg: Color, val border: Color, val bg: Color)

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun SessionRowView(
    row: SessionRow,
    /** 有提问等着我回答（服务端标记，或本地那条流刚推来的）。 */
    ask: Boolean,
    tAsk: String,
    tOn: String,
    tNoAgent: String,
    tBlank: String,
    onClick: () -> Unit,
    /** 长按：只有空白会话会被真的删掉，其余给一句提示（判断在调用方）。 */
    onLongClick: () -> Unit,
) {
    val tags = ArrayList<RowTag>(3)
    // 「待回答」放最前：它是唯一"需要你动手"的状态
    if (ask) tags.add(RowTag(tAsk, Dsh.AccentFg, Dsh.LineAsk, Dsh.Sel))
    if (row.running) tags.add(RowTag(tOn, Dsh.Ok, Dsh.LineOk, Dsh.OkBg))
    if (!row.agentAvailable) tags.add(RowTag(tNoAgent, Dsh.ListDim, Dsh.ListLine, Color.Transparent))
    if (row.blank) tags.add(RowTag(tBlank, Dsh.ListDim, Dsh.ListLine, Color.Transparent))

    Box(
        modifier = Modifier.fillMaxWidth(),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 56.dp)
                .combinedClickable(onClick = onClick, onLongClick = onLongClick)
                .padding(start = 20.dp, end = 20.dp, top = 12.dp, bottom = 12.dp),
            horizontalArrangement = Arrangement.spacedBy(11.dp),
            verticalAlignment = Alignment.Top,
        ) {
            Box(modifier = Modifier.padding(top = 7.dp)) { Dot(on = row.running) }

            Column(modifier = Modifier.weight(1f)) {
                Text(
                    row.label,
                    fontSize = 15.5f.sp,
                    lineHeight = 21.7f.sp,
                    fontWeight = FontWeight.SemiBold, fontFamily = LocalDshFonts.current.uiBold,
                    color = Dsh.ListFg,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                if (tags.isNotEmpty()) {
                    Row(
                        modifier = Modifier.padding(top = 7.dp),
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        for (t in tags) TagChip(t)
                    }
                }
            }

            Text(
                Sessions.relTime(row.updatedAt),
                modifier = Modifier.padding(top = 2.dp),
                fontSize = 12.sp,
                color = Dsh.ListDim,
                maxLines = 1,
            )
        }
    }
}

@Composable
private fun TagChip(tag: RowTag) {
    val shape = RoundedCornerShape(999.dp)
    Box(
        modifier = Modifier
            .clip(shape)
            .background(tag.bg)
            .border(1.dp, tag.border, shape)
            .padding(horizontal = 8.dp, vertical = 1.dp),
    ) {
        Text(tag.text, fontSize = 11.5f.sp, lineHeight = 17.sp, color = tag.fg, maxLines = 1)
    }
}

@Composable
private fun HintLine(text: String) {
    Text(
        text,
        modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 16.dp),
        fontSize = 13.sp,
        color = Dsh.ListDim,
    )
}

@Composable
private fun EmptyState(title: String, note: String) {
    Column(
        modifier = Modifier.fillMaxWidth().padding(start = 24.dp, end = 24.dp, top = 80.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(title, fontSize = 15.sp, fontWeight = FontWeight.SemiBold, fontFamily = LocalDshFonts.current.uiBold, color = Dsh.ListFg)
        Spacer(Modifier.height(6.dp))
        Text(
            note,
            fontSize = 12.5f.sp,
            lineHeight = 20.sp,
            color = Dsh.ListDim,
            textAlign = TextAlign.Center,
        )
    }
}
