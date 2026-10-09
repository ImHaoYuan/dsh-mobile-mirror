package dev.dsh.mirror.client

import android.content.Context
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.sp
import dev.dsh.mirror.ServerPrefs
import dev.dsh.mirror.client.R
import dev.dsh.mirror.client.net.LoginResult
import dev.dsh.mirror.client.net.MirrorSession
import dev.dsh.mirror.client.theme.Dsh
import dev.dsh.mirror.client.theme.DshMirrorTheme
import dev.dsh.mirror.client.ui.LoginScreen
import dev.dsh.mirror.client.ui.PairScreen
import dev.dsh.mirror.client.ui.SessionListScreen
import dev.dsh.mirror.client.vault.SecretVault

/**
 * 原生客户端的入口。
 *
 * <p>四个状态，没有导航库 —— 就四个页面，用不着引 navigation-compose：
 * {@code Boot}（判断该去哪）→ {@code Pair} / {@code Login} / {@code Home}。
 */
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            DshMirrorTheme {
                App()
            }
        }
    }
}

private enum class Screen { Boot, Pair, Login, Home }

@Composable
private fun App() {
    val app = LocalContext.current.applicationContext
    val prefs = remember { ServerPrefs(app) }
    var screen by remember {
        mutableStateOf(if (prefs.isConfigured()) Screen.Boot else Screen.Pair)
    }
    // 顶栏副标题用账号名（用户指定）。键是 screen：配对/重登之后会重新读一次保险箱。
    val username = remember(screen) { SecretVault.load(app)?.first ?: "" }

    // 键是 screen：配对完回到 Boot 时会重新跑一遍引导
    LaunchedEffect(screen) {
        if (screen != Screen.Boot) return@LaunchedEffect
        // 手里有票根就直接进主页（票根过期的话主页会退回登录页）
        if (prefs.cookie().isNotEmpty()) {
            screen = Screen.Home
            return@LaunchedEffect
        }
        // 没票根：用保险箱里的凭据自动登一次，省掉一次手打
        val cred = SecretVault.load(app)
        screen = if (cred != null && MirrorSession.login(app, cred.first, cred.second) == LoginResult.Ok) {
            Screen.Home
        } else {
            Screen.Login
        }
    }

    Surface(color = Dsh.BgPage, modifier = Modifier.fillMaxSize()) {
        when (screen) {
            Screen.Boot -> BootScreen()
            Screen.Pair -> PairScreen(app) { screen = Screen.Boot }
            Screen.Login -> LoginScreen(
                app,
                onLoggedIn = { screen = Screen.Home },
                onRepair = { forget(app, prefs); screen = Screen.Pair },
            )
            Screen.Home -> SessionListScreen(
                app = app,
                username = username,
                onExpired = { screen = Screen.Login },
                onRepair = { forget(app, prefs); screen = Screen.Pair },
                onOpenSession = {
                    // M2 的边界：会话页是 M3。这里说清楚，不假装能进去。
                    Toast.makeText(app, app.getString(R.string.list_chat_later), Toast.LENGTH_SHORT).show()
                },
            )
        }
    }
}

/** 重新配对 = 忘掉地址、指纹、票根与保存的密码。 */
private fun forget(app: Context, prefs: ServerPrefs) {
    prefs.clear()
    SecretVault.clear(app)
}

@Composable
private fun BootScreen() {
    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Text(
            stringResource(R.string.boot_checking),
            fontSize = 14.sp,
            color = Dsh.LabelSecondary,
        )
    }
}
