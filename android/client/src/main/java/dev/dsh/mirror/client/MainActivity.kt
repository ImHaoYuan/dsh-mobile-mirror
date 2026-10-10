package dev.dsh.mirror.client

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.core.app.ActivityCompat
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import dev.dsh.mirror.ServerPrefs
import dev.dsh.mirror.client.notify.MirrorNotify
import dev.dsh.mirror.client.R
import dev.dsh.mirror.client.net.LoginResult
import dev.dsh.mirror.client.net.CreateResult
import dev.dsh.mirror.client.net.ModelPick
import dev.dsh.mirror.client.net.Models
import dev.dsh.mirror.client.net.MirrorSession
import dev.dsh.mirror.client.net.Sessions
import dev.dsh.mirror.client.theme.Dsh
import dev.dsh.mirror.client.theme.DshFontStore
import dev.dsh.mirror.client.theme.DshFonts
import dev.dsh.mirror.client.theme.DshMirrorTheme
import dev.dsh.mirror.client.ui.AskOverlay
import dev.dsh.mirror.client.ui.ChatScreen
import dev.dsh.mirror.client.ui.ChatTarget
import dev.dsh.mirror.client.ui.QuestionHub
import dev.dsh.mirror.client.prefs.UiPrefs
import dev.dsh.mirror.client.ui.FontPanel
import dev.dsh.mirror.client.ui.HomeScreen
import dev.dsh.mirror.client.ui.LicensePanel
import dev.dsh.mirror.client.ui.LoginScreen
import dev.dsh.mirror.client.ui.ModelHub
import dev.dsh.mirror.client.ui.MorePanel
import dev.dsh.mirror.client.ui.NewSessionPanel
import dev.dsh.mirror.client.ui.PairScreen
import dev.dsh.mirror.client.ui.SessionListScreen
import dev.dsh.mirror.client.vault.SecretVault
import kotlinx.coroutines.launch

/**
 * 原生客户端的入口。
 *
 * <p>四个状态，没有导航库 —— 就四个页面，用不着引 navigation-compose：
 * {@code Boot}（判断该去哪）→ {@code Pair} / {@code Login} / {@code Home}。
 */
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Android 13+ 没这个权限就什么都看不见：前台服务照跑，但通知栏里那条常驻通知
        // 与超级岛都不显示，用户会以为坏了。拒绝了不拦着用 App，只是没有通知与岛；
        // 系统只会真正弹一次，所以每次启动都调也无害。
        requestNotificationPermission()
        setContent {
            // 改字体后 +1，重建整套 Typeface。思源黑体那个文件 17 MB，
            // 绝不能每次重组都重建一遍。
            var fontRev by remember { mutableStateOf(0) }
            val fonts = remember(fontRev) {
                DshFonts.build(applicationContext, DshFontStore.load(applicationContext))
            }
            DshMirrorTheme(fonts) {
                App(onFontsChanged = { fontRev += 1 })
            }
        }
    }
    /**
     * 申请通知权限（Android 13+）。
     *
     * <p>没有它，前台服务照跑，但通知栏里那条常驻通知与超级岛都不显示 ——
     * 用户会以为坏了。拒绝了也不影响 App 本体：只是没有通知与岛。
     */
    private fun requestNotificationPermission() {
        if (Build.VERSION.SDK_INT < 33) return
        val ok = checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
        if (!ok) {
            ActivityCompat.requestPermissions(
                this,
                arrayOf(Manifest.permission.POST_NOTIFICATIONS),
                REQ_NOTIFY,
            )
        }
    }
}

/** 通知权限的请求码，随便定的（没有结果回调要匹配）。 */
private const val REQ_NOTIFY = 1001

private enum class Screen { Boot, Pair, Login, Home }

/**
 * 抽屉里的页面栈（0.6）。
 *
 * <p>0.6 之前「新建会话」「更多」「字体」「开源许可」都是底部弹层，点开时抽屉还开着、
 * 弹层盖在上面。现在全部改成抽屉自己的页面：层级一致，返回键也有了明确的上一层。
 */
private enum class DrawerPage { Sessions, More, Fonts, Licenses, New }

@Composable
private fun App(onFontsChanged: () -> Unit) {
    val app = LocalContext.current.applicationContext
    val prefs = remember { ServerPrefs(app) }
    var screen by remember {
        mutableStateOf(if (prefs.isConfigured()) Screen.Boot else Screen.Pair)
    }
    // 抽屉头部的副标题用账号名（用户指定）。键是 screen：配对/重登之后会重新读一次保险箱。
    val username = remember(screen) { SecretVault.load(app)?.first ?: "" }

    // 0.15：每次回到前台、以及每次进主页（含自动登录那一下），都查一次"有没有东西在跑" ——
    // 有才把 :core 的前台服务拉起来（常驻通知 + 超级岛）。停不用这里管：服务空闲 30 秒自己停。
    LifecycleEventEffect(Lifecycle.Event.ON_START) { MirrorNotify.ensure(app) }
    LaunchedEffect(screen) {
        if (screen == Screen.Home) MirrorNotify.ensure(app)
    }

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
            Screen.Home -> HomeWithDrawer(
                app = app,
                username = username,
                onExpired = { screen = Screen.Login },
                onRepair = { forget(app, prefs); screen = Screen.Pair },
                onFontsChanged = onFontsChanged,
            )
        }
    }
}

/**
 * 首页 + 抽屉（DeepSeek 安卓客户端那种形态，方案 §4.4）。
 *
 * <p>落地的页面是首页（logo + 底部输入区），会话列表住进左侧抽屉：
 * 宽 **71.4% 屏宽**、直角白板、右侧遮罩 **32% 黑**（都是截图实测值）。
 *
 * <p>刷新键与两个面板都由这里持有 —— 首页的输入条和抽屉里的
 * 「＋ 新建会话」指向同一个面板，状态放在共同父级才只有一个实例。
 */
@Composable
private fun HomeWithDrawer(
    app: Context,
    username: String,
    onExpired: () -> Unit,
    onRepair: () -> Unit,
    onFontsChanged: () -> Unit,
) {
    val drawerState = rememberDrawerState(DrawerValue.Closed)
    val scope = rememberCoroutineScope()
    // 抽屉与面板都是「覆盖层」，不该让底下的输入框继续持有焦点 —— 否则输入法不收，
    // 抽屉开着、键盘也开着（用户报的 bug）。所有会盖住首页的动作都先 clearFocus()。
    val focus = LocalFocusManager.current
    var reloadKey by remember { mutableStateOf(0) }
    var page by remember { mutableStateOf(DrawerPage.Sessions) }
    // 开源许可既可以从「更多」进、也可以从「字体」进：返回要回**来的那一层**，不能一律回「更多」
    var licensesFrom by remember { mutableStateOf(DrawerPage.More) }
    val tCreateFail = stringResource(R.string.chat_create_failed)
    // 正在看的那条会话（0.7）：非空就把会话页盖在最上层
    var chat by remember { mutableStateOf<ChatTarget?>(null) }
    // 建会话是异步的，挡住连点（两次点击会建出两条会话）
    var creating by remember { mutableStateOf(false) }
    // 「显示详细工作过程」：设置面板改、会话页读，所以状态放在共同父级
    var detail by remember { mutableStateOf(UiPrefs.detailWork(app)) }
    // 待答提问（0.11）：全局一条流管所有会话 —— 会话列表要角标、会话页要弹卡片。
    // 放在这里是因为首页+抽屉+会话页都活在同一个组合里，实例只有一个。
    val questions = remember { QuestionHub(app) }
    LaunchedEffect(Unit) { questions.connect(scope) }
    LaunchedEffect(questions.expired) { if (questions.expired) onExpired() }

    // 模型 / 模式（0.12）：首页输入条与抽屉里的「新建会话」共用同一份 —— 那时会话还没建，
    // 所以这里是「先记住」，建会话时再带过去。0.12.3 起选择面板就地长在那两处的胶囊行下面
    // （不再是画在根 Box 那一层的全屏卡片），所以这一层只剩状态。
    val modelHub = remember { ModelHub(app) }
    var preModel by remember { mutableStateOf(ModelPick("", "")) }
    var prePreset by remember { mutableStateOf("") }
    LaunchedEffect(Unit) { modelHub.ensure() }
    // 目录到手后把「宿主默认模型」填进去：用户没主动选过，胶囊就不该是空的
    LaunchedEffect(modelHub.catalog) {
        val cat = modelHub.catalog ?: return@LaunchedEffect
        if (preModel.model.isEmpty()) {
            preModel = ModelPick(cat.defaultProvider, cat.defaultModel, cat.defaultEffort)
        }
    }

    // 返回键分层：先回上一层，已经在会话列表那一层才关抽屉
    BackHandler(enabled = drawerState.isOpen) {
        if (page == DrawerPage.Sessions) {
            scope.launch { drawerState.close() }
        } else {
            page = when (page) {
                DrawerPage.Licenses -> licensesFrom
                DrawerPage.Fonts -> DrawerPage.More
                else -> DrawerPage.Sessions
            }
        }
    }

    // 切抽屉页（设置 / 字体 / 许可 / 新建）同样要收键盘：首页的输入框还在底下活着
    LaunchedEffect(page) { focus.clearFocus() }

    // 抽屉一关就复位到会话列表：下次打开还是列表，不会停在半路的设置页
    LaunchedEffect(drawerState.currentValue) {
        if (drawerState.currentValue == DrawerValue.Closed) {
            page = DrawerPage.Sessions
            licensesFrom = DrawerPage.More
        }
    }

    Box(modifier = Modifier.fillMaxSize()) {
        ModalNavigationDrawer(
            drawerState = drawerState,
            scrimColor = Color.Black.copy(alpha = 0.32f),
            drawerContent = {
                ModalDrawerSheet(
                    modifier = Modifier.fillMaxWidth(0.714f),
                    drawerShape = RectangleShape,
                    drawerContainerColor = Dsh.BgPage,
                ) {
                    // 会话列表**一直留在组合里**，面板只是盖在它上面：
                    // 否则每次从设置页返回都会重建列表 —— 重拉一次清单（闪一下「正在读取」）、
                    // 滚动位置也回到顶部。面板自带不透明底色，视觉上没有区别。
                    Box(modifier = Modifier.fillMaxSize()) {
                        SessionListScreen(
                            app = app,
                            username = username,
                            questions = questions,
                            reloadKey = reloadKey,
                            onRefresh = { reloadKey += 1 },
                            onNew = { page = DrawerPage.New },
                            onMore = { page = DrawerPage.More },
                            onExpired = onExpired,
                            onOpenSession = { row ->
                                // 进会话页：抽屉先关上（否则返回时它还开着），会话页盖在最上层
                                focus.clearFocus()
                                // blank 决定「模式能不能改」（0.12 的胶囊要拿它判断锁没锁）
                                chat = ChatTarget(row.id, row.title, row.cwd, row.preset, row.running, blank = row.blank)
                                scope.launch { drawerState.close() }
                            },
                        )

                        when (page) {
                            DrawerPage.Sessions -> Unit

                            DrawerPage.More -> MorePanel(
                                detail = detail,
                                onDetail = {
                                    detail = it
                                    UiPrefs.setDetailWork(app, it)
                                },
                                onBack = { page = DrawerPage.Sessions },
                                onFonts = { page = DrawerPage.Fonts },
                                onLicenses = {
                                    licensesFrom = DrawerPage.More
                                    page = DrawerPage.Licenses
                                },
                                onRepair = {
                                    page = DrawerPage.Sessions
                                    onRepair()
                                },
                            )

                            DrawerPage.Fonts -> {
                                // 每次打开都重新读一次设置：面板里改完立刻落盘，重开就是最新值
                                val initial = remember { DshFontStore.load(app) }
                                FontPanel(
                                    app = app,
                                    initial = initial,
                                    onChanged = {
                                        DshFontStore.save(app, it)
                                        onFontsChanged()
                                    },
                                    onBack = { page = DrawerPage.More },
                                    onLicenses = {
                                        licensesFrom = DrawerPage.Fonts
                                        page = DrawerPage.Licenses
                                    },
                                )
                            }

                            DrawerPage.Licenses -> LicensePanel(onBack = { page = licensesFrom })

                            DrawerPage.New -> NewSessionPanel(
                                app = app,
                                hub = modelHub,
                                pickModel = preModel,
                                presetId = prePreset,
                                onPickModel = { p -> preModel = p; null },
                                onPreset = { id -> prePreset = id; null },
                                onBack = { page = DrawerPage.Sessions },
                                // 建完**直接进那个会话**（0.12.1）。以前只 toast + 回列表，
                                // 看着像"点了没反应" —— 用户连点了 4 次，17 秒里建了 4 个空白会话。
                                onCreated = { newId, newCwd ->
                                    page = DrawerPage.Sessions
                                    chat = ChatTarget(
                                        id = newId,
                                        // 空标题：会话页顶栏会退回显示目录名，等宿主的标题投影到了再换
                                        title = "",
                                        cwd = newCwd,
                                        preset = prePreset.ifEmpty { null },
                                        running = false,
                                        blank = true,
                                    )
                                    reloadKey += 1
                                },
                                onExpired = {
                                    page = DrawerPage.Sessions
                                    onExpired()
                                },
                            )
                        }
                    }
                }
            },
        ) {
            HomeScreen(
                app = app,
                hub = modelHub,
                pickModel = preModel,
                presetId = prePreset,
                onPickModel = { p -> preModel = p; null },
                onPreset = { id -> prePreset = id; null },
                // 先收键盘再开抽屉：ModalNavigationDrawer 不会自己夺焦，输入框不收焦点输入法就不走
                onOpenDrawer = {
                    focus.clearFocus()
                    scope.launch { drawerState.open() }
                },
                // 真发第一步：建会话（宿主 /api/session **不吃 prompt**，所以必须两步）。
                // 拿到 id 后进会话页，并把这句话当 initialPrompt 交给它 —— 会话页拿到第一帧快照后再发，
                // 这样乐观回显与宿主的权威回显落在同一个地方。
                onSend = { text, workspaceId, cwd, preset, pick ->
                    if (!creating) {
                        creating = true
                        scope.launch {
                            when (val r = Sessions.create(app, workspaceId, cwd, preset)) {
                                is CreateResult.Ok -> {
                                    // 建完立刻定模型（`/api/session` 不吃模型）。失败就不管：
                                    // 会话页那枚胶囊显示的是宿主实际在用的模型，用户一眼能看出没生效。
                                    if (pick.model.isNotEmpty()) Models.select(app, r.sessionId, pick)
                                    chat = ChatTarget(r.sessionId, text, cwd, preset, true, text)
                                    reloadKey += 1
                                }
                                is CreateResult.Rejected ->
                                    Toast.makeText(app, tCreateFail + "：" + r.message, Toast.LENGTH_LONG).show()
                                CreateResult.Expired -> onExpired()
                                CreateResult.Unreachable ->
                                    Toast.makeText(app, tCreateFail, Toast.LENGTH_LONG).show()
                            }
                            creating = false
                        }
                    }
                },
            )
        }

        // 会话页盖在首页与抽屉**之上**（不是替换）：首页与抽屉保持组合，
        // 从会话页返回时列表不会重拉、滚动位置也不丢。
        chat?.let { open ->
            ChatScreen(
                app = app,
                target = open,
                hub = modelHub,
                detail = detail,
                onBack = { chat = null },
                onExpired = {
                    chat = null
                    onExpired()
                },
            )
            // 提问卡盖在会话页**之上**（Box 里后画的就是上层），所以它内部那个
            // fillMaxSize 能连输入框一起罩住；没有待答提问时它不画遮罩、也不吃点击。
            AskOverlay(hub = questions, sessionId = open.id)
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
