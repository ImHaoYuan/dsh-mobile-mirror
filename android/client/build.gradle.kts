// 原生 Compose 客户端。与 :app（WebView 外壳）并存安装，是同一份 HTTP/SSE 协议
// 的第二个客户端 —— lib/web/* 与宿主 lib/*.js 都不需要改。见 docs/client-plan.md。
//
// 依赖版本刻意钉死为本机 Gradle 缓存里已有的那套（Kotlin 2.0.21 / Compose 1.7.3 /
// material3 1.3.0），免得构建依赖 plugins.gradle.org 的连通性。
plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    // 包名不能含 `native`（Java 关键字），模块名、目录、包名统一都用 client。
    namespace = "dsh.mirror.client"
    compileSdk = 36

    defaultConfig {
        applicationId = "dsh.mirror.client"
        minSdk = 29          // 与外壳一致：指纹固定要用 SslCertificate.getX509Certificate()（API 29）
        // targetSdk 与外壳一致停在 34：35+ 强制 edge-to-edge，Compose 也要自己处理 inset。
        targetSdk = 34
        // 版本号慢慢递增：M0 = 0.1，M1 = 0.2（界面调整 0.2.1 / 0.2.2），M2 = 0.3，
        // 首页+抽屉 = 0.4，字体 = 0.5，抽屉四级页 + 首页真输入框 = 0.6（修版 0.6.1、0.6.2）
        // 会话页只读 = 0.7（修版 0.7.1：刷新图标箭头压住圆环）
        // 发送 / 停止 + 乐观回显 = 0.8
        // Markdown 渲染与网页端逐条一致 = 0.9（修版 0.9.1：会话页贴底跟随）
        // 修版 0.9.2：表格重写（列对齐 / 只画横线 / 空表头不画）+ 本地文件蓝色芯片
        // 0.10：文件下载（点文件芯片先问再下，存系统「下载」目录）
        // 修版 0.10.1：电脑端的「文件」卡（deliverables/presented）+ 详细工作过程开关真正生效
        // 修版 0.10.2：假粗体字面 + 文件卡挪到一轮末尾 + throughSeq 翻页参数（这一版的字体是错的）
        // 0.10.3：删掉假粗体，正文改可变字体真 400/700；翻页超时与参数修复；输入法收起；长按选中
        // 修版 0.10.4：去掉自加的长按「复制整条消息」—— 它和系统选择弹层打架、还让选择工具条点不掉
        // 0.11：提问卡（M5 第一块）—— 底部弹出的卡片 + /api/questions/stream + hold 认领
        // 0.12：模型 / 模式胶囊（输入条上方两颗 + 遮罩贴底卡片）
        // 修版 0.12.1：JSON null 显示成字面 null / 目录没剥壳 / 档位键找错；长按删除空白会话；建会话直接进会话
        // 修版 0.12.2：首页把「选择新的文件夹」并进文件夹清单；胶囊移到输入框上方
        // 0.12.3：三颗胶囊并排（模型 / 模式 / 文件夹）+ 统一成全圆胶囊；模型与模式拆成两块
        //         **就地展开**的面板（不再遮罩 + 贴底卡片），会话页与抽屉「新建会话」一起改
        // 0.13：工作过程「完整」折叠 —— 思考存正文（不再是「思考 N 字」），卡片里给它
        //       40% 窗口高的滚动区；件数把思考也算一件（对齐网页端的「N 项」）
        // 0.14：「已发消息」清单（顶栏入口 + 就地展开的面板，点一条跳过去）+ 右下角
        //       「↑ 上一句」兜底浮键 —— 替掉网页端那条右侧刻度条（会跟返回手势打架）
        // 修版 0.14.1：① 相邻「工作过程」卡合成一张（一轮一卡，run_code 步骤一条不少）
        //       ② 翻页失败不再自动重发，顶部改成可点的「点这里重试」并显示等了多久，
        //          读取超时 30 → 90 秒；③ 「我的话」改名「已发消息」
        // 0.15（M6）：把前台服务 + 常驻通知 + 超级岛接进原生客户端（复用 :core）。
        //       **按需**：登录/回前台查一次，有会话在跑或有问题在等才起；空闲 30 秒自己停
        //       （用户选的 A：没会话 = 完全停，连常驻通知一起消失）。
        //       另发第二条「会话提醒」通知：提问带题面、跑完报完成，走 HIGH 渠道会响会弹。
        //       release 同时打开 R8 与资源压缩；外壳行为不变，但 :core 变了 → 另出 1.1.2。
        // 修版 0.15.1：① 焦点收口（用户报：点会话输入框、字却进了首页那个看不见的输入框）
        //       —— 进会话自动聚焦 + 抽屉一开就收焦点（含手势开抽屉）+ 新建会话面板补 clearFocus
        //       + 会话页面板收键盘 + 首页输入框被盖住时不准拿焦点；
        //       ② 岛的进度环：运行中 50%，报错/询问/完成 100%（以前恒为 100，只会变色）；
        //       ③ 设置面板加「检测通知」：当场验证通知权限与「会话提醒」渠道。
        //       :core 变了 → 外壳跟随出 1.1.3（岛的行为按用户要求变了，不再逐字节等价）。
        // 修版 0.15.2：emoji 兜底（用户报：消息里的 ✅ 在手机上是一片黑色马赛克）。
        //       根因：chainOf() 用 CustomFallbackBuilder，只 setSystemFallback("sans-serif")，
        //       而彩色 emoji 是系统里**单独一个族**，这样拿不到 → 缺字形。
        //       改法：从 SystemFonts.getAvailableFonts()（API 29+）里挑 familyName 含 "emoji"
        //       的族当 custom fallback —— 0 MB、不下载、不涉许可；找不到就照旧（不崩）。
        //       只动 :client → **外壳不用重出**。
        // 修版 0.15.3：修「后台回来不刷新」（用户报：会话页放后台 → 通知弹出 → 回来，
        //       ① 落库正文的 Markdown 不出现、② 文件卡不挂、③ 没有「正在重连」、④ 重进才好、
        //       ⑤ 只有长消息中招）。根因：Follow.stream 是 callbackFlow + trySend 且没配
        //       .buffer(…)：默认只有 64 槽，**trySend 满了静默丢帧**；消费者是主线程，
        //       长消息流式排版一重就丢后面那些帧（落库正文 / deliverables/presented / turn/end）。
        //       改：① Follow 加 .buffer(Channel.UNLIMITED)（channelFlow 会与 buffer 融合）—— 治本；
        //       ② ChatModel.resync() + ChatScreen ON_START 重新同步 —— 兜底（= 自动"退出重进"）；
        //       ③ 新增 FramePumpTest 两条 A/B 单测钉住这个机制。
        //       只动 :client → 外壳不用重出。
        // 修版 0.15.4：抽屉里「检测通知」原先是一行裸文字、看不出是按钮，「详细模式」也一样。
        //       两处都改成和其他按钮同款（1dp l4 描边 + 圆角 12 + 高 44）：说明文字挪到按钮上方
        //       走 PanelNote（与「修复」那条一致），详细模式用新增的 DshSecondarySwitch。
        //       纯 :client 改动 → 外壳不用重出。
        // 修版 0.15.5：① 抽屉里那个发测试通知的按钮在 0.15.4 里**误传了面板标题**（more_title =
        //       「设置」），所以按钮上显示成了「设置」——改成传 more_notify_test 并改名为「检验通知权限」；
        //       同时把说明文字从控件上面挪到**下面**（检测通知 / 详细模式 / 重新配对 三条）。
        //       ② 主页刷新出"有会话在跑 / 等回答"时直接 MirrorNotify.start 把 :core 监测服务拉起：
        //       原先只有回前台与进主页那一下会 ensure（查到有才起），停在主页时服务往往没起，
        //       电脑上新开会话时点刷新也不出岛。
        //       纯 :client 改动 → 外壳不用重出。
        // 修版 0.15.6：文件卡挂错位置（用户 2026-10-10 真机报：同一条回复在电脑端卡片挂在最下面，
        //       手机端不是）。根因不是"没下发"，是**挂点**：present 带来的文件原本挂在
        //       "present 之后的第一条助手消息"下面，而那一轮 present 完我还在继续干活
        //       （补记忆、写总结），所以卡片落在中途，后面两条正文全跑到它下面去了。
        //       实测本会话日志：35 次 present 里 34 次天然落在该轮最后一条助手消息（看着正常），
        //       只有那一轮落在中途。改：**唯一挂点改成 turn/end**，语义与电脑端一致。
        //       纯 :client 改动 → 外壳不用重出。
        // 修版 0.15.7：① **App 在前台时不弹岛、也不发第二条提醒**（用户要求"在 app 内就不弹"）——
        //       :core 加进程级静态 appVisible（客户端 ON_START/ON_STOP 上报；外壳不调 = 老行为），
        //       前台时 buildNotification() 不挂岛参数、alert() 提前 return 且**不动 lastAlertKey**
        //       （切回后台后同样的状态还能再提醒一次）。
        //       ② **点通知 / 点岛跳到对应会话** —— :core 新增 EXTRA_SESSION_ID，
        //       PendingIntent 请求码按 (用途, 会话) 生成（filterEquals 不比 extras，
        //       同一个请求码会让后一条通知偷走前一条的会话）；IslandMonitor.Snapshot 补 sessionId
        //       （提问 / 运行 / 完成三条通知各自带对）；客户端 singleTop + onCreate/onNewIntent
        //       读 extra → 进主页后再开会话页（Boot/Login 期间挂起）。
        //       ③ 修 emoji「✅ 又变回黑色马赛克」：挑 emoji 字体时按**彩色优先**排序
        //       （黑白老字体 NotoEmoji-Regular.ttf 名字里也含 "moji"，而 SystemFonts 顺序不保证），
        //       再加一层直接扫 /system/fonts 的兜底；字体面板临时加一行自证（诊断完就删）。
        //       :core 变了 → **外壳必须重出 1.1.4**（:app 源码未动，靠 extra 默认值保证行为不变）。
        // 修版 0.15.8：① 修「0.15.7 之后超级岛彻底不显示」（用户报）—— 前台时重发出去的通知
        //       不带岛参数，而通知只在"岛状态跳变"时重发，退到后台若没有新的跳变就再没有
        //       一次重发，岛挂不上去；反向也一样（后台挂着岛，回到 App 收不回来）。
        //       改法：可见性一变就自己补一次重发。② 侧栏彻底不显示子智能体。
        //       ③ 删掉 0.15.7 那行 emoji 自证行（用户真机确认 ✅ 已正常）。
        //       :core 变了 → 外壳跟随出 1.1.5（外壳不调 setAppVisible，行为与 1.1.4 一致）。
        // 1.0：版本号从这一版起改用「正式版」口径（不再跟 0.x 的小步快跑走）。三件事一起做：
        //   ① **包名去掉 dev**：dev.dsh.mirror.client → dsh.mirror.client，应用名改「DSH镜像」。
        //      注意这是**换了一个 App**：新包名与旧包不能共存（抽屉里会并排两个），旧包要手动卸载，
        //      配对/登录状态存在旧包名下、会一起丢（要重新配对一次）。:core 也一起去了 dev
        //      （共用层 → dsh.mirror，namespace dsh.mirror.core），三个 extra 键同步改；
        //      **外壳因此必须重出 1.1.6**。
        //   ② 主页输入框从「死高度 52dp + singleLine」改成与聊天页输入框同一套：最低 52dp、
        //      最多 5 行、120dp 封顶后框内自滚（用户报的"字紧跟字后面、不换行不扩容"）。
        //   ③ 网页端补「文件卡 + 下载」（原生早就有）—— 那条在网页侧实现，本模块不动。
        versionCode = 40
        versionName = "1.0"

        // app_name 与外壳一样用 resValue 注入，避免与 strings.xml 重复定义。
        // 1.0：应用名与外壳统一成「DSH镜像」（不带空格，用户明确要求）。
        resValue("string", "app_name", "DSH镜像")
    }

    buildTypes {
        debug { isMinifyEnabled = false }
        release {
            // 0.15 起打开 R8：摇树 + 改名 + 优化。字体那 20 MB 压不动（在 res/font 里且被
            // noCompress 排除），这一刀砍的是代码与其余资源，预期 42 MB → 20 MB 上下。
            // **必须装机验证**：R8 的坑全在运行时，构建永远成功。
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
            signingConfig = signingConfigs.getByName("debug")   // 自用，release 也走 debug 签名
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        compose = true
    }

    // 内置字体（20.24 MB）刻意**不压缩**：android.graphics.fonts.Font.Builder 先试 fd，
    // 压缩条目拿不到 fd，就只能退化成「整份读进内存」—— 思源黑体那 17 MB 会变成一份
    // 18 MB 的常驻 ByteBuffer。不压缩就能 mmap，零堆占用。代价是 APK 大 6.8 MB。
    androidResources {
        noCompress.addAll(listOf("ttf", "otf"))
    }

    // 单测用 JUnit 5。5.10.2 全套（jupiter + platform）**本机 Gradle 缓存里都有**，
    // 所以配好了也不需要联网 —— 与这个模块"依赖只用缓存里那套"的原则一致。
    testOptions {
        unitTests.all { it.useJUnitPlatform() }
    }
}

dependencies {
    // 平台层（证书固定 / 地址 / 原生 HTTP / 前台服务 / 超级岛）与外壳共用。
    implementation(project(":core"))

    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.activity:activity-compose:1.9.2")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.6")
    implementation("androidx.compose.ui:ui:1.7.3")
    implementation("androidx.compose.foundation:foundation:1.7.3")
    implementation("androidx.compose.material3:material3:1.3.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")

    // Markdown 解析器的行为契约测试（断言搬自网页端 tools/web-pure-test.cjs）。
    testImplementation("org.junit.jupiter:junit-jupiter:5.10.2")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher:1.10.2")
}
