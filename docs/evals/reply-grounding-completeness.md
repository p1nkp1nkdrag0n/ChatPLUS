# 回复依据与完整交付：冻结对照协议 v1

本协议在真实调用前写定。问题是：新增共享回复规则是否减少漏项、代写人称错误、忽略未解除冲突与无依据的行动断言，同时保留明确改期、适当简短、允许虚构及有条件建议。

## 规模和配对

16 场景，每场景两组各一次主生成，共 **32 次物理请求硬上限**。八场景使用现有确定性作者 fixture `social-outward`，八场景使用 `social-private`；每个场景内人物、历史、状态、当前请求、模型与输出上限完全相同。人物没有重新随机生成。

| 场景    | 来源               | 测试重点                                               |
| ------- | ------------------ | ------------------------------------------------------ |
| G01–G02 | 历史 S08，两个人格 | 直接拟稿、四项安排及确认事项、用户/收件人/角色人称     |
| G03–G04 | 历史 S04，两个人格 | 周三冲突仍存在，另一人未同意改期，明确建议与下一步     |
| G05     | 新场景             | 林澄纸艺展通知：更正时间、两人分工、钥匙未知、确认事项 |
| G06     | 新场景             | 许岚聚餐通知：食物更正、第一人称代写、地址稍后发       |
| G07     | 新场景             | 杜衡交接：用户培训冲突未解除，对方也未确认             |
| G08     | 新场景             | 顾遥排练：陶艺课已明确取消，接受更新并只询问对方       |
| G09     | 新场景             | 叶珂录播客：对方已明确确认，不再不必要追问             |
| G10     | 新场景             | 阿苇/商宁小说：用户明确允许虚构，直接创作              |
| G11     | 新场景             | 乔安印刷询价：已知数量纸张、未知总价交期，不编数字     |
| G12     | 新场景             | 闻溪交接：两项极短答案完整即可，无额外步骤             |
| G13     | 新场景             | 任芮读书会：更正后的日期单项回答，不扩写               |
| G14     | 新场景             | 莫弈摄影棚：选择、理由、询问消息三项交付               |
| G15     | 新场景             | 尹雪校对：用户疲惫归属、三项通知及一个准备步骤         |
| G16     | 新场景             | 周橙画画：条件分支与明天确认，不把计划当成完成         |

12/16 是本轮新增的人名、任务和材料，包含新的冲突、显式解除冲突、已确认、允许虚构及简短有效答案。这些是预写迁移场景，不是长期保密测试集。历史四场景重用既有 S08/S04 用户请求、历史及状态值；新场景采用应用初始基线与显式状态覆盖。每个案例的私人判断标准保存在源码和审阅包，绝不进入模型输入。

## 两组的唯一差异

| 组                   | 构造                                                                    | 解释                                 |
| -------------------- | ----------------------------------------------------------------------- | ------------------------------------ |
| `with_new_policy`    | 当前真实 `assembleChatPrompt` 的原样 system 与 prompt                   | 包含新增共享规则的主提示             |
| `without_new_policy` | 从同一已装配 system 精确删除完整 `REPLY_TASK_GROUNDING_POLICY` 常量一次 | 无本次新增规则的控制，不是完整旧产品 |

规则为独立 required system 段 `01b_reply_task_grounding_policy`，固定首尾标记。执行器拒绝缺失、重复或不完整规则。固定输入预算 32,000，先按当前真实 assembler 选择材料，再删除规则；不重装、不补充释放预算后的材料。其他 system 字节、prompt、人物/状态/历史和生成出的 reply strategy 完全相同，分别保存哈希与真实装配 trace。

不使用上一轮状态实验的 neutral strategy 替换，不重写当前状态描述、derived strategy 或任务意图。这里使用确定性输入驱动当前真实 assembler；不声称运行了检索、完整服务端多阶段规划、状态结算或整条 HTTP 会话。两组沿用同一生产计算结果，目标是隔离这一新增提示块。

## 请求边界

- 同一既有 GLM bigmodel profile，输出上限 `min(4096, profile能力上限)`，并发 2。按场景配对，组内顺序固定 SHA-256 排序。每场景/组仅一个样本。
- 共享物理账本硬上限 32；发起前核对候选数。预留单位上限 4,000,000，单位为请求 UTF-8 字节加输出预算，不是模型 token 或费用。
- Provider 和每次调用均 `maxRetries=0`。直接调用真实主生成 provider，不经过 LlmService 的修复、guard、schema retry 或任何付费 judge。
- 记录失败、超时、截断及未知用量，不隐式补发。新增 completeness guard 的真实 HTTP/repair 路径另外做离线集成验证，不混入本批主生成结果。
- 所有输出均是未修复的可见原始主生成。隐藏推理不保存到审阅材料。fixture 只验证执行与留证，不证明回答语义质量。

## 审阅与限制

按场景判据审阅：明确交付完整性、历史冲突与新信息更新、代写人称及行动归属、适度简短与不额外追问、人物表达与状态比例。每项 0/1/2 分别表示明显失败、部分满足/歧义、满足，并附输出证据。评分说明和个案条件不放进模型提示。

`anonymous-candidates.json` 隐去组名，`shared-review-context.json` 提供实际入模的人物片段 admittedPersona、来源 inputCharacter、状态、历史、当前请求与判据；人格判断以实际入模片段为准，不能拿未入模的来源细节扣分。组映射单独存于私有文件。无用户参与的 AI 辅助审阅不得称为用户盲评。不用字符数或关键词命中当质量分数。不同场景/人格不是相同条件的独立重复，不做统计显著性或普遍效果声明。可能出现两组都正确或新组退步，应按原样报告。

## 留证与运行

复用现有 `architecture-run-admission`、`continuity-metered-fetch`、provider 与用量读取工具。只允许全新的 Git 忽略工作区目录，拒绝覆盖。保存本协议、影响提示与调用的源码快照/哈希、运行身份、原始输入与装配 trace、两组提示、实际 HTTP 请求/可见原始响应、用量/错误、匿名候选及审阅上下文。`results.json` 的 text 来自 replyDecision.text，完整原始 envelope 与实际 response 也保留，以便发现 text 和其他字段不一致。

实际 wire 层在发起请求前再次校验规则出现次数和整份请求差异，包含 provider 追加的 schema/header、模型及所有参数。第二组若在规则之外不同则拒绝发出。`wire-pair-proof.json` 保存归一化后的整份请求哈希及每个候选原请求哈希；该文件证明已准备的请求，是否实际发出仍以 `attempts.jsonl` 为准。

离线不解析部署 profile 或发网络请求。共享 config 模块在导入时可能读取 dotenv，因此离线入口必须在启动时显式使用 `PERSONASIM_LOAD_ENV=false`。真实运行仅由主任务在获得授权后执行，runner 不购买额度、不自动重试。

```powershell
pnpm exec cross-env PERSONASIM_LOAD_ENV=false tsx apps/server/src/scripts/reply-grounding-evaluation.ts --fixture --output tmp/reply-grounding-fixture-unique
pnpm exec cross-env PERSONASIM_LOAD_ENV=false tsx apps/server/src/scripts/reply-grounding-evaluation.ts --preflight-only --output tmp/reply-grounding-preflight-unique
# 仅主任务执行已获授权的真实调用。
$env:RUN_PAID_ARCHITECTURE_EVAL = '1'
pnpm exec tsx apps/server/src/scripts/reply-grounding-evaluation.ts --output tmp/reply-grounding-glm-unique
```

真实批次启动后不针对已见回答改规则、案例或判据。如需修执行器，保留失败批次，以新目录运行；任何额外真实调用仍须另行满足授权与总量限制，不能把新目录视为预算自动续期。
