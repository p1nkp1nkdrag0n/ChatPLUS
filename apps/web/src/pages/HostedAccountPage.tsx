import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { LogOut, RefreshCw, Wallet } from "lucide-react";
import {
  hostedApi,
  hostedMeKey,
  formatPoints,
  type HostedMe,
} from "../api/hosted";
import { useHosted } from "../hooks/useHosted";
import { ErrorBlock, LoadingBlock } from "../components/Feedback";
import { PageHeader } from "../components/PageHeader";
import { PasswordChange } from "../components/HostedBoundary";
import { AttemptTable, LedgerTable } from "../components/hosted/HostedBilling";

export default function HostedAccountPage() {
  const hosted = useHosted();
  const client = useQueryClient();
  const [logoutError, setLogoutError] = useState<unknown>();
  const [loggingOut, setLoggingOut] = useState(false);
  const billing = useQuery({
    queryKey: ["hosted", "billing"],
    queryFn: () => hostedApi.billing(),
    enabled: Boolean(hosted),
    refetchInterval: 30_000,
  });
  const models = useQuery({
    queryKey: ["hosted", "public-models"],
    queryFn: hostedApi.publicModels,
    enabled: Boolean(hosted),
  });
  useEffect(() => {
    const wallet = billing.data?.wallet;
    if (wallet)
      client.setQueryData<HostedMe>(hostedMeKey, (previous) =>
        previous ? { ...previous, wallet } : previous,
      );
  }, [billing.data?.wallet, client]);
  if (!hosted) return null;
  const wallet = billing.data?.wallet ?? hosted.session.wallet;
  return (
    <div className="page hosted-account">
      <PageHeader
        title="我的账号"
        description={`${hosted.session.user.username} · 测试积分与使用明细`}
        actions={
          <button
            className="button button--secondary"
            disabled={loggingOut}
            onClick={() => {
              setLoggingOut(true);
              void hosted
                .logout()
                .catch(setLogoutError)
                .finally(() => setLoggingOut(false));
            }}
          >
            <LogOut size={17} />
            {loggingOut ? "退出中…" : "退出登录"}
          </button>
        }
      />
      {logoutError ? <ErrorBlock error={logoutError} /> : null}
      <div className="hosted-stats">
        <section>
          <Wallet size={22} />
          <span>可用积分</span>
          <strong>{formatPoints(wallet.availableMicros)}</strong>
        </section>
        <section>
          <span>预留积分</span>
          <strong>{formatPoints(wallet.reservedMicros)}</strong>
          <small>处理中或待核对请求暂时占用</small>
        </section>
        <section>
          <span>账号余额</span>
          <strong>{formatPoints(wallet.balanceMicros)}</strong>
          <small>可用积分与预留积分之和</small>
        </section>
      </div>
      <section className="hosted-panel">
        <div className="hosted-section-heading">
          <h2>调用明细</h2>
          <button
            className="text-button"
            disabled={billing.isFetching}
            onClick={() => {
              void billing.refetch();
              void hosted.refresh();
            }}
          >
            <RefreshCw size={16} />
            刷新
          </button>
        </div>
        <p className="hosted-muted">
          显示最近 100
          次调用。一次回复可能包含多次模型调用。这里逐次列出实际用量；供应商未返回的
          token 显示为未知，待核对费用不会被当作零费用。
        </p>
        {billing.isPending ? (
          <LoadingBlock label="正在读取账单…" />
        ) : billing.error ? (
          <ErrorBlock error={billing.error} />
        ) : (
          <AttemptTable attempts={billing.data?.attempts ?? []} />
        )}
      </section>
      <section className="hosted-panel">
        <h2>积分流水</h2>
        {billing.data ? <LedgerTable entries={billing.data.entries} /> : null}
      </section>
      <section className="hosted-panel">
        <h2>模型价格</h2>
        <p className="hosted-muted">
          文本价格单位为积分 / 百万
          token。缓存命中单独计价。历史调用使用当时的价格。
        </p>
        {models.isPending ? (
          <LoadingBlock />
        ) : models.error ? (
          <ErrorBlock error={models.error} />
        ) : models.data?.models.length ? (
          <div className="hosted-table-scroll">
            <table className="hosted-table">
              <thead>
                <tr>
                  <th>显示名称</th>
                  <th>输入</th>
                  <th>输出</th>
                  <th>缓存命中</th>
                </tr>
              </thead>
              <tbody>
                {models.data.models.map((model) => (
                  <tr key={model.publicModelId}>
                    <td>{model.displayName}</td>
                    {model.kind === "image" ? (
                      <td colSpan={3}>
                        {formatPoints(model.imagePointsMicros)} 积分 / 张
                      </td>
                    ) : (
                      <>
                        <td>{formatPoints(model.inputMicrosPerMillion)}</td>
                        <td>{formatPoints(model.outputMicrosPerMillion)}</td>
                        <td>{formatPoints(model.cacheReadMicrosPerMillion)}</td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="hosted-empty">管理员尚未开放可用模型。</p>
        )}
      </section>
      <PasswordChange
        onSaved={(session) => client.setQueryData(hostedMeKey, session)}
      />
    </div>
  );
}
