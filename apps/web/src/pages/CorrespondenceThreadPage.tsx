import { ArrowLeft, Mail, PenLine, Send } from "lucide-react";
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { api, unwrapCharacter } from "../api/client";
import { ErrorBlock, LoadingBlock } from "../components/Feedback";
import {
  correspondenceQueryKeys,
  composeAvailability,
  findThreadLetters,
  formatCorrespondenceDate,
  statusLabel,
} from "../lib/correspondence";
import {
  readActiveCharacter,
  rememberActiveCharacter,
} from "../lib/activeCharacter";

export default function CorrespondenceThreadPage() {
  const { threadId = "" } = useParams();
  const [searchParams] = useSearchParams();
  const agentId = searchParams.get("agentId") ?? readActiveCharacter() ?? "";
  useEffect(() => {
    if (agentId) rememberActiveCharacter(agentId);
  }, [agentId]);
  const mailboxQuery = useQuery({
    queryKey: correspondenceQueryKeys.mailbox(agentId),
    queryFn: () => api.correspondence.list(agentId),
    enabled: Boolean(agentId),
  });
  const characterQuery = useQuery({
    queryKey: ["character", agentId],
    queryFn: () => api.characters.get(agentId),
    enabled: Boolean(agentId),
  });
  const character = characterQuery.data
    ? unwrapCharacter(characterQuery.data)
    : undefined;
  const correspondent = character?.identity.name ?? "角色";
  const thread = mailboxQuery.data?.threads.find(
    (item) => item.id === threadId,
  );
  const letters = mailboxQuery.data
    ? findThreadLetters(mailboxQuery.data, threadId)
    : [];
  const compose = composeAvailability(mailboxQuery.data);

  if (mailboxQuery.isPending || characterQuery.isPending) {
    return <LoadingBlock label="正在整理往来…" fullPage />;
  }
  const error = mailboxQuery.error ?? characterQuery.error;
  if (error) return <ErrorBlock error={error} />;

  const mailboxHref = agentId
    ? `/characters/${agentId}/correspondence`
    : "/characters";

  return (
    <div className="thread-page">
      <header className="thread-page__header">
        <Link className="correspondence-back-link" to={mailboxHref}>
          <ArrowLeft size={18} aria-hidden="true" /> 返回书信
        </Link>
        <div>
          <h1>与 {correspondent} 的往来</h1>
          <p>
            {thread?.status === "closed"
              ? "这段往来已归档"
              : "一来一回，等待彼此的时间"}
          </p>
        </div>
        {agentId && thread?.status === "open" && compose.kind !== "waiting" ? (
          <Link
            className="button button--primary"
            to={`/characters/${agentId}/correspondence/compose${
              compose.kind === "edit"
                ? `?draftId=${encodeURIComponent(compose.draftId)}`
                : ""
            }`}
          >
            <PenLine size={16} aria-hidden="true" /> 写下一封信
          </Link>
        ) : null}
      </header>

      <main className="thread-exchanges">
        {letters.map((letter) => {
          const incoming = letter.direction === "agent_to_user";
          const Icon = incoming ? Mail : Send;
          return (
            <article
              className={`thread-turn thread-turn--${incoming ? "incoming" : "outgoing"}`}
              key={letter.id}
            >
              <span className="thread-turn__node" aria-hidden="true">
                <Icon size={18} />
              </span>
              <div className="thread-turn__paper">
                <header>
                  <div>
                    <strong>{incoming ? correspondent : "你"}</strong>
                    <time>
                      {formatCorrespondenceDate(letter.authoredDisplayDate)}
                    </time>
                  </div>
                  <span
                    className={`letter-status letter-status--${letter.status}`}
                  >
                    {statusLabel(letter.status, letter.direction)}
                  </span>
                </header>
                {letter.previewText ? (
                  <p>{letter.previewText}</p>
                ) : (
                  <p className="thread-turn__private">
                    {incoming && letter.status !== "read"
                      ? "这封回信尚未启封。"
                      : "打开信件查看正文。"}
                  </p>
                )}
                <Link
                  className="text-button"
                  to={`/letters/${letter.id}?agentId=${encodeURIComponent(agentId)}`}
                >
                  {letter.canOpen ? "启封阅读" : "查看信件"}
                </Link>
              </div>
            </article>
          );
        })}

        {letters.length === 0 ? (
          <div className="thread-page__empty">
            <h2>这段往来尚无信件</h2>
            <Link className="button button--primary" to={mailboxHref}>
              返回书信
            </Link>
          </div>
        ) : null}
      </main>
    </div>
  );
}
