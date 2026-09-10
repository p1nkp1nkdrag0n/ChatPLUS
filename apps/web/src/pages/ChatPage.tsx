import {
  BookOpen,
  Clock3,
  Leaf,
  MessageCircleMore,
  MoreHorizontal,
  Plus,
  Search,
  Send,
  Smile,
  Sparkles,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  useMutation,
  useMutationState,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { DateTime } from "luxon";
import { api, unwrapCharacter, unwrapList } from "../api/client";
import { llmApi, sessionModelKey } from "../api/llm";
import { ChatModelToolbar } from "../components/llm/ChatModelToolbar";
import type {
  CharacterSpec,
  ChatMessage,
  ChatSession,
  RuntimeState,
} from "../api/types";
import { CharacterAvatar } from "../components/CharacterAvatar";
import { ErrorBlock, LoadingBlock } from "../components/Feedback";
import { LifeContextOverview } from "../components/LifeContextOverview";
import { StatusMeter } from "../components/StatusMeter";
import {
  agentOverviewQueryKey,
  primeAgentOverview,
} from "../hooks/agentEventQueryKeys";
import { formatLocalTime } from "../lib/date";
import { shouldSubmitChatKey } from "../lib/chatInput";
import {
  findChatSendReceipt,
  prepareChatSend,
  type ChatDraft,
  type ChatSendInput,
} from "../lib/chatSend";
import {
  chatHref,
  findOwnedSession,
  readLastConversation,
  rememberLastConversation,
  selectLegacySession,
} from "../lib/lastConversation";
import {
  resolveMessageDelivery,
  sequentialAnimationSignature,
  sequentialChunkDelay,
  shouldAnimateLiveMessage,
} from "../lib/messageDelivery";

const EMOJI = [
  "😊",
  "🌿",
  "🌼",
  "☀️",
  "🌙",
  "✨",
  "💚",
  "💌",
  "🥰",
  "😂",
  "🥹",
  "🤗",
  "☕",
  "🌸",
  "🍃",
  "👋",
];
const EMPTY_SESSIONS: ChatSession[] = [];

export default function ChatPage() {
  const { characterId } = useParams<{ characterId: string }>();
  return characterId ? (
    <CharacterChat key={characterId} characterId={characterId} />
  ) : null;
}

function CharacterChat({ characterId }: { characterId: string }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const requestedSessionId = searchParams.get("sessionId");
  const [search, setSearch] = useState("");
  const [railOpen, setRailOpen] = useState(false);
  const draftsRef = useRef(new Map<string, ChatDraft>());
  const initialCreationRef = useRef(false);
  const mountedRef = useRef(true);
  const characterMenuRef = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  useEffect(() => {
    const closeCharacterMenu = (event: PointerEvent) => {
      const menu = characterMenuRef.current;
      if (menu?.open && !menu.contains(event.target as Node)) menu.open = false;
    };
    document.addEventListener("pointerdown", closeCharacterMenu);
    return () =>
      document.removeEventListener("pointerdown", closeCharacterMenu);
  }, []);

  const charactersQuery = useQuery({
    queryKey: ["characters"],
    queryFn: api.characters.list,
  });
  const characterQuery = useQuery({
    queryKey: ["character", characterId],
    queryFn: () => api.characters.get(characterId),
  });
  const character = characterQuery.data
    ? unwrapCharacter(characterQuery.data)
    : undefined;
  const published = character?.status === "published";
  const activationQuery = useQuery({
    queryKey: ["agent-activation", characterId],
    queryFn: async () => {
      const snapshot = await api.agents.activate(characterId);
      primeAgentOverview(queryClient, characterId, snapshot);
      return snapshot;
    },
    enabled: published,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const sessionsQuery = useQuery({
    queryKey: ["agent", characterId, "sessions"],
    queryFn: async () =>
      unwrapList<ChatSession>(
        await api.agents.sessions(characterId),
        "sessions",
      ),
    enabled: published,
  });
  const sessions = sessionsQuery.data ?? EMPTY_SESSIONS;
  const session =
    requestedSessionId !== null
      ? findOwnedSession(sessions, characterId, requestedSessionId)
      : undefined;
  const createSessionMutation = useMutation({
    mutationFn: () => api.agents.createSession(characterId),
    onSuccess: (created) => {
      queryClient.setQueryData<ChatSession[]>(
        ["agent", characterId, "sessions"],
        (current) => [
          created,
          ...(current ?? []).filter((item) => item.id !== created.id),
        ],
      );
      if (!mountedRef.current) return;
      void navigate(chatHref(characterId, created.id), {
        replace: requestedSessionId === null,
      });
    },
  });
  const { mutate: createSession } = createSessionMutation;

  useEffect(() => {
    if (requestedSessionId !== null || !sessionsQuery.isSuccess) return;
    const restored = selectLegacySession(
      sessions,
      characterId,
      readLastConversation(),
    );
    if (restored) {
      void navigate(chatHref(characterId, restored.id), { replace: true });
    } else if (!initialCreationRef.current) {
      initialCreationRef.current = true;
      createSession();
    }
  }, [
    characterId,
    createSession,
    navigate,
    requestedSessionId,
    sessions,
    sessionsQuery.isSuccess,
  ]);

  const overviewQuery = useQuery({
    queryKey: agentOverviewQueryKey(characterId),
    queryFn: () => api.agents.overview(characterId),
    enabled: Boolean(activationQuery.data),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const state = overviewQuery.data?.state ?? activationQuery.data?.state;
  const lifeContext =
    overviewQuery.data?.lifeContext ?? activationQuery.data?.lifeContext;
  const filteredCharacters = (charactersQuery.data?.characters ?? []).filter(
    (item) =>
      item.status !== "archived" &&
      `${item.name} ${item.workOrRole}`
        .toLocaleLowerCase()
        .includes(search.toLocaleLowerCase().trim()),
  );

  const showSession = (id: string) => {
    void navigate(chatHref(characterId, id));
  };
  const recover = () => {
    const latest = selectLegacySession(sessions, characterId, undefined);
    if (latest) showSession(latest.id);
    else createSession();
  };

  let conversation;
  if (
    characterQuery.isError ||
    sessionsQuery.isError ||
    activationQuery.isError
  ) {
    conversation = (
      <div className="chat-feedback">
        <ErrorBlock
          error={
            characterQuery.error ?? sessionsQuery.error ?? activationQuery.error
          }
        />
      </div>
    );
  } else if (character && !published) {
    conversation = (
      <div className="conversation-opening chat-feedback">
        <h2>这个角色还没有准备好</h2>
        <p>完成角色设定并发布后，就可以开始对话了。</p>
        <Link
          className="button button--primary"
          to={`/characters/${characterId}/edit`}
        >
          继续编辑角色
        </Link>
      </div>
    );
  } else if (
    requestedSessionId !== null &&
    sessionsQuery.isSuccess &&
    !session
  ) {
    conversation = (
      <div className="conversation-opening chat-feedback">
        <h2>这段对话暂时无法打开</h2>
        <p>对话可能已被移除，或属于另一个角色。</p>
        <button
          className="button button--primary"
          type="button"
          onClick={recover}
          disabled={createSessionMutation.isPending}
        >
          打开可用的对话
        </button>
        <Link to="/characters">返回角色库</Link>
      </div>
    );
  } else if (!character || !session || activationQuery.isPending) {
    conversation = createSessionMutation.isError ? (
      <div className="chat-feedback">
        <ErrorBlock error={createSessionMutation.error} />
        <button className="button" onClick={() => createSession()}>
          重新打开对话
        </button>
      </div>
    ) : (
      <LoadingBlock label="正在打开这段对话…" />
    );
  } else {
    conversation = (
      <SessionConversation
        key={session.id}
        character={character}
        session={session}
        drafts={draftsRef.current}
      />
    );
  }

  return (
    <div className="dearvale-chat">
      <aside className="chat-sessions" aria-label="历史对话">
        <Link className="chat-brand" to="/welcome">
          Dearvale
        </Link>
        <div className="chat-sessions__heading">
          <h2>历史对话</h2>
          <p>{character?.identity.name ?? "当前角色"}</p>
        </div>
        <div className="chat-session-list">
          {sessionsQuery.isPending && published ? (
            <p className="chat-list-note">正在翻开历史对话…</p>
          ) : null}
          {sessionsQuery.isError ? (
            <ErrorBlock error={sessionsQuery.error} />
          ) : null}
          {sessions
            .filter((item) => item.agentId === characterId)
            .map((item) => (
              <button
                key={item.id}
                data-session-id={item.id}
                type="button"
                onClick={() => showSession(item.id)}
                className={item.id === session?.id ? "is-current" : ""}
                aria-current={item.id === session?.id ? "page" : undefined}
              >
                <span>
                  {DateTime.fromISO(item.createdAtUtc)
                    .setZone(character?.identity.timezone ?? "local")
                    .toFormat("MM月dd日 HH:mm")}{" "}
                  的对话
                </span>
                {item.id === session?.id ? <small>正在阅读</small> : null}
              </button>
            ))}
          {sessionsQuery.isSuccess && sessions.length === 0 ? (
            <p className="chat-list-note">还没有历史对话。</p>
          ) : null}
        </div>
        <button
          className="chat-new-conversation"
          type="button"
          onClick={() => createSession()}
          disabled={!published || createSessionMutation.isPending}
        >
          <Plus size={20} aria-hidden="true" />
          {createSessionMutation.isPending ? "正在开启…" : "新建对话"}
        </button>
        {requestedSessionId !== null && createSessionMutation.isError ? (
          <ErrorBlock error={createSessionMutation.error} />
        ) : null}
      </aside>
      <div className={`chat-page${railOpen ? " has-rail" : ""}`}>
        <header className="chat-header">
          <div className="chat-header__identity">
            <CharacterAvatar characterId={characterId} size={88} />
            <div>
              <h1>{character?.identity.name ?? "对话"}</h1>
              <span>
                {character?.identity.workOrRole || "缓缓听风，慢慢说故事。"}
              </span>
            </div>
          </div>
          <div className="chat-header__context">
            {published ? (
              <button
                className="chat-context-button"
                type="button"
                onClick={() => setRailOpen((open) => !open)}
                aria-expanded={railOpen}
                aria-controls="character-context"
              >
                <Leaf size={22} />
                角色近况
              </button>
            ) : null}
            <details
              className="chat-character-menu"
              ref={characterMenuRef}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.currentTarget.open = false;
                  event.currentTarget.querySelector("summary")?.focus();
                }
              }}
            >
              <summary
                className="icon-button"
                aria-label="切换角色"
                title="切换角色"
              >
                <MoreHorizontal size={24} />
              </summary>
              <div className="chat-character-menu__popover">
                <h2>切换角色</h2>
                <label className="chat-character-search">
                  <Search size={19} aria-hidden="true" />
                  <input
                    aria-label="搜索角色"
                    placeholder="搜索角色"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                  />
                </label>
                <div className="chat-character-list">
                  {charactersQuery.isPending ? (
                    <p className="chat-list-note">正在寻找熟悉的身影…</p>
                  ) : null}
                  {charactersQuery.isError ? (
                    <ErrorBlock error={charactersQuery.error} />
                  ) : null}
                  {filteredCharacters.map((item) => (
                    <Link
                      key={item.id}
                      className={`chat-character${item.id === characterId ? " is-current" : ""}`}
                      aria-current={
                        item.id === characterId ? "page" : undefined
                      }
                      to={
                        item.status === "published"
                          ? chatHref(item.id)
                          : `/characters/${item.id}/edit`
                      }
                      onClick={() => {
                        if (characterMenuRef.current)
                          characterMenuRef.current.open = false;
                      }}
                    >
                      <CharacterAvatar characterId={item.id} size={48} />
                      <span>
                        {item.name}
                        {item.status === "draft" ? <small>待完成</small> : null}
                      </span>
                    </Link>
                  ))}
                  {charactersQuery.isSuccess &&
                  filteredCharacters.length === 0 ? (
                    <p className="chat-list-note">没有找到这个角色。</p>
                  ) : null}
                </div>
                <Link to={`/characters/${characterId}/edit`}>编辑角色</Link>
              </div>
            </details>
          </div>
        </header>
        {conversation}
        {railOpen ? (
          <aside
            className="chat-rail"
            id="character-context"
            aria-label="角色近况"
          >
            <div className="chat-rail__top">
              <h2>角色近况</h2>
              <button
                className="icon-button"
                type="button"
                aria-label="收起角色近况"
                onClick={() => setRailOpen(false)}
              >
                <X size={18} />
              </button>
            </div>
            <div className="chat-local-time">
              <Clock3 size={15} />
              <CharacterClock
                timezone={character?.identity.timezone ?? "local"}
                referenceUtc={state?.asOfUtc}
              />
            </div>
            {state ? <StateOverview state={state} /> : null}
            {lifeContext ? (
              <LifeContextOverview
                value={lifeContext}
                timelineHref={`/characters/${characterId}/timeline`}
              />
            ) : null}
            {!lifeContext && character?.tier === "lightweight" ? (
              <p className="chat-list-note">
                此角色专注于与你的对话，尚未展开日常生活。
              </p>
            ) : null}
          </aside>
        ) : null}
      </div>
    </div>
  );
}

function SessionConversation({
  character,
  session,
  drafts,
}: {
  character: CharacterSpec;
  session: ChatSession;
  drafts: Map<string, ChatDraft>;
}) {
  const characterId = character.id;
  const queryClient = useQueryClient();
  const [text, setText] = useState(() => drafts.get(session.id)?.text ?? "");
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [modelNotice, setModelNotice] = useState("");
  const modelQuery = useQuery({
    queryKey: sessionModelKey(session.id),
    queryFn: () => llmApi.session(session.id),
  });
  const modelMutation = useMutation({
    mutationFn: (selection: Parameters<typeof llmApi.setSession>[1]) =>
      llmApi.setSession(session.id, selection),
    onSuccess: (value) => {
      queryClient.setQueryData(sessionModelKey(session.id), value);
      const draft = drafts.get(session.id);
      if (draft?.retryInput) drafts.set(session.id, { text: draft.text });
      setModelNotice(value.effective ? "已切换，下一条消息使用该模型。" : "");
    },
  });
  const listRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const emojiRef = useRef<HTMLDivElement>(null);
  const composingRef = useRef(false);
  const submittingRef = useRef(false);
  const mountedRef = useRef(true);
  const newlyArrivedSequentialIdsRef = useRef(new Set<string>());
  const animatedSequentialIdsRef = useRef(new Set<string>());
  const sendStates = useMutationState({
    filters: {
      mutationKey: ["chat-send", characterId, session.id],
      exact: true,
    },
    select: (mutation) => ({
      status: mutation.state.status,
      error: mutation.state.error,
      input: mutation.state.variables as ChatSendInput | undefined,
    }),
  });
  const latestSend = sendStates.at(-1);
  const sendPending = latestSend?.status === "pending";
  const pendingInput = sendPending ? latestSend.input : undefined;
  const knownMessageIdsAtSendStart = pendingInput
    ? new Set(pendingInput.knownMessageIds)
    : null;
  const messagesQuery = useQuery({
    queryKey: ["messages", characterId, session.id],
    queryFn: () => api.sessions.messages(session.id),
    refetchInterval: false,
  });
  const messages = messagesQuery.data
    ? unwrapList<ChatMessage>(messagesQuery.data, "messages").filter(
        (message) =>
          message.sessionId === session.id && message.agentId === characterId,
      )
    : [];
  const sendReceipt = findChatSendReceipt(
    messages,
    latestSend?.input?.clientMessageId,
  );
  const pendingUserMessage: ChatMessage | undefined =
    pendingInput && !sendReceipt.userMessage
      ? {
          id: `pending:${pendingInput.clientMessageId}`,
          clientMessageId: pendingInput.clientMessageId,
          sessionId: session.id,
          agentId: characterId,
          role: "user",
          text: pendingInput.text,
          createdAtUtc: pendingInput.createdAtUtc,
        }
      : undefined;
  const displayMessages = pendingUserMessage
    ? [...messages, pendingUserMessage]
    : messages;
  const awaitingReply = sendPending && !sendReceipt.assistantMessage;
  const updateText = (next: string) => {
    setText(next);
    // An edit starts a new logical message; unchanged retries keep their identity.
    drafts.set(session.id, { text: next });
  };
  const sendMutation = useMutation({
    mutationKey: ["chat-send", characterId, session.id],
    mutationFn: (input: ChatSendInput) =>
      api.sessions.send(session.id, {
        agentId: characterId,
        text: input.text,
        clientMessageId: input.clientMessageId,
        modelSelection: input.modelSelection,
      }),
    onSuccess: (result) => {
      const assistantDelivery = resolveMessageDelivery(result.assistantMessage);
      if (
        assistantDelivery.mode === "sequential" &&
        !animatedSequentialIdsRef.current.has(result.assistantMessage.id)
      ) {
        newlyArrivedSequentialIdsRef.current.add(result.assistantMessage.id);
      }
      queryClient.setQueryData<{ messages: ChatMessage[] }>(
        ["messages", characterId, session.id],
        (current) => ({
          messages: appendUniqueMessages(current?.messages ?? [], [
            result.userMessage,
            result.assistantMessage,
          ]),
        }),
      );
      void Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["messages", characterId, session.id],
        }),
        queryClient.invalidateQueries({
          queryKey: agentOverviewQueryKey(characterId),
        }),
        queryClient.invalidateQueries({
          queryKey: ["agent", characterId, "sessions"],
        }),
      ]);
    },
    onError: async (_error, input) => {
      // The response can be lost after the server commits. Reconcile before
      // restoring the draft so an acknowledged turn is not offered for resend.
      await queryClient.invalidateQueries({
        queryKey: ["messages", characterId, session.id],
      });
      const current = queryClient.getQueryData<{ messages: ChatMessage[] }>([
        "messages",
        characterId,
        session.id,
      ]);
      if (
        !findChatSendReceipt(current?.messages ?? [], input.clientMessageId)
          .assistantMessage
      ) {
        drafts.set(session.id, { text: input.text, retryInput: input });
        if (mountedRef.current) setText(input.text);
      }
    },
    onSettled: () => {
      submittingRef.current = false;
    },
  });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  useEffect(() => {
    rememberLastConversation(characterId, session.id);
  }, [characterId, session.id]);
  useEffect(() => {
    if (sendPending) return;
    let draft = drafts.get(session.id);
    if (
      sendReceipt.assistantMessage &&
      draft?.retryInput?.clientMessageId === latestSend?.input?.clientMessageId
    ) {
      drafts.delete(session.id);
      draft = undefined;
    } else if (
      !draft &&
      latestSend?.status === "error" &&
      latestSend.input &&
      !sendReceipt.assistantMessage
    ) {
      // Mutation state survives leaving this character while a request runs.
      draft = { text: latestSend.input.text, retryInput: latestSend.input };
      drafts.set(session.id, draft);
    }
    setText(draft?.text ?? "");
  }, [
    drafts,
    latestSend?.input,
    latestSend?.status,
    sendPending,
    sendReceipt.assistantMessage,
    session.id,
  ]);
  useEffect(() => {
    if (!emojiOpen) return;
    const close = (event: PointerEvent) => {
      if (!emojiRef.current?.contains(event.target as Node))
        setEmojiOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [emojiOpen]);
  const scrollToLatest = useCallback(() => {
    listRef.current?.scrollTo({
      top: listRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, []);
  useEffect(() => {
    scrollToLatest();
  }, [displayMessages.length, scrollToLatest, awaitingReply]);
  const finishSequentialDelivery = useCallback((messageId: string) => {
    newlyArrivedSequentialIdsRef.current.delete(messageId);
  }, []);
  const startSequentialDelivery = useCallback((messageId: string) => {
    animatedSequentialIdsRef.current.add(messageId);
  }, []);
  const submit = () => {
    const message = text.trim();
    if (
      !message ||
      sendPending ||
      submittingRef.current ||
      queryClient.isMutating({
        mutationKey: ["chat-send", characterId, session.id],
        exact: true,
      }) > 0 ||
      modelMutation.isPending ||
      modelQuery.isError ||
      !modelQuery.data?.effective ||
      messagesQuery.isPending ||
      messagesQuery.isError
    )
      return;
    const input = prepareChatSend(
      drafts.get(session.id),
      message,
      modelQuery.data.effective,
      messages,
    );
    submittingRef.current = true;
    drafts.delete(session.id);
    setText("");
    setEmojiOpen(false);
    sendMutation.mutate(input);
  };
  const insertEmoji = (emoji: string) => {
    const input = textareaRef.current;
    const start = input?.selectionStart ?? text.length;
    const end = input?.selectionEnd ?? start;
    updateText(`${text.slice(0, start)}${emoji}${text.slice(end)}`);
    setEmojiOpen(false);
    requestAnimationFrame(() => {
      input?.focus();
      input?.setSelectionRange(start + emoji.length, start + emoji.length);
    });
  };
  return (
    <section
      className="chat-conversation"
      aria-label={`与 ${character.identity.name} 的对话`}
    >
      <div className="message-list" ref={listRef}>
        {messagesQuery.isPending ? (
          <LoadingBlock label="正在翻开这段对话…" />
        ) : null}
        {messagesQuery.isError ? (
          <ErrorBlock error={messagesQuery.error} />
        ) : null}
        {messagesQuery.isSuccess && displayMessages.length === 0 ? (
          <div className="conversation-opening">
            <CharacterAvatar characterId={characterId} size={88} />
            <h2>从此刻开始</h2>
            <p>和{character.identity.name}聊聊今天，或是刚刚浮上心头的小事。</p>
          </div>
        ) : null}
        {displayMessages.map((message) => (
          <MessageBubble
            key={message.id}
            message={message}
            characterId={characterId}
            name={character.identity.name}
            timezone={character.identity.timezone}
            animateSequential={shouldAnimateLiveMessage(message, {
              sendPending: sendPending,
              knownMessageIdsAtSendStart,
              explicitlyAnimatedIds: newlyArrivedSequentialIdsRef.current,
              alreadyAnimatedIds: animatedSequentialIdsRef.current,
            })}
            onReveal={scrollToLatest}
            onDeliveryStart={startSequentialDelivery}
            onDeliveryComplete={finishSequentialDelivery}
          />
        ))}
        {awaitingReply ? (
          <div
            className="message-group message-group--assistant is-thinking"
            data-testid="chat-typing"
            role="status"
          >
            <CharacterAvatar characterId={characterId} size={64} />
            <div className="message-content">
              <span className="message-meta">对方正在输入中...</span>
              <div className="thinking-dots" aria-label="对方正在输入中...">
                <span />
                <span />
                <span />
              </div>
            </div>
          </div>
        ) : null}
      </div>
      <div className="composer-wrap">
        <ChatModelToolbar
          model={modelQuery.data}
          disabled={
            sendPending || modelMutation.isPending || modelQuery.isPending
          }
          onChange={(selection) => {
            setModelNotice("");
            modelMutation.mutate(selection);
          }}
          notice={modelNotice}
          error={modelMutation.error ?? modelQuery.error}
        />
        {latestSend?.status === "error" && !sendReceipt.assistantMessage ? (
          <ErrorBlock error={latestSend.error} />
        ) : null}
        <div className="composer">
          <textarea
            ref={textareaRef}
            value={text}
            rows={1}
            placeholder="输入一条消息…"
            aria-label="消息内容"
            data-testid="chat-input"
            disabled={sendPending || !messagesQuery.isSuccess}
            onChange={(event) => updateText(event.target.value)}
            onCompositionStart={() => {
              composingRef.current = true;
            }}
            onCompositionEnd={() => {
              composingRef.current = false;
            }}
            onKeyDown={(event) => {
              if (
                shouldSubmitChatKey(event.nativeEvent, composingRef.current)
              ) {
                event.preventDefault();
                submit();
              }
            }}
          />
          <div className="composer__footer">
            <div
              className="emoji-control"
              ref={emojiRef}
              onKeyDown={(event) => {
                if (event.key === "Escape") setEmojiOpen(false);
              }}
            >
              <button
                className="icon-button"
                type="button"
                aria-label="选择表情"
                aria-expanded={emojiOpen}
                aria-controls="chat-emoji-picker"
                onClick={() => setEmojiOpen((open) => !open)}
                disabled={sendPending || !messagesQuery.isSuccess}
              >
                <Smile size={25} />
              </button>
              {emojiOpen ? (
                <div
                  className="emoji-picker"
                  id="chat-emoji-picker"
                  role="group"
                  aria-label="常用表情"
                >
                  {EMOJI.map((emoji) => (
                    <button
                      key={emoji}
                      type="button"
                      aria-label={`插入 ${emoji}`}
                      onClick={() => insertEmoji(emoji)}
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            <button
              className="send-button"
              type="button"
              onClick={submit}
              disabled={
                !text.trim() ||
                sendPending ||
                modelMutation.isPending ||
                modelQuery.isError ||
                !modelQuery.data?.effective ||
                !messagesQuery.isSuccess
              }
              aria-label="发送消息"
            >
              <Send size={23} />
            </button>
          </div>
        </div>
        <span className="composer-key-hint">
          Enter 发送 · Shift + Enter 换行
        </span>
      </div>
    </section>
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
  characterId,
  name,
  timezone,
  animateSequential,
  onReveal,
  onDeliveryStart,
  onDeliveryComplete,
}: {
  message: ChatMessage;
  characterId?: string;
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
      {message.role === "assistant" ? (
        <CharacterAvatar
          characterId={characterId ?? message.agentId}
          name={name}
          size={64}
        />
      ) : null}
      <div className="message-content">
        {proactive ? (
          <div className="proactive-origin">
            <span />
            <Sparkles size={13} /> 主动消息 · 来自近期经历
            <span />
          </div>
        ) : null}
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
        <div className="message-meta">
          <time dateTime={message.createdAtUtc}>
            {formatLocalTime(message.createdAtUtc, timezone)}
          </time>
        </div>
        {message.role === "assistant" && message.memoryRecall ? (
          <MemoryContextSummary value={message.memoryRecall} />
        ) : null}
        {proactive ? (
          <Link
            className="message-origin-link"
            to={`/characters/${encodeURIComponent(message.agentId)}/timeline`}
          >
            <MessageCircleMore size={14} /> 查看触发经历
          </Link>
        ) : null}
      </div>
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
