import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  List,
  RefreshCw,
} from "lucide-react";
import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import { flushSync } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import {
  diariesApi,
  diaryQueryKeys,
  type DiaryEntry,
  type DiaryVolume,
} from "../../api/diaries";
import { ErrorBlock, LoadingBlock } from "../Feedback";
import { BookCoverFace } from "./BookCover";
import { DiaryPage } from "./DiaryPage";
import {
  bookColor,
  monthTitle,
  readReadingAnchor,
  saveReadingAnchor,
  spreadForAnchor,
  volumeKey,
  type DiaryPageData,
  type ReadingAnchor,
} from "./pagination";
import { useDiaryPagination } from "./useDiaryPagination";
import { useBookMotion } from "./useBookMotion";

const NO_ENTRIES: DiaryEntry[] = [];
type Leaf = {
  kind: "open" | "close" | "turn";
  direction: -1 | 1;
  destination: number;
  front: DiaryPageData | null | "cover";
  back: DiaryPageData | null;
  frontNumber: number;
  backNumber: number;
};

function focusLater(element: HTMLElement | null) {
  requestAnimationFrame(() => {
    if (element?.isConnected) element.focus({ preventScroll: true });
  });
}

export function DiaryBook({
  volume,
  phoneMode,
  sourceRect,
  getSource,
  onAlignViewport,
  onReturn,
  onRewrite,
}: {
  volume: DiaryVolume;
  phoneMode: boolean;
  sourceRect: DOMRect;
  getSource: () => HTMLButtonElement | undefined;
  onAlignViewport: () => void;
  onReturn: () => void;
  onRewrite: (entry: DiaryEntry) => void;
}) {
  const key = volumeKey(volume.agentId, volume.month);
  const [phase, setPhase] = useState<"held" | "reading">("held");
  const [tocOpen, setTocOpen] = useState(false);
  const [anchor, setAnchor] = useState<ReadingAnchor | undefined>(() =>
    readReadingAnchor(key),
  );
  const [leaf, setLeaf] = useState<Leaf | null>(null);
  const coverRef = useRef<HTMLButtonElement>(null);
  const bookRef = useRef<HTMLSpanElement>(null);
  const spreadRef = useRef<HTMLDivElement>(null);
  const carrierRef = useRef<HTMLDivElement>(null);
  const leafRef = useRef<HTMLDivElement>(null);
  const readerHeading = useRef<HTMLHeadingElement>(null);
  const { busy, run, animate } = useBookMotion();
  const query = useQuery({
    queryKey: diaryQueryKeys.entries(volume.agentId, volume.month),
    queryFn: () => diariesApi.entries(volume.agentId, volume.month),
    staleTime: 15_000,
  });
  const entries = query.data?.entries ?? NO_ENTRIES;
  const { pages: boundPages, probeRef } = useDiaryPagination(
    entries,
    volume.characterName,
  );
  const pages = useMemo(
    () => (phoneMode ? boundPages.filter((page) => page !== null) : boundPages),
    [boundPages, phoneMode],
  );
  const pagesPerSpread = phoneMode ? 1 : 2;
  const index = spreadForAnchor(pages, anchor, pagesPerSpread);
  const spreadCount = Math.ceil(pages.length / pagesPerSpread);
  const currentPage = pages[index * pagesPerSpread];
  const currentEntry = entries.find(
    (entry) => entry.id === currentPage?.entryId,
  );
  const remember = (destination: number) => {
    const page = pages[destination * pagesPerSpread];
    if (!page) return;
    const nextAnchor = { entryId: page.entryId, offset: page.offset };
    saveReadingAnchor(key, nextAnchor);
    setAnchor(nextAnchor);
  };

  useLayoutEffect(() => {
    void run(async (current) => {
      const target = coverRef.current?.getBoundingClientRect();
      if (!target) return;
      const dx =
        sourceRect.x + sourceRect.width / 2 - target.x - target.width / 2;
      const dy =
        sourceRect.y + sourceRect.height / 2 - target.y - target.height / 2;
      const scale = sourceRect.height / target.height;
      await Promise.all([
        animate(
          coverRef.current,
          [
            { transform: `translate(${dx}px,${dy}px) scale(${scale})` },
            {
              transform: `translate(${dx * 0.82}px,${dy * 0.83}px) scale(${scale * 1.08})`,
              offset: 0.24,
            },
            { transform: "translate(0,0) scale(1)" },
          ],
          760,
        ),
        animate(
          bookRef.current,
          [
            { transform: "rotateY(90deg)" },
            { transform: "rotateY(90deg)", offset: 0.24 },
            { transform: "rotateY(0deg)" },
          ],
          760,
        ),
      ]);
      if (current()) focusLater(coverRef.current);
    });
  }, [sourceRect, run, animate]);

  const returnBook = () => {
    if (phase !== "held") return;
    void run(async (current) => {
      const start = coverRef.current?.getBoundingClientRect();
      const target = getSource()?.getBoundingClientRect();
      if (start && target) {
        const dx = target.x + target.width / 2 - start.x - start.width / 2;
        const dy = target.y + target.height / 2 - start.y - start.height / 2;
        await Promise.all([
          animate(
            coverRef.current,
            [
              { transform: "translate(0,0) scale(1)" },
              {
                transform: `translate(${dx}px,${dy}px) scale(${target.height / start.height})`,
              },
            ],
            600,
          ),
          animate(
            bookRef.current,
            [
              { transform: "rotateY(0deg)" },
              { transform: "rotateY(90deg)", offset: 0.66 },
              { transform: "rotateY(90deg)" },
            ],
            600,
          ),
        ]);
      }
      if (current()) onReturn();
    });
  };
  const coverLeaf = (kind: "open" | "close"): Leaf => ({
    kind,
    direction: 1,
    destination: index,
    front: "cover",
    back: pages[index * 2] ?? null,
    frontNumber: 0,
    backNumber: index * 2 + 1,
  });
  const openBook = () => {
    if (phase !== "held" || !pages.length || query.isError) return;
    void run(async (current) => {
      if (phoneMode) {
        flushSync(() => {
          setLeaf(null);
          setPhase("reading");
        });
        focusLater(readerHeading.current);
        return;
      }
      onAlignViewport();
      const start = coverRef.current?.getBoundingClientRect();
      flushSync(() => {
        setPhase("reading");
        setLeaf(coverLeaf("open"));
      });
      const target = carrierRef.current?.getBoundingClientRect();
      if (start && target) {
        const dx = start.x + start.width / 2 - target.x - target.width / 2;
        const dy = start.y + start.height / 2 - target.y - target.height / 2;
        await animate(
          carrierRef.current,
          [
            {
              transform: `translate(${dx}px,${dy}px) scale(${start.width / target.width},${start.height / target.height})`,
            },
            { transform: "translate(0,0) scale(1)" },
          ],
          270,
        );
      }
      if (!current()) return;
      await animate(
        leafRef.current,
        [{ transform: "rotateY(0deg)" }, { transform: "rotateY(-180deg)" }],
        520,
      );
      if (!current()) return;
      flushSync(() => setLeaf(null));
      onAlignViewport();
      focusLater(readerHeading.current);
    });
  };
  const closeBook = () => {
    if (phase !== "reading") return;
    void run(async (current) => {
      remember(index);
      if (phoneMode) {
        flushSync(() => {
          setTocOpen(false);
          setLeaf(null);
          setPhase("held");
        });
        focusLater(coverRef.current);
        return;
      }
      flushSync(() => {
        setTocOpen(false);
        setLeaf(coverLeaf("close"));
      });
      await animate(
        leafRef.current,
        [{ transform: "rotateY(-180deg)" }, { transform: "rotateY(0deg)" }],
        460,
      );
      if (!current()) return;
      const start = carrierRef.current?.getBoundingClientRect();
      flushSync(() => {
        setLeaf(null);
        setPhase("held");
      });
      const target = coverRef.current?.getBoundingClientRect();
      if (start && target) {
        const dx = start.x + start.width / 2 - target.x - target.width / 2;
        const dy = start.y + start.height / 2 - target.y - target.height / 2;
        await animate(
          coverRef.current,
          [
            {
              transform: `translate(${dx}px,${dy}px) scale(${start.width / target.width},${start.height / target.height})`,
            },
            { transform: "translate(0,0) scale(1)" },
          ],
          270,
        );
      }
      if (current()) focusLater(coverRef.current);
    });
  };
  const turn = (direction: -1 | 1) => {
    const destination = index + direction;
    if (phase !== "reading" || destination < 0 || destination >= spreadCount)
      return;
    void run(async (current) => {
      if (phoneMode) {
        flushSync(() => remember(destination));
        return;
      }
      const frontIndex = index * 2 + (direction > 0 ? 1 : 0);
      const backIndex = destination * 2 + (direction > 0 ? 0 : 1);
      flushSync(() =>
        setLeaf({
          kind: "turn",
          direction,
          destination,
          front: pages[frontIndex] ?? null,
          back: pages[backIndex] ?? null,
          frontNumber: frontIndex + 1,
          backNumber: backIndex + 1,
        }),
      );
      await animate(
        leafRef.current,
        [
          { transform: "rotateY(0deg)" },
          { transform: `rotateY(${direction > 0 ? -180 : 180}deg)` },
        ],
        560,
        "cubic-bezier(.34,.08,.2,1)",
      );
      if (!current()) return;
      remember(destination);
      setLeaf(null);
    });
  };
  const keyDown = (event: KeyboardEvent) => {
    if (
      busy ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      /^(INPUT|SELECT|TEXTAREA)$/u.test(
        (event.target as HTMLElement).tagName,
      ) ||
      (event.target as HTMLElement).isContentEditable
    )
      return;
    if (event.key === "Escape") {
      event.preventDefault();
      if (phase === "reading") closeBook();
      else returnBook();
    }
    if (
      phase === "reading" &&
      (event.key === "ArrowLeft" || event.key === "ArrowRight")
    ) {
      event.preventDefault();
      turn(event.key === "ArrowLeft" ? -1 : 1);
    }
  };
  const leftIndex =
    !phoneMode && leaf?.kind === "turn" && leaf.direction < 0
      ? leaf.destination * pagesPerSpread
      : index * pagesPerSpread;
  const rightIndex =
    leaf?.kind === "turn" && leaf.direction > 0
      ? leaf.destination * 2 + 1
      : index * 2 + 1;
  const leafElement =
    !phoneMode && leaf ? (
      <div
        className={`ml-flipper ${leaf.direction > 0 ? "next" : "prev"}`}
        ref={leafRef}
        aria-hidden="true"
      >
        <div className="ml-face front">
          {leaf.front === "cover" ? (
            <div className="ml-cover-face">
              <BookCoverFace volume={volume} />
            </div>
          ) : (
            <DiaryPage
              page={leaf.front}
              side={leaf.direction > 0 ? "right" : "left"}
              number={leaf.frontNumber}
              characterName={volume.characterName}
            />
          )}
        </div>
        <div className="ml-face back">
          <DiaryPage
            page={leaf.back}
            side={leaf.direction > 0 ? "left" : "right"}
            number={leaf.backNumber}
            characterName={volume.characterName}
          />
        </div>
      </div>
    ) : null;

  return (
    <div
      className="ml-book-stage"
      role={phoneMode ? "dialog" : undefined}
      aria-modal={phoneMode ? true : undefined}
      aria-label={
        phoneMode
          ? `${volume.characterName}的${monthTitle(volume.month)}手记`
          : undefined
      }
      tabIndex={phoneMode ? -1 : undefined}
      data-phase={phase}
      aria-busy={busy}
      onKeyDown={keyDown}
      style={{ "--cover": bookColor(volume.agentId) } as CSSProperties}
    >
      <section
        className="ml-held-view"
        aria-label="取出的书籍封面"
        aria-hidden={phase !== "held"}
        inert={phase !== "held"}
      >
        <div className="ml-held-toolbar">
          <button
            type="button"
            className="ml-plain"
            disabled={busy}
            onClick={returnBook}
          >
            <ArrowLeft size={16} aria-hidden="true" />
            放回书架
          </button>
          <span>
            {volume.characterName} · {volume.month.slice(0, 4)} 年{" "}
            {Number(volume.month.slice(5))} 月
          </span>
        </div>
        <div className="ml-held-area">
          <button
            type="button"
            className="ml-cover-button"
            ref={coverRef}
            disabled={busy || query.isPending || query.isError || !pages.length}
            onClick={openBook}
            aria-label={`打开${volume.characterName}的${monthTitle(volume.month)}手记`}
          >
            <span className="ml-book3d" ref={bookRef}>
              <span className="ml-cover-face ml-front">
                <BookCoverFace volume={volume} />
              </span>
              <span className="ml-cover-face ml-back-cover" />
              <span className="ml-side">
                {monthTitle(volume.month)}手记 · {volume.characterName}
              </span>
              <span className="ml-paper-edge" />
            </span>
          </button>
        </div>
        {query.isPending ? (
          <LoadingBlock label="正在取来这本手记…" />
        ) : query.isError ? (
          <ErrorBlock
            error={query.error}
            action={
              <button
                type="button"
                className="ml-plain"
                onClick={() => void query.refetch()}
              >
                重新读取
              </button>
            }
          />
        ) : entries.length === 0 ? (
          <p className="ml-held-caption">这本书暂时没有可阅读的手记。</p>
        ) : (
          <p className="ml-held-caption">
            已取出《{monthTitle(volume.month)}手记》
            <small>再次点击封面，展开这个月的日记。</small>
          </p>
        )}
      </section>
      <section
        className="ml-reader-view"
        aria-label={phoneMode ? "单页日记" : "正视双页日记"}
        aria-hidden={phase !== "reading"}
        inert={phase !== "reading"}
      >
        <div className="ml-reader-toolbar">
          <button
            type="button"
            className="ml-plain"
            disabled={busy}
            onClick={closeBook}
          >
            <ArrowLeft size={16} aria-hidden="true" />
            合上这本书
          </button>
          <h2 className="ml-reader-title" tabIndex={-1} ref={readerHeading}>
            <span className="ml-reader-character">
              {volume.characterName}的手记
            </span>
            <span className="ml-reader-period">
              <span className="ml-hint-desktop"> / </span>
              {volume.month.slice(0, 4)} · {monthTitle(volume.month)}
            </span>
          </h2>
          <button
            type="button"
            className="ml-plain"
            aria-expanded={tocOpen}
            aria-controls="diary-date-contents"
            disabled={busy}
            onClick={() => setTocOpen(!tocOpen)}
          >
            <List size={16} aria-hidden="true" />
            日期目录
          </button>
        </div>
        {tocOpen ? (
          <nav
            className="ml-toc"
            id="diary-date-contents"
            aria-label="按日期翻阅"
          >
            {[...entries]
              .sort((a, b) => a.entryDate.localeCompare(b.entryDate))
              .map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  disabled={busy}
                  aria-current={
                    currentEntry?.id === entry.id ? "page" : undefined
                  }
                  onClick={() => {
                    const location = pages.findIndex(
                      (page) => page?.entryId === entry.id,
                    );
                    if (location >= 0) {
                      remember(Math.floor(location / pagesPerSpread));
                      if (phoneMode) {
                        setTocOpen(false);
                        focusLater(readerHeading.current);
                      }
                    }
                  }}
                >
                  <time dateTime={entry.entryDate}>
                    {Number(entry.entryDate.slice(5, 7))} /{" "}
                    {Number(entry.entryDate.slice(8))}
                  </time>
                  <span>{entry.title}</span>
                </button>
              ))}
          </nav>
        ) : null}
        <div className="ml-spread" ref={spreadRef}>
          <DiaryPage
            page={pages[leftIndex]}
            number={leftIndex + 1}
            side="left"
            characterName={volume.characterName}
          />
          {!phoneMode ? (
            <>
              <DiaryPage
                page={pages[rightIndex]}
                number={rightIndex + 1}
                side="right"
                characterName={volume.characterName}
              />
              <span className="ml-gutter" aria-hidden="true" />
            </>
          ) : null}
          <span className="ml-ribbon" aria-hidden="true" />
          {!phoneMode && (leaf?.kind === "open" || leaf?.kind === "close") ? (
            <div className="ml-open-carrier" ref={carrierRef}>
              {leafElement}
            </div>
          ) : (
            leafElement
          )}
          <div className="ml-measurement" aria-hidden="true">
            <article className="ml-paper">
              <div className="ml-page-flow" ref={probeRef} />
            </article>
          </div>
        </div>
        <nav className="ml-reader-bottom" aria-label="手记翻页">
          <button
            type="button"
            className="ml-turn"
            aria-label="上一页"
            disabled={busy || index === 0}
            onClick={() => turn(-1)}
          >
            <ChevronLeft size={20} aria-hidden="true" />
          </button>
          <span className="ml-position" role="status" aria-live="polite">
            {phoneMode
              ? `第 ${index + 1} / ${pages.length} 页`
              : `第 ${index * 2 + 1}–${index * 2 + 2} / ${pages.length} 页`}
          </span>
          <button
            type="button"
            className="ml-turn"
            aria-label="下一页"
            disabled={busy || index + 1 >= spreadCount}
            onClick={() => turn(1)}
          >
            <ChevronRight size={20} aria-hidden="true" />
          </button>
        </nav>
        <p className="ml-reader-hint">
          <span className="ml-hint-desktop">
            左右键翻页 · 日期目录跳转 · Esc 合书
          </span>
          <span className="ml-hint-mobile">轻触箭头翻页 · 日期目录跳转</span>
        </p>
        {currentEntry ? (
          <div className="ml-entry-actions">
            <p>
              {currentEntry.validity === "source_changed"
                ? "这篇手记所依据的聊天有了变化，可以重新整理。"
                : currentEntry.hasNewMaterial
                  ? "这一天又留下了新的聊天，可以续写进手记。"
                  : ""}
            </p>
            <button
              type="button"
              className="ml-plain"
              disabled={busy}
              onClick={() => onRewrite(currentEntry)}
            >
              <RefreshCw size={14} aria-hidden="true" />
              重新整理这一天
            </button>
          </div>
        ) : null}
      </section>
    </div>
  );
}
