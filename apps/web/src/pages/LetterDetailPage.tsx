import {
  ArrowLeft,
  BookOpen,
  Clipboard,
  PenLine,
  Reply,
  SkipForward,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams, useSearchParams } from "react-router-dom";
import type {
  CorrespondenceMailboxResponse,
  OpenLetterResponse,
} from "@personasim/contracts";
import type { LetterSummaryResponse } from "@personasim/contracts";
import { api, unwrapCharacter } from "../api/client";
import {
  EnvelopePanel,
  ExchangeTimeline,
  LetterPaper,
  OpenedLetterPaper,
  ReplyGenerationStatus,
  TransitProgress,
} from "../components/correspondence/CorrespondencePrimitives";
import { ErrorBlock, LoadingBlock } from "../components/Feedback";
import {
  correspondenceQueryKeys,
  findThreadLetters,
  formatCorrespondenceDate,
  isCachedUserLetterDetail,
  statusLabel,
  type LetterRevealPhase,
} from "../lib/correspondence";
import {
  readActiveCharacter,
  rememberActiveCharacter,
} from "../lib/activeCharacter";
import { openLetterForMountedReader } from "../lib/correspondenceMutations";
import { usePrefersReducedMotion } from "../hooks/usePrefersReducedMotion";
import { useReplyGenerationRetry } from "../hooks/useReplyGenerationRetry";

export default function LetterDetailPage() {
  const { letterId = "" } = useParams();
  const [searchParams] = useSearchParams();
  const agentId = searchParams.get("agentId") ?? readActiveCharacter() ?? "";
  return (
    <LetterReader
      key={`${agentId}:${letterId}`}
      letterId={letterId}
      agentId={agentId}
    />
  );
}

export function LetterReader({
  letterId,
  agentId,
  embedded = false,
  mailboxSnapshot,
  onReadingModeChange,
}: {
  letterId: string;
  agentId: string;
  embedded?: boolean;
  mailboxSnapshot?: CorrespondenceMailboxResponse;
  onReadingModeChange?: (reading: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const prefersReducedMotion = usePrefersReducedMotion();
  const [opened, setOpened] = useState<OpenLetterResponse>();
  const [phase, setPhase] = useState<LetterRevealPhase>("envelope");
  const [openPending, setOpenPending] = useState(false);
  const [openError, setOpenError] = useState<unknown>();
  const [readingMode, setReadingMode] = useState(false);
  const [copied, setCopied] = useState(false);
  const readingHeadingRef = useRef<HTMLHeadingElement>(null);
  const mountedRef = useRef(false);
  const openingRef = useRef(false);
  const automaticReadAttemptedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (agentId) rememberActiveCharacter(agentId);
  }, [agentId]);

  const detailQuery = useQuery({
    queryKey: correspondenceQueryKeys.letter(letterId),
    queryFn: () => api.letters.getCacheSafe(letterId),
    enabled: Boolean(letterId),
  });
  const characterQuery = useQuery({
    queryKey: ["character", agentId],
    queryFn: () => api.characters.get(agentId),
    enabled: Boolean(agentId),
  });
  const mailboxQuery = useQuery({
    queryKey: correspondenceQueryKeys.mailbox(agentId),
    queryFn: () => api.correspondence.list(agentId),
    enabled: Boolean(agentId) && mailboxSnapshot === undefined,
  });
  const settingsQuery = useQuery({
    queryKey: ["settings"],
    queryFn: api.settings.get,
  });
  const character = characterQuery.data
    ? unwrapCharacter(characterQuery.data)
    : undefined;
  const correspondent = character?.identity.name ?? "角色";
  const detail = detailQuery.data;
  const letter = detail?.letter;
  const mailbox = mailboxSnapshot ?? mailboxQuery.data;
  const thread =
    letter === undefined
      ? undefined
      : mailbox?.threads.find((item) => item.id === letter.threadId);
  const projectedReplyState = thread?.replyState;
  const replyState =
    projectedReplyState?.incomingLetterId === letter?.id
      ? projectedReplyState
      : undefined;
  const threadLetters =
    letter && mailbox ? findThreadLetters(mailbox, letter.threadId) : [];
  const canCompose = settingsQuery.data?.correspondenceMode === "enforced";
  const replyRetry = useReplyGenerationRetry(agentId, replyState);

  const openLetter = useCallback(
    async (alreadyRead = false) => {
      if (!letterId || openingRef.current) return;
      openingRef.current = true;
      setOpenPending(true);
      setOpenError(undefined);
      try {
        // Deliberately not a React Query mutation: the decrypted response must
        // live only in this mounted reader and disappear when it unmounts.
        await openLetterForMountedReader({
          open: () => api.letters.open(letterId),
          prefersReducedMotion: prefersReducedMotion || alreadyRead,
          onOpened: (response, nextPhase) => {
            if (!mountedRef.current) return;
            setOpened(response);
            setPhase(nextPhase);
          },
        });
        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: correspondenceQueryKeys.letter(letterId),
          }),
          agentId
            ? queryClient.invalidateQueries({
                queryKey: correspondenceQueryKeys.mailbox(agentId),
              })
            : Promise.resolve(),
          agentId
            ? queryClient.invalidateQueries({
                queryKey: ["agent", agentId, "timeline"],
              })
            : Promise.resolve(),
        ]);
      } catch (error) {
        if (mountedRef.current) setOpenError(error);
      } finally {
        openingRef.current = false;
        if (mountedRef.current) setOpenPending(false);
      }
    },
    [agentId, letterId, prefersReducedMotion, queryClient],
  );

  useEffect(() => {
    if (
      letter?.direction !== "agent_to_user" ||
      letter.status !== "read" ||
      automaticReadAttemptedRef.current ||
      openingRef.current ||
      opened
    )
      return;
    automaticReadAttemptedRef.current = true;
    void openLetter(true);
  }, [letter?.direction, letter?.status, openLetter, opened]);

  useEffect(() => {
    if (phase !== "revealing") return;
    const timer = window.setTimeout(() => setPhase("reading"), 900);
    return () => window.clearTimeout(timer);
  }, [phase]);

  useEffect(() => {
    if (phase === "reading" && opened) readingHeadingRef.current?.focus();
  }, [opened, phase]);

  if (detailQuery.isPending) {
    return <LoadingBlock label="正在取信…" fullPage />;
  }
  if (detailQuery.isError) {
    return <ErrorBlock error={detailQuery.error} />;
  }
  if (!letter || !detail) return null;

  const backHref = agentId
    ? `/characters/${agentId}/correspondence`
    : "/characters";
  const serverTimeUtc = mailbox?.serverTimeUtc ?? new Date().toISOString();
  const readableBody =
    opened && phase === "reading"
      ? opened.body
      : isCachedUserLetterDetail(detail)
        ? detail.body
        : undefined;
  const toggleReadingMode = () => {
    const next = !readingMode;
    setReadingMode(next);
    onReadingModeChange?.(next);
  };
  const copyBody = async () => {
    if (readableBody === undefined) return;
    try {
      await navigator.clipboard.writeText(readableBody);
      if (mountedRef.current) setCopied(true);
    } catch {
      if (mountedRef.current)
        setOpenError(new Error("未能复制，请选中信件正文后复制。"));
    }
  };

  return (
    <div
      className={`letter-detail-page letter-reader${embedded ? " letter-reader--embedded" : ""}${readingMode ? " letter-reader--focused" : ""}`}
    >
      {!embedded ? (
        <header className="letter-detail-header">
          <Link className="correspondence-back-link" to={backHref}>
            <ArrowLeft size={18} aria-hidden="true" /> 返回书信
          </Link>
          <h1>与 {correspondent} 的往来</h1>
          <div className="letter-detail-header__date">
            <time>{formatCorrespondenceDate(letter.authoredDisplayDate)}</time>
            <span>{letter.postmark}</span>
          </div>
        </header>
      ) : null}

      <div className="letter-detail-layout">
        <section className="letter-detail-content">
          <div className="letter-reader__scroll" aria-label="信件阅读区">
            {openError ? <ErrorBlock error={openError} /> : null}
            {letter.direction === "agent_to_user" ? (
              <AgentLetterReader
                correspondent={correspondent}
                letter={letter}
                opened={opened}
                phase={phase}
                openPending={openPending}
                readingMode={readingMode}
                headingRef={readingHeadingRef}
                onOpen={() => void openLetter()}
                onSkip={() => setPhase("reading")}
              />
            ) : isCachedUserLetterDetail(detail) ? (
              <LetterPaper
                {...(detail.subject === undefined
                  ? {}
                  : { subject: detail.subject })}
                body={detail.body}
                recipient={correspondent}
                authoredDate={letter.authoredDisplayDate}
                readingMode={readingMode}
              />
            ) : null}

            {replyState ? (
              <div className="letter-reply-generation">
                <ReplyGenerationStatus
                  state={replyState}
                  correspondent={correspondent}
                  isPending={replyRetry.isPending}
                  {...(replyRetry.safeErrorMessage === undefined
                    ? {}
                    : { safeErrorMessage: replyRetry.safeErrorMessage })}
                  onRetry={replyRetry.retry}
                />
              </div>
            ) : null}

            {letter.dispatchedAtUtc &&
            letter.arrivalDueAtUtc &&
            phase !== "reading" &&
            letter.status !== "read" ? (
              <TransitProgress
                letter={letter}
                serverTimeUtc={serverTimeUtc}
                timezone={character?.identity.timezone ?? "UTC"}
              />
            ) : null}
          </div>

          {readableBody !== undefined ||
          (canCompose && letter.status === "draft") ? (
            <div className="letter-reader-actions">
              {canCompose && opened && phase === "reading" && agentId ? (
                <Link
                  className="button button--primary letter-reader-actions__reply"
                  to={`/characters/${agentId}/correspondence/compose`}
                >
                  <Reply size={18} aria-hidden="true" /> 回信
                </Link>
              ) : null}
              {readableBody !== undefined ? (
                <button
                  className="button button--quiet"
                  type="button"
                  aria-pressed={readingMode}
                  onClick={toggleReadingMode}
                >
                  <BookOpen size={18} aria-hidden="true" />{" "}
                  {readingMode ? "退出专注" : "专注阅读"}
                </button>
              ) : null}
              {readableBody !== undefined ? (
                <button
                  className="button button--ghost"
                  type="button"
                  onClick={() => void copyBody()}
                >
                  <Clipboard size={17} aria-hidden="true" />{" "}
                  {copied ? "已复制" : "复制正文"}
                </button>
              ) : null}
              {canCompose && letter.status === "draft" && agentId ? (
                <Link
                  className="button button--primary"
                  to={`/characters/${agentId}/correspondence/compose?draftId=${encodeURIComponent(letter.id)}`}
                >
                  <PenLine size={17} aria-hidden="true" /> 继续编辑
                </Link>
              ) : null}
            </div>
          ) : null}
          {embedded && agentId ? (
            <Link
              className="text-button letter-reader__thread-link"
              to={`/correspondence/threads/${letter.threadId}?agentId=${encodeURIComponent(agentId)}`}
            >
              查看完整往来
            </Link>
          ) : null}
        </section>

        {!embedded && !readingMode && threadLetters.length > 0 && agentId ? (
          <aside className="letter-thread-rail">
            <ExchangeTimeline
              letters={threadLetters}
              correspondent={correspondent}
              agentId={agentId}
            />
            <Link
              className="text-button"
              to={`/correspondence/threads/${letter.threadId}?agentId=${encodeURIComponent(agentId)}`}
            >
              查看完整往来
            </Link>
          </aside>
        ) : null}
      </div>
    </div>
  );
}

function AgentLetterReader({
  correspondent,
  letter,
  opened,
  phase,
  openPending,
  readingMode,
  headingRef,
  onOpen,
  onSkip,
}: {
  correspondent: string;
  letter: LetterSummaryResponse;
  opened: OpenLetterResponse | undefined;
  phase: LetterRevealPhase;
  openPending: boolean;
  readingMode: boolean;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
  onOpen: () => void;
  onSkip: () => void;
}) {
  if (opened && phase === "reading") {
    return (
      <OpenedLetterPaper
        opened={opened}
        readingMode={readingMode}
        headingRef={headingRef}
      />
    );
  }

  return (
    <div className="letter-reveal-stage" aria-live="polite">
      <EnvelopePanel
        correspondent={correspondent}
        letter={letter}
        isRevealing={phase === "revealing"}
        openPending={openPending}
        {...(phase === "envelope" && letter.canOpen ? { onOpen } : {})}
      />
      {phase === "revealing" ? (
        <button
          className="text-button letter-reveal-skip"
          type="button"
          onClick={onSkip}
        >
          <SkipForward size={15} aria-hidden="true" /> 跳过展开
        </button>
      ) : null}
      {phase === "envelope" && !letter.canOpen ? (
        <p className="letter-envelope-note">
          {statusLabel(letter.status, letter.direction)}
          。信件抵达前不会显示正文。
        </p>
      ) : null}
    </div>
  );
}
