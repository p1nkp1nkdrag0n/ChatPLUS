# Dearvale 桌面版与官网分离

Dearvale 现在提供独立的 Windows x64 桌面应用。桌面窗口启动后直接进入现有的 `/welcome` 欢迎页，角色、聊天、设置等功能继续复用应用前端和 Fastify 后端。官网使用单独的前端入口、开发端口和静态构建目录，可以独立部署和更新。

## 运行与打包

开发和打包需要 Windows x64、Node.js 22.12–24 与项目指定的 pnpm。最终安装包内包含 Electron、Node.js、本地服务、SQLite 原生模块与前端资源，使用者安装后无需额外安装 Node.js、pnpm 或启动网页服务。

在仓库根目录运行：

```powershell
pnpm install
pnpm desktop:dev
```

首次构建需要下载 Electron、依赖和所嵌入 Node 版本的许可证。`desktop:dev` 构建完整桌面运行目录后启动窗口；修改代码后重新运行该命令。Web 前端的热更新开发仍使用 `pnpm dev`。

| 命令                 | 结果                                                                                                       |
| -------------------- | ---------------------------------------------------------------------------------------------------------- |
| `pnpm desktop:build` | 构建前端、主进程及独立服务到 `apps/desktop/dist/`，验证内置 Node 能运行 SQLite 与图片模块。                |
| `pnpm desktop:dev`   | 构建完成后运行桌面应用。                                                                                   |
| `pnpm desktop:pack`  | 输出可直接运行的目录 `artifacts/desktop/win-unpacked/`。                                                   |
| `pnpm desktop:dist`  | 输出 Windows 安装程序 `artifacts/desktop/Dearvale-0.1.3-Setup.exe`。版本取自 `apps/desktop/package.json`。 |
| `pnpm test:desktop`  | 执行桌面运行环境与后端集成测试。                                                                           |

运行目录版时打开 `win-unpacked/Dearvale.exe`，分发时应保留整个 `win-unpacked` 目录。安装程序支持选择安装位置，并创建桌面和开始菜单快捷方式。应用窗口、可执行文件、安装程序和卸载程序统一使用 Dearvale 图标；正式对外发布的代码签名可以在 `apps/desktop/electron-builder.yml` 配置。

当前安装包仅面向 Windows x64，并要求在同平台构建。Node 可执行文件和原生依赖随构建机平台生成，因此不能把此构建目录直接用于 macOS、Linux 或 Windows ARM 安装包。

0.1.3 同步记忆档案室：按角色与月份陈列书脊、抽书后打开、正视双页翻阅，以及官网风格的植物背板、布面装帧与纸纹。安装包同时包含日记服务与 `036_memory_diaries.sql` 迁移，首次启动由本地服务自动迁移数据库。贴图随安装包内置，不依赖官网下载。联网版直接加载服务器页面，应更新它所连接的服务端前端与日记服务；重新打包连接壳不会更新远端内容。

## 启动、数据与退出

应用固定使用 `dearvale://app/welcome` 作为窗口入口。主进程启动仅监听 `127.0.0.1` 随机端口的本地后端，等后端和数据库迁移完成后展示欢迎页。固定的应用地址保证浏览器草稿、上次聊天入口等存储不会因每次随机端口不同而丢失。本地请求由主进程转发，并附加每次启动独立生成的访问凭证。

桌面实例默认使用 `%APPDATA%\Dearvale\`，安装目录仅保存程序资源。

| 内容                 | 位置                                                 |
| -------------------- | ---------------------------------------------------- |
| SQLite 数据库        | `%APPDATA%\Dearvale\data\persona-sim.sqlite`         |
| 模型凭据主密钥       | `%APPDATA%\Dearvale\data\persona-sim.sqlite.llm-key` |
| 书信实例密钥         | `%APPDATA%\Dearvale\data\instance-secret`            |
| 纪念物资产           | `%APPDATA%\Dearvale\data\assets\`                    |
| 成就图片资产         | `%APPDATA%\Dearvale\data\assets-achievements\`       |
| 本地服务日志         | `%APPDATA%\Dearvale\logs\server.log`                 |
| 页面存储和浏览器缓存 | `%APPDATA%\Dearvale\` 下的 Electron 用户目录         |

桌面实例使用独立数据目录，不会自动导入开发环境的数据库或 `.env`。后端默认采用 Fixture 演示模型；欢迎页沿用现有的首次模型配置引导，未完成配置时先展示该引导，再进入角色创建等流程。真实模型在引导或应用“设置”中添加。备份时先退出应用，再保管整个 `%APPDATA%\Dearvale\` 目录，以同时保存数据和解密所需密钥。升级和普通卸载保留用户数据。

关闭最后一个桌面窗口会停止本地后端。退出期间不会持续进行模型调用，重新打开后按现有应用规则补算时间。重复启动会唤起已打开的窗口，避免同一桌面实例同时启动多个服务。

开发验证可使用独立目录，避免测试修改日常桌面数据：

```powershell
$env:DEARVALE_DESKTOP_DATA_DIR = [System.IO.Path]::GetFullPath((Join-Path (Get-Location) 'tmp/desktop-qa'))
pnpm desktop:dev
Remove-Item Env:DEARVALE_DESKTOP_DATA_DIR
```

该变量必须是绝对路径，指定的是完整桌面用户目录，数据库位于其 `data` 子目录。

## 官网与应用的独立入口

| 入口     | 开发命令和地址                                                      | 构建结果                                     |
| -------- | ------------------------------------------------------------------- | -------------------------------------------- |
| 应用     | `pnpm dev` → `http://127.0.0.1:5173/welcome`，访问 `/` 也进入欢迎页 | `apps/web/dist/`                             |
| 官网     | `pnpm dev:website` → `http://127.0.0.1:5174`                        | `apps/web/dist-website/`                     |
| 桌面应用 | `pnpm desktop:dev` → 独立窗口欢迎页                                 | `apps/desktop/dist/` 与 `artifacts/desktop/` |

官网保留产品介绍和展示页面，不启动应用后端。开发时，官网的进入按钮默认跳转到 `http://127.0.0.1:5173/welcome`。部署官网前必须明确配置应用的实际地址：

```powershell
$env:VITE_APP_URL = 'https://app.example.com/welcome'
pnpm build:website
Remove-Item Env:VITE_APP_URL
```

`VITE_APP_URL` 要求绝对的 HTTP 或 HTTPS 地址，构建时写入官网静态资源；改变目标地址后需要重新构建。部署 `apps/web/dist-website/` 即可发布官网；已有 Web 应用继续按[自托管指南](SELF_HOSTING.md)独立部署。桌面应用包含自己的前端和本地服务，启动无需访问官网。

应用如需展示官网链接，可以在应用或桌面构建前设置 `VITE_WEBSITE_URL` 为官网的完整 HTTP/HTTPS 地址；未配置时生产应用隐藏该链接。两项 Vite 变量也可以写入 `apps/web/.env.local`，仓库根目录的 `.env` 用于后端配置。

## 生成角色时提示输出被截断

若模型返回 `OUTPUT_TRUNCATED`，表示它已触及当前单次输出限制，角色内容尚未完整生成。0.1.1 起会显示明确的中文原因，并在角色生成页提供“前往模型设置”入口；只有确认本地保存成功时才提示描绘已保存在本机。

在“设置”选择当前供应商和模型，展开“高级设置”，检查“输出 token 上限”。角色编译申请的上限为 32,000，但实际值仍受该模型的配置限制；例如模型配置为 8,192 时，最终仅发送 8,192。应在供应商支持的范围内调整这个模型的上限；如果模型启用了推理，也要为可见结果留出空间。保存后返回角色描绘，再次生成即可。

应用不会自动提高用户设置的 token 上限，也不会将截断的半成品当作完整角色保存。失败请求可能已经产生模型用量；日志位于 `%APPDATA%\Dearvale\logs\server.log`。其他未知异常仍隐藏内部细节，便于诊断的具体错误保留在本地日志中。

## 构建结构

桌面图标的原始作品位于 `apps/desktop/build/icon-source.png`。运行 `pnpm desktop:icon`，会通过 `apps/server/src/scripts/prepare-desktop-icon.ts` 派生 1024 × 1024 的 `icon.png` 和包含 16–256 像素版本的 Windows 多尺寸 `icon.ico`；设计说明和完整创作提示词见[图标说明](../apps/desktop/build/ICON.md)。

构建会将 PNG 复制到 `runtime/icon.png`，供开发窗口和安装后的应用窗口使用；electron-builder 以 `apps/desktop/build` 为构建资源目录，将 ICO 嵌入应用、安装程序与卸载程序。更新原始作品后，依次运行 `pnpm desktop:icon` 与 `pnpm desktop:dist`，即可生成包含新图标的完整安装包。

`scripts/desktop-build.ts` 使用 pnpm 的冻结锁文件部署模式，临时启用 workspace injection，并生成没有符号链接或 Windows junction 的 hoisted 生产依赖目录。项目内部 workspace 源码合并到服务 bundle，第三方依赖保留为生产模块，避免打包时依赖开发机的目录链接。

Electron 仅运行桌面主进程；服务通过随包分发的标准 Node 运行，所以 SQLite 和图片处理模块保留构建用 Node 的 ABI，无需再为 Electron 重编译。构建过程包含真实的内存 SQLite 建表与图片编码校验，并在 `runtime/build-info.json` 记录 Node 版本、平台和锁文件摘要。运行资源作为 `extraResources` 复制，独立于主进程的 ASAR 包。

## 发布范围

源码仓库保留 Electron 与服务端源码、图标、构建脚本及依赖锁文件。安装程序、解压运行目录、构建记录、测试数据、日志、截图和验收报告留在本地忽略目录；对外分发时将安装包与校验信息作为独立发布附件。代码签名凭据和桌面用户数据不进入仓库。
