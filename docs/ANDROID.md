# Dearvale Android 应用

Dearvale Android 将当前 `apps/web` 的正式构建内置到 APK，以 iPhone Pro 纵向比例为设计参考，并适配 Android 的实际屏幕、安全区域和键盘。原生连接页负责选择电脑或私人服务器；对话、角色、模型调用、SQLite 与后台任务运行在该服务中。**手机使用时需要服务保持运行，APK 不包含 Node.js 后端，也不提供离线模型对话。**

应用信息：包名 `app.dearvale.mobile`，版本 `0.1.2`（`versionCode 3`），最低 Android 8.0 / API 26，目标 API 35。没有原生 CPU 架构依赖，可安装到常见 ARM 与 x86 Android 设备。release 构建使用发布者自己的签名密钥；签名材料不随源码分发，Google Play 发布需另行配置。

0.1.2 的记忆档案室按 402 × 874 逻辑尺寸重新排布：两行筛选、可横向滑动的书脊、全屏抽书和单页阅读。手机上一页／下一页直接切换，不使用桌面的双页翻转动画；正文、分页和安全边距按设备实际可用尺寸适配。桌面继续保持双页阅读。

## 安装与连接

构建产物为 `artifacts/android/Dearvale-0.1.2.apk`。将 APK 传到手机，使用系统安装器安装，并在系统提示时允许当前文件来源安装应用。用 USB 调试安装可运行：

```powershell
adb install -r artifacts/android/Dearvale-0.1.2.apk
```

首次打开填写 **Dearvale 服务根地址**，例如 `https://dearvale.example.com` 或电脑终端显示的 `http://192.168.x.x:3000`。不要填写模型供应商地址、`/api` 路径或用户名密码到 URL 内。账号和密码使用服务的访问凭据；它们与模型 API Key 不同。

| 连接方式         | 电脑 / 服务器操作                                            | APK 中填写                                                  |
| ---------------- | ------------------------------------------------------------ | ----------------------------------------------------------- |
| 同一可信 Wi-Fi   | 在仓库运行 `pnpm mobile:serve`，保持终端运行                 | 终端显示的地址、账号 `mobile`、本次随机密码；勾选 HTTP 确认 |
| HTTPS 私人服务器 | 按 [自托管指南](SELF_HOSTING.md)部署带 Basic Auth 的独立实例 | HTTPS 根地址与该实例访问账号、密码                          |
| USB 本机调试     | 启动后端，并运行 `adb reverse tcp:3001 tcp:3001`             | `http://127.0.0.1:3001`；默认本地后端无需账号密码           |

电脑无线连接的防火墙、实例数据和启动参数详见 [手机连接电脑](MOBILE-SERVER.md)。HTTP 没有加密，仅用于可信局域网；跨互联网使用 HTTPS。APK 会检查 `/api/health`，地址不可达、认证失败、证书无效都会显示明确错误并允许重试。地址与账号保存在手机，密码只保留在当前应用进程内；应用完全退出或系统回收进程后需重新输入密码。

连接后可在“设置 → 服务器连接”返回原生连接页。系统返回键会先关闭打开的网页对话框或展开项，再返回网页历史；处于根页面时可选择连接设置或退出。后台数据仍以所连接服务为准，换服务器会进入那个服务器的独立实例。

## 已接入的手机能力

- APK 内置 Web 构建的 HTML、JS、CSS、字体和静态图片。它以配置的服务 origin 运行，同源 `/api` 与 SSE 直接访问服务，保留现有聊天和模型配置流程。
- 原生窗口使用实际状态栏、手势导航区域与输入法 insets，键盘出现时缩小内容区。
- 角色导入等上传入口调用 Android 系统文件选择器，不申请广泛存储权限。
- 同源文件和网页生成的 PNG / Blob 可通过系统“保存到”选择位置，单次导出上限 20 MB；未获得位置前不会写入公共文件夹。
- 外部 HTTP(S) / 邮件链接交给系统应用；WebView 内部仅允许配置服务的完整同源网络请求，避免跨域请求携带实例认证。第三方远程嵌入素材需改为由服务同源提供。
- 不接受无效 HTTPS 证书，不开放 JavaScript 原生接口，不允许 WebView 直接读取本机文件，不启用第三方 Cookie。release 包关闭 WebView 调试与系统备份。

## 重新构建

仓库已有 pnpm 依赖后执行：

```powershell
pnpm android:build
```

这个命令会依次：构建当前前端、复制到原生 assets、运行 Android 地址策略单元测试与 release lint、生成并验证签名 APK，然后写入 SHA-256 和 `build-info.json`。`pnpm android:debug` 生成可调试版本；`pnpm android:build --skip-web` 仅在已经完成并确认前端构建时使用。

工具链要求 JDK 17 或 21、Android SDK platform 35、Build Tools 35.0.0。仓库带 Gradle 8.11.1 wrapper 和发行文件 SHA-256；Android Gradle Plugin 固定为 8.9.2。可以通过 Android Studio 安装 SDK，或使用 [Android 命令行工具](https://developer.android.com/studio#command-line-tools-only)。官方兼容关系见 [AGP 8.9 说明](https://developer.android.com/build/releases/agp-8-9-0-release-notes)，JDK 可使用 [Microsoft OpenJDK](https://learn.microsoft.com/en-us/java/openjdk/download)。

常规环境设置示例（路径按实际安装修改）：

```powershell
$env:JAVA_HOME = 'C:\Tools\jdk-21'
$env:ANDROID_HOME = 'C:\Tools\android-sdk'
& "$env:ANDROID_HOME\cmdline-tools\latest\bin\sdkmanager.bat" 'platforms;android-35' 'build-tools;35.0.0' 'platform-tools'
pnpm android:build
```

可将工具链安装到仓库忽略目录 `.cache/android-toolchain/`；构建脚本在没有显式环境变量时会自动发现该目录中的 JDK 与 SDK。工具链和 Gradle 缓存由每台构建机器自行准备，不随源码分发。

## 签名与版本升级

首次 release 构建会在 `.cache/android-signing/` 创建 `dearvale-release.jks` 和 `credentials.json`，后续构建重复使用。**请把这两个文件作为私密发布凭据一起安全备份**，它们不应提交 Git 或随 APK 分发；丢失原签名密钥后，已安装应用无法直接升级为另一把密钥签名的版本。

已有发行密钥时通过以下环境变量指定，脚本不会替换它：

```text
DEARVALE_ANDROID_KEYSTORE
DEARVALE_ANDROID_STORE_PASSWORD
DEARVALE_ANDROID_KEY_ALIAS
DEARVALE_ANDROID_KEY_PASSWORD
```

分享安装包时可一并提供 `.apk.sha256.txt` 供校验。每个 APK 附带独立的 `.apk.build-info.json`，并以 `build-info.json` 保留最新构建记录，包含包名、版本、版本代码、SDK 要求、构建时间、包体积与内容校验值，不包含服务器地址或访问凭据。发布下一版本只需修改 `apps/android/app/build.gradle` 的 `versionCode` 与 `versionName` 对应普通版或联网版的分支；打包脚本读取 Gradle 生成的 APK 元数据，自动同步输出文件名和构建记录，旧版本 APK 会保留。

联网版当前为 `0.1.1`（`versionCode 2`），运行 `pnpm online:android:build` 生成 `artifacts/android-online/Dearvale-Online-0.1.1.apk`。其包名为 `app.dearvale.mobile.online`，使用与普通版独立的签名，不内置信纸等 Web 资源；连接已更新的 HTTPS 服务后加载该服务的当前界面。联网版加载服务端当前界面，更新网页功能时应更新所连接的服务。

普通版 `0.1.2` 同步共享 Web 的记忆档案室页面与三张 WebP 贴图：柜体植物背板、书卷布面、日记纸纹。资源随 APK 内置；角色、日记与生成接口仍由所连接的服务提供，因此服务也需要更新到包含日记 API 的版本。原生资源加载已有 WebP MIME 与页面路由回退支持，原生连接和用户数据保存方式独立于网页资源。资源来源与用途见 [贴图说明](../apps/web/public/dearvale/art/memory-library/README.md)。

## 维护验证与发布范围

发布前运行构建脚本中的地址策略测试、release lint 与 APK 签名验证，并核对包名、版本及 SHA-256。普通版需确认内置 Web 资源与本次前端构建一致；联网版需确认没有意外打包单机 Web 资源。

设备验证应使用隔离的 Fixture 服务，覆盖安装和冷启动、局域网/HTTPS 连接、登录失败恢复、消息发送与返回、软键盘、系统返回、文件导入、PNG 保存和服务器切换。浏览器视口测试可运行 `pnpm test:mobile`；它不能代替目标 Android 设备或模拟器中的 WebView 验证。

APK、校验文件、构建记录、模拟器截图、设备日志、测试数据和验收报告保存在本地忽略目录 `artifacts/`；源码仓库仅保留构建脚本、测试代码、合成夹具及本指南。需要分发安装包时使用独立发布附件，签名密钥不得随包发送。
