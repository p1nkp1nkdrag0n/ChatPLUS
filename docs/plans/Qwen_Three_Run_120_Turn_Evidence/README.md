# Qwen 三次 120 轮测试证据包

本包对应 `codex/qwen-three-run-long-validation` 分支、冻结产品提交 `2a5b5457350b4f6c82cb5064a5dae4c747d2c8c3`。三组使用相同场景和作者输入、各自新生成角色；实际完成 360 轮，372 次物理请求。结论和执行例外请先读[测试报告](../Qwen_Three_Run_120_Turn_Results.md)。

## 推荐阅读顺序

| 文件                                                         | 用途                                                                             |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| [conversation-comparison.md](conversation-comparison.md)     | 同一轮输入下的三组实际回复，完整 120 × 3 对照                                    |
| [primary-reviews.jsonl](primary-reviews.jsonl)               | 360 个唯一轮次；初始解析成功回复、最终文字及气泡、初审、上下文规划和检查证据     |
| [secondary-reviews.json](secondary-reviews.json)             | 63 条第二审阅：42 个预先固定点，21 个额外候选；保留评分分歧和非盲审披露          |
| [review-summary.json](review-summary.json)                   | 初审的描述统计、固定机会分母、分阶段和旧前 16 轮口径                             |
| [review-adjudications.json](review-adjudications.json)       | 主任务对实际分歧和撤销误报的裁定，不覆盖独立原评分                               |
| [cross-run-clusters.json](cross-run-clusters.json)           | 三组全部轮次的问题索引、共同机制、分层归因及来源 hash                            |
| [run-summary.json](run-summary.json)                         | 物理调用、逻辑用途、实际 usage、预算、幂等和运行状态                             |
| [execution-deviations.json](execution-deviations.json)       | R1 书信失败后观测继续、R3 T87 文件故障恢复；失败仍计入                           |
| [final-state-proof.json](final-state-proof.json)             | 三个最终库的最小证据，包括错误 storage、纠正事实、相处实践、日程关闭与未触发路径 |
| [prompt-delivery-summary.json](prompt-delivery-summary.json) | 361 个物理主请求的提示送达核对；包括三次 repair 原文检测的勘误                   |

原始 oracle 的评阅分别在 [R1](r1-oracle-review.json)、[R2](r2-oracle-review.json)、[R3](r3-oracle-review.json)。R1/R2 补充 ledger 在 [R1 ledger](r1-oracle-ledger.json)、[R2 ledger](r2-oracle-ledger.json)，与既有 30 项具体探针共同阅读。限定目标 pass 不等于整体回复正确或自然，未覆盖项不算通过。R3 T119 对“历史混名”的过强推断已撤销，以 `review-adjudications.json`、全量初审和最新版聚类为准；原探针的限定目标判定仍为 pass。

## 解释边界

所有评分是 **Codex 辅助语义审阅**，没有真人参与者或额外付费评分模型。原评阅中“人工核对/manual”指逐条语义阅读，不能解释为真人评分。部分额外复核在读过主审意见后进行；来源披露保留在二审证据中，不是完全盲审。三位初审的 1–5 分只作序数描述，不给三个角色排名、不推算独立同分布错误概率。

`initialParsedChatText` / `initialParsedChatReply` 是结构解析成功、进入语义检查前的聊天回复。R1 T49 第一个物理响应结构不合法，另保留在 [结构重试证据](r1-t049-structural-retry.json)，不能用成功重试覆盖首样本失败。三次真正的语义 repair 是 R1 T118、R3 T36、R3 T107；普通分行或气泡变化不等于新增 API 修复。

R1 最终 journal 为 completed，但它经书信失败后的有限观测适配器继续，不是原 runner 无中断通过；原失败回信没有重试。R3 使用原 runner 恢复 T87 文件故障。恢复更新的 journal 与单独封存的失败前缀分别追溯，不声称所有恢复前后文件字节相同。

场景是 15 次会话、每次 8 轮，模拟 45 天。三组都没有触发对话整理、自传巩固或 72 小时精细日程。360 轮完成不能替代长单会话、压缩压力或真人长期体验验证。

## 来源和完整性

`source-index.json` 记录实际选用的评阅、审计与打包输入路径和 SHA-256。`package-manifest.json` 覆盖本目录其他交付文件的大小和 hash；不包含自身，以避免递归。使用支持 ES modules 的 Node 运行：

```powershell
node docs/plans/Qwen_Three_Run_120_Turn_Evidence/verify-package.mjs
```

检查是离线只读，不调用模型、不改变原运行库。它核对交付 hash、360 个初审唯一轮次、63 个二审、42 个固定复核点、严重候选覆盖和预算总数。它验证证据包完整性，不重新判断语义正确性，也不将检查通过视为产品质量通过。

完整原始物理请求/响应、运行日志、SQLite 和失败前缀保存在本地 `tmp/companion-continuity-real/cc-qwen-long-r{1,2,3}-20260907` 及偏差记录列出的目录。包内仅收录可审阅的正文、评分和必要状态，未复制完整 provider 消息、隐藏推理、凭证或实例密钥。内部租约标识若有剔除，会在来源转换记录中注明；原件不改。私有 oracle 完整输入文件没有打包，其评阅和选定预期目标用于解释结果。
