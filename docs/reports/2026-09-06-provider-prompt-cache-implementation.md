# Prompt Cache 计量与稳定前缀实施记录

- Date: 2026-09-06（Asia/Shanghai）
- Related: [本地原问题与历史证据](../issue/2026-09-05-provider-prompt-cache-hit-rate-and-cost.md)（该目录由仓库既有规则忽略；本实施记录单独纳入版本控制）
- Scope: Provider 计量、提示词布局、长测落盘与离线报告；没有真实供应商调用。
- State: 批次 1、2 的代码及离线验证已实施；批次 3 完成文档能力核对并选择暂不启用；批次 4 尚未执行。

## 成因与方案选择

1. `packages/providers/src/openai-compatible-llm.ts` 的 `responseMetricFields` 原来只采集输入/输出 token。`usageSource: provider` 只能证明基础用量来自供应商，不能证明缓存字段已采集。HTTP 错误与无效响应 envelope 的原始 usage 也会丢失；结构失败和重试可能已产生费用。
2. `packages/features/src/prompt-assembler.ts` 的 `commonPolicy` 按记忆是否存在改变 system 前部；这让后面的稳定角色文本失去共同前缀机会。改为始终包含同一句条件式规则，记忆证据仍逐轮提供，引用来源和权威性约束不变。
3. `generateObject` 将静态 Schema 追加在动态 user prompt 后面。现在 prompt JSON 模式把 Schema 放在独立的前置 user 消息里；native schema 模式只使用 `response_format` 中的一份 Schema。运行时校验和末尾修复消息保持有效，不把 user 内容提升为 system 指令。
4. registry 的预算选择按 `priority`，最终渲染原本按 ID。新增独立 `renderOrder`，只让保留的 `recent_verbatim` 历史提前；预算、ID、截断及可见性规则不变。模拟用户的参与者信息及公开历史提前，当前时间、场景及省略计数保留在后面。历史窗口滑动或配置变化仍应表现为前缀变化。
5. 长测观察器另有本地逻辑序号，跨分支或重启会重复。Provider UUID 与本地 trace 关联 ID 分开保留，费用汇总只用 Provider UUID 去重；旧数据缺少 UUID 时标明未知。

选择先观察供应商自动缓存。尚无当前账户的计费方式、实际单价和显式缓存收益证据，引入显式写入会增加协议差异与写入成本，当前不具备选择它优于自动缓存的依据。没有新增无用 token，也没有调整 thinking/streaming 来充当缓存开关。

## 已实现的计量口径

`LlmCallMetric` 新增可选 `logicalCallId`、`cacheReadTokens`、`cacheWriteTokens`、`cacheReadSource`、`cacheWriteSource`。

| 指标           | 已核对的 OpenAI 兼容接口字段                              |
| -------------- | --------------------------------------------------------- |
| 缓存读取 token | `usage.prompt_tokens_details.cached_tokens`               |
| 缓存创建 token | `usage.prompt_tokens_details.cache_creation_input_tokens` |

缺失、`null`、字符串、负数、小数和非安全整数均不产生缓存数值；明确的 `0` 才代表已知零。字段逐项提取，一个异常字段不会遮蔽其他有效用量。成功、JSON/结构失败、空输出、截断、无效 envelope、带 usage 的 HTTP 错误均按物理尝试记录。本地 Schema 转换失败没有发 HTTP 请求，不计物理尝试。当前 Provider 明确使用 `stream: false`，未声称支持或测试流式 usage。

`apps/server/src/scripts/provider-metrics-summary.ts` 按 provider、profile、请求模型、实际响应模型及 purpose 分组，分别给出物理尝试、失败、重试、已知逻辑调用数、输入/输出与缓存读写量、已知/未知请求数及覆盖率。逻辑 ID 不全时，报告的逻辑调用数只是已观察 ID 的数量，不能当作完整总数。

读取率仅使用同时具有有效供应商输入 token 与读取 token 的尝试：`sum(读取) / sum(同批输入)`；估算输入、读取大于输入等不合口径记录排除并计入 excluded attempts。分母为零时读取率未知。缺失读取字段的请求不暗中按零纳入分母。读写 token 总和是已知部分，覆盖率不足时不代表全部费用。

Product-life 和 dual-model 的新运行写入 `provider-metrics.json`、`provider-metrics.md`；恢复时合并已有原始指标再汇总。Companion v2/v3 的 artifact projection 保留缓存字段，报告接入共享汇总，并单独保留观察器估算前的供应商输入 token。旧日志可离线读取，但不补造缓存值或 Provider UUID。

模拟用户输入协议升级为 `named-public-history-v4`，新旧提示词不能接续成同一实验；旧运行仍保留原始产物，需新建运行建立布局基线。

## 前缀诊断与语义边界

- Provider 提供默认关闭的 `promptDiagnostics`；product-life 和 dual-model 的观察路径明确开启，普通服务默认不收集。
- 基于真正送入 HTTP body 的 messages 数组，记录布局版本 `stable-prefix-v1`、`messages-json-v1` 序列化、消息顺序/角色、内容 hash、字符数、首个变化消息及共同前缀字符数。native `response_format` 另记 hash。
- 比较对象是同一 Provider 实例中上一条开始的同用途物理尝试；记录 `previousMessagesSha256`，响应完成顺序改变时仍可确定比较对象。
- 只输出元数据，不新增提示词正文日志。前一请求仅在内存中有界保存：最多 16 个用途、每个 256,000 个序列化字符。超限清除该用途基线；重启重新建立基线。它不模拟供应商缓存、TTL 或真实 tokenization。
- registry trace 新增 `localCacheHit`，旧 `cacheHit` 作为兼容别名；`renderedIndex` 和 `renderedCharacters` 描述最终保留片段。片段渲染缓存仍是实例内缓存，未扩大为全局共享。
- 当前时间保持本轮最新值；参与者、来源 ID、首次可见时间和引用数据边界保留。动态 `effectsContract` 未整块迁入静态 system。

## 官方能力核对与待验证事项

2026-09-06 查阅 [Qwen 官方上下文缓存说明](https://help.aliyun.com/zh/model-studio/context-cache) 与 [GLM 官方上下文缓存说明](https://docs.bigmodel.cn/cn/guide/capabilities/cache)。Qwen 的 OpenAI 兼容示例确认上述嵌套字段；其他协议的顶层字段和输入分母不能直接混用。GLM 文档描述自动缓存及嵌套读取字段。

Qwen 文档列出显式缓存需主动标记，最低 1,024 token，TTL 为 5 分钟且命中续期；`qwen3.8-flash` 有单独的显式命中价说明。文档能力不等于当前账户、地域与接入路径已经验证。现实现不向任何 profile 发送 `cache_control` 或 TTL 字段，GLM/Claude 也不会收到推测的显式参数。

真实对照前仍需记录实际 endpoint/地域/模型、账户计费方式、输入/读取/写入/输出单价、请求数和费用上限。以新布局建立基线，覆盖重复前缀与变化尾部、前缀变化、TTL 内复用与过期，并把失败重试和输出成本计入；同步评估结构通过率及内容质量。没有这些数据时不计算金额或宣称降费比例。Claude 的既有真实调用暂停保持不变。

## 验证记录

- Provider 现有与新增离线测试覆盖普通/结构响应、缺字段/零/读写值/异常值、各类失败、重试 ID、Schema 模式和修复消息、诊断开关与基线边界。
- Feature 回归覆盖记忆切换、历史窗口滑动与重建、来源和首次可见信息、最新时间/状态、预算选择独立于渲染顺序，以及本地缓存 trace。
- Runner 回归覆盖未知字段、已知读取率分母、分组、重试/逻辑 ID、旧日志兼容、恢复与新协议隔离、v2/v3 artifact 字段及跨 observer 计量。
- `pnpm test`：207 个测试文件、2,208 个测试全部通过（44.68 秒）。覆盖 42 轮 product-life、完成后恢复与第 45 天中断恢复。测试运行期间保持 Git 不变：恢复协议会正确拒绝跨 Git 版本接续。
- 最后收紧两处测试 fixture 的 HTTP body 类型检查后，对对应 Provider 测试复测：2 个文件、30 个测试通过。功能代码在全量通过后未再改变。
- `pnpm lint`、`pnpm typecheck` 和本次变更文件的 Prettier 检查均通过。
- 原始 2026-09-05 指标用新汇总器只读复核：角色 69 次物理尝试、6 次失败、5 次重试，输入 794,828 / 输出 78,969 token；模拟用户 43 次物理尝试，输入 285,800 / 输出 39,921 token。两组缓存字段覆盖率均为 0，缓存 token、读取率及完整逻辑调用数均为未知。新报告保存在 `tmp/prompt-cache-review-20260906/historical-provider-metrics.json` 和 `.md`，读取前后 SHA-256 一致，原文件未改写。
- 所有验证使用离线 fixture 或既有日志，不将布局字符增长表述为供应商命中增长。
