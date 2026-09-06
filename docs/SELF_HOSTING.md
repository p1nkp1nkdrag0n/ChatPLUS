# ChatPLUS 单实例自托管与恢复指南

本指南对应 R1.1：本地常驻 `resident` 与服务器 `worker` 使用完全相同的 `TemporalCatchUpService`、任务排序、幂等键和 SQLite lease。浏览器和 SSE 连接不参与任务发现；进程启动会全局扫描数据库，并为最近可处理时间设置计时器。

当前仍是单用户模型。远程测试必须坚持“一位朋友一个 Compose project、一个数据库、一个资产目录、一个 `INSTANCE_SECRET`、一个域名”，不得把多个朋友的数据放进同一实例。

## 安全边界

- 应用容器只在 Compose 私网 `expose: 3001`，不向宿主机发布该端口。
- Caddy 是唯一公网入口，自动处理 HTTPS，并在反向代理前执行 Basic Auth；认证成功后会先移除 `Authorization`，不会把可复用的 Basic Auth 凭据转发给应用进程。
- `SELFHOSTED_REVERSE_PROXY=true` 只有在 `NODE_ENV=production`、容器内 `HOST=0.0.0.0`（或 `::`）且 `WEB_ORIGIN` 全为 HTTPS origin 时才通过启动检查。它表示“端口已由认证代理隔离”，不是应用内认证功能。
- `.env`、数据库和备份目录都不得提交到 Git。Caddy 密码哈希可以进入实例环境文件，但明文密码、`INSTANCE_SECRET` 和 Provider API Key 只能存放在运维密钥存储中。
- `off` 或 `shadow` 并不放宽历史密文的密钥校验：数据库已有 fingerprint 或密文时，启动仍要求匹配的 secret。

## 准备一个朋友实例

1. 将 `.env.selfhosted.example` 复制到仓库外或被 Git 忽略的 `.env.friend-a`。
2. 把 `CHATPLUS_DOMAIN` 指向这台服务器，并开放 TCP 80/443 与 UDP 443。
3. 为 Caddy 生成 bcrypt 密码哈希，将结果用单引号按字面量写入 `CHATPLUS_BASIC_AUTH_HASH`，例如 `CHATPLUS_BASIC_AUTH_HASH='$2a$14$…'`；单引号可防止 Compose 把哈希中的 `$` 当作变量插值。不要把 Basic Auth 明文写进文件。
4. 用密码学安全随机源生成 32 字节，并以规范 Base64 写入 `INSTANCE_SECRET`。每个实例重新生成，禁止复制另一个朋友的 secret。
5. 将 `CHATPLUS_DATA_DIR`、`CHATPLUS_ASSETS_DIR`、`CHATPLUS_LOG_DIR` 和 `CHATPLUS_BACKUP_DIR` 改成该实例独占的宿主机目录，并在启动前显式创建。Compose 使用 `create_host_path: false`，路径拼错或缺失时会失败，不会悄悄创建 root-owned 空目录。Linux 上确保 UID 1000 可写，例如先执行 `install -d -m 0750`，再对这四个目录执行 `chown 1000:1000`。

示例启动命令：

```bash
docker compose \
  --env-file .env.friend-a \
  --project-name chatplus-friend-a \
  --file docker-compose.selfhosted.yml \
  up --detach --build
```

`.env.friend-a` 中的 `CHATPLUS_ENV_FILE` 也应指向同一个实例配置文件，这样 Compose 会把它只读挂载到 `/app/config/instance.env`。若 `--env-file` 使用仓库外路径（例如 `/secure/chatplus/friend-a.env`），这里也必须填写同一个绝对路径；示例放在仓库目录内时才写 `.env.friend-a`。镜像构建会执行 pnpm frozen install、Vite production build 和 server typecheck；运行阶段使用非 root `node` 用户。健康检查是 `/api/health`。

不要把示例中的 `REPLACE_*` 占位符当作凭据。启动失败时先看 `docker compose logs app`；日志只应包含结构化标识和错误码，不应包含信件正文、完整 Prompt、secret 或 API Key。

## 执行驱动

| 配置                            | 进程行为                                                             | 适用场景               |
| ------------------------------- | -------------------------------------------------------------------- | ---------------------- |
| `CORRESPONDENCE_EXECUTION=lazy` | 不启动常驻计时器；启动和相关角色入口调用同一补算服务                 | 纯本地、服务可随时关闭 |
| `resident`                      | 启动立即全局扫描，并按数据库最近 due/lease 设置 timer                | 本机 Node/Docker 常驻  |
| `worker`                        | 与 resident 使用同一循环和领域服务；跨进程由 SQLite claim/lease 仲裁 | 自托管服务器           |

`CORRESPONDENCE_MODE=shadow` 时，常驻驱动只处理去程/回程抵达等确定性任务，不 claim 模型生成任务；`enforced` 才处理四类书信任务。`off` 完全不启动书信 scheduler、不 claim 到期任务。模式或驱动都不改变有效时间顺序和最终领域历史。

FakeClock 开发环境中，`clock/set` 与 `clock/advance` 会先补算角色，再显式唤醒数据库 scheduler；真实 system clock 使用最近 due timer 和空闲轮询发现本进程或其他进程写入的任务。

## 安全备份

备份脚本会：

1. 对 SQLite 执行 `wal_checkpoint(TRUNCATE)`，busy 时直接失败；
2. 使用 SQLite online backup 生成一致数据库副本；
3. 复制资产并计算不含内容的聚合 SHA-256；
4. 复核数据库 schema 历史和不可逆实例 key fingerprint；
5. 在随机 `.partial` 目录中完成全部验证，最后才原子发布命名备份。

manifest 只含格式版本、migration 列表、数据库大小/哈希、不可逆 key fingerprint 以及资产数量/总字节/聚合哈希。它绝不包含 `INSTANCE_SECRET`、API Key、信件正文、Prompt 或解密内容。

在应用容器运行时执行：

```bash
docker compose \
  --env-file .env.friend-a \
  --project-name chatplus-friend-a \
  --file docker-compose.selfhosted.yml \
  exec app ./node_modules/.bin/tsx scripts/backup-instance.ts \
  --database /app/data/chatplus.sqlite \
  --assets /app/assets \
  --output /app/backups/2026-09-03T120000Z \
  --env-file /app/config/instance.env
```

宿主开发环境也可使用等价的 `pnpm selfhost:backup -- ...`。输出目录必须尚不存在，且不得位于资产目录内部。脚本失败不会留下有 manifest 的“半个备份”。

数据库备份和对应 `INSTANCE_SECRET` 必须作为同一个恢复批次保管，但 secret 必须放在独立的密钥存储/加密环境文件中，脚本刻意不把它复制到备份目录。只有数据库而没有 secret，未启封回信无法恢复。

## 恢复演练

恢复必须面向全新、明确的数据库文件和资产目录；只要任一目标已经存在，脚本就拒绝覆盖。它会在创建目标前完成以下预检：

- manifest 为严格的受支持格式，数据库与资产 SHA-256 匹配；
- 备份数据库记录的 migration 历史是当前程序支持的有序前缀，不含未知/更高 schema；
- 数据库 key metadata 与 manifest 一致；
- 当前环境中的 `INSTANCE_SECRET` 指纹与备份匹配；
- 备份和资产树不含符号链接或路径逃逸。

先停止旧实例，并恢复到一个新实例目录：

```bash
docker compose \
  --env-file .env.friend-a \
  --project-name chatplus-friend-a \
  --file docker-compose.selfhosted.yml \
  run --rm --no-deps --entrypoint ./node_modules/.bin/tsx app \
  scripts/restore-instance.ts \
  --backup /app/backups/2026-09-03T120000Z \
  --database /app/data/restored/chatplus.sqlite \
  --assets /app/assets/restored \
  --env-file /app/config/instance.env
```

恢复目标放在已经挂载的 `/app/data` 和 `/app/assets` 的新子目录中，因此 `run --rm` 退出后仍保留在宿主机；不要改回 `/app/data-restored` 之类未挂载的 sibling 路径。宿主开发环境可使用 `pnpm selfhost:restore -- ...`。恢复完成后，将 `CHATPLUS_DATA_DIR` 指向原 data 目录下的 `restored` 子目录、将 `CHATPLUS_ASSETS_DIR` 指向原 assets 目录下的 `restored` 子目录，再启动实例；先检查 `/api/health` 和历史信件启封，再触发一次 worker tick/重启验证。任务 claim、logical generation run、稳定 reply id 与 business commit 都是幂等的，恢复测试已覆盖重复 worker tick 不产生第二封回信。

## 更新、回滚与隔离检查

- 更新镜像前先备份；新镜像启动会按 migration registry 补齐旧 schema。
- 功能回滚使用 `CORRESPONDENCE_MODE=off`，不删除 018/019 或后续表。已有到达历史仍可读/启封，但待处理任务暂停。
- 每次恢复或复制配置后，确认错误 secret 会 fail-fast；绝不能通过删除 fingerprint 来“修复”启动。
- 两个朋友实例应使用不同 Compose project 名、域名、宿主目录和 secret。示例中的 Caddy 独占宿主 TCP 80/443 与 UDP 443，所以两个实例同时运行时必须位于不同主机/独立 IP，或由运维方提供一个共享边缘代理按域名分流、并移除各项目内的 Caddy 端口发布；仅更换 project 名不能避免同一宿主的端口冲突。无论采用哪种拓扑，它们都不得共享 SQLite、资产、Caddy volume 或 SSE 连接。
- 当前不实现 Electron、系统通知、密钥轮换、跨实例迁移或多租户。
