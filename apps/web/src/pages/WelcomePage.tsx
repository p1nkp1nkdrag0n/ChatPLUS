import { useQuery } from "@tanstack/react-query";
import { LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { ErrorBlock } from "../components/Feedback";
import {
  readActiveCharacter,
  rememberActiveCharacter,
} from "../lib/activeCharacter";
import { readInterviewDraft } from "../lib/characterInterview";
import {
  chatHref,
  readLastConversation,
  rememberLastConversation,
  publishedUserCharacters,
  resolveWelcomeConversation,
} from "../lib/lastConversation";

export default function WelcomePage() {
  const navigate = useNavigate();
  const [candidate] = useState(readLastConversation);
  const [activeCharacterId] = useState(readActiveCharacter);
  const [hasDraft] = useState(() => Boolean(readInterviewDraft()));
  const library = useQuery({
    queryKey: ["characters"],
    queryFn: api.characters.list,
    staleTime: 0,
    retry: 1,
  });
  const characters = publishedUserCharacters(library.data?.characters ?? []);
  const hasCharacters = characters.length > 0;
  const resume = useQuery({
    queryKey: [
      "last-conversation",
      candidate?.characterId,
      candidate?.sessionId,
      activeCharacterId,
      characters.map((character) => [character.id, character.updatedAtUtc]),
    ],
    queryFn: async () =>
      (await resolveWelcomeConversation(
        characters,
        candidate,
        activeCharacterId,
      )) ?? null,
    enabled: library.isSuccess && hasCharacters,
    staleTime: 0,
    retry: 1,
  });
  useEffect(() => {
    document.title = "欢迎来到 Dearvale";
  }, []);
  const pending =
    library.isPending ||
    library.isFetching ||
    (hasCharacters && (resume.isPending || resume.isFetching));
  const error = library.error ?? (hasCharacters ? resume.error : null);
  const enter = () => {
    if (error) {
      if (library.isError) void library.refetch();
      else void resume.refetch();
    } else if (hasCharacters && resume.data) {
      if (resume.data.sessionId) {
        rememberLastConversation(
          resume.data.characterId,
          resume.data.sessionId,
        );
      } else rememberActiveCharacter(resume.data.characterId);
      void navigate(chatHref(resume.data.characterId, resume.data.sessionId));
    } else if (!hasCharacters) void navigate("/create");
  };
  return (
    <div className="welcome-page">
      <header className="welcome-header">
        <Link to="/" className="dearvale-brand">
          Dearvale
        </Link>
        <Link to="/" className="welcome-back">
          返回官网
        </Link>
      </header>
      <img
        className="welcome-botanical welcome-botanical--top"
        src="/dearvale/art/botanical.png"
        alt=""
      />
      <img
        className="welcome-botanical welcome-botanical--bottom"
        src="/dearvale/art/botanical.png"
        alt=""
      />
      <main className="welcome-card">
        <div className="welcome-art">
          <img src="/dearvale/art/welcome.png" alt="系着花束的手绘信封" />
        </div>
        <div className="welcome-content">
          <h1>
            欢迎来到 <span>Dearvale</span>
          </h1>
          <p className="welcome-description">
            在这里，文字会被好好记住，
            <br />
            故事会慢慢生长。
          </p>
          <button
            type="button"
            className="welcome-primary"
            disabled={pending}
            onClick={enter}
          >
            {pending ? <LoaderCircle size={19} className="spin" /> : null}
            {pending
              ? "正在寻找熟悉的身影…"
              : error
                ? "重新连接"
                : hasCharacters
                  ? "继续聊天"
                  : "描述你梦中的他/她"}
          </button>
          <p className="welcome-hint">
            {error
              ? "暂时没能读到角色，重新连接后再继续。"
              : pending
                ? "请稍等，故事正在翻到上次停下的地方。"
                : hasDraft
                  ? "还有一份未完成的描绘，等你接着写。"
                  : hasCharacters
                    ? "那些没说完的话，还在这里等你。"
                    : "从一个名字开始，慢慢描绘心中的身影。"}
          </p>
          <div className="welcome-secondary">
            {hasCharacters ? <Link to="/create">描述你梦中的他/她</Link> : null}
            <Link to="/import">导入角色</Link>
          </div>
          {error ? <ErrorBlock error={error} /> : null}
          <Link className="welcome-later" to="/characters">
            稍后再说
          </Link>
        </div>
      </main>
    </div>
  );
}
