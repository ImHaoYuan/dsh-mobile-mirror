package dev.dsh.mirror.client.ui

import android.content.Context
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
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
 * 通用底部弹层：白底、无拖柄、标题 + 内容。
 *
 * <p>「新建会话」与「⋯」两个面板共用它 —— 两处的容器一模一样，没必要写两遍。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DshSheet(title: String, onDismiss: () -> Unit, content: @Composable ColumnScope.() -> Unit) {
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        containerColor = Dsh.BgPage,
        dragHandle = null,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(start = 20.dp, end = 20.dp, top = 20.dp, bottom = 28.dp),
        ) {
            Text(
                title,
                fontSize = 16.sp,
                fontWeight = FontWeight.SemiBold,
                color = Dsh.ListFg,
            )
            Spacer(Modifier.height(12.dp))
            content()
        }
    }
}

/** 面板里的一行小字说明。 */
@Composable
fun SheetNote(text: String) {
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
private fun SheetOption(label: String, desc: String, enabled: Boolean = true, onClick: () -> Unit) {
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

/**
 * 新建会话。
 *
 * <p>刻意**不做模式选择器**（与网页端一致）：新建出来的会话是 blank 的，进去以后头部那枚
 * 模式芯片本来就能点，没必要在建的时候先问一遍。
 *
 * <p>文件夹清单拉不到也**不影响新建** —— 下面永远有手输绝对路径那一行。
 */
@Composable
fun NewSessionSheet(
    app: Context,
    onDismiss: () -> Unit,
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

    DshSheet(tTitle, onDismiss) {
        val rows = workspaces
        when {
            rows == null -> SheetNote(tPick)
            rows.isEmpty() -> SheetNote(tNone)
            else -> {
                SheetNote(tPick)
                for (w in rows) {
                    SheetOption(
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
        Box(Modifier.fillMaxWidth().height(1.dp).background(Dsh.ListLine))
        Spacer(Modifier.height(14.dp))
        SheetNote(tOther)
        DshField(
            value = path,
            onValueChange = { path = it },
            label = tHint,
            enabled = !busy,
            monospace = true,
        )
        Spacer(Modifier.height(8.dp))
        if (busy) SheetNote(tCreating)
        DshError(error, center = false)
        DshPrimaryButton(tCreate, enabled = !busy) {
            val v = path.trim()
            if (v.isEmpty()) error = tNeedPath else submit(null, v)
        }
    }
}

/** 顶栏「⋯」：目前只有一项（重新配对）。 */
@Composable
fun MoreSheet(onDismiss: () -> Unit, onRepair: () -> Unit) {
    val tTitle = stringResource(R.string.more_title)
    val tRepair = stringResource(R.string.action_repair)
    val tRepairNote = stringResource(R.string.more_repair_note)

    DshSheet(tTitle, onDismiss) {
        SheetNote(tRepairNote)
        DshSecondaryButton(tRepair) { onRepair() }
    }
}
