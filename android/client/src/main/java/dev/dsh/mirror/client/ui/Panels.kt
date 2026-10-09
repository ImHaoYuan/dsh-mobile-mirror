package dev.dsh.mirror.client.ui

import android.content.Context
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
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
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.dsh.mirror.client.R
import dev.dsh.mirror.client.net.CreateResult
import dev.dsh.mirror.client.net.Sessions
import dev.dsh.mirror.client.net.Workspace
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
            Text(title, fontSize = 19.sp, fontWeight = FontWeight.SemiBold, color = Dsh.ListFg)
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
        Text(label, fontSize = 14.5f.sp, fontWeight = FontWeight.SemiBold, color = Dsh.ListFg)
        if (desc.isNotEmpty()) {
            Text(desc, fontSize = 12.5f.sp, lineHeight = 20.sp, color = Dsh.ListDim)
        }
    }
}

/** 顶栏「⋯」：字体 / 开源许可 / 重新配对。 */
@Composable
fun MorePanel(
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

    DrawerPanel(tTitle, onBack) {
        DshSecondaryButton(tFonts) { onFonts() }
        Spacer(Modifier.height(8.dp))
        DshSecondaryButton(tLicenses) { onLicenses() }
        Spacer(Modifier.height(14.dp))
        PanelNote(tRepairNote)
        DshSecondaryButton(tRepair) { onRepair() }
    }
}

/**
 * 新建会话。
 *
 * <p>刻意**不做模式选择器**（与网页端一致）：新建出来的会话是 blank 的，进去以后头部那枚
 * 模式芯片本来就能点，没必要在建的时候先问一遍。
 *
 * <p>文件夹清单拉不到也**不影响新建** —— 下面永远有手输绝对路径那一行。
 */
@Composable
fun NewSessionPanel(
    app: Context,
    onBack: () -> Unit,
    onCreated: (String) -> Unit,
    onExpired: () -> Unit,
) {
    var workspaces by remember { mutableStateOf<List<Workspace>?>(null) }
    var path by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf("") }
    val scope = rememberCoroutineScope()

    val tTitle = stringResource(R.string.new_title)
    val tPick = stringResource(R.string.new_pick)
    val tNone = stringResource(R.string.new_none)
    val tOther = stringResource(R.string.new_other)
    val tHint = stringResource(R.string.new_path_hint)
    val tCreate = stringResource(R.string.new_create)
    val tNeedPath = stringResource(R.string.new_need_path)
    val tCreating = stringResource(R.string.new_creating)
    val tUnreachable = stringResource(R.string.login_err_unreachable)

    LaunchedEffect(Unit) { workspaces = Sessions.workspaces(app) }

    fun submit(workspaceId: String?, cwd: String?) {
        if (busy) return
        busy = true
        error = ""
        scope.launch {
            when (val r = Sessions.create(app, workspaceId, cwd)) {
                is CreateResult.Ok -> onCreated(r.sessionId)
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
