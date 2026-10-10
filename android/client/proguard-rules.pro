# R8 规则（0.15 起 release 打开压缩与资源压缩）。
#
# 为什么几乎不需要 keep：本 App 的代码全部从 MainActivity 可达，而且**没有任何反射**
# （没有 Class.forName / getDeclaredMethod / resources.getIdentifier）。内置字体虽然是从
# 代码按 id 取的，但用的是 `R.font.*` 常量而不是按名字查表，所以资源压缩也认得它们 ——
# 不必写 keep.xml。
#
# 下面两条是"保命"用的，代价可以忽略。

# 崩溃栈里保留源文件名与行号：release 包出问题时还能自己对上代码
-keepattributes SourceFile,LineNumberTable

# 入口 Activity 由清单引用，AGP 本来就会保；显式再写一遍，免得以后有人改配置时踩空
-keep class dev.dsh.mirror.client.MainActivity { *; }
