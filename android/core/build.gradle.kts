// 两个客户端共用的平台层。刻意保持**零第三方依赖** —— 只用 Android 框架 API，
// 与界面（WebView 还是 Compose）完全无关。搬进来的都是原本就在 app 里、
// 且不依赖任何 Activity / layout 的类。
plugins {
    id("com.android.library")
}

android {
    namespace = "dev.dsh.mirror.core"
    compileSdk = 36

    defaultConfig {
        minSdk = 29
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

// 刻意不写 dependencies {} —— 本模块零第三方依赖。
