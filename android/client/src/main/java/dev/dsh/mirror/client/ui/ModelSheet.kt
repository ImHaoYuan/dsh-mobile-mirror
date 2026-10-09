package dev.dsh.mirror.client.ui

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
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
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.dsh.mirror.client.R
import dev.dsh.mirror.client.net.ModelCatalog
import dev.dsh.mirror.client.net.ModelEffort
import dev.dsh.mirror.client.net.ModelInfo
import dev.dsh.mirror.client.net.ModelPick
import dev.dsh.mirror.client.net.PresetRow
import dev.dsh.mirror.client.theme.Dsh
import dev.dsh.mirror.client.theme.LocalDshFonts
import kotlinx.coroutines.launch

/** 卡片里一次切换的回执。`null` 表示成功。 */
class SheetReply(val message: String, val locked: Boolean = false)

/**
 * 输入条上方那颗胶囊（0.12）。显示「模型名 · 档位」，点开选择卡。
 *
 * <p>尺寸照 DSH 桌面端的 `wq12jW_trigger`：高 28dp 上下、圆角 8dp、13px、
 * chevron 展开时转 180°（`transition .12s`）。
 */
@Composable
fun ModelCapsule(text: String, open: Boolean, enabled: Boolean = true, onClick: () -> Unit) {
    val turn by animateFloatAsState(if (open) 180f else 0f, tween(120), label = "chevron")
    Row(
        modifier = Modifier
            .clip(RoundedCornerShape(8.dp))
            .background(Dsh.Chip)
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 10.dp, vertical = 5.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text,
            fontSize = 13.sp,
            color = if (enabled) Dsh.ListDim else Dsh.ListDim3,
            fontFamily = LocalDshFonts.current.ui,
        )
        Spacer(Modifier.width(6.dp))
        Canvas(modifier = Modifier.size(9.dp).rotate(turn)) {
            val p = Path()
            p.moveTo(size.width * 0.1f, size.height * 0.32f)
            p.lineTo(size.width * 0.5f, size.height * 0.7f)
            p.lineTo(size.width * 0.9f, size.height * 0.32f)
            drawPath(
                p,
                Dsh.ListDim3,
                style = Stroke(width = 1.3.dp.toPx(), cap = StrokeCap.Round, join = StrokeJoin.Round),
            )
        }
    }
}

/**
 * 模型 / 模式选择卡（0.12，形态与提问卡一致：遮罩 + 贴底卡片）。
 *
 * <p>选**模型 / 档位**不关卡片 —— 档位只在当前模型下面展开，换完要能立刻看到并接着调；
 * 换**模式**是决定性动作（还决定这个会话挂哪些插件），成功就关。
 *
 * @param presetLocked 会话已经跑过至少一轮 —— DSH 的规则，模式不能再改。
 * @param onPick 选模型；返回 null = 成功。
 * @param onPreset 换模式；返回 null = 成功。
 */
@Composable
fun ModelSheet(
    hub: ModelHub,
    pick: ModelPick,
    presetId: String,
    presetLocked: Boolean,
    onPick: suspend (ModelPick) -> SheetReply?,
    onPreset: suspend (String) -> SheetReply?,
    onDismiss: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf("") }
    var done by remember { mutableStateOf("") }
    var locked by remember(presetLocked) { mutableStateOf(presetLocked) }

    LaunchedEffect(Unit) { hub.ensure() }

    val labels = hub.presets.associate { it.id to it.label }

    fun choose(p: ModelPick, label: String) {
        if (busy) return
        busy = true
        error = ""
        done = ""
        scope.launch {
            val r = onPick(p)
            busy = false
            if (r == null) done = label else error = r.message
        }
    }

    fun choosePreset(id: String, label: String) {
        if (busy) return
        busy = true
        error = ""
        done = ""
        scope.launch {
            val r = onPreset(id)
            busy = false
            // 成功就关卡片 —— 换模式是决定性动作，留在卡片里只会挡住会话页
            if (r == null) {
                onDismiss()
            } else {
                error = r.message
                if (r.locked) locked = true
            }
        }
    }

    Box(modifier = Modifier.fillMaxSize()) {
        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(Color.Black.copy(alpha = 0.32f))
                .clickable(
                    interactionSource = remember { MutableInteractionSource() },
                    indication = null,
                ) { onDismiss() },
        )

        Column(
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .fillMaxWidth()
                .clip(RoundedCornerShape(topStart = 20.dp, topEnd = 20.dp))
                .background(Dsh.BgPage)
                .heightIn(max = 560.dp)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 18.dp, vertical = 16.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    stringResource(R.string.model_title),
                    fontSize = 16.sp,
                    fontWeight = FontWeight.SemiBold,
                    fontFamily = LocalDshFonts.current.uiBold,
                    color = Dsh.ListFg,
                    modifier = Modifier.weight(1f),
                )
                Text(
                    stringResource(R.string.model_close),
                    fontSize = 13.sp,
                    color = Dsh.ListDim,
                    fontFamily = LocalDshFonts.current.ui,
                    modifier = Modifier.clickable(onClick = onDismiss).padding(4.dp),
                )
            }

            // 目录段：`/api/models` 要宿主控制器就绪，刚启动可能是 503 —— 那就给「重试」，
            // 而不是把整张卡清空。
            val cat = hub.catalog
            if (cat == null) {
                Spacer(Modifier.height(14.dp))
                if (hub.loading) {
                    DshHint(stringResource(R.string.model_loading))
                } else {
                    if (hub.error.isNotEmpty()) DshError(hub.error)
                    Spacer(Modifier.height(10.dp))
                    DshPrimaryButton(
                        text = stringResource(R.string.model_retry),
                        onClick = { scope.launch { hub.reload() } },
                    )
                }
            } else {
                Spacer(Modifier.height(12.dp))
                SectionTitle(stringResource(R.string.model_section_model))
                for (g in cat.groups) {
                    Spacer(Modifier.height(6.dp))
                    Text(
                        g.name,
                        fontSize = 12.sp,
                        color = Dsh.ListDim3,
                        fontFamily = LocalDshFonts.current.ui,
                        modifier = Modifier.padding(horizontal = 12.dp, vertical = 4.dp),
                    )
                    for (m in g.models) {
                        val on = pick.provider == g.id && pick.model == m.id
                        ModelRow(
                            model = m,
                            current = on,
                            selectedEffort = if (on) pick.effort else "",
                            busy = busy,
                            onPickModel = {
                                val effort = ModelLogic.effortFor(cat, pick, g.id, m.id)
                                choose(ModelPick(g.id, m.id, effort), m.name)
                            },
                            onPickEffort = { e ->
                                choose(ModelPick(g.id, m.id, e.id), m.name + " · " + e.name)
                            },
                        )
                    }
                }
                if (cat.failures.isNotEmpty()) {
                    Spacer(Modifier.height(10.dp))
                    SectionTitle(stringResource(R.string.model_section_failed))
                    for (f in cat.failures) {
                        Text(
                            f.name + " —— " + f.message,
                            fontSize = 12.5.sp,
                            lineHeight = 18.sp,
                            color = Dsh.ListDim3,
                            fontFamily = LocalDshFonts.current.body,
                            modifier = Modifier.padding(horizontal = 12.dp, vertical = 4.dp),
                        )
                    }
                }

            }

            // 模式段**独立于目录**：`/api/presets` 不需要控制器，所以目录 503 时模式照样能换 ——
            // 一起藏掉就等于「控制器没就绪 = 模式也不让选」，没必要。
            if (hub.presets.isNotEmpty() || locked || cat != null) {
                Spacer(Modifier.height(14.dp))
                SectionTitle(stringResource(R.string.model_section_preset))
                if (locked) {
                    Spacer(Modifier.height(6.dp))
                    DshHint(stringResource(R.string.model_preset_locked))
                }
                if (hub.presets.isEmpty()) {
                    Spacer(Modifier.height(6.dp))
                    DshHint(stringResource(R.string.model_preset_none))
                }
                for (p in hub.presets) {
                    PresetRowView(
                        row = p,
                        current = p.id == presetId,
                        disabled = locked || busy || p.broken.isNotEmpty(),
                    ) { choosePreset(p.id, p.label) }
                }
            }

            if (done.isNotEmpty()) {
                Spacer(Modifier.height(12.dp))
                Text(
                    stringResource(R.string.model_switched, done),
                    fontSize = 12.5.sp,
                    color = Dsh.Ok,
                    fontFamily = LocalDshFonts.current.ui,
                )
            }
            if (error.isNotEmpty()) {
                Spacer(Modifier.height(12.dp))
                DshError(error)
            }
            Spacer(Modifier.height(8.dp))
        }
    }
}

/** 小节标题（「模型」「模式」「不可用」）。 */
@Composable
private fun SectionTitle(text: String) {
    Text(
        text,
        fontSize = 13.sp,
        fontWeight = FontWeight.SemiBold,
        color = Dsh.ListFg,
        fontFamily = LocalDshFonts.current.uiBold,
        modifier = Modifier.padding(horizontal = 12.dp),
    )
}

/** 一个模型条目。档位只在**当前选中的那个**下面展开（每个都铺一排会长到没法用，与网页端同款）。 */
@Composable
private fun ModelRow(
    model: ModelInfo,
    current: Boolean,
    selectedEffort: String,
    busy: Boolean,
    onPickModel: () -> Unit,
    onPickEffort: (ModelEffort) -> Unit,
) {
    Column {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(Dsh.RadiusMd))
                .background(if (current) Dsh.Sel else Color.Transparent)
                .clickable(enabled = !busy, onClick = onPickModel)
                .padding(horizontal = 12.dp, vertical = 10.dp),
            verticalAlignment = Alignment.Top,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    model.name,
                    fontSize = 14.5.sp,
                    lineHeight = 21.sp,
                    color = Dsh.ListFg,
                    fontFamily = LocalDshFonts.current.body,
                )
                if (model.description.isNotEmpty()) {
                    Spacer(Modifier.height(2.dp))
                    Text(
                        model.description,
                        fontSize = 12.5.sp,
                        lineHeight = 18.sp,
                        color = Dsh.ListDim3,
                        fontFamily = LocalDshFonts.current.body,
                    )
                }
            }
            if (current) {
                Spacer(Modifier.width(8.dp))
                CheckMark()
            }
        }
        if (current && model.efforts.isNotEmpty()) {
            Row(
                modifier = Modifier.padding(start = 12.dp, end = 12.dp, bottom = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                for (e in model.efforts) {
                    EffortChip(
                        effort = e,
                        on = e.id == selectedEffort,
                        enabled = !busy,
                    ) { onPickEffort(e) }
                }
            }
        }
    }
}

/** 档位小胶囊。 */
@Composable
private fun EffortChip(effort: ModelEffort, on: Boolean, enabled: Boolean, onClick: () -> Unit) {
    Text(
        effort.name,
        fontSize = 12.5.sp,
        color = if (on) Dsh.AccentFg else Dsh.ListDim,
        fontFamily = LocalDshFonts.current.ui,
        modifier = Modifier
            .clip(RoundedCornerShape(999.dp))
            .background(if (on) Dsh.Sel else Dsh.Chip)
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 10.dp, vertical = 5.dp),
    )
}

/** 一个模式条目。`broken` 非空 = 当前不可用（自带原因，红字）。 */
@Composable
private fun PresetRowView(row: PresetRow, current: Boolean, disabled: Boolean, onClick: () -> Unit) {
    val fg = if (disabled) Dsh.ListDim3 else Dsh.ListFg
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(Dsh.RadiusMd))
            .background(if (current && !disabled) Dsh.Sel else Color.Transparent)
            .clickable(enabled = !disabled, onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 10.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                row.label,
                fontSize = 14.5.sp,
                lineHeight = 21.sp,
                color = fg,
                fontFamily = LocalDshFonts.current.body,
                modifier = Modifier.weight(1f),
            )
            if (current) {
                Spacer(Modifier.width(8.dp))
                CheckMark()
            }
        }
        val note = if (row.broken.isNotEmpty()) row.broken else row.description
        if (note.isNotEmpty()) {
            Spacer(Modifier.height(2.dp))
            Text(
                note,
                fontSize = 12.5.sp,
                lineHeight = 18.sp,
                color = if (row.broken.isNotEmpty()) Dsh.Err else Dsh.ListDim3,
                fontFamily = LocalDshFonts.current.body,
            )
        }
    }
}

/** 选中的那个对勾（画的，不用字形）。 */
@Composable
private fun CheckMark() {
    Canvas(modifier = Modifier.size(16.dp)) {
        val p = Path()
        p.moveTo(size.width * 0.18f, size.height * 0.52f)
        p.lineTo(size.width * 0.42f, size.height * 0.76f)
        p.lineTo(size.width * 0.84f, size.height * 0.26f)
        drawPath(
            p,
            Dsh.Brand,
            style = Stroke(width = 1.8.dp.toPx(), cap = StrokeCap.Round, join = StrokeJoin.Round),
        )
    }
}