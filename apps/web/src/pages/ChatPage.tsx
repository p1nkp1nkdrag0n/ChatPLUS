import {
  BookOpen,
  ChevronLeft,
  ChevronRight,
  Clock3,
  MessageCircleMore,
  Send,
  Sparkles,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { DateTime } from "luxon";
import { api, unwrapCharacter, unwrapList } from "../api/client";
import type { ChatMessage, ChatSession, RuntimeState } from "../api/types";
import { ErrorBlock, LoadingBlock } from "../components/Feedback";
import { LifeContextOverview } from "../components/LifeContextOverview";
import { StatusMeter } from "../components/StatusMeter";
import { TierLabel } from "../components/TierLabel";
import {
  agentOverviewQueryKey,
  primeAgentOverview,
} from "../hooks/agentEventQueryKeys";
import { rememberActiveCharacter } from "../lib/activeCharacter";
import { formatLocalTime } from "../lib/date";
import {
  resolveMessageDelivery,
  sequentialAnimationSignature,
  sequentialChunkDelay,
  shouldAnimateLiveMessage,
} from "../lib/messageDelivery";

export default function ChatPage() {
  const { characterId } = useParams<{ characterId: string }>();
  const queryClient = useQueryClient();
  const [text, setText] = useState("");
  const [railOpen, setRailOpen] = useState(
    () => !window.matchMedia("(max-width: 720px)").matches,
  );
  const listRef = useRef<HTMLDivElement>(null);
  const newlyArrivedSequentialIdsRef = useRef(new Set<string>());
  const animatedSequentialIdsRef = useRef(new Set<string>());
  const knownMessageIdsAtSendStartRef = useRef<Set<string> | null>(null);
  const characterQuery = useQuery({
    queryKey: ["character", characterId],
    queryFn: () => api.characters.get(characterId!),
    enabled: Boolean(characterId),
  });
  const character = characterQuery.data
    ? unwrapCharacter(characterQuery.data)
    : undefined;

  const activationQuery = useQuery({
    queryKey: ["agent-activation", characterId],
    queryFn: async () => {
      const snapshot = await api.agents.activate(characterId!);
      primeAgentOverview(queryClient, characterId!, snapshot);
      return snapshot;
    },
    enabled: Boolean(characterId),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const sessionQuery = useQuery({
    queryKey: ["agent", characterId, "session"],
    queryFn: async () => {
      const result = await api.agents.sessions(characterId!);
      const sessions = unwrapList<ChatSession>(result, "sessions");
      return sessions[0] ?? api.agents.createSession(characterId!);
    },
    enabled: Boolean(characterId),
  });
  const session = sessionQuery.data;
  const messagesQuery = useQuery({
    queryKey: ["messages", characterId, session?.id],
    queryFn: () => api.sessions.messages(session!.id),
    enabled: Boolean(session?.id),
    refetchInterval: false,
  });
  const messages = messagesQuery.data
    ? unwrapList<ChatMessage>(messagesQuery.data, "messages")
    : [];

  const overviewQuery = useQuery({
    queryKey: agentOverviewQueryKey(characterId!),
    queryFn: () => api.agents.overview(characterId!),
    enabled: Boolean(characterId && activationQuery.data),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const state = overviewQuery.data?.state ?? activationQuery.data?.state;
  const lifeContext =
    overviewQuery.data?.lifeContext ?? activationQuery.data?.lifeContext;

  const sendMutation = useMutation({
    mutationFn: (message: string) =>
      api.sessions.send(session!.id, {
        agentId: characterId!,
        clientMessageId: crypto.randomUUID(),
        text: message,
      }),
    onMutate: () => {
      knownMessageIdsAtSendStartRef.current = new Set(
        messages.map((message) => message.id),
      );
    },
    onSuccess: (result) => {
      setText("");
      const assistantDelivery = resolveMessageDelivery(result.assistantMessage);
      if (
        assistantDelivery.mode === "sequential" &&
        !animatedSequentialIdsRef.current.has(result.assistantMessage.id)
      ) {
        newlyArrivedSequentialIdsRef.current.add(result.assistantMessage.id);
      }
      queryClient.setQueryData<{ messages: ChatMessage[] }>(
        ["messages", characterId, session?.id],
        (current) => ({
          messages: appendUniqueMessages(current?.messages ?? [], [
            result.userMessage,
            result.assistantMessage,
          ]),
        }),
      );
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: ["messages", characterId] }),
        queryClient.invalidateQueries({
          queryKey: agentOverviewQueryKey(characterId!),
        }),
      ]);
    },
    onSettled: () => {
      knownMessageIdsAtSendStartRef.current = null;
    },
  });

  useEffect(() => {
    if (characterId) rememberActiveCharacter(characterId);
  }, [characterId]);

  useEffect(() => {
    newlyArrivedSequentialIdsRef.current.clear();
    animatedSequentialIdsRef.current.clear();
    knownMessageIdsAtSendStartRef.current = null;
  }, [session?.id]);

  const scrollToLatest = useCallback(() => {
    listRef.current?.scrollTo({
      top: listRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, []);

  useEffect(() => {
    scrollToLatest();
  }, [messages.length, scrollToLatest, sendMutation.isPending]);

  const finishSequentialDelivery = useCallback((messageId: string) => {
    newlyArrivedSequentialIdsRef.current.delete(messageId);
  }, []);

  const startSequentialDelivery = useCallback((messageId: string) => {
    animatedSequentialIdsRef.current.add(messageId);
  }, []);

  if (
    characterQuery.isPending ||
    activationQuery.isPending ||
    sessionQuery.isPending ||
    messagesQuery.isPending
  ) {
    return <LoadingBlock label="正在同步角色状态与对话…" />;
  }
  if (characterQuery.isError)
    return (
      <div className="page">
        <ErrorBlock error={characterQuery.error} />
      </div>
    );
  if (activationQuery.isError)
    return (
      <div className="page">
        <ErrorBlock error={activationQuery.error} />
      </div>
    );
  if (sessionQuery.isError)
    return (
      <div className="page">
        <ErrorBlock error={sessionQuery.error} />
      </div>
    );
  if (messagesQuery.isError)
    return (
      <div className="page">
        <ErrorBlock error={messagesQuery.error} />
      </div>
    );
  if (!character || !session) return null;

  const timezone = character.identity.timezone;
  const showRail = character.tier !== "lightweight";
  const submit = () => {
    const message = text.trim();
    if (!message || sendMutation.isPending) return;
    sendMutation.mutate(message);
  };

  return (
    <div className={`chat-page${railOpen && showRail ? " has-rail" : ""}`}>
      <header className="chat-header">
        <div className="chat-header__identity">
          <Link
            className="icon-button"
            to="/characters"
            aria-label="返回角色库"
          >
            <ChevronLeft size={19} />
          </Link>
          <div>
            <h1>{character.identity.name}</h1>
            <span>{character.identity.workOrRole}</span>
          </div>
          <TierLabel tier={character.tier} />
        </div>
        <div className="chat-header__context">
          <Clock3 size={16} aria-hidden="true" />
          <CharacterClock timezone={timezone} referenceUtc={state?.asOfUtc} />
          <span className="header-divider" />
          <span className="status-dot" /> 本地模式
          {showRail ? (
            <button
              className="icon-button"
              type="button"
              onClick={() => setRailOpen((open) => !open)}
              aria-label={railOpen ? "收起状态栏" : "展开状态栏"}
            >
              {railOpen ? (
                <ChevronRight size={18} />
              ) : (
                <ChevronLeft size={18} />
              )}
            </button>
          ) : null}
        </div>
      </header>

      <section
        className="chat-conversation"
        aria-label={`与 ${character.identity.name} 的对话`}
      >
        <div className="message-list" ref={listRef}>
          {messages.length === 0 ? (
            <div className="conversation-opening">
              <span className="thread-node" />
              <h2>从此刻开始</h2>
              <p>
                {character.identity.name}{" "}
                会按照已发布的人格回应。经历、关系和记忆只会在校验后更新。
              </p>
            </div>
          ) : null}
          {messages.map((message) => (
            <MessageBubble
              key={message.id}
              message={message}
              name={character.identity.name}
              timezone={timezone}
              animateSequential={shouldAnimateLiveMessage(message, {
                sendPending: sendMutation.isPending,
                knownMessageIdsAtSendStart:
                  knownMessageIdsAtSendStartRef.current,
                explicitlyAnimatedIds: newlyArrivedSequentialIdsRef.current,
                alreadyAnimatedIds: animatedSequentialIdsRef.current,
              })}
              onReveal={scrollToLatest}
              onDeliveryStart={startSequentialDelivery}
              onDeliveryComplete={finishSequentialDelivery}
            />
          ))}
          {sendMutation.isPending ? (
            <div className="message-group message-group--assistant is-thinking">
              <div className="message-meta">
                <strong>{character.identity.name}</strong>
                <span>正在权衡…</span>
              </div>
              <div className="thinking-dots">
                <span />
                <span />
                <span />
              </div>
            </div>
          ) : null}
        </div>

        <div className="composer-wrap">
          {sendMutation.isError ? (
            <ErrorBlock error={sendMutation.error} />
          ) : null}
          <div className="composer">
            <textarea
              value={text}
              rows={1}
              placeholder={`给${character.identity.name}发消息…`}
              aria-label="消息内容"
              data-testid="chat-input"
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  submit();
                }
              }}
            />
            <div className="composer__footer">
              <button className="context-button" type="button">
                <BookOpen size={15} /> 上下文
              </button>
              <span>Enter 发送 · Shift+Enter 换行</span>
              <button
                className="send-button"
                type="button"
                onClick={submit}
                disabled={!text.trim() || sendMutation.isPending}
                aria-label="发送消息"
              >
                <Send size={18} />
              </button>
            </div>
          </div>
        </div>
      </section>

      {railOpen && showRail ? (
        <aside className="chat-rail">
          {state ? <StateOverview state={state} /> : null}
          {lifeContext ? (
            <LifeContextOverview
              value={lifeContext}
              timelineHref={`/characters/${character.id}/timeline`}
            />
          ) : null}
        </aside>
      ) : null}
    </div>
  );
}

function CharacterClock({
  timezone,
  referenceUtc,
}: {
  timezone: string;
  referenceUtc?: string | undefined;
}) {
  const anchor = useRef({
    simulated: referenceUtc ? DateTime.fromISO(referenceUtc) : DateTime.utc(),
    observed: DateTime.utc(),
  });
  const [now, setNow] = useState(() => anchor.current.simulated);

  useEffect(() => {
    anchor.current = {
      simulated: referenceUtc ? DateTime.fromISO(referenceUtc) : DateTime.utc(),
      observed: DateTime.utc(),
    };
    setNow(anchor.current.simulated);
  }, [referenceUtc]);

  useEffect(() => {
    const id = window.setInterval(() => {
      const elapsed = DateTime.utc().diff(anchor.current.observed).toMillis();
      setNow(anchor.current.simulated.plus({ milliseconds: elapsed }));
    }, 30_000);
    return () => window.clearInterval(id);
  }, []);
  return (
    <time dateTime={now.toISO() ?? undefined}>
      {now.setZone(timezone).toFormat("HH:mm")}
    </time>
  );
}

export function MessageBubble({
  message,
  name,
  timezone,
  animateSequential,
  onReveal,
  onDeliveryStart,
  onDeliveryComplete,
}: {
  message: ChatMessage;
  name: string;
  timezone: string;
  animateSequential: boolean;
  onReveal: () => void;
  onDeliveryStart: (messageId: string) => void;
  onDeliveryComplete: (messageId: string) => void;
}) {
  const proactive =
    message.kind === "proactive" || Boolean(message.triggerEventId);
  const delivery = resolveMessageDelivery(message);
  const chunks = delivery.chunks;
  const chunkCount = chunks.length;
  const chunkSignature = sequentialAnimationSignature(chunks);
  const animateOnMountRef = useRef(animateSequential);
  const shouldSequence =
    animateOnMountRef.current &&
    delivery.mode === "sequential" &&
    chunkCount > 1;
  const [visibleChunkCount, setVisibleChunkCount] = useState(() =>
    shouldSequence ? 1 : chunkCount,
  );

  useLayoutEffect(() => {
    if (shouldSequence) onDeliveryStart(message.id);
  }, [message.id, onDeliveryStart, shouldSequence]);

  useEffect(() => {
    if (!shouldSequence) {
      setVisibleChunkCount(chunkCount);
      return;
    }

    setVisibleChunkCount(1);
    const revealChunks = JSON.parse(chunkSignature) as string[];
    let revealedCount = 1;
    let timerId: number | undefined;
    const scheduleNextChunk = () => {
      const previousChunk = revealChunks[revealedCount - 1] ?? "";
      timerId = window.setTimeout(() => {
        revealedCount += 1;
        setVisibleChunkCount(revealedCount);
        if (revealedCount < chunkCount) {
          scheduleNextChunk();
        } else {
          onDeliveryComplete(message.id);
        }
      }, sequentialChunkDelay(previousChunk));
    };
    scheduleNextChunk();

    return () => {
      if (timerId !== undefined) window.clearTimeout(timerId);
    };
  }, [
    chunkCount,
    chunkSignature,
    message.id,
    onDeliveryComplete,
    shouldSequence,
  ]);

  useEffect(() => {
    if (shouldSequence) onReveal();
  }, [onReveal, shouldSequence, visibleChunkCount]);

  return (
    <div
      className={`message-group message-group--${message.role}`}
      aria-live={shouldSequence ? "polite" : undefined}
    >
      {proactive ? (
        <div className="proactive-origin">
          <span />
          <Sparkles size={13} /> 主动消息 · 来自近期经历
          <span />
        </div>
      ) : null}
      <div className="message-meta">
        {message.role === "assistant" ? <strong>{name}</strong> : null}
        <time>{formatLocalTime(message.createdAtUtc, timezone)}</time>
      </div>
      {chunks.slice(0, visibleChunkCount).map((chunk, index) => (
        <div className="message-bubble" key={`${message.id}:${index}`}>
          {chunk}
        </div>
      ))}
      {shouldSequence && visibleChunkCount < chunkCount ? (
        <div className="sequential-typing" aria-label="正在输入下一条消息">
          <span />
          <span />
          <span />
        </div>
      ) : null}
      {message.role === "assistant" && message.memoryRecall ? (
        <MemoryContextSummary value={message.memoryRecall} />
      ) : null}
      {proactive ? (
        <button className="message-origin-link" type="button">
          <MessageCircleMore size={14} /> 查看触发经历
        </button>
      ) : null}
    </div>
  );
}

function MemoryContextSummary({
  value,
}: {
  value: NonNullable<ChatMessage["memoryRecall"]>;
}) {
  const evidenceCount = value.selectedEvidenceIds.length;
  const usedForReply = value.promptStrategy === "evidence_selected";
  return (
    <details className="message-memory-context">
      <summary>
        <BookOpen size={13} aria-hidden="true" />
        {value.abstained
          ? "本轮没有引用记忆"
          : `本轮记忆依据 · ${evidenceCount} 条证据`}
      </summary>
      <p>
        {value.abstained
          ? "没有找到同时满足相关性和证据要求的记忆，因此回复没有补入未经验证的旧信息。"
          : `${usedForReply ? "已用于回复" : "仅作对照评估"}：${memoryRecallModeLabel(value.recallMode)}，相关度 ${Math.round(value.score * 100)}%。系统只选择有来源且与当前话题最相关的记忆。`}
      </p>
    </details>
  );
}

function memoryRecallModeLabel(value: string): string {
  return (
    {
      event_card: "可追溯经历",
      verbatim_quote: "对话原文",
      date_digest: "日期摘要",
      basic_memory: "基础记忆",
      none: "无可用来源",
    }[value] ?? "已验证记忆"
  );
}

function appendUniqueMessages(
  current: ChatMessage[],
  incoming: ChatMessage[],
): ChatMessage[] {
  const existingIds = new Set(current.map((message) => message.id));
  const next = [...current];
  for (const message of incoming) {
    if (!existingIds.has(message.id)) {
      existingIds.add(message.id);
      next.push(message);
    }
  }
  return next;
}

function StateOverview({ state }: { state: RuntimeState }) {
  return (
    <section className="rail-section">
      <div className="rail-heading">
        <h2>状态概览</h2>
        <span>rev {state.revision}</span>
      </div>
      <div className="state-meters">
        <StatusMeter label="精力" value={state.energy} tone="green" />
        <StatusMeter
          label="心情"
          value={(state.moodValence + 1) / 2}
          tone="green"
        />
        <StatusMeter label="专注" value={state.focus} tone="blue" />
        <StatusMeter label="社交" value={state.socialBattery} tone="orange" />
        <StatusMeter label="唤醒" value={state.moodArousal} tone="sky" />
        <StatusMeter label="压力" value={state.stress} tone="sky" />
      </div>
    </section>
  );
}
