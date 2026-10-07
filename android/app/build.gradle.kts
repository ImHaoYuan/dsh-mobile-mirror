plugins {
    id("com.android.application")
}

// ---------------------------------------------------------------------------
// 超级岛验证变体
//
// 用法：gradlew assembleDebug -Pvariant=C   →  app-debug.apk，versionName 1.0-C
//
// 一次做三个变体（C / D / E），让用户"改一次 → 装一次 → 看一眼"的循环只走一趟。
// 变体标记通过两条路暴露出来，避免装错：
//   ① versionName 后缀（应用信息里能看到）
//   ② App 名称后缀（桌面图标下面就能看到）
//
// 三个变体共用同一个 applicationId，所以是**覆盖安装**：主机地址、端口、证书指纹
// 这些配置只填一次就一直在。versionCode 三个都相同，因此任意顺序覆盖安装都成立
// （同版本重装被允许，降级才会被系统拒绝）。
// ---------------------------------------------------------------------------
val variant = (project.findProperty("variant") as String?)?.trim()?.uppercase().orEmpty()
val variantSuffix = if (variant.isEmpty()) "" else "-$variant"

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
        versionCode = 7
        // 版本号方案（用户定的）：0.<基本功能实现>.<当前阶段>
        //   0.1.1 定位静默失败 → 0.1.2 确认必须给全字段 JSON → 0.1.3 定下外观配方
        //   → 0.1.4 接进 MirrorService（状态绑定）→ 0.1.5 岛上显示会话标题
        //   → **1.0**：超级岛第 2 步收官，版本号进位（用户定的）
        // versionCode 必须单调递增：同版本重装系统允许，降级会被拒绝，
        // 而"版本号没涨"会让升级判断失真。
        versionName = "1.0$variantSuffix"

        // app_name 刻意**不**写在 strings.xml 里 —— 那里写会和这里的 resValue 冲突
        // （重复资源，aapt2 直接报错）。manifest 的 android:label 引用它。
        resValue("string", "app_name",
            if (variant.isEmpty()) "DSH 镜像" else "DSH 镜像 $variant")
        // 空字符串 = 普通构建（三个变体按钮都不发，只显示说明）
        resValue("string", "variant_id", variant)
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

// 刻意不写 dependencies {} —— 本模块零第三方依赖。
// WebView、通知、前台服务、HTTPS 全部走 Android 原生 API。
