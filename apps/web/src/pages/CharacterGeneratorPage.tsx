import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { useNavigate } from "react-router-dom";
import { CharacterInterviewAnswersSchema } from "@personasim/contracts";
import { interviewApi } from "../api/interview";
import { ApiError } from "../api/types";
import {
  CreationDesk,
  type PenMotion,
} from "../components/creation/CreationDesk";
import { useReducedMotion } from "../hooks/useReducedMotion";
import { ErrorBlock } from "../components/Feedback";
import {
  CREATION_TITLE,
  INTERVIEW_QUESTIONS,
  firstMissingAnswer,
  interviewSubject,
  mainAnswersSnapshot,
  newInterviewDraft,
  readInterviewDraft,
  saveInterviewDraft,
  updateInterviewAnswer,
  type AnswerField,
  type InterviewDraft,
} from "../lib/characterInterview";

export default function CharacterGeneratorPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(
    () => readInterviewDraft() ?? newInterviewDraft(),
  );
  const draftRef = useRef(draft);
  const live = useRef(true);
  const requestEpoch = useRef(0);
  const compileInFlight = useRef(false);
  const turnInFlight = useRef(false);
  const turnTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const [storageFailed, setStorageFailed] = useState(false);
  const [followUpsPending, setFollowUpsPending] = useState(false);
  const [fieldError, setFieldError] = useState("");
  const [restartOpen, setRestartOpen] = useState(false);
  const [customGender, setCustomGender] = useState(() =>
    Boolean(
      draft.answers.gender && !["女性", "男性"].includes(draft.answers.gender),
    ),
  );
  const reduced = useReducedMotion();
  const [motion, setMotion] = useState<PenMotion>(
    reduced || (draft.phase !== "main" && draft.phase !== "followups")
      ? "idle"
      : "writing",
  );
  const [inkCount, setInkCount] = useState(0);
  const [penPoint, setPenPoint] = useState({ x: 50, y: 57 });
  const questionRef = useRef<HTMLHeadingElement>(null);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const subject = interviewSubject(draft.answers);
  const mainQuestion = INTERVIEW_QUESTIONS[draft.step]!;
  const followQuestion = draft.followUpQuestions[draft.followUpIndex];
  const isFollowUp = draft.phase === "followups";
  const questionText =
    isFollowUp && followQuestion
      ? followQuestion.text
      : mainQuestion.text(subject);
  const questionLetters = Array.from(questionText);
  const isQuestion = draft.phase === "main" || isFollowUp;

  const commit = (next: InterviewDraft) => {
    draftRef.current = next;
    setDraft(next);
    setStorageFailed(!saveInterviewDraft(next));
  };

  useEffect(() => {
    const epoch = requestEpoch;
    live.current = true;
    document.title = `${CREATION_TITLE} · Dearvale`;
    return () => {
      live.current = false;
      epoch.current++;
      clearTimeout(turnTimer.current);
    };
  }, []);
  useEffect(() => {
    if (draft.phase === "preview" && draft.characterId)
      void navigate(`/characters/${draft.characterId}/preview`, {
        replace: true,
      });
  }, [draft.phase, draft.characterId, navigate]);
  useEffect(() => {
    if (motion !== "writing" || !isQuestion) return;
    if (reduced) {
      setInkCount(questionLetters.length);
      setMotion("idle");
      return;
    }
    const timer = setInterval(
      () => setInkCount((count) => count + 1),
      Math.min(38, 680 / Math.max(1, questionLetters.length)),
    );
    return () => clearInterval(timer);
  }, [motion, reduced, questionText, questionLetters.length, isQuestion]);
  useEffect(() => {
    if (motion === "writing" && inkCount >= questionLetters.length)
      setMotion("idle");
  }, [inkCount, motion, questionLetters.length]);
  useLayoutEffect(() => {
    if (motion !== "writing") return;
    const letter = questionRef.current?.querySelector(
      `[data-letter="${Math.max(0, inkCount - 1)}"]`,
    );
    const stage = questionRef.current?.closest(".creation-stage");
    if (!letter || !stage) return;
    const bounds = letter.getBoundingClientRect();
    const area = stage.getBoundingClientRect();
    setPenPoint({
      x: ((bounds.right - area.left) / area.width) * 100,
      y: ((bounds.bottom - area.top) / area.height) * 100,
    });
  }, [inkCount, motion, questionText]);
  useEffect(() => {
    if (motion === "idle" && isQuestion)
      inputRef.current?.focus({ preventScroll: true });
  }, [motion, isQuestion, draft.step, draft.followUpIndex]);

  const compileMutation = useMutation({
    mutationFn: (current: InterviewDraft) =>
      interviewApi.compile({
        answers: CharacterInterviewAnswersSchema.parse(current.answers),
        requestId: current.requestId,
        ...(current.characterId
          ? {
              characterId: current.characterId,
              expectedVersion: current.characterVersion!,
            }
          : {}),
      }),
    onSuccess: (result, current) => {
      const next: InterviewDraft = {
        ...current,
        phase: "preview",
        characterId: result.character.id,
        characterVersion: result.character.version,
      };
      const stored = readInterviewDraft();
      if (!stored || stored.requestId === current.requestId)
        saveInterviewDraft(next);
      queryClient.setQueryData(
        ["creation-preview", result.character.id],
        result.preview,
      );
      queryClient.setQueryData(["character", result.character.id], {
        character: result.character,
      });
      void queryClient.invalidateQueries({ queryKey: ["characters"] });
      if (live.current) {
        draftRef.current = next;
        setDraft(next);
        void navigate(`/characters/${result.character.id}/preview`, {
          replace: true,
        });
      }
    },
    onSettled: () => {
      compileInFlight.current = false;
    },
  });

  const turnTo = (next: InterviewDraft, backward = false) => {
    setFieldError("");
    clearTimeout(turnTimer.current);
    if (backward || reduced) {
      turnInFlight.current = false;
      commit(next);
      setInkCount(1000);
      setMotion("idle");
      return;
    }
    turnInFlight.current = true;
    setStorageFailed(!saveInterviewDraft(next));
    setMotion("dipping");
    turnTimer.current = setTimeout(() => {
      turnInFlight.current = false;
      commit(next);
      setInkCount(0);
      setMotion(
        next.phase === "main" || next.phase === "followups"
          ? "writing"
          : "idle",
      );
    }, 880);
  };
  const updateAnswer = (field: AnswerField, value: string) => {
    const current = draftRef.current;
    setFieldError("");
    commit(updateInterviewAnswer(current, field, value));
  };
  const requestFollowUps = async (current: InterviewDraft) => {
    const missing = firstMissingAnswer(current.answers);
    if (missing >= 0) {
      turnTo({ ...current, phase: "main", step: missing }, true);
      setFieldError("先把这一处写下来，再继续。");
      return;
    }
    const snapshot = mainAnswersSnapshot(current.answers);
    if (current.followUpSnapshot === snapshot) {
      turnTo({
        ...current,
        phase: current.followUpQuestions.length ? "followups" : "ready",
        followUpIndex: 0,
      });
      return;
    }
    const clean: InterviewDraft = {
      ...current,
      phase: "ready",
      followUpSnapshot: snapshot,
      followUpQuestions: [],
      followUpIndex: 0,
      answers: { ...current.answers, followUps: [] },
    };
    commit(clean);
    setFollowUpsPending(true);
    setMotion("idle");
    const epoch = ++requestEpoch.current;
    try {
      const result = await interviewApi.followUps(clean.answers);
      if (!live.current || epoch !== requestEpoch.current) return;
      const questions = result.questions.slice(0, 2);
      turnTo({
        ...draftRef.current,
        followUpQuestions: questions,
        phase: questions.length ? "followups" : "ready",
      });
    } catch {
      if (live.current && epoch === requestEpoch.current)
        commit({ ...draftRef.current, phase: "ready" });
    } finally {
      if (live.current && epoch === requestEpoch.current)
        setFollowUpsPending(false);
    }
  };
  const forward = (event?: FormEvent, skip = false) => {
    event?.preventDefault();
    if (
      turnInFlight.current ||
      compileInFlight.current ||
      motion === "dipping" ||
      compileMutation.isPending ||
      followUpsPending
    )
      return;
    const current = draftRef.current;
    if (isFollowUp) {
      let next = current;
      if (skip && followQuestion)
        next = {
          ...current,
          answers: {
            ...current.answers,
            followUps: (current.answers.followUps ?? []).filter(
              (a) => a.id !== followQuestion.id,
            ),
          },
        };
      const index = next.followUpIndex + 1;
      turnTo({
        ...next,
        followUpIndex: index,
        phase: index < next.followUpQuestions.length ? "followups" : "ready",
      });
      return;
    }
    if (mainQuestion.required && !current.answers[mainQuestion.field]?.trim()) {
      setFieldError(
        mainQuestion.field === "gender"
          ? "选一个性别，或写下你的描述。"
          : "这一处还空着，写下答案后再继续。",
      );
      setMotion("idle");
      inputRef.current?.focus();
      return;
    }
    const next = skip
      ? updateInterviewAnswer(current, mainQuestion.field, "")
      : current;
    if (next.step === INTERVIEW_QUESTIONS.length - 1)
      void requestFollowUps(next);
    else turnTo({ ...next, step: next.step + 1 });
  };
  const backward = () => {
    const current = draftRef.current;
    requestEpoch.current++;
    setFollowUpsPending(false);
    if (current.phase === "ready")
      turnTo(
        { ...current, phase: "main", step: INTERVIEW_QUESTIONS.length - 1 },
        true,
      );
    else if (current.phase === "followups")
      turnTo(
        current.followUpIndex > 0
          ? { ...current, followUpIndex: current.followUpIndex - 1 }
          : { ...current, phase: "main", step: INTERVIEW_QUESTIONS.length - 1 },
        true,
      );
    else if (current.step > 0)
      turnTo({ ...current, step: current.step - 1 }, true);
  };
  const skipRemaining = () => {
    requestEpoch.current++;
    setFollowUpsPending(false);
    clearTimeout(turnTimer.current);
    turnInFlight.current = false;
    commit({ ...draftRef.current, phase: "ready" });
    setMotion("idle");
  };
  const generate = () => {
    if (compileInFlight.current) return;
    const current = draftRef.current;
    const validation = CharacterInterviewAnswersSchema.safeParse(
      current.answers,
    );
    if (!validation.success) {
      setFieldError(
        validation.error.issues[0]?.message ?? "有一处描绘还需要补充。",
      );
      return;
    }
    compileInFlight.current = true;
    commit(current);
    setFieldError("");
    compileMutation.mutate(current);
  };
  const value = isFollowUp
    ? (draft.answers.followUps?.find((a) => a.id === followQuestion?.id)
        ?.answer ?? "")
    : (draft.answers[mainQuestion.field] ?? "");
  const updateCurrent = (value: string) => {
    if (isFollowUp && followQuestion) {
      const current = draftRef.current;
      const remaining =
        current.answers.followUps?.filter((a) => a.id !== followQuestion.id) ??
        [];
      commit({
        ...current,
        answers: {
          ...current.answers,
          followUps: [
            ...remaining,
            {
              id: followQuestion.id,
              question: followQuestion.text,
              answer: value,
            },
          ],
        },
      });
    } else updateAnswer(mainQuestion.field, value);
  };
  const completeInk = () => {
    if (motion === "writing") {
      setInkCount(1000);
      setMotion("idle");
    }
  };
  const waiting =
    followUpsPending || draft.phase === "ready" || draft.phase === "preview";
  const disabled = motion === "dipping" || compileMutation.isPending;

  return (
    <CreationDesk
      motion={motion}
      penPoint={penPoint}
      onPaperClick={completeInk}
    >
      {waiting ? (
        <section className="creation-ready" aria-live="polite">
          <h2>
            {compileMutation.isPending
              ? `正在写成${subject}的故事…`
              : followUpsPending
                ? "再想一想，还有什么细节…"
                : "那些片段，已经留在纸上。"}
          </h2>
          <p>
            {compileMutation.isPending
              ? "名字、性格与生活，正慢慢连成一个人。"
              : followUpsPending
                ? "也可以先写到这里。"
                : "读一读这份描绘，再开始你们的第一次相遇。"}
          </p>
          {compileMutation.isPending || followUpsPending ? (
            <span className="creation-waiting-ink" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
          ) : null}
          {compileMutation.isError ? (
            <ErrorBlock error={compileMutation.error} />
          ) : null}
          {fieldError ? (
            <p className="creation-field-error" role="alert">
              {fieldError}
            </p>
          ) : null}
          {compileMutation.error instanceof ApiError &&
          compileMutation.error.status === 409 &&
          draft.characterId ? (
            <button
              className="creation-text-button"
              onClick={() =>
                void navigate(`/characters/${draft.characterId}/preview`)
              }
            >
              查看最新的小传
            </button>
          ) : null}
          <div className="creation-actions">
            {!compileMutation.isPending ? (
              <button
                className="creation-button creation-button--secondary"
                onClick={backward}
              >
                回去看看
              </button>
            ) : null}
            {followUpsPending ? (
              <button className="creation-button" onClick={skipRemaining}>
                先写到这里
              </button>
            ) : (
              <button
                className="creation-button"
                disabled={
                  compileMutation.isPending || draft.phase === "preview"
                }
                onClick={generate}
                data-testid="generate-character"
              >
                {compileMutation.isPending ? "正在整理…" : "读一读人物小传"}
              </button>
            )}
          </div>
        </section>
      ) : (
        <form
          className="creation-question-form"
          onSubmit={forward}
          data-testid="character-generator"
          data-question={isFollowUp ? "follow-up" : mainQuestion.field}
          noValidate
        >
          <h2
            ref={questionRef}
            className="creation-question"
            aria-label={questionText}
            onClick={completeInk}
          >
            <span aria-hidden="true">
              {questionLetters.map((letter, index) => (
                <span
                  className="creation-ink-letter"
                  data-letter={index}
                  key={`${questionText}-${index}`}
                  style={{
                    opacity: motion !== "writing" || index < inkCount ? 1 : 0,
                  }}
                >
                  {letter}
                </span>
              ))}
            </span>
          </h2>
          <div className="creation-answer-area" onFocus={completeInk}>
            {!isFollowUp && mainQuestion.field === "gender" ? (
              <>
                <div
                  className="creation-gender"
                  role="radiogroup"
                  aria-label={questionText}
                  aria-required="true"
                >
                  {["女性", "男性", "自定义"].map((gender) => (
                    <button
                      type="button"
                      role="radio"
                      aria-checked={
                        gender === "自定义"
                          ? customGender
                          : !customGender && value === gender
                      }
                      className="creation-gender-option"
                      key={gender}
                      disabled={disabled}
                      onClick={() => {
                        setCustomGender(gender === "自定义");
                        updateAnswer(
                          "gender",
                          gender === "自定义" ? "" : gender,
                        );
                      }}
                    >
                      {gender}
                    </button>
                  ))}
                </div>
                {customGender ? (
                  <input
                    ref={(node) => {
                      inputRef.current = node;
                    }}
                    className="creation-answer"
                    aria-label="自定义性别"
                    required
                    maxLength={120}
                    value={value}
                    placeholder={mainQuestion.placeholder}
                    onChange={(event) => updateCurrent(event.target.value)}
                    disabled={disabled}
                    onKeyDown={(event) => {
                      if (
                        event.key === "Enter" &&
                        event.nativeEvent.isComposing
                      )
                        event.preventDefault();
                    }}
                  />
                ) : null}
              </>
            ) : (
              <>
                <label className="sr-only" htmlFor="interview-answer">
                  {questionText}
                </label>
                {isFollowUp || mainQuestion.multiline ? (
                  <textarea
                    ref={(node) => {
                      inputRef.current = node;
                    }}
                    id="interview-answer"
                    className="creation-answer creation-answer--long"
                    rows={3}
                    required={!isFollowUp && mainQuestion.required}
                    value={value}
                    maxLength={isFollowUp ? 1000 : mainQuestion.maxLength}
                    placeholder={
                      isFollowUp
                        ? "写下你想到的，也可以暂时略过……"
                        : mainQuestion.placeholder
                    }
                    onChange={(event) => updateCurrent(event.target.value)}
                    onKeyDown={(event) => {
                      if (
                        event.key === "Enter" &&
                        (event.ctrlKey || event.metaKey) &&
                        !event.nativeEvent.isComposing
                      )
                        forward(event);
                    }}
                    disabled={disabled}
                    aria-describedby={
                      fieldError ? "creation-field-error" : undefined
                    }
                  />
                ) : (
                  <input
                    ref={(node) => {
                      inputRef.current = node;
                    }}
                    id="interview-answer"
                    className="creation-answer"
                    autoComplete="off"
                    value={value}
                    maxLength={mainQuestion.maxLength}
                    placeholder={mainQuestion.placeholder}
                    required={mainQuestion.required}
                    onChange={(event) => updateCurrent(event.target.value)}
                    onKeyDown={(event) => {
                      if (
                        event.key === "Enter" &&
                        event.nativeEvent.isComposing
                      )
                        event.preventDefault();
                    }}
                    disabled={disabled}
                    aria-describedby={
                      fieldError ? "creation-field-error" : undefined
                    }
                    data-testid={
                      mainQuestion.field === "name"
                        ? "character-name"
                        : undefined
                    }
                  />
                )}
              </>
            )}
          </div>
          {fieldError ? (
            <p
              id="creation-field-error"
              className="creation-field-error"
              role="alert"
            >
              {fieldError}
            </p>
          ) : null}
          <div className="creation-actions">
            <button
              type="button"
              className="creation-button creation-button--secondary"
              disabled={disabled || (!isFollowUp && draft.step === 0)}
              onClick={backward}
            >
              上一问
            </button>
            <button
              type="submit"
              className="creation-button"
              disabled={disabled}
              data-testid="interview-next"
            >
              写好了
            </button>
          </div>
          <div className="creation-question-footer">
            {!mainQuestion.required || isFollowUp ? (
              <button
                type="button"
                className="creation-text-button"
                disabled={disabled}
                onClick={() => forward(undefined, true)}
              >
                暂时略过
              </button>
            ) : (
              <span />
            )}
            {isFollowUp ? (
              <button
                type="button"
                className="creation-text-button"
                disabled={disabled}
                onClick={skipRemaining}
              >
                先写到这里
              </button>
            ) : null}
          </div>
        </form>
      )}
      {storageFailed ? (
        <p className="creation-field-error" role="status">
          浏览器暂时无法保存进度，请留在这一页完成描绘。
        </p>
      ) : null}
      {!compileMutation.isPending && !followUpsPending ? (
        <div className="creation-restart">
          {restartOpen ? (
            <div role="group" aria-label="重新描绘确认">
              <span>开启一张新的信纸？</span>
              <button
                className="creation-text-button"
                onClick={() => {
                  requestEpoch.current++;
                  clearTimeout(turnTimer.current);
                  turnInFlight.current = false;
                  commit(newInterviewDraft());
                  setCustomGender(false);
                  setRestartOpen(false);
                  setFieldError("");
                  compileMutation.reset();
                  setInkCount(0);
                  setMotion(reduced ? "idle" : "writing");
                }}
              >
                重新描绘
              </button>
              <button
                className="creation-text-button"
                onClick={() => setRestartOpen(false)}
              >
                继续这一份
              </button>
            </div>
          ) : (
            <button
              className="creation-text-button"
              onClick={() => setRestartOpen(true)}
            >
              重新描绘
            </button>
          )}
        </div>
      ) : null}
    </CreationDesk>
  );
}
