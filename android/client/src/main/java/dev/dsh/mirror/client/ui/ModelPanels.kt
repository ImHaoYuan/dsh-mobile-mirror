package dev.dsh.mirror.client.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
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

/** 一次切换的回执。`null` 表示成功。 */
class PickReply(val message: String, val locked: Boolean = false)

/**
 * 胶囊行下面那块**就地展开**的面板（0.12.3）。同一时刻最多一块。
 *
 * <p>模型 / 模式 / 文件夹三个入口共用同一个位置：谁被点开谁就长在那里。首页、会话页、
 * 抽屉里的「新建会话」都是这个规矩，所以面板形态也必须只有一种 —— 没有遮罩、没有卡片底，
 * 就地长出来、最高半个窗口、超了自己滚（与首页文件夹清单**一模一样**）。
 *
 * <p>0.12 的模型 / 模式是一张盖住整屏的贴底大卡（带 32% 黑遮罩、没有入场动画），
 * 0.12.3 拆成两块、改成这个形态。
 */
enum class ChipPanel { None, Model, Preset, Folder, Path }

/** 面板展开 / 收起的动画时长（与首页文件夹清单一致）。 */
const val PANEL_MS = 220

/**
 * 胶囊行里的一颗（0.12 起是模型 / 模式，0.12.3 起文件夹也用同一种）。
 *
 * <p>尺寸：**全圆**、12.5sp、横 12dp 竖 7dp。模型 / 模式这两颗原来是照 DSH 桌面端
 * `wq12jW_trigger` 的「8dp 圆角 + 13sp + 竖 5dp」，0.12.3 三颗并排后必须完全同高同圆角，
 * 于是统一到文件夹那一套。chevron 展开时转 180°（`transition .12s`）。
 *
 * @param prefix 前缀小字（文件夹那颗是「文件夹」），空就不画。
 * @param modifier 宽度由调用方给：并排时是 `weight(1f, fill = false)`，各占一份、谁也不挤谁。
 */
@Composable
fun ModelCapsule(
    text: String,
    open: Boolean,
    enabled: Boolean = true,
    prefix: String = "",
    modifier: Modifier = Modifier,
    onClick: () -> Unit,
) {
    Row(
        modifier = modifier
            .clip(RoundedCornerShape(999.dp))
            .background(Dsh.Chip)
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 7.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (prefix.isNotEmpty()) {
            Text(prefix, fontSize = 12.5f.sp, color = Dsh.ListDim3, fontFamily = LocalDshFonts.current.ui)
            Spacer(Modifier.width(6.dp))
        }
        Text(
            text,
            // fill = false：短就按内容宽（不硬撑），长就截到自己的那份 —— 并排时谁也不会把谁挤出去
            modifier = Modifier.weight(1f, fill = false),
            fontSize = 12.5f.sp,
            color = if (enabled) Dsh.ListDim else Dsh.ListDim3,
            fontFamily = LocalDshFonts.current.ui,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        Spacer(Modifier.width(5.dp))
        // 箭头与文件夹胶囊共用（0.12.2 抽到 Components.kt）
        DshChevron(open = open)
    }
}

/**
 * 面板正文的外壳：**与首页文件夹清单同一套** —— 左右 16dp、最高 [maxHeight]、超了自己滚、
 * 底部留 10dp（面板与下面输入框的间隔）。
 *
 * <p>没有卡片底、没有遮罩：面板就是长在页面里的，页面还是亮的。
 */
@Composable
fun PanelBody(maxHeight: Dp, content: @Composable ColumnScope.() -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(start = 16.dp, end = 16.dp, bottom = 10.dp)
            .heightIn(max = maxHeight)
            .verticalScroll(rememberScrollState()),
        content = content,
    )
}

/**
 * 模型面板（0.12.3）：就地展开的模型清单。
 *
 * <p>选**模型 / 档位**不关面板 —— 档位只在当前模型下面展开，换完要能接着调。
 *
 * @param maxHeight 面板最高多少（三处调用都给「半个窗口」）。
 * @param onPick 选模型；返回 null = 成功。
 */
@Composable
fun ModelPanel(
    hub: ModelHub,
    pick: ModelPick,
    maxHeight: Dp,
    onPick: suspend (ModelPick) -> PickReply?,
) {
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf("") }
    var done by remember { mutableStateOf("") }

    LaunchedEffect(Unit) { hub.ensure() }

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

    PanelBody(maxHeight) {
        // 目录段：`/api/models` 要宿主控制器就绪，刚启动可能是 503 —— 那就给「重试」，
        // 而不是把整块清空。
        val cat = hub.catalog
        if (cat == null) {
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
        PanelFeedback(done, error)
    }
}

/**
 * 模式面板（0.12.3）：就地展开的模式清单。
 *
 * <p>模式段**独立于目录**：`/api/presets` 不需要控制器，所以目录 503 时模式照样能换 ——
 * 一起藏掉就等于「控制器没就绪 = 模式也不让选」，没必要。
 *
 * @param presetLocked 会话已经跑过至少一轮 —— DSH 的规则，模式不能再改。
 * @param onPreset 换模式；返回 null = 成功（成功就收起面板：换模式是决定性动作）。
 */
@Composable
fun PresetPanel(
    hub: ModelHub,
    presetId: String,
    presetLocked: Boolean,
    maxHeight: Dp,
    onPreset: suspend (String) -> PickReply?,
    onDismiss: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf("") }
    var locked by remember(presetLocked) { mutableStateOf(presetLocked) }

    LaunchedEffect(Unit) { hub.ensure() }

    fun choosePreset(id: String) {
        if (busy) return
        busy = true
        error = ""
        scope.launch {
            val r = onPreset(id)
            busy = false
            // 成功就收起面板 —— 换模式是决定性动作，留在面板里只会挡着会话
            if (r == null) {
                onDismiss()
            } else {
                error = r.message
                if (r.locked) locked = true
            }
        }
    }

    PanelBody(maxHeight) {
        if (locked) {
            DshHint(stringResource(R.string.model_preset_locked))
            Spacer(Modifier.height(6.dp))
        }
        if (hub.presets.isEmpty()) {
            DshHint(stringResource(R.string.model_preset_none))
        }
        for (p in hub.presets) {
            PresetRowView(
                row = p,
                current = p.id == presetId,
                disabled = locked || busy || p.broken.isNotEmpty(),
            ) { choosePreset(p.id) }
        }
        PanelFeedback("", error)
    }
}

/** 面板底部的反馈行（原来在卡片最下面）：成功绿字，失败红字。 */
@Composable
private fun PanelFeedback(done: String, error: String) {
    if (done.isNotEmpty()) {
        Spacer(Modifier.height(10.dp))
        Text(
            stringResource(R.string.model_switched, done),
            fontSize = 12.5.sp,
            color = Dsh.Ok,
            fontFamily = LocalDshFonts.current.ui,
        )
    }
    if (error.isNotEmpty()) {
        Spacer(Modifier.height(10.dp))
        DshError(error)
    }
}

/** 小节标题（「读不到的 provider」）。 */
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
