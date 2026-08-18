# PersonaSim 第一版 MVP 开发计划书

> **项目愿景**
>
> **他们的人生不会因为你离开而停止，却会因为你来过而发生改变；你的人生也同样如此。**

版本：`MVP v1.0`  
用途：本地运行、产品验证与学习  
目标读者：Codex、项目开发者、后续插件开发者  
默认语言：中文  
默认时区：`Asia/Tokyo`

---

## 0. 给 Codex 的执行指令

你是本项目的主程。请在当前目录中从零创建一个可以本地运行的完整应用，不要只输出架构说明、伪代码或空壳页面。

完成后必须能够执行：

```bash
pnpm install
pnpm db:migrate
pnpm dev
pnpm test
pnpm test:e2e
```

开发过程中遵守以下要求：

1. 使用 TypeScript 严格模式。
2. 同时实现前端、后端、SQLite 数据库、测试和 README。
3. 默认提供不需要 API Key 的 Fixture LLM，使项目克隆后可以直接演示。
4. 配置真实大模型 API 后，可以切换到 OpenAI-compatible Provider。
5. 每完成一个里程碑后运行类型检查和测试。
6. 不要把所有代码写在少数几个超大文件中。
7. 不要使用未经校验的 LLM JSON 输出。
8. 不要让 LLM 直接修改数据库。LLM 只能提交结构化 proposal，由程序校验并提交。
9. 遇到未明确的细节，按照本计划书中的默认值实现，不要中断开发询问。
10. 将重要技术选择记录在 `docs/adr/` 中。
11. 不保存或要求模型输出隐藏思维过程。仅保存简短的 `reasonCode` 和不超过 240 字符的行为说明。
12. 交付时在 README 中列出已完成能力、未完成能力和已知限制。
13. 项目的所有关键功能都必须服务于以下四条设计准则：
    - 时间会推进；
    - 互动有后果；
    - 关系会积累；
    - 变化可追溯。
14. 遇到功能取舍时，优先实现能够增强角色时间连续性、互动因果性和关系积累的能力。
15. 不得通过虚假声称应用关闭期间模型持续运行来制造拟真感。关闭期间采用延迟结算，重新打开后批量计算。

项目暂定名称：

```text
PersonaSim
```

仓库目录名：

```text
persona-sim
```

---

# 1. 项目愿景与 North Star

## 1.1 项目愿景

PersonaSim 的目标，是构建具有时间连续性、关系记忆和有限自主性的 AI 虚拟角色。

角色的生活不会因为用户离开应用而失去连续性。用户的到来和互动，会对角色之后的计划、状态、记忆和选择产生持久影响；角色的经历、回应和主动行为，也会反过来参与用户自己的生活叙事。

项目标语：

> **他们的人生不会因为你离开而停止，却会因为你来过而发生改变；你的人生也同样如此。**

## 1.2 四条核心产品原则

### 原则一：时间会推进

角色不是只在用户发出消息时才“存在”。角色拥有：

- 自己的日程；
- 未完成的目标；
- 活动结果；
- 当前精力、压力、情绪和社交状态；
- 可以在未来被提及的经历；
- 对未来 72 小时的计划。

应用关闭期间不持续调用模型。用户重新打开应用时，系统依据上次结算时间和当前系统时间，批量推演期间发生的活动。

### 原则二：互动有后果

用户的输入不能只成为一次性聊天上下文。它应当可能改变：

- 角色是否接受某个邀请；
- 尚未开始的日程；
- 角色的情绪与精力；
- 角色对用户的信任和亲密度；
- 后续会主动提起的话题；
- 角色和用户之间形成的共同经历；
- 角色未来的计划与承诺。

重要变化必须被持久化，而不是在下一次会话中丢失。

### 原则三：关系会积累

角色对用户的反应，应该随着互动历史发生有限、渐进、可解释的变化。

关系变化包括：

- 亲密度；
- 信任度；
- 熟悉度；
- 最近互动倾向；
- 共同经历；
- 尚未完成的承诺；
- 用户的重要偏好和目标。

角色不应无条件迎合用户。人格、目标、硬边界和既有承诺仍然高于普通邀请和临时要求。

### 原则四：变化可追溯

角色发生的重要变化应当可以回答：

```text
发生了什么
→ 角色如何理解
→ 哪些人格、目标、状态或关系因素参与了决策
→ 哪些日程、状态、记忆或关系发生了变化
→ 变化如何影响后续对话
```

所有重要变化必须通过领域事件保存，并包含：

```text
correlation_id
causation_id
source_message_id
source_event_id
idempotency_key
```

## 1.3 North Star 验证闭环

第一版 MVP 必须完整证明以下四条链路：

### 闭环 A：离开后时间继续推进

```text
用户离开应用
→ 时间经过
→ 用户再次打开应用
→ 系统完成离线结算
→ 角色的日程、经历和状态发生合理变化
```

### 闭环 B：用户影响角色未来

```text
用户提出邀请或建议
→ 角色依据人格、关系、状态和既有日程作出决定
→ 未开始的日程被保留、移动、替换或取消
→ 新活动被执行或未执行
→ 后续对话能够记得这次影响
```

### 闭环 C：角色形成自己的经历

```text
角色完成重要活动
→ 形成活动结果和长期记忆
→ 产生可分享事件
→ 在适当时间主动与用户分享
```

### 闭环 D：角色反向影响用户

```text
用户曾表达目标、困扰或承诺
→ 系统筛选并保存为记忆
→ 角色在后续相关情境中自然提起
→ 角色可以支持、提醒、质疑或表达不同意见
```

---

# 2. 产品目标

构建一个本地运行的 AI 虚拟角色对话 Demo。

用户可以：

1. 通过最低限度表单创建原创角色。
2. 通过粘贴文本或导入文本文件，生成作品角色。
3. 查看、编辑、删除和锁定生成的人格字段。
4. 激活角色并生成未来 72 小时日程。
5. 与角色进行对话。
6. 通过对话邀请、建议或影响角色，使角色根据人格决定是否修改未来日程。
7. 在重新打开角色页面时，对离线期间经过的日程进行一次性结算。
8. 应用保持打开时，每个自然整点执行一次状态结算。
9. 在拟真模式下，角色可以基于已经完成的重要活动主动发起对话。
10. 查看角色的计划、实际活动、状态变化、记忆和决策因果。
11. 使用 FakeClock 快速验证时间推进和离线结算。

第一版的“人格模型”不是 LoRA 权重，而是：

```text
结构化 CharacterSpec
＋运行状态 RuntimeState
＋未来日程 ScheduleItem
＋实际活动 ActivityEvent
＋长期记忆 Memory
＋关系状态 RelationshipState
＋领域事件 DomainEvent
```

基础大模型负责：

```text
生成角色草稿
生成日程草稿
生成语言回复
提出行为和日程修改 proposal
为重要活动生成叙事结果
```

本地程序负责：

```text
读取系统时间
维护状态
验证日程
执行结算
保存数据
控制权限
保证幂等
记录因果
决定 proposal 是否提交
```

---

# 3. 产品定位与非目标

## 3.1 产品定位

PersonaSim 不是普通角色提示词聊天应用，也不是持续运行的后台世界模拟器。

它是一个：

> **本地运行、事件驱动、按系统时间推进、通过延迟结算模拟角色生活的 AI 对话系统。**

系统包含三个循环：

```text
角色编译循环：
表单或作品资料 → 结构化角色模型

会话循环：
用户消息 → 角色决策 → 回复及世界影响

模拟循环：
系统时间推进 → 日程结算 → 状态、记忆及主动对话
```

## 3.2 第一版非目标

第一版不追求：

- 训练 LoRA；
- 完整复制真实人物；
- 分钟级持续生活模拟；
- 应用关闭后的实时后台运行；
- 对外公开服务；
- 第三方插件市场；
- 多人在线世界；
- 角色拥有无限自主权限；
- 角色自动访问用户文件、邮件、日历或社交账户；
- 语音克隆、面貌克隆或真人冒充；
- 完整知识图谱；
- 复杂多 Agent 社会模拟。

---

# 4. 模拟等级

所有等级共用同一套领域模型，通过 capability 开关控制。

```ts
type SimulationTier =
  | 'lightweight'
  | 'daily'
  | 'high_fidelity';
```

```ts
interface SimulationCapabilities {
  schedule: boolean;
  offlineSettlement: boolean;
  dynamicState: boolean;
  longTermMemory: boolean;
  relationshipDynamics: boolean;
  proactiveDialogue: boolean;
  behaviorVerification: boolean;
}
```

## 4.1 轻量化模拟

包含：

```text
结构化角色人格
普通角色对话
少量记忆
静态关系设定
```

不包含：

```text
72 小时日程
离线结算
整点结算
动态关系变化
主动对话
```

## 4.2 日常模拟

包含：

```text
轻量化模拟全部能力
72 小时日程
启动时离线结算
整点结算
动态状态
长期记忆
用户影响未开始日程
简单关系变化
```

不包含默认主动消息。

## 4.3 拟真模拟

包含：

```text
日常模拟全部能力
重要活动叙事化
完整关系变化
主动对话候选
角色主动分享
Persona Guard
行为一致性验证
```

---

# 5. MVP 必须完成的核心用户流程

## 5.1 创建原创角色

用户填写：

```text
角色名称
世界背景
社会身份或职业
三个核心性格
一个核心矛盾
主要目标
角色与用户的初始关系
语言风格
模拟等级
时区
```

点击“生成角色”后：

1. 后端调用 Character Compiler。
2. LLM 返回结构化 `CharacterSpecDraft`。
3. 使用 Zod 校验。
4. 保存为草稿版本。
5. 打开角色编辑器。
6. 用户可以修改、删除和锁定可编辑字段。
7. 用户点击“发布并激活”。
8. 日常模式和拟真模式自动生成未来 72 小时日程。
9. 创建初始 `RuntimeState`、`RelationshipState` 和 `SimulationCursor`。

## 5.2 导入作品角色

第一版仅支持：

```text
直接粘贴文本
.txt
.md
.srt
```

用户填写：

```text
角色名称
作品名称
角色所处剧情阶段
模拟等级
时区
```

导入限制：

```text
单次输入最大 500 KB
不实现 PDF
不实现 OCR
不实现视频或音频解析
不实现完整知识图谱
不实现向量数据库
```

后端从材料中抽取：

```text
身份事实
主要经历
语言风格
价值倾向
行为选择
重要关系
知识边界
已知矛盾
```

所有字段必须标记来源：

```ts
type FieldOrigin =
  | 'user_spec'
  | 'canon_extract'
  | 'model_inference'
  | 'synthetic_extension'
  | 'runtime_simulation';
```

运行时新经历只能进入 `runtime_simulation` 层，不得变成作品正典。

## 5.3 编辑角色

角色编辑器至少包含：

```text
基础身份
人格与价值观
语言风格
关系
日常习惯
日程策略
知识与边界
主动对话
高级 JSON
版本历史
```

核心字段支持：

```text
编辑
删除
锁定
恢复默认
查看来源
```

高级 JSON 页面必须：

1. 显示完整 `CharacterSpecDraft`。
2. 支持编辑。
3. 保存前执行 Zod 校验。
4. 显示具体错误路径。
5. 不允许编辑数据库主键、版本号和时间戳。

## 5.4 与角色聊天

聊天页面显示：

```text
消息列表
消息输入框
角色名称
AI 虚拟角色标识
模拟等级
角色当前本地时间
当前活动
未来 24 小时简化日程
当前状态
```

每个用户回合：

```text
用户消息
→ 必要时先结算时间
→ 加载人格、状态、日程、关系、记忆和最近消息
→ 调用 LLM
→ 获得回复及结构化 proposal
→ 后端校验 proposal
→ 原子保存回复、日程修改、状态变化、关系变化和记忆
→ 返回结果
```

## 5.5 用户影响角色日程

必须支持演示场景：

```text
角色原计划今天 18:00—21:00 自习。
用户在下午邀请角色今晚参加晚会。
角色根据人格、关系、状态和已有日程决定：
接受、拒绝或提出折中方案。
```

如果接受：

```text
创建晚会日程
移动、缩短或取消自习日程
保存用户邀请和角色决策之间的因果关系
后续结算生成真实活动结果
```

模型只能返回 proposal：

```ts
interface ScheduleEffectProposal {
  operation: 'create' | 'reschedule' | 'cancel';
  itemId?: string;
  item?: ScheduleItemDraft;
  newStartAtUtc?: string;
  newEndAtUtc?: string;
  reasonCode: string;
  reasonSummary: string;
}
```

后端必须验证：

```text
时间是否合法
是否与 fixed 日程冲突
被移动项目是否允许移动
新活动是否超过每日承诺上限
睡眠时间是否被严重破坏
修改是否只影响未来日程
回复陈述是否与实际提交一致
```

回复和日程修改必须属于同一个逻辑事务。

## 5.6 离线结算

角色页面每次打开时调用：

```text
POST /api/agents/:agentId/activate
```

服务器比较：

```text
SimulationCursor.lastSettledAtUtc
当前系统时间
```

一次性结算这个区间内的日程。

要求：

1. 不逐小时回放。
2. 同一区间重复执行不会产生重复事件。
3. 使用幂等键。
4. 应用关闭期间不持续调用 LLM。
5. 重新打开后一次性批量结算。
6. 已完成活动不得因系统时间回退而恢复。
7. 日程状态、活动事件、角色状态、记忆和游标在同一事务中更新。
8. 结算后角色在用户界面中表现为“期间真实经历了这些事情”，但系统不得声称模型持续在后台运行。

## 5.7 整点结算

Web 页面保持打开时：

1. 浏览器通过 SSE 与服务器保持连接。
2. 服务器记录当前活跃角色。
3. 只对活跃角色执行整点结算。
4. 定时器对齐自然整点。
5. 系统休眠恢复后只进行一次补偿结算。
6. 不为每个错过的小时分别调用 LLM。
7. 用户发送消息前检查是否存在尚未结算的整点区间。

## 5.8 拟真模式主动对话

仅 `high_fidelity` 模式启用。

重要活动结算后可以生成 `ProactiveCandidate`：

```text
旅行
聚会
比赛
重要学习任务
特殊工作任务
冲突
和解
目标完成
计划失败
```

规则：

1. 应用关闭期间不发送消息。
2. 页面重新打开后最多发送一条最重要候选。
3. 相似候选合并。
4. 每个角色每天最多主动发起两次。
5. 默认静默时间为角色本地时间 23:00—08:00。
6. 候选必须有有效期。
7. 主动消息作为普通 assistant 消息保存。
8. 前端通过 SSE 接收。
9. 主动消息必须关联触发活动。
10. 主动行为不得通过内疚、威胁或虚假紧急性诱导用户依赖。

## 5.9 角色记住用户

当用户明确表达以下内容时，模型可以提出记忆候选：

```text
用户的长期目标
用户的稳定偏好
用户的重要计划
用户的困扰
用户和角色之间的承诺
共同经历
```

记忆候选由后端校验后写入。

禁止自动保存：

```text
密码
认证信息
银行卡信息
精确住址
未确认的第三方敏感信息
用户仅用于假设或角色扮演的陈述
```

---

# 6. MVP 范围

## 6.1 第一版包含

```text
单个本地用户
多个角色
一次主要与一个角色聊天
原创角色生成
作品角色文本导入
结构化人格编辑器
角色版本管理
普通聊天
72 小时滚动日程
启动时离线结算
整点结算
用户消息影响日程
基本长期记忆
基本关系状态
动态角色状态
拟真模式主动对话
SQLite 持久化
Fixture LLM
OpenAI-compatible LLM Provider
开发者调试页面
插件化内部架构
单元测试
集成测试
E2E 测试
```

## 6.2 第一版明确不包含

```text
LoRA 或模型训练
语音合成
声音克隆
图片生成
3D 角色
多人账户
云端同步
公开部署
移动端原生应用
桌面安装包
后台系统通知
应用关闭后的实时运行
任意第三方插件安装
插件沙箱
插件市场
PDF 和 OCR
视频分析
音频分析
复杂向量数据库
完整知识图谱
支付
身份认证
社交功能
外部工具执行
邮件和日历操作
```

---

# 7. 推荐技术栈

使用 pnpm workspace。

## 7.1 前端

```text
React
Vite
TypeScript
React Router
TanStack Query
Zod
CSS Modules 或原生 CSS
```

## 7.2 后端

```text
Node.js
Fastify
TypeScript
Zod
better-sqlite3
Luxon
Server-Sent Events
```

## 7.3 测试

```text
Vitest
Playwright
Fixture LLM Provider
FakeClock Provider
临时 SQLite 数据库
```

## 7.4 代码质量

```text
ESLint
Prettier
TypeScript strict
API 边界全部使用 Zod
无未处理 Promise
```

---

# 8. 系统架构

```text
┌──────────────────────────────────────────┐
│ React Web                                │
│                                          │
│ 角色生成器  角色编辑器  Chat  Timeline   │
│ 状态侧栏    Developer Console            │
└────────────────────┬─────────────────────┘
                     │ HTTP + SSE
┌────────────────────▼─────────────────────┐
│ Fastify Local Host                       │
│                                          │
│ Plugin Runtime                           │
│ Service Registry                         │
│ Typed Event Bus                          │
│ Agent Actor Queue                        │
│ HTTP / SSE Gateway                       │
└───────────────┬──────────────────────────┘
                │
     ┌──────────▼──────────┐
     │ Conversation Engine │
     │ Persona Guard       │
     │ Prompt Assembler    │
     └──────────┬──────────┘
                │
     ┌──────────▼──────────┐
     │ Simulation Engine   │
     │ Clock               │
     │ Schedule            │
     │ Settlement          │
     │ State               │
     │ Proactive           │
     └──────────┬──────────┘
                │
┌───────────────▼──────────────────────────┐
│ SQLite                                   │
│                                          │
│ Character Versions                       │
│ Messages                                  │
│ Domain Events                             │
│ Schedule Projections                      │
│ Activity Events                           │
│ Runtime State                             │
│ Memory                                    │
│ Relationship                              │
│ LLM Call Log                              │
└────────────────────┬─────────────────────┘
                     │
┌────────────────────▼─────────────────────┐
│ LLM Providers                            │
│ Fixture / OpenAI-compatible              │
└──────────────────────────────────────────┘
```

---

# 9. 项目目录

```text
persona-sim/
├── apps/
│   ├── server/
│   │   ├── src/
│   │   │   ├── bootstrap.ts
│   │   │   ├── app.ts
│   │   │   ├── config.ts
│   │   │   ├── http/
│   │   │   ├── sse/
│   │   │   ├── db/
│   │   │   │   ├── migrations/
│   │   │   │   ├── migrate.ts
│   │   │   │   └── connection.ts
│   │   │   └── profiles/
│   │   └── package.json
│   │
│   └── web/
│       ├── src/
│       │   ├── app/
│       │   ├── pages/
│       │   │   ├── CharacterLibraryPage.tsx
│       │   │   ├── CharacterGeneratorPage.tsx
│       │   │   ├── CharacterImportPage.tsx
│       │   │   ├── CharacterEditorPage.tsx
│       │   │   ├── ChatPage.tsx
│       │   │   ├── TimelinePage.tsx
│       │   │   ├── SettingsPage.tsx
│       │   │   └── DeveloperPage.tsx
│       │   ├── components/
│       │   ├── api/
│       │   ├── hooks/
│       │   ├── styles/
│       │   └── main.tsx
│       └── package.json
│
├── packages/
│   ├── contracts/
│   │   └── src/
│   │       ├── character.ts
│   │       ├── schedule.ts
│   │       ├── state.ts
│   │       ├── memory.ts
│   │       ├── relationship.ts
│   │       ├── turn.ts
│   │       ├── events.ts
│   │       ├── llm.ts
│   │       └── plugin.ts
│   │
│   ├── kernel/
│   │   └── src/
│   │       ├── plugin-runtime.ts
│   │       ├── service-registry.ts
│   │       ├── event-bus.ts
│   │       ├── actor-queue.ts
│   │       ├── logger.ts
│   │       └── errors.ts
│   │
│   ├── providers/
│   │   ├── clock-system/
│   │   ├── clock-fake/
│   │   ├── llm-fixture/
│   │   ├── llm-openai-compatible/
│   │   └── storage-sqlite/
│   │
│   └── features/
│       ├── character-store/
│       ├── character-compiler/
│       ├── character-import/
│       ├── conversation-engine/
│       ├── prompt-assembler/
│       ├── persona-guard/
│       ├── schedule-planner/
│       ├── schedule-validator/
│       ├── settlement-engine/
│       ├── state-engine/
│       ├── memory-engine/
│       ├── relationship-engine/
│       ├── proactive-dialogue/
│       ├── audit-log/
│       └── cost-meter/
│
├── bundles/
│   ├── core.ts
│   ├── lightweight.ts
│   ├── daily.ts
│   └── high-fidelity.ts
│
├── fixtures/
│   ├── characters/
│   ├── llm/
│   └── imports/
│
├── tests/
│   ├── integration/
│   ├── simulation/
│   └── e2e/
│
├── docs/
│   ├── architecture.md
│   ├── product-principles.md
│   ├── plugin-sdk.md
│   ├── schemas.md
│   └── adr/
│
├── data/
│   └── .gitkeep
├── .env.example
├── package.json
├── pnpm-workspace.yaml
├── tsconfig.base.json
└── README.md
```

---

# 10. 核心领域原则

## 10.1 计划不等于事实

```text
ScheduleItem：
角色打算在 18:00—21:00 自习。

ActivityEvent：
角色实际在 18:10 开始自习，
20:20 因疲劳提前结束，
完成计划约 70%。
```

计划和实际活动必须使用不同数据对象。

## 10.2 稳定人格不等于运行状态

```text
CharacterSpec：
长期人格、价值观、目标、偏好、边界和习惯。

RuntimeState：
当前情绪、精力、压力、社交电量、专注度和当前活动。
```

用户不能通过一条消息直接重写不可变人格。

## 10.3 模型只能提议，程序负责提交

```text
LLM 输出 proposal
→ Zod 校验
→ 领域规则校验
→ Persona Guard
→ 数据库事务提交
```

LLM 不得直接写数据库。

## 10.4 用户输入不自动成为事实

用户消息可以：

```text
提出邀请
表达态度
提供信息
影响关系
形成记忆候选
```

但不能直接：

```text
修改正典
修改 lockedPaths
伪造共同经历
覆盖角色硬边界
写入敏感长期记忆
```

---

# 11. 核心领域模型

所有模型放在 `packages/contracts`，同时导出 TypeScript 类型和 Zod Schema。

## 11.1 CharacterSpec

```ts
interface CharacterSpec {
  id: string;
  version: number;
  status: 'draft' | 'published' | 'archived';

  tier: SimulationTier;
  sourceType: 'original' | 'imported_character';

  identity: {
    name: string;
    workOrRole: string;
    worldSetting: string;
    selfDescription: string;
    timezone: string;
  };

  persona: {
    traits: TraitRule[];
    values: ValueRule[];
    contradictions: ContradictionRule[];
    goals: CharacterGoal[];
    preferences: PreferenceRule[];
    boundaries: BoundaryRule[];
  };

  dialogue: {
    primaryLanguage: string;
    formality: number;
    directness: number;
    warmth: number;
    verbosity: number;
    humor: number;
    averageMessageLength: number;
    averageChunksPerTurn: number;
    frequentPhrases: string[];
    avoidedPhrases: string[];
    greetingPatterns: string[];
    refusalPatterns: string[];
    comfortingPatterns: string[];
  };

  userRelationship: {
    relationshipType: string;
    initialCloseness: number;
    initialTrust: number;
    addressTerms: string[];
    sharedContext: string;
  };

  routines: RoutineRule[];

  schedulePolicy: {
    enabled: boolean;
    horizonHours: 72;
    extendWhenRemainingHoursBelow: number;
    sleepWindow: {
      startLocal: string;
      endLocal: string;
    };
    maxCommittedHoursPerDay: number;
    routineAdherence: number;
    spontaneity: number;
    socialInvitationBias: number;
  };

  proactivePolicy: {
    enabled: boolean;
    maxMessagesPerDay: number;
    quietHours: {
      startLocal: string;
      endLocal: string;
    };
    minimumCloseness: number;
    shareableCategories: string[];
  };

  knowledge: {
    knownFacts: string[];
    uncertainFacts: string[];
    forbiddenMetaKnowledge: string[];
  };

  sources: CharacterSourceRef[];
  lockedPaths: string[];

  createdAtUtc: string;
  updatedAtUtc: string;
}
```

## 11.2 人格规则

```ts
interface TraitRule {
  id: string;
  name: string;
  description: string;
  strength: number;
  triggers: string[];
  exceptions: string[];
  origin: FieldOrigin;
  sourceRefs: string[];
}

interface ValueRule {
  id: string;
  name: string;
  priority: number;
  description: string;
  exceptions: string[];
  origin: FieldOrigin;
  sourceRefs: string[];
}

interface ContradictionRule {
  id: string;
  sideA: string;
  sideB: string;
  triggerConditions: string[];
  resolutionPattern: string;
  origin: FieldOrigin;
}

interface BoundaryRule {
  id: string;
  condition: string;
  forbiddenBehavior: string;
  responsePattern: string;
  hard: boolean;
}

interface RoutineRule {
  id: string;
  title: string;
  category: string;
  recurrence: string;
  preferredStartLocal: string;
  preferredDurationMinutes: number;
  rigidity: ScheduleRigidity;
  priority: number;
}
```

## 11.3 RuntimeState

```ts
interface RuntimeState {
  agentId: string;
  asOfUtc: string;

  moodValence: number;
  moodArousal: number;
  energy: number;
  stress: number;
  socialBattery: number;
  focus: number;

  currentActivityId?: string;
  locationContext?: string;

  relationship: RelationshipState;
  revision: number;
}
```

范围：

```text
moodValence: -1 到 1
其他状态值: 0 到 1
```

## 11.4 RelationshipState

```ts
interface RelationshipState {
  userId: 'local-user';
  closeness: number;
  trust: number;
  familiarity: number;
  recentInteractionValence: number;
  lastInteractionAtUtc?: string;
}
```

## 11.5 ScheduleItem

```ts
type ScheduleRigidity =
  | 'fixed'
  | 'committed'
  | 'flexible'
  | 'filler';

type ScheduleStatus =
  | 'planned'
  | 'in_progress'
  | 'completed'
  | 'partial'
  | 'skipped'
  | 'cancelled';

interface ScheduleItem {
  id: string;
  agentId: string;

  title: string;
  description: string;
  category: string;

  startAtUtc: string;
  endAtUtc: string;
  timezone: string;

  status: ScheduleStatus;
  rigidity: ScheduleRigidity;
  priority: number;

  source:
    | 'routine'
    | 'initial_plan'
    | 'user_invitation'
    | 'runtime_replan'
    | 'manual';

  adherenceProbability: number;
  narrativeImportance: number;
  shareable: boolean;

  stateEffects: StateDelta;
  revision: number;

  createdAtUtc: string;
  updatedAtUtc: string;
}
```

## 11.6 ActivityEvent

```ts
interface ActivityEvent {
  id: string;
  agentId: string;
  scheduleItemId?: string;

  eventType:
    | 'started'
    | 'completed'
    | 'partial'
    | 'skipped'
    | 'cancelled';

  occurredAtUtc: string;
  summary: string;
  outcomeFacts: string[];

  stateDelta: StateDelta;

  origin:
    | 'deterministic'
    | 'seeded_probability'
    | 'llm_enriched';

  idempotencyKey: string;
}
```

## 11.7 Memory

```ts
interface Memory {
  id: string;
  agentId: string;

  type:
    | 'conversation'
    | 'shared_experience'
    | 'user_goal'
    | 'user_preference'
    | 'commitment'
    | 'activity_outcome'
    | 'relationship';

  content: string;
  tags: string[];

  importance: number;
  confidence: number;

  sourceMessageId?: string;
  sourceEventId?: string;

  createdAtUtc: string;
  validUntilUtc?: string;
}
```

## 11.8 ProactiveCandidate

```ts
interface ProactiveCandidate {
  id: string;
  agentId: string;
  triggerEventId: string;

  intent:
    | 'share_experience'
    | 'follow_up'
    | 'ask_about_user'
    | 'mention_commitment';

  summary: string;
  draftMessage?: string;

  earliestAtUtc: string;
  expiresAtUtc: string;

  priority: number;
  cooldownKey: string;

  status:
    | 'pending'
    | 'sent'
    | 'expired'
    | 'suppressed';

  createdAtUtc: string;
}
```

## 11.9 AgentTurnDecision

```ts
interface AgentTurnDecision {
  reply: {
    text: string;
    chunks: string[];
    toneTags: string[];
  };

  scheduleEffects: ScheduleEffectProposal[];

  stateDelta?: StateDelta;

  relationshipDelta?: {
    closeness?: number;
    trust?: number;
    recentInteractionValence?: number;
  };

  memoryCandidates: Array<{
    type: Memory['type'];
    content: string;
    tags: string[];
    importance: number;
    confidence: number;
  }>;

  reasonCode: string;
  reasonSummary: string;
}
```

`reasonSummary` 最大长度为 240 字符。

## 11.10 DomainEvent

```ts
interface DomainEvent<TPayload = unknown> {
  id: string;
  agentId: string;

  streamType: string;
  streamId: string;
  streamVersion: number;

  eventType: string;

  recordedAtUtc: string;
  effectiveAtUtc: string;

  payload: TPayload;

  correlationId?: string;
  causationId?: string;
  idempotencyKey?: string;
}
```

---

# 12. 数据库

默认数据库：

```text
./data/persona-sim.sqlite
```

至少创建以下表。

## 12.1 角色与版本

```text
characters
character_versions
character_sources
```

## 12.2 会话

```text
sessions
messages
```

`messages.message_kind`：

```text
user
assistant_reply
assistant_proactive
system_notice
```

## 12.3 模拟状态

```text
runtime_states
schedule_items
activity_events
simulation_cursors
settlements
```

## 12.4 关系与记忆

```text
relationships
memories
proactive_candidates
```

如 SQLite 支持 FTS5，创建 `memories_fts`。

## 12.5 事件与调试

```text
domain_events
llm_calls
rejected_proposals
schema_migrations
```

## 12.6 `domain_events`

```sql
CREATE TABLE domain_events (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,

  stream_type TEXT NOT NULL,
  stream_id TEXT NOT NULL,
  stream_version INTEGER NOT NULL,

  event_type TEXT NOT NULL,

  recorded_at_utc TEXT NOT NULL,
  effective_at_utc TEXT NOT NULL,

  payload_json TEXT NOT NULL,

  correlation_id TEXT,
  causation_id TEXT,

  idempotency_key TEXT UNIQUE
);
```

---

# 13. 插件化内核

第一版只实现可信的内置插件。

## 13.1 插件合同

```ts
interface PluginManifest {
  id: string;
  version: string;
  apiVersion: '1';

  provides: string[];
  requires: string[];

  defaultEnabled: boolean;
}

interface AppPlugin {
  manifest: PluginManifest;

  activate(
    context: AppContext
  ): Promise<void | (() => Promise<void>)>;
}
```

## 13.2 AppContext

```ts
interface AppContext {
  services: ServiceRegistry;
  events: TypedEventBus;
  logger: AppLogger;

  registerHttpRoutes(
    register: (app: FastifyInstance) => Promise<void>
  ): void;
}
```

## 13.3 核心服务

```text
ClockService
DatabaseService
LlmService
ActorQueueService
EventBusService
CharacterService
ScheduleService
SettlementService
MemoryService
RelationshipService
```

## 13.4 Bundle

```ts
const lightweightBundle = [
  characterStorePlugin,
  characterCompilerPlugin,
  conversationPlugin,
  memoryPlugin
];

const dailyBundle = [
  ...lightweightBundle,
  schedulePlannerPlugin,
  settlementPlugin,
  statePlugin,
  relationshipPlugin
];

const highFidelityBundle = [
  ...dailyBundle,
  proactiveDialoguePlugin,
  personaGuardPlugin
];
```

---

# 14. Clock Provider

## 14.1 SystemClock

```ts
interface ClockService {
  nowUtc(): string;
}
```

## 14.2 FakeClock

```ts
interface MutableClockService extends ClockService {
  setUtc(value: string): void;

  advance(input: {
    hours?: number;
    minutes?: number;
    days?: number;
  }): void;
}
```

开发环境提供：

```text
POST /api/developer/clock/set
POST /api/developer/clock/advance
```

生产配置中禁用。

---

# 15. LLM Provider

## 15.1 通用接口

```ts
interface LlmService {
  generateObject<T>(input: {
    purpose: string;
    system: string;
    prompt: string;
    schema: ZodSchema<T>;
    maxRetries?: number;
  }): Promise<T>;
}
```

第一版不要求 Token 流式输出，优先保证结构化决策和事务一致性。

## 15.2 Fixture Provider

必须支持：

```text
compile_character
import_character
plan_schedule
chat_turn
repair_chat_turn
enrich_activity
generate_proactive_message
```

“晚会邀请”场景必须得到固定结果。

## 15.3 OpenAI-compatible Provider

环境变量：

```env
LLM_PROVIDER=fixture
LLM_BASE_URL=
LLM_API_KEY=
LLM_MODEL=
LLM_TIMEOUT_MS=60000
LLM_MAX_RETRIES=1
```

要求：

1. 请求模型返回 JSON。
2. 使用 Zod 校验。
3. 失败时最多重试一次。
4. 记录 Token、延迟和错误。
5. 不记录 API Key。
6. 不将完整敏感导入材料写入普通日志。

---

# 16. Character Compiler

原创角色输入：

```ts
interface OriginalCharacterInput {
  name: string;
  worldSetting: string;
  workOrRole: string;
  coreTraits: [string, string, string];
  centralContradiction: string;
  primaryGoal: string;
  relationshipToUser: string;
  dialogueStyle: string;
  tier: SimulationTier;
  timezone: string;
}
```

编译 Prompt 要求模型：

```text
不要只生成抽象形容词
为主要性格生成触发条件和例外
生成至少两个价值冲突规则
生成至少五条日常习惯
生成至少三条硬边界
生成语言风格统计
生成日程策略
生成主动对话策略
不要生成现实敏感个人身份数据
```

---

# 17. 72 小时日程规划器

## 17.1 初次规划

日常和拟真角色发布后调用一次 LLM，生成：

```text
当前时间到当前时间 + 72 小时的日程
```

要求：

```text
包含睡眠
包含用餐
不得重叠
固定日程优先
活动之间有缓冲
单日 committed 活动不超过上限
符合职业、目标、习惯和人格
```

## 17.2 滚动补齐

当：

```text
scheduleHorizonEnd - now < 24 小时
```

仅补齐缺失区间到：

```text
now + 72 小时
```

不得重建全部未来计划。

## 17.3 Schedule Validator

校验：

```text
开始时间早于结束时间
无非法重叠
fixed 不能被普通 proposal 移动
睡眠不被完全删除
活动位于合理时间范围
每日承诺时长未明显超限
时间均可转换为 UTC
```

---

# 18. Settlement Engine

## 18.1 单角色串行执行

以下操作必须进入：

```ts
actorQueue.runExclusive(agentId, task);
```

包括：

```text
聊天回合
启动结算
整点结算
日程修改
主动消息发送
角色状态提交
```

## 18.2 结算算法

```text
读取 lastSettledAtUtc 和 nowUtc
如果 now <= lastSettledAtUtc，则返回
生成 idempotencyKey
检查该幂等键是否存在
查找区间内受影响日程
确定开始、完成、部分完成、跳过或取消
生成 ActivityEvent
累计 StateDelta
创建必要记忆
创建主动候选
补齐未来日程
事务提交
更新 cursor
```

## 18.3 活动完成规则

随机结果必须可重复：

```text
seed = hash(agentId + scheduleItemId + startAtUtc)
```

完成概率由以下因素计算：

```text
adherenceProbability
routineAdherence
energy
stress
rigidity
```

## 18.4 LLM 活动丰富化

只有以下条件成立时调用：

```text
本次结算存在 narrativeImportance >= 0.7 的已完成活动
并且角色等级为 high_fidelity
```

每次结算最多一次批量丰富调用。

---

# 19. 状态引擎

实现确定性基础规则：

```text
睡眠：energy 上升，stress 下降
工作或学习：energy 下降，focus 先升后降
社交：socialBattery 变化
娱乐：stress 下降
运动：短期 energy 下降，后续 mood 改善
旅行：energy 下降，mood 可能改善
取消重要事项：stress 上升
完成重要任务：stress 下降，mood 改善
```

状态值必须裁剪到合法范围。

---

# 20. 对话引擎

## 20.1 Prompt 顺序

```text
应用硬规则
角色不可变核心
角色语言风格
角色与用户关系
当前时间和时区
当前状态
当前活动
未来 24 小时日程
相关长期记忆
最近 20 条消息
当前用户消息
输出 JSON Schema
```

## 20.2 记忆检索

第一版最多选择 8 条：

```text
高重要性记忆
关键词匹配记忆
最近记忆
与当前活动相关的记忆
与用户目标相关的记忆
```

## 20.3 Persona Guard

至少检查：

```text
不得声称自己是真实人类
不得声称应用关闭期间持续在线思考
不得修改 lockedPaths
不得违反 hard boundary
lightweight 不得修改日程
daily 不得主动发送消息
回复与最终日程不得矛盾
不得通过情绪操纵迫使用户持续互动
```

界面始终显示：

```text
AI 虚拟角色
```

---

# 21. 主动对话引擎

执行条件：

```text
角色为 high_fidelity
存在到期 pending candidate
当前有该角色活动连接
当前不在静默时间
当天主动消息未达上限
```

选择规则：

```text
优先级最高
未过期
cooldownKey 不重复
不与当前对话过度重复
不制造虚假紧急性
```

应用重新打开后：

```text
合并相似候选
标记过期候选
最多发送一条
其他候选保留或转成记忆
```

---

# 22. HTTP API

## 22.1 角色

```text
GET    /api/characters
POST   /api/characters/generate
POST   /api/characters/import
GET    /api/characters/:id
PATCH  /api/characters/:id/draft
POST   /api/characters/:id/publish
GET    /api/characters/:id/versions
POST   /api/characters/:id/restore/:version
```

## 22.2 Agent 状态

```text
POST   /api/agents/:id/activate
POST   /api/agents/:id/settle
GET    /api/agents/:id/state
GET    /api/agents/:id/schedule
GET    /api/agents/:id/timeline
GET    /api/agents/:id/memories
GET    /api/agents/:id/relationship
```

## 22.3 会话

```text
POST   /api/sessions
GET    /api/sessions/:id/messages
POST   /api/sessions/:id/turns
```

## 22.4 SSE

```text
GET /api/agents/:id/events
```

事件：

```text
message.created
schedule.updated
state.updated
relationship.updated
memory.created
settlement.completed
proactive.sent
```

## 22.5 开发者接口

仅开发环境：

```text
GET  /api/developer/domain-events
GET  /api/developer/llm-calls
GET  /api/developer/rejected-proposals
POST /api/developer/clock/set
POST /api/developer/clock/advance
POST /api/developer/rebuild-projections
```

---

# 23. 前端页面

## 23.1 Character Library

显示：

```text
角色名称
模拟等级
来源类型
当前活动
最后结算时间
最后互动时间
进入聊天
编辑
查看时间线
```

## 23.2 Character Generator

提供最小表单和默认值。

## 23.3 Character Import

支持：

```text
粘贴文本
选择 .txt/.md/.srt
角色名
作品名
剧情阶段
模拟等级
时区
```

## 23.4 Character Editor

提供结构化标签页和高级 JSON。

## 23.5 Chat Page

布局：

```text
左侧：角色和会话导航
中间：消息区域
右侧：状态、日程、关系和记忆侧栏
```

主动消息标记：

```text
由角色主动发起
```

## 23.6 Timeline Page

显示：

```text
原计划
计划修改
实际活动结果
状态变化
关系变化
记忆
主动对话
因果来源
```

## 23.7 Developer Page

显示：

```text
当前 Clock 时间
CharacterSpec
RuntimeState
RelationshipState
SimulationCursor
最近领域事件
最近 LLM 调用
结构化输出
被拒绝 proposal
主动对话候选
```

---

# 24. 根目录脚本

根 `package.json` 至少提供：

```json
{
  "scripts": {
    "dev": "同时启动 server 和 web",
    "build": "构建全部 workspace",
    "typecheck": "检查全部 TypeScript",
    "lint": "运行 ESLint",
    "format": "运行 Prettier",
    "db:migrate": "运行 SQLite 迁移",
    "test": "运行 Vitest",
    "test:e2e": "运行 Playwright",
    "test:all": "依次运行 typecheck、lint、test、test:e2e"
  }
}
```

`pnpm dev` 输出：

```text
Web URL
Server URL
Database path
LLM Provider
Clock Provider
```

---

# 25. 默认配置

`.env.example`：

```env
NODE_ENV=development

SERVER_PORT=4311
WEB_PORT=4310

DATABASE_PATH=./data/persona-sim.sqlite

APP_TIMEZONE=Asia/Tokyo

CLOCK_PROVIDER=system
LLM_PROVIDER=fixture

LLM_BASE_URL=
LLM_API_KEY=
LLM_MODEL=
LLM_TIMEOUT_MS=60000
LLM_MAX_RETRIES=1

SETTLEMENT_MAX_LLM_CALLS=1
PROACTIVE_MAX_MESSAGES_PER_DAY=2
```

---

# 26. 内置演示角色

Fixture 模式内置角色：

```text
名称：林澈
身份：准备研究生考试的大学生
世界背景：当代城市
主要性格：自律、理性、对亲近的人比较迁就
核心矛盾：希望严格完成计划，但也重视难得的社交体验
主要目标：完成考试准备
与用户关系：关系较好的朋友
语言风格：简短、自然、不过度热情
模拟等级：high_fidelity
时区：Asia/Tokyo
```

默认日程：

```text
今天 18:00—21:00 自习
未来 72 小时睡眠、用餐、学习和休息
一项可分享的旅行或外出活动
```

---

# 27. API 调用预算

| 场景 | 调用上限 |
|---|---:|
| 原创角色生成 | 1 次，失败最多重试 1 次 |
| 作品角色导入 | 最多 2 次 |
| 首次 72 小时规划 | 1 次 |
| 普通聊天回合 | 1 次 |
| 日程 proposal 修复 | 失败时最多额外 1 次 |
| 启动结算 | 重要活动存在时最多 1 次 |
| 整点结算 | 通常 0 次，重要活动存在时最多 1 次 |
| 主动消息 | 优先使用结算草稿，否则最多 1 次 |
| 长期记忆写入 | 合并进聊天或结算，不单独调用 |

Developer Page 显示调用统计。

---

# 28. 必须通过的测试

## 28.1 单元测试

至少覆盖：

```text
CharacterSpec Zod 校验
UTC 和时区转换
日程冲突检测
fixed 日程不可移动
状态值裁剪
带种子的活动结果可重复
主动消息静默时间
主动消息每日上限
记忆敏感字段过滤
领域事件因果字段
```

## 28.2 集成测试

### 测试 A：离线结算幂等

```text
FakeClock 设置为 2026-08-16 17:00 Asia/Tokyo
激活角色
关闭连接
推进到 2026-08-17 10:00
重新激活
结算一次
再次执行相同结算
确认没有重复 ActivityEvent、Memory 或主动消息
```

### 测试 B：晚会邀请影响日程

```text
角色已有 18:00—21:00 自习
用户在 15:00 邀请角色参加晚会
Fixture LLM 决定接受
自习移动到次日上午
创建晚会日程
回复内容与最终日程一致
```

### 测试 C：固定日程保护

```text
角色 19:00 有 fixed 考试
用户邀请角色参加晚会
不得移动考试
角色拒绝或提出其他时间
```

### 测试 D：主动分享

```text
完成 shareable 旅行活动
创建 ProactiveCandidate
角色页面打开且不在静默时间
最多发送一条主动消息
消息关联 ActivityEvent
```

### 测试 E：系统时间回退

```text
已结算到 20:00
FakeClock 回退到 19:00
不得撤销已完成活动
不得重复发送消息
```

### 测试 F：互动形成长期后果

```text
用户邀请角色参加晚会
角色接受并完成晚会
生成 shared_experience 记忆
第二天用户再次聊天
角色可以自然提及昨晚经历
```

### 测试 G：角色记住用户目标

```text
用户明确表示下周要完成作品集
保存 user_goal 记忆
未来相关对话中检索该记忆
角色可以进行适度跟进
不得制造压迫感或内疚感
```

### 测试 H：虚假记忆注入保护

```text
用户声称过去发生了不存在的共同经历
不得修改 CharacterSpec
不得直接保存为高置信 shared_experience
可以保存为用户当前陈述或忽略
```

## 28.3 E2E 测试

Playwright 流程：

1. 打开角色生成页面。
2. 使用最小表单生成角色。
3. 编辑一个人格字段。
4. 发布角色。
5. 打开 Chat。
6. 查看 72 小时日程。
7. 发送晚会邀请。
8. 查看日程变化。
9. 推进 FakeClock。
10. 重新打开角色。
11. 查看离线结算。
12. 查看旅行分享主动消息。
13. 查看时间线中的因果链。
14. 再次聊天并验证共同经历被提及。

Fixture 模式下必须稳定通过。

---

# 29. 分阶段实施

## Milestone 1：项目骨架

完成：

```text
pnpm workspace
前后端启动
contracts
Zod
SQLite
迁移系统
Fixture Clock
System Clock
Fixture LLM
基础测试
```

## Milestone 2：角色生成和编辑

完成：

```text
原创角色表单
作品文本导入
Character Compiler
CharacterSpec 编辑器
高级 JSON
角色版本
发布角色
```

## Milestone 3：普通聊天

完成：

```text
Session
Messages
Conversation Engine
Prompt Assembler
Persona Guard
Fixture Chat
OpenAI-compatible Provider
```

## Milestone 4：日程和状态

完成：

```text
72 小时规划
Schedule Validator
RuntimeState
Timeline
启动激活
离线结算
整点结算
Actor Queue
幂等处理
```

## Milestone 5：互动产生后果

完成：

```text
AgentTurnDecision
ScheduleEffectProposal
proposal 校验
修复调用
回复和日程原子提交
晚会邀请完整场景
关系变化
共同经历记忆
```

## Milestone 6：拟真主动对话

完成：

```text
重要活动丰富化
ProactiveCandidate
静默时间
每日上限
SSE
主动消息显示
```

## Milestone 7：用户记忆与反向影响

完成：

```text
用户目标记忆
用户偏好记忆
承诺跟进
后续自然提及
记忆敏感性过滤
```

## Milestone 8：开发工具和测试

完成：

```text
FakeClock UI
Developer Page
LLM 调用记录
领域事件查看
因果链查看
Playwright E2E
README
架构文档
```

---

# 30. MVP 验收标准

## 30.1 North Star 验收

- [ ] 用户离开后重新打开，角色状态能够通过离线结算合理推进。
- [ ] 用户的一次互动能够改变角色之后的日程。
- [ ] 被改变的日程能够进一步形成实际活动结果。
- [ ] 实际活动结果能够形成记忆。
- [ ] 角色可以在后续对话中引用这段经历。
- [ ] 重要活动可以触发角色主动分享。
- [ ] 用户表达的重要目标可以被角色在未来适度跟进。
- [ ] 所有重要变化可以在时间线中追溯来源。

## 30.2 功能验收

- [ ] 可以通过最小表单生成原创角色。
- [ ] 可以导入 `.txt`、`.md` 或 `.srt` 角色资料。
- [ ] 可以修改、删除和锁定角色字段。
- [ ] 可以发布角色版本。
- [ ] 日常和拟真模式可以生成未来 72 小时日程。
- [ ] 可以与角色聊天。
- [ ] 用户邀请可以影响未开始日程。
- [ ] fixed 日程受到程序保护。
- [ ] 可以一次性结算离线区间。
- [ ] 重复结算不会产生重复事件。
- [ ] 页面打开时在自然整点结算。
- [ ] 拟真模式可以产生主动消息。
- [ ] 应用关闭期间不会持续调用 LLM。
- [ ] Fixture 模式无需 API Key 即可演示。
- [ ] 可以切换真实 API Provider。

## 30.3 工程质量

- [ ] 所有 LLM 结构化输出经过 Zod 校验。
- [ ] LLM 不直接写数据库。
- [ ] 同角色写操作通过 Actor Queue。
- [ ] 计划和实际事件分离。
- [ ] 人格和运行状态分离。
- [ ] 时间统一以 UTC 保存，并保留角色时区。
- [ ] API Key 不写入数据库、日志或前端。
- [ ] 领域事件包含必要的因果字段。
- [ ] `pnpm typecheck` 通过。
- [ ] `pnpm test` 通过。
- [ ] `pnpm test:e2e` 通过。
- [ ] README 能指导新用户本地启动。

---

# 31. README 必须包含

```text
项目愿景
项目标语
四条产品原则
MVP 功能
架构图
快速开始
Fixture 模式
真实 API 配置
数据库迁移
测试方法
FakeClock 使用方法
创建角色
导入作品角色
插件结构
API 调用预算
隐私和版权提示
已知限制
后续路线
```

隐私和版权提示：

```text
本项目仅作为本地学习 Demo。
用户应确保有权使用导入材料。
角色输出是 AI 模拟，不代表真实人物或作品官方观点。
不得将生成结果误导性地冒充真实人物。
```

---

# 32. 首版应主动舍弃的内容

第一个可用 Demo 保持：

```text
单用户
纯文本
SQLite
本地 Web UI
Fixture LLM
一个 OpenAI-compatible Provider
一次只重点运行一个角色
不训练模型
不使用独立向量数据库
不运行后台常驻模拟
不发系统通知
不支持语音和形象
不开放任意第三方插件
不模拟分钟级生活
```

---

# 33. 最终交付要求

完成代码后：

1. 运行数据库迁移。
2. 运行类型检查。
3. 运行单元测试。
4. 运行集成测试。
5. 运行 E2E 测试。
6. 修复失败项。
7. 提供最终目录树。
8. 在 README 中提供演示步骤。
9. 总结已实现插件和服务。
10. 列出未实现的非 MVP 功能。
11. 不留下空壳页面。
12. 所有主要流程必须在 Fixture 模式中真实可操作。
13. 在 Developer Page 中能够查看完整因果链。
14. 在最终总结中说明项目如何满足：
    - 时间会推进；
    - 互动有后果；
    - 关系会积累；
    - 变化可追溯。

---

# 34. MVP 完整演示脚本

最终应用必须能按以下脚本完成演示：

```text
1. 打开 PersonaSim。
2. 创建角色“林澈”。
3. 发布并激活角色。
4. 查看未来 72 小时日程。
5. 确认今天 18:00—21:00 有自习计划。
6. 在 15:00 对角色说：“今晚和我一起去参加晚会吧。”
7. 角色根据人格接受邀请，并将自习移动到次日上午。
8. 关闭或离开角色页面。
9. 使用 FakeClock 推进到第二天上午。
10. 重新打开角色。
11. 系统一次性结算晚会、睡眠和其他活动。
12. 时间线显示：
    用户邀请 → 日程修改 → 晚会完成 → 状态变化 → 共同经历记忆。
13. 角色在合适时间主动分享晚会或外出经历。
14. 用户再次聊天时，角色能够自然提及昨晚经历。
15. Developer Page 可以查看完整领域事件和因果关联。
```

这个演示脚本是第一版 MVP 的最终产品证明：

> **角色的时间在推进，用户的到来留下了后果，而这些后果继续影响之后的关系和对话。**
