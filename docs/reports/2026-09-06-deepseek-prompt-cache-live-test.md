# DeepSeek Prompt Cache 真实调用验证

- 时间：2026-09-06 15:17:29–15:17:50（Asia/Shanghai）
- 授权：用户要求“调用 deepseek 进行测试”。
- 模型与接口：`deepseek-v4-flash`，`https://api.deepseek.com`，现有 `legacy` 配置。
- 前置改造：[计量与稳定前缀实施记录](2026-09-06-provider-prompt-cache-implementation.md)。
- 产物目录：`tmp/deepseek-cache-live/2026-09-06T07-17-28-672Z-607fb4/`。

## 执行范围

先走现有 `runLlmHttpSmoke` 生产 HTTP 对话、校验与落库链路，使用内存数据库和应用自带的演示角色。再复用它实际发出的 messages，对完全重复、两次变化尾部、一次变化前缀执行 Provider 请求；没有填充无用 token。后四次只验证 Provider 结构边界，不声称经过完整应用落库链路。

测试前写入 `plan.json`：最多 6 次物理请求、累计输入 UTF-8 字节上限 120,000、每次输出上限 768 token。此次临时使用 `thinking: disabled`、非流式、Provider 默认重试 0；未修改 `.env` 或默认模型配置。相邻请求在上一请求结束后等待 4 秒。

实际发出 **5 次物理请求、5 次逻辑调用**，全部 HTTP 200 / `finish_reason: stop`，无失败、无重试。累计请求体 85,345 UTF-8 字节。生产 smoke 保存了两个回复 chunk，应用用途仅 `chat_turn`，没有应用层 repair。

## 逐次结果

| 请求             | 输入 token | 输出 token | 读取 token |     读取率 | Provider 延迟 ms |
| ---------------- | ---------: | ---------: | ---------: | ---------: | ---------------: |
| 生产 HTTP smoke  |      3,553 |         33 |          0 |         0% |              823 |
| 完全重复请求     |      3,553 |         72 |      3,456 |     97.27% |              958 |
| 第一次变化尾部   |      3,551 |         52 |          0 |         0% |            1,147 |
| 第二次变化尾部   |      3,549 |         78 |      3,328 |     93.77% |            1,098 |
| 改变 system 前缀 |      3,563 |         77 |          0 |         0% |            1,106 |
| 合计             | **17,769** |    **312** |  **6,784** | **38.18%** |                — |

读取字段覆盖率 **100%（5/5）**，所有响应均满足 `prompt_cache_hit_tokens + prompt_cache_miss_tokens = prompt_tokens`。缓存写入字段覆盖率 **0%（0/5）**，写入量保持未知，不把 miss 当成写入量。

原始响应同时包含 `usage.prompt_tokens_details.cached_tokens` 和 `usage.prompt_cache_hit_tokens`，五次都相等。实际 Provider 计量选择前者，与原生字段逐次一致。本次不能声称旧映射在该真实接口已经丢失读取量。

实际消息顺序是 JSON system 指令、角色 system、独立 user Schema、动态 user 数据。完全重复时 messages hash 一致，共有 14,573 个序列化字符；两次变化尾部都保留 14,017 个公共前缀字符，首次却没有命中；改变 system 前缀后，相邻请求公共前缀降为 168 个字符。

这组数据证明当前布局可以产生供应商真实缓存读取，同时直接说明字符前缀长度不能替代命中计量。首次变化尾部未命中、再次复用公共前缀后命中的行为，与 [DeepSeek 官方缓存规则](https://api-docs.deepseek.com/guides/kv_cache/)描述相符；这是现象对照，并非已查明服务端内部缓存决策。

## 费用口径与结论边界

按 [2026-09-06 查阅的官方价格](https://api-docs.deepseek.com/quick_start/pricing/)，本次周日适用 off-peak。Flash 每百万 token 的美元单价：命中输入 0.007、未命中输入 0.22、输出 0.66。

`(6,784 × 0.007 + 10,985 × 0.22 + 312 × 0.66) / 1,000,000 = 0.002670108 USD`。

这是根据官方价和返回用量的估算，**不是账户实际扣款核对**。所有五次请求都纳入金额，没有仅挑选高命中请求。未观察到独立缓存写入收费字段，不补造为零。

本次是 5 个样本的功能/行为验证，未做改造前后固定温度的配对实验、TTL 过期实验、长期内容质量评估或 Qwen/GLM 对照。同一输入的两次回答在是否接受邀请上不同；缓存不会固定模型输出，本次也未固定 temperature，因此不据此宣称质量保持或退化。不能把两个高命中样本推广为长期平均命中率，也不能证明延迟降低。Claude 暂停状态不变。

## 随测试补充的代码

- `responseMetricFields`：为没有有效 OpenAI 兼容别名的响应，补充 DeepSeek 官方 `usage.prompt_cache_hit_tokens` 回退，记录精确来源。已有有效别名（包括 0）保持优先，不重复相加；`prompt_cache_miss_tokens` 不映射为写入量。[字段依据](https://api-docs.deepseek.com/api/create-chat-completion/)
- `runLlmHttpSmoke`：增加可选 observation 转发，真实生产 smoke 可以输出既有 Provider 指标与前缀诊断，不改变默认调用方式。
- 新增 18 项 DeepSeek 离线回归，覆盖原生字段缺失/零/正值/异常值、别名优先、回退、失败尝试和重试身份；原生回退由离线测试验证，本次真实响应使用兼容别名。
- 聚焦 Provider 与生产 HTTP smoke 回归 **5 个文件、72 项通过**；变更文件 ESLint、Prettier，Provider/Server 类型检查通过。

## 可核对产物

- `plan.json`：执行前的请求约束和单价口径。
- `raw-usage.jsonl`：每次请求的原始 usage、状态、模型和消息诊断元数据。
- `provider-metrics.jsonl`：应用 Provider 发出的五条物理尝试指标。
- `result.json`：输出、逐次计量一致性检查、汇总及费用估算。
- 执行脚本保存在 `tmp/deepseek-cache-live-test.ts`，再次运行会产生新目录并再次付费；本次未自动扩大样本。

产物只记录本次应用演示数据、生成回复和必要诊断元数据，没有保存凭据或新增完整请求正文日志。
