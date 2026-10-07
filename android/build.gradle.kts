// 只有 AGP 一个插件，且 apply false —— 由 :app 模块自己 apply。
// 版本坐标取已验证可用的组合（AGP 8.5.2 + Gradle 8.9）。
plugins {
    id("com.android.application") version "8.5.2" apply false
}
