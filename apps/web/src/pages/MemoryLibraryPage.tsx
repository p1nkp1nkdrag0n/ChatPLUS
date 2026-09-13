import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen, PenLine, X } from "lucide-react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { api } from "../api/client";
import {
  diariesApi,
  diaryQueryKeys,
  type DiaryEntry,
  type DiaryVolume,
} from "../api/diaries";
import { ErrorBlock, LoadingBlock } from "../components/Feedback";
import { DiaryBook } from "../components/memory-library/DiaryBook";
import { DiaryComposer } from "../components/memory-library/DiaryComposer";
import { LibraryShelf } from "../components/memory-library/LibraryShelf";
import { volumeKey } from "../components/memory-library/pagination";
import { useMobileBookStage } from "../components/memory-library/useMobileBookStage";
import "../styles/memory-library.css";
import "../styles/memory-library-mobile.css";

export default function MemoryLibraryPage() {
  const { characterId } = useParams();
  const [params] = useSearchParams();
  return (
    <MemoryLibrary
      key={characterId ?? "all"}
      initialAgentId={characterId ?? ""}
      composeRequested={params.get("compose") === "1"}
    />
  );
}

function MemoryLibrary({
  initialAgentId,
  composeRequested,
}: {
  initialAgentId: string;
  composeRequested: boolean;
}) {
  const queryClient = useQueryClient();
  const rootRef = useRef<HTMLDivElement>(null);
  const roleRef = useRef<HTMLSelectElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const [role, setRole] = useState(initialAgentId);
  const [year, setYear] = useState("");
  const [month, setMonth] = useState("");
  const [composerOpen, setComposerOpen] = useState(composeRequested);
  const [rewrite, setRewrite] = useState<DiaryEntry | undefined>();
  const [selected, setSelected] = useState<{
    volume: DiaryVolume;
    sourceRect: DOMRect;
  } | null>(null);
  const phoneMode = useMobileBookStage(selected !== null, rootRef);
  const charactersQuery = useQuery({
    queryKey: ["characters"],
    queryFn: api.characters.list,
  });
  const volumesQuery = useQuery({
    queryKey: diaryQueryKeys.volumes(),
    queryFn: () => diariesApi.volumes(),
  });
  const characters = charactersQuery.data?.characters ?? [];
  const volumes = volumesQuery.data?.volumes ?? [];
  const selectedKey = selected
    ? volumeKey(selected.volume.agentId, selected.volume.month)
    : undefined;
  const visible = volumes.filter(
    (volume) =>
      (!role || volume.agentId === role) &&
      (!year || volume.month.startsWith(`${year}-`)) &&
      (!month || volume.month.slice(5) === month),
  );
  const years = [...new Set(volumes.map((volume) => volume.month.slice(0, 4)))]
    .sort()
    .reverse();
  const roleOptions = new Map(
    characters.map((character) => [character.id, character.name]),
  );
  for (const volume of volumes)
    roleOptions.set(volume.agentId, volume.characterName);
  if (initialAgentId && !roleOptions.has(initialAgentId))
    roleOptions.set(initialAgentId, "当前角色");
  useEffect(() => {
    if (composeRequested) setComposerOpen(true);
  }, [composeRequested]);

  const alignLibraryTop = () => {
    const library = rootRef.current;
    const scroller = library?.closest<HTMLElement>(".app-main");
    if (
      library &&
      scroller &&
      window.matchMedia("(min-width: 701px)").matches
    ) {
      const offset =
        library.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top -
        scroller.clientTop;
      if (offset < 0) {
        scroller.scrollTo({
          top: Math.max(0, scroller.scrollTop + offset),
          behavior: "instant",
        });
      }
    }
  };

  const findSource = () =>
    [
      ...(rootRef.current?.querySelectorAll<HTMLButtonElement>(
        "[data-volume]",
      ) ?? []),
    ].find((button) => button.dataset.volume === selectedKey);
  const returnToShelf = () => {
    const source = findSource();
    setSelected(null);
    requestAnimationFrame(() =>
      (source?.isConnected ? source : roleRef.current)?.focus({
        preventScroll: true,
      }),
    );
  };
  const rewriteEntry = (entry: DiaryEntry) => {
    setSelected(null);
    setRole(entry.agentId);
    setRewrite(entry);
    setComposerOpen(true);
    requestAnimationFrame(() => {
      composerRef.current?.scrollIntoView({ block: "nearest" });
      composerRef.current
        ?.querySelector<HTMLElement>("select")
        ?.focus({ preventScroll: true });
    });
  };

  return (
    <div
      className="memory-library"
      ref={rootRef}
      data-book-active={selected !== null}
    >
      <header className="ml-header">
        <div>
          <h1>记忆档案室</h1>
          <small>THE DAYS WE KEEP</small>
        </div>
        <button
          type="button"
          className="ml-primary"
          disabled={
            selected !== null ||
            charactersQuery.isPending ||
            characters.length === 0
          }
          aria-expanded={composerOpen}
          aria-controls="diary-composer"
          onClick={() => {
            setRewrite(undefined);
            setComposerOpen(!composerOpen);
          }}
        >
          <PenLine size={17} aria-hidden="true" />
          写进日记
        </button>
      </header>
      <div
        inert={selected !== null}
        aria-hidden={selected !== null ? true : undefined}
      >
        {composerOpen ? (
          <div
            className="ml-composer-wrap"
            id="diary-composer"
            ref={composerRef}
          >
            <button
              type="button"
              className="ml-composer-close"
              onClick={() => setComposerOpen(false)}
              aria-label="收起写日记"
            >
              <X size={17} aria-hidden="true" />
            </button>
            {charactersQuery.isError ? (
              <ErrorBlock
                error={charactersQuery.error}
                action={
                  <button
                    type="button"
                    className="ml-plain"
                    onClick={() => void charactersQuery.refetch()}
                  >
                    重新读取角色
                  </button>
                }
              />
            ) : charactersQuery.isPending ? (
              <LoadingBlock label="正在读取角色…" />
            ) : (
              <DiaryComposer
                key={rewrite?.id ?? "new"}
                characters={characters.filter(
                  (character) => character.status !== "draft",
                )}
                initialAgentId={
                  role ||
                  characters.find((character) => character.status !== "draft")
                    ?.id ||
                  ""
                }
                {...(rewrite ? { initialEntry: rewrite } : {})}
                onGenerated={(entry) => {
                  setRole(entry.agentId);
                  setYear(entry.entryDate.slice(0, 4));
                  setMonth(entry.entryDate.slice(5, 7));
                }}
              />
            )}
          </div>
        ) : null}
      </div>
      <div className="ml-views">
        <section
          className={`ml-shelf-view${selected ? " is-background" : ""}`}
          aria-label="按角色与月份找手记"
          aria-hidden={selected !== null ? true : undefined}
          inert={selected !== null}
        >
          <div className="ml-filters">
            <label>
              角色
              <select
                value={role}
                ref={roleRef}
                onChange={(event) => setRole(event.target.value)}
                aria-label="按角色筛选"
              >
                <option value="">所有角色</option>
                {[...roleOptions.entries()].map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              年份
              <select
                value={year}
                onChange={(event) => setYear(event.target.value)}
                aria-label="按年份筛选"
              >
                <option value="">所有年份</option>
                {years.map((value) => (
                  <option key={value} value={value}>
                    {value} 年
                  </option>
                ))}
              </select>
            </label>
            <label>
              月份
              <select
                value={month}
                onChange={(event) => setMonth(event.target.value)}
                aria-label="按月份筛选"
              >
                <option value="">全年</option>
                {Array.from({ length: 12 }, (_, i) => (
                  <option key={i} value={String(i + 1).padStart(2, "0")}>
                    {i + 1} 月
                  </option>
                ))}
              </select>
            </label>
            {volumesQuery.isFetching && !volumesQuery.isPending ? (
              <span className="ml-refreshing" role="status">
                正在更新书架…
              </span>
            ) : null}
          </div>
          {volumesQuery.isPending ? (
            <LoadingBlock label="正在整理书架…" />
          ) : volumesQuery.isError ? (
            <ErrorBlock
              error={volumesQuery.error}
              action={
                <button
                  type="button"
                  className="ml-plain"
                  onClick={() => void volumesQuery.refetch()}
                >
                  重新读取书架
                </button>
              }
            />
          ) : visible.length ? (
            <LibraryShelf
              volumes={visible}
              phoneMode={phoneMode}
              {...(selectedKey ? { selectedKey } : {})}
              onSelect={(volume, button) => {
                if (selected) return;
                alignLibraryTop();
                void queryClient.prefetchQuery({
                  queryKey: diaryQueryKeys.entries(
                    volume.agentId,
                    volume.month,
                  ),
                  queryFn: () =>
                    diariesApi.entries(volume.agentId, volume.month),
                  staleTime: 15_000,
                });
                setSelected({
                  volume,
                  sourceRect: button.getBoundingClientRect(),
                });
              }}
            />
          ) : (
            <div className="ml-empty">
              <BookOpen size={30} strokeWidth={1.2} aria-hidden="true" />
              <h2>
                {volumes.length
                  ? "这个时间里，还没有收录手记"
                  : "书架上的第一本，等一个说过话的日子"}
              </h2>
              <p>选一位角色和一天聊天，让这些片刻成为这个月的一册手记。</p>
              {charactersQuery.isPending ? (
                <LoadingBlock label="正在读取角色…" />
              ) : charactersQuery.isError ? (
                <ErrorBlock
                  error={charactersQuery.error}
                  action={
                    <button
                      type="button"
                      className="ml-plain"
                      onClick={() => void charactersQuery.refetch()}
                    >
                      重新读取角色
                    </button>
                  }
                />
              ) : characters.length ? (
                <button
                  type="button"
                  className="ml-primary"
                  onClick={() => {
                    setComposerOpen(true);
                    requestAnimationFrame(() =>
                      composerRef.current?.scrollIntoView({ block: "nearest" }),
                    );
                  }}
                >
                  <PenLine size={16} aria-hidden="true" />
                  写下一篇手记
                </button>
              ) : (
                <Link className="ml-primary" to="/characters">
                  去认识一位角色
                </Link>
              )}
            </div>
          )}
          {visible.length > 0 ? (
            <p className="ml-footnote" role="status">
              <span className="ml-hint-desktop">
                {visible.length} 本月度手记 · 点击书脊，取出一册。
              </span>
              <span className="ml-hint-mobile">
                {visible.length} 本月度手记 · 左右滑动书架，轻触书脊取书。
              </span>
            </p>
          ) : null}
        </section>
        {selected ? (
          <DiaryBook
            key={selectedKey}
            volume={selected.volume}
            phoneMode={phoneMode}
            sourceRect={selected.sourceRect}
            getSource={findSource}
            onAlignViewport={alignLibraryTop}
            onReturn={returnToShelf}
            onRewrite={rewriteEntry}
          />
        ) : null}
      </div>
    </div>
  );
}
