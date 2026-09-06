import {
  ArrowLeft,
  BookOpen,
  Clipboard,
  PenLine,
  SkipForward,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams, useSearchParams } from "react-router-dom";
import type { OpenLetterResponse } from "@personasim/contracts";
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
  const queryClient = useQueryClient();
  const prefersReducedMotion = usePrefersReducedMotion();
  const [opened, setOpened] = useState<OpenLetterResponse>();
  const [phase, setPhase] = useState<LetterRevealPhase>("envelope");
  const [openPending, setOpenPending] = useState(false);
  const [openError, setOpenError] = useState<unknown>();
  const [readingMode, setReadingMode] = useState(false);
  const readingHeadingRef = useRef<HTMLHeadingElement>(null);

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
    enabled: Boolean(agentId),
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
  const thread =
    letter === undefined
      ? undefined
      : mailboxQuery.data?.threads.find((item) => item.id === letter.threadId);
  const projectedReplyState = thread?.replyState;
  const replyState =
    projectedReplyState?.incomingLetterId === letter?.id
      ? projectedReplyState
      : undefined;
  const threadLetters =
    letter && mailboxQuery.data
      ? findThreadLetters(mailboxQuery.data, letter.threadId)
      : [];
  const canCompose = settingsQuery.data?.correspondenceMode === "enforced";
  const replyRetry = useReplyGenerationRetry(agentId, replyState);

  const openLetter = useCallback(async () => {
    if (!letterId || openPending) return;
    setOpenPending(true);
    setOpenError(undefined);
    try {
      // Deliberately not a React Query mutation: the decrypted response must
      // live only in this mounted reader and disappear when it unmounts.
      await openLetterForMountedReader({
        open: () => api.letters.open(letterId),
        prefersReducedMotion,
        onOpened: (response, nextPhase) => {
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
      setOpenError(error);
    } finally {
      setOpenPending(false);
    }
  }, [agentId, letterId, openPending, prefersReducedMotion, queryClient]);

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
  const serverTimeUtc =
    mailboxQuery.data?.serverTimeUtc ?? new Date().toISOString();

  return (
    <div className="letter-detail-page">
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

      {openError ? <ErrorBlock error={openError} /> : null}

      <main className="letter-detail-layout">
        <section className="letter-detail-content">
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
          phase !== "reading" ? (
            <TransitProgress
              letter={letter}
              serverTimeUtc={serverTimeUtc}
              timezone={character?.identity.timezone ?? "UTC"}
            />
          ) : null}

          <div className="letter-reader-actions">
            {opened && phase === "reading" ? (
              <button
                className="button button--ghost"
                type="button"
                onClick={() => void navigator.clipboard.writeText(opened.body)}
              >
                <Clipboard size={16} aria-hidden="true" /> 复制正文
              </button>
            ) : null}
            {(opened && phase === "reading") ||
            letter.direction === "user_to_agent" ? (
              <button
                className="button button--quiet"
                type="button"
                aria-pressed={readingMode}
                onClick={() => setReadingMode((value) => !value)}
              >
                <BookOpen size={16} aria-hidden="true" /> 清晰阅读
              </button>
            ) : null}
            {canCompose && letter.status === "draft" && agentId ? (
              <Link
                className="button button--primary"
                to={`/characters/${agentId}/correspondence/compose?draftId=${encodeURIComponent(letter.id)}`}
              >
                继续编辑
              </Link>
            ) : null}
            {canCompose && opened && phase === "reading" && agentId ? (
              <Link
                className="button button--primary letter-reader-actions__reply"
                to={`/characters/${agentId}/correspondence/compose`}
              >
                <PenLine size={16} aria-hidden="true" /> 写下一封信
              </Link>
            ) : null}
          </div>
        </section>

        {threadLetters.length > 0 && agentId ? (
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
      </main>
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
