package dsh.mirror.client.ui

import android.content.Context
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
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
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import dsh.mirror.client.R
import dsh.mirror.client.net.AskBatch
import dsh.mirror.client.net.AskOption
import dsh.mirror.client.theme.Dsh
import dsh.mirror.client.theme.LocalDshFonts
import kotlinx.coroutines.launch

/**
 * 提问卡（0.11，用户选的形态：**底部弹出的卡片**）。
 *
 * <p>数据来自 {@link QuestionHub}（全局的 `/api/questions/stream`），按会话过滤；
 * 这条会话没有待答提问时它什么都不画。
 *
 * <p><b>为什么不用 `ModalBottomSheet`</b>：卡片里有个多行输入框，而 material3 的 bottom sheet
 * 是独立窗口，输入法与 `adjustResize` 在它上面容易错位。自己画「遮罩 + 贴底卡片」放在同一个
 * 窗口里，`adjustResize` 直接就能用。
 *
 * <p><b>认领（hold）</b>：卡片开着 = 认领，宿主不再跑它自己的 120 秒倒计时；卡片一关、
 * 或者 App 退到后台，立刻释放。释放不阻塞界面（即发即忘）。
 */
@Composable
fun AskOverlay(
    hub: QuestionHub,
    sessionId: String,
) {
    val pending = hub.forSession(sessionId)
    // 点过遮罩「稍后再答」的那些暂时不自动弹；底部留一个胶囊能再叫回来
    var dismissed by remember(sessionId) { mutableStateOf<Set<String>>(emptySet()) }
    val batch = pending.firstOrNull { it.id !in dismissed }
    val owner = LocalLifecycleOwner.current

    DisposableEffect(batch?.id) {
        val id = batch?.id
        if (id == null) return@DisposableEffect onDispose { }
        hub.holdAsync(id, true)
        val obs = LifecycleEventObserver { _, e ->
            when (e) {
                Lifecycle.Event.ON_START -> hub.holdAsync(id, true)
                Lifecycle.Event.ON_STOP -> hub.holdAsync(id, false)
                else -> Unit
            }
        }
        owner.lifecycle.addObserver(obs)
        onDispose {
            owner.lifecycle.removeObserver(obs)
            hub.holdAsync(id, false)
        }
    }

    Box(modifier = Modifier.fillMaxSize()) {
        if (batch == null) {
            if (pending.isNotEmpty()) {
                AskPill(
                    count = pending.size,
                    modifier = Modifier
                        .align(Alignment.BottomCenter)
                        .padding(bottom = 84.dp),
                ) { dismissed = dismissed - pending.map { it.id }.toSet() }
            }
            return@Box
        }

        // 遮罩：点一下 = 稍后再答（提问不会丢，底部留胶囊）
        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(Color.Black.copy(alpha = 0.32f))
                .clickable(
                    interactionSource = remember { MutableInteractionSource() },
                    indication = null,
                ) { dismissed = dismissed + batch.id },
        )

        AskCard(hub = hub, batch = batch, pendingCount = pending.size) {
            dismissed = dismissed + batch.id
        }
    }
}

/** 卡片本体：一道提问里的全部题目 + 一个提交键（贴底对齐靠 BoxScope）。 */
@Composable
private fun BoxScope.AskCard(
    hub: QuestionHub,
    batch: AskBatch,
    pendingCount: Int,
    onLater: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    val selected = remember(batch.id) { mutableStateMapOf<String, List<String>>() }
    val custom = remember(batch.id) { mutableStateMapOf<String, String>() }
    var busy by remember(batch.id) { mutableStateOf(false) }
    var error by remember(batch.id) { mutableStateOf("") }

    // 宿主的要求：**每道题**要么选了选项、要么写了自定义答案，否则整批被拒
    val ready = AskLogic.ready(batch.questions, selected, custom)

    val submit: () -> Unit = {
        if (!busy && ready) {
            busy = true
            error = ""
            scope.launch {
                val err = hub.submit(batch, AskLogic.answers(batch.questions, selected, custom))
                busy = false
                if (err != null) error = err
            }
        }
    }

    Column(
        modifier = Modifier
            .align(Alignment.BottomCenter)
            .fillMaxWidth()
            .clip(RoundedCornerShape(topStart = 20.dp, topEnd = 20.dp))
            .background(Dsh.BgPage)
            .heightIn(max = 520.dp)
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 18.dp, vertical = 16.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                stringResource(R.string.ask_title),
                fontSize = 16.sp,
                fontWeight = FontWeight.SemiBold,
                fontFamily = LocalDshFonts.current.uiBold,
                color = Dsh.ListFg,
                modifier = Modifier.weight(1f),
            )
            Text(
                stringResource(R.string.ask_later),
                fontSize = 13.sp,
                color = Dsh.ListDim,
                fontFamily = LocalDshFonts.current.ui,
                modifier = Modifier.clickable(onClick = onLater).padding(4.dp),
            )
        }
        if (pendingCount > 1) {
            Spacer(Modifier.height(4.dp))
            Text(
                stringResource(R.string.ask_more, pendingCount - 1),
                fontSize = 12.sp,
                color = Dsh.ListDim3,
                fontFamily = LocalDshFonts.current.ui,
            )
        }

        for (q in batch.questions) {
            Spacer(Modifier.height(14.dp))
            if (q.header.isNotEmpty()) {
                Text(
                    q.header,
                    fontSize = 11.5.sp,
                    color = Dsh.AccentFg,
                    fontFamily = LocalDshFonts.current.ui,
                    modifier = Modifier
                        .clip(RoundedCornerShape(999.dp))
                        .background(Dsh.Sel)
                        .padding(horizontal = 8.dp, vertical = 3.dp),
                )
                Spacer(Modifier.height(7.dp))
            }
            Text(
                q.text,
                fontSize = 15.sp,
                lineHeight = 22.sp,
                color = Dsh.ListFg,
                fontFamily = LocalDshFonts.current.body,
            )
            for (o in q.options) {
                Spacer(Modifier.height(8.dp))
                OptionRow(
                    option = o,
                    multi = q.multiSelect,
                    on = selected[q.id]?.contains(o.label) == true,
                ) {
                    val cur = selected[q.id] ?: emptyList()
                    selected[q.id] = if (q.multiSelect) {
                        if (cur.contains(o.label)) cur - o.label else cur + o.label
                    } else {
                        listOf(o.label)
                    }
                }
            }
            Spacer(Modifier.height(9.dp))
            CustomField(
                value = custom[q.id] ?: "",
                onValueChange = { custom[q.id] = it },
                hint = stringResource(
                    if (q.options.isEmpty()) R.string.ask_custom_only else R.string.ask_custom_hint,
                ),
            )
        }

        Spacer(Modifier.height(14.dp))
        if (error.isNotEmpty()) {
            DshError(error)
            Spacer(Modifier.height(8.dp))
        }
        DshPrimaryButton(
            text = stringResource(if (busy) R.string.ask_submitting else R.string.ask_submit),
            enabled = ready && !busy,
            onClick = submit,
        )
        if (!ready) {
            Spacer(Modifier.height(6.dp))
            DshHint(stringResource(R.string.ask_need_answer))
        }
        Spacer(Modifier.height(6.dp))
    }
}

/** 「有 N 个问题待回答」那个胶囊（点一下把卡片叫回来）。 */
@Composable
private fun AskPill(count: Int, modifier: Modifier = Modifier, onClick: () -> Unit) {
    Box(modifier = modifier) {
        Text(
            stringResource(R.string.ask_pill, count),
            fontSize = 13.sp,
            color = Dsh.AccentFg,
            fontFamily = LocalDshFonts.current.ui,
            modifier = Modifier
                .clip(RoundedCornerShape(999.dp))
                .background(Dsh.Sel)
                .clickable(onClick = onClick)
                .padding(horizontal = 14.dp, vertical = 8.dp),
        )
    }
}

/** 一个选项。左边的指示器是**画出来的**（单选圆 / 多选方），不用字形。 */
@Composable
private fun OptionRow(option: AskOption, multi: Boolean, on: Boolean, onClick: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(Dsh.RadiusMd))
            .background(if (on) Dsh.Sel else Dsh.Chip)
            .clickable(onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 10.dp),
        verticalAlignment = Alignment.Top,
    ) {
        Canvas(modifier = Modifier.size(18.dp)) {
            val stroke = 1.6.dp.toPx()
            val c = if (on) Dsh.Brand else Dsh.BorderL4
            if (multi) {
                val r = 3.dp.toPx()
                if (on) {
                    drawRoundRect(color = c, cornerRadius = CornerRadius(r, r))
                    val p = Path()
                    p.moveTo(size.width * 0.24f, size.height * 0.52f)
                    p.lineTo(size.width * 0.44f, size.height * 0.72f)
                    p.lineTo(size.width * 0.78f, size.height * 0.30f)
                    drawPath(
                        p,
                        Color.White,
                        style = Stroke(width = stroke * 1.4f, cap = StrokeCap.Round),
                    )
                } else {
                    drawRoundRect(
                        color = c,
                        cornerRadius = CornerRadius(r, r),
                        style = Stroke(width = stroke),
                    )
                }
            } else {
                val rad = size.minDimension / 2f - stroke / 2f
                drawCircle(color = c, radius = rad, style = Stroke(width = stroke))
                if (on) drawCircle(color = Dsh.Brand, radius = size.minDimension * 0.24f)
            }
        }
        Spacer(Modifier.width(10.dp))
        Column(modifier = Modifier.weight(1f)) {
            Text(
                option.label,
                fontSize = 14.5.sp,
                lineHeight = 21.sp,
                color = Dsh.ListFg,
                fontFamily = LocalDshFonts.current.body,
            )
            if (option.description.isNotEmpty()) {
                Spacer(Modifier.height(2.dp))
                Text(
                    option.description,
                    fontSize = 12.5.sp,
                    lineHeight = 18.sp,
                    color = Dsh.ListDim3,
                    fontFamily = LocalDshFonts.current.body,
                )
            }
        }
    }
}

/** 自定义答案（多行，样式与底部输入框一致）。 */
@Composable
private fun CustomField(value: String, onValueChange: (String) -> Unit, hint: String) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 46.dp, max = 120.dp)
            .clip(RoundedCornerShape(Dsh.RadiusMd))
            .background(Dsh.Field)
            .padding(horizontal = 12.dp, vertical = 10.dp),
    ) {
        if (value.isEmpty()) {
            Text(
                hint,
                fontSize = 14.sp,
                color = Dsh.Placeholder,
                fontFamily = LocalDshFonts.current.body,
            )
        }
        BasicTextField(
            value = value,
            onValueChange = onValueChange,
            modifier = Modifier.fillMaxWidth().heightIn(max = 100.dp),
            textStyle = TextStyle(
                fontSize = 14.sp,
                lineHeight = 21.sp,
                color = Dsh.ListFg,
                fontFamily = LocalDshFonts.current.body,
            ),
            cursorBrush = SolidColor(Dsh.Brand),
            maxLines = 5,
        )
    }
}