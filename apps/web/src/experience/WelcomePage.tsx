import { ArrowRight } from "lucide-react";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api, unwrapList } from "../api/client";
import type { CharacterSummary } from "../api/types";
import {
  clearActiveCharacter,
  readActiveCharacter,
} from "../lib/activeCharacter";
import { selectAvailableCharacter } from "./entryPreferences";
import { RouteTransition } from "./RouteTransition";
import "./experience.css";

export default function WelcomePage() {
  const [activeCharacterId] = useState(readActiveCharacter);
  const query = useQuery({
    queryKey: ["characters"],
    queryFn: api.characters.list,
    refetchOnMount: "always",
  });
  const characters = query.data
    ? unwrapList<CharacterSummary>(query.data, "characters")
    : [];
  const isCheckingCharacters = query.isPending || query.isFetching;
  const character =
    query.isSuccess && !isCheckingCharacters
      ? selectAvailableCharacter(characters, activeCharacterId)
      : undefined;
  const invalidActiveCharacter = Boolean(
    query.isSuccess &&
    !isCheckingCharacters &&
    activeCharacterId &&
    !characters.some(
      (entry) => entry.id === activeCharacterId && entry.status === "published",
    ),
  );
  useEffect(() => {
    if (invalidActiveCharacter) clearActiveCharacter();
  }, [invalidActiveCharacter]);

  return (
    <RouteTransition title="ChatPLUS · 欢迎来到故事里">
      <main className="welcome-page">
        <header className="experience-header">
          <Link
            className="experience-brand"
            to="/about"
            aria-label="ChatPLUS 产品介绍"
          >
            ChatPLUS
          </Link>
          <Link className="experience-text-link" to="/start">
            使用说明
          </Link>
        </header>
        <div
          className="welcome-botanical welcome-botanical--left"
          aria-hidden="true"
        />
        <div
          className="welcome-botanical welcome-botanical--right"
          aria-hidden="true"
        />
        <section className="welcome-content" aria-labelledby="welcome-title">
          <div className="welcome-letter" aria-hidden="true">
            <div className="welcome-letter__paper" />
            <div className="welcome-letter__fold" />
            <span className="welcome-letter__flower" />
          </div>
          <h1 id="welcome-title" tabIndex={-1}>
            欢迎来到 ChatPLUS
          </h1>
          <p className="welcome-description">
            在这里，文字会被好好记住，
            <br />
            故事会慢慢生长。
          </p>
          <div className="welcome-actions">
            {character ? (
              <Link
                className="experience-button experience-button--primary"
                to={`/characters/${encodeURIComponent(character.id)}/chat`}
              >
                <span>
                  先聊一会儿 <small>与 {character.name}</small>
                </span>
                <ArrowRight size={17} aria-hidden="true" />
              </Link>
            ) : (
              <Link
                className="experience-button experience-button--primary"
                to="/characters"
              >
                进入角色列表 <ArrowRight size={17} aria-hidden="true" />
              </Link>
            )}
            <div className="welcome-actions__secondary">
              <Link className="experience-button" to="/create">
                创建角色
              </Link>
              <Link className="experience-button" to="/import">
                导入角色
              </Link>
            </div>
            <div className="welcome-status" aria-live="polite">
              {isCheckingCharacters ? <p>正在看看有哪些角色可以相遇…</p> : null}
              {query.isError ? (
                <p>暂时无法读取角色。你可以进入角色列表重试。</p>
              ) : null}
              {!isCheckingCharacters && !query.isError && !character ? (
                <p>还没有可对话的角色。创建一位，或从文字中导入。</p>
              ) : null}
              {character ? (
                <p>也可以创建原创角色，或导入 .txt、.md、.srt 文字。</p>
              ) : null}
            </div>
            {character ? (
              <Link
                className="experience-text-link welcome-skip"
                to="/characters"
              >
                进入角色列表
              </Link>
            ) : null}
          </div>
          <p className="welcome-closing">愿每一次相遇，都有话可说。</p>
        </section>
      </main>
    </RouteTransition>
  );
}
