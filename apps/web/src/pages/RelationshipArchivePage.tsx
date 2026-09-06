import {
  ArrowDown,
  ArrowUp,
  ChevronRight,
  Download,
  Landmark,
} from "lucide-react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import type {
  KeepsakeSummaryResponse,
  RelationshipArchiveEntry,
  RelationshipArchiveFilter,
} from "@personasim/contracts";
import { RelationshipArchiveEntryIdSchema } from "@personasim/contracts";
import { api, unwrapCharacter } from "../api/client";
import {
  ArchiveTimeline,
  KeepsakeShelf,
  ProvenancePanel,
  SharePreviewCard,
} from "../components/archive/ArchivePrimitives";
import { EmptyState, ErrorBlock, LoadingBlock } from "../components/Feedback";
import { rememberActiveCharacter } from "../lib/activeCharacter";
import {
  ARCHIVE_FILTERS,
  groupArchiveByMonth,
  relationshipArchiveQueryKeys,
  selectRelationshipShareSources,
} from "../lib/relationshipArchive";

export default function RelationshipArchivePage() {
  const { characterId = "" } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const [filter, setFilter] = useState<RelationshipArchiveFilter>(() =>
    parseArchiveFilter(searchParams.get("filter")),
  );
  const [ascending, setAscending] = useState(false);
  const [selectedKeepsakeId, setSelectedKeepsakeId] = useState<string>();

  useEffect(() => {
    if (characterId) rememberActiveCharacter(characterId);
  }, [characterId]);

  const characterQuery = useQuery({
    queryKey: ["character", characterId],
    queryFn: () => api.characters.get(characterId),
    enabled: Boolean(characterId),
  });
  const archiveQuery = useInfiniteQuery({
    queryKey: relationshipArchiveQueryKeys.page(characterId, filter),
    queryFn: ({ pageParam }) =>
      api.relationshipArchive.list(characterId, {
        filter,
        limit: 30,
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor,
    enabled: Boolean(characterId),
  });
  const requestedEntryIdResult = RelationshipArchiveEntryIdSchema.safeParse(
    searchParams.get("entryId"),
  );
  const requestedEntryId = requestedEntryIdResult.success
    ? requestedEntryIdResult.data
    : undefined;
  const exactEntryQuery = useQuery({
    queryKey: relationshipArchiveQueryKeys.entry(
      characterId,
      requestedEntryId ?? "",
    ),
    queryFn: () =>
      api.relationshipArchive.list(characterId, {
        filter: "all",
        entryId: requestedEntryId!,
        limit: 1,
      }),
    enabled: Boolean(characterId && requestedEntryId),
  });
  const keepsakesQuery = useQuery({
    queryKey: relationshipArchiveQueryKeys.keepsakes(characterId),
    queryFn: () => api.keepsakes.list(characterId, { limit: 4 }),
    enabled: Boolean(characterId),
  });

  const character = characterQuery.data
    ? unwrapCharacter(characterQuery.data)
    : undefined;
  const timezone = character?.identity.timezone ?? "UTC";
  const archiveEntries = useMemo(() => {
    const pageEntries =
      archiveQuery.data?.pages.flatMap((page) => page.items) ?? [];
    const exactEntry = exactEntryQuery.data?.items[0];
    if (
      exactEntry === undefined ||
      pageEntries.some(
        (entry) =>
          entry.entryType === exactEntry.entryType &&
          entry.id === exactEntry.id,
      )
    ) {
      return pageEntries;
    }
    return [...pageEntries, exactEntry].toSorted(
      compareArchiveEntriesNewestFirst,
    );
  }, [archiveQuery.data?.pages, exactEntryQuery.data?.items]);
  const orderedEntries = useMemo(
    () => (ascending ? archiveEntries.toReversed() : archiveEntries),
    [archiveEntries, ascending],
  );
  const groups = useMemo(
    () => groupArchiveByMonth(orderedEntries, "zh-CN", timezone),
    [orderedEntries, timezone],
  );
  const legacySourceId = searchParams.get("sourceId");
  const requestedArchiveEntry =
    exactEntryQuery.data?.items[0] ??
    archiveEntries.find(
      (entry) =>
        entry.id === legacySourceId ||
        (legacySourceId !== null && entry.sourceIds.includes(legacySourceId)),
    );
  const selectedArchiveEntry = requestedArchiveEntry ?? archiveEntries[0];
  const keepsakes = keepsakesQuery.data?.items ?? [];
  const selectedKeepsake =
    keepsakes.find((item) => item.id === selectedKeepsakeId) ?? keepsakes[0];
  const selectedKeepsakeQuery = useQuery({
    queryKey: relationshipArchiveQueryKeys.keepsake(selectedKeepsake?.id ?? ""),
    queryFn: () => api.keepsakes.get(selectedKeepsake!.id),
    enabled: Boolean(selectedKeepsake),
  });

  useEffect(() => {
    if (!requestedEntryId || !requestedArchiveEntry) return;
    const selector = `[data-archive-entry-id="${CSS.escape(requestedArchiveEntry.id)}"]`;
    window.requestAnimationFrame(() => {
      document.querySelector(selector)?.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
    });
  }, [requestedArchiveEntry, requestedEntryId]);

  const selectArchiveEntry = (entry: RelationshipArchiveEntry) => {
    const next = new URLSearchParams(searchParams);
    next.delete("sourceId");
    next.set("entryId", archiveEntryId(entry));
    next.set("filter", filter);
    setSearchParams(next, { replace: true });
  };
  const changeFilter = (nextFilter: RelationshipArchiveFilter) => {
    setFilter(nextFilter);
    const next = new URLSearchParams();
    next.set("filter", nextFilter);
    setSearchParams(next, { replace: true });
  };

  const pending =
    characterQuery.isPending ||
    archiveQuery.isPending ||
    (requestedEntryId !== undefined && exactEntryQuery.isPending);
  const error =
    characterQuery.error ?? archiveQuery.error ?? exactEntryQuery.error;
  const shareSources = selectRelationshipShareSources(
    archiveEntries,
    selectedArchiveEntry,
    selectedKeepsake,
  );

  return (
    <div className="relationship-archive-page">
      <header className="archive-header">
        <div>
          <h1>关系档案</h1>
          <p>
            按时间轴回顾你与 {character?.identity.name ?? "这位角色"}
            的信件、生活与重要时刻。
          </p>
        </div>
        <div className="archive-header__actions">
          <Link
            className="button button--ghost"
            to={`/characters/${characterId}/relationship-share`}
          >
            <Download size={16} aria-hidden="true" /> 导出档案
          </Link>
          <Link
            className="button button--quiet"
            to={`/characters/${characterId}/keepsakes`}
          >
            <Landmark size={16} aria-hidden="true" /> 纪念物陈列柜
          </Link>
        </div>
      </header>

      <div className="archive-toolbar">
        <div className="archive-filters" aria-label="筛选关系档案">
          {ARCHIVE_FILTERS.map((item) => (
            <button
              key={item.value}
              type="button"
              className={item.value === filter ? "is-active" : ""}
              aria-pressed={item.value === filter}
              onClick={() => changeFilter(item.value)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <button
          className="archive-order"
          type="button"
          aria-label={
            ascending
              ? "当前按时间升序，点击改为降序"
              : "当前按时间降序，点击改为升序"
          }
          onClick={() => setAscending((value) => !value)}
        >
          {ascending ? (
            <ArrowUp size={15} aria-hidden="true" />
          ) : (
            <ArrowDown size={15} aria-hidden="true" />
          )}
          {ascending ? "按时间升序" : "按时间降序"}
        </button>
      </div>

      {pending ? <LoadingBlock label="正在整理关系档案…" /> : null}
      {error ? <ErrorBlock error={error} /> : null}

      {!pending && !error && archiveEntries.length === 0 ? (
        <EmptyState
          title="档案还在等待第一条记录"
          description="已寄出的信、已确认的经历和纪念物会沿着各自的时间进入这里。"
          action={
            <Link
              className="button button--primary"
              to={`/characters/${characterId}/correspondence`}
            >
              前往书信
            </Link>
          }
        />
      ) : null}

      {archiveEntries.length > 0 ? (
        <main className="archive-layout">
          <section className="archive-record" aria-label="分页关系时间轴">
            <ArchiveTimeline
              groups={groups}
              {...(selectedArchiveEntry
                ? { selectedId: selectedArchiveEntry.id }
                : {})}
              timezone={timezone}
              onSelect={selectArchiveEntry}
            />
            {archiveQuery.hasNextPage ? (
              <button
                className="button button--ghost archive-load-more"
                type="button"
                disabled={archiveQuery.isFetchingNextPage}
                onClick={() => void archiveQuery.fetchNextPage()}
              >
                {archiveQuery.isFetchingNextPage ? "正在加载…" : "继续向前翻阅"}
              </button>
            ) : (
              <p className="archive-record__end">已经抵达这段档案的开端</p>
            )}
          </section>

          <aside className="archive-aside" aria-label="纪念物与分享">
            <section className="archive-cabinet-preview">
              <div className="archive-section-heading">
                <div>
                  <h2>纪念物陈列柜</h2>
                  <p>精心保存的 {keepsakes.length} 件纪念物</p>
                </div>
                <Link to={`/characters/${characterId}/keepsakes`}>
                  查看全部 <ChevronRight size={14} aria-hidden="true" />
                </Link>
              </div>
              {keepsakesQuery.isPending ? (
                <LoadingBlock label="正在打开陈列柜…" />
              ) : keepsakes.length > 0 ? (
                <KeepsakeShelf
                  items={keepsakes}
                  {...(selectedKeepsake
                    ? { selectedId: selectedKeepsake.id }
                    : {})}
                  timezone={timezone}
                  onSelect={(item: KeepsakeSummaryResponse) =>
                    setSelectedKeepsakeId(item.id)
                  }
                />
              ) : (
                <p className="archive-cabinet-preview__empty">
                  还没有从已确认经历中留下纪念物。
                </p>
              )}
            </section>

            <ProvenancePanel
              {...(!selectedKeepsake && selectedArchiveEntry
                ? { archiveEntry: selectedArchiveEntry }
                : {})}
              {...(selectedKeepsakeQuery.data
                ? { keepsakeDetail: selectedKeepsakeQuery.data }
                : {})}
            />

            <section className="archive-share-preview">
              <div className="archive-section-heading">
                <div>
                  <h2>分享预览</h2>
                  <p>正文摘录默认关闭</p>
                </div>
                <Link
                  to={`/characters/${characterId}/relationship-share?${new URLSearchParams(
                    shareSources,
                  ).toString()}`}
                >
                  自定义 <ChevronRight size={14} aria-hidden="true" />
                </Link>
              </div>
              <SharePreviewCard
                {...(selectedKeepsake ? { keepsake: selectedKeepsake } : {})}
              />
              <p className="archive-share-preview__note">
                仅生成本地 PNG，不会上传或创建公开链接。
              </p>
            </section>
          </aside>
        </main>
      ) : null}
    </div>
  );
}

function parseArchiveFilter(value: string | null): RelationshipArchiveFilter {
  return ARCHIVE_FILTERS.some((item) => item.value === value)
    ? (value as RelationshipArchiveFilter)
    : "all";
}

function compareArchiveEntriesNewestFirst(
  left: RelationshipArchiveEntry,
  right: RelationshipArchiveEntry,
): number {
  const byTime = right.effectiveAtUtc.localeCompare(left.effectiveAtUtc);
  return byTime !== 0 ? byTime : right.id.localeCompare(left.id);
}

function archiveEntryId(entry: RelationshipArchiveEntry): string {
  try {
    const fromHref = new URL(
      entry.href,
      window.location.origin,
    ).searchParams.get("entryId");
    const parsed = RelationshipArchiveEntryIdSchema.safeParse(fromHref);
    if (parsed.success) return parsed.data;
  } catch {
    // Fall through to the entry's typed archive projection.
  }
  if (entry.entryType === "letter") return `letter:${entry.id}`;
  if (entry.entryType === "keepsake") return `keepsake:${entry.id}`;
  if (entry.entryType === "life") return `domain_event:${entry.id}`;
  if (entry.sourceType === "relationship_milestone") {
    return `relationship_milestone:${entry.id}`;
  }
  if (entry.sourceType === "reflection") return `reflection:${entry.id}`;
  return `life_outcome:${entry.id}`;
}
