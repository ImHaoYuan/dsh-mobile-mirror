package dsh.mirror.client.ui

import android.content.Context
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dsh.mirror.client.R
import dsh.mirror.client.theme.LocalDshFonts
import dsh.mirror.client.theme.Dsh
import dsh.mirror.client.theme.DshFontStore
import dsh.mirror.client.theme.FontChoice
import dsh.mirror.client.theme.FontPrefs
import dsh.mirror.client.theme.FontSlot
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** 三档字体，用来记住「这次的文件是给哪一档挑的」。 */
private enum class SlotKind { Ui, Body, Mono }

/**
 * 字体面板（{@code ⋯ → 字体}）。
 *
 * <p>三档各一行：**内置 / 系统 / 文件…**。选「文件…」直接拉系统文件选择器，
 * 挑中的文件复制进 App 私有目录后立刻校验能不能当字体用（见 {@link DshFontStore#import}）。
 *
 * <p>0.6 起它是**抽屉里的一页**（头部 ← 返回，正文可滚动），不再是底部弹层。
 *
 * <p>这一版**每档只能整体换一个字体**：自定义字体同时顶替拉丁与中文两路，缺字回落系统。
 * 想做「拉丁用 A、中文用 B」的分开指定，得再拆一层，等有需要再说。
 */
@Composable
fun FontPanel(
    app: Context,
    initial: FontPrefs,
    onChanged: (FontPrefs) -> Unit,
    onBack: () -> Unit,
    onLicenses: () -> Unit,
) {
    var prefs by remember { mutableStateOf(initial) }
    var error by remember { mutableStateOf("") }
    var picking by remember { mutableStateOf<SlotKind?>(null) }
    var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    val tTitle = stringResource(R.string.font_title)
    val tBuiltin = stringResource(R.string.font_builtin)
    val tSystem = stringResource(R.string.font_system)
    val tFile = stringResource(R.string.font_file)
    val tImportFail = stringResource(R.string.font_import_failed)
    val tImporting = stringResource(R.string.font_importing)
    val tReset = stringResource(R.string.font_reset)
    val tLicenses = stringResource(R.string.more_licenses)
    val tRemove = stringResource(R.string.font_remove)
    val tNote = stringResource(R.string.font_note)

    // 局部函数必须写在用它的地方之前（Kotlin 不做提升），所以这三个先声明 —— picker 里要用
    fun choose(kind: SlotKind, slot: FontSlot) {
        val next = put(prefs, kind, slot)
        prefs = next
        error = ""
        onChanged(next)
    }

    fun fileOf(kind: SlotKind): String? = when (kind) {
        SlotKind.Ui -> prefs.ui.file
        SlotKind.Body -> prefs.body.file
        SlotKind.Mono -> prefs.mono.file
    }

    /**
     * 删掉这一档导入的字体：**文件也从私有目录删掉**。
     *
     * <p>只把选择改回「内置」是不够的 —— 文件留在 `filesDir/fonts/` 里，界面上再也看不见、
     * 也没地方删，反复导入就成了几 MB 一个的隐形垃圾。
     */
    fun dropCustom(kind: SlotKind) {
        fileOf(kind)?.let { DshFontStore.delete(app, it) }
        choose(kind, FontSlot(FontChoice.Builtin))
    }

    // 三档共用一个选择器：选完往哪一档写，靠 picking 记住
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        val kind = picking
        picking = null
        if (uri == null || kind == null) return@rememberLauncherForActivityResult
        busy = true
        scope.launch {
            // 复制 + 建 Typeface 可能几百毫秒（大字体上 MB），别占着主线程
            val name = withContext(Dispatchers.IO) { DshFontStore.import(app, uri) }
            busy = false
            if (name == null) {
                error = tImportFail
                return@launch
            }
            error = ""
            // 换新字体时把这一档原来那个文件删掉，否则它就成了看不见的死文件
            val old = fileOf(kind)
            if (!old.isNullOrEmpty() && old != name) DshFontStore.delete(app, old)
            val next = put(prefs, kind, FontSlot(FontChoice.Custom, name))
            prefs = next
            onChanged(next)
        }
    }

    DrawerPanel(tTitle, onBack) {
        PanelNote(tNote)

        SlotSection(
            title = stringResource(R.string.font_slot_ui),
            note = stringResource(R.string.font_slot_ui_note),
            builtin = stringResource(R.string.font_builtin_ui),
            systemDesc = stringResource(R.string.font_system_desc),
            currentFmt = stringResource(R.string.font_current),
            slot = prefs.ui,
            enabled = !busy,
            labels = Triple(tBuiltin, tSystem, tFile),
            onChoose = { choose(SlotKind.Ui, it) },
            onPickFile = {
                picking = SlotKind.Ui
                picker.launch(arrayOf("*/*"))
            },
            onRemove = { dropCustom(SlotKind.Ui) },
            removeLabel = tRemove,
        )
        SlotSection(
            title = stringResource(R.string.font_slot_body),
            note = stringResource(R.string.font_slot_body_note),
            builtin = stringResource(R.string.font_builtin_body),
            systemDesc = stringResource(R.string.font_system_desc),
            currentFmt = stringResource(R.string.font_current),
            slot = prefs.body,
            enabled = !busy,
            labels = Triple(tBuiltin, tSystem, tFile),
            onChoose = { choose(SlotKind.Body, it) },
            onPickFile = {
                picking = SlotKind.Body
                picker.launch(arrayOf("*/*"))
            },
            onRemove = { dropCustom(SlotKind.Body) },
            removeLabel = tRemove,
        )
        SlotSection(
            title = stringResource(R.string.font_slot_mono),
            note = stringResource(R.string.font_slot_mono_note),
            builtin = stringResource(R.string.font_builtin_mono),
            systemDesc = stringResource(R.string.font_system_desc),
            currentFmt = stringResource(R.string.font_current),
            slot = prefs.mono,
            enabled = !busy,
            labels = Triple(tBuiltin, tSystem, tFile),
            onChoose = { choose(SlotKind.Mono, it) },
            onPickFile = {
                picking = SlotKind.Mono
                picker.launch(arrayOf("*/*"))
            },
            onRemove = { dropCustom(SlotKind.Mono) },
            removeLabel = tRemove,
        )

        if (busy) PanelNote(tImporting)
        DshError(error, center = false)

        Spacer(Modifier.height(6.dp))
        // 三档回内置，并把导入过的字体一并删掉（否则它们既看不见也删不掉）
        DshSecondaryButton(tReset) {
            dropCustom(SlotKind.Ui)
            dropCustom(SlotKind.Body)
            dropCustom(SlotKind.Mono)
        }
        Spacer(Modifier.height(8.dp))
        DshSecondaryButton(tLicenses) { onLicenses() }
        Spacer(Modifier.height(8.dp))
    }
}

private fun put(prefs: FontPrefs, kind: SlotKind, slot: FontSlot): FontPrefs = when (kind) {
    SlotKind.Ui -> prefs.copy(ui = slot)
    SlotKind.Body -> prefs.copy(body = slot)
    SlotKind.Mono -> prefs.copy(mono = slot)
}

@Composable
private fun SlotSection(
    title: String,
    note: String,
    builtin: String,
    systemDesc: String,
    currentFmt: String,
    slot: FontSlot,
    enabled: Boolean,
    labels: Triple<String, String, String>,
    onChoose: (FontSlot) -> Unit,
    onPickFile: () -> Unit,
    onRemove: () -> Unit,
    removeLabel: String,
) {
    Spacer(Modifier.height(14.dp))
    Text(title, fontSize = 14.5f.sp, fontWeight = FontWeight.SemiBold, fontFamily = LocalDshFonts.current.uiBold, color = Dsh.ListFg)
    Text(note, fontSize = 12.sp, lineHeight = 18.sp, color = Dsh.ListDim3)

    Spacer(Modifier.height(8.dp))
    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        SegChip(
            label = labels.first,
            selected = slot.choice == FontChoice.Builtin,
            enabled = enabled,
            onClick = { onChoose(FontSlot(FontChoice.Builtin)) },
        )
        SegChip(
            label = labels.second,
            selected = slot.choice == FontChoice.System,
            enabled = enabled,
            onClick = { onChoose(FontSlot(FontChoice.System)) },
        )
        SegChip(
            label = labels.third,
            selected = slot.choice == FontChoice.Custom,
            enabled = enabled,
            onClick = onPickFile,
        )
    }

    // 当前生效的到底是哪个字体，写在胶囊下面一行 —— 胶囊只放短标签，放不下「内置 · JetBrains Mono + 得意黑」
    val file = slot.file
    val current = when (slot.choice) {
        FontChoice.Builtin -> builtin
        FontChoice.System -> systemDesc
        FontChoice.Custom -> file ?: ""
    }
    if (current.isNotEmpty()) {
        Spacer(Modifier.height(6.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                currentFmt.format(current),
                modifier = Modifier.weight(1f),
                fontSize = 11.5f.sp,
                color = Dsh.ListDim3,
                maxLines = 1,
            )
            if (slot.choice == FontChoice.Custom) {
                Text(
                    removeLabel,
                    modifier = Modifier.clickable(enabled = enabled, onClick = onRemove).padding(4.dp),
                    fontSize = 11.5f.sp,
                    color = Dsh.Brand,
                )
            }
        }
    }
}

@Composable
private fun SegChip(label: String, selected: Boolean, enabled: Boolean, onClick: () -> Unit) {
    val shape = RoundedCornerShape(999.dp)
    Box(
        modifier = Modifier
            .clip(shape)
            .background(if (selected) Dsh.Sel else Dsh.Chip)
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 7.dp),
    ) {
        Text(
            label,
            fontSize = 12.5f.sp,
            fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal,
            color = if (selected) Dsh.AccentFg else Dsh.ListDim,
            maxLines = 1,
        )
    }
}

/**
 * 开源许可。
 *
 * <p>OFL 要求随包附版权声明与许可全文，所以这里不是「顺手加的一页」，是**合规动作**：
 * 三份原文都从 {@code assets/licenses/} 读，与随包分发的那几个字体文件一一对应。
 */
@Composable
fun LicensePanel(onBack: () -> Unit) {
    val app = LocalContext.current.applicationContext
    val tTitle = stringResource(R.string.license_title)
    val items = remember {
        listOf(
            "JetBrains Mono" to "licenses/OFL-JetBrainsMono.txt",
            "得意黑 Smiley Sans" to "licenses/OFL-SmileySans.txt",
            "思源黑体 Noto Sans SC" to "licenses/OFL-NotoSansSC.txt",
        )
    }

    DrawerPanel(tTitle, onBack) {
        for ((name, path) in items) {
            val text = remember(path) {
                runCatching { app.assets.open(path).bufferedReader().use { it.readText() } }
                    .getOrDefault("（读不到 " + path + "）")
            }
            Text(name, fontSize = 14.sp, fontWeight = FontWeight.SemiBold, fontFamily = LocalDshFonts.current.uiBold, color = Dsh.ListFg)
            Spacer(Modifier.height(4.dp))
            Text(text, fontSize = 11.sp, lineHeight = 16.sp, color = Dsh.ListDim)
            Spacer(Modifier.height(16.dp))
        }
    }
}
