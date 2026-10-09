package dev.dsh.mirror.client.ui

import android.content.Context
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import dev.dsh.mirror.ServerPrefs
import dev.dsh.mirror.client.R
import dev.dsh.mirror.client.net.Pairing
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * 配对页：输地址 → 探测 → 核对指纹。
 *
 * <p>版式是**整组垂直居中**（见 {@link DshCenteredPage}），输入框因此落在屏幕中间。
 *
 * <p>三个状态各自成一屏、都带 App 图标：输地址 / 核对指纹 / 证书不符。
 * 分开而不是堆在一页里，是为了避免出现两个同级标题。
 *
 * <p>指纹核对做成一整页而不是弹窗（外壳版是弹窗）：手机上指纹有 32 组，
 * 弹窗里挤成一行根本对不了；整页可以分组换行、放大字号。
 */
@Composable
fun PairScreen(app: Context, onPaired: () -> Unit) {
    val prefs = remember { ServerPrefs(app) }
    var address by remember {
        mutableStateOf(if (prefs.isConfigured()) prefs.host() + ":" + prefs.port() else "")
    }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf("") }
    /** 非空 = 正在等用户核对指纹（首次配对或换了地址）。 */
    var confirmFp by remember { mutableStateOf("") }
    var confirmChanged by remember { mutableStateOf(false) }
    /** 非空 = 同一个地址但证书变了（真正可疑的情况，不自动放行）。 */
    var mismatchFp by remember { mutableStateOf("") }
    /** 探测通过、正在等核对的那次目标（核对的是它，不是输入框当前内容）。 */
    var pendingHost by remember { mutableStateOf("") }
    var pendingPort by remember { mutableStateOf(0) }

    val scope = rememberCoroutineScope()

    val tTitle = stringResource(R.string.pair_title)
    val tIntro = stringResource(R.string.pair_intro)
    val tHint = stringResource(R.string.pair_field_hint)
    val tConnect = stringResource(R.string.pair_connect)
    val tTesting = stringResource(R.string.pair_testing)
    val tErrEmpty = stringResource(R.string.pair_err_empty)
    val tErrFormat = stringResource(R.string.pair_err_format)
    val tErrUnreachable = stringResource(R.string.pair_err_unreachable)
    val tCertTitle = stringResource(R.string.pair_cert_title)
    val tCertIntro = stringResource(R.string.pair_cert_intro)
    val tCertChanged = stringResource(R.string.pair_cert_changed)
    val tCertTrust = stringResource(R.string.pair_cert_trust)
    val tCancel = stringResource(R.string.pair_cert_cancel)
    val tMismatchTitle = stringResource(R.string.pair_mismatch_title)
    val tMismatchIntro = stringResource(R.string.pair_mismatch_intro)
    val tMismatchNow = stringResource(R.string.pair_mismatch_now)
    val tMismatchHint = stringResource(R.string.pair_mismatch_hint)
    val tRepair = stringResource(R.string.action_repair)

    fun attempt() {
        error = ""
        confirmFp = ""
        mismatchFp = ""
        val raw = address
        val parsed = ServerPrefs.normalize(raw)
        if (parsed == null) {
            error = if (raw.trim().isEmpty()) tErrEmpty else tErrFormat
            return
        }
        val host = parsed[0]
        val port = parsed[1].toIntOrNull() ?: run { error = tErrFormat; return }

        busy = true
        scope.launch {
            val probe = withContext(Dispatchers.IO) { Pairing.probe(host, port) }
            busy = false
            if (probe.code <= 0 || probe.fingerprint.isEmpty()) {
                error = tErrUnreachable
                return@launch
            }
            val pinned = prefs.fingerprint()
            val sameTarget = host.equals(prefs.host(), ignoreCase = true) && port == prefs.port()
            when {
                // 尚未建立信任，或换了地址 —— 需要用户核对
                pinned.isEmpty() || !sameTarget -> {
                    pendingHost = host
                    pendingPort = port
                    confirmFp = probe.fingerprint
                    confirmChanged = !sameTarget && pinned.isNotEmpty()
                }
                pinned.equals(probe.fingerprint, ignoreCase = true) -> {
                    prefs.save(host, port)
                    onPaired()
                }
                // 同一个地址，证书换了：不自动放行
                else -> {
                    error = tMismatchTitle
                    mismatchFp = probe.fingerprint
                }
            }
        }
    }

    DshCenteredPage {
        // 图标与标题之间保持 20dp：统一间距已给 12dp，这里再补 8dp
        Box(Modifier.padding(bottom = 8.dp)) { DshAppMark() }

        if (confirmFp.isNotEmpty()) {
            // —— 核对指纹 ——
            DshPageTitle(tCertTitle)
            DshHint(tCertIntro + if (confirmChanged) "\n" + tCertChanged else "", center = true)
            DshFingerprint(confirmFp)
            DshPrimaryButton(tCertTrust) {
                prefs.save(pendingHost, pendingPort)
                prefs.saveFingerprint(confirmFp)
                onPaired()
            }
            DshSecondaryButton(tCancel) {
                confirmFp = ""
                confirmChanged = false
            }
        } else if (mismatchFp.isNotEmpty()) {
            // —— 证书与记录不符 ——
            DshPageTitle(tMismatchTitle)
            DshHint(tMismatchIntro, center = true)
            DshFingerprint(prefs.fingerprint())
            DshHint(tMismatchNow, center = true)
            DshFingerprint(mismatchFp)
            DshHint(tMismatchHint, center = true)
            DshPrimaryButton(tRepair) {
                prefs.saveFingerprint("")
                mismatchFp = ""
                error = ""
                attempt()
            }
            DshSecondaryButton(tCancel) { mismatchFp = "" }
        } else {
            // —— 输地址 ——
            DshPageTitle(tTitle)
            DshHint(tIntro, center = true)
            DshField(address, { address = it }, tHint, enabled = !busy, keyboardType = KeyboardType.Uri)
            if (busy) DshHint(tTesting, center = true)
            DshError(error, center = true)
            DshPrimaryButton(tConnect, enabled = !busy) { attempt() }
        }
    }
}
