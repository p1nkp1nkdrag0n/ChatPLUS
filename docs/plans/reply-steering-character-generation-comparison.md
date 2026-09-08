# 独立角色生成比较补充

回复引导实验使用人工冻结的三种角色规格，目的是让同场景、同人格、同模型的两个回复分支只有指定引导字段不同。为补充真实角色生成能力的覆盖，另行运行角色编译比较；它生成的角色只进入自己的隔离数据库，不替换回复实验快照。

固定输入来自 `reply-steering-scenarios.ts`：三种角色共享纪录片剪辑师背景、创作价值、失去合作的经历和朋友关系，分别表达温和细察、沉静直率、明快外露的性格。每种模型收到完全相同的对应作者输入，输入哈希、实际模型配置、代码与锁文件指纹写入清单。

默认矩阵为 DeepSeek、GLM、Qwen、GPT-6 Astra × 三种性格，共 12 次主要生成。通过生产 `POST /api/characters/generate`、`POST /api/characters/:id/publish`、`GET /api/characters/:id` 完成生成、发布、读取。编译沿用生产 32,000 输出 token 上限与一次重试，所有物理请求（包括失败与重试）共享 72 次请求、10,000,000 保守预留单位上限；预留单位是 UTF-8 请求字节加输出上限，不是实际账单。

运行 fixture：

```powershell
pnpm exec tsx apps/server/src/scripts/character-generation-comparison.ts --fixture --output tmp/character-generation-fixture-unique
```

真实运行需要当前任务已批准的模型权限，并显式设置脚本开关：

```powershell
$env:RUN_PAID_REPLY_STEERING = '1'
pnpm exec tsx apps/server/src/scripts/character-generation-comparison.ts --output tmp/character-generation-real-unique
```

输出目录必须是工作区内、被 Git 忽略且尚不存在的新目录。可用 `--profiles`、`--personas` 缩小矩阵；不支持覆盖或恢复。每个候选保存作者输入、HTTP 记录、可见模型输出、解析提案、生成与发布规格、来源、权限审查、用量和失败证据；隐藏推理与密钥不写入证据。

字段保留诊断包括身份、职业、时区、作者语气、明确性格标签与原始素材保存情况；同时记录具体行为、价值、经历、硬规则数量和服务端权限审查。它们是检查线索，不能当作语义分数。人工应分别审阅事实保留、人物区分度、行为与例外的具体性、无依据新增经历，以及把普通偏好升级为硬限制的问题。单个模型每种性格只有一次生成，是小样本筛查，不能据此宣称稳定排名。
