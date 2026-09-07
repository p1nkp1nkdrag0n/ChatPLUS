# Qwen 短测问题修复记录

实施分支：`codex/qwen-state-and-generation-fixes`，起点 `cbec36d06be7efb62ac9aee2abd5eb0ef780ddf5`。

## 回归证据

`apps/server/src/test-fixtures/qwen-fresh-regressions.json` 保存经过审阅的最小文本、生成候选和 SHA-256。主要证据来自新角色运行 `cc-qwen-fresh-20260907-1652`，补充建议漏检来自中止运行 `cc-qwen-pilot-20260907-1649`。原始数据库、完整模型日志、密钥与 private oracle 不进入版本控制。

主要评分分母固定为普通交流 T1–T6、T10–T12 共 9 轮，明确求助 T8、T15、T16 共 3 轮。补充漏检与自然度样本独立记录。原始实验代码为 `3dd8ef2bebc4e737d53bad3ac3aea3b1a6a7eb8b`；新修复不能倒写旧实验结果。

PR-0 首先增加完整 T8 经聊天 HTTP 路径的持久化回归；预期旧代码会保存错误角色压力，因此该步骤故意保留红色测试，随后 PR-1 修复。归属、生成授权与建议解析各自独立变更，聊天仍复用当前证据和一次共享修复预算。
