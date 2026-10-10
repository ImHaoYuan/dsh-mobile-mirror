package dev.dsh.mirror.client.ui

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.border
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.dsh.mirror.client.R
import dev.dsh.mirror.client.theme.Dsh
import dev.dsh.mirror.client.theme.LocalDshFonts

/**
 * 配对页 / 登录页共用的版式：**整组垂直居中**，内容超高时自动滚动。
 *
 * <p>为什么不是顶对齐：这两页都只有「图标 + 标题 + 一两个输入框 + 按钮」，
 * 顶对齐会让下半屏空一大片。居中之后输入框自然落在屏幕中间。
 *
 * <p>{@code verticalScroll} 与 {@code Arrangement.Center} 能共存：外层
 * {@code fillMaxSize} 把高度钉在视口上，滚动修饰符只负责"装不下时能滚"，
 * 于是内容矮时居中、高时滚动，两种情形不用分叉写。
 *
 * <p><b>间距用 {@code spacedBy} 统一给，页面里不手写 {@code Spacer}</b>：
 * 手写间距时「输入框 → 按钮」这种相邻关系极易漏掉（0.2.1 就漏了，两者贴在一起）。
 * 统一间距还有个好处 —— {@code DshHint} / {@code DshError} 没内容时是空节点、不占位，
 * 报错出现时不会多出空隙。
 */
@Composable
fun DshCenteredPage(content: @Composable ColumnScope.() -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 24.dp, vertical = 32.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp, Alignment.CenterVertically),
        horizontalAlignment = Alignment.CenterHorizontally,
        content = content,
    )
}

/**
 * 页面上的 App 图标：黑底圆角方块 + 白色手机字形。
 *
 * <p><b>刻意复用启动图标的前景矢量</b>（{@code ic_launcher_foreground}）而不是另画一个
 * "页面版 logo" —— 否则以后改图标就得改两处，迟早漂移。
 *
 * <p>启动图标是自适应图标（{@code <adaptive-icon>} XML），Compose 渲染不了它本身，
 * 所以这里拆成两步：底色用 Compose 画，前景用矢量画。视觉与启动器里一致
 * （那个手机字形本来就偏小 —— 108 画布只占 18×48，和启动图标里一模一样）。
 */
@Composable
fun DshAppMark(size: Dp = 80.dp) {
    Box(
        modifier = Modifier
            .size(size)
            .clip(RoundedCornerShape(size * 0.25f))
            .background(Color.Black),
        contentAlignment = Alignment.Center,
    ) {
        Image(
            painter = painterResource(R.drawable.ic_launcher_foreground),
            contentDescription = null,
            modifier = Modifier.fillMaxSize(),
        )
    }
}

/** 页面主标题：20sp、居中。 */
@Composable
fun DshPageTitle(text: String) {
    Text(
        text,
        modifier = Modifier.fillMaxWidth(),
        textAlign = TextAlign.Center,
        fontSize = 20.sp,
        color = Dsh.LabelPrimary,
    )
}

/** 主按钮：品牌蓝、圆角 12、高 44。 */
@Composable
fun DshPrimaryButton(text: String, enabled: Boolean = true, onClick: () -> Unit) {
    Button(
        onClick = onClick,
        enabled = enabled,
        modifier = Modifier.fillMaxWidth().height(44.dp),
        shape = RoundedCornerShape(Dsh.RadiusMd),
        colors = ButtonDefaults.buttonColors(
            containerColor = Dsh.Brand,
            contentColor = Color.White,
            disabledContainerColor = Dsh.BgOverlay,
            disabledContentColor = Dsh.LabelTertiary,
        ),
        contentPadding = PaddingValues(0.dp),
    ) {
        Text(text, fontSize = 15.sp)
    }
}

/** 次按钮：白底 + l4 描边，用于「重新配对」这类破坏性不强的操作。 */
@Composable
fun DshSecondaryButton(text: String, enabled: Boolean = true, onClick: () -> Unit) {
    OutlinedButton(
        onClick = onClick,
        enabled = enabled,
        modifier = Modifier.fillMaxWidth().height(44.dp),
        shape = RoundedCornerShape(Dsh.RadiusMd),
        border = BorderStroke(1.dp, Dsh.BorderL4),
        colors = ButtonDefaults.outlinedButtonColors(contentColor = Dsh.LabelSecondary),
    ) {
        Text(text, fontSize = 15.sp)
    }
}

/**
 * 次按钮 + 开关（0.15.4）。
 *
 * <p>与 [DshSecondaryButton] **同款**：1dp l4 描边、圆角 12、高 44，只是右侧放一个开关。
 * 原先抽屉里的「详细模式」是一行裸文字 + 开关 —— 看上去不像个控件，和旁边的按钮也不一致。
 */
@Composable
fun DshSecondarySwitch(text: String, checked: Boolean, onCheckedChange: (Boolean) -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(44.dp)
            .clip(RoundedCornerShape(Dsh.RadiusMd))
            .border(1.dp, Dsh.BorderL4, RoundedCornerShape(Dsh.RadiusMd))
            .clickable { onCheckedChange(!checked) }
            .padding(horizontal = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(text, modifier = Modifier.weight(1f), fontSize = 15.sp, color = Dsh.LabelSecondary)
        Switch(checked = checked, onCheckedChange = onCheckedChange)
    }
}

@Composable
fun DshField(
    value: String,
    onValueChange: (String) -> Unit,
    label: String,
    enabled: Boolean = true,
    password: Boolean = false,
    /** 等宽字体（新建会话里手输路径那一格用，网页端 .sheet-input 同款）。 */
    monospace: Boolean = false,
    keyboardType: KeyboardType = KeyboardType.Text,
) {
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        label = { Text(label, fontSize = 13.sp) },
        singleLine = true,
        enabled = enabled,
        visualTransformation = if (password) PasswordVisualTransformation() else VisualTransformation.None,
        keyboardOptions = KeyboardOptions(keyboardType = keyboardType),
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(Dsh.RadiusMd),
        textStyle = TextStyle(
            fontSize = 15.sp,
            color = Dsh.LabelPrimary,
            fontFamily = if (monospace) LocalDshFonts.current.mono else FontFamily.Default,
        ),
        colors = OutlinedTextFieldDefaults.colors(
            focusedBorderColor = Dsh.Brand,
            unfocusedBorderColor = Dsh.BorderL2,
            focusedLabelColor = Dsh.Brand,
            unfocusedLabelColor = Dsh.LabelTertiary,
            cursorColor = Dsh.Brand,
            focusedTextColor = Dsh.LabelPrimary,
            unfocusedTextColor = Dsh.LabelPrimary,
            disabledTextColor = Dsh.LabelTertiary,
        ),
    )
}

/** 报错正文：12sp 红字（DSH 桌面端提问卡的反馈行同规格）。 */
@Composable
fun DshError(text: String, center: Boolean = false) {
    if (text.isEmpty()) return
    Text(
        text,
        modifier = Modifier.fillMaxWidth(),
        textAlign = if (center) TextAlign.Center else TextAlign.Start,
        fontSize = 12.sp,
        lineHeight = 18.sp,
        color = Color(0xFFE5484D),
    )
}

/** 三级灰的小字说明。 */
@Composable
fun DshHint(text: String, center: Boolean = false) {
    Text(
        text,
        modifier = Modifier.fillMaxWidth(),
        textAlign = if (center) TextAlign.Center else TextAlign.Start,
        style = MaterialTheme.typography.labelSmall,
    )
}

/**
 * 手画的小箭头（`▾`）—— 展开时转 180°。
 *
 * <p>为什么不用字符：内置字体里没有 `⌄` / `▾` 这类字形，会掉到设备系统字体去画，
 * 各家 ROM 的粗细与基线都不一样。0.12 的模型胶囊先画了它，0.12.2 起文件夹胶囊共用。
 *
 * @param open 展开时转 180°（桌面端 `transition .12s` 同款）。
 */
@Composable
fun DshChevron(open: Boolean = false, size: Dp = 9.dp, color: Color = Dsh.ListDim3) {
    val turn by animateFloatAsState(if (open) 180f else 0f, tween(120), label = "chevron")
    Canvas(modifier = Modifier.size(size).rotate(turn)) {
        // 显式写 this.size：DrawScope 自己也有个 size，别跟参数撞上
        val w = this.size.width
        val h = this.size.height
        val p = Path()
        p.moveTo(w * 0.1f, h * 0.32f)
        p.lineTo(w * 0.5f, h * 0.7f)
        p.lineTo(w * 0.9f, h * 0.32f)
        drawPath(p, color, style = Stroke(width = 1.3.dp.toPx(), cap = StrokeCap.Round, join = StrokeJoin.Round))
    }
}

/**
 * 顶栏的字符键。
 *
 * <p>只留给**内置字体确实有**的那几个字形：`←`(U+2190)、`↑`(ASCII) —— JBM 里都有，渲染正常。
 * 像 `⟳`(U+27F3)、`⋯`(U+22EF)、`☰`(U+2630) 这些内置字体**没有**的，会掉到设备系统字体去画，
 * 各家 ROM 粗细大小都不一样 —— 那些改用 [DshIconButton]。
 */
@Composable
fun DshGlyphButton(
    glyph: String,
    onClick: () -> Unit,
    size: Dp = 40.dp,
    fontSize: Float = 17f,
    color: Color = Dsh.ListDim,
) {
    Box(
        modifier = Modifier.size(size).clip(RoundedCornerShape(10.dp)).clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Text(glyph, fontSize = fontSize.sp, fontWeight = FontWeight.Medium, color = color)
    }
}

/**
 * 顶栏的图标键（刷新 / 更多 / 菜单）。
 *
 * <p>为什么手画矢量而不用现成图标：`material-icons` 没进本机 Gradle 缓存
 * （`plugins.gradle.org` 连不上），拿不到 `Icons.Filled.Refresh`。
 * 而且原先那三个字形内置字体里都没有、只能由设备系统字体兜底，观感完全不可控 ——
 * 换成矢量后**大小与圆滑度都由我们定**：所有图标共用 [iconSize]，形状自带圆头线帽。
 */
@Composable
fun DshIconButton(
    icon: Int,
    onClick: () -> Unit,
    contentDescription: String? = null,
    size: Dp = 40.dp,
    iconSize: Dp = 20.dp,
    color: Color = Dsh.ListDim,
) {
    Box(
        modifier = Modifier.size(size).clip(RoundedCornerShape(10.dp)).clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            painter = painterResource(icon),
            contentDescription = contentDescription,
            tint = color,
            modifier = Modifier.size(iconSize),
        )
    }
}

/**
 * 指纹展示：每 4 组一行（{@code AA:BB:CC:DD}），等宽字体、整体居中。
 *
 * <p>32 组挤成一行在手机上根本对不了；分组换行后一眼能扫。
 */
@Composable
fun DshFingerprint(hex: String) {
    val pretty = dev.dsh.mirror.CertPinner.pretty(hex)
    val lines = pretty.split(':').chunked(4).map { it.joinToString(":") }
    Column(
        modifier = Modifier.fillMaxWidth(),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        for (line in lines) {
            Text(
                line,
                fontFamily = LocalDshFonts.current.mono,
                fontSize = 14.sp,
                lineHeight = 22.sp,
                letterSpacing = 0.5.sp,
                color = Dsh.LabelPrimary,
            )
        }
        Spacer(Modifier.height(2.dp))
    }
}
