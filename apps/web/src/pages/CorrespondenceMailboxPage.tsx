import { Archive, ChevronRight, Mail, PenLine, Send } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { KeyboardEvent } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import type { LetterSummaryResponse } from "@personasim/contracts";
import { api, unwrapCharacter, unwrapList } from "../api/client";
import type { CharacterSummary } from "../api/types";
import {
  EnvelopePanel,
  LetterPaper,
  ReplyGenerationStatus,
  TransitProgress,
} from "../components/correspondence/CorrespondencePrimitives";
import { EmptyState, ErrorBlock, LoadingBlock } from "../components/Feedback";
import {
  correspondenceQueryKeys,
  composeAvailability,
  filterMailboxLetters,
  formatCorrespondenceDate,
  isCachedUserLetterDetail,
  mergeCorrespondenceMailboxPages,
  statusLabel,
  transitPresentation,
  type MailboxFilter,
} from "../lib/correspondence";
import { rememberActiveCharacter } from "../lib/activeCharacter";
import { useReplyGenerationRetry } from "../hooks/useReplyGenerationRetry";

const FILTERS: Array<{ value: MailboxFilter; label: string }> = [
  { value: "all", label: "全部" },
  { value: "inbox", label: "收件" },
  { value: "transit", label: "在途" },
  { value: "sent", label: "已寄" },
  { value: "archive", label: "档案" },
];

const MAILBOX_PAGE_SIZE = 50;

export default function CorrespondenceMailboxPage() {
  const { characterId = "" } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [filter, setFilter] = useState<MailboxFilter>("all");
  useEffect(() => {
    if (characterId) rememberActiveCharacter(characterId);
  }, [characterId]);

  const charactersQuery = useQuery({
    queryKey: ["characters"],
    queryFn: api.characters.list,
  });
  const characterQuery = useQuery({
    queryKey: ["character", characterId],
    queryFn: () => api.characters.get(characterId),
    enabled: Boolean(characterId),
  });
  const mailboxQuery = useInfiniteQuery({
    queryKey: correspondenceQueryKeys.mailboxPages(characterId),
    queryFn: ({ pageParam }) =>
      api.correspondence.list(characterId, {
        limit: MAILBOX_PAGE_SIZE,
        ...(pageParam === null ? {} : { cursor: pageParam }),
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    enabled: Boolean(characterId),
  });
  const settingsQuery = useQuery({
    queryKey: ["settings"],
    queryFn: api.settings.get,
  });

  const character = characterQuery.data
    ? unwrapCharacter(characterQuery.data)
    : undefined;
  const characters = charactersQuery.data
    ? unwrapList<CharacterSummary>(charactersQuery.data, "characters")
    : [];
  const mailbox = useMemo(
    () => mergeCorrespondenceMailboxPages(mailboxQuery.data?.pages ?? []),
    [mailboxQuery.data?.pages],
  );
  const letters = useMemo(
    () => filterMailboxLetters(mailbox?.letters ?? [], filter),
    [filter, mailbox?.letters],
  );
  const requestedLetterId = searchParams.get("letterId");
  const selectedLetter =
    letters.find((letter) => letter.id === requestedLetterId) ?? letters[0];
  const compose = composeAvailability(mailbox);
  const openThread = mailbox?.threads.find(
    (thread) => thread.status === "open",
  );
  const replyState = openThread?.replyState;
  const replyRetry = useReplyGenerationRetry(characterId, replyState);
  const modeResolved = !settingsQuery.isPending && !settingsQuery.isError;
  const canCompose = settingsQuery.data?.correspondenceMode === "enforced";

  const detailQuery = useQuery({
    queryKey: correspondenceQueryKeys.letter(selectedLetter?.id ?? ""),
    queryFn: () => api.letters.getCacheSafe(selectedLetter!.id),
    enabled: Boolean(selectedLetter),
  });

  const selectLetter = (letter: LetterSummaryResponse) => {
    const mobile =
      typeof window !== "undefined" &&
      window.matchMedia?.("(max-width: 900px)").matches;
    if (mobile) {
      void navigate(
        `/letters/${letter.id}?agentId=${encodeURIComponent(characterId)}`,
      );
      return;
    }
    setSearchParams({ letterId: letter.id }, { replace: true });
  };

  const pending =
    charactersQuery.isPending ||
    characterQuery.isPending ||
    mailboxQuery.isPending;
  const error =
    charactersQuery.error ?? characterQuery.error ?? mailboxQuery.error;

  return (
    <div className="correspondence-page mailbox-page">
      <header className="correspondence-header">
        <div>
          <h1>书信</h1>
        </div>
        <div className="correspondence-header__actions">
          <label className="correspondence-character-select">
            <span className="sr-only">当前角色</span>
            <select
              value={characterId}
              onChange={(event) =>
                void navigate(
                  `/characters/${event.target.value}/correspondence`,
                )
              }
            >
              {characters.map((item) => (
                <option value={item.id} key={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          {!modeResolved ? null : !canCompose ? (
            <span className="correspondence-readonly-note" role="status">
              书信当前只读
            </span>
          ) : compose.kind === "waiting" ? (
            <button
              className="button button--primary correspondence-compose-link"
              type="button"
              disabled
              title={
                replyState?.kind === "failed"
                  ? "这封回信暂时没有写成"
                  : replyState?.kind === "retry_scheduled"
                    ? "回信已安排重新尝试"
                    : replyState?.kind === "waiting"
                      ? "正在等待回信"
                      : "这一轮往来仍在途中"
              }
            >
              <PenLine size={17} aria-hidden="true" />
              {replyState?.kind === "failed" ? "回信待处理" : "等待回信"}
            </button>
          ) : (
            <Link
              className="button button--primary correspondence-compose-link"
              to={`/characters/${characterId}/correspondence/compose${
                compose.kind === "edit"
                  ? `?draftId=${encodeURIComponent(compose.draftId)}`
                  : ""
              }`}
            >
              <PenLine size={17} aria-hidden="true" /> 写一封信
            </Link>
          )}
        </div>
      </header>

      <div className="mailbox-filters" role="tablist" aria-label="筛选书信">
        {FILTERS.map((item) => (
          <button
            key={item.value}
            type="button"
            role="tab"
            id={`mailbox-filter-${item.value}`}
            aria-controls="mailbox-filter-panel"
            aria-selected={filter === item.value}
            tabIndex={filter === item.value ? 0 : -1}
            className={filter === item.value ? "is-active" : ""}
            onClick={() => setFilter(item.value)}
            onKeyDown={(event) =>
              moveFilterFocus(event, FILTERS.indexOf(item), setFilter)
            }
          >
            {item.label}
          </button>
        ))}
      </div>

      {pending ? <LoadingBlock label="正在整理书信…" /> : null}
      {error ? <ErrorBlock error={error} /> : null}

      {!pending && !error && replyState ? (
        <div className="mailbox-reply-generation">
          <ReplyGenerationStatus
            state={replyState}
            correspondent={character?.identity.name ?? "角色"}
            isPending={replyRetry.isPending}
            {...(replyRetry.safeErrorMessage === undefined
              ? {}
              : { safeErrorMessage: replyRetry.safeErrorMessage })}
            onRetry={replyRetry.retry}
          />
        </div>
      ) : null}

      {!pending && !error && letters.length === 0 ? (
        <div
          id="mailbox-filter-panel"
          role="tabpanel"
          aria-labelledby={`mailbox-filter-${filter}`}
        >
          <EmptyState
            title={
              mailboxQuery.hasNextPage
                ? "已加载的书信里暂时没有这一类"
                : filter === "all"
                  ? "还没有书信"
                  : "这个分类里还没有信"
            }
            description={
              mailboxQuery.hasNextPage
                ? "可以继续加载更早的书信；当前筛选和已选书信会保持不变。"
                : canCompose
                  ? "写下第一封信，封缄后它会沿着自己的时间抵达对方。"
                  : "当前模式只开放已有书信的阅读；切换到 enforced 后才能开始新的往来。"
            }
            action={
              mailboxQuery.hasNextPage ? (
                <button
                  className="button button--secondary"
                  type="button"
                  disabled={mailboxQuery.isFetchingNextPage}
                  onClick={() => void mailboxQuery.fetchNextPage()}
                >
                  {mailboxQuery.isFetchingNextPage
                    ? "正在加载…"
                    : "加载更早书信"}
                </button>
              ) : canCompose ? (
                <Link
                  className="button button--primary"
                  to={`/characters/${characterId}/correspondence/compose`}
                >
                  写一封信
                </Link>
              ) : undefined
            }
          />
        </div>
      ) : null}

      {letters.length > 0 ? (
        <div
          className="mailbox-layout"
          id="mailbox-filter-panel"
          role="tabpanel"
          aria-labelledby={`mailbox-filter-${filter}`}
        >
          <section className="letter-list" aria-label="书信列表">
            {letters.map((letter) => (
              <LetterListRow
                key={letter.id}
                letter={letter}
                correspondent={character?.identity.name ?? "角色"}
                serverTimeUtc={
                  mailbox?.serverTimeUtc ?? new Date().toISOString()
                }
                selected={selectedLetter?.id === letter.id}
                timezone={character?.identity.timezone ?? "UTC"}
                onSelect={() => selectLetter(letter)}
              />
            ))}
            {mailboxQuery.hasNextPage ? (
              <div className="letter-list__pagination">
                <button
                  className="button button--secondary"
                  type="button"
                  disabled={mailboxQuery.isFetchingNextPage}
                  onClick={() => void mailboxQuery.fetchNextPage()}
                >
                  {mailboxQuery.isFetchingNextPage
                    ? "正在加载…"
                    : "加载更早书信"}
                </button>
              </div>
            ) : null}
          </section>

          <section className="mailbox-detail" aria-live="polite">
            {detailQuery.isPending ? <LoadingBlock label="正在取信…" /> : null}
            {detailQuery.isError ? (
              <ErrorBlock error={detailQuery.error} />
            ) : null}
            {detailQuery.data && selectedLetter ? (
              <MailboxLetterDetail
                detail={detailQuery.data}
                letter={selectedLetter}
                correspondent={character?.identity.name ?? "角色"}
                serverTimeUtc={
                  mailbox?.serverTimeUtc ?? new Date().toISOString()
                }
                agentId={characterId}
                timezone={character?.identity.timezone ?? "UTC"}
              />
            ) : null}
          </section>
        </div>
      ) : null}
    </div>
  );
}

function moveFilterFocus(
  event: KeyboardEvent<HTMLButtonElement>,
  currentIndex: number,
  select: (filter: MailboxFilter) => void,
): void {
  let nextIndex: number | undefined;
  if (event.key === "ArrowRight") {
    nextIndex = (currentIndex + 1) % FILTERS.length;
  } else if (event.key === "ArrowLeft") {
    nextIndex = (currentIndex - 1 + FILTERS.length) % FILTERS.length;
  } else if (event.key === "Home") {
    nextIndex = 0;
  } else if (event.key === "End") {
    nextIndex = FILTERS.length - 1;
  }
  if (nextIndex === undefined) return;
  event.preventDefault();
  const next = FILTERS[nextIndex];
  if (!next) return;
  select(next.value);
  const buttons =
    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
      '[role="tab"]',
    );
  buttons?.item(nextIndex).focus();
}

export function LetterListRow({
  letter,
  correspondent,
  serverTimeUtc,
  selected,
  timezone,
  onSelect,
}: {
  letter: LetterSummaryResponse;
  correspondent: string;
  serverTimeUtc: string;
  selected: boolean;
  timezone: string;
  onSelect: () => void;
}) {
  const Icon =
    letter.status === "read"
      ? Archive
      : letter.direction === "agent_to_user"
        ? Mail
        : Send;
  const transit = transitPresentation(letter, serverTimeUtc, "zh-CN", timezone);
  return (
    <button
      className={`letter-list-row${selected ? " is-selected" : ""}`}
      type="button"
      aria-current={selected ? "true" : undefined}
      onClick={onSelect}
    >
      <Icon size={30} strokeWidth={1.4} aria-hidden="true" />
      <span className="letter-list-row__content">
        <span className="letter-list-row__topline">
          <strong>{correspondent}</strong>
          <time>{formatCorrespondenceDate(letter.authoredDisplayDate)}</time>
        </span>
        <span className={`letter-status letter-status--${letter.status}`}>
          {statusLabel(letter.status, letter.direction)}
          {transit.dayLabel ? ` · ${transit.dayLabel}` : ""}
        </span>
        {letter.previewText ? (
          <span className="letter-list-row__preview">{letter.previewText}</span>
        ) : letter.arrivalDueAtUtc && letter.status === "in_transit" ? (
          <span className="letter-list-row__preview">
            预计 {formatCorrespondenceDate(letter.arrivalDueAtUtc)}抵达
          </span>
        ) : null}
      </span>
      <ChevronRight
        className="letter-list-row__chevron"
        size={18}
        aria-hidden="true"
      />
    </button>
  );
}

function MailboxLetterDetail({
  detail,
  letter,
  correspondent,
  serverTimeUtc,
  agentId,
  timezone,
}: {
  detail: Awaited<ReturnType<typeof api.letters.getCacheSafe>>;
  letter: LetterSummaryResponse;
  correspondent: string;
  serverTimeUtc: string;
  agentId: string;
  timezone: string;
}) {
  return (
    <div className="mailbox-detail__inner">
      <header className="mailbox-detail__heading">
        <div>
          <h2>
            {letter.direction === "agent_to_user" ? "来自" : "寄给"}：
            {correspondent}
          </h2>
          <p>日期：{formatCorrespondenceDate(letter.authoredDisplayDate)}</p>
        </div>
        <span className={`letter-status letter-status--${letter.status}`}>
          {statusLabel(letter.status, letter.direction)}
        </span>
      </header>

      {letter.direction === "agent_to_user" ? (
        <EnvelopePanel
          correspondent={correspondent}
          letter={letter}
          {...(letter.canOpen
            ? {
                openHref: `/letters/${letter.id}?agentId=${encodeURIComponent(agentId)}`,
              }
            : {})}
        />
      ) : isCachedUserLetterDetail(detail) ? (
        <LetterPaper
          {...(detail.subject === undefined ? {} : { subject: detail.subject })}
          body={detail.body}
          recipient={correspondent}
          authoredDate={letter.authoredDisplayDate}
        />
      ) : null}

      {letter.dispatchedAtUtc && letter.arrivalDueAtUtc ? (
        <TransitProgress
          letter={letter}
          serverTimeUtc={serverTimeUtc}
          timezone={timezone}
        />
      ) : null}

      <div className="mailbox-detail__actions">
        {!letter.canOpen ? (
          <Link
            className="button button--ghost"
            to={`/letters/${letter.id}?agentId=${encodeURIComponent(agentId)}`}
          >
            查看详情
          </Link>
        ) : null}
        <Link
          className="text-button"
          to={`/correspondence/threads/${letter.threadId}?agentId=${encodeURIComponent(agentId)}`}
        >
          与 {correspondent} 的往来
        </Link>
      </div>
    </div>
  );
}
