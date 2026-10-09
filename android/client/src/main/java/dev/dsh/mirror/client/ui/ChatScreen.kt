package dev.dsh.mirror.client.ui

import android.content.Context
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
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
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.dsh.mirror.client.R
import dev.dsh.mirror.client.net.Sessions
import dev.dsh.mirror.client.theme.Dsh
import dev.dsh.mirror.client.theme.LocalDshFonts
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * 会话页（0.7：**只读**）。
 *
 * <p>数据只有两个来源：`/api/follow` 的 SSE 流（首帧 snapshot = 首屏，之后是增量，
 * 断线重连后又是一份新 snapshot），以及往上翻更早时用的 `/api/page`。
 *
 * <p><b>列表是倒着排的</b>（{@code reverseLayout = true}）：屏幕最下面是 index 0。
 * 这样新消息天然出现在底部、不需要手动滚到底，往上翻就是列表末端 —— 翻页触发条件也因此
 * 写成"最后一个可见项接近末端"。
 *
 * <p>0.8 起底部是真的输入框 + 发送/停止；发送**先乐观上屏**（见 {@link ChatModel#send}）。
 *
 * <p>0.9.1 起有**贴底跟随**（对齐网页端 {@code state.stick}）：贴着底时新内容自动跟下来，
 * 用户往上翻则停住跟随并浮出"回到底部"键。判定的时机与判据见文件内注释 —— 那里有个坑。
 */
@Composable
fun ChatScreen(
    app: Context,
    target: ChatTarget,
    /** 设置里的「显示详细工作过程」：关时每一步只显示简短解释。 */
    detail: Boolean,
    onBack: () -> Unit,
    onExpired: () -> Unit,
) {
    val model = remember(target.id) {
        ChatModel(
            app, target.id, target.title, target.cwd, target.preset, target.running,
            target.initialPrompt,
        )
    }
    val scope = rememberCoroutineScope()
    val listState = rememberLazyListState()

    // 是否"贴在底部"（对齐网页端 state.stick）。初始 true：进会话页就该看到最新一条。
    var stick by remember(target.id) { mutableStateOf(true) }
    val stickGap = with(LocalDensity.current) { 80.dp.toPx() }   // 网页端 STICK_GAP = 80

    LaunchedEffect(target.id) { model.connect(scope) }
    LaunchedEffect(model.expired) { if (model.expired) onExpired() }
    BackHandler { onBack() }

    Column(modifier = Modifier.fillMaxSize().background(Dsh.BgPage)) {
        ChatTopBar(model, onBack)

        if (model.status.isNotEmpty()) StatusStrip(model.status)

        Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
            val shown = model.rows.asReversed()
            LazyColumn(
                state = listState,
                reverseLayout = true,
                modifier = Modifier.fillMaxSize(),
                contentPadding = PaddingValues(top = 10.dp, bottom = 14.dp),
            ) {
                // index 0 = 屏幕最下：正在输出中的那条排在最前，落库的行排在它上面
                if (model.liveVisible) {
                    item(key = "live") {
                        LiveRow(model, detail)
                    }
                }
                // 乐观回显：还没被宿主回显的那几句，排在已落库的行**下面**（也就是屏幕更靠下）
                itemsIndexed(
                    model.pending.asReversed(),
                    key = { _, p -> "p" + p.requestId },
                ) { _, p ->
                    ChatRowView(ChatRow.User(0, p.text), detail, running = false)
                }
                // 落库的行一律 running=false：它们的过程已经结束，标题显示「工作过程」；
                // 真正在跑的那条走上面的 live 块，标题才是「工作中」。
                // key 里带上行的类型：一条 turn/end 可能同时产出「工作过程」与「系统提示」两条，
                // 只按 seq 做 key 会撞（LazyColumn 撞 key 会崩）
                itemsIndexed(shown, key = { _, r -> "s" + r.seq + r.javaClass.simpleName }) { _, row ->
                    ChatRowView(row, detail, running = false)
                }
                if (model.loadingOlder) {
                    item(key = "older") {
                        DimLine(stringResource(R.string.chat_loading_older))
                    }
                }
                if (shown.isEmpty() && !model.liveVisible && !model.loadingOlder) {
                    item(key = "empty") {
                        DimLine(stringResource(R.string.chat_empty))
                    }
                }
            }

            // 用户滚上去看历史时，右下角浮一个"回到底部"键（网页端 btnBottom）。
            // 它和列表是叠着的：Box 的右下角就是输入框上方。
            if (!stick) {
                Box(
                    modifier = Modifier
                        .align(Alignment.BottomEnd)
                        .padding(end = 16.dp, bottom = 12.dp)
                        .size(36.dp)
                        .clip(CircleShape)
                        .background(Dsh.BgPage)
                        .border(1.dp, Dsh.ListLine, CircleShape)
                        .clickable {
                            stick = true
                            scope.launch { listState.animateScrollToItem(0) }
                        },
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        text = "↓",
                        fontSize = 18.sp,
                        lineHeight = 18.sp,
                        color = Dsh.ListDim,
                        fontFamily = LocalDshFonts.current.ui,
                    )
                }
            }

            // 判定只在**滚动停止**的那一刻做。不能直接盯着 firstVisibleItemIndex：
            // 新内容插进倒排列表的 index 0 时，Compose 会按 item key 重锚定 ——
            // 上一刻还贴着底，插入后 firstVisibleItemIndex 就变成 1 了，跟着判定就会
            // 把"正在跟随"误判成"用户滚走了"，然后跟随自己把自己关掉。
            // 所以判据是"用户的手停下来时，视口是不是还在底部附近"。
            LaunchedEffect(listState, stickGap) {
                snapshotFlow { listState.isScrollInProgress }.collect { scrolling ->
                    if (!scrolling) {
                        stick = listState.firstVisibleItemIndex == 0 &&
                            listState.firstVisibleItemScrollOffset <= stickGap
                    }
                }
            }

            // 内容一变就往底贴（仅当用户在底部附近）。**不加动画**：网页端也是
            // stickToBottom(false)，流式输出几十毫秒变一次，动画会互相打架。
            val contentKey = listOf(
                model.rows.size,
                model.pending.size,
                model.liveText.length,
                model.liveThink,          // 是"思考字符数"（Int），不是字符串
                model.liveTools.size,
            )
            LaunchedEffect(contentKey) {
                if (stick && !listState.isScrollInProgress) listState.scrollToItem(0)
            }

            // 往上翻到头（倒排列表的末端）就再要一页
            LaunchedEffect(listState) {
                snapshotFlow {
                    val info = listState.layoutInfo
                    val last = info.visibleItemsInfo.lastOrNull()?.index ?: 0
                    last to info.totalItemsCount
                }.collect { (last, total) ->
                    if (total > 0 && last >= total - 2) model.loadOlder(scope)
                }
            }
        }

        ChatComposer(model, scope)
    }
}

@Composable
private fun ChatTopBar(model: ChatModel, onBack: () -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(start = 6.dp, end = 20.dp, top = 14.dp, bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        DshGlyphButton("←", onBack, fontSize = 20f)
        Spacer(Modifier.width(6.dp))
        Column(modifier = Modifier.weight(1f)) {
            Text(
                model.title.ifEmpty { Sessions.shortPath(model.cwd) },
                fontSize = 17.sp,
                fontWeight = FontWeight.SemiBold,
                color = Dsh.ListFg,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            val sub = subtitleOf(model)
            if (sub.isNotEmpty()) {
                Text(
                    sub,
                    fontSize = 12.sp,
                    color = Dsh.ListDim3,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

private fun subtitleOf(model: ChatModel): String {
    val parts = ArrayList<String>(3)
    model.preset?.takeIf { it.isNotEmpty() }?.let { parts.add(it) }
    model.model?.takeIf { it.isNotEmpty() }?.let { parts.add(it) }
    Sessions.shortPath(model.cwd).takeIf { it.isNotEmpty() }?.let { parts.add(it) }
    return parts.joinToString("  ")
}

/** 连接状态条（正在重连、翻页失败…）。正常时不占位置。 */
@Composable
private fun StatusStrip(text: String) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(Dsh.ErrBg)
            .padding(horizontal = 16.dp, vertical = 7.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(text, fontSize = 12.5.sp, color = Dsh.Err, fontFamily = LocalDshFonts.current.ui)
    }
}

/**
 * 底部输入区：多行输入框 + 发送 / 停止。
 *
 * <p>**停止是两段式**（与网页端一致）：第一下只把按钮点亮成红的"再点一次停止"，
 * 第二下才真发 `/api/cancel`；3 秒没跟上自动复位。网页端当初这么做是因为 `window.confirm`
 * 在 WebView 里恒为 false —— 手机上误触停止的代价（整轮白跑）比多一次点击大得多。
 */
@Composable
private fun ChatComposer(model: ChatModel, scope: CoroutineScope) {
    var draft by remember { mutableStateOf("") }
    var confirmStop by remember { mutableStateOf(false) }
    val body = LocalDshFonts.current.body
    val hint = stringResource(R.string.chat_hint)
    val tStop = stringResource(R.string.chat_stop)
    val tStopAgain = stringResource(R.string.chat_stop_again)

    // 发送失败时把文本还给输入框（用户没接着打字才还，免得覆盖他刚敲的）
    LaunchedEffect(model.restore) {
        val back = model.takeRestore() ?: return@LaunchedEffect
        if (draft.isEmpty()) draft = back
    }
    LaunchedEffect(confirmStop) {
        if (confirmStop) {
            delay(3000)
            confirmStop = false
        }
    }

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 8.dp)
            .heightIn(min = 52.dp)
            .clip(RoundedCornerShape(24.dp))
            .background(Dsh.Field)
            .padding(start = 18.dp, end = 8.dp, top = 8.dp, bottom = 8.dp),
        verticalAlignment = Alignment.Bottom,
    ) {
        Box(modifier = Modifier.weight(1f).padding(bottom = 6.dp)) {
            if (draft.isEmpty()) {
                Text(hint, fontSize = 15.sp, color = Dsh.Placeholder, fontFamily = body, maxLines = 1)
            }
            BasicTextField(
                value = draft,
                onValueChange = { draft = it },
                modifier = Modifier.fillMaxWidth().heightIn(max = 120.dp),
                textStyle = TextStyle(fontSize = 15.sp, lineHeight = 22.sp, color = Dsh.ListFg, fontFamily = body),
                cursorBrush = SolidColor(Dsh.Brand),
                maxLines = 5,
            )
        }

        if (model.running) {
            Box(
                modifier = Modifier
                    .height(34.dp)
                    .clip(RoundedCornerShape(17.dp))
                    .background(if (confirmStop) Dsh.Err else Dsh.BgOverlay)
                    .clickable {
                        if (confirmStop) {
                            confirmStop = false
                            model.cancel(scope)
                        } else {
                            confirmStop = true
                        }
                    }
                    .padding(horizontal = 13.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = if (confirmStop) tStopAgain else tStop,
                    fontSize = if (confirmStop) 11.sp else 12.5.sp,
                    color = if (confirmStop) Color.White else Dsh.ListDim,
                    fontFamily = LocalDshFonts.current.ui,
                )
            }
        } else {
            val canSend = draft.isNotBlank() && !model.sending
            Box(
                modifier = Modifier
                    .size(34.dp)
                    .clip(CircleShape)
                    .background(if (canSend) Dsh.Brand else Dsh.BgOverlay)
                    .clickable(enabled = canSend) {
                        val t = draft.trim()
                        draft = ""
                        scope.launch { model.send(t) }
                    },
                contentAlignment = Alignment.Center,
            ) {
                Text("↑", fontSize = 16.sp, color = if (canSend) Color.White else Dsh.Placeholder)
            }
        }
    }
}

/** 正在流式输出的那条。 */
@Composable
private fun LiveRow(model: ChatModel, detail: Boolean) {
    Column(modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)) {
        // 流式中的工作过程：与落库后**同一条折叠卡**，只是标题是「工作中」
        if (model.liveThink > 0 || model.liveTools.isNotEmpty()) {
            WorkBlock(model.liveThink, model.liveTools, detail, running = true)
            Spacer(Modifier.size(6.dp))
        }
        if (model.liveText.isNotEmpty()) {
            Text(
                model.liveText,
                fontSize = 15.sp,
                lineHeight = 23.sp,
                color = Dsh.ListFg,
                fontFamily = LocalDshFonts.current.body,
            )
        }
    }
}

@Composable
private fun DimLine(text: String) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp),
        horizontalArrangement = Arrangement.Center,
    ) {
        Text(text, fontSize = 12.5.sp, color = Dsh.ListDim3, fontFamily = LocalDshFonts.current.ui)
    }
}
