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
        versionCode = 8
        versionName = "1.1"

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
