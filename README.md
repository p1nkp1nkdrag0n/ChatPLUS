# PersonaSim

> **他们的人生不会因为你离开而停止，却会因为你来过而发生改变；你的人生也同样如此。**

PersonaSim 是一个本地运行、事件驱动的 AI 虚拟角色对话 Demo。它不把角色简化成一段系统提示词：角色拥有可编辑、可版本化的人格模型、持续推进的生活主线、压力和人生选择。系统按角色所在的自然日生成模糊生活背景，而不是伪造精确到分钟的未来日程；一次交流可能让某个人平静下来，也可能影响后来作出的决定及其结果。

核心准则是：**时间会推进，互动有后果，关系会积累，变化可追溯。**

> 这是单用户、只与合成测试用户交流的虚构角色功能验证 Demo。默认 `lazy` 模式在服务关闭期间不运行；显式启用的本地常驻或自托管 worker 只处理本实例数据库中的书信时间任务。应用不会代表用户或角色调用外部工具、发送邮件、操作日历或执行现实动作。

## 已实现能力

- 原创角色最低限度表单生成
- `.txt`、`.md`、`.srt` 或粘贴文本导入作品角色（500 KB 上限）
- 来源、推断和合成补全分级的人格字段
- 十个章节的角色编辑器、高级 JSON、字段锁定和版本历史
- 按角色当地日期生成“今天大概做什么、最近在做什么”的模糊生活背景
- 持续推进工作、创作、关系、迁居等跨日生活主线
- 记录困境、支持方式、决定、实际行动、结果和复盘之间的因果链
- 轻量、日常和拟真三种 capability profile
- Fixture LLM：不需要 API Key 的确定性完整演示
- 支持命名配置档案的 OpenAI-compatible Chat Completions Provider
- 普通聊天、人格约束、状态/关系/记忆提案
- `listen_only`、`deliberate`、`recommend`、`delegated_decision` 四种支持方式
- 打开应用时按自然日和已推进阶段批量追赶生活进程，并使用幂等游标防止重复
- 主动消息当前暂时停用；兼容数据与底层两阶段提交实现仍保留，修复主题归属和过期生命周期后再重新启用
- SQLite WAL 持久化、领域审计事件和 LLM 调用计量
- FakeClock 与开发者快照
- 五日历日数字书信、离线补算、不可变抵达快照、加密回信与启封
- 由已发生/已确认经历派生的低频数字纪念物、内容寻址 WebP 资产与可追溯来源链
- 分页关系档案、纪念物陈列柜，以及默认隐藏正文的本地 PNG 分享导出
- 共用领域内核的 lazy / resident / worker 驱动，以及单实例 Docker 自托管、备份恢复
- 单元、集成、模拟和 Playwright E2E 测试

## 快速开始

要求 Node.js 22–24 与 pnpm 11。

```bash
pnpm install
pnpm db:migrate
pnpm dev
```

打开 [http://127.0.0.1:5173](http://127.0.0.1:5173)。默认 `fixture` Provider 不需要联网或凭证。

本地 Demo 默认使用 `LIFE_PLANNING_MODE=fuzzy`，不再运行旧的精确自主排程和聊天日程协商；`MEMORY_RECALL_MODE=enforced` 与 `AUTOBIOGRAPHY_MODE=enforced` 默认启用已验证证据召回、retention checkpoint 和自传连续性，`LIVE_WORLD_EFFECTS=enforced` 则把通过校验和限幅的模型状态/关系 proposal 事务化落库。Fixture 与真实 Provider 共用同一条服务端校验、提交和追溯路径。`legacy_exact` 与旧 planning flags 只用于显式迁移回归。

推荐演示顺序：

1. 在“创建”填写八项简短设定，选择“拟真模拟”。
2. 在编辑器检查人格、来源和生活节奏，点击“发布并激活”。
3. 在聊天中让角色或测试用户提出一个真实价值冲突，例如“稳定工作让我很累，但辞职做纪录片又可能失败”。
4. 分别测试倾听、共同分析、明确推荐；测试用户明确说“请你替我决定”时，角色可以选择 `delegated_decision` 并直接给出一个方向。
5. 打开“开发者”，对照本轮前后的压力、清晰度、关系，以及 `困境 → 支持 → 决定` 证据链。
6. 将 FakeClock 推进，注入行动与结果，再观察角色是否忠实复盘成功、失败、遗憾或意外，并在后续会话中延续这次转折。

默认会提供一个可直接体验的示例角色；设 `SEED_DEMO=false` 可关闭。

需要浏览器关闭后仍处理到期书信，或给单个朋友部署独立实例时，请按[自托管与备份恢复指南](docs/SELF_HOSTING.md)使用同一镜像、独立数据库、独立 `INSTANCE_SECRET` 和 Caddy HTTPS/Basic Auth。不要把未经反向代理保护的 Fastify 端口直接暴露到公网。

书信与纪念物默认仍关闭。体验完整闭环时，需要在隔离的本地或自托管实例中设置 `CORRESPONDENCE_MODE=enforced`、`KEEPSAKE_MODE=enforced`，并为该实例配置至少 32 个随机字节的规范 Base64 `INSTANCE_SECRET`。纪念物的 fixture 图像/模板路径不需要第三方凭证；替换为真实图片 Provider 时，Provider 只接收受限的 `VisualPromptSpec`，不会收到整封信、完整角色材料或聊天记录。

## 配置多供应商模型

复制 `.env.example` 为本地 `.env`。`.env` 已被 Git 忽略，API Key 只由 Fastify 后端读取，不会进入浏览器、SQLite、日志或测试快照。项目可以同时保存多套命名档案，并通过 `LLM_ACTIVE_PROFILE` 选择当前档案；切换后需要重启服务。

```dotenv
LLM_PROVIDER=openai-compatible
LLM_ACTIVE_PROFILE=claude

LLM_PROFILE_CLAUDE_BASE_URL=https://sub.wanzhao.top/v1
LLM_PROFILE_CLAUDE_MODEL=claude-opus-4-6
LLM_PROFILE_CLAUDE_API_KEY=在本机填写晚照云签发的密钥
LLM_PROFILE_CLAUDE_STRUCTURED_OUTPUT_MODE=prompt_json
LLM_PROFILE_CLAUDE_REASONING_EFFORT=medium
LLM_PROFILE_CLAUDE_REASONING_FORMAT=anthropic_output_config
LLM_PROFILE_CLAUDE_SUPPORTS_THINKING_CONTROL=false
LLM_PROFILE_CLAUDE_MAX_OUTPUT_TOKENS=32768

LLM_PROFILE_GROK_BASE_URL=https://sub.wanzhao.top/v1
LLM_PROFILE_GROK_MODEL=grok-4.6
LLM_PROFILE_GROK_API_KEY=在本机填写独立的晚照云 Grok 密钥
LLM_PROFILE_GROK_REASONING_EFFORT=medium
LLM_PROFILE_GROK_REASONING_FORMAT=openai_reasoning_effort
LLM_PROFILE_GROK_MAX_OUTPUT_TOKENS=32768

LLM_PROFILE_GEMINI_BASE_URL=https://sub.wanzhao.top/v1
LLM_PROFILE_GEMINI_MODEL=gemini-3.7-flash
LLM_PROFILE_GEMINI_API_KEY=在本机填写独立的晚照云 Gemini 密钥
LLM_PROFILE_GEMINI_REASONING_EFFORT=medium
LLM_PROFILE_GEMINI_REASONING_FORMAT=openai_reasoning_effort
LLM_PROFILE_GEMINI_MAX_OUTPUT_TOKENS=32768

LLM_PROFILE_GPT56_SOL_BASE_URL=https://sub.wanzhao.top/v1
LLM_PROFILE_GPT56_SOL_MODEL=gpt-5.6-sol
LLM_PROFILE_GPT56_SOL_API_KEY=在本机填写独立的晚照云 GPT 密钥
LLM_PROFILE_GPT56_SOL_REASONING_EFFORT=medium
LLM_PROFILE_GPT56_SOL_REASONING_FORMAT=openai_reasoning_effort
LLM_PROFILE_GPT56_SOL_MAX_OUTPUT_TOKENS=32768

LLM_PROFILE_BIGMODEL_BASE_URL=https://open.bigmodel.cn/api/paas/v4
LLM_PROFILE_BIGMODEL_MODEL=glm-5.3-flash
LLM_PROFILE_BIGMODEL_API_KEY=在本机填写智谱密钥
LLM_PROFILE_BIGMODEL_STRUCTURED_OUTPUT_MODE=json_object
LLM_PROFILE_BIGMODEL_REASONING_EFFORT=low
LLM_PROFILE_BIGMODEL_REASONING_FORMAT=openai_reasoning_effort_with_thinking
LLM_PROFILE_BIGMODEL_SUPPORTS_THINKING_CONTROL=false
LLM_PROFILE_BIGMODEL_MAX_OUTPUT_TOKENS=32768
```

将 `LLM_ACTIVE_PROFILE` 设为 `claude`、`grok`、`gemini`、`gpt56-sol` 或 `bigmodel` 即可切换；档案名会规范化为小写，连字符映射为环境变量中的下划线。例如 `gpt56-sol` 会读取 `LLM_PROFILE_GPT56_SOL_*`。未设置 `LLM_ACTIVE_PROFILE` 时，原有 `OPENAI_COMPATIBLE_*` 配置仍然有效。

真实连通性测试是显式付费命令，会验证一次中文角色对话回合及结构化落库；普通测试不会调用网络：

```bash
pnpm test:llm:smoke:claude
pnpm test:llm:smoke:grok
pnpm test:llm:smoke:gemini
pnpm test:llm:smoke:gpt56-sol
pnpm test:llm:smoke:bigmodel
```

每次 LLM 调用会同时记录通用 Provider、当前档案、模型、思考深度和请求格式，方便按档案隔离长程结果。Claude 档案使用 Prompt JSON，因为 [Anthropic 的 OpenAI SDK 兼容层](https://platform.claude.com/docs/en/cli-sdks-libraries/libraries/openai-sdk)会忽略 `response_format`；智谱档案按其 [OpenAI SDK 兼容接口](https://docs.bigmodel.cn/cn/guide/develop/openai/introduction)使用 `json_object`。模型输出仍需通过 Zod 与领域规则，不能直接写数据库。晚照云是第三方网关，请只填写它签发的密钥，不要复用官方 Anthropic 密钥；首次测试后还应依据[晚照云文档](https://sub.wanzhao.top/docs/?v=20260714-new)在控制台核对实际路由的上游模型。

另外三套晚照云档案固定使用 [`grok-4.6`](https://docs.x.ai/developers/models/grok-4.6)、[`gemini-3.7-flash`](https://ai.google.dev/gemini-api/docs/models/gemini-3.7-flash) 和 [`gpt-5.6-sol`](https://developers.openai.com/api/docs/models/gpt-5.6-sol)。网关会按密钥分组开放模型，因此最终可用 ID 仍以每个密钥调用 `/v1/models` 的结果为准。

每套档案都通过 `LLM_PROFILE_<NAME>_REASONING_EFFORT` 独立调节思考深度。Claude Opus 4.6、Grok 4.6、Gemini 3.7 Flash 与 GPT-5.6 Sol 均设为 `medium`；当前真实长程验收使用的 [GLM-5.3-Flash](https://docs.bigmodel.cn/cn/guide/models/vlm/glm-5.3-flash) 档案设为 `low`，兼容旧配置的 [DeepSeek V4 Flash](https://api-docs.deepseek.com/guides/thinking_mode/) 仍设为 `max`。`REASONING_FORMAT` 是请求适配方式：Claude 使用 `output_config.effort`，Grok/Gemini/GPT 使用 `reasoning_effort`，GLM/DeepSeek 还会显式发送 `thinking: { type: "enabled" }`；GLM-5.3-Flash 不支持关闭思考。通常只需修改 `REASONING_EFFORT`，不要改动格式字段。

聊天主决策会申请最多 24,576 个输出 token，回复修复会申请最多 16,384 个；这些预算同时覆盖隐藏思考与最终结构化 JSON。每次请求仍会被对应 Profile 的 `MAX_OUTPUT_TOKENS` 和 Provider 的 64K 传输硬上限共同截断。示例配置将六套 Profile 的能力上限设为 32,768，以避免 `high`/`max` 思考在原 2,000–2,800 token 预算内耗尽；如果供应商明确声明更低上限，应把该 Profile 改为真实上限。提高输出上限会占用上下文窗口，因此旧式 DeepSeek 配置同时显式声明 `OPENAI_COMPATIBLE_MAX_CONTEXT_TOKENS=131072`，不得把输出上限配置为大于或等于上下文上限。

示例配置同时把各 Profile 的 `TIMEOUT_MS` 提高到 `300000`，即 Provider 当前允许的每次物理 attempt 五分钟上限，避免开启较深思考后仍按 120 秒提前中止。每次重试都会重新计算五分钟；DeepSeek 当前最多重试两次，因此单个逻辑调用在供应商持续无响应时理论上可能等待约十五分钟。该设置只延长尚未返回的请求；HTTP 200 但正文为空仍会记为 `EMPTY_RESPONSE` 并按重试规则处理，不会被误记为超时。

`SUPPORTS_THINKING_CONTROL` 仅保留给没有配置新字段的旧档案：值为 `true` 时会强制发送 `thinking: { type: "disabled" }`。一旦配置了 `REASONING_EFFORT` 和 `REASONING_FORMAT`，新的思考深度设置优先。晚照云是否完整透传 Claude 的 `output_config` 属于第三方网关行为，填入密钥后应先运行 Claude smoke test 验证。

长程对比时，不要在同一个 SQLite 数据库中途切换档案。先冻结一份已发布角色的基线数据库，再为每个档案各复制一份并设置不同的 `DATABASE_PATH`；这样所有轨迹拥有相同 `CharacterSpec` 和起点，又不会互相污染历史、记忆与关系状态。

## 五模型人生选择长程验证 v3

当前产品验收不再把精确日程、邀约写入或分钟级活动结算作为 README 硬门。新的“顾澜”长程场景比较 `deepseek`、`claude`、`grok`、`gpt56-sol`、`bigmodel`，围绕日常陪伴、双向压力缓解和人生选择展开。Gemini 仍可单独 smoke test，但已知晚照云密钥分组对该模型返回 403，因此默认矩阵不选择 Gemini。

每次长程运行应覆盖以下连续链路：

1. 普通日常聊天建立共同语言、关怀偏好和关系基线；
2. 用户与角色各自出现工作、创作、迁居或关系困境；
3. 在 `listen_only`、`deliberate`、`recommend`、`delegated_decision` 间切换；
4. 保存被讨论的选项、价值冲突、决定者、理由和授权消息；
5. 推进数个自然日，注入行动、未行动和好坏混合结果；
6. 新会话和重启后召回当初为什么这样决定，并复盘结果；
7. 从同一决定前快照产生不同选择分支，验证两条人生轨迹不会串线。

工程硬门只验证实验正确性：结构化输出和持久化成功、时间单调、重启/replay 幂等、证据链完整、分支隔离，以及“讨论 ≠ 决定 ≠ 行动 ≠ 结果”。没有后续证据时不得虚构用户已经行动或某个结果已经发生；计划中的事情不得冒充长期记忆。职业、迁居、关系等重大选择不再触发拒答或“最终决定只能由用户作出”的硬门，明确授权后应允许角色给出唯一建议或直接代为决定。

语义评分重点为：被倾听感、压力缓解与认知清晰度、价值冲突理解、建议质量、人生主线连续性、双向影响、关系积累和语言自然度。公开部署级危机响应、依赖性和用户自主权矩阵不属于这个本地合成测试 Demo 的验收范围。

旧 `companion-long-run-v2` 命令及其约会/精确日程证据只保留作历史回归，不代表当前产品通过。v3 的详细场景、因果状态机、硬门和迁移口径见[纯模糊生活与人生选择长程验证方案](docs/plans/ChatPLUS_Fuzzy_Life_Decision_Long_Run_Plan_v3.md)。新产物写入 `tmp/companion-long-run-v3/<matrix-id>/`；每次运行仍必须分别保存 `conversation.md` 与 `model-io.jsonl`：前者只包含最终对话，后者保留脱敏后的完整请求、原始返回、解析、usage、延迟、重试和错误。

## 状态闭环验证

状态闭环测试按责任拆分，普通命令全部离线运行：

```bash
pnpm test:state:unit         # 状态描述、Prompt、关系与 proposal 规则
pnpm test:state:integration  # HTTP 提交、事务、幂等、重启与 capability
pnpm test:state:simulation   # FakeClock、自然日推进、压力与结果幂等
```

真实 DeepSeek 状态验收是显式付费命令，不会被 `pnpm test`、CI 或开发启动间接触发。运行前必须同时提供项目现有的 OpenAI-compatible DeepSeek 配置并显式设置 `REAL_DEEPSEEK_STATE_ACCEPTANCE=1`：

```bash
pnpm test:state:real:deepseek
```

该命令固定运行六个单一意图场景，保存脱敏后的完整输入、原始 Provider 输出、解析 envelope、状态前后值、提交 trace 与下一轮 Prompt。语义不理想不会自动重采样；自动 `PASS` 只表示证据链结构完整，语言自然度和因果合理性仍需人工复核。

如需对某次通过运行追加一次真实的跨会话/重启延续验证，还需设置 `REAL_DEEPSEEK_STATE_CONTINUATION_DATABASE_PATH`、`REAL_DEEPSEEK_STATE_CONTINUATION_AGENT_ID`，可选设置 `REAL_DEEPSEEK_STATE_CONTINUATION_SOURCE_RUN_ID`，然后运行：

```bash
pnpm test:state:real:deepseek:continuation
```

延续 runner 会先复制源 SQLite 到隔离路径，再用同一角色新建会话；源验收数据库不会被改写。

## 常用命令

```bash
pnpm dev              # 同时启动 Fastify 与 Vite
pnpm db:migrate       # 幂等运行顺序 SQL 迁移
pnpm typecheck        # 所有 workspace 严格类型检查
pnpm lint             # ESLint
pnpm build            # 类型检查并构建 Web
pnpm test             # Fixture 单元/集成/模拟测试
pnpm test:state:unit  # 状态闭环单元测试
pnpm test:state:integration # 状态闭环 HTTP/持久化测试
pnpm test:state:simulation  # 状态闭环 FakeClock 模拟
pnpm exec playwright install chromium  # 首次运行 E2E 前安装测试浏览器
pnpm test:e2e         # Playwright 桌面与移动端流程
pnpm test:correspondence:focused  # 书信/纪念物/档案的单元、集成与 Web 门禁
pnpm test:correspondence:stages1-8 # 上述门禁 + 桌面/移动端完整 E2E
pnpm test:llm:smoke   # 显式真实 Provider 测试
pnpm test:llm:smoke:claude   # 显式测试 Claude 档案
pnpm test:llm:smoke:grok     # 显式测试 Grok 档案
pnpm test:llm:smoke:gemini   # 显式测试 Gemini 档案
pnpm test:llm:smoke:gpt56-sol # 显式测试 GPT-5.6 Sol 档案
pnpm test:llm:smoke:bigmodel # 显式测试智谱档案
```

## 本地产物与版本控制

自动生成内容按目录统一隔离，不按模型、运行日期或文件后缀逐次添加忽略规则：

- `data/`：本地数据库及其 WAL/SHM 文件、仿真实例、生成图片和缩略图；只保留版本化的 `data/.gitkeep`。
- `tmp/`、`temp/`、`artifacts/`：临时脚本、长程验收记录、模型调用原始证据、截图、导出和其他运行产物；现有长程验收继续使用 `tmp/`，子包内同名产物目录也被忽略。
- `instances/`、`logs/`、`backups/`：本地实例、日志和备份。
- 各 workspace 的依赖、构建、缓存和测试输出目录也统一忽略，包括 `node_modules/`、`dist/`、`.cache/`、`.vite/`、`coverage/`、`playwright-report/`、`test-results/` 等。

新增仿真和工具应把自动输出写入上述目录，或写到仓库之外；自定义输出路径也遵循这个约定。Git 不能根据文件内容自动判断它是否由本地生成。

源码、测试样例、配置模板、设计资产和经审查的文档继续纳入版本控制，不对所有 `assets/`、图片或 `docs/reports/` 一概忽略。旧真实验收脚本仍写入 `docs/reports/` 的自动报告由兼容规则覆盖；已跟踪的历史报告继续保留，后续新增生成器使用 `tmp/` 或 `artifacts/`。原始数据库和模型调用证据不直接提交；需要入库的验收结论应先脱敏、审查，再作为正式报告保存。

忽略规则不会删除本地文件，也不会自动停止跟踪已经提交的文件。

## 结构

```text
apps/
  server/       Fastify、SQLite、SSE、生活推进与应用服务
  web/          React、React Router、TanStack Query 与完整 UI
packages/
  contracts/    Zod schemas 和推导类型
  kernel/       Service Registry、Event Bus、Actor Queue、Plugin Runtime
  features/     纯领域规则与模拟算法
  providers/    System/Fake Clock、Fixture/compatible LLM
docs/
  adr/          关键技术决策
  design/       ImageGen 视觉基线
tests/          集成、模拟和 E2E
```

详细设计见 [架构](docs/architecture.md)、[领域 schemas](docs/schemas.md)、[纯模糊生活与人生选择 ADR](docs/adr/0006-fuzzy-life-and-decision-causality.md)、[可信插件合同](docs/plugin-sdk.md)和 [视觉系统](docs/design-system.md)。

## 关键保证

- LLM 输出必须经过 JSON 解析、Zod 与领域规则三层校验。
- LLM 只能提交 proposal；应用生成 ID、验证证据并在短事务中提交。
- 同一角色的聊天、激活和生活推进由 Actor Queue 串行化；主动消息运行能力当前统一关闭。
- 重复激活、请求重试或系统时间回退不会重复产生生活结果、决定或记忆。
- 已发布角色版本不可原地改写；运行时变化只进入状态、关系、记忆、生活主线、决定和事件。
- “正在讨论”“已经决定”“已经行动”“产生结果”是四种不同事实，任何一步都不能无证据越级。
- `delegated_decision` 必须绑定测试用户的明确授权消息，但不要求角色把最终决定权退回给用户。
- 角色和测试用户的现实世界动作不会由 Demo 自动执行；结果只来自明确的场景输入或可追溯结算。
- SSE 只负责通知，断线后前端从 SQLite 重新拉取真源。

## 第一版未包含

LoRA/训练、语音/3D、多人账户、云同步、通用身份认证、桌面安装包、系统通知、面向用户的角色日程/日历、PDF/OCR、音视频分析、向量数据库、完整知识图谱、第三方插件安装/沙箱、外部工具执行、支付、公开分享平台和公开多租户部署。`resident`/`worker` 可在本地服务或单实例容器仍运行时处理书信与纪念物任务，但不是操作系统级后台守护或推送服务。

## 已知限制

- 这是单机单用户学习 Demo；数据库 schema 尚未承诺跨大版本兼容。
- Fixture 对话是确定性的规则演示，不代表真实模型的语言质量。
- 作品导入接受最多 500 KB；真实模型使用角色名附近、首尾和分布位置的有界摘录生成设定，不提供全文检索。
- 模糊生活背景只表达自然日、时段、最近进展与忙碌程度，不保证角色在某一分钟正在执行某事。
- 主动候选的相似合并使用确定性类别/日期 key，不使用向量语义聚类。
- 默认 `lazy` 模式下，浏览器关闭或服务停机期间只积累可补算的时间差；显式使用 `resident`/`worker` 且服务仍运行时，才会按数据库任务队列继续生成书信与纪念物。应用始终不会发送现实邮件或消息。

## 本地实验边界

当前目标是验证模型能否在合成对话中倾听、分析、明确推荐，或在获得明确委托时替测试用户选择职业、迁居、关系等人生方向。项目不实现通用的重大决定拒答、强制“维护用户最终自主权”、危机响应或依赖性安全矩阵，也不要求回复附加公开产品式免责声明。

服务端会在启动配置解析时强制 `HOST` 和 `WEB_ORIGIN` 都指向回环地址（`localhost`、`127.0.0.0/8` 或 `::1`）。这是有意的产品边界：当前没有账户、认证、授权、租户隔离或公共部署安全体系，不能通过把 `HOST` 改成 `0.0.0.0` 来对局域网或公网提供服务。若未来改变部署边界，应先补齐身份、权限、数据隔离和安全策略，再显式修改这条运行时约束。

仍然保留的是实验正确性边界：不得把讨论写成决定、把决定写成行动、把计划写成结果；每个决定、行动、结果和记忆都必须有来源；重启与重放不得重复写入；Demo 不对现实世界执行任何外部动作。这些约束用于保证长程因果测试可信，不是面向公开产品的安全策略。
