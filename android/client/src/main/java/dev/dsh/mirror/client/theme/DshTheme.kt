package dev.dsh.mirror.client.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * DSH / DeepSeek 的设计 token（**只有浅色**，用户指定不跟随系统）。
 *
 * 取值出处（见 docs/client-plan.md）：
 * - 颜色与圆角来自 DSH 桌面端的 [dsh-client-ui-theme]：--dsw-static-* / --dsw-alias-* / --dsw-radius-*
 * - 用户气泡底色、品牌蓝另有参考截图实测值佐证
 */
object Dsh {
    /** 品牌蓝。DSH 的 deepseek-500 是 #4176E6，参考截图的鲸鱼 logo 实测 #4E69EE —— 取项目网页端在用的 #4D6BFE。 */
    val Brand = Color(0xFF4D6BFE)

    /** 输入条上「深度思考」那类胶囊：浅蓝底 + 蓝字/蓝图标（截图实测 #E4F2FF / #5371D1）。 */
    val BrandChipBg = Color(0xFFE4F2FF)
    val BrandChipFg = Color(0xFF5371D1)

    /** 用户消息气泡底（DSH --dsw-specific-bubble = deepseek-50）。 */
    val Bubble = Color(0xFFEDF3FE)

    val LabelPrimary = Color(0xFF0F1115)     // --dsw-alias-label-primary
    val LabelSecondary = Color(0xFF61666B)   // --dsw-alias-label-secondary
    val LabelTertiary = Color(0xFF81858C)    // --dsw-alias-label-tertiary
    val LabelCaption = Color(0xFFADB2B8)     // --dsw-alias-label-caption

    val BgPage = Color(0xFFFFFFFF)           // --dsw-specific-input-major（卡片底）
    val BgModule = Color(0xFFF5F6F7)         // --dsw-alias-bg-module-platform
    val BgOverlay = Color(0xFFE9ECF2)        // --dsw-alias-bg-overlay（编号徽章底）

    val Hover = Color(0x0F263148)            // --dsw-alias-interactive-bg-hover
    val BorderL2 = Color(0x1A000000)         // --dsw-alias-border-l2
    val BorderL4 = Color(0x29000000)         // --dsw-alias-border-l4

    // —— 会话列表专用：取自网页端 app.css 的**浅色**那一套（@media prefers-color-scheme: light）。
    // 刻意不复用上面的 DSH 桌面 token：列表要对齐的是网页端，两边灰阶并不完全相同。
    val ListFg = Color(0xFF1B1F24)           // --fg（会话标题）
    val ListDim = Color(0xFF575F6B)          // --dim（分组名、相对时间）
    val ListDim3 = Color(0xFF767D88)         // --dim-3（分组数量、短路径、页脚）
    val ListLine = Color(0xFFE2E5EA)         // --line（会话行分隔线）
    val ListLine2 = Color(0xFFC9CED8)        // --line-2（子会话引导线、灰标签描边）
    val Chip = Color(0xFFEEF1F5)             // --chip（标签底、面板选项底）
    val Code = Color(0xFFF2F4F7)             // --code（面板输入框底）
    val Field = Color(0xFFF4F6F9)            // --field
    val Sel = Color(0xFFE8EFFF)              // --sel（选中项底）
    val Ok = Color(0xFF1A7F4B)               // --ok（运行中）
    val OkBg = Color(0xFFE7F6ED)             // --ok-bg
    val LineOk = Color(0xFFB7E4C7)           // --line-ok
    val AccentFg = Color(0xFF1D4ED8)         // --accent-fg（待回答标签的字）
    val LineAsk = Color(0xFFC7D8F5)          // --line-ask
    val Placeholder = Color(0xFF878E99)      // --placeholder

    // 圆角阶梯：--dsw-radius-xs/sm/md/lg/xl = 4/8/12/16/20
    val RadiusXs = 4.dp
    val RadiusSm = 8.dp
    val RadiusMd = 12.dp
    val RadiusLg = 16.dp
    val RadiusXl = 20.dp

    /** 正文 14sp/22sp（DSH 默认 --dsh-content-font-size，桌面端气泡同值）。 */
    val BodySize = 14.sp
    val BodyLine = 22.sp
}

private val DshTypography = Typography(
    bodyLarge = TextStyle(fontSize = Dsh.BodySize, lineHeight = Dsh.BodyLine, color = Dsh.LabelPrimary),
    titleMedium = TextStyle(fontSize = 16.sp, lineHeight = 22.sp, color = Dsh.LabelPrimary),
    labelSmall = TextStyle(fontSize = 11.sp, lineHeight = 16.sp, color = Dsh.LabelTertiary),
)

@Composable
fun DshMirrorTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = lightColorScheme(
            primary = Dsh.Brand,
            onPrimary = Color.White,
            background = Dsh.BgPage,
            onBackground = Dsh.LabelPrimary,
            surface = Dsh.BgPage,
            onSurface = Dsh.LabelPrimary,
            surfaceVariant = Dsh.BgModule,
            onSurfaceVariant = Dsh.LabelSecondary,
            outline = Dsh.BorderL4,
            outlineVariant = Dsh.BorderL2,
        ),
        typography = DshTypography,
        content = content,
    )
}
