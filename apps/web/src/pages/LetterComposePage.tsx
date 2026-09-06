import { AlertCircle, ArrowLeft, Feather, Leaf } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DateTime } from "luxon";
import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { api, unwrapCharacter } from "../api/client";
import {
  LetterPaper,
  PaperSelector,
  type PaperTemplate,
} from "../components/correspondence/CorrespondencePrimitives";
import { EmptyState, ErrorBlock, LoadingBlock } from "../components/Feedback";
import {
  arrivalEstimateLabel,
  correspondenceQueryKeys,
  isCachedUserLetterDetail,
} from "../lib/correspondence";
import { rememberActiveCharacter } from "../lib/activeCharacter";
import { persistThenSealLetter } from "../lib/correspondenceMutations";

export default function LetterComposePage() {
  const { characterId = "" } = useParams();
  const [searchParams] = useSearchParams();
  const draftId = searchParams.get("draftId") ?? undefined;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [paper, setPaper] = useState<PaperTemplate>("cotton");
  const [confirmingSeal, setConfirmingSeal] = useState(false);
  const initializedDraft = useRef<string | undefined>(undefined);
  const confirmButtonRef = useRef<HTMLButtonElement>(null);
  const sealTriggerRef = useRef<HTMLButtonElement>(null);
  const sealDialogRef = useRef<HTMLElement>(null);
  const sealPendingRef = useRef(false);
  const createRequestId = useRef(makeClientRequestId("letter-create"));
  const sealRequestId = useRef(makeClientRequestId("letter-seal"));

  useEffect(() => {
    if (characterId) rememberActiveCharacter(characterId);
  }, [characterId]);

  const characterQuery = useQuery({
    queryKey: ["character", characterId],
    queryFn: () => api.characters.get(characterId),
    enabled: Boolean(characterId),
  });
  const settingsQuery = useQuery({
    queryKey: ["settings"],
    queryFn: api.settings.get,
  });
  const canCompose = settingsQuery.data?.correspondenceMode === "enforced";
  const mailboxQuery = useQuery({
    queryKey: correspondenceQueryKeys.mailbox(characterId),
    queryFn: () => api.correspondence.list(characterId),
    enabled: Boolean(characterId) && canCompose,
  });
  const draftQuery = useQuery({
    queryKey: correspondenceQueryKeys.letter(draftId ?? ""),
    queryFn: () => api.letters.getCacheSafe(draftId!),
    enabled: Boolean(draftId) && canCompose,
  });
  const character = characterQuery.data
    ? unwrapCharacter(characterQuery.data)
    : undefined;

  useEffect(() => {
    if (!draftId || !draftQuery.data || initializedDraft.current === draftId) {
      return;
    }
    if (!isCachedUserLetterDetail(draftQuery.data)) return;
    initializedDraft.current = draftId;
    setSubject(draftQuery.data.subject ?? "");
    setBody(draftQuery.data.body);
  }, [draftId, draftQuery.data]);

  const invalidateAfterWrite = async (letterId: string) => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: correspondenceQueryKeys.mailbox(characterId),
      }),
      queryClient.invalidateQueries({
        queryKey: correspondenceQueryKeys.letter(letterId),
      }),
      queryClient.invalidateQueries({
        queryKey: ["agent", characterId, "timeline"],
      }),
    ]);
  };

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (draftId) {
        return api.letters.updateDraft(draftId, {
          subject: subject.trim() || null,
          body,
        });
      }
      return api.letters.createDraft(characterId, {
        clientRequestId: createRequestId.current,
        ...(subject.trim() ? { subject: subject.trim() } : {}),
        body,
      });
    },
    onSuccess: async (detail) => {
      await invalidateAfterWrite(detail.letter.id);
      if (!draftId) {
        void navigate(
          `/characters/${characterId}/correspondence/compose?draftId=${encodeURIComponent(detail.letter.id)}`,
          { replace: true },
        );
      }
    },
  });

  const sealMutation = useMutation({
    mutationFn: () =>
      persistThenSealLetter({
        persistDraft: () =>
          draftId
            ? api.letters.updateDraft(draftId, {
                subject: subject.trim() || null,
                body,
              })
            : api.letters.createDraft(characterId, {
                clientRequestId: createRequestId.current,
                ...(subject.trim() ? { subject: subject.trim() } : {}),
                body,
              }),
        sealDraft: (letterId) =>
          api.letters.seal(letterId, {
            clientRequestId: sealRequestId.current,
          }),
      }),
    onSuccess: async (detail) => {
      await invalidateAfterWrite(detail.letter.id);
      void navigate(
        `/letters/${detail.letter.id}?agentId=${encodeURIComponent(characterId)}`,
      );
    },
  });

  const error =
    settingsQuery.error ??
    characterQuery.error ??
    mailboxQuery.error ??
    draftQuery.error ??
    saveMutation.error ??
    sealMutation.error;
  const isBusy = saveMutation.isPending || sealMutation.isPending;
  sealPendingRef.current = isBusy;
  const isValid = body.trim().length > 0 && body.length <= 50_000;
  const recipient = character?.identity.name ?? "角色";
  const timezone = character?.identity.timezone ?? "Asia/Shanghai";

  useEffect(() => {
    if (!confirmingSeal) return;
    const previouslyFocused = document.activeElement;
    confirmButtonRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !sealPendingRef.current) {
        event.preventDefault();
        setConfirmingSeal(false);
        return;
      }
      if (event.key !== "Tab") return;
      const buttons = Array.from(
        sealDialogRef.current?.querySelectorAll<HTMLButtonElement>(
          "button:not(:disabled)",
        ) ?? [],
      );
      const first = buttons[0];
      const last = buttons.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
    };
  }, [confirmingSeal]);

  if (
    settingsQuery.isPending ||
    characterQuery.isPending ||
    (canCompose && draftId && draftQuery.isPending)
  ) {
    return <LoadingBlock label="正在铺开信纸…" fullPage />;
  }

  if (settingsQuery.isError) {
    return <ErrorBlock error={settingsQuery.error} />;
  }

  if (!canCompose) {
    return (
      <div className="correspondence-page">
        <Link
          className="correspondence-back-link"
          to={`/characters/${characterId}/correspondence`}
        >
          <ArrowLeft size={18} aria-hidden="true" /> 返回书信
        </Link>
        <EmptyState
          title="书信当前为只读模式"
          description="off 与 shadow 模式不会开放写信控件；已有书信仍可在邮箱中阅读。"
        />
      </div>
    );
  }

  return (
    <div className="compose-page">
      <header className="compose-header">
        <Link
          className="correspondence-back-link"
          to={`/characters/${characterId}/correspondence`}
        >
          <ArrowLeft size={18} aria-hidden="true" /> 返回书信
        </Link>
      </header>

      <main className="compose-layout">
        <section className="compose-form-panel" aria-labelledby="compose-title">
          <h1 id="compose-title">写一封信</h1>
          <p className="compose-recipient">
            写给 <strong>{recipient}</strong>
          </p>

          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (isValid) setConfirmingSeal(true);
            }}
          >
            <label className="correspondence-field">
              <span>主题（可选）</span>
              <input
                value={subject}
                maxLength={240}
                onChange={(event) => setSubject(event.target.value)}
                placeholder="输入主题（可选）"
              />
            </label>
            <label className="correspondence-field">
              <span>正文</span>
              <textarea
                value={body}
                maxLength={50_000}
                rows={14}
                required
                aria-describedby="letter-body-count"
                onChange={(event) => setBody(event.target.value)}
              />
            </label>
            <p id="letter-body-count" className="compose-character-count">
              {body.length} / 50000
            </p>
            <PaperSelector value={paper} onChange={setPaper} />

            {error ? <ErrorBlock error={error} /> : null}

            <div className="compose-assurances">
              <span>
                <AlertCircle size={17} aria-hidden="true" />
                封缄后将无法修改
              </span>
              <span>
                <Leaf size={16} aria-hidden="true" />
                预计五天后抵达
              </span>
            </div>
            <div className="compose-actions">
              <button
                className="button button--ghost"
                type="button"
                disabled={!isValid || isBusy}
                onClick={() => saveMutation.mutate()}
              >
                {saveMutation.isPending ? "正在保存…" : "保存草稿"}
              </button>
              <button
                ref={sealTriggerRef}
                className="button button--primary"
                type="submit"
                disabled={!isValid || isBusy}
              >
                <Feather size={17} aria-hidden="true" />
                确认封缄并寄出
              </button>
            </div>
          </form>
        </section>

        <section className="compose-preview" aria-label="信纸预览">
          <LetterPaper
            paper={paper}
            {...(subject.trim() ? { subject: subject.trim() } : {})}
            body={body || "你的文字会在这里呈现。"}
            recipient={recipient}
          />
        </section>
      </main>

      {confirmingSeal ? (
        <div
          className="seal-dialog-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (
              event.target === event.currentTarget &&
              !sealMutation.isPending
            ) {
              setConfirmingSeal(false);
            }
          }}
        >
          <section
            ref={sealDialogRef}
            className="seal-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="seal-dialog-title"
            aria-describedby="seal-dialog-description"
          >
            <span className="seal-dialog__mark" aria-hidden="true">
              <Feather size={22} />
            </span>
            <h2 id="seal-dialog-title">确认封缄</h2>
            <p id="seal-dialog-description">
              封缄后将无法修改。这封信预计于
              {arrivalEstimateLabel(
                timezone,
                mailboxQuery.data?.serverTimeUtc
                  ? DateTime.fromISO(mailboxQuery.data.serverTimeUtc, {
                      zone: "utc",
                    })
                  : DateTime.utc(),
              )}
              抵达 {recipient}。
            </p>
            <div className="seal-dialog__actions">
              <button
                className="button button--ghost"
                type="button"
                aria-disabled={sealMutation.isPending}
                onClick={() => {
                  if (!sealMutation.isPending) setConfirmingSeal(false);
                }}
              >
                再检查一下
              </button>
              <button
                ref={confirmButtonRef}
                className="button button--primary"
                type="button"
                aria-disabled={sealMutation.isPending}
                onClick={() => {
                  if (!sealMutation.isPending) sealMutation.mutate();
                }}
              >
                {sealMutation.isPending ? "正在封缄…" : "确认封缄并寄出"}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}

function makeClientRequestId(prefix: string): string {
  const value =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}:${value}`;
}
