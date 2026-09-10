import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  CharacterInterviewAnswersSchema,
  type CharacterInterviewAnswers,
} from "@personasim/contracts";
import { api, unwrapCharacter } from "../api/client";
import { interviewApi, type InterviewPreview } from "../api/interview";
import { ApiError } from "../api/types";
import { CreationDesk } from "../components/creation/CreationDesk";
import { InterviewSettings } from "../components/creation/InterviewSettings";
import { ErrorBlock } from "../components/Feedback";
import { rememberActiveCharacter } from "../lib/activeCharacter";
import {
  clearInterviewDraft,
  interviewSubject,
  previewInterviewDraft,
  readInterviewDraft,
  restoredPreviewAnswers,
  saveInterviewDraft,
} from "../lib/characterInterview";

export default function CharacterPreviewPage() {
  const { characterId } = useParams<{ characterId: string }>();
  const [conflictCharacterId, setConflictCharacterId] = useState<string>();
  const [reviewCharacterId, setReviewCharacterId] = useState<string>();
  const query = useQuery({
    queryKey: ["creation-preview", characterId],
    queryFn: () => interviewApi.preview(characterId!),
    enabled: Boolean(characterId),
    retry: false,
  });
  useEffect(() => {
    document.title = "读一读人物小传 · Dearvale";
  }, []);
  return (
    <CreationDesk preview>
      {query.isPending ? (
        <div className="creation-ready" role="status">
          <h2>正在打开这份描绘…</h2>
        </div>
      ) : query.isError ? (
        <div className="creation-ready">
          <ErrorBlock error={query.error} />
          <button
            className="creation-button"
            onClick={() => void query.refetch()}
          >
            重新读取
          </button>
          <Link to="/create" className="creation-text-button">
            回到信纸
          </Link>
        </div>
      ) : (
        <PreviewContents
          key={`${query.data.characterId}:${query.data.characterVersion}`}
          preview={query.data}
          conflict={conflictCharacterId === query.data.characterId}
          onConflict={() => setConflictCharacterId(query.data.characterId)}
          reviewNeeded={reviewCharacterId === query.data.characterId}
          onReviewNeeded={() => setReviewCharacterId(query.data.characterId)}
        />
      )}
    </CreationDesk>
  );
}

function PreviewContents({
  preview,
  conflict,
  onConflict,
  reviewNeeded,
  onReviewNeeded,
}: {
  preview: InterviewPreview;
  conflict: boolean;
  onConflict: () => void;
  reviewNeeded: boolean;
  onReviewNeeded: () => void;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [answers, setAnswers] = useState<CharacterInterviewAnswers>(() =>
    restoredPreviewAnswers(preview, readInterviewDraft()),
  );
  const [storageFailed, setStorageFailed] = useState(false);
  const [chooseQuestion, setChooseQuestion] = useState(false);
  const [settingsError, setSettingsError] = useState<string>();
  const actionInFlight = useRef(false);
  const changePanel = useRef<HTMLDivElement>(null);
  const reviewPanel = useRef<HTMLElement>(null);
  useEffect(() => {
    if (chooseQuestion)
      changePanel.current?.scrollIntoView({ block: "nearest" });
  }, [chooseQuestion]);
  useEffect(() => {
    if (reviewNeeded) reviewPanel.current?.scrollIntoView({ block: "nearest" });
  }, [reviewNeeded, preview.characterVersion]);
  const subject = interviewSubject({
    name: preview.identity.name,
    gender: preview.identity.gender ?? "",
  });
  const editable = preview.canReviseInterview;
  const dirty =
    JSON.stringify(answers.advanced) !==
    JSON.stringify(preview.answers.advanced);
  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: ["creation-preview", preview.characterId],
      }),
      queryClient.invalidateQueries({
        queryKey: ["character", preview.characterId],
      }),
    ]);
  };
  const currentDraft = () => previewInterviewDraft(preview, answers);
  const handleConflict = () => {
    onConflict();
    void refresh();
  };
  const beginAction = (run: () => void) => {
    if (actionInFlight.current) return;
    const saved = readInterviewDraft();
    if (
      saved?.characterId === preview.characterId &&
      (saved.characterVersion ?? 0) > preview.characterVersion
    ) {
      handleConflict();
      return;
    }
    actionInFlight.current = true;
    run();
  };
  const releaseAction = () => {
    actionInFlight.current = false;
  };
  const initialPreview = useRef({ preview, answers });
  useEffect(() => {
    const initial = initialPreview.current;
    const stored = readInterviewDraft();
    // A direct preview route must not overwrite writing that is in progress in
    // another tab. Restore only settings that belong to this exact spec version.
    if (
      !stored ||
      (stored.characterId === initial.preview.characterId &&
        stored.phase === "preview" &&
        (stored.characterVersion ?? 0) <= initial.preview.characterVersion)
    ) {
      setStorageFailed(
        !saveInterviewDraft(
          previewInterviewDraft(initial.preview, initial.answers, stored),
        ),
      );
    }
  }, []);

  const publish = useMutation({
    mutationFn: () =>
      api.characters.publish(preview.characterId, preview.characterVersion),
    onSuccess: (result) => {
      const character = unwrapCharacter(result);
      queryClient.setQueryData(["character", character.id], result);
      rememberActiveCharacter(character.id);
      clearInterviewDraft(character.id);
      void queryClient.invalidateQueries({ queryKey: ["characters"] });
      void navigate(`/characters/${character.id}/chat`);
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 422) onReviewNeeded();
      if (error instanceof ApiError && error.status === 409) handleConflict();
    },
    onSettled: releaseAction,
  });
  const settings = useMutation({
    mutationFn: () =>
      interviewApi.compile({
        answers: CharacterInterviewAnswersSchema.parse(answers),
        requestId: currentDraft().requestId,
        characterId: preview.characterId,
        expectedVersion: preview.characterVersion,
      }),
    onSuccess: (result) => {
      const stored = readInterviewDraft();
      if (
        !stored ||
        (stored.characterId === preview.characterId &&
          stored.phase === "preview" &&
          stored.characterVersion === preview.characterVersion)
      ) {
        setStorageFailed(
          !saveInterviewDraft(
            previewInterviewDraft(result.preview, result.preview.answers),
          ),
        );
      }
      queryClient.setQueryData(
        ["creation-preview", preview.characterId],
        result.preview,
      );
      queryClient.setQueryData(["character", preview.characterId], {
        character: result.character,
      });
      void queryClient.invalidateQueries({ queryKey: ["characters"] });
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) handleConflict();
    },
    onSettled: releaseAction,
  });
  const review = useMutation({
    mutationFn: (decision: {
      candidateId: string;
      candidateSha256: string;
      decision: "accept" | "reject";
    }) =>
      api.characters.reviewAuthority(
        preview.characterId,
        preview.characterVersion,
        decision,
      ),
    onSuccess: async () => {
      await refresh();
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) handleConflict();
    },
    onSettled: releaseAction,
  });
  const busy = publish.isPending || settings.isPending || review.isPending;
  const pendingCandidates =
    preview.authorityReview?.candidates.filter(
      (candidate) =>
        candidate.status === "pending" &&
        (candidate.strength === "hard" || candidate.strength === "lock"),
    ) ?? [];
  const back = (step: number) => {
    if (!editable || busy || actionInFlight.current) return;
    const stored = readInterviewDraft();
    if (
      stored?.characterId === preview.characterId &&
      (stored.characterVersion ?? 0) > preview.characterVersion
    ) {
      handleConflict();
      return;
    }
    const next = { ...currentDraft(), phase: "main" as const, step };
    if (!saveInterviewDraft(next)) {
      setStorageFailed(true);
      return;
    }
    void navigate("/create");
  };
  return (
    <section className="creation-portrait" data-testid="character-preview">
      <header className="creation-portrait-heading">
        <h2>{preview.identity.name}</h2>
        <p>
          {[
            preview.identity.gender,
            preview.identity.ageText,
            preview.identity.workOrRole,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      </header>
      <div className="creation-portrait-prose">
        {preview.paragraphs.map((paragraph, index) => (
          <p key={index}>{paragraph}</p>
        ))}
        {conflict ? (
          <p className="creation-field-error" role="status">
            这份描绘已有更新，请读过最新的小传后再确认。
          </p>
        ) : null}
        {storageFailed ? (
          <p className="creation-field-error" role="alert">
            浏览器暂时无法保存修改进度，请先允许本地存储后重试。
          </p>
        ) : null}
        {settingsError ? (
          <p className="creation-field-error" role="alert">
            {settingsError}
          </p>
        ) : null}
        {publish.isError && !reviewNeeded ? (
          <ErrorBlock error={publish.error} />
        ) : null}
        {settings.isError ? <ErrorBlock error={settings.error} /> : null}
        {review.isError ? <ErrorBlock error={review.error} /> : null}
        {reviewNeeded ? (
          <section
            ref={reviewPanel}
            className="creation-review"
            aria-label="确认描绘"
          >
            <h3>有一处描绘，需要你确认</h3>
            {pendingCandidates.map((candidate) => (
              <article key={candidate.candidateId}>
                <p>{candidate.effectiveValue ?? candidate.originalValue}</p>
                <small>
                  {candidate.strength === "lock"
                    ? "保留后，这处设定将固定下来。"
                    : "保留后，角色会始终遵循这处设定。"}
                </small>
                <div className="creation-actions">
                  <button
                    className="creation-button creation-button--secondary"
                    disabled={busy}
                    onClick={() =>
                      beginAction(() =>
                        review.mutate({
                          candidateId: candidate.candidateId,
                          candidateSha256: candidate.candidateSha256,
                          decision: "reject",
                        }),
                      )
                    }
                  >
                    不采用
                  </button>
                  <button
                    className="creation-button"
                    disabled={busy}
                    onClick={() =>
                      beginAction(() =>
                        review.mutate({
                          candidateId: candidate.candidateId,
                          candidateSha256: candidate.candidateSha256,
                          decision: "accept",
                        }),
                      )
                    }
                  >
                    保留这处描绘
                  </button>
                </div>
              </article>
            ))}
            {!pendingCandidates.length ? <p>这份设定需要进一步核对。</p> : null}
            <Link
              className="creation-text-button"
              to={`/characters/${preview.characterId}/edit`}
            >
              打开详细设定
            </Link>
          </section>
        ) : null}
        {chooseQuestion ? (
          <div
            ref={changePanel}
            className="creation-edit-answers"
            role="group"
            aria-label="选择要修改的答案"
          >
            {[
              "性别",
              "名字",
              "年龄",
              "世界",
              "身份",
              "外貌",
              "性格",
              "习惯",
              "经历",
              "说话方式",
              "在意的事",
              "补充",
            ].map((label, step) => (
              <button
                className="creation-text-button"
                key={label}
                disabled={busy || !editable}
                onClick={() => back(step)}
              >
                {label}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      <footer className="creation-portrait-footer">
        <div className="creation-actions">
          {editable ? (
            <button
              className="creation-button creation-button--secondary"
              disabled={busy}
              onClick={() => setChooseQuestion((open) => !open)}
            >
              回去修改
            </button>
          ) : (
            <Link
              className="creation-button creation-button--secondary"
              to={`/characters/${preview.characterId}/edit`}
            >
              修改详细设定
            </Link>
          )}
          {preview.status === "published" ? (
            <Link
              className="creation-button"
              data-testid="publish-character"
              to={`/characters/${preview.characterId}/chat`}
            >
              与{subject}相遇
            </Link>
          ) : (
            <button
              className="creation-button"
              disabled={
                busy || (editable && dirty) || preview.status !== "draft"
              }
              data-testid="publish-character"
              onClick={() => beginAction(() => publish.mutate())}
            >
              {publish.isPending ? "正在准备相遇…" : `与${subject}相遇`}
            </button>
          )}
        </div>
        {editable ? (
          <InterviewSettings
            answers={answers}
            disabled={busy}
            onChange={(next) => {
              setAnswers(next);
              setSettingsError(undefined);
              setStorageFailed(
                !saveInterviewDraft({ ...currentDraft(), answers: next }),
              );
            }}
          />
        ) : preview.status === "draft" ? (
          <p className="creation-hint">
            这份描绘已有进一步修改或确认；你可以在详细设定中继续修改，或确认这份小传。
          </p>
        ) : null}
        {editable && dirty ? (
          <button
            className="creation-text-button"
            disabled={busy}
            onClick={() => {
              const checked =
                CharacterInterviewAnswersSchema.safeParse(answers);
              if (!checked.success) {
                setSettingsError(
                  "请检查更多设定：填写有效的时区，故事年份为四位整数。",
                );
                return;
              }
              beginAction(() => settings.mutate());
            }}
          >
            {settings.isPending ? "正在更新描绘…" : "保存设定并更新小传"}
          </button>
        ) : null}
      </footer>
    </section>
  );
}
