import {
  ArrowRight,
  CalendarDays,
  Clock3,
  MessageCircle,
  RefreshCw,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { DateTime } from "luxon";
import { api, unwrapCharacter, unwrapList } from "../api/client";
import type {
  CharacterSummary,
  ScheduleItem,
  TimelineEvent,
} from "../api/types";
import { EmptyState, ErrorBlock, LoadingBlock } from "../components/Feedback";
import { PageHeader } from "../components/PageHeader";
import { TierLabel } from "../components/TierLabel";
import {
  readActiveCharacter,
  rememberActiveCharacter,
} from "../lib/activeCharacter";
import { formatLocalDateTime, nowWindow } from "../lib/date";
import {
  buildTimelineLineage,
  type TimelineLineageInput,
} from "../lib/timelineLineage";

const SOURCE_LABELS: Record<string, string> = {
  routine: "\u65e5\u5e38",
  initial_plan: "\u521d\u59cb\u8ba1\u5212",
  user_invitation: "\u7528\u6237\u9080\u8bf7",
  runtime_replan: "\u8fd0\u884c\u8c03\u6574",
  self_initiated: "\u81ea\u4e3b\u53d1\u8d77",
  manual: "\u624b\u52a8",
};

function SourceBadge({ source }: { source: string | undefined }) {
  if (!source) return null;
  return (
    <span className="timeline-source-badge" title={"source: " + source}>
      {SOURCE_LABELS[source] ?? source}
    </span>
  );
}

function LineageDetails({ value }: { value: TimelineLineageInput }) {
  const nodes = buildTimelineLineage(value);
  if (nodes.length < 2) return null;
  return (
    <details className="timeline-lineage">
      <summary>{nodes.map((node) => node.label).join(" → ")}</summary>
      {nodes.map((node, index) => (
        <span key={node.field}>
          {index > 0 ? <span aria-hidden="true">{" → "}</span> : null}
          <code>{node.id}</code>
        </span>
      ))}
    </details>
  );
}

export default function TimelinePage() {
  const params = useParams<{ characterId: string }>();
  const charactersQuery = useQuery({
    queryKey: ["characters"],
    queryFn: api.characters.list,
  });
  const characters = charactersQuery.data
    ? unwrapList<CharacterSummary>(charactersQuery.data, "characters").filter(
        (item) => item.status === "published",
      )
    : [];
  const initialId =
    params.characterId ?? readActiveCharacter() ?? characters[0]?.id;
  const [selectedId, setSelectedId] = useState<string | undefined>(initialId);
  const agentId = params.characterId ?? selectedId ?? characters[0]?.id;
  const characterQuery = useQuery({
    queryKey: ["character", agentId],
    queryFn: () => api.characters.get(agentId!),
    enabled: Boolean(agentId),
  });
  const character = characterQuery.data
    ? unwrapCharacter(characterQuery.data)
    : undefined;
  const activationQuery = useQuery({
    queryKey: ["agent-activation", agentId],
    queryFn: () => api.agents.activate(agentId!),
    enabled: Boolean(agentId),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const stateQuery = useQuery({
    queryKey: ["agent", agentId, "state"],
    queryFn: () => api.agents.state(agentId!),
    enabled: Boolean(agentId),
  });
  const simulationNowUtc =
    stateQuery.data?.asOfUtc ??
    activationQuery.data?.serverTimeUtc ??
    activationQuery.data?.state.asOfUtc;
  const window = useMemo(
    () => nowWindow(72, simulationNowUtc, 12),
    [simulationNowUtc],
  );
  const scheduleEnabled = Boolean(
    agentId && simulationNowUtc && character?.tier !== "lightweight",
  );
  const scheduleQuery = useQuery({
    queryKey: [
      "agent",
      agentId,
      "schedule",
      "72h",
      window.fromUtc,
      window.toUtc,
    ],
    queryFn: () => api.agents.schedule(agentId!, window.fromUtc, window.toUtc),
    enabled: scheduleEnabled,
  });
  const eventsQuery = useQuery({
    queryKey: ["agent", agentId, "timeline"],
    queryFn: () => api.agents.timeline(agentId!),
    enabled: Boolean(agentId),
  });
  const schedule = scheduleQuery.data
    ? unwrapList<ScheduleItem>(scheduleQuery.data, "items")
    : [];
  const events = eventsQuery.data
    ? unwrapList<TimelineEvent>(eventsQuery.data, "events")
    : [];
  const timezone = character?.identity.timezone ?? "Asia/Shanghai";
  const days = groupScheduleByDay(schedule, timezone);

  if (charactersQuery.isPending)
    return <LoadingBlock label="正在读取角色时间线…" />;
  if (charactersQuery.isError)
    return (
      <div className="page">
        <ErrorBlock error={charactersQuery.error} />
      </div>
    );

  if (characters.length === 0) {
    return (
      <div className="page">
        <PageHeader
          title="时间线"
          description="查看计划、结算事件和角色状态如何随时间推进。"
        />
        <EmptyState
          title="还没有可推进的角色"
          description="发布一个日常或拟真模拟角色后，这里会展示未来 72 小时与已结算经历。"
          action={
            <Link className="button button--primary" to="/create">
              创建角色 <ArrowRight size={16} />
            </Link>
          }
        />
      </div>
    );
  }

  return (
    <div className="page page--timeline">
      <PageHeader
        title="时间线"
        description="确定性时间推进负责事实；模型只丰富值得记住的活动结果。"
        actions={
          <div className="button-row">
            <label className="compact-select">
              <span className="sr-only">选择角色</span>
              <select
                value={agentId}
                onChange={(event) => {
                  setSelectedId(event.target.value);
                  rememberActiveCharacter(event.target.value);
                }}
              >
                {characters.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            {character ? <TierLabel tier={character.tier} /> : null}
            <Link
              className="button button--ghost"
              to={`/characters/${agentId}/chat`}
            >
              <MessageCircle size={16} /> 返回聊天
            </Link>
          </div>
        }
      />

      {(scheduleEnabled && scheduleQuery.isPending) ||
      characterQuery.isPending ||
      activationQuery.isPending ? (
        <LoadingBlock label="正在排列未来 72 小时…" />
      ) : null}
      {activationQuery.isError ? (
        <ErrorBlock error={activationQuery.error} />
      ) : null}
      {scheduleQuery.isError ? (
        <ErrorBlock error={scheduleQuery.error} />
      ) : null}

      <div className="timeline-layout">
        <section className="timeline-days" aria-label="未来 72 小时日程">
          {days.map(([day, items], dayIndex) => (
            <div className="timeline-day" key={day}>
              <div className="timeline-day__label">
                <span>
                  {dayIndex === 0
                    ? "今天"
                    : dayIndex === 1
                      ? "明天"
                      : DateTime.fromISO(day).toFormat("ccc")}
                </span>
                <strong>
                  {DateTime.fromISO(day)
                    .setLocale("zh-CN")
                    .toFormat("MM 月 dd 日")}
                </strong>
              </div>
              <div className="timeline-day__track">
                {items.map((item) => (
                  <article
                    className={`timeline-block timeline-block--${item.status}`}
                    key={item.id}
                  >
                    <span className="timeline-block__node" />
                    <time>
                      {DateTime.fromISO(item.startAtUtc, { zone: "utc" })
                        .setZone(timezone)
                        .toFormat("HH:mm")}
                    </time>
                    <div>
                      <div className="timeline-block__title-row">
                        <strong>{item.title}</strong>
                        <SourceBadge source={item.source} />
                      </div>
                      <p>{item.description}</p>
                      <LineageDetails
                        value={{
                          scheduleItemId: item.id,
                          ...(item.sourceIntentId
                            ? { sourceIntentId: item.sourceIntentId }
                            : {}),
                        }}
                      />
                    </div>
                    <span className="timeline-block__meta">
                      {item.rigidity} · {item.status}
                    </span>
                  </article>
                ))}
              </div>
            </div>
          ))}
          {!scheduleQuery.isPending && days.length === 0 ? (
            <EmptyState
              title="这段时间没有计划"
              description="角色发布后，计划器会滚动补齐未来 72 小时。"
            />
          ) : null}
        </section>

        <aside className="event-ledger">
          <div className="event-ledger__heading">
            <div>
              <h2>活动账本</h2>
              <p>最近结算与日程变更</p>
            </div>
            <RefreshCw size={17} />
          </div>
          {eventsQuery.isPending ? <LoadingBlock label="读取事件…" /> : null}
          {eventsQuery.isError ? (
            <ErrorBlock error={eventsQuery.error} />
          ) : null}
          <ol>
            {events.slice(0, 12).map((event) => (
              <li key={event.id}>
                <span className="event-ledger__node">
                  <CalendarDays size={13} />
                </span>
                <div>
                  <div className="timeline-block__title-row">
                    <strong>{event.title}</strong>
                    <SourceBadge source={event.source} />
                  </div>
                  <p>{event.summary}</p>
                  <time>
                    {formatLocalDateTime(event.occurredAtUtc, timezone)}
                  </time>
                  <LineageDetails value={event} />
                  {event.correlationId || event.causationId ? (
                    <details className="timeline-lineage">
                      <summary>{"Correlation / causation"}</summary>
                      <code>{event.correlationId ?? "-"}</code>
                      <span>{" / "}</span>
                      <code>{event.causationId ?? "-"}</code>
                    </details>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
          {!eventsQuery.isPending && events.length === 0 ? (
            <p className="event-ledger__empty">
              <Clock3 size={16} /> 尚未产生已结算事件。
            </p>
          ) : null}
        </aside>
      </div>
    </div>
  );
}

function groupScheduleByDay(
  items: ScheduleItem[],
  timezone: string,
): Array<[string, ScheduleItem[]]> {
  const groups = new Map<string, ScheduleItem[]>();
  for (const item of items) {
    const day = DateTime.fromISO(item.startAtUtc, { zone: "utc" })
      .setZone(timezone)
      .toISODate();
    if (!day) continue;
    const group = groups.get(day) ?? [];
    group.push(item);
    groups.set(day, group);
  }
  return [...groups.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  );
}
