plugins {
    id("com.android.application")
}

android {
    namespace = "dev.dsh.mirror"
    compileSdk = 36

    defaultConfig {
        applicationId = "dev.dsh.mirror"
        minSdk = 29          // Android 10+。指纹固定要用 SslCertificate.getX509Certificate()（API 29）
        // targetSdk 故意停在 34，不跟 compileSdk 一起上 36：
        // 35+ 会强制 edge-to-edge，WebView 会画到状态栏底下。而 WebView 是否上报
        // env(safe-area-inset-*) 并不可靠 —— 不上报的话页面顶栏会被状态栏压住。
        // 停在 34 时系统按常规方式施加 inset，页面完整可见，行为可预测。
        // 我们要用的 API 全部 ≤ 34（POST_NOTIFICATIONS=33、FOREGROUND_SERVICE_DATA_SYNC=34、
        // startForeground(id,notif,type)=29、SslCertificate.getX509Certificate()=29）。
        targetSdk = 34

        // versionCode 必须单调递增：同版本重装系统允许，降级会被拒绝，
        // 而"版本号没涨"会让升级判断失真。
        //
        // 版本沿革：
        //   0.1.1 定位静默失败 → 0.1.2 确认必须给全字段 JSON → 0.1.3 定下外观配方
        //   → 0.1.4 接进 MirrorService（状态绑定）→ 0.1.5 岛上显示会话标题
        //   → 1.0 超级岛第 2 步收官 → **1.1 清掉验证脚手架、准备开源发布**
        //   → **1.1.1 跟随 :core 重建**：平台层多了「按请求指定读取超时」的重载（供原生客户端翻页），
        //     外壳行为与 1.1 完全一致，只是 dex 变了，所以跟着出一版。
        //   → **1.1.2 跟随 :core 重建**（0.15/M6）：:core 的前台服务多了「按需模式」（extra
        //     onDemand：没会话空闲 30 秒自停）与第二条「会话提醒」通知。**外壳不传这个 extra**
        //     —— 常驻、START_STICKY、只发原来那一条，行为与 1.1.1 完全一致，同样只是 dex 变了。
        //   → **1.1.3 跟随 :core 重建**（0.15.1）：:core 多了「运行中进度环 50%」，
        //     并加了给原生客户端设置面板用的 notifyTest()。**这一版岛的行为确实变了**
        //     （以前 progress 恒为 100%，现在运行中显示 50%），不再是"只有 dex 变"。
        // 1.1.4：**只为跟随 :core**（外壳源码一行未改）。
        // 0.15.7 给共用层加了：appVisible（前台不弹岛/不提醒）、EXTRA_SESSION_ID（点通知进会话）。
        // 外壳既不调 setAppVisible、也不读 sessionId extra ⇒ 点通知仍是"只打开 App"，
        // 前台仍照旧弹岛 —— 行为与 1.1.3 完全一致，变的只是字节。
        versionCode = 12
        versionName = "1.1.4"

        // app_name 刻意**不**写在 strings.xml 里 —— 那里写会和这里的 resValue 冲突
        // （重复资源，aapt2 直接报错）。manifest 的 android:label 引用它。
        resValue("string", "app_name", "DSH 镜像")
    }

    buildTypes {
        debug {
            isMinifyEnabled = false
        }
        release {
            isMinifyEnabled = false
            // 自用，不发布 —— release 也用 debug 签名，免去保管密钥
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    // 只依赖本仓库自己的 :core —— 仍然零第三方依赖。
    // 共享的是平台层（证书固定 / 地址 / 原生 HTTP / 前台服务 / 超级岛），界面仍全在网页侧。
    implementation(project(":core"))
}
