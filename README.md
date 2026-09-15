# Dearvale · ChatPLUS

> **让相遇，慢慢成为故事。**
>
> 他们的人生不会因为你离开而停止，却会因为你来过而发生改变；你的人生也同样如此。

Dearvale 是一个以长期相处为核心的 AI 虚拟角色应用：从逐题描绘一个角色开始，和对方聊天、交换书信，在有来源的记忆、生活变化与关系积累中留下共同经历。

项目采用本地优先、事件驱动的实现，支持无 API Key 的确定性演示、接入真实模型，以及独立实例自托管。仓库名仍为 **ChatPLUS**，内部 workspace 包名沿用 `persona-sim` / `@personasim/*`；页面品牌为 **Dearvale**。

好友联网测试版现提供独立的服务器入口、邀请码账号、积分计费、研究采集和本机管理网页。新账号先选择平台模型或配置自己的 API，再进入欢迎页；个人供应商和功能模型设置随账号在网页与安卓端共用。运行 `pnpm hosted:serve` 后访问 `http://127.0.0.1:3002/admin` 完成配置；独立 Windows / Android 联网包分别使用 `pnpm online:desktop:dist`、`pnpm online:android:build`。部署、模型映射、穿透要求和双包加密备份见[好友联网测试版说明](docs/HOSTED.md)。

核心准则是：**时间会推进，互动有后果，关系会积累，变化可追溯。** 目前仍处于实验阶段，真实模型的自然度、长期连续性和完整纠错保持尚未完成整体验收。本文按当前仓库实现整理；历史发布记录见 [v0.1.6-Beta](docs/releases/v0.1.6-Beta.md)，workspace 的 `0.1.0` 不是发布标签版本。

## 当前体验

| 模块           | 当前实现                                                                                                                               |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 欢迎与角色创建 | 插画叙事首页、欢迎页与书桌问答。十二个主问题中六项必答，其余可跳过；最多两个可选追问，支持中断恢复、修改答案、小传预览与确认发布。     |
| 角色管理       | 原创角色、作品文本导入、详细编辑器、高级 JSON、字段锁定、来源审核和版本历史。目标与矛盾可以留空，已发布版本保持不可变。                |
| 日常对话       | 多会话、按会话切换模型、发送状态与输入中提示；支持倾听、共同分析、明确推荐和有授权的委托决定。可选开启回复目标复核。                   |
| 记忆与相处     | 基于来源的召回、当前事实修订、自传与事件证据；纠正会使依赖旧解释的派生内容失效并保留历史。可选学习有适用范围、可撤回的相处偏好。       |
| 角色生活       | 按角色当地自然日生成“今天大概做什么、最近在做什么”的模糊背景；生活主线、状态和关系变化需要证据，讨论、决定、行动、结果分别记录。       |
| 数字书信       | 可选启用普通、加急、特快投递、离线补算、不可变抵达快照、加密回信与启封；支持本地常驻和自托管时间任务。                                 |
| 纪念物与收藏   | 可选生成有来源的关系纪念物，提供档案、陈列柜和本地 PNG 分享；成就页记录全局足迹与角色纪念，高阶角色徽章可使用独立图片模型。            |
| 模型与诊断     | 页面管理多供应商、模型和加密凭据；支持 Fixture、OpenAI 兼容、Anthropic Messages、Gemini 原生协议。内部状态与诊断由开发者模式单独开放。 |

当前主导航包含“对话、书信、记忆、角色、成就、设置”，托管模式另提供账号与账单入口。记忆档案室支持按角色和月份阅读日记；时间线、关系档案、纪念物及分享页面的路由仍保留。**主动消息当前统一停用**，兼容数据和底层实现保留，不应把角色生活补算理解为主动聊天或系统推送。

## 快速开始

需要 **Node.js 22–24** 和 **pnpm 11.19.0**（以 [package.json](package.json) 的 `engines`、`packageManager` 为准）。在仓库根目录执行：

```bash
pnpm install
pnpm db:migrate
pnpm dev
```

打开 [http://127.0.0.1:5173](http://127.0.0.1:5173)。开发模式同时启动 Vite 前端和 `127.0.0.1:3001` 上的 Fastify 后端，前端将 `/api` 请求代理到后端。

新实例无需创建 `.env` 即可运行，默认使用 `fixture` 模型，不需要 API Key 或外部模型请求。Fixture 用于验证创建、聊天和数据流程，回复是确定性的演示内容；体验真实对话请在“设置”中添加模型。

单机版入口直接进入 `/welcome` 欢迎页；联网版新账号先完成模型设置，已有账号升级时保留原入口。Windows x64 桌面版可运行 `pnpm desktop:dev`，生成安装程序使用 `pnpm desktop:dist`；安装包自带本地服务和运行环境，输出在 `artifacts/desktop/`。官网通过 `pnpm dev:website` 单独运行在 `http://127.0.0.1:5174`，使用 `pnpm build:website` 独立构建。桌面数据目录、安装包和官网部署配置见[桌面版与官网分离说明](docs/DESKTOP.md)。

手机端采用参考 iPhone Pro 比例的 iOS 风格布局；运行 `pnpm android:build` 生成 `artifacts/android/Dearvale-<version>.apk`（版本取自 Android 构建配置），电脑运行 `pnpm mobile:serve` 后，在 APK 中填写输出的局域网地址、用户名与本次连接密码；安装和 HTTPS 服务器连接见[安卓应用说明](docs/ANDROID.md)，电脑连接步骤见[手机连接指南](docs/MOBILE-SERVER.md)，五种屏幕尺寸的隔离验收可运行 `pnpm test:mobile`。

首次使用：

1. 从欢迎页点击“描述你梦中的他/她”，依次填写性别、姓名、文字年龄、世界、身份和性格，再按需补充其他设定。默认使用“拟真模拟”，可在更多设定中选择轻量、日常或拟真模式。
2. 完成可选追问，阅读生成的小传。可以返回修改答案；需要核对完整设定与来源时，也可暂存离开，从“角色”列表的编辑入口打开详细编辑器。
3. 确认必要的设定后，点击“与他/她相遇”发布角色并进入聊天。未完成的问答与未确认小传支持恢复；发布成功后欢迎页才会显示“继续聊天”。
4. 也可以从“角色”导入 `.txt`、`.md`、`.srt` 或粘贴文本，检查草稿后发布。单次作品导入上限为 500 KB。

应用不再自动创建示例角色，旧 `SEED_DEMO` 配置也不会恢复播种。升级迁移仅归档来源或登记记录明确识别的系统示例，并保留角色版本、来源材料和聊天历史。新角色统一以初识关系开始；轻量模式不增长关系，日常与拟真模式按已有规则逐步积累。

## 模型配置

### 在页面中设置

单机版打开“设置”添加供应商，选择协议并填写 API 根地址、密钥和模型。可以检测模型列表，也可以手动填写模型 ID；无需鉴权的本机或局域网 HTTP 模型服务允许留空密钥。联网版个人供应商在“模型与功能”页面管理，需要 API Key 与公网 HTTPS 地址。

- **全局默认模型**在单机版用于跟随默认的会话、角色生成与后台模型任务；联网版可按功能分别选择平台模型或自己的模型。
- **会话模型**在聊天输入框上方选择，从下一条消息生效，保留历史和输入内容。
- **检测模型**只读取模型列表。**测试连接与回复**最多执行两次真实短请求，分别检查可见正文与结构化 JSON；两项通过才显示绿色成功。
- **上下文预算**新模型默认 64,000 token，支持逐个调整；供应商返回的输入、上下文和输出限制单独保存并约束实际预算，刷新列表保留已有参数。
- **保存或切换**不会自动测试；页面配置保存后即时生效，无需重启。
- **回复目标复核**位于“回复体验”，默认关闭。单机版开启后由当前会话模型结合上下文复核，联网版使用对应功能的模型设置；必要时重新生成，会增加等待时间和模型用量。

页面保存的 API Key 由后端加密写入 SQLite，主密钥存放在 `${DATABASE_PATH}.llm-key`，读取接口不返回密钥原文。联网版还加密个人供应商 URL，保存在所属账号的数据库；模型参数与聊天业务库仍为普通字段，并非全库加密。浏览器不持久保存密钥，也不直接调用模型供应商。协议参数、连接状态及凭据恢复详见[模型设置说明](docs/MODEL_SETTINGS.md)。

联网版首次显示“我们需要确定一些设置”：选择“我没有API-KEY”后选择平台文本模型；选择“我有API-KEY”后配置供应商、选定模型并通过短回复与结构化测试，两条路径保存成功后进入 Welcome。首次选择应用到全部文本功能，后续在“模型与功能”页面分别调整；未设置的功能使用平台对应模型，个人模型失败时不自动切回平台。

自带 Key 的调用及测试不冻结、不扣除平台积分，用量缺失也不冻结；平台调用继续扣额度。图片生成当前仅支持单独选择平台图片模型，引导中说明会消耗额度。自带 Key 沿用现有研究采集，不新增许可确认或提醒文案。配置与首次设置状态随服务端账号保存，网页完成后安卓可直接使用；请求由服务端统一执行公网 HTTPS、DNS 地址、重定向、体积与超时检查，解析并持久化结果后同步给客户端。

### 使用环境变量

需要用文件管理配置或运行模型实验时，参考 [.env.example](.env.example) 创建本地 `.env`。已有 `.env` 应按需合并，保留实际使用的 `DATABASE_PATH`；修改环境变量后重启服务。

命名档案使用以下格式，示例地址、模型和密钥需替换为自己的供应商配置：

```dotenv
LLM_PROVIDER=openai-compatible
LLM_ACTIVE_PROFILE=main

LLM_PROFILE_MAIN_BASE_URL=https://your-provider.example/v1
LLM_PROFILE_MAIN_MODEL=your-model-id
LLM_PROFILE_MAIN_API_KEY=your-api-key
LLM_PROFILE_MAIN_STRUCTURED_OUTPUT_MODE=prompt_json
```

档案名会规范化为小写，连字符映射到环境变量中的下划线，例如 `gpt56-sol` 读取 `LLM_PROFILE_GPT56_SOL_*`。环境变量命名档案走 OpenAI 兼容 Chat Completions 接口并要求 HTTPS；原生 Anthropic / Gemini 和本地 HTTP 服务请通过页面配置。未选择命名档案时，旧 `OPENAI_COMPATIBLE_*` 配置仍兼容。

环境来源在设置页只读展示，可复制为可编辑配置；页面不会反写 `.env`。未设置页面全局默认时，应用继续使用环境变量选择的模型。超时、结构化输出、思考参数、上下文和输出上限见配置模板；其中的模型 ID 与网关示例不代表供应商当前可用性，接入时应以自己的账户和连接测试结果为准。

## 功能开关与运行方式

以下是新实例未覆盖配置时的默认行为；角色自身的轻量、日常、拟真能力档也会影响具体功能。完整参数见 [.env.example](.env.example)，模式说明见[功能开关与灰度指南](docs/ROLLOUT.md)。

| 配置                       | 默认值     | 作用                                                            |
| -------------------------- | ---------- | --------------------------------------------------------------- |
| `LLM_PROVIDER`             | `fixture`  | 无凭证演示；真实环境档案使用 `openai-compatible`。              |
| `CLOCK_MODE`               | `system`   | 使用系统时间；`fake` 用于可控时间实验。                         |
| `LIFE_PLANNING_MODE`       | `fuzzy`    | 模糊自然日生活；`legacy_exact` 仅保留给旧排程回归。             |
| `MEMORY_RECALL_MODE`       | `enforced` | 校验证据后召回记忆。                                            |
| `AUTOBIOGRAPHY_MODE`       | `enforced` | 自传连续性与来源验证。                                          |
| `LIVE_WORLD_EFFECTS`       | `enforced` | 校验并限幅状态、关系等模型提案，再事务化提交。                  |
| `COMPANION_CONTEXT_MODE`   | `off`      | 可选的陪伴上下文选择与记忆使用策略。                            |
| `PERSONA_RUNTIME_MODE`     | `off`      | 可选的、有来源且可撤回的局部相处偏好学习。                      |
| `CORRESPONDENCE_MODE`      | `off`      | 数字书信生成与时间任务。                                        |
| `CORRESPONDENCE_EXECUTION` | `lazy`     | 书信与纪念物的 `lazy` 补算，或 `resident` / `worker` 常驻处理。 |
| `KEEPSAKE_MODE`            | `off`      | 由已发生或已确认经历派生纪念物。                                |
| `DEVELOPER_MODE`           | `false`    | 开放开发者页面和内部诊断接口。                                  |

体验陪伴上下文与局部偏好学习，可在 `.env` 设置后重启：

```dotenv
COMPANION_CONTEXT_MODE=enforced
PERSONA_RUNTIME_MODE=enforced
```

两项也支持 `shadow`，用于记录诊断而不应用新策略。基础记忆真实性、完整来源验证和纠正失效不依赖这两个开关。可以用“聊工作烦恼时，先听我说，不急着建议”建立限定话题的偏好，再在后续会话验证或撤回；当轮明确结束、临时例外和长期偏好分别处理。实现与边界见[记忆系统架构](docs/memory-architecture.md)和[功能开关指南](docs/ROLLOUT.md)。

### 书信、纪念物与成就

启用书信与纪念物时，在实例配置中设置：

```dotenv
CORRESPONDENCE_MODE=enforced
KEEPSAKE_MODE=enforced
CORRESPONDENCE_EXECUTION=lazy
INSTANCE_SECRET=replace-with-your-generated-base64-secret
```

`INSTANCE_SECRET` 必须替换为至少 32 个随机字节的规范 Base64；占位符不能直接启动。可以运行以下命令生成值，再写入本实例配置并独立保管：

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

| 执行方式   | 行为                                                       |
| ---------- | ---------------------------------------------------------- |
| `lazy`     | 启动和相关角色入口执行补算，不启动书信与纪念物常驻计时器。 |
| `resident` | 本机进程常驻时扫描到期任务，与浏览器是否打开无关。         |
| `worker`   | 自托管使用相同任务循环，通过 SQLite claim/lease 协调执行。 |

原信可选择普通、加急或特快投递；运输天数按共享契约计算，回信沿用自身固定运输规则。服务停机期间不会运行模型，重新启动后按时间与幂等游标补算。书信处于 `off` 时暂停任务；已有密文仍需要匹配的实例密钥。纪念物默认图片/模板路径不需要第三方图片凭证。

“成就”不依赖书信功能整体开启：目前有 **11 项全局纪念、每角色 5 项关系纪念**，满足相应行为后记录；寄信和启封类纪念自然需要书信功能。前台使用日期按 `Asia/Shanghai` 自然日记录，无需签到按钮。设置中的“徽章生图模型”独立于聊天模型，固定徽章无需图片服务，高阶专属徽章按保存的配置排队生成。徽章任务使用独立后台队列，不受 `CORRESPONDENCE_EXECUTION` 控制；失败不撤回成就，可手动重试。详见[成就收藏说明](docs/ACHIEVEMENTS.md)。

### 开发者模式

在 `.env` 中设置 `DEVELOPER_MODE=true` 并重启，设置页才会开放开发者入口。可查看完整角色状态、关系、记忆、生活推演、来源审计、LLM 调用记录与成就任务；使用 `CLOCK_MODE=fake` 时可推进测试时间。

普通 HTTP 和 SSE 始终使用公开字段投影，即使开启开发者模式也不夹带原始状态或内部诊断。旧说明中助手消息的 `companionContext`、`personaRuntime` 等 metadata 应通过开发者记录检查。

普通聊天仅保留紧凑的召回策略、选中记忆与来源标识；完整检索候选、阶段与回放快照在开发者模式下记录，并在聊天提交成功后独立保存，诊断失败不会撤回回复。检索诊断按角色保留最近 30 天、最多 100 条，在后续聊天或开发者预览时清理；该保留策略不删除聊天原文、记忆或事实来源。

## 自托管、数据与备份

开发模式默认只允许回环地址。项目也支持显式的单实例生产部署：同一镜像提供 Web 和 Fastify，由 Caddy 处理 HTTPS 与 Basic Auth，应用端口只在 Compose 私网内开放。

按[自托管与恢复指南](docs/SELF_HOSTING.md)从 [.env.selfhosted.example](.env.selfhosted.example) 准备域名、认证、独立密钥和可写目录，再启动：

```bash
docker compose --env-file .env.friend-a --project-name chatplus-friend-a --file docker-compose.selfhosted.yml up --detach --build
```

自托管边界通过 `SELFHOSTED_REVERSE_PROXY=true` 显式启用，同时要求生产环境、容器内监听地址及 HTTPS origin。该单实例入口依赖反向代理认证；不同使用者部署为独立实例。需要邀请码账号与隔离用户数据时，使用[托管入口](docs/HOSTED.md)。仅修改 `HOST=0.0.0.0` 不能替代这套配置。

数据位置以实际配置为准：

| 内容           | 默认位置或规则                                                                                                                          |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| SQLite 数据库  | 无 `.env` 时为 `data/persona-sim.sqlite`；复制 `.env.example` 后示例为 `data/personasim.db`；Compose 内为 `/app/data/chatplus.sqlite`。 |
| 纪念物资产     | `ASSET_STORAGE_PATH`，默认 `data/assets/`。                                                                                             |
| 成就徽章资产   | `${resolve(ASSET_STORAGE_PATH)}-achievements`，默认 `data/assets-achievements/`；Compose 使用独立卷。                                   |
| 模型凭据主密钥 | `${DATABASE_PATH}.llm-key`，聊天与徽章供应商共用；与书信的 `INSTANCE_SECRET` 独立。                                                     |
| 测试及实验产物 | `tmp/`、`artifacts/`、`test-results/`、`playwright-report/` 等。                                                                        |

**首次启动后再复制环境模板时，请保留原数据库路径**，否则应用会打开另一份数据库，看起来像没有历史数据。升级已有实例前先备份，再运行迁移或更新镜像。

`pnpm selfhost:backup -- ...` 和 `pnpm selfhost:restore -- ...` 提供一致性备份及恢复到全新路径的工具。当前备份格式 v3 包含数据库、纪念物和独立徽章资产，兼容恢复 v1/v2；**备份不包含 `INSTANCE_SECRET` 或 `.llm-key`**，需同批次单独保管。完整参数、密钥缺失处理和 Compose 徽章卷恢复步骤见[恢复指南](docs/SELF_HOSTING.md)。

源码仓库保留正式源码、依赖锁文件、构建与通用启动脚本、配置模板、测试源代码、人工合成夹具、运行时设计资产以及持续维护的技术指南和评测协议。`.env`、数据库、凭据与签名密钥、日志、备份、缓存、本地测试数据、评分、验收截图、工作记录和报告均留在 Git 忽略目录。

Windows 安装程序、APK、解压运行目录和构建校验产物保存在 `artifacts/`，不提交 Git；需要分发时通过独立发布附件提供。个人启动快捷脚本仅在本机保留，公开操作使用本文的 `pnpm` 命令。`docs/plans/`、`docs/reports/` 与历史实验结果不属于公开源码内容。

## 开发与测试

项目采用 pnpm workspace、TypeScript、React 19 / Vite 7、Fastify 5、SQLite WAL 与 Zod。测试按职责分布：源码旁的 Vitest 单元和集成测试，以及 `tests/e2e/` 的 Playwright 浏览器流程。

| 命令                                                                                  | 用途                                                               |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `pnpm dev`                                                                            | 同时启动后端与前端开发服务。                                       |
| `pnpm db:migrate`                                                                     | 幂等运行顺序数据库迁移。                                           |
| `pnpm typecheck`                                                                      | 各 workspace 类型检查。                                            |
| `pnpm lint`                                                                           | ESLint 检查。                                                      |
| `pnpm build`                                                                          | 各包类型检查与 Web 生产构建；后端仍通过 `tsx` 运行。               |
| `pnpm test`                                                                           | Vitest 单元、集成与模拟测试。                                      |
| `pnpm test:e2e`                                                                       | Playwright 浏览器验收，主项目覆盖 1440×900 与 1920×1080 桌面尺寸。 |
| `pnpm test:state:unit` / `pnpm test:state:integration` / `pnpm test:state:simulation` | 状态、关系、持久化与时间推进的专项检查。                           |
| `pnpm test:correspondence:focused`                                                    | 书信、纪念物和档案的单元、集成与 Web 测试。                        |
| `pnpm test:correspondence:stages1-8`                                                  | 上述检查及书信完整 E2E。                                           |
| `pnpm test:companion:long-run:v3:fixture`                                             | 120 轮确定性长程回归。                                             |

首次运行浏览器测试前安装 Chromium：

```bash
pnpm exec playwright install chromium
pnpm test:e2e
```

[CI](.github/workflows/ci.yml) 分别运行代码质量与构建、浏览器验收、120 轮确定性长测。普通测试和 fixture 实验不请求外部模型；真实模型实验需显式运行，并产生供应商用量。

### 模型实验

首页只列常用入口，具体场景、恢复方式、评审协议见对应文档。长程实验应使用独立数据库与新产物目录，避免不同模型混用同一历史。

| 实验           | 离线入口                                                               | 说明                                                                                                            |
| -------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 双模型动态对话 | `pnpm test:dual-model:fixture --turns 3`                               | 一个模型扮演合成用户，另一个走项目真实角色消息流程；见[双模型测试](docs/DUAL_MODEL_TESTING.md)。                |
| 产品人生长测   | `pnpm test:product-life:fixture <run-id>`                              | 42 轮、45 个模拟日，覆盖生活、记忆、重启与书信；见[产品人生实验](docs/DUAL_MODEL_TESTING.md#产品人生长程实验)。 |
| 记忆相关性     | `pnpm test:memory-relevance:fixture --output tmp/memory-relevance-NEW` | 召回、回复消融与上下文预算实验；见[记忆与预算实验方法](docs/evals/memory-relevance-and-budget-method.md)。      |
| 整体架构比较   | `pnpm test:architecture:fixture --output tmp/architecture-NEW`         | 对照系统、固定历史、人格与模块消融；见[实验协议](docs/evals/architecture-comparison.md)。                       |
| 角色生成比较   | `pnpm test:character-generation:comparison:fixture`                    | 比较角色生成及约束路径；见[生成对比方案](docs/evals/character-generation-comparison.md)。                       |
| 回复策略       | `pnpm test:reply-steering:fixture`                                     | 回复意图与表达策略实验；见[回复策略评测](docs/evals/reply-steering/README.md)。                                 |

`pnpm test:llm:smoke` 检查所选环境模型档案的真实业务路径，另有 `:claude`、`:grok`、`:gemini`、`:gpt56-sol`、`:bigmodel`、`:qwen` 命名快捷命令。真实双模型及产品人生实验要求 `RUN_PAID_DUAL_MODEL=1`；其他实验按各自文档设置对应的显式运行开关。不要把 smoke、fixture 或执行器的 `completed` 当作真实语言质量通过。

## 项目结构

```text
apps/
  web/                  React 页面、交互、样式及 Dearvale 视觉资产
  server/
    src/composition/    静态类型化服务工厂与统一启动/释放
    src/http/           HTTP 路由、公开数据投影与开发者边界
    src/services/       角色、对话、记忆、生活、书信与成就服务
    src/repositories/   专项持久化接口
    src/db/             SQLite 迁移与兼容存储层
    src/runtime/        时钟、时间任务与实例备份恢复
    src/scripts/        模型验收与实验执行器
packages/
  contracts/            Zod schemas 与共享类型
  kernel/               提示 token 估算与保留的历史插件 SDK
  features/             纯领域规则、因果、记忆、提示与模拟算法
  providers/            Fixture、兼容/原生模型适配与图片 Provider
scripts/                实例备份、恢复及资源准备工具
tests/
  fixtures/             固定场景与测试数据
  e2e/                  Playwright 用户流程
deploy/                 Caddy 与可选 Compose 挂载配置
docs/                   架构、操作指南、ADR、设计规范与评测协议
```

模型只生成文本与有界提案：服务端读取上下文、调用模型、校验来源与领域规则，最后在短 SQLite 事务中提交。角色队列协调同一角色的关键变更；SSE 通知前端重新读取持久化数据。模型调用不占用数据库事务，模型输出也不能直接写数据库。

## 文档导航

| 文档                                                                                                                            | 内容                                               |
| ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| [模型设置](docs/MODEL_SETTINGS.md)                                                                                              | 多供应商、协议参数、连接测试与加密凭据。           |
| [成就收藏](docs/ACHIEVEMENTS.md)                                                                                                | 行为纪念、专属徽章、独立图片模型与资产恢复。       |
| [角色问答实施](docs/design/character-interview-implementation.md)                                                               | 问答、追问、草稿、小传、发布与交互规则。           |
| [自托管与恢复](docs/SELF_HOSTING.md)                                                                                            | Docker、Caddy、时间任务、备份和升级。              |
| [功能开关](docs/ROLLOUT.md)                                                                                                     | 默认模式、灰度行为和历史兼容路径。                 |
| [架构](docs/architecture.md) / [数据契约](docs/schemas.md) / [插件合同](docs/plugin-sdk.md)                                     | 领域分层与接口约定；当前部署方式以自托管指南为准。 |
| [模糊生活与因果 ADR](docs/adr/0006-fuzzy-life-and-decision-causality.md) / [书信 ADR](docs/adr/0007-temporal-correspondence.md) | 时间、生活、选择与延迟书信的设计依据。             |
| [Dearvale 插画清单](docs/design/dearvale-assets.md) / [问答素材清单](docs/design/character-interview-assets.md)                 | 当前视觉资源来源与实现说明。                       |
| [双模型测试](docs/DUAL_MODEL_TESTING.md) / [架构实验](docs/evals/architecture-comparison.md)                                    | 可复现的执行入口与评审协议。                       |

历史发布说明描述对应版本的功能与边界；当前默认配置以功能开关指南和源码为准。本地报告与测试成绩不随源码发布。

## 当前边界

- 提供本地单实例、独立自托管和邀请码托管测试入口；托管入口使用独立账号与数据目录，尚无云同步或公共分享平台。
- 真实模型仍可能出现修辞惯性、附加建议、错误召回或主体归属问题；工程测试通过不能替代长期内容质量评审。
- 生活背景只表达自然日、粗粒度时段、近况和忙碌程度，不提供分钟级角色日历。时间过去本身不证明目标完成、用户采取行动或结果发生。
- 作品导入使用有界摘录编译角色，不是全文检索、PDF/OCR 或音视频分析。当前没有部署向量数据库或 embedding 检索服务。
- 主动消息暂停；没有系统通知、语音/3D、第三方插件安装与沙箱。Windows 与 Android 客户端可从源码构建，安装包单独分发。内部可信插件运行时不等于外部插件市场。
- 应用不代表用户或角色发送现实邮件、操作日历或执行外部工具。倾听、分析、推荐和明确授权的委托决定都发生在对话与模拟中，后续行动、结果和记忆仍需证据。
- 数据库 schema 尚未承诺跨大版本兼容；升级前保留数据库、两类资产及各自密钥的可恢复备份。
