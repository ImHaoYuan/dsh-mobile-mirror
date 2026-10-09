pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "dsh-mobile-mirror"

// :app    —— WebView 外壳（纯 Java，零第三方依赖）
// :core   —— 两个客户端共用的平台层（证书固定 / 地址 / 原生 HTTP / 前台服务 / 超级岛）
// :client —— 原生 Compose 客户端（Kotlin，见 docs/client-plan.md）
include(":app")
include(":core")
include(":client")
