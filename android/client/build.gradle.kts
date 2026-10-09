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
        // 版本号慢慢递增：M0 = 0.1，M1 = 0.2（界面调整 0.2.1 / 0.2.2），M2 = 0.3
        versionCode = 5
        versionName = "0.3"

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
}
