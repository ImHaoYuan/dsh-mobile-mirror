package dsh.mirror.client.ui

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
import dsh.mirror.client.R
import dsh.mirror.client.net.LoginResult
import dsh.mirror.client.net.MirrorSession
import dsh.mirror.client.vault.SecretVault
import kotlinx.coroutines.launch

/**
 * 登录页：版式与配对页一致 —— **整组垂直居中**，顶部带 App 图标，
 * 账号密码框落在屏幕中间。
 *
 * <p>账号密码从保险箱预填（有的话）—— 大多数情况下来到这里是因为会话过期，
 * 而凭据已经在手，点一下就行。
 */
@Composable
fun LoginScreen(app: Context, onLoggedIn: () -> Unit, onRepair: () -> Unit) {
    val saved = remember { SecretVault.load(app) }
    var user by remember { mutableStateOf(saved?.first ?: "") }
    var pass by remember { mutableStateOf(saved?.second ?: "") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf("") }

    val scope = rememberCoroutineScope()

    val tTitle = stringResource(R.string.login_title)
    val tUser = stringResource(R.string.login_user)
    val tPass = stringResource(R.string.login_pass)
    val tSubmit = stringResource(R.string.login_submit)
    val tBusy = stringResource(R.string.login_busy)
    val tBad = stringResource(R.string.login_err_bad)
    val tLockedFmt = stringResource(R.string.login_err_locked)
    val tMissing = stringResource(R.string.login_err_missing)
    val tUnconfigured = stringResource(R.string.login_err_unconfigured)
    val tUnreachable = stringResource(R.string.login_err_unreachable)
    val tSavedHint = stringResource(R.string.login_saved_hint)
    val tRepair = stringResource(R.string.action_repair)

    fun submit() {
        if (user.isBlank() || pass.isEmpty()) {
            error = tMissing
            return
        }
        error = ""
        busy = true
        scope.launch {
            val r = MirrorSession.login(app, user.trim(), pass)
            busy = false
            when (r) {
                LoginResult.Ok -> onLoggedIn()
                LoginResult.BadCredentials -> error = tBad
                is LoginResult.Locked -> error = tLockedFmt.format(r.seconds)
                LoginResult.Missing -> error = tMissing
                LoginResult.Unconfigured -> error = tUnconfigured
                LoginResult.Unreachable -> error = tUnreachable
            }
        }
    }

    DshCenteredPage {
        // 图标与标题之间保持 20dp：统一间距已给 12dp，这里再补 8dp
        Box(Modifier.padding(bottom = 8.dp)) { DshAppMark() }
        DshPageTitle(tTitle)
        if (saved != null) DshHint(tSavedHint, center = true)

        DshField(user, { user = it }, tUser, enabled = !busy)
        DshField(pass, { pass = it }, tPass, enabled = !busy, password = true,
            keyboardType = KeyboardType.Password)

        if (busy) DshHint(tBusy, center = true)
        DshError(error, center = true)

        DshPrimaryButton(tSubmit, enabled = !busy) { submit() }
        DshSecondaryButton(tRepair, enabled = !busy) { onRepair() }
    }
}
