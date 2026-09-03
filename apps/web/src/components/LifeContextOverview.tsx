import { Link } from "react-router-dom";
import type { FuzzyLifeContext } from "../api/types";

export function LifeContextOverview({
  value,
  timelineHref,
}: {
  value: FuzzyLifeContext;
  timelineHref: string;
}) {
  const activeDilemma = value.unresolvedDilemmas[0];
  const activePressure = value.activePressure[0];
  const recentChain = value.canonicalCausalFacts[0];
  const standaloneReflection = value.reflections[0];
  const hasDecisionChain = Boolean(
    recentChain &&
    (recentChain.actions.length > 0 ||
      recentChain.outcomes.length > 0 ||
      recentChain.reflections.length > 0),
  );

  return (
    <section className="rail-section life-context" aria-label="生活脉络">
      <div className="rail-heading">
        <h2>生活脉络</h2>
        <Link to={timelineHref}>查看全部变化</Link>
      </div>

      <div className="life-context__today">
        <span>
          {lifePeriodLabel(value.today.currentPeriod)} · {value.today.localDate}{" "}
          · {availabilityLabel(value.today.availability)}
        </span>
        <strong>{value.today.currentFocus || "正在整理今天的节奏"}</strong>
        {value.today.intentions.length > 0 ? (
          <ul className="life-context__intentions" aria-label="今日意向">
            {value.today.intentions.slice(0, 3).map((intention, index) => (
              <li key={`${intention.title}-${index}`}>
                <span>{lifePeriodLabel(intention.period)}</span>
                {intention.title}
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      {value.ongoingThreads.length > 0 ? (
        <div className="life-context__group">
          <h3>正在推进</h3>
          {value.ongoingThreads.slice(0, 3).map((thread, index) => (
            <article key={`${thread.title}-${index}`}>
              <div>
                <strong>{thread.title}</strong>
                <span>{thread.currentStage}</span>
              </div>
              {thread.progressNote ? <p>{thread.progressNote}</p> : null}
              {thread.nextStepHint ? (
                <small>{thread.nextStepHint}</small>
              ) : null}
            </article>
          ))}
        </div>
      ) : null}

      {activeDilemma || activePressure ? (
        <div className="life-context__group life-context__signal">
          <h3>正在权衡</h3>
          {activeDilemma ? (
            <article>
              <div>
                <strong>{activeDilemma.title}</strong>
                <span>{subjectLabel(activeDilemma.subject)}</span>
              </div>
              <p>{activeDilemma.summary}</p>
              {activeDilemma.options.length > 0 ? (
                <small>{activeDilemma.options.join(" · ")}</small>
              ) : null}
            </article>
          ) : null}
          {activePressure ? (
            <article>
              <div>
                <strong>{activePressure.triggerSummary}</strong>
                <span>{pressureLabel(activePressure.pressureKind)}</span>
              </div>
              <div className="life-context__pressure">
                <span>
                  压力 {Math.round(activePressure.currentPressure * 100)}%
                </span>
                <span>
                  清晰度 {Math.round(activePressure.currentClarity * 100)}%
                </span>
                <span>
                  被理解{" "}
                  {Math.round(activePressure.currentFeltUnderstood * 100)}%
                </span>
              </div>
            </article>
          ) : null}
        </div>
      ) : null}

      {recentChain ? (
        <details className="life-context__chain" open={hasDecisionChain}>
          <summary>最近一次选择如何发展</summary>
          <ol>
            <li>
              <span>决定</span>
              <p>{recentChain.decision.selectionSummary}</p>
            </li>
            {recentChain.actions.slice(0, 2).map((action) => (
              <li key={action.actionId}>
                <span>行动</span>
                <p>{action.summary}</p>
              </li>
            ))}
            {recentChain.outcomes.slice(0, 2).map((outcome) => (
              <li key={outcome.outcomeId}>
                <span>结果</span>
                <p>{outcome.summary}</p>
              </li>
            ))}
            {recentChain.reflections.slice(0, 2).map((reflection) => (
              <li key={reflection.reflectionId}>
                <span>反思</span>
                <p>{reflection.summary}</p>
              </li>
            ))}
          </ol>
        </details>
      ) : standaloneReflection ? (
        <div className="life-context__group">
          <h3>最近的反思</h3>
          <article>
            <p>{standaloneReflection.summary}</p>
          </article>
        </div>
      ) : null}
    </section>
  );
}

function lifePeriodLabel(value: string): string {
  return (
    {
      early_morning: "清晨",
      morning: "上午",
      midday: "中午",
      afternoon: "下午",
      evening: "晚上",
      late_night: "深夜",
      anytime: "今天",
    }[value] ?? value
  );
}

function subjectLabel(value: string): string {
  return value === "user"
    ? "关于你"
    : value === "character"
      ? "角色选择"
      : "共同议题";
}

function availabilityLabel(value: string): string {
  return (
    {
      free: "可自在交流",
      interruptible: "可短暂交流",
      occupied: "正在专注",
    }[value] ?? value
  );
}

function pressureLabel(value: string): string {
  return (
    {
      work: "工作压力",
      decision: "选择压力",
      relationship: "关系压力",
      identity: "身份压力",
      health: "健康压力",
      grief: "失落与哀伤",
      other: "其他压力",
    }[value] ?? value
  );
}
