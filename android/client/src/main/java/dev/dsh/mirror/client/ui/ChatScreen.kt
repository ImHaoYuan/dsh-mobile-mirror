package dev.dsh.mirror.client.ui

import android.content.Intent
import android.net.Uri
import android.widget.Toast
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.TextButton
import dev.dsh.mirror.ServerPrefs
import dev.dsh.mirror.client.notify.MirrorNotify
import dev.dsh.mirror.client.net.Download
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

import android.content.Context
import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
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
import androidx.compose.foundation.lazy.LazyListState
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
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.dsh.mirror.client.R
import dev.dsh.mirror.client.net.Models
import dev.dsh.mirror.client.net.PickOutcome
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
    /** 模型目录缓存（0.12，进程内一份，三个入口共用）。 */
    hub: ModelHub,
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

    /** 胶囊行下面开着哪一块面板（0.12.3 起是就地展开的面板，不再是盖住整屏的卡片）。 */
    var panel by remember(target.id) { mutableStateOf(ChipPanel.None) }
    // 收起动画期间 panel 已经是 None，所以单独留一份「最后展开的是哪个」给内容用，
    // 否则内容会先变空、动画只剩一片空白在缩（首页文件夹清单同款）
    var lastPanel by remember(target.id) { mutableStateOf(ChipPanel.Model) }
    LaunchedEffect(panel) {
        if (panel != ChipPanel.None) lastPanel = panel
    }
    /** 面板最高「半个窗口」（按当前窗口算，键盘在的时候窗口已经缩了）。 */
    val halfScreen = LocalConfiguration.current.screenHeightDp.dp * 0.5f

    val tCapsule = stringResource(R.string.model_capsule)
    val tPreset = stringResource(R.string.model_preset_default)
    val tExpired = stringResource(R.string.chat_expired)
    val tUnreachable = stringResource(R.string.login_err_unreachable)
    /** 模式 id → 中文名（清单还没拉到时胶囊退回 id 本身）。 */
    val presetLabels = hub.presets.associate { it.id to it.label }

    // 是否"贴在底部"（对齐网页端 state.stick）。初始 true：进会话页就该看到最新一条。
    var stick by remember(target.id) { mutableStateOf(true) }
    val stickGap = with(LocalDensity.current) { 80.dp.toPx() }   // 网页端 STICK_GAP = 80
    val density = LocalDensity.current

    /**
     * 0.14「已发消息」：我自己发出去的每一条 + 它在会话列表里的 item 下标。
     *
     * <p>会话列表是**倒排**的（index 0 在屏幕最下），前面还压着「正在输出」与「乐观回显」
     * 两块，所以 item 下标 = 前缀 + 它在倒排行里的位置。乐观回显**不算**（还没落库，
     * 位置随后会跳一次 —— 与网页端刻度条同款判据）。顺序是**由新到旧**：要找的通常
     * 是刚发出去的那条。
     */
    val sent = remember(model.rows, model.pending.size, model.liveVisible) {
        val prefix = (if (model.liveVisible) 1 else 0) + model.pending.size
        model.rows.asReversed().mapIndexedNotNull { i, r ->
            if (r is ChatRow.User) SentEntry(r.text, prefix + i) else null
        }
    }
    val sentItems = remember(sent) { sent.map { it.item } }

    /**
     * 跳到某条消息。
     *
     * <p>倒排列表里 `scrollToItem` 会把目标放在**底边**，而"回头看"要的是它落在
     * **顶边附近**（这样它下面紧接着就是当轮的回复）。目标高度只能估 —— 估小一点
     * 没关系（落点略低于顶边也看得见），估大了会把目标顶出屏幕外。
     */
    val jumpTo: (Int) -> Unit = { item ->
        panel = ChipPanel.None
        stick = false
        scope.launch {
            val vh = listState.layoutInfo.viewportSize.height
            // 目标高度：看得见就直接量，看不见按字数估。**宁可估高** —— 估低了会把
            // 这句的开头顶出屏幕外（长提示词很常见），估高只是落点偏低一点。
            val known = listState.layoutInfo.visibleItemsInfo.firstOrNull { it.index == item }?.size
            val est = known ?: run {
                val n = sent.firstOrNull { it.item == item }?.text?.length ?: 0
                val lines = n / 18 + 1
                with(density) { (46 + lines * 20).coerceAtMost(320).dp.roundToPx() }
            }
            listState.animateScrollToItem(item, scrollOffset = (vh - est).coerceAtLeast(0))
        }
    }

    LaunchedEffect(target.id) { model.connect(scope) }
    LaunchedEffect(target.id) { hub.ensure() }
    LaunchedEffect(model.expired) { if (model.expired) onExpired() }
    // 0.15：一旦有会话在跑，就把 :core 的前台服务拉起来（常驻通知 + 超级岛）。
    // 触发源是"流里看到 turn/start"，所以**电脑上开跑的会话、手机正看着也一样接得上**。
    // 只起不停 —— 服务空闲 30 秒会自己停。
    LaunchedEffect(model.running) {
        if (model.running) MirrorNotify.start(app)
    }
    BackHandler { onBack() }

    // —— 下载文件（0.10）——
    // 用户指定的交互：点一次只**问**，再点才真的下；存进系统的「下载」目录。
    var dl by remember(target.id) { mutableStateOf<Dl?>(null) }
    val startDownload: (String, String) -> Unit = { path, name ->
        dl = Dl.Busy(name, 0, -1)
        scope.launch {
            val prefs = ServerPrefs(app)
            var lastPct = -1
            val res = withContext(Dispatchers.IO) {
                Download.run(app, prefs, target.id, path) { done, total ->
                    if (total > 0) {
                        val pct = (done * 100 / total).toInt()
                        // 每 1% 才回主线程刷一次，别把进度刷成刷屏
                        if (pct != lastPct) {
                            lastPct = pct
                            scope.launch { dl = Dl.Busy(name, done, total) }
                        }
                    }
                }
            }
            dl = when (res) {
                is Download.Result.Ok -> Dl.Done(res.name, res.uri)
                is Download.Result.Fail -> Dl.Fail(res.message)
            }
        }
    }
    val openDownload: (Uri) -> Unit = { uri ->
        dl = null
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, app.contentResolver.getType(uri) ?: "*/*")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        try {
            app.startActivity(intent)
        } catch (_: Exception) {
            Toast.makeText(app, app.getString(R.string.dl_no_app), Toast.LENGTH_SHORT).show()
        }
    }
    dl?.let { state ->
        DownloadDialog(
            state = state,
            onCancel = { dl = null },
            onStart = startDownload,
            onOpen = openDownload,
        )
    }

    Box(modifier = Modifier.fillMaxSize()) {
        Column(modifier = Modifier.fillMaxSize().background(Dsh.BgPage)) {
            ChatTopBar(
                model = model,
                onBack = onBack,
                hasSent = sent.isNotEmpty(),
                onSent = { panel = if (panel == ChipPanel.Jump) ChipPanel.None else ChipPanel.Jump },
            )

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
                        ChatRowView(row, detail, running = false, onFile = { path -> dl = Dl.Ask(path, baseNameOf(path)) })
                    }
                    if (model.loadingOlder) {
                        item(key = "older") {
                            OlderLoadingRow()
                        }
                    } else if (model.olderError != null) {
                        // 失败后不再自动重发（一次翻页要宿主现场读整个会话日志），
                        // 所以这里必须给一个**能点**的出口
                        item(key = "olderErr") {
                            OlderFailedRow(model.olderError!!) { model.retryOlder(scope) }
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
                // 往上翻的时候右下角浮两个键：↑ 跳到我说的**上一句**（0.14 的 B 兜底），
                // ↓ 回到底部（原有）。叠在一起而不是并排 —— 并排会压到消息正文。
                if (!stick) {
                    Column(
                        modifier = Modifier
                            .align(Alignment.BottomEnd)
                            .padding(end = 16.dp, bottom = 12.dp),
                        horizontalAlignment = Alignment.End,
                    ) {
                        PrevSentButton(listState, sentItems, jumpTo)
                        Box(
                            modifier = Modifier
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
                    model.liveThink.length,   // 用长度当 key：思考正文每来一小段就变一次
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
                        // auto = true：失败过就不再自动重发，交给顶部那行的「点这里重试」
                        if (total > 0 && last >= total - 2) model.loadOlder(scope, auto = true)
                    }
                }
            }

            // 胶囊行（0.12）：模型 · 档位 / 模式。两颗各占一半（字长了省略号），
            // 点开就地展开的面板（0.12.3）—— 会话页没有文件夹那颗，路径是会话级的。
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(start = 16.dp, end = 16.dp, bottom = 10.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                ModelCapsule(
                    modifier = Modifier.weight(1f, fill = false),
                    text = ModelLogic.capsuleText(hub.catalog, model.pick, tCapsule),
                    open = panel == ChipPanel.Model,
                    onClick = { panel = if (panel == ChipPanel.Model) ChipPanel.None else ChipPanel.Model },
                )
                ModelCapsule(
                    modifier = Modifier.weight(1f, fill = false),
                    text = ModelLogic.presetText(presetLabels, model.preset.orEmpty(), tPreset),
                    open = panel == ChipPanel.Preset,
                    onClick = { panel = if (panel == ChipPanel.Preset) ChipPanel.None else ChipPanel.Preset },
                )
            }

            // 面板紧贴胶囊行下面、输入框上面：消息列表在上面，被往上挤（不是被盖住）
            AnimatedVisibility(
                visible = panel != ChipPanel.None,
                enter = expandVertically(tween(PANEL_MS)) + fadeIn(tween(PANEL_MS)),
                exit = shrinkVertically(tween(PANEL_MS)) + fadeOut(tween(PANEL_MS)),
            ) {
                when (lastPanel) {
                    ChipPanel.Model -> ModelPanel(
                        hub = hub,
                        pick = model.pick,
                        maxHeight = halfScreen,
                        onPick = { p ->
                            when (val r = Models.select(app, target.id, p)) {
                                is PickOutcome.Ok -> {
                                    model.setPick(p)
                                    null
                                }
                                is PickOutcome.Rejected -> PickReply(r.message)
                                PickOutcome.Expired -> {
                                    onExpired()
                                    PickReply(tExpired)
                                }
                                PickOutcome.Unreachable -> PickReply(tUnreachable)
                            }
                        },
                    )
                    ChipPanel.Preset -> PresetPanel(
                        hub = hub,
                        presetId = model.preset.orEmpty(),
                        // 跑过至少一轮就锁死（网页端同款信号：`row.blank === false`）
                        presetLocked = !target.blank,
                        maxHeight = halfScreen,
                        onPreset = { id ->
                            when (val r = Models.selectPreset(app, target.id, id)) {
                                is PickOutcome.Ok -> {
                                    model.applyPreset(id)
                                    null
                                }
                                // `preset-locked`：把整段模式置灰，别让人反复点
                                is PickOutcome.Rejected -> PickReply(r.message, r.code == "preset-locked")
                                PickOutcome.Expired -> {
                                    onExpired()
                                    PickReply(tExpired)
                                }
                                PickOutcome.Unreachable -> PickReply(tUnreachable)
                            }
                        },
                        onDismiss = { panel = ChipPanel.None },
                    )
                    ChipPanel.Jump -> SentPanel(
                        entries = sent,
                        listState = listState,
                        maxHeight = halfScreen,
                        onJump = jumpTo,
                    )
                    else -> {}
                }
            }

            ChatComposer(model, scope)
        }

    }
}

@Composable
private fun ChatTopBar(
    model: ChatModel,
    onBack: () -> Unit,
    /** 0.14：有「已发消息」可列时才显示入口 —— 点开一片空的比没有入口更让人困惑。 */
    hasSent: Boolean,
    onSent: () -> Unit,
) {
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
                fontWeight = FontWeight.SemiBold, fontFamily = LocalDshFonts.current.uiBold,
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
        if (hasSent) {
            DshIconButton(R.drawable.ic_sent, onSent, stringResource(R.string.cd_sent))
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

/** 下载对话框的状态机。 */
private sealed class Dl {
    /** 第一次点击：只问，不下。 */
    class Ask(val path: String, val name: String) : Dl()

    /** 下载中；total 未知时给 -1。 */
    class Busy(val name: String, val done: Long, val total: Long) : Dl()

    class Done(val name: String, val uri: Uri) : Dl()

    class Fail(val message: String) : Dl()
}

/** 路径最后一段当文件名（给"是否下载文件（x）？"用）。 */
private fun baseNameOf(path: String): String =
    path.substringAfterLast('/').substringAfterLast('\\').ifEmpty { path }

@Composable
private fun DownloadDialog(
    state: Dl,
    onCancel: () -> Unit,
    onStart: (String, String) -> Unit,
    onOpen: (Uri) -> Unit,
) {
    val title = stringResource(R.string.dl_title)
    when (state) {
        is Dl.Ask -> AlertDialog(
            onDismissRequest = onCancel,
            title = { Text(title) },
            text = { Text(stringResource(R.string.dl_ask, state.name)) },
            confirmButton = { TextButton(onClick = { onStart(state.path, state.name) }) { Text(stringResource(R.string.dl_start)) } },
            dismissButton = { TextButton(onClick = onCancel) { Text(stringResource(R.string.dl_cancel)) } },
        )
        is Dl.Busy -> AlertDialog(
            onDismissRequest = { /* 下载中不让点外面关掉 */ },
            title = { Text(title) },
            text = {
                Column {
                    Text(stringResource(R.string.dl_running, state.name))
                    Spacer(Modifier.height(6.dp))
                    Text(
                        if (state.total > 0) {
                            stringResource(R.string.dl_progress, (state.done * 100 / state.total).toInt())
                        } else {
                            stringResource(R.string.dl_progress_unknown, state.done / 1024)
                        },
                    )
                }
            },
            confirmButton = {},
        )
        is Dl.Done -> AlertDialog(
            onDismissRequest = onCancel,
            title = { Text(title) },
            text = { Text(stringResource(R.string.dl_done, state.name)) },
            confirmButton = { TextButton(onClick = { onOpen(state.uri) }) { Text(stringResource(R.string.dl_open)) } },
            dismissButton = { TextButton(onClick = onCancel) { Text(stringResource(R.string.dl_cancel)) } },
        )
        is Dl.Fail -> AlertDialog(
            onDismissRequest = onCancel,
            title = { Text(title) },
            text = { Text(state.message) },
            confirmButton = { TextButton(onClick = onCancel) { Text(stringResource(R.string.dl_ok)) } },
        )
    }
}

/**
 * 0.14 的 B 兜底键：跳到我**当前视口之上**最近的那条「已发消息」。
 *
 * <p>上面没有了就整颗不显示（不是灰着 —— 灰键在手机上只会让人反复戳）。
 * 状态放在这个小组件里：视口一变只有它重组，不会把整屏拖下水。
 */
@Composable
private fun PrevSentButton(listState: LazyListState, items: List<Int>, onJump: (Int) -> Unit) {
    var prev by remember(items) { mutableStateOf(-1) }
    LaunchedEffect(listState, items) {
        snapshotFlow { centerItemOf(listState) }.collect { c ->
            val anchor = anchorOf(items, c)
            // 倒排列表里 index 越大越旧：比我这条更旧的里面，取最近的那个
            prev = items.filter { it > anchor }.minOrNull() ?: -1
        }
    }
    if (prev < 0) return
    Box(
        modifier = Modifier
            .size(36.dp)
            .clip(CircleShape)
            .background(Dsh.BgPage)
            .border(1.dp, Dsh.ListLine, CircleShape)
            .clickable { onJump(prev) },
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = "↑",
            fontSize = 18.sp,
            lineHeight = 18.sp,
            color = Dsh.ListDim,
            fontFamily = LocalDshFonts.current.ui,
        )
    }
    Spacer(Modifier.height(8.dp))
}

/** 正在流式输出的那条。 */
@Composable
private fun LiveRow(model: ChatModel, detail: Boolean) {
    Column(modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)) {
        // 流式中的工作过程：与落库后**同一条折叠卡**，只是标题是「工作中」
        if (model.liveThink.isNotBlank() || model.liveTools.isNotEmpty()) {
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

/**
 * 列表顶部那一行「正在读取更早的消息… N 秒」。
 *
 * <p>秒数是**刻意**露出来的：一次翻页要宿主现场读整个会话日志再往前扫，大会话上几十秒
 * 起步 —— 没有这个数，用户只会觉得"卡死了"（0.14.1 之前就是这个体感）。也正因为慢，
 * 读取超时从 30 秒放宽到了 90 秒（见 Session.PAGE_TIMEOUT_MS）。
 */
@Composable
private fun OlderLoadingRow() {
    var secs by remember { mutableStateOf(0) }
    LaunchedEffect(Unit) {
        while (true) {
            delay(1000)
            secs++
        }
    }
    DimLine(stringResource(R.string.chat_loading_older, secs))
}

/**
 * 翻页失败那一行：**可以点**，点了重试。
 *
 * <p>失败之后自动那条路就被闩住了（见 [ChatModel.olderError]）—— 一次请求要宿主读一遍
 * 整个会话日志，滑一下自动发一次等于拿重活反复捶它。所以这里必须有个出口，
 * 而且要把"等了多久"写出来：30 秒整基本就是超时，几秒就是连接断了。
 */
@Composable
private fun OlderFailedRow(text: String, onRetry: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onRetry)
            .padding(horizontal = 24.dp, vertical = 12.dp),
        horizontalArrangement = Arrangement.Center,
    ) {
        Text(
            stringResource(R.string.chat_older_retry, text),
            fontSize = 12.5.sp,
            lineHeight = 18.sp,
            color = Dsh.ListDim,
            fontFamily = LocalDshFonts.current.ui,
            textAlign = TextAlign.Center,
        )
    }
}
