import { useMutation, useQuery } from "@tanstack/react-query";
import { LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { ErrorBlock } from "../components/Feedback";
import {
  chatHref,
  readLastConversation,
  rememberLastConversation,
  validateLastConversation,
} from "../lib/lastConversation";

export default function WelcomePage() {
  const navigate = useNavigate();
  const [candidate] = useState(readLastConversation);
  const resume = useQuery({
    queryKey: [
      "last-conversation",
      candidate?.characterId,
      candidate?.sessionId,
    ],
    queryFn: async () => (await validateLastConversation(candidate)) ?? null,
    enabled: Boolean(candidate),
    staleTime: 0,
    retry: 1,
  });
  const demo = useMutation({
    mutationFn: api.demo.ensure,
    onSuccess: ({ characterId, sessionId }) => {
      rememberLastConversation(characterId, sessionId);
      void navigate(chatHref(characterId, sessionId));
    },
  });
  useEffect(() => {
    document.title = "欢迎来到 Dearvale";
  }, []);
  const checking = Boolean(candidate) && resume.isPending;
  const pending = checking || demo.isPending;
  const enter = () => {
    if (resume.data) {
      rememberLastConversation(resume.data.characterId, resume.data.sessionId);
      void navigate(chatHref(resume.data.characterId, resume.data.sessionId));
    } else if (resume.isError) {
      void resume.refetch();
    } else demo.mutate();
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
            {checking
              ? "正在找回上次的对话…"
              : demo.isPending
                ? "正在准备相遇…"
                : resume.isError
                  ? "重新连接"
                  : resume.data
                    ? "继续上次的对话"
                    : "先聊一会儿"}
          </button>
          <p className="welcome-hint">
            {resume.data
              ? "那些没说完的话，还在这里等你。"
              : "使用示例角色，开始一段对话"}
          </p>
          <div className="welcome-secondary">
            <Link to="/create">创建新角色</Link>
            <Link to="/import">导入角色</Link>
          </div>
          {demo.isError || resume.isError ? (
            <ErrorBlock error={demo.error ?? resume.error} />
          ) : null}
          <Link className="welcome-later" to="/characters">
            稍后再说
          </Link>
        </div>
      </main>
    </div>
  );
}
