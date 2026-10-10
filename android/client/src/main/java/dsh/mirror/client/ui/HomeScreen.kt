package dsh.mirror.client.ui

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
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
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
import androidx.compose.ui.focus.focusProperties
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
import dsh.mirror.client.R
import dsh.mirror.client.net.ModelPick
import dsh.mirror.client.net.Sessions
import dsh.mirror.client.net.Workspace
import dsh.mirror.client.prefs.Composer
import dsh.mirror.client.theme.Dsh
import dsh.mirror.client.theme.LocalDshFonts

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
 * {@code adjustResize} 把窗口缩短，输入框自然贴在键盘上方，logo 被顶上去。面板展开时 logo
 * 缩到 56dp 压到顶部给它腾地方，面板最多半个窗口高。
 *
 * <p><b>0.12.3 起底部是两段：胶囊行 → 输入框</b>。三颗胶囊（模型 / 模式 / 文件夹）**并排一行**、
 * 各占一份（{@code weight(1f, fill = false)}，字短按内容宽、字长截断加省略号），样式统一成
 * 文件夹那颗的全圆胶囊。点开谁，谁的面板就**就地**长在胶囊行与输入框之间（没有遮罩、页面
 * 还是亮的、最多半个窗口），再点一下收起。「选择新的文件夹」那行独立的蓝字 0.12.2 已并进清单末尾。
 *
 * <p>0.6.1 修的两件事：① logo 缩不缩**只看面板是否展开**，不再看输入框焦点 ——
 * 点文件夹按钮时输入框的焦点不一定被清掉，把焦点算进来会让选完文件夹后 logo 回不到中心；
 * 打开面板时主动 {@code clearFocus()} 收键盘。② 清单高度从 132dp 改成「半个窗口」。
 *
 * <p><b>0.6 的边界（用户选定）</b>：发送键**不真发**，只提示会话页在 M3。
 * 输入框内容与文件夹选择先按 M3 的形状做好，等聊天页接上再打开开关。
 */
@Composable
fun HomeScreen(
    app: Context,
    onOpenDrawer: () -> Unit,
    /**
     * 首页输入框**能不能拿焦点**（0.15.1）。
     *
     * <p>首页与抽屉永远留在组合里（会话页只是盖在上面的覆盖物），所以被盖住时它的输入框
     * 还活着、还能持有焦点 —— 用户点会话页输入框、字却进了首页那一个，就是这么来的。
     * 这里连同 {@code clearFocus()} 一起做成两道保险：盖住时连"能拿焦点"都关掉。
     */
    focusEnabled: Boolean,
    /** 模型目录缓存（0.12，进程内一份，三个入口共用）。 */
    hub: ModelHub,
    /** 建会话前先记着的模型 / 模式：状态在 MainActivity —— 首页与抽屉里的「新建会话」共用同一份。 */
    pickModel: ModelPick,
    presetId: String,
    /** 选模型 / 换模式：会话还没建，只是记下来（没有网络请求），返回 null = 成功。 */
    onPickModel: suspend (ModelPick) -> PickReply?,
    onPreset: suspend (String) -> PickReply?,
    /**
     * 真发：建会话 → 进会话页 → 把这句话发出去（都在 MainActivity 里串）。
     *
     * <p>`preset` / `pick` 是 0.12 加的：**建会话时就要带过去** —— 首句一发出去模式就锁死了
     * （宿主 `agent-preset/locked`），之后再改只能新建会话。
     */
    onSend: (text: String, workspaceId: String?, cwd: String?, preset: String?, pick: ModelPick) -> Unit,
) {
    val composer = remember { Composer(app) }
    val focus = LocalFocusManager.current
    // 「半个屏幕」按**当前窗口**算，不按物理屏幕：键盘收起后窗口就是整屏，而万一键盘还在，
    // 按物理屏幕算会算出比可见区域还高的清单，直接顶出屏幕
    val halfScreen = LocalConfiguration.current.screenHeightDp.dp * 0.5f
    var text by remember { mutableStateOf("") }
    var panel by remember { mutableStateOf(ChipPanel.None) }
    var workspaces by remember { mutableStateOf<List<Workspace>?>(null) }
    var chosen by remember {
        mutableStateOf(composer.location()?.let { ChosenFolder(it.workspaceId, it.cwd, "") })
    }
    var manual by remember { mutableStateOf("") }
    var pathError by remember { mutableStateOf("") }

    val hint = stringResource(R.string.home_input_hint)
    val tPickFolder = stringResource(R.string.home_folder_pick)
    /** 文件夹胶囊的前缀小字（0.12.3：它跟模型 / 模式并排，得说清自己是什么）。 */
    val tFolderPrefix = stringResource(R.string.home_folder_label)
    val tUse = stringResource(R.string.home_folder_use)
    val tBadPath = stringResource(R.string.home_path_bad)
    val tCapsule = stringResource(R.string.model_capsule)
    val tPresetDefault = stringResource(R.string.model_preset_default)
    /** 模式 id → 中文名（清单还没拉到时退回 id 本身）。 */
    val presetLabels = hub.presets.associate { it.id to it.label }

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
    val compact = panel != ChipPanel.None

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

        // 胶囊行（0.12.2 起在**输入框上方**；0.12.3 起三颗并排：模型 / 模式 / 文件夹）。
        // 三颗**各占一份**（weight(1f, fill = false)）：字短就按内容宽，字长就截到自己的那份并省略号，
        // 谁也不会把谁挤出去。圆角与字号统一到文件夹那一套，并排才不会显得没对齐。
        // 间距：输入框是个 52dp 的盒子、上下都没有内距，所以这一行的 bottom 就是它与下面那块的间隔；
        // 面板自己底部的 10dp（PanelBody 里）是它与输入框的间隔 —— 两段相等。
        // （胶囊上方是弹性的 weight 区域，不给固定上距：那不是「两个组件之间」。）
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(start = 16.dp, end = 16.dp, bottom = 10.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            ModelCapsule(
                modifier = Modifier.weight(1f, fill = false),
                text = ModelLogic.capsuleText(hub.catalog, pickModel, tCapsule),
                open = panel == ChipPanel.Model,
                onClick = {
                    // 收键盘：面板要地方，而且这样 logo 才能回中心
                    focus.clearFocus()
                    panel = if (panel == ChipPanel.Model) ChipPanel.None else ChipPanel.Model
                },
            )
            ModelCapsule(
                modifier = Modifier.weight(1f, fill = false),
                text = ModelLogic.presetText(presetLabels, presetId, tPresetDefault),
                open = panel == ChipPanel.Preset,
                onClick = {
                    focus.clearFocus()
                    panel = if (panel == ChipPanel.Preset) ChipPanel.None else ChipPanel.Preset
                },
            )
            ModelCapsule(
                modifier = Modifier.weight(1f, fill = false),
                prefix = tFolderPrefix,
                text = folderLabel,
                open = panel == ChipPanel.Folder || panel == ChipPanel.Path,
                onClick = {
                    // 清焦点 = 收键盘：半屏清单需要地方，而且这样 logo 才能回中心
                    focus.clearFocus()
                    panel = if (panel == ChipPanel.Folder) ChipPanel.None else ChipPanel.Folder
                },
            )
        }

        // 面板槽（0.12.3）：三颗胶囊共用这一个位置 —— 谁被点开谁就长在这里，
        // 而且**就长在胶囊行与输入框之间**（会话页、抽屉里的「新建会话」也是同一套）。
        // 收起动画期间 panel 已经是 None，所以单独留一份「最后展开的是哪个」给内容用，
        // 否则内容会先变空、动画只剩一片空白在缩。
        var lastPanel by remember { mutableStateOf(ChipPanel.Folder) }
        LaunchedEffect(panel) {
            if (panel != ChipPanel.None) lastPanel = panel
        }
        AnimatedVisibility(
            visible = panel != ChipPanel.None,
            enter = expandVertically(tween(MOVE_MS)) + fadeIn(tween(MOVE_MS)),
            exit = shrinkVertically(tween(MOVE_MS)) + fadeOut(tween(MOVE_MS)),
        ) {
            when (lastPanel) {
                ChipPanel.Model -> ModelPanel(
                    hub = hub,
                    pick = pickModel,
                    maxHeight = halfScreen,
                    onPick = onPickModel,
                )
                ChipPanel.Preset -> PresetPanel(
                    hub = hub,
                    presetId = presetId,
                    // 会话都还没建，谈不上锁
                    presetLocked = false,
                    maxHeight = halfScreen,
                    onPreset = onPreset,
                    onDismiss = { panel = ChipPanel.None },
                )
                ChipPanel.Path -> PathPicker(
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
                        panel = ChipPanel.None
                    }
                }
                else -> FolderPicker(
                    rows = workspaces,
                    maxHeight = halfScreen,
                    onChoose = { w ->
                        val id = w.id.ifEmpty { null }
                        chosen = ChosenFolder(id, w.path, labelOf(w))
                        composer.remember(id, w.path)
                        focus.clearFocus()
                        panel = ChipPanel.None
                    },
                    // 「其他路径…」原来是输入框右边一行独立的蓝字，0.12.2 合并到清单末尾
                    onManual = {
                        pathError = ""
                        panel = ChipPanel.Path
                    },
                )
            }
        }

        HomeComposer(
            value = text,
            onValueChange = { text = it },
            // 点回输入框就收起选择器：键盘与半屏清单同时出现会撑出屏幕
            onFocusChanged = { if (it) panel = ChipPanel.None },
            focusEnabled = focusEnabled,
            hint = hint,
            canSend = text.isNotBlank(),
            // 0.8 起真发：建会话 → 进会话页 → 发首句。
            // 这里**立刻清空输入框** —— 这句话已经乐观上屏到会话页了，留在首页反而像没发出去；
            // 建会话失败会 toast，用户重打一遍即可（比"看起来发出去了其实没有"好）。
            onSend = {
                val t = text.trim()
                if (t.isNotEmpty()) {
                    onSend(t, chosen?.workspaceId, chosen?.cwd, presetId, pickModel)
                    text = ""
                }
            },
        )
    }
}

/** 首页 logo 移动 / 选择器展开共用的动画时长。 */
private const val MOVE_MS = 220

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
    /** 被覆盖层盖住时置 false：避免"看不见的输入框"继续接字（0.15.1）。 */
    focusEnabled: Boolean,
    hint: String,
    canSend: Boolean,
    onSend: () -> Unit,
) {
    val shape = RoundedCornerShape(24.dp)
    val body = LocalDshFonts.current.body
    Row(
        modifier = Modifier
            .fillMaxWidth()
            // bottom = 12dp：输入框现在是**最下面那一个**，屏幕底边的留白归它（原来在文件夹行上）
            .padding(start = 16.dp, end = 16.dp, bottom = 12.dp)
            // 1.0：原来是 .height(52.dp) 的**死高度** —— 盒子永远只有一行，字一长就只能横向滚
            //（用户看到的"字紧跟字后面，不换行也不扩容"）。改成与聊天页输入框同一套：
            // 最低 52dp、最多 5 行、长到 120dp 封顶后框内自己滚。
            .heightIn(min = 52.dp)
            .clip(shape)
            .background(Dsh.Field)
            .padding(start = 18.dp, end = 8.dp, top = 8.dp, bottom = 8.dp),
        // Bottom：框长高时按钮留在下沿（与聊天页的发送键一致），而不是整行一起垂直居中
        verticalAlignment = Alignment.Bottom,
    ) {
        Box(modifier = Modifier.weight(1f).padding(bottom = 6.dp)) {
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
                modifier = Modifier
                    .fillMaxWidth()
                    // 名字不能叫 canFocus：lambda 里那个 canFocus 是 FocusProperties 的属性，
                    // 同名会变成自己赋给自己
                    .focusProperties { canFocus = focusEnabled }
                    .onFocusChanged { onFocusChanged(it.isFocused) },
                // lineHeight 显式给：多行时默认行高偏挤（与聊天页同款 22sp）
                textStyle = TextStyle(fontSize = 15.sp, lineHeight = 22.sp, color = Dsh.ListFg, fontFamily = body),
                cursorBrush = SolidColor(Dsh.Brand),
                maxLines = 5,
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

/**
 * 展开的工作区清单。
 *
 * <p>高度**跟着内容长、最多半个窗口**（用户要求「半个屏幕的高度」）：工作区少的时候不留一大片空白，
 * 多的时候也不会把输入框挤出屏幕。超过就自己滚动。
 */
@Composable
private fun FolderPicker(
    rows: List<Workspace>?,
    maxHeight: Dp,
    onChoose: (Workspace) -> Unit,
    /** 清单末尾的「其他路径…」：手输一个绝对路径（0.12.2 从输入框右边搬进来）。 */
    onManual: () -> Unit,
) {
    val tPick = stringResource(R.string.new_pick)
    val tNone = stringResource(R.string.new_none)
    val tOther = stringResource(R.string.new_other)
    // 外壳与模型 / 模式面板共用（0.12.3）：左右 16dp、最高半个窗口、超了自己滚、底部 10dp
    PanelBody(maxHeight) {
        when {
            rows == null -> PanelNote(tPick)
            rows.isEmpty() -> PanelNote(tNone)
            else -> for (w in rows) {
                PanelOption(label = labelOf(w), desc = Sessions.shortPath(w.path)) { onChoose(w) }
            }
        }
        // 这一行**不受上面 when 影响**：清单拉不到 / 一个工作区都没有时它照样在 ——
        // 「清单挂了也能新建」这条老性质（原来靠输入框右边那个独立入口保着）不能丢
        PanelOption(label = tOther, desc = "") { onManual() }
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
    Column(modifier = Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, bottom = 10.dp)) {
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
