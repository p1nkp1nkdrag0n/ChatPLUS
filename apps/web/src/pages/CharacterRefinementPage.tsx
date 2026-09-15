import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { interviewApi, type InterviewPreview } from "../api/interview";
import { ApiError } from "../api/types";
import { CreationDesk } from "../components/creation/CreationDesk";
import { ErrorBlock } from "../components/Feedback";
import {
  previewInterviewDraft,
  readInterviewDraft,
  saveInterviewDraft,
} from "../lib/characterInterview";
import {
  REFINEMENT_FEEDBACK_LIMIT,
  clearRefinementDraft,
  newRefinementDraft,
  readRefinementDraft,
  saveRefinementDraft,
  updateRefinementFeedback,
  type RefinementDraft,
} from "../lib/characterRefinement";

export default function CharacterRefinementPage() {
  const { characterId } = useParams<{ characterId: string }>();
  const query = useQuery({
    queryKey: ["creation-preview", characterId],
    queryFn: () => interviewApi.preview(characterId!),
    enabled: Boolean(characterId),
    retry: false,
    refetchOnWindowFocus: false,
  });
  useEffect(() => {
    document.title = "调整人物设定 · Dearvale";
  }, []);
  return (
    <CreationDesk preview lifted={Boolean(query.data)}>
      {query.isPending ? (
        <div className="creation-ready" role="status">
          <h2>正在打开当前的人物小传…</h2>
        </div>
      ) : query.isError && !query.data ? (
        <div className="creation-ready">
          <ErrorBlock error={query.error} />
          <button
            className="creation-button"
            onClick={() => void query.refetch()}
          >
            重新读取
          </button>
          <Link
            className="creation-text-button"
            to={`/characters/${characterId}/preview`}
          >
            返回人物小传
          </Link>
        </div>
      ) : query.data ? (
        <RefinementContents
          key={query.data.characterId}
          preview={query.data}
          refreshing={query.isFetching}
          refresh={async () => {
            const result = await query.refetch();
            if (result.isError) throw result.error;
            return result.data!;
          }}
        />
      ) : null}
    </CreationDesk>
  );
}

function RefinementContents({
  preview,
  refreshing,
  refresh,
}: {
  preview: InterviewPreview;
  refreshing: boolean;
  refresh: () => Promise<InterviewPreview>;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(
    () =>
      readRefinementDraft(preview.characterId) ??
      newRefinementDraft(preview.characterId, preview.characterVersion),
  );
  const draftRef = useRef(draft);
  const actionInFlight = useRef(false);
  const live = useRef(true);
  const feedbackInput = useRef<HTMLTextAreaElement>(null);
  const [storageFailed, setStorageFailed] = useState(false);
  const [fieldError, setFieldError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [refreshedVersion, setRefreshedVersion] = useState<number>();
  const [refreshError, setRefreshError] = useState<unknown>();
  const canRefine = preview.canRefine ?? preview.canReviseInterview;
  const staleVersion = draft.characterVersion !== preview.characterVersion;
  const needsReview = conflict || staleVersion;
  const commit = (next: RefinementDraft) => {
    draftRef.current = next;
    setDraft(next);
    setStorageFailed(!saveRefinementDraft(next));
  };
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const mutation = useMutation({
    mutationFn: (current: RefinementDraft) =>
      interviewApi.refine({
        characterId: current.characterId,
        expectedVersion: current.characterVersion,
        feedback: current.feedback,
        requestId: current.requestId,
      }),
    onSuccess: (result, current) => {
      const saved = readInterviewDraft();
      if (
        !saved ||
        (saved.characterId === current.characterId &&
          (saved.characterVersion ?? 0) <= current.characterVersion)
      ) {
        saveInterviewDraft(
          previewInterviewDraft(result.preview, result.preview.answers),
        );
      }
      clearRefinementDraft(current.characterId, current.requestId);
      queryClient.setQueryData(
        ["creation-preview", current.characterId],
        result.preview,
      );
      queryClient.setQueryData(["character", current.characterId], {
        character: result.character,
      });
      void queryClient.invalidateQueries({ queryKey: ["characters"] });
      if (live.current)
        void navigate(`/characters/${current.characterId}/preview`, {
          replace: true,
        });
    },
    onError: (error) => {
      if (live.current && error instanceof ApiError && error.status === 409) {
        setConflict(true);
        setRefreshedVersion(undefined);
      }
    },
    onSettled: () => {
      actionInFlight.current = false;
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (
      actionInFlight.current ||
      mutation.isPending ||
      refreshing ||
      !canRefine ||
      needsReview
    )
      return;
    const current = draftRef.current;
    if (!current.feedback.trim()) {
      setFieldError("写下希望调整的地方，再更新人物小传。");
      feedbackInput.current?.focus();
      return;
    }
    actionInFlight.current = true;
    setFieldError("");
    commit(current);
    mutation.mutate(current);
  };
  const refreshLatest = async () => {
    if (actionInFlight.current || refreshing) return;
    actionInFlight.current = true;
    setRefreshError(undefined);
    try {
      const latest = await refresh();
      if (live.current) setRefreshedVersion(latest.characterVersion);
    } catch (error) {
      if (live.current) setRefreshError(error);
    } finally {
      actionInFlight.current = false;
    }
  };
  const acceptLatest = () => {
    if (
      refreshing ||
      actionInFlight.current ||
      refreshedVersion !== preview.characterVersion
    )
      return;
    commit(
      newRefinementDraft(
        preview.characterId,
        preview.characterVersion,
        draftRef.current.feedback,
      ),
    );
    setConflict(false);
    setRefreshedVersion(undefined);
    mutation.reset();
    feedbackInput.current?.focus();
  };
  return (
    <form
      className="creation-portrait creation-refinement"
      data-testid="character-refinement"
      onSubmit={submit}
      noValidate
    >
      <header className="creation-portrait-heading">
        <h2>调整人物设定</h2>
        <p>
          {preview.identity.name} · 第 {preview.characterVersion} 版
        </p>
      </header>
      <div className="creation-portrait-prose creation-refinement-body">
        <p className="creation-refinement-intro">
          写下哪里不符合你的想象，以及希望改成什么样。我们会根据你的意见调整人物设定，再写成新的小传；没有提到的设定会尽量保留。
        </p>
        <details
          className="creation-refinement-reference"
          key={needsReview ? "review" : "writing"}
          open={needsReview}
        >
          <summary>查看当前人物小传</summary>
          <div>
            {preview.paragraphs.map((paragraph, index) => (
              <p key={index}>{paragraph}</p>
            ))}
          </div>
        </details>
        {!canRefine ? (
          <p className="creation-field-error" role="status">
            这位角色已经开始生活，暂时不能通过意见重新生成。你仍可以阅读人物小传，或打开详细设定。
          </p>
        ) : null}
        {needsReview && canRefine ? (
          <section
            className="creation-refinement-conflict"
            aria-label="确认最新人物小传"
            role="status"
          >
            <p>
              人物设定已有更新。你的修改意见已保留，请重新读取并读过最新小传后再继续。
            </p>
            <button
              type="button"
              className="creation-text-button"
              disabled={refreshing || mutation.isPending}
              data-testid="refinement-refresh"
              onClick={() => void refreshLatest()}
            >
              {refreshing ? "正在读取最新小传…" : "重新读取最新小传"}
            </button>
            {refreshedVersion === preview.characterVersion ? (
              <button
                type="button"
                className="creation-text-button"
                data-testid="refinement-confirm-version"
                disabled={refreshing}
                onClick={acceptLatest}
              >
                已读最新小传，继续修改
              </button>
            ) : null}
          </section>
        ) : null}
        {refreshError ? <ErrorBlock error={refreshError} /> : null}
        <label className="creation-refinement-label" htmlFor="refine-feedback">
          你希望调整哪些地方？
        </label>
        <textarea
          id="refine-feedback"
          ref={feedbackInput}
          className="creation-refinement-feedback"
          data-testid="refine-feedback"
          value={draft.feedback}
          maxLength={REFINEMENT_FEEDBACK_LIMIT}
          rows={6}
          disabled={mutation.isPending || !canRefine}
          aria-invalid={Boolean(fieldError)}
          aria-describedby={`refinement-hint refinement-count${fieldError ? " refinement-field-error" : ""}`}
          placeholder="例如：她不应当总是温柔退让。希望她对陌生人更有戒心，但仍然珍惜熟悉的人；保留修书的职业和原来的生活经历。"
          onChange={(event) => {
            setFieldError("");
            if (mutation.isError && !conflict) mutation.reset();
            commit(
              updateRefinementFeedback(draftRef.current, event.target.value),
            );
          }}
        />
        <div className="creation-refinement-meta">
          <span id="refinement-hint">可以多次调整，满意后再开始相遇。</span>
          <span id="refinement-count">
            {draft.feedback.length} / {REFINEMENT_FEEDBACK_LIMIT}
          </span>
        </div>
        {fieldError ? (
          <p
            id="refinement-field-error"
            className="creation-field-error"
            role="alert"
          >
            {fieldError}
          </p>
        ) : null}
        {storageFailed ? (
          <p className="creation-field-error" role="status">
            浏览器暂时无法暂存意见，请留在这一页完成调整。
          </p>
        ) : null}
        {mutation.isError && !conflict ? (
          <ErrorBlock
            error={mutation.error}
            action={<p>修改意见仍保留在这里，可以重试。</p>}
          />
        ) : null}
        {mutation.isPending ? (
          <div className="creation-refinement-waiting" role="status">
            <span className="creation-waiting-ink" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <p>正在根据你的意见调整人物设定，并更新小传…</p>
          </div>
        ) : null}
      </div>
      <footer className="creation-portrait-footer">
        <div className="creation-actions">
          {!mutation.isPending ? (
            <Link
              className="creation-button creation-button--secondary"
              to={`/characters/${preview.characterId}/preview`}
            >
              返回小传
            </Link>
          ) : null}
          {canRefine ? (
            <button
              className="creation-button"
              type="submit"
              data-testid="submit-refinement"
              disabled={mutation.isPending || refreshing || needsReview}
            >
              {mutation.isPending ? "正在更新…" : "更新人物小传"}
            </button>
          ) : (
            <Link
              className="creation-button"
              to={`/characters/${preview.characterId}/edit`}
            >
              打开详细设定
            </Link>
          )}
        </div>
      </footer>
    </form>
  );
}
