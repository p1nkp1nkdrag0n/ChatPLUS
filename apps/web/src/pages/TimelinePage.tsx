import {
  ArrowRight,
  Clock3,
  MessageCircle,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { api, unwrapCharacter, unwrapList } from "../api/client";
import type { CharacterSummary, TimelineEvent } from "../api/types";
import { EmptyState, ErrorBlock, LoadingBlock } from "../components/Feedback";
import { PageHeader } from "../components/PageHeader";
import { TierLabel } from "../components/TierLabel";
import {
  readActiveCharacter,
  rememberActiveCharacter,
} from "../lib/activeCharacter";
import { formatLocalDateTime } from "../lib/date";
import {
  buildTimelineLineage,
  type TimelineLineageInput,
} from "../lib/timelineLineage";
import { timelineEventTitle } from "../lib/timelinePresentation";

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
  const eventsQuery = useQuery({
    queryKey: ["agent", agentId, "timeline"],
    queryFn: () => api.agents.timeline(agentId!),
    enabled: Boolean(agentId && activationQuery.data),
  });
  const events = eventsQuery.data
    ? unwrapList<TimelineEvent>(eventsQuery.data, "events")
    : [];
  const timezone = character?.identity.timezone ?? "Asia/Shanghai";

  if (charactersQuery.isPending)
    return <LoadingBlock label="正在读取角色经历…" />;
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
          title="变化记录"
          description="回顾选择、感受、关系与共同经历如何随时间积累。"
        />
        <EmptyState
          title="还没有可以回顾的角色"
          description="发布一个角色并开始交流后，这里会保留可追溯的变化与共同经历。"
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
        title="变化记录"
        description="角色经历、人生选择、关系变化与共同转折都在这里留下可追溯证据。"
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

      {characterQuery.isPending || activationQuery.isPending ? (
        <LoadingBlock label="正在同步最近变化…" />
      ) : null}
      {activationQuery.isError ? (
        <ErrorBlock error={activationQuery.error} />
      ) : null}
      <section className="event-ledger" aria-label="共同经历与变化记录">
        <div className="event-ledger__heading">
          <div>
            <h2>共同经历</h2>
            <p>最近发生的选择、变化与实际结果</p>
          </div>
          <RefreshCw size={17} />
        </div>
        {eventsQuery.isPending ? <LoadingBlock label="读取事件…" /> : null}
        {eventsQuery.isError ? <ErrorBlock error={eventsQuery.error} /> : null}
        <ol>
          {events.slice(0, 12).map((event) => (
            <li key={event.id}>
              <span className="event-ledger__node">
                <Sparkles size={13} />
              </span>
              <div>
                <div className="event-ledger__title-row">
                  <strong>{timelineEventTitle(event)}</strong>
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
            <Clock3 size={16} /> 尚未产生可追溯的共同经历。
          </p>
        ) : null}
      </section>
    </div>
  );
}
