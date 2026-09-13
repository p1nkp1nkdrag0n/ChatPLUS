import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  hostedApi,
  formatPoints,
  hostedMeKey,
  type HostedMe,
  type HostedAttempt,
  type HostedLedgerEntry,
  type HostedUsage,
} from "../../api/hosted";
import { useHosted } from "../../hooks/useHosted";
import {
  displayDate,
  formatTokens,
  purposeLabel,
} from "../../lib/hostedBilling";

const ATTEMPT_LABELS: Record<HostedAttempt["status"], string> = {
  reserved: "已预留",
  sent: "处理中",
  settled: "已结算",
  released: "已释放",
  unknown: "待核对",
};
function sumUsage(
  attempts: HostedAttempt[],
  key: keyof HostedUsage,
): number | null {
  if (
    attempts.some(
      (attempt) =>
        attempt.usage?.[key] === undefined || attempt.usage[key] === null,
    )
  )
    return null;
  return attempts.reduce(
    (sum, attempt) => sum + (attempt.usage?.[key] ?? 0),
    0,
  );
}

export function ReplyUsage({
  clientMessageId,
}: {
  clientMessageId: string | undefined;
}) {
  const hosted = useHosted();
  if (!hosted || !clientMessageId) return null;
  return <HostedReplyUsage clientMessageId={clientMessageId} />;
}

function HostedReplyUsage({ clientMessageId }: { clientMessageId: string }) {
  const client = useQueryClient();
  const [startedAt] = useState(Date.now);
  const billing = useQuery({
    queryKey: ["hosted", "billing", "turn", clientMessageId],
    queryFn: () => hostedApi.billing({ clientMessageId }),
    retry: 1,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    refetchInterval: (query) =>
      Date.now() - startedAt < 30_000 &&
      (!query.state.data?.attempts.length ||
        query.state.data.attempts.some((attempt) =>
          ["reserved", "sent"].includes(attempt.status),
        ))
        ? 2500
        : false,
  });
  useEffect(() => {
    const wallet = billing.data?.wallet;
    if (wallet)
      client.setQueryData<HostedMe>(hostedMeKey, (previous) =>
        previous ? { ...previous, wallet } : previous,
      );
  }, [billing.data?.wallet, client]);
  if (billing.isPending)
    return (
      <div className="hosted-reply-usage" role="status">
        正在读取本轮用量…
      </div>
    );
  if (billing.error)
    return (
      <div className="hosted-reply-usage">
        <span>用量暂时无法读取</span>
        <button className="text-button" onClick={() => void billing.refetch()}>
          重试
        </button>
      </div>
    );
  const attempts = billing.data?.attempts ?? [];
  if (attempts.length === 0)
    return (
      <div className="hosted-reply-usage">
        <Link to="/account">本轮用量尚未记录 · 查看账单</Link>
      </div>
    );
  const pending = attempts.some((attempt) =>
    ["unknown", "reserved", "sent"].includes(attempt.status),
  );
  const cost = attempts
    .filter((attempt) => attempt.status === "settled")
    .reduce((sum, attempt) => sum + (attempt.costMicros ?? 0), 0);
  const names = [
    ...new Set(attempts.map((attempt) => attempt.displayName).filter(Boolean)),
  ];
  return (
    <div className="hosted-reply-usage" aria-label="本轮用量与费用">
      {names.length ? <span>{names.join(" · ")}</span> : null}
      <span>输入 {formatTokens(sumUsage(attempts, "inputTokens"))}</span>
      <span>输出 {formatTokens(sumUsage(attempts, "outputTokens"))}</span>
      <span>
        缓存命中 {formatTokens(sumUsage(attempts, "cacheReadTokens"))}
      </span>
      <span>
        {pending
          ? `已结算 ${formatPoints(cost)} 积分 · 另有待核对用量`
          : `${formatPoints(cost)} 积分`}
      </span>
      <Link to="/account">费用明细</Link>
    </div>
  );
}

export function AttemptTable({
  attempts,
  admin = false,
  onReconcile,
}: {
  attempts: HostedAttempt[];
  admin?: boolean;
  onReconcile?: (attempt: HostedAttempt) => void;
}) {
  if (!attempts.length) return <p className="hosted-empty">还没有调用记录。</p>;
  return (
    <div className="hosted-table-scroll">
      <table className="hosted-table">
        <thead>
          <tr>
            <th>时间 / 模型</th>
            {admin ? <th>用户 / 用途</th> : <th>用途</th>}
            <th>输入 token</th>
            <th>输出 token</th>
            <th>缓存命中</th>
            <th>积分</th>
            <th>状态</th>
            {onReconcile ? <th>操作</th> : null}
          </tr>
        </thead>
        <tbody>
          {attempts.map((attempt) => (
            <tr key={attempt.id}>
              <td>
                <strong>
                  {attempt.displayName ??
                    attempt.modelSnapshot?.displayName ??
                    "模型调用"}
                </strong>
                <small>{displayDate(attempt.createdAtUtc)}</small>
              </td>
              <td>
                {admin ? <small>{attempt.userId}</small> : null}
                {admin ? attempt.purpose : purposeLabel(attempt.purpose)}
              </td>
              <td>{formatTokens(attempt.usage?.inputTokens)}</td>
              <td>{formatTokens(attempt.usage?.outputTokens)}</td>
              <td>{formatTokens(attempt.usage?.cacheReadTokens)}</td>
              <td>
                {attempt.status === "released"
                  ? "未扣费"
                  : formatPoints(attempt.costMicros)}
              </td>
              <td>
                <span
                  className={`hosted-status hosted-status--${attempt.status}`}
                >
                  {ATTEMPT_LABELS[attempt.status]}
                </span>
              </td>
              {onReconcile ? (
                <td>
                  {attempt.status === "unknown" ? (
                    <button
                      className="text-button"
                      onClick={() => onReconcile(attempt)}
                    >
                      人工核对
                    </button>
                  ) : (
                    "—"
                  )}
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function LedgerTable({ entries }: { entries: HostedLedgerEntry[] }) {
  if (!entries.length) return <p className="hosted-empty">还没有积分流水。</p>;
  const labels: Record<string, string> = {
    initial: "初始积分",
    invitation: "邀请码积分",
    credit: "增加积分",
    debit: "扣除积分",
    charge: "调用扣费",
    adjustment: "管理调整",
    refund: "退回积分",
    reserve: "预留积分",
    release: "释放预留",
    invite_credit: "邀请码积分",
    llm_charge: "调用扣费",
    admin_adjustment: "管理调整",
  };
  const reasons: Record<string, string> = {
    provider_usage: "按供应商返回用量结算",
    "Invitation starting balance": "邀请码初始积分",
  };
  return (
    <div className="hosted-table-scroll">
      <table className="hosted-table">
        <thead>
          <tr>
            <th>时间</th>
            <th>类型</th>
            <th>变动积分</th>
            <th>说明</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr key={entry.id}>
              <td>{displayDate(entry.createdAtUtc)}</td>
              <td>{labels[entry.kind] ?? entry.kind}</td>
              <td>
                {entry.deltaMicros > 0 ? "+" : ""}
                {formatPoints(entry.deltaMicros)}
              </td>
              <td>
                {reasons[entry.reason ?? entry.note ?? ""] ??
                  entry.reason ??
                  entry.note ??
                  "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
