import { useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import {
  Activity,
  BookOpenText,
  Coins,
  Database,
  Download,
  KeyRound,
  LogOut,
  Network,
  Plus,
  RefreshCw,
  Search,
  Server,
  Settings,
  Shield,
  Users,
} from "lucide-react";
import { LlmPurposeSchema } from "@personasim/contracts";
import {
  hostedApi,
  formatPoints,
  pointsToMicros,
  type AdminUser,
  type HostedAttempt,
  type HostedLimits,
  type HostedModel,
  type HostedModelInput,
  type HostedResearchRecord,
  type ResearchFilters,
} from "../api/hosted";
import { useHosted } from "../hooks/useHosted";
import { LoadingBlock } from "../components/Feedback";
import { AttemptTable, LedgerTable } from "../components/hosted/HostedBilling";
import { displayDate, formatStorage } from "../lib/hostedBilling";
import { hostedModelPricingReady } from "../lib/hostedModelPricing";

const SECTIONS = [
  { path: "", label: "运行概览", icon: Activity },
  { path: "users", label: "测试用户", icon: Users },
  { path: "invitations", label: "邀请码", icon: KeyRound },
  { path: "models", label: "模型与价格", icon: Server },
  { path: "purposes", label: "用途映射", icon: Network },
  { path: "billing", label: "账单与核对", icon: Coins },
  { path: "research", label: "研究数据", icon: BookOpenText },
  { path: "maintenance", label: "维护与限制", icon: Settings },
] as const;

function Failure({ error }: { error: unknown }) {
  return error ? (
    <p className="hosted-error" role="alert">
      {error instanceof Error ? error.message : "操作未完成，请稍后重试。"}
    </p>
  ) : null;
}
function Success({ children }: { children: ReactNode }) {
  return (
    <p className="hosted-success" role="status">
      {children}
    </p>
  );
}
function AdminHeading({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="hosted-admin-heading">
      <div>
        <p className="hosted-eyebrow">DEARVALE / 测试管理</p>
        <h1>{title}</h1>
        {description ? <p className="hosted-muted">{description}</p> : null}
      </div>
      {actions}
    </header>
  );
}
function RefreshButton({
  refresh,
  pending,
}: {
  refresh: () => unknown;
  pending: boolean;
}) {
  return (
    <button
      className="button button--secondary"
      disabled={pending}
      onClick={() => void refresh()}
    >
      <RefreshCw size={16} />
      刷新
    </button>
  );
}
function useAdminRefresh() {
  const client = useQueryClient();
  return () => client.invalidateQueries({ queryKey: ["hosted", "admin"] });
}
function PointInput({
  label,
  name,
  value,
  required = true,
}: {
  label: string;
  name: string;
  value?: number;
  required?: boolean;
}) {
  return (
    <label className="field">
      {label}
      <input
        name={name}
        type="number"
        min="0"
        step="0.000001"
        required={required}
        defaultValue={value === undefined ? "" : value / 1_000_000}
      />
    </label>
  );
}
function NumberInput({
  label,
  name,
  value,
  min = 1,
  max,
}: {
  label: string;
  name: string;
  value: number;
  min?: number;
  max?: number;
}) {
  return (
    <label className="field">
      {label}
      <input
        name={name}
        type="number"
        min={min}
        max={max}
        step="1"
        required
        defaultValue={value}
      />
    </label>
  );
}
function formString(data: FormData, key: string): string {
  const value = data.get(key);
  return typeof value === "string" ? value.trim() : "";
}
function formPoints(data: FormData, key: string): number {
  return pointsToMicros(formString(data, key));
}

export default function HostedAdminPage() {
  const hosted = useHosted();
  const [error, setError] = useState<unknown>();
  const [loggingOut, setLoggingOut] = useState(false);
  if (
    !hosted ||
    hosted.info.surface !== "admin" ||
    hosted.session.user.role !== "admin"
  )
    return <Navigate to="/welcome" replace />;
  return (
    <div className="hosted-admin-shell">
      <aside className="hosted-admin-nav">
        <NavLink to="/admin" className="hosted-admin-brand">
          <Shield size={27} />
          <span>
            Dearvale<small>管理控制台</small>
          </span>
        </NavLink>
        <nav aria-label="管理导航">
          {SECTIONS.map(({ path, label, icon: Icon }) => (
            <NavLink
              key={path}
              to={`/admin${path ? `/${path}` : ""}`}
              end={!path}
              className={({ isActive }) =>
                `hosted-admin-nav__item${isActive ? " is-active" : ""}`
              }
            >
              <Icon size={18} />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="hosted-admin-nav__account">
          <span>{hosted.session.user.username}</span>
          <button
            className="text-button"
            disabled={loggingOut}
            onClick={() => {
              setLoggingOut(true);
              void hosted
                .logout()
                .catch(setError)
                .finally(() => setLoggingOut(false));
            }}
          >
            <LogOut size={15} />
            退出
          </button>
        </div>
      </aside>
      <main className="hosted-admin-main">
        <Failure error={error} />
        <Routes>
          <Route index element={<OverviewSection />} />
          <Route path="users" element={<UsersSection />} />
          <Route path="invitations" element={<InvitationsSection />} />
          <Route path="models" element={<ModelsSection />} />
          <Route path="purposes" element={<PurposesSection />} />
          <Route path="billing" element={<BillingSection />} />
          <Route path="research" element={<ResearchSection />} />
          <Route path="maintenance" element={<MaintenanceSection />} />
          <Route path="*" element={<Navigate to="/admin" replace />} />
        </Routes>
      </main>
    </div>
  );
}

function OverviewSection() {
  const query = useQuery({
    queryKey: ["hosted", "admin", "overview"],
    queryFn: hostedApi.overview,
    refetchInterval: 20_000,
  });
  const data = query.data;
  return (
    <>
      <AdminHeading
        title="运行概览"
        description="查看测试服务的账号、积分与调用状态。"
        actions={
          <RefreshButton refresh={query.refetch} pending={query.isFetching} />
        }
      />
      <Failure error={query.error} />
      {query.isPending ? (
        <LoadingBlock />
      ) : data ? (
        <>
          <div className="hosted-stats hosted-stats--admin">
            <section>
              <span>测试账号</span>
              <strong>{data.users}</strong>
              <small>
                正常 {data.activeUsers} · 已封禁 {data.bannedUsers}
              </small>
            </section>
            <section>
              <span>累计调用</span>
              <strong>{data.requestCount}</strong>
            </section>
            <section>
              <span>已结算积分</span>
              <strong>{formatPoints(data.chargedMicros)}</strong>
            </section>
            <section>
              <span>待核对调用</span>
              <strong>{data.pendingReconciliations}</strong>
              <NavLink to="/admin/billing">打开账单核对 →</NavLink>
            </section>
          </div>
          <div className="hosted-two-column">
            <section className="hosted-panel">
              <h2>账号资金</h2>
              <dl className="hosted-definitions">
                <dt>总余额</dt>
                <dd>{formatPoints(data.totalBalanceMicros)} 积分</dd>
                <dt>预留金额</dt>
                <dd>{formatPoints(data.totalHeldMicros)} 积分</dd>
                <dt>正在执行 / 排队</dt>
                <dd>
                  {data.calls?.active ?? 0} / {data.calls?.queued ?? 0}
                </dd>
                <dt>正在生成图片</dt>
                <dd>{data.calls?.activeImages ?? 0}</dd>
              </dl>
              <p className="hosted-muted">
                处理中和待核对的调用会占用预留积分，完成结算或释放后更新可用余额。
              </p>
            </section>
            <section className="hosted-panel">
              <h2>测试准备</h2>
              <div className="hosted-shortcuts">
                <NavLink to="/admin/models">配置模型与价格 →</NavLink>
                <NavLink to="/admin/purposes">分配后台用途模型 →</NavLink>
                <NavLink to="/admin/invitations">创建测试邀请码 →</NavLink>
                <NavLink to="/admin/maintenance">设置调用上限与备份 →</NavLink>
              </div>
            </section>
          </div>
        </>
      ) : null}
    </>
  );
}

function UsersSection() {
  const [draft, setDraft] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [selected, setSelected] = useState<AdminUser | null>(null);
  const query = useQuery({
    queryKey: ["hosted", "admin", "users", search, status],
    queryFn: () => hostedApi.users(search, status),
  });
  const refresh = useAdminRefresh();
  return (
    <>
      <AdminHeading
        title="测试用户"
        description="搜索账号，调整积分，管理访问权限和密码。"
      />
      <form
        className="hosted-filter-bar"
        onSubmit={(event) => {
          event.preventDefault();
          setSearch(draft.trim());
        }}
      >
        <label className="hosted-search">
          <Search size={17} />
          <input
            aria-label="搜索用户名"
            placeholder="用户名或账号 ID"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
        </label>
        <select
          aria-label="账号状态"
          value={status}
          onChange={(event) => setStatus(event.target.value)}
        >
          <option value="">全部状态</option>
          <option value="active">正常</option>
          <option value="banned">已封禁</option>
        </select>
        <button className="button button--secondary">搜索</button>
      </form>
      <Failure error={query.error} />
      {query.isPending ? (
        <LoadingBlock />
      ) : (
        <section className="hosted-panel">
          {query.data?.users.length ? (
            <div className="hosted-table-scroll">
              <table className="hosted-table">
                <thead>
                  <tr>
                    <th>账号</th>
                    <th>状态</th>
                    <th>可用积分</th>
                    <th>预留积分</th>
                    <th>注册时间</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {query.data.users.map((user) => (
                    <tr key={user.id}>
                      <td>
                        <strong>{user.username}</strong>
                        <small>{user.id}</small>
                        {user.role === "admin" ? <small>管理员</small> : null}
                      </td>
                      <td>
                        <span
                          className={`hosted-status hosted-status--${user.status}`}
                        >
                          {user.status === "active" ? "正常" : "已封禁"}
                        </span>
                      </td>
                      <td>{formatPoints(user.wallet?.availableMicros)}</td>
                      <td>{formatPoints(user.wallet?.reservedMicros)}</td>
                      <td>{displayDate(user.createdAtUtc)}</td>
                      <td>
                        <button
                          className="text-button"
                          onClick={() => setSelected(user)}
                        >
                          管理
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="hosted-empty">没有匹配的账号。</p>
          )}
        </section>
      )}
      {selected ? (
        <UserEditor
          key={`${selected.id}:${selected.updatedAtUtc}`}
          user={selected}
          onClose={() => setSelected(null)}
          onSaved={() => {
            setSelected(null);
            void refresh();
          }}
        />
      ) : null}
    </>
  );
}

function UserEditor({
  user,
  onClose,
  onSaved,
}: {
  user: AdminUser;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [localError, setLocalError] = useState<unknown>();
  const update = useMutation({
    mutationFn: (input: {
      status: AdminUser["status"];
      balanceMicros: number;
      reason: string;
    }) => hostedApi.updateUser(user.id, input),
    onSuccess: onSaved,
  });
  const password = useMutation({
    mutationFn: (value: string) => hostedApi.resetPassword(user.id, value),
  });
  return (
    <section className="hosted-panel hosted-editor">
      <div className="hosted-section-heading">
        <h2>管理 {user.username}</h2>
        <button className="text-button" onClick={onClose}>
          关闭
        </button>
      </div>
      <div className="hosted-two-column">
        <form
          className="hosted-form"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            try {
              setLocalError(undefined);
              update.mutate({
                status: formString(form, "status") as AdminUser["status"],
                balanceMicros: formPoints(form, "balance"),
                reason: formString(form, "reason"),
              });
            } catch (error) {
              setLocalError(error);
            }
          }}
        >
          <label className="field">
            账号状态
            <select name="status" defaultValue={user.status}>
              <option value="active">正常</option>
              <option value="banned">封禁</option>
            </select>
          </label>
          <PointInput
            label="设置账号总余额（积分）"
            name="balance"
            value={user.wallet.balanceMicros}
          />
          <label className="field">
            调整原因
            <input
              name="reason"
              required
              maxLength={500}
              placeholder="例如：第二轮测试额度"
            />
          </label>
          <p className="hosted-muted hosted-small">
            设置的是总余额；已有预留积分仍会从可用额度中扣除。
          </p>
          <Failure error={localError ?? update.error} />
          <button
            className="button button--primary"
            disabled={update.isPending}
          >
            {update.isPending ? "保存中…" : "保存账号调整"}
          </button>
        </form>
        <form
          className="hosted-form"
          onSubmit={(event) => {
            event.preventDefault();
            const form = event.currentTarget;
            password.mutate(formString(new FormData(form), "password"), {
              onSuccess: () => form.reset(),
            });
          }}
        >
          <h3>重置密码</h3>
          <label className="field">
            新的临时密码
            <input
              name="password"
              type="password"
              autoComplete="new-password"
              minLength={10}
              maxLength={128}
              required
            />
          </label>
          <p className="hosted-muted hosted-small">
            用户下次登录需要修改密码。请通过你们约定的方式告知临时密码。
          </p>
          <Failure error={password.error} />
          {password.isSuccess ? <Success>密码已重置。</Success> : null}
          <button
            className="button button--secondary"
            disabled={password.isPending}
          >
            重置密码
          </button>
        </form>
      </div>
    </section>
  );
}

function InvitationsSection() {
  const query = useQuery({
    queryKey: ["hosted", "admin", "invitations"],
    queryFn: hostedApi.invitations,
  });
  const refresh = useAdminRefresh();
  const [error, setError] = useState<unknown>();
  const [code, setCode] = useState("");
  const [copied, setCopied] = useState(false);
  const create = useMutation({
    mutationFn: hostedApi.createInvitation,
    onSuccess: (value) => {
      setCode(value.code);
      setCopied(false);
      void refresh();
    },
  });
  const revoke = useMutation({
    mutationFn: hostedApi.revokeInvitation,
    onSuccess: refresh,
  });
  return (
    <>
      <AdminHeading
        title="邀请码"
        description="分配测试席位与初始积分。邀请码创建后只显示一次。"
      />
      <section className="hosted-panel">
        <h2>创建邀请码</h2>
        <form
          className="hosted-form"
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            try {
              setError(undefined);
              const expires = formString(data, "expires");
              create.mutate({
                label: formString(data, "label"),
                initialBalanceMicros: formPoints(data, "balance"),
                maxUses: Number(formString(data, "uses")),
                ...(expires
                  ? { expiresAtUtc: new Date(expires).toISOString() }
                  : {}),
              });
            } catch (value) {
              setError(value);
            }
          }}
        >
          <div className="hosted-form-grid">
            <label className="field">
              备注
              <input
                name="label"
                required
                maxLength={120}
                placeholder="周末测试小组"
              />
            </label>
            <NumberInput label="可使用次数" name="uses" value={1} max={1000} />
            <PointInput label="每个账号的初始积分" name="balance" value={0} />
            <label className="field">
              过期时间（可选）
              <input name="expires" type="datetime-local" />
            </label>
          </div>
          <Failure error={error ?? create.error} />
          <button
            className="button button--primary"
            disabled={create.isPending}
          >
            <Plus size={17} />
            {create.isPending ? "创建中…" : "创建邀请码"}
          </button>
        </form>
        {code ? (
          <div className="hosted-invite-result">
            <span>请现在保存邀请码</span>
            <code>{code}</code>
            <button
              className="button button--secondary"
              onClick={() => {
                void navigator.clipboard
                  .writeText(code)
                  .then(() => setCopied(true))
                  .catch(setError);
              }}
            >
              {copied ? "已复制" : "复制邀请码"}
            </button>
          </div>
        ) : null}
      </section>
      <section className="hosted-panel">
        <h2>邀请码记录</h2>
        <Failure error={query.error ?? revoke.error} />
        {query.isPending ? (
          <LoadingBlock />
        ) : query.data?.invitations.length ? (
          <div className="hosted-table-scroll">
            <table className="hosted-table">
              <thead>
                <tr>
                  <th>备注</th>
                  <th>使用情况</th>
                  <th>初始积分</th>
                  <th>过期时间</th>
                  <th>状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {query.data.invitations.map((invite) => (
                  <tr key={invite.id}>
                    <td>{invite.label}</td>
                    <td>
                      {invite.uses} / {invite.maxUses}
                    </td>
                    <td>{formatPoints(invite.initialBalanceMicros)}</td>
                    <td>
                      {invite.expiresAtUtc
                        ? displayDate(invite.expiresAtUtc)
                        : "不设期限"}
                    </td>
                    <td>
                      {invite.revokedAtUtc
                        ? "已停用"
                        : invite.expiresAtUtc &&
                            new Date(invite.expiresAtUtc) < new Date()
                          ? "已过期"
                          : invite.uses >= invite.maxUses
                            ? "已用完"
                            : "可用"}
                    </td>
                    <td>
                      {!invite.revokedAtUtc ? (
                        <button
                          className="text-button"
                          disabled={revoke.isPending}
                          onClick={() => revoke.mutate(invite.id)}
                        >
                          停用
                        </button>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="hosted-empty">还没有邀请码。</p>
        )}
      </section>
    </>
  );
}

function ModelsSection() {
  const query = useQuery({
    queryKey: ["hosted", "admin", "models"],
    queryFn: hostedApi.models,
  });
  const [selected, setSelected] = useState<HostedModel | "new" | null>(null);
  const refresh = useAdminRefresh();
  return (
    <>
      <AdminHeading
        title="模型与价格"
        description="配置用户看到的名称、实际供应商模型和计费价格。"
        actions={
          <button
            className="button button--primary"
            onClick={() => setSelected("new")}
          >
            <Plus size={17} />
            添加模型
          </button>
        }
      />
      <p className="hosted-muted hosted-small">
        文本输入和输出、图片每张积分必须大于
        0。缓存命中可以免费，缓存写入可以留空。
        计费未配置完成的模型只保存为停用草稿，不会发送新的供应商请求；历史已结算结果仍可恢复。
      </p>
      <Failure error={query.error} />
      {query.isPending ? (
        <LoadingBlock />
      ) : (
        <section className="hosted-panel">
          {query.data?.models.length ? (
            <div className="hosted-table-scroll">
              <table className="hosted-table">
                <thead>
                  <tr>
                    <th>显示名称 / ID</th>
                    <th>真实模型</th>
                    <th>输入 / 输出</th>
                    <th>缓存命中 / 写入</th>
                    <th>状态</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {query.data.models.map((model) => (
                    <tr key={model.routeId}>
                      <td>
                        <strong>{model.displayName}</strong>
                        <small>
                          {model.routeId} · v{model.revision}
                        </small>
                      </td>
                      <td>
                        {model.modelId}
                        <small>{model.protocol}</small>
                      </td>
                      <td>
                        {model.kind === "image"
                          ? `${formatPoints(model.imagePointsMicros)} / 张`
                          : `${formatPoints(model.inputMicrosPerMillion)} / ${formatPoints(model.outputMicrosPerMillion)}`}
                        <small>
                          {model.kind === "image"
                            ? "积分 / 张"
                            : "积分 / 百万 token"}
                        </small>
                      </td>
                      <td>
                        {formatPoints(model.cacheReadMicrosPerMillion)} /{" "}
                        {formatPoints(
                          model.cacheWriteMicrosPerMillion ??
                            model.inputMicrosPerMillion,
                        )}
                      </td>
                      <td>
                        {!hostedModelPricingReady(model)
                          ? "计费待配置 · 不会调用"
                          : model.enabled
                            ? "已启用"
                            : "已停用"}
                        <small>
                          {model.keyConfigured ? "密钥已配置" : "尚未配置密钥"}
                        </small>
                      </td>
                      <td>
                        <button
                          className="text-button"
                          onClick={() => setSelected(model)}
                        >
                          编辑
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="hosted-empty">先添加一个模型，再分配后台用途。</p>
          )}
        </section>
      )}
      {selected ? (
        <ModelEditor
          key={
            typeof selected === "string"
              ? "new"
              : `${selected.routeId}:${selected.revision}`
          }
          model={selected === "new" ? null : selected}
          onClose={() => setSelected(null)}
          onSaved={() => {
            setSelected(null);
            void refresh();
          }}
        />
      ) : null}
    </>
  );
}

function ModelEditor({
  model,
  onClose,
  onSaved,
}: {
  model: HostedModel | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [kind, setKind] = useState<"text" | "image">(model?.kind ?? "text");
  const [pricingReady, setPricingReady] = useState(
    model ? hostedModelPricingReady(model) : false,
  );
  const [modelEnabled, setModelEnabled] = useState(model?.enabled ?? false);
  const [error, setError] = useState<unknown>();
  const save = useMutation({
    mutationFn: (value: HostedModelInput) =>
      hostedApi.saveModel(value, Boolean(model)),
    onSuccess: onSaved,
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    try {
      setError(undefined);
      const apiKey = formString(data, "apiKey");
      const cacheWrite = formString(data, "cacheWrite");
      if (
        Number(formString(data, "maxContextTokens")) <=
        Number(formString(data, "maxOutputTokens"))
      )
        throw new Error("上下文上限需要大于输出上限，为输入提示留出空间。");
      save.mutate({
        routeId: model?.routeId ?? formString(data, "routeId"),
        displayName: formString(data, "displayName"),
        kind,
        protocol: formString(data, "protocol") as HostedModel["protocol"],
        baseUrl: formString(data, "baseUrl"),
        modelId: formString(data, "modelId"),
        inputMicrosPerMillion: formPoints(data, "input"),
        outputMicrosPerMillion: formPoints(data, "output"),
        cacheReadMicrosPerMillion: formPoints(data, "cacheRead"),
        ...(cacheWrite
          ? { cacheWriteMicrosPerMillion: pointsToMicros(cacheWrite) }
          : {}),
        maxOutputTokens: Number(formString(data, "maxOutputTokens")),
        maxContextTokens: Number(formString(data, "maxContextTokens")),
        ...(kind === "image"
          ? {
              imagePointsMicros: formPoints(data, "imagePoints"),
              imageSpecification: formString(data, "imageSpecification"),
            }
          : {}),
        enabled: data.get("enabled") === "on",
        ...(apiKey ? { apiKey } : {}),
      });
    } catch (value) {
      setError(value);
    }
  };
  return (
    <section className="hosted-panel hosted-editor">
      <div className="hosted-section-heading">
        <h2>{model ? `编辑 ${model.displayName}` : "添加模型"}</h2>
        <button className="text-button" onClick={onClose}>
          关闭
        </button>
      </div>
      <form
        className="hosted-form"
        onSubmit={submit}
        onChange={(event) => {
          const data = new FormData(event.currentTarget);
          try {
            setPricingReady(
              hostedModelPricingReady({
                kind: formString(data, "kind") as "text" | "image",
                inputMicrosPerMillion: formPoints(data, "input"),
                outputMicrosPerMillion: formPoints(data, "output"),
                cacheReadMicrosPerMillion: formPoints(data, "cacheRead"),
                ...(formString(data, "cacheWrite")
                  ? {
                      cacheWriteMicrosPerMillion: formPoints(
                        data,
                        "cacheWrite",
                      ),
                    }
                  : {}),
                ...(formString(data, "kind") === "image"
                  ? { imagePointsMicros: formPoints(data, "imagePoints") }
                  : {}),
              }),
            );
          } catch {
            setPricingReady(false);
          }
        }}
      >
        <div className="hosted-form-grid">
          <label className="field">
            用户显示名称
            <input
              name="displayName"
              required
              maxLength={120}
              defaultValue={model?.displayName}
              placeholder="例如：林间轻语"
            />
          </label>
          <label className="field">
            公开模型 ID
            <input
              name="routeId"
              required
              pattern={"[A-Za-z0-9_\\-]+"}
              maxLength={100}
              defaultValue={model?.routeId}
              readOnly={Boolean(model)}
              placeholder="例如：Claude-opus-4-6"
              aria-describedby="public-model-id-help"
              title="使用 1–100 个英文字母、数字、下划线 _ 或短横线 -，不能包含点号或空格。"
              onInvalid={(event) => {
                const input = event.currentTarget;
                input.setCustomValidity(
                  input.validity.valueMissing
                    ? "请填写公开模型 ID，例如 Claude-opus-4-6。"
                    : input.validity.patternMismatch
                      ? "公开模型 ID 只能包含英文字母、数字、下划线 _ 或短横线 -；请将点号或空格改为短横线，例如 Claude-opus-4-6。"
                      : "",
                );
              }}
              onInput={(event) => event.currentTarget.setCustomValidity("")}
            />
            <span
              id="public-model-id-help"
              className="hosted-muted hosted-small"
            >
              自定义标识，1–100 个英文字母、数字、下划线 _ 或短横线 -，
              不支持点号和空格；保存后不可修改。显示名称和真实模型 ID
              不受此字符限制。
            </span>
          </label>
          <label className="field">
            模型类型
            <select
              name="kind"
              value={kind}
              onChange={(event) =>
                setKind(event.target.value as "text" | "image")
              }
            >
              <option value="text">文本模型</option>
              <option value="image">图片模型</option>
            </select>
          </label>
          <label className="field">
            供应商协议
            <select
              name="protocol"
              defaultValue={model?.protocol ?? "openai-compatible"}
            >
              <option value="openai-compatible">OpenAI 兼容</option>
              <option value="anthropic">Anthropic</option>
              <option value="gemini">Gemini</option>
            </select>
          </label>
          <label className="field">
            API 根地址
            <input
              name="baseUrl"
              type="url"
              required
              defaultValue={model?.baseUrl}
              placeholder="https://api.example.com/v1"
            />
          </label>
          <label className="field">
            真实调用模型 ID
            <input
              name="modelId"
              required
              maxLength={250}
              defaultValue={model?.modelId}
            />
          </label>
          <label className="field">
            {model?.keyConfigured ? "更换 API Key（留空保留）" : "API Key"}
            <input
              name="apiKey"
              type="password"
              autoComplete="new-password"
              required={!model?.keyConfigured}
              placeholder={
                model?.keyConfigured
                  ? "已加密保存，不会回显"
                  : "填写服务端使用的密钥"
              }
            />
          </label>
          <NumberInput
            label="模型上下文上限 token"
            name="maxContextTokens"
            value={model?.maxContextTokens ?? 128000}
            min={8192}
            max={2000000}
          />
          <NumberInput
            label="单次最大输出 token"
            name="maxOutputTokens"
            value={model?.maxOutputTokens ?? 4096}
            max={64000}
          />
        </div>
        <h3>价格 · 积分 / 百万 token</h3>
        <p className="hosted-muted hosted-small">
          上下文上限应按供应商实际能力填写，并为输入提示预留空间。
          价格按本次调用的配置快照计算；修改后只影响新调用。缓存命中属于输入
          token 的一部分，计费时单独应用缓存价格。
        </p>
        <div className="hosted-form-grid">
          <PointInput
            label="非缓存输入价格"
            name="input"
            value={model?.inputMicrosPerMillion ?? 0}
          />
          <PointInput
            label="输出价格"
            name="output"
            value={model?.outputMicrosPerMillion ?? 0}
          />
          <PointInput
            label="缓存命中价格"
            name="cacheRead"
            value={model?.cacheReadMicrosPerMillion ?? 0}
          />
          <PointInput
            label="缓存写入价格（可选）"
            name="cacheWrite"
            {...(model?.cacheWriteMicrosPerMillion === undefined
              ? {}
              : { value: model.cacheWriteMicrosPerMillion })}
            required={false}
          />
          {kind === "image" ? (
            <>
              <PointInput
                label="每张图片积分"
                name="imagePoints"
                value={model?.imagePointsMicros ?? 0}
              />
              <label className="field">
                图片尺寸与质量
                <input
                  name="imageSpecification"
                  required
                  defaultValue={model?.imageSpecification ?? "1024x1024"}
                  placeholder="例如：1024x1024:standard"
                />
                <small className="hosted-muted">
                  格式为宽x高，可附加 :质量。
                </small>
              </label>
            </>
          ) : null}
        </div>
        <label className="hosted-checkbox">
          <input
            name="enabled"
            type="checkbox"
            disabled={!pricingReady}
            checked={pricingReady && modelEnabled}
            onChange={(event) => setModelEnabled(event.target.checked)}
          />
          启用此模型
        </label>
        {!pricingReady ? (
          <p className="hosted-error" role="status">
            计费尚未配置完成。文本输入和输出价格、或每张图片积分必须大于 0。
            当前只能保存为停用草稿，不会产生新的供应商调用。
          </p>
        ) : (
          <p className="hosted-muted hosted-small">
            计费配置已完成。勾选启用后，还需在“维护与限制”允许新的模型调用。
          </p>
        )}
        <Failure error={error ?? save.error} />
        <button className="button button--primary" disabled={save.isPending}>
          {save.isPending
            ? "正在保存…"
            : pricingReady
              ? "保存模型与价格"
              : "保存为停用草稿"}
        </button>
      </form>
    </section>
  );
}

const PURPOSE_NAMES: Record<string, string> = {
  default: "默认文本模型",
  compile_character: "角色编译",
  character_interview: "角色访谈",
  import_character: "角色导入",
  plan_schedule: "安排规划",
  chat_turn: "聊天回复",
  repair_chat_turn: "回复结构修复",
  review_reply_goal: "回复目标复核",
  rewrite_reply_goal: "回复目标重写",
  rewrite_reply_affinity: "回复语气调整",
  enrich_activity: "活动细节",
  compose_proactive_message: "主动消息",
  checkpoint_autobiography: "长期记忆摘要",
  letter_reply: "书信回复",
  achievement_image: "成就图片",
};
function PurposesSection() {
  const models = useQuery({
    queryKey: ["hosted", "admin", "models"],
    queryFn: hostedApi.models,
  });
  const mappings = useQuery({
    queryKey: ["hosted", "admin", "mappings"],
    queryFn: hostedApi.mappings,
  });
  const refresh = useAdminRefresh();
  const save = useMutation({
    mutationFn: hostedApi.saveMappings,
    onSuccess: refresh,
  });
  return (
    <>
      <AdminHeading
        title="用途映射"
        description="为自动发生的后台调用分配模型，所有调用统一经过账号余额与限额检查。"
      />
      <Failure error={models.error ?? mappings.error ?? save.error} />
      {models.isPending || mappings.isPending ? (
        <LoadingBlock />
      ) : mappings.data && models.data ? (
        <section className="hosted-panel">
          <form
            className="hosted-form"
            key={JSON.stringify(mappings.data)}
            onChange={() => save.reset()}
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              const values: Record<string, string> = {};
              for (const [key, value] of form)
                if (typeof value === "string" && value) values[key] = value;
              save.mutate(values);
            }}
          >
            <div className="hosted-form-grid">
              {[
                ...new Set([
                  "default",
                  ...LlmPurposeSchema.options,
                  "achievement_image",
                  ...Object.keys(mappings.data.mappings),
                ]),
              ].map((purpose) => (
                <label className="field" key={purpose}>
                  {PURPOSE_NAMES[purpose] ?? purpose}
                  <select
                    name={purpose}
                    defaultValue={mappings.data.mappings[purpose] ?? ""}
                  >
                    <option value="">跟随默认配置</option>
                    {models.data.models
                      .filter(
                        (model) =>
                          model.enabled &&
                          model.kind ===
                            (purpose === "achievement_image"
                              ? "image"
                              : "text"),
                      )
                      .map((model) => (
                        <option key={model.routeId} value={model.routeId}>
                          {model.displayName} · {model.modelId}
                        </option>
                      ))}
                  </select>
                  <small className="hosted-muted">{purpose}</small>
                </label>
              ))}
            </div>
            {save.isSuccess ? <Success>用途映射已保存。</Success> : null}
            <button
              className="button button--primary"
              disabled={save.isPending}
            >
              {save.isPending ? "保存中…" : "保存用途映射"}
            </button>
          </form>
        </section>
      ) : null}
    </>
  );
}

function BillingSection() {
  const [draftUser, setDraftUser] = useState("");
  const [userId, setUserId] = useState("");
  const [status, setStatus] = useState("");
  const [selected, setSelected] = useState<HostedAttempt | null>(null);
  const query = useQuery({
    queryKey: ["hosted", "admin", "billing", userId, status],
    queryFn: () => hostedApi.adminBilling(userId, status),
  });
  const refresh = useAdminRefresh();
  return (
    <>
      <AdminHeading
        title="账单与核对"
        description="查看最近 1000 次真实调用、token 与积分流水，对供应商用量不确定的调用进行人工核对。"
        actions={
          <RefreshButton refresh={query.refetch} pending={query.isFetching} />
        }
      />
      <form
        className="hosted-filter-bar"
        onSubmit={(event) => {
          event.preventDefault();
          setUserId(draftUser.trim());
        }}
      >
        <input
          aria-label="按用户 ID 筛选账单"
          placeholder="用户 ID（可选）"
          value={draftUser}
          onChange={(event) => setDraftUser(event.target.value)}
        />
        <select
          aria-label="调用状态"
          value={status}
          onChange={(event) => setStatus(event.target.value)}
        >
          <option value="">全部状态</option>
          <option value="unknown">待核对</option>
          <option value="settled">已结算</option>
          <option value="reserved">已预留</option>
          <option value="sent">处理中</option>
          <option value="released">已释放</option>
        </select>
        <button className="button button--secondary">筛选</button>
      </form>
      <Failure error={query.error} />
      {query.isPending ? (
        <LoadingBlock />
      ) : (
        <section className="hosted-panel">
          <AttemptTable
            attempts={query.data?.attempts ?? []}
            admin
            onReconcile={setSelected}
          />
        </section>
      )}
      {selected ? (
        <ReconcileEditor
          key={selected.id}
          attempt={selected}
          onClose={() => setSelected(null)}
          onSaved={() => {
            setSelected(null);
            void refresh();
          }}
        />
      ) : null}
      <section className="hosted-panel">
        <h2>积分流水</h2>
        <LedgerTable entries={query.data?.entries ?? []} />
      </section>
    </>
  );
}
function ReconcileEditor({
  attempt,
  onClose,
  onSaved,
}: {
  attempt: HostedAttempt;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [action, setAction] = useState<"charge" | "release">("charge");
  const [error, setError] = useState<unknown>();
  const save = useMutation({
    mutationFn: (input: {
      action: "charge" | "release";
      amountMicros?: number;
      reason: string;
    }) => hostedApi.reconcile(attempt.id, input),
    onSuccess: onSaved,
  });
  return (
    <section className="hosted-panel hosted-editor">
      <div className="hosted-section-heading">
        <h2>核对调用</h2>
        <button className="text-button" onClick={onClose}>
          关闭
        </button>
      </div>
      <p className="hosted-muted">
        {attempt.id} · 预留 {formatPoints(attempt.maximumCostMicros)} 积分
      </p>
      <form
        className="hosted-form"
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          try {
            setError(undefined);
            save.mutate({
              action,
              ...(action === "charge"
                ? { amountMicros: formPoints(data, "amount") }
                : {}),
              reason: formString(data, "reason"),
            });
          } catch (value) {
            setError(value);
          }
        }}
      >
        <label className="field">
          处理方式
          <select
            value={action}
            onChange={(event) =>
              setAction(event.target.value as "charge" | "release")
            }
          >
            <option value="charge">按确认金额结算</option>
            <option value="release">不扣费，释放预留</option>
          </select>
        </label>
        {action === "charge" ? (
          <PointInput label="确认扣除积分" name="amount" value={0} />
        ) : null}
        <label className="field">
          核对依据
          <textarea
            name="reason"
            required
            rows={3}
            placeholder="填写供应商账单或请求核对结果"
          />
        </label>
        <Failure error={error ?? save.error} />
        <button className="button button--primary" disabled={save.isPending}>
          {save.isPending ? "正在处理…" : "确认核对结果"}
        </button>
      </form>
    </section>
  );
}

const RESEARCH_KIND_LABELS = {
  input: "用户输入",
  output: "用户收到的输出",
  request: "模型完整请求",
  response: "模型原始响应",
  image: "图片输出",
};
function ResearchSection() {
  const client = useQueryClient();
  const [filters, setFilters] = useState<ResearchFilters>({});
  const [selected, setSelected] = useState<HostedResearchRecord | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ["hosted", "admin", "research", filters],
    queryFn: () => hostedApi.research(filters),
  });
  const detail = useQuery({
    queryKey: ["hosted", "admin", "research-detail", selected?.id],
    queryFn: () => hostedApi.researchDetail(selected!.id),
    enabled: Boolean(selected),
  });
  const exportData = useMutation({
    mutationFn: () => hostedApi.researchExport(filters),
    onSuccess: (data) => {
      const url = URL.createObjectURL(data);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `dearvale-research-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
  });
  const remove = useMutation({
    mutationFn: hostedApi.researchDelete,
    onSuccess: () => {
      setSelected(null);
      setDeleteTarget(null);
      void client.invalidateQueries({
        queryKey: ["hosted", "admin", "research"],
      });
    },
  });
  return (
    <>
      <AdminHeading
        title="研究数据"
        actions={
          <button
            className="button button--secondary"
            disabled={exportData.isPending || query.isPending}
            onClick={() => exportData.mutate()}
          >
            <Download size={17} />
            {exportData.isPending ? "导出中…" : "导出筛选结果"}
          </button>
        }
      />
      <form
        className="hosted-filter-bar hosted-filter-bar--wrap"
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          const values: ResearchFilters = {};
          for (const key of [
            "userId",
            "operationId",
            "sessionId",
            "modelId",
            "purpose",
            "kind",
            "from",
            "to",
          ] as const) {
            const value = formString(data, key);
            if (value)
              values[key] =
                key === "from" || key === "to"
                  ? new Date(value).toISOString()
                  : value;
          }
          setFilters(values);
          setSelected(null);
        }}
      >
        <input
          name="userId"
          aria-label="研究数据用户 ID"
          placeholder="用户 ID"
        />
        <input
          name="operationId"
          aria-label="研究数据操作 ID"
          placeholder="操作 ID"
        />
        <input
          name="sessionId"
          aria-label="研究数据会话 ID"
          placeholder="会话 ID"
        />
        <input
          name="modelId"
          aria-label="研究数据真实模型 ID"
          placeholder="真实模型 ID"
        />
        <select name="purpose" aria-label="研究数据用途">
          <option value="">全部用途</option>
          {Object.entries(PURPOSE_NAMES)
            .filter(([purpose]) => purpose !== "default")
            .map(([purpose, label]) => (
              <option key={purpose} value={purpose}>
                {label}
              </option>
            ))}
        </select>
        <select name="kind" aria-label="输入或输出">
          <option value="">全部模型输入与输出</option>
          <option value="request">模型完整请求</option>
          <option value="response">模型原始响应</option>
          <option value="image">图片输出</option>
        </select>
        <label className="field">
          开始时间
          <input name="from" type="datetime-local" />
        </label>
        <label className="field">
          结束时间
          <input name="to" type="datetime-local" />
        </label>
        <button className="button button--secondary">筛选</button>
      </form>
      <Failure error={query.error ?? exportData.error ?? remove.error} />
      {exportData.isSuccess ? <Success>导出文件已生成。</Success> : null}
      <section className="hosted-panel">
        {query.isPending ? (
          <LoadingBlock />
        ) : query.data?.records.length ? (
          <div className="hosted-table-scroll">
            <table className="hosted-table">
              <thead>
                <tr>
                  <th>类型 / 时间</th>
                  <th>用户 / 调用</th>
                  <th>显示模型 / 实际模型</th>
                  <th>用途</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {query.data.records.map((record) => (
                  <tr key={record.id}>
                    <td>
                      <span className="hosted-status">
                        {RESEARCH_KIND_LABELS[record.kind]}
                      </span>
                      <small>{displayDate(record.createdAtUtc)}</small>
                    </td>
                    <td>
                      {record.userId}
                      <small>{record.attemptId ?? record.operationId}</small>
                    </td>
                    <td>
                      {record.displayName}
                      <small>{record.modelId}</small>
                    </td>
                    <td>{record.purpose}</td>
                    <td>
                      {record.deletedAtUtc ? (
                        "已删除"
                      ) : (
                        <>
                          <button
                            className="text-button"
                            onClick={() => {
                              setSelected(record);
                              setDeleteTarget(null);
                            }}
                          >
                            查看内容
                          </button>
                          <button
                            className="text-button hosted-danger"
                            onClick={() => setDeleteTarget(record.id)}
                          >
                            删除
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="hosted-empty">没有符合条件的研究记录。</p>
        )}
        <div className="hosted-pagination">
          <span className="hosted-muted">
            第 {Math.floor(Number(filters.offset ?? 0) / 100) + 1} 页 · 每页最多
            100 条
          </span>
          <button
            className="button button--secondary"
            disabled={query.isFetching || Number(filters.offset ?? 0) === 0}
            onClick={() => {
              setSelected(null);
              setFilters((previous) => ({
                ...previous,
                offset: String(Math.max(0, Number(previous.offset ?? 0) - 100)),
              }));
            }}
          >
            上一页
          </button>
          <button
            className="button button--secondary"
            disabled={
              query.isFetching || (query.data?.records.length ?? 0) < 100
            }
            onClick={() => {
              setSelected(null);
              setFilters((previous) => ({
                ...previous,
                offset: String(Number(previous.offset ?? 0) + 100),
              }));
            }}
          >
            下一页
          </button>
        </div>
      </section>
      {deleteTarget ? (
        <section className="hosted-panel hosted-confirm" role="alert">
          <h2>删除此研究记录？</h2>
          <p>将删除这条记录的研究内容，保留必要的操作审计。此操作不能撤销。</p>
          <div className="hosted-actions">
            <button
              className="button button--secondary"
              disabled={remove.isPending}
              onClick={() => setDeleteTarget(null)}
            >
              取消
            </button>
            <button
              className="button hosted-danger-button"
              disabled={remove.isPending}
              onClick={() => remove.mutate(deleteTarget)}
            >
              确认删除
            </button>
          </div>
        </section>
      ) : null}
      {selected ? (
        <section className="hosted-panel hosted-editor">
          <div className="hosted-section-heading">
            <h2>{RESEARCH_KIND_LABELS[selected.kind]}</h2>
            <button className="text-button" onClick={() => setSelected(null)}>
              关闭
            </button>
          </div>
          <p className="hosted-muted">
            {selected.id} · {selected.displayName} / {selected.modelId}
          </p>
          {detail.isPending ? (
            <LoadingBlock />
          ) : detail.error ? (
            <Failure error={detail.error} />
          ) : (
            <pre className="hosted-payload">
              {typeof detail.data?.payload === "string"
                ? detail.data.payload
                : JSON.stringify(detail.data?.payload, null, 2)}
            </pre>
          )}
        </section>
      ) : null}
    </>
  );
}

function MaintenanceSection() {
  const models = useQuery({
    queryKey: ["hosted", "admin", "models"],
    queryFn: hostedApi.models,
  });
  const query = useQuery({
    queryKey: ["hosted", "admin", "maintenance"],
    queryFn: hostedApi.maintenance,
  });
  const refresh = useAdminRefresh();
  const [error, setError] = useState<unknown>();
  const [backupPassword, setBackupPassword] = useState("");
  const enabledModels =
    models.data?.models.filter((model) => model.enabled) ?? [];
  const canEnableCalls =
    !models.isPending &&
    !models.error &&
    enabledModels.length > 0 &&
    enabledModels.every(
      (model) => hostedModelPricingReady(model) && model.keyConfigured,
    );
  const save = useMutation({
    mutationFn: hostedApi.saveLimits,
    onSuccess: refresh,
  });
  const backup = useMutation({
    mutationFn: hostedApi.backup,
    onSuccess: () => setBackupPassword(""),
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    if (!query.data) return;
    try {
      setError(undefined);
      if (form.get("callsEnabled") === "on" && !canEnableCalls)
        throw new Error(
          "请先在“模型与价格”配置并启用至少一个模型，确保所有启用模型已配置正价和服务器凭据。",
        );
      const limits: HostedLimits = {
        ...query.data.limits,
        registrationEnabled: form.get("registrationEnabled") === "on",
        callsEnabled: form.get("callsEnabled") === "on",
        globalConcurrency: Number(formString(form, "globalConcurrency")),
        perUserConcurrency: Number(formString(form, "perUserConcurrency")),
        maxQueuedCalls: Number(formString(form, "maxQueuedCalls")),
        maxRequestBytes: Number(formString(form, "maxRequestBytes")),
        perUserDailyMicros: formPoints(form, "perUserDailyMicros"),
        globalDailyMicros: formPoints(form, "globalDailyMicros"),
        researchRetentionDays: Number(
          formString(form, "researchRetentionDays"),
        ),
        sessionDays: Number(formString(form, "sessionDays")),
      };
      save.mutate(limits);
    } catch (value) {
      setError(value);
    }
  };
  return (
    <>
      <AdminHeading
        title="维护与限制"
        description="控制公开服务的使用上限，管理数据保留与备份。"
      />
      <Failure error={query.error} />
      {query.data?.storage ? (
        <div className="hosted-stats">
          <section>
            <span>中央数据库</span>
            <strong>
              {formatStorage(
                query.data.storage.controlBytes +
                  query.data.storage.controlWalBytes,
              )}
            </strong>
            <small>包含数据库与写入日志</small>
          </section>
          <section>
            <span>研究数据库</span>
            <strong>
              {formatStorage(
                query.data.storage.researchBytes +
                  query.data.storage.researchWalBytes,
              )}
            </strong>
            <small>包含数据库与写入日志</small>
          </section>
          <section>
            <span>磁盘可用空间</span>
            <strong>
              {formatStorage(query.data.storage.diskAvailableBytes)}
            </strong>
            <small>服务器数据目录所在磁盘</small>
          </section>
        </div>
      ) : null}
      {query.isPending ? (
        <LoadingBlock />
      ) : query.data ? (
        <section className="hosted-panel">
          <h2>服务限制</h2>
          <Failure error={models.error} />
          {!canEnableCalls ? (
            <p className="hosted-error" role="status">
              计费配置未完成，不能开启新的模型调用。请先在“模型与价格”配置正的输入和输出价格（图片为每张积分），保存并启用模型。
              缓存命中价格可以为 0；服务器会在每次新请求前再次检查。
              <NavLink to="/admin/models">前往模型与价格</NavLink>
            </p>
          ) : (
            <p className="hosted-muted hosted-small">
              所有启用模型已配置计费与凭据。允许调用后，每次请求仍会检查余额与每日积分上限。
            </p>
          )}
          <form
            className="hosted-form"
            key={`${JSON.stringify(query.data.limits)}:${canEnableCalls}`}
            onChange={() => save.reset()}
            onSubmit={submit}
          >
            <div className="hosted-actions">
              <label className="hosted-checkbox">
                <input
                  name="registrationEnabled"
                  type="checkbox"
                  defaultChecked={query.data.limits.registrationEnabled}
                />
                允许邀请码注册
              </label>
              <label className="hosted-checkbox">
                <input
                  name="callsEnabled"
                  type="checkbox"
                  disabled={!canEnableCalls}
                  defaultChecked={
                    query.data.limits.callsEnabled && canEnableCalls
                  }
                />
                允许新的模型调用
              </label>
            </div>
            <div className="hosted-form-grid">
              <NumberInput
                label="全局同时调用数"
                name="globalConcurrency"
                value={query.data.limits.globalConcurrency}
              />
              <NumberInput
                label="每人同时调用数"
                name="perUserConcurrency"
                value={query.data.limits.perUserConcurrency}
              />
              <NumberInput
                label="最大排队调用数"
                name="maxQueuedCalls"
                value={query.data.limits.maxQueuedCalls}
                min={1}
              />
              <NumberInput
                label="单次请求最大字节数"
                name="maxRequestBytes"
                value={query.data.limits.maxRequestBytes}
                min={1024}
              />
              <PointInput
                label="每人每日积分上限"
                name="perUserDailyMicros"
                value={query.data.limits.perUserDailyMicros}
              />
              <PointInput
                label="全局每日积分上限"
                name="globalDailyMicros"
                value={query.data.limits.globalDailyMicros}
              />
              <NumberInput
                label="研究内容保留天数（0 表示不自动清理）"
                name="researchRetentionDays"
                value={query.data.limits.researchRetentionDays}
                min={0}
              />
              <NumberInput
                label="登录会话有效天数"
                name="sessionDays"
                value={query.data.limits.sessionDays}
                min={1}
              />
            </div>
            <Failure error={error ?? save.error} />
            {save.isSuccess ? <Success>服务限制已保存。</Success> : null}
            <button
              className="button button--primary"
              disabled={save.isPending}
            >
              {save.isPending ? "保存中…" : "保存服务限制"}
            </button>
          </form>
        </section>
      ) : null}
      <section className="hosted-panel">
        <h2>
          <Database size={21} /> 数据备份
        </h2>
        <p className="hosted-muted">
          在服务器上创建加密备份，包含账号、独立用户数据和研究档案。恢复时需要使用这里设置的备份密码，请妥善保存。
        </p>
        <form
          className="hosted-form"
          onSubmit={(event) => {
            event.preventDefault();
            backup.mutate(backupPassword);
          }}
        >
          <label className="field">
            备份加密密码（至少 12 个字符）
            <input
              type="password"
              autoComplete="new-password"
              minLength={12}
              required
              value={backupPassword}
              onChange={(event) => setBackupPassword(event.target.value)}
            />
          </label>
          <Failure error={backup.error} />
          {backup.data ? (
            <Success>
              备份已完成：<code>{backup.data.path}</code>
              <br />
              {backup.data.keyPath ? (
                <>
                  独立密钥包：<code>{backup.data.keyPath}</code>
                  <br />
                  恢复需要数据包、密钥包和备份密码，请分别保管。
                  <br />
                </>
              ) : null}
              {displayDate(backup.data.createdAtUtc)}
            </Success>
          ) : null}
          <button
            className="button button--secondary"
            disabled={backup.isPending}
          >
            <Database size={17} />
            {backup.isPending ? "正在创建备份…" : "创建加密备份"}
          </button>
        </form>
      </section>
      <section className="hosted-panel">
        <h2>近期管理操作</h2>
        {query.data?.audit?.length ? (
          <div className="hosted-table-scroll">
            <table className="hosted-table">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>操作人</th>
                  <th>操作</th>
                  <th>对象</th>
                </tr>
              </thead>
              <tbody>
                {query.data.audit.map((entry) => (
                  <tr key={entry.id}>
                    <td>{displayDate(entry.createdAtUtc)}</td>
                    <td>{entry.actorId}</td>
                    <td>{entry.action}</td>
                    <td>{entry.targetId ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="hosted-empty">还没有管理操作记录。</p>
        )}
      </section>
    </>
  );
}
