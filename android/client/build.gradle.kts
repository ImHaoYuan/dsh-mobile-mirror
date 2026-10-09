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
    namespace = "dev.dsh.mirror.client"
    compileSdk = 36

    defaultConfig {
        applicationId = "dev.dsh.mirror.client"
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
        versionCode = 27
        versionName = "0.12.3"

        // app_name 与外壳一样用 resValue 注入，避免与 strings.xml 重复定义。
        resValue("string", "app_name", "DSH镜像原生")
    }

    buildTypes {
        debug { isMinifyEnabled = false }
        release {
            isMinifyEnabled = false
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
