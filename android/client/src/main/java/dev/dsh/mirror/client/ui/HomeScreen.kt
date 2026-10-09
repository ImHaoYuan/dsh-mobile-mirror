package dev.dsh.mirror.client.ui

import android.content.Context
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
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
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.dsh.mirror.client.R
import dev.dsh.mirror.client.net.Sessions
import dev.dsh.mirror.client.net.Workspace
import dev.dsh.mirror.client.prefs.Composer
import dev.dsh.mirror.client.theme.Dsh
import dev.dsh.mirror.client.theme.LocalDshFonts

/**
 * 首页：DeepSeek 安卓客户端那种形态（方案 §4.4）。
 *
 * <p>版式照截图实测值来：logo 居中在**屏幕高度 y≈44%**、底部输入区在 **y≈88–97%**。
 * 44% 不是靠固定 padding 硬凑的，而是用上下两个 weight（0.44 / 0.56）分配剩余空间 ——
 * 这样换任何屏幕比例，logo 的视觉重心都还在那个位置。
 *
 * <p>顶栏只有左上角一个抽屉键：DeepSeek 首页就是这样，没有标题。
 * 标题、刷新、更多都搬进抽屉头部了。
 *
 * <p><b>0.6：底部那条从「按钮」变成真输入框</b>。点一下聚焦、出键盘；键盘靠清单里的
 * {@code adjustResize} 把窗口缩短，输入框自然贴在键盘上方，logo 被顶上去。输入框**下面**
 * 一行是文件夹：左边显示当前文件夹、右边「选择新的文件夹」手输绝对路径 —— 两个都在首页就地展开。
 * 展开时 logo 缩到 56dp 压到顶部给它腾地方，清单最多半个窗口高。
 *
 * <p>0.6.1 修的两件事：① logo 缩不缩**只看选择器是否展开**，不再看输入框焦点 ——
 * 点文件夹按钮时输入框的焦点不一定被清掉，把焦点算进来会让选完文件夹后 logo 回不到中心；
 * 打开选择器时主动 {@code clearFocus()} 收键盘。② 清单高度从 132dp 改成「半个窗口」。
 *
 * <p><b>0.6 的边界（用户选定）</b>：发送键**不真发**，只提示会话页在 M3。
 * 输入框内容与文件夹选择先按 M3 的形状做好，等聊天页接上再打开开关。
 */
@Composable
fun HomeScreen(
    app: Context,
    onOpenDrawer: () -> Unit,
    /** 真发：建会话 → 进会话页 → 把这句话发出去（都在 MainActivity 里串）。 */
    onSend: (text: String, workspaceId: String?, cwd: String?) -> Unit,
) {
    val composer = remember { Composer(app) }
    val focus = LocalFocusManager.current
    // 「半个屏幕」按**当前窗口**算，不按物理屏幕：键盘收起后窗口就是整屏，而万一键盘还在，
    // 按物理屏幕算会算出比可见区域还高的清单，直接顶出屏幕
    val halfScreen = LocalConfiguration.current.screenHeightDp.dp * 0.5f
    var text by remember { mutableStateOf("") }
    var pick by remember { mutableStateOf(FolderPick.None) }
    var workspaces by remember { mutableStateOf<List<Workspace>?>(null) }
    var chosen by remember {
        mutableStateOf(composer.location()?.let { ChosenFolder(it.workspaceId, it.cwd, "") })
    }
    var manual by remember { mutableStateOf("") }
    var pathError by remember { mutableStateOf("") }

    val hint = stringResource(R.string.home_input_hint)
    val tPickFolder = stringResource(R.string.home_folder_pick)
    val tNewFolder = stringResource(R.string.home_folder_new)
    val tUse = stringResource(R.string.home_folder_use)
    val tBadPath = stringResource(R.string.home_path_bad)

    LaunchedEffect(Unit) { workspaces = Sessions.workspaces(app) }

    // 宿主 validateSessionCreate 要求 cwd 与 workspaceId 至少给一个，两个都不给直接 400。
    // 所以这里必须有默认值：没记过就用清单里最新的那个工作区。
    LaunchedEffect(workspaces) {
        val rows = workspaces ?: return@LaunchedEffect
        val cur = chosen
        if (cur == null) {
            rows.firstOrNull()?.let { w ->
                chosen = ChosenFolder(w.id.ifEmpty { null }, w.path, labelOf(w))
            }
        }
    }

    val folderLabel = chosen?.let { labelFor(it, workspaces) }?.takeIf { it.isNotEmpty() } ?: tPickFolder
    // logo 缩到顶部**只看选择器是否展开**（要给它腾地方）。
    // 输入框聚焦时不额外缩 —— 键盘一弹窗口自己会缩短，logo 会被顶上去，这已经够了；
    // 而且把「焦点」算进来会卡住：点文件夹按钮时输入框的焦点不一定被清掉，选完文件夹 logo 就回不到中心了。
    val compact = pick != FolderPick.None

    // logo 的位置与大小**都走动画** —— 不然点文件夹时它是「跳」过去的。
    // 位置由上下两个 weight 的比值决定（0.44/0.56 → 0.06/0.94），权重本身可以动画，
    // 于是「移动」和「缩放」是同一段过渡的两个分量，不会各走各的。
    val topWeight by animateFloatAsState(
        targetValue = if (compact) 0.06f else 0.44f,
        animationSpec = tween(MOVE_MS, easing = FastOutSlowInEasing),
        label = "logoTopWeight",
    )
    val bottomWeight by animateFloatAsState(
        targetValue = if (compact) 0.94f else 0.56f,
        animationSpec = tween(MOVE_MS, easing = FastOutSlowInEasing),
        label = "logoBottomWeight",
    )
    val logoSize by animateDpAsState(
        targetValue = if (compact) 56.dp else 88.dp,
        animationSpec = tween(MOVE_MS, easing = FastOutSlowInEasing),
        label = "logoSize",
    )
    val tMenu = stringResource(R.string.cd_menu)

    Column(modifier = Modifier.fillMaxSize().background(Dsh.BgPage)) {
        Box(modifier = Modifier.padding(start = 6.dp, top = 6.dp)) {
            DshIconButton(R.drawable.ic_menu, onOpenDrawer, tMenu)
        }

        Spacer(Modifier.weight(topWeight))
        Box(modifier = Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
            DshAppMark(size = logoSize)
        }
        Spacer(Modifier.weight(bottomWeight))

        HomeComposer(
            value = text,
            onValueChange = { text = it },
            // 点回输入框就收起选择器：键盘与半屏清单同时出现会撑出屏幕
            onFocusChanged = { if (it) pick = FolderPick.None },
            hint = hint,
            canSend = text.isNotBlank(),
            // 0.8 起真发：建会话 → 进会话页 → 发首句。
            // 这里**立刻清空输入框** —— 这句话已经乐观上屏到会话页了，留在首页反而像没发出去；
            // 建会话失败会 toast，用户重打一遍即可（比"看起来发出去了其实没有"好）。
            onSend = {
                val t = text.trim()
                if (t.isNotEmpty()) {
                    onSend(t, chosen?.workspaceId, chosen?.cwd)
                    text = ""
                }
            },
        )

        FolderRow(
            label = folderLabel,
            tNew = tNewFolder,
            onPick = {
                // 清焦点 = 收键盘：半屏清单需要地方，而且这样 logo 才能回中心
                focus.clearFocus()
                pick = if (pick == FolderPick.List) FolderPick.None else FolderPick.List
            },
            onNewPath = {
                focus.clearFocus()
                pick = if (pick == FolderPick.Path) FolderPick.None else FolderPick.Path
            },
        )

        // 收起动画期间 pick 已经是 None，所以单独留一份「最后展开的是哪个」给内容用，
        // 否则内容会先变空、动画只剩一片空白在缩。
        var lastPick by remember { mutableStateOf(FolderPick.List) }
        LaunchedEffect(pick) {
            if (pick != FolderPick.None) lastPick = pick
        }
        AnimatedVisibility(
            visible = pick != FolderPick.None,
            enter = expandVertically(tween(MOVE_MS)) + fadeIn(tween(MOVE_MS)),
            exit = shrinkVertically(tween(MOVE_MS)) + fadeOut(tween(MOVE_MS)),
        ) {
            when (lastPick) {
                FolderPick.Path -> PathPicker(
                    value = manual,
                    onValueChange = { manual = it; pathError = "" },
                    error = pathError,
                    tUse = tUse,
                ) {
                    val v = manual.trim()
                    if (!looksAbsolute(v)) {
                        pathError = tBadPath
                    } else {
                        chosen = ChosenFolder(null, v, Sessions.shortPath(v).ifEmpty { v })
                        composer.remember(null, v)
                        focus.clearFocus()
                        pick = FolderPick.None
                    }
                }
                else -> FolderPicker(rows = workspaces, maxHeight = halfScreen) { w ->
                    val id = w.id.ifEmpty { null }
                    chosen = ChosenFolder(id, w.path, labelOf(w))
                    composer.remember(id, w.path)
                    focus.clearFocus()
                    pick = FolderPick.None
                }
            }
        }
    }
}

/** 首页 logo 移动 / 选择器展开共用的动画时长。 */
private const val MOVE_MS = 220

/** 首页下面那一行文件夹选择器的展开状态。 */
private enum class FolderPick { None, List, Path }

/** 首页当前选中的文件夹。{@code label} 为空表示「从设置里恢复出来的，还没跟清单对上」。 */
private data class ChosenFolder(val workspaceId: String?, val cwd: String?, val label: String)

private fun labelOf(w: Workspace): String =
    w.name.ifEmpty { Sessions.shortPath(w.path) }.ifEmpty { w.path }

private fun labelFor(c: ChosenFolder, rows: List<Workspace>?): String {
    if (c.label.isNotEmpty()) return c.label
    val w = rows?.firstOrNull { c.workspaceId != null && it.id == c.workspaceId }
    if (w != null) return labelOf(w)
    val path = c.cwd.orEmpty()
    return Sessions.shortPath(path).ifEmpty { path }
}

/**
 * 绝对路径的本地预检。
 *
 * <p>宿主端 {@code isAbsolutePath} 才是权威，但 0.6 不真发请求，本地先拦一道，
 * 免得用户填个相对路径还以为选好了。Windows 盘符与 Unix 斜杠都认。
 */
private fun looksAbsolute(path: String): Boolean =
    path.startsWith("/") || Regex("^[A-Za-z]:[\\\\/]").containsMatchIn(path)

/**
 * 底部输入框。
 *
 * <p>0.6 之前它是一条**按钮**（点了开新建会话面板）；现在是真的 {@link BasicTextField}。
 * 正文用**正文档**字体（JBM + 思源黑体）—— 打进去的字就是会话内容，理应用会话内容的字体，
 * 顺带也让「正文档」在 M3 之前就有个能看见的地方。
 */
@Composable
private fun HomeComposer(
    value: String,
    onValueChange: (String) -> Unit,
    onFocusChanged: (Boolean) -> Unit,
    hint: String,
    canSend: Boolean,
    onSend: () -> Unit,
) {
    val shape = RoundedCornerShape(24.dp)
    val body = LocalDshFonts.current.body
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(start = 16.dp, end = 16.dp)
            .height(52.dp)
            .clip(shape)
            .background(Dsh.Field)
            .padding(start = 18.dp, end = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(modifier = Modifier.weight(1f)) {
            if (value.isEmpty()) {
                Text(
                    hint,
                    fontSize = 15.sp,
                    color = Dsh.Placeholder,
                    fontFamily = body,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            BasicTextField(
                value = value,
                onValueChange = onValueChange,
                modifier = Modifier.fillMaxWidth().onFocusChanged { onFocusChanged(it.isFocused) },
                textStyle = TextStyle(fontSize = 15.sp, color = Dsh.ListFg, fontFamily = body),
                cursorBrush = SolidColor(Dsh.Brand),
                singleLine = true,
            )
        }
        Box(
            modifier = Modifier
                .size(34.dp)
                .clip(CircleShape)
                .background(if (canSend) Dsh.Brand else Dsh.BgOverlay)
                .clickable(enabled = canSend, onClick = onSend),
            contentAlignment = Alignment.Center,
        ) {
            Text("↑", fontSize = 16.sp, color = if (canSend) Color.White else Dsh.Placeholder)
        }
    }
}

/** 输入框下面那行：当前文件夹 + 选择新的文件夹。 */
@Composable
private fun FolderRow(label: String, tNew: String, onPick: () -> Unit, onNewPath: () -> Unit) {
    val pill = RoundedCornerShape(999.dp)
    Row(
        modifier = Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Row(
            modifier = Modifier
                .weight(1f)
                .clip(pill)
                .background(Dsh.Chip)
                .clickable(onClick = onPick)
                .padding(horizontal = 12.dp, vertical = 7.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(stringResource(R.string.home_folder_label), fontSize = 12.5f.sp, color = Dsh.ListDim3)
            Spacer(Modifier.width(6.dp))
            Text(
                label,
                modifier = Modifier.weight(1f),
                fontSize = 12.5f.sp,
                color = Dsh.ListDim,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Spacer(Modifier.width(8.dp))
        Text(
            tNew,
            modifier = Modifier
                .clip(pill)
                .clickable(onClick = onNewPath)
                .padding(horizontal = 10.dp, vertical = 7.dp),
            fontSize = 12.5f.sp,
            color = Dsh.Brand,
            maxLines = 1,
        )
    }
}

/**
 * 展开的工作区清单。
 *
 * <p>高度**跟着内容长、最多半个窗口**（用户要求「半个屏幕的高度」）：工作区少的时候不留一大片空白，
 * 多的时候也不会把输入框挤出屏幕。超过就自己滚动。
 */
@Composable
private fun FolderPicker(rows: List<Workspace>?, maxHeight: Dp, onChoose: (Workspace) -> Unit) {
    val tPick = stringResource(R.string.new_pick)
    val tNone = stringResource(R.string.new_none)
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp)
            .heightIn(max = maxHeight)
            .verticalScroll(rememberScrollState()),
    ) {
        when {
            rows == null -> PanelNote(tPick)
            rows.isEmpty() -> PanelNote(tNone)
            else -> for (w in rows) {
                PanelOption(label = labelOf(w), desc = Sessions.shortPath(w.path)) { onChoose(w) }
            }
        }
    }
}

/** 展开的手输路径。 */
@Composable
private fun PathPicker(
    value: String,
    onValueChange: (String) -> Unit,
    error: String,
    tUse: String,
    onUse: () -> Unit,
) {
    Column(modifier = Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, bottom = 16.dp)) {
        DshField(
            value = value,
            onValueChange = onValueChange,
            label = stringResource(R.string.new_path_hint),
            monospace = true,
        )
        Spacer(Modifier.height(8.dp))
        DshError(error, center = false)
        DshSecondaryButton(tUse, onClick = onUse)
    }
}
