# 成就火漆章图片 v2

基础章采用 C 组：缎面蜡质、不规则自然蜡边、少量香槟金压印细边。六档视觉色为酒红、松绿、深蓝、紫、金、珠母极光；这只是展示映射，成就名称、解锁事实与规则保持原样。`@personasim/contracts` 的 `getAchievementWaxBadge(key)` 为前端统一提供档位、颜色和静态图 URL，未知 key 使用酒红门扉章。

角色专属章继续通过项目已有生图配置生成，使用第一次解锁专属成就时冻结的角色视觉资料，以角色职业、世界或特征相关的象征压印表达纪念主题。`star` 固定金色，`constellation` 固定粉、青、紫、浅金交融的珠母极光。提示不含关系阈值、聊天内容或解锁规则，也不要求在图中书写角色姓名。

对于模型名为 `gpt-image-*` 或 `chatgpt-image-latest` 的 OpenAI compatible 配置，v2 请求显式发送 `background: "transparent"` 和 `output_format: "png"`，符合 [OpenAI 官方图片输出文档](https://developers.openai.com/api/docs/guides/image-generation#customize-image-output)；其他兼容模型保持通用参数，并通过提示与返回文件的 alpha 校验保证透明背景。

## 发布、保留与缓存

- 新解锁任务显式设置 `visual_version=2`，对应 `achievement_badge_v2`；旧任务保留 v1 规格，直到管理员明确安排重绘。`AchievementBadgeVisualSpecSchema` 同时接受 v1、v2，v2 增加 `finish` 字段。任务幂等键使用实际版本号；OpenAI compatible 请求同时携带该键作为 `idempotency-key` header，是否支持服务端去重取决于配置的供应商。
- v2 要求真实透明背景。服务端拒绝无 alpha、全不透明、仅在少量边角透明的实心底图，以及没有实色主体的无效输出，保留旧图并记录 `image_transparency_required`。配置测试也执行相同检查。通过检查后复用图片存储器生成最长 1024px WebP 和 320px 缩略图；尺寸和文件 hash 校验通过后才提交。
- `achievement_badge_versions` 保存成功图片的不可变内容 hash、完整图/缩略图路径、视觉版本、生成规格及供应商元数据。迁移 `034_achievement_wax_versions.sql` 只回填已有图片引用并更新新解锁触发器，不安排重绘、不调用生图接口。
- 任务中的当前图片指针与生成状态独立。pending、generating、failed 期间仍返回并读取已有图片；成功后以任务 claim 和视觉版本检查所有权，在同一个事务中添加历史版本并切换当前图片。失败或失去所有权的任务不能覆盖已发布图片。
- 公开 `Achievement` 数据结构不变。完整图 URL 为 `/api/achievements/:id/badge?v=<完整图 sha256>`，缩略图追加 `thumbnail=true`。携带有效 hash 时读取该历史版本并缓存一年（private、immutable）；旧的无版本 URL 读取当前图片并要求重新验证。未知 hash 返回 404，格式错误返回 400，不回退到其他版本。
- 当前图与历史图均计入清理引用。原有实例备份已包含独立的成就图片目录及数据库，历史表和完整图片目录共同备份与恢复。切换旧图不删除新图，也不修改冻结的角色资料。

## 一次性重绘与恢复

从项目根目录执行。命令默认只读 dry-run，不运行迁移、不启动 worker、不修改生图配置、不直接发起付费生成。

```powershell
pnpm exec tsx apps/server/src/scripts/achievement-wax.ts
# 或显式指定数据库
pnpm exec tsx apps/server/src/scripts/achievement-wax.ts --database ./data/personasim.db --dry-run
```

输出包括旧版候选、已安排或已尝试的 v2 任务，以及正在生成、需等待的旧任务。启用重绘前先使用现有 `selfhost:backup` 命令保存实例与资产，并部署 v2 worker、执行 `pnpm db:migrate`；不要让旧 worker 和新版本同时处理队列。

```powershell
# 一次性安排全部旧任务；也可重复 --id 只选择指定专属成就
pnpm exec tsx apps/server/src/scripts/achievement-wax.ts --enqueue
pnpm exec tsx apps/server/src/scripts/achievement-wax.ts --enqueue --id achievement_example
```

安排操作保留已有图与角色快照，把旧任务切换为 v2 pending，交给已有 worker。所有已经是 v2 的任务都会跳过，包括 pending、ready、failed 和主动恢复过旧图的任务，重复运行不会重复付费安排。选中任何正在生成的旧任务时整批拒绝，其他条目也不修改；等待该任务完成，或按现有过期租约恢复机制处理后，再运行。

已有并发和重试策略不变：全局串行，2 秒唤醒，5 分钟租约；只有明确可重试的 429/503 拒绝会按原有退避重试，总尝试最多 3 次。未知结果不会自动重新付费，失败任务使用已有手动重试入口。

逻辑请求键保存在 `request_id`，包含实际视觉版本及请求配置/冻结规格的摘要。自动重试与未知结果的手动恢复在请求未变时复用该键；收到明确失败输出后的手动重试创建新请求键，以免支持幂等缓存的供应商一直重放同一张无效图片。修改请求模型或目的地址后也会使用新键。

```powershell
# 查看某枚专属章保留的版本
pnpm exec tsx apps/server/src/scripts/achievement-wax.ts --history --id achievement_example
# 切换指定 hash 的历史图片；可用 --assets 指定不同的成就资产目录
pnpm exec tsx apps/server/src/scripts/achievement-wax.ts --restore <sha256> --id achievement_example
```

恢复命令先读取并校验完整图与缩略图的 hash，再切换指针；当前正在生成时拒绝操作，损坏或缺失文件不会成为当前图片。恢复会取消尚未开始的重绘，但保留任务已经尝试过的视觉版本，避免下次全量命令又覆盖管理员选择。

## 本次验证

覆盖 v1 回填、新任务 v2、规格与配色、透明背景、原图在重绘各状态下持续可见、失败重试、批量重复运行去重、生成中的批量拒绝、过期完成无法提交、历史文件清理保护、损坏恢复拒绝、历史备份恢复、带版本/无版本 HTTP 缓存与无效 hash。

2026-09-11 对当前配置数据库 `data/personasim.db` 只读 dry-run：专属任务总数 0，待重绘数 0，无需安排历史重绘；未为本次改版配置或调用后台图片供应商。静态基础章由内置 imagegen 独立生成。
