# Dearvale 成就收藏

成就是相处经历的永久纪念。收藏页只展示已经获得的徽章、名称、纪念文案、角色和日期。关系数值、门槛、判定证据和图片任务诊断只向开发者开放。

## 使用

- 主导航的“成就”提供“全部”“我的足迹”“与角色的纪念”及角色筛选，详情可用链接直接打开。
- 首次使用、连续使用、第一次发布角色、成功聊天、寄信、收到回信和启封都会自动记录；无需签到按钮。
- 连续使用按 `Asia/Shanghai` 自然日计算。网页可见且获得焦点时，首次打开、返回前台、联网恢复及每分钟检查登记服务端当前日期。隐藏或失焦不登记，客户端不能提交日期；同一天、多标签页、多角色均只记一天。断签不撤销旧徽章。
- 聊天以用户消息和最终角色回复一并成功提交为准；信件草稿不算寄出，生成回信和运输途中不算收到，实际进入已抵达状态才算。启封须成功解密。
- 示例角色自动发布不算用户创建角色；用户与示例角色的真实聊天及书信行为仍可计入首次行为。
- 所有角色以初识关系开始。轻量模式不增长关系；日常、拟真使用原有多维成长与每日限幅。

## 徽章图片设置

设置页的“徽章生图模型”独立于聊天模型。填写供应商地址、协议、模型名和密钥，启用并保存后可以测试。凭证沿用本实例的 AES-GCM 加密与 `.llm-key` 文件，不写入浏览器持久存储。更换协议或供应商地址时清除旧凭证，防止把密钥发送到新地址。

支持 OpenAI 兼容 `POST /images/generations` 的 Base64 或图片 URL，以及 Gemini 原生 `generateContent` 的最终 `inlineData` 图片；Gemini 思考过程图片不作为结果。模型名以设置为准，不自动选择收费模型。固定徽章不需要图片服务。

图片 URL 下载不携带供应商凭证、不跟随重定向，并在解析后固定连接到经过校验的公网地址。若使用本机或内网图片服务，请在供应商地址中明确填写 `localhost` 或内网 IP；该配置仅允许下载同源图片，其他本机、内网和链路本地地址仍会被拦截。

两枚高阶角色纪念共享首次生成时冻结的角色视觉主题，各自排队绘制。排队期间展示基础徽章，完成后自动替换；失败时成就仍保留，可在详情手动重试。编辑角色不会自动重绘已有图片。请求只包含有限的角色视觉特征及纪念主题，不传聊天或书信全文。

任务持久化并默认单并发。明确的临时失败最多追加两次自动重试；网络结果不明、超时及失去执行租约的任务不自动重发，以免重复计费。等待中的任务可以在服务重启后继续执行。测试用 `fixture` 图片协议仅允许开发者模式配置。

## 开发者模式

在实例 `.env` 中设置 `DEVELOPER_MODE=true` 并重启服务，才能访问开发者入口及接口；默认关闭。开发者页集中读取完整运行状态、关系、记忆、生活推演、成就规则、解锁证据及图片任务。普通 HTTP 和 SSE 响应始终采用公开投影，即使开发者模式开启也不夹带原始状态或诊断 metadata。开发者查询使用独立缓存键。

## 实现与存储

- `packages/contracts/src/achievements.ts`：公开收藏、图片设置及视觉请求类型。
- `apps/server/src/db/migrations/031_character_creation_origin.sql`：持久区分用户角色与示例角色。
- `apps/server/src/db/migrations/032_achievements.sql`：11 项全局规则、每角色 5 项规则、日历记录、独立解锁账本、通知确认和绘图任务。
- `apps/server/src/services/achievement-service.ts`：日期计算、公开查询、凭证设置、任务领取、图片入库和重试。
- `packages/providers/src/achievement-images.ts`：两种远程图片协议。
- `apps/server/src/http/public-projection.ts`：普通运行数据白名单。

角色发布、聊天提交、书信状态变化及关系状态更新通过 SQLite 触发器，在同一个业务事务中写入解锁和必要任务；事务回滚会一起回滚。唯一键为用户、成就与归属。提交后的全局修订号变化驱动 SSE 刷新，断线或刷新后从持久化未确认通知恢复。

成就账本不以角色外键级联删除；正常删除角色后，纪念文案、角色名称快照和图片继续保留。现有领域事件可绑定角色，新的成就账本独立存储全局记录。历史活动不会自动回填成就。

普通 API：

| 路径                                       | 作用                                             |
| ------------------------------------------ | ------------------------------------------------ |
| `POST /api/activity/visit`                 | 幂等登记服务端当前使用日期，请求体为空对象       |
| `GET /api/achievements`                    | 类别、角色及游标分页；同时返回待展示通知         |
| `GET /api/achievements/:id`                | 已获得收藏详情                                   |
| `GET /api/achievements/events`             | 与当前角色无关的 `achievements.changed` 刷新通知 |
| `POST /api/achievements/notifications/ack` | `{ ids: [...] }` 确认已经显示的通知              |
| `GET /api/achievements/:id/badge`          | 成品图片；`thumbnail=true` 获取缩略图            |
| `POST /api/achievements/:id/badge/retry`   | 仅重新排队失败的绘图任务                         |
| `GET/PUT /api/achievement-image/settings`  | 读取或保存独立图片配置                           |
| `POST /api/achievement-image/test`         | 测试已保存图片配置                               |

开发者额外读取 `GET /api/developer/achievements`；关闭开发者模式时路由不存在。

## 备份

徽章资产使用 `${resolve(ASSET_STORAGE_PATH)}-achievements` 独立目录，例如默认的 `data/assets-achievements`，不会进入纪念物清理范围。备份格式 v3 包含单独的 `achievement-assets/` 清单，仍能恢复 v1/v2。指定原有 `--assets` 时自动发现相邻徽章目录，也可以用 `--achievement-assets` 覆盖路径。`.llm-key` 继续单独保管，恢复时需与凭证指纹匹配。

自托管 Compose 为 `/app/assets-achievements` 配置独立命名卷。手动部署时也必须持久化这个目录。实例清理属于单次管理操作，不放入自动迁移；升级或重启不会删除用户角色和收藏。

## 验证

`achievements.integration.test.ts` 覆盖自然日、连续天数、回拨、跨年、重复请求、事务回滚、角色来源、关系门槛、角色删除、书信生命周期、通知和固定/专属徽章。Provider 测试使用模拟网络响应验证协议和错误处理；`tests/e2e/achievements-flow.spec.ts` 以受控图片响应及真实 fixture 后端验证收藏与解锁流程。真实图片供应商仍须在实例设置好对应凭证后执行设置页测试。
