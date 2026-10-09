package dev.dsh.mirror.client.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
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
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.dsh.mirror.client.R
import dev.dsh.mirror.client.theme.Dsh

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
            fontFamily = if (monospace) FontFamily.Monospace else FontFamily.Default,
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
                fontFamily = FontFamily.Monospace,
                fontSize = 14.sp,
                lineHeight = 22.sp,
                letterSpacing = 0.5.sp,
                color = Dsh.LabelPrimary,
            )
        }
        Spacer(Modifier.height(2.dp))
    }
}
