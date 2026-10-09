package dev.dsh.mirror.client.ui

import android.content.Context
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.dsh.mirror.client.R
import dev.dsh.mirror.client.net.CreateResult
import dev.dsh.mirror.client.net.ModelPick
import dev.dsh.mirror.client.net.Models
import dev.dsh.mirror.client.net.Sessions
import dev.dsh.mirror.client.net.Workspace
import dev.dsh.mirror.client.theme.LocalDshFonts
import dev.dsh.mirror.client.theme.Dsh
import kotlinx.coroutines.launch

/**
 * 抽屉里的一级面板：**固定头部 + 可滚动正文**。
 *
 * <p>0.6 之前这些都是底部弹层（{@code ModalBottomSheet}）。改成抽屉页以后，
 * 头部必须留在滚动区外面 —— 弹层有拖柄可以下滑关掉，抽屉页没有，返回键只剩左上角那枚，
 * 跟着正文一起滚上去就等于没了。
 *
 * <p>各面板正文与弹层时期**一字未改**，只换了容器。
 */
@Composable
fun DrawerPanel(title: String, onBack: () -> Unit, content: @Composable ColumnScope.() -> Unit) {
    // 面板是**盖在会话列表上**的（列表常驻，避免每次返回都重拉），所以这里必须把点击吞掉：
    // 不吞的话，面板空白处的点击会穿到下面那些会话行上去。
    val sink = remember { MutableInteractionSource() }
    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(Dsh.BgPage)
            .clickable(interactionSource = sink, indication = null) {},
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(start = 6.dp, end = 20.dp, top = 14.dp, bottom = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            // ← 是 U+2190，JetBrains Mono 里有这个字形，不靠设备系统字体兜底
            DshGlyphButton("←", onBack, fontSize = 20f)
            Text(title, fontSize = 19.sp, fontWeight = FontWeight.SemiBold, fontFamily = LocalDshFonts.current.uiBold, color = Dsh.ListFg)
        }
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(start = 20.dp, end = 20.dp, top = 4.dp, bottom = 28.dp),
            content = content,
        )
    }
}

/** 面板里的一行小字说明。 */
@Composable
fun PanelNote(text: String) {
    Text(
        text,
        modifier = Modifier.fillMaxWidth().padding(bottom = 10.dp),
        fontSize = 12.5f.sp,
        lineHeight = 21.sp,
        color = Dsh.ListDim,
    )
}

/** 面板里的候选条目（网页端 {@code .opt}）：名称 + 尾部路径。 */
@Composable
fun PanelOption(label: String, desc: String, enabled: Boolean = true, onClick: () -> Unit) {
    val shape = RoundedCornerShape(Dsh.RadiusMd)
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(bottom = 8.dp)
            .clip(shape)
            .background(Dsh.Chip)
            .border(1.dp, Dsh.ListLine, shape)
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 10.dp),
    ) {
        Text(label, fontSize = 14.5f.sp, fontWeight = FontWeight.SemiBold, fontFamily = LocalDshFonts.current.uiBold, color = Dsh.ListFg)
        if (desc.isNotEmpty()) {
            Text(desc, fontSize = 12.5f.sp, lineHeight = 20.sp, color = Dsh.ListDim)
        }
    }
}

/**
 * 设置面板（0.9.3 起由「更多」改名而来）。
 *
 * <p>字体设置收在这里；「显示详细工作过程」也在这里 —— 关（默认）时「工作过程」折叠卡
 * 每一步只显示简短解释，打开才显示工具名与完整参数。
 */
@Composable
fun MorePanel(
    detail: Boolean,
    onDetail: (Boolean) -> Unit,
    onBack: () -> Unit,
    onFonts: () -> Unit,
    onLicenses: () -> Unit,
    onRepair: () -> Unit,
) {
    val tTitle = stringResource(R.string.more_title)
    val tFonts = stringResource(R.string.more_fonts)
    val tLicenses = stringResource(R.string.more_licenses)
    val tRepair = stringResource(R.string.action_repair)
    val tRepairNote = stringResource(R.string.more_repair_note)
    val tDetail = stringResource(R.string.settings_detail)
    val tDetailNote = stringResource(R.string.settings_detail_note)

    DrawerPanel(tTitle, onBack) {
        DshSecondaryButton(tFonts) { onFonts() }
        Spacer(Modifier.height(14.dp))
        Row(
            modifier = Modifier.fillMaxWidth().clickable { onDetail(!detail) },
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(tDetail, fontSize = 14.5f.sp, fontWeight = FontWeight.SemiBold, fontFamily = LocalDshFonts.current.uiBold, color = Dsh.ListFg)
                Spacer(Modifier.height(2.dp))
                Text(tDetailNote, fontSize = 12.5f.sp, lineHeight = 20.sp, color = Dsh.ListDim)
            }
            Spacer(Modifier.width(12.dp))
            Switch(checked = detail, onCheckedChange = { onDetail(it) })
        }
        Spacer(Modifier.height(14.dp))
        DshSecondaryButton(tLicenses) { onLicenses() }
        Spacer(Modifier.height(14.dp))
        PanelNote(tRepairNote)
        DshSecondaryButton(tRepair) { onRepair() }
    }
}

/**
 * 新建会话。
 *
 * <p>0.12 起这里也带**模型 / 模式**。原先的「进来再点芯片」不够用了：从首页发首句那条路
 * 建完会话就立刻发消息，**首句一发出去模式就锁死**（宿主 `agent-preset/locked`），
 * 所以必须在建之前选。
 *
 * <p>文件夹清单拉不到也**不影响新建** —— 下面永远有手输绝对路径那一行。
 */
@Composable
fun NewSessionPanel(
    app: Context,
    /** 模型目录缓存（0.12）。 */
    hub: ModelHub,
    /** 建会话前先记着的模型 / 模式：状态在 MainActivity（首页与这里共用同一份）。 */
    pickModel: ModelPick,
    presetId: String,
    /** 选模型 / 换模式：会话还没建，只是记下来（没有网络请求），返回 null = 成功。 */
    onPickModel: suspend (ModelPick) -> PickReply?,
    onPreset: suspend (String) -> PickReply?,
    onBack: () -> Unit,
    /** 建好了：`(sessionId, 用的目录)` —— 宿主直接进这个会话（0.12.1 起不再只 toast）。 */
    onCreated: (String, String?) -> Unit,
    onExpired: () -> Unit,
) {
    var workspaces by remember { mutableStateOf<List<Workspace>?>(null) }
    var path by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf("") }
    val scope = rememberCoroutineScope()
    /** 胶囊行下面开着哪一块面板（0.12.3 起就地展开，见 HomeScreen 同款注释）。 */
    var panel by remember { mutableStateOf(ChipPanel.None) }
    var lastPanel by remember { mutableStateOf(ChipPanel.Model) }
    LaunchedEffect(panel) {
        if (panel != ChipPanel.None) lastPanel = panel
    }
    /** 面板最高「半个窗口」。 */
    val halfScreen = LocalConfiguration.current.screenHeightDp.dp * 0.5f

    val tTitle = stringResource(R.string.new_title)
    val tPick = stringResource(R.string.new_pick)
    val tNone = stringResource(R.string.new_none)
    val tOther = stringResource(R.string.new_other)
    val tHint = stringResource(R.string.new_path_hint)
    val tCreate = stringResource(R.string.new_create)
    val tNeedPath = stringResource(R.string.new_need_path)
    val tCreating = stringResource(R.string.new_creating)
    val tUnreachable = stringResource(R.string.login_err_unreachable)
    val tCapsule = stringResource(R.string.model_capsule)
    val tPresetDefault = stringResource(R.string.model_preset_default)
    /** 模式 id → 中文名（清单还没拉到时退回 id 本身）。 */
    val presetLabels = hub.presets.associate { it.id to it.label }

    LaunchedEffect(Unit) { workspaces = Sessions.workspaces(app) }

    fun submit(workspaceId: String?, cwd: String?) {
        if (busy) return
        busy = true
        error = ""
        scope.launch {
            when (val r = Sessions.create(app, workspaceId, cwd, presetId.ifEmpty { null })) {
                is CreateResult.Ok -> {
                    // 建完立刻定模型：`/api/session` 不吃模型，而建完这里就交给会话页了
                    if (pickModel.model.isNotEmpty()) Models.select(app, r.sessionId, pickModel)
                    onCreated(r.sessionId, cwd)
                }
                is CreateResult.Rejected -> {
                    error = r.message
                    busy = false
                }
                CreateResult.Expired -> {
                    busy = false
                    onExpired()
                }
                CreateResult.Unreachable -> {
                    error = tUnreachable
                    busy = false
                }
            }
        }
    }

    DrawerPanel(tTitle, onBack) {
        // 模型 / 模式（0.12）：见函数头注释 —— 建会话时就要带过去。
        // 0.12.3 起两颗各占一半，点开就地展开的面板（不再是盖住整屏的卡片）。
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
                onClick = { panel = if (panel == ChipPanel.Model) ChipPanel.None else ChipPanel.Model },
            )
            ModelCapsule(
                modifier = Modifier.weight(1f, fill = false),
                text = ModelLogic.presetText(presetLabels, presetId, tPresetDefault),
                open = panel == ChipPanel.Preset,
                onClick = { panel = if (panel == ChipPanel.Preset) ChipPanel.None else ChipPanel.Preset },
            )
        }

        AnimatedVisibility(
            visible = panel != ChipPanel.None,
            enter = expandVertically(tween(PANEL_MS)) + fadeIn(tween(PANEL_MS)),
            exit = shrinkVertically(tween(PANEL_MS)) + fadeOut(tween(PANEL_MS)),
        ) {
            when (lastPanel) {
                ChipPanel.Model -> ModelPanel(
                    hub = hub,
                    pick = pickModel,
                    maxHeight = halfScreen,
                    onPick = onPickModel,
                )
                else -> PresetPanel(
                    hub = hub,
                    presetId = presetId,
                    // 会话都还没建，谈不上锁
                    presetLocked = false,
                    maxHeight = halfScreen,
                    onPreset = onPreset,
                    onDismiss = { panel = ChipPanel.None },
                )
            }
        }

        val rows = workspaces
        when {
            rows == null -> PanelNote(tPick)
            rows.isEmpty() -> PanelNote(tNone)
            else -> {
                PanelNote(tPick)
                for (w in rows) {
                    PanelOption(
                        label = w.name.ifEmpty { w.path },
                        desc = Sessions.shortPath(w.path),
                        enabled = !busy,
                    ) {
                        submit(w.id.ifEmpty { null }, w.path)
                    }
                }
            }
        }

        // —— 手输路径：清单里还没有的文件夹也能开会话 ——
        Spacer(Modifier.height(6.dp))
        PanelNote(tOther)
        DshField(
            value = path,
            onValueChange = { path = it },
            label = tHint,
            enabled = !busy,
            monospace = true,
        )
        Spacer(Modifier.height(8.dp))
        if (busy) PanelNote(tCreating)
        DshError(error, center = false)
        DshPrimaryButton(tCreate, enabled = !busy) {
            val v = path.trim()
            if (v.isEmpty()) error = tNeedPath else submit(null, v)
        }
    }
}
