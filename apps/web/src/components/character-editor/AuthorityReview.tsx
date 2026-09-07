import type { CharacterSpec } from "../../api/types";

export type AuthorityDecision = {
  candidateId: string;
  candidateSha256: string;
  decision: "accept" | "reject";
};

const STRENGTH = {
  hard: "硬约束",
  soft: "倾向",
  fact: "初始事实",
  phrase: "固定用语",
  lock: "锁定字段",
};
const STATUS = { accepted: "已确认", pending: "待复核", rejected: "未采用" };

export function AuthorityReview({
  spec,
  busy,
  onDecide,
}: {
  spec: CharacterSpec;
  busy: boolean;
  onDecide: (decision: AuthorityDecision) => void;
}) {
  const audit = spec.authorityAudit;
  if (audit === undefined)
    return (
      <p className="muted">
        此历史角色尚未记录约束来源。保存为新草稿后可逐项复核，原发布版本会保留。
      </p>
    );
  const pending = audit.candidates.filter(
    (candidate) => candidate.status === "pending",
  );
  return (
    <section className="editor-section" aria-label="约束来源复核">
      <h2>约束来源复核</h2>
      <p>
        待复核 {pending.length}{" "}
        项。请同时检查内容、适用对象与强度。确认后会保存新版本；未采用的候选仍保留在对照中。
      </p>
      {audit.candidates.length === 0 ? (
        <p>当前没有需要审查的额外约束。</p>
      ) : (
        audit.candidates.map((candidate) => (
          <details
            key={candidate.candidateId}
            open={candidate.status === "pending"}
          >
            <summary>
              {candidate.target} · {STRENGTH[candidate.strength]} ·{" "}
              {STATUS[candidate.status]}
            </summary>
            <p>{candidate.reason}</p>
            <label className="field">
              <span>原始候选</span>
              <textarea readOnly value={candidate.originalValue} rows={4} />
            </label>
            {candidate.providerValue !== undefined &&
            candidate.providerValue !== candidate.originalValue ? (
              <label className="field">
                <span>模型最初返回内容</span>
                <textarea readOnly value={candidate.providerValue} rows={4} />
              </label>
            ) : null}
            <label className="field">
              <span>当前采用内容</span>
              <textarea
                readOnly
                value={candidate.effectiveValue ?? "尚未采用"}
                rows={3}
              />
            </label>
            {candidate.source === undefined ? (
              <p>尚无经过确认的创作来源。</p>
            ) : (
              <p>
                来源：{candidate.source.field} · {candidate.source.quote}
              </p>
            )}
            {candidate.status === "pending" ? (
              <div className="authority-review-actions">
                <button
                  className="button button--secondary"
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    onDecide({
                      candidateId: candidate.candidateId,
                      candidateSha256: candidate.candidateSha256,
                      decision: "accept",
                    })
                  }
                >
                  确认此内容与强度
                </button>
                <button
                  className="button button--ghost"
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    onDecide({
                      candidateId: candidate.candidateId,
                      candidateSha256: candidate.candidateSha256,
                      decision: "reject",
                    })
                  }
                >
                  不采用此候选
                </button>
              </div>
            ) : null}
          </details>
        ))
      )}
    </section>
  );
}
