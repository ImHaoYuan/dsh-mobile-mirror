// 只声明插件，不 apply —— 由各模块自己 apply。
// 版本坐标取已验证可用的组合（AGP 8.5.2 + Gradle 8.9 + Kotlin 2.0.21）。
plugins {
    id("com.android.application") version "8.5.2" apply false
    id("com.android.library") version "8.5.2" apply false
    id("org.jetbrains.kotlin.android") version "2.0.21" apply false
    // Kotlin 2.0 起 Compose 编译器随 Kotlin 版本走，用这个插件而不是旧的 composeOptions。
    id("org.jetbrains.kotlin.plugin.compose") version "2.0.21" apply false
}
