# Qwen 短测问题修复记录

实施分支：`codex/qwen-state-and-generation-fixes`，起点 `cbec36d06be7efb62ac9aee2abd5eb0ef780ddf5`。

## 回归证据

`apps/server/src/test-fixtures/qwen-fresh-regressions.json` 保存经过审阅的最小文本、生成候选和 SHA-256。主要证据来自新角色运行 `cc-qwen-fresh-20260907-1652`，补充建议漏检来自中止运行 `cc-qwen-pilot-20260907-1649`。原始数据库、完整模型日志、密钥与 private oracle 不进入版本控制。

主要评分分母固定为普通交流 T1–T6、T10–T12 共 9 轮，明确求助 T8、T15、T16 共 3 轮。补充漏检与自然度样本独立记录。原始实验代码为 `3dd8ef2bebc4e737d53bad3ac3aea3b1a6a7eb8b`；新修复不能倒写旧实验结果。

PR-0 首先增加完整 T8 经聊天 HTTP 路径的持久化回归；预期旧代码会保存错误角色压力，因此该步骤故意保留红色测试，随后 PR-1 修复。归属、生成授权与建议解析各自独立变更，聊天仍复用当前证据和一次共享修复预算。

## PR-1：状态归属与持久化入口

完整 T8 的 HTTP 回归先复现 `expected 0 / actual 1` 压力记录。新解析接口保留原动作解析的历史 subject 语义，状态候选另用相对体验者、实际说话者、模态和原始 UTF-16 span。局部省略有边界；认知框架、句间和新话题不能无限继承。后置体验者（事情压着我）和同一主体的压力/清晰度量表仍可表达。

角色压力从最终已保存消息重新解析；仅本人断言、当前来源及回复前运行时状态支持的候选可进入压力投影。本轮模型 state delta 不能反过来授权这轮自述。普通当轮表达保留，缺少持久化依据的候选记录独立 `life.pressure_candidate_rejected`，不改写为用户压力。数值标明 `explicit_self_report / algorithm_initial / algorithm_update`，不将缺省 0.72 声称为测量。

旧有正向角色压力测试现在显式配置独立的高压力/低精力初态；省略主体的用户正例改为明确本人表达，另有 unknown 不写的对照。完整 T8 原文与原始实验保持不变。正向用户压力、支持方向、显式帮助、一次修复和重放均由集成测试分别检验；后续数据失效及全量验证另行提交。
