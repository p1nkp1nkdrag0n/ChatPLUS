import type { DiaryEntry } from "../../api/diaries";

export type DiaryPageData = {
  entryId: string;
  entryDate: string;
  title: string;
  body: string;
  offset: number;
  first: boolean;
  last: boolean;
};

export type ReadingAnchor = { entryId: string; offset: number };

/** Every entry starts on the left; text is split only at grapheme boundaries. */
export function paginateDiaryEntries(
  entries: readonly DiaryEntry[],
  fits: (page: DiaryPageData) => boolean,
): Array<DiaryPageData | null> {
  const pages: Array<DiaryPageData | null> = [];
  const segmenter = new Intl.Segmenter("zh", { granularity: "grapheme" });
  for (const entry of [...entries].sort((a, b) =>
    a.entryDate.localeCompare(b.entryDate),
  )) {
    const segments = [...segmenter.segment(entry.body)];
    let cursor = 0;
    do {
      const offset = segments[cursor]?.index ?? 0;
      const candidate = (end: number): DiaryPageData => ({
        entryId: entry.id,
        entryDate: entry.entryDate,
        title: entry.title,
        body: entry.body.slice(
          offset,
          segments[end]?.index ?? entry.body.length,
        ),
        offset,
        first: cursor === 0,
        last: end === segments.length,
      });
      let low = cursor + 1;
      let high = segments.length;
      let end = Math.min(cursor + 1, segments.length);
      while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        if (fits(candidate(middle))) {
          end = middle;
          low = middle + 1;
        } else high = middle - 1;
      }
      // Prefer a nearby paragraph/sentence ending without leaving half a blank page.
      if (end < segments.length) {
        const minimum = cursor + Math.floor((end - cursor) * 0.75);
        for (let boundary = end; boundary > minimum; boundary--) {
          if (/[\n。！？.!?]$/u.test(segments[boundary - 1]?.segment ?? "")) {
            end = boundary;
            break;
          }
        }
      }
      pages.push(candidate(end));
      cursor = end;
    } while (cursor < segments.length);
    balanceFinalPages(pages, entry.id, fits, segmenter);
    if (pages.length % 2) pages.push(null);
  }
  return pages;
}

/** Avoid a final page containing only a dangling sentence. Keep whole paragraphs where possible. */
function balanceFinalPages(
  pages: Array<DiaryPageData | null>,
  entryId: string,
  fits: (page: DiaryPageData) => boolean,
  segmenter: Intl.Segmenter,
): void {
  const last = pages.at(-1);
  const previous = pages.at(-2);
  if (!last || !previous || previous.entryId !== entryId) return;
  const previousLength = [...segmenter.segment(previous.body)].length;
  const lastLength = [...segmenter.segment(last.body)].length;
  if (lastLength >= Math.max(24, previousLength * 0.25)) return;
  const combined = previous.body + last.body;
  const segments = [...segmenter.segment(combined)];
  const midpoint = Math.floor(segments.length / 2);
  const candidates = segments
    .map((segment, index) => ({
      offset: segment.index,
      index,
      paragraph: combined.slice(0, segment.index).endsWith("\n\n"),
      sentence: /[。！？.!?\n]$/u.test(combined.slice(0, segment.index)),
    }))
    .filter(
      (cut) =>
        cut.index >= segments.length * 0.2 &&
        cut.index <= segments.length * 0.8,
    )
    .sort(
      (a, b) =>
        Number(b.paragraph) - Number(a.paragraph) ||
        Number(b.sentence) - Number(a.sentence) ||
        Math.abs(a.index - midpoint) - Math.abs(b.index - midpoint),
    );
  for (const cut of candidates) {
    const before = { ...previous, body: combined.slice(0, cut.offset) };
    const after = {
      ...last,
      body: combined.slice(cut.offset),
      offset: previous.offset + cut.offset,
    };
    if (fits(before) && fits(after)) {
      pages[pages.length - 2] = before;
      pages[pages.length - 1] = after;
      return;
    }
  }
}

export function spreadForAnchor(
  pages: readonly (DiaryPageData | null)[],
  anchor?: ReadingAnchor,
  pagesPerSpread: 1 | 2 = 2,
): number {
  if (!anchor) return 0;
  let matched = -1;
  pages.forEach((page, index) => {
    if (page?.entryId === anchor.entryId && page.offset <= anchor.offset)
      matched = index;
  });
  return matched < 0 ? 0 : Math.floor(matched / pagesPerSpread);
}

export function monthTitle(month: string): string {
  const names = [
    "一月",
    "二月",
    "三月",
    "四月",
    "五月",
    "六月",
    "七月",
    "八月",
    "九月",
    "十月",
    "十一月",
    "十二月",
  ];
  return names[Number(month.slice(5, 7)) - 1] ?? month;
}

export function volumeKey(agentId: string, month: string): string {
  return `${agentId}:${month}`;
}

export function bookColor(agentId: string): string {
  const colors = ["#4b6854", "#906859", "#68707b", "#876f49", "#646c51"];
  let hash = 0;
  for (const letter of agentId) hash = (hash * 31 + letter.charCodeAt(0)) >>> 0;
  return colors[hash % colors.length]!;
}

const POSITION_KEY = "dearvale.diary-reading.v1";
export function readReadingAnchor(key: string): ReadingAnchor | undefined {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(POSITION_KEY) ?? "{}",
    );
    if (!value || typeof value !== "object") return;
    const item = (value as Record<string, unknown>)[key];
    if (!item || typeof item !== "object") return;
    const anchor = item as Record<string, unknown>;
    if (
      typeof anchor.entryId === "string" &&
      typeof anchor.offset === "number" &&
      Number.isInteger(anchor.offset) &&
      anchor.offset >= 0
    )
      return { entryId: anchor.entryId, offset: anchor.offset };
  } catch {
    /* Reading remains available when local storage is disabled. */
  }
}

export function saveReadingAnchor(key: string, anchor: ReadingAnchor): void {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(POSITION_KEY) ?? "{}");
    const records =
      raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    const retained = Object.entries(records)
      .filter(([id]) => id !== key)
      .slice(-79);
    localStorage.setItem(
      POSITION_KEY,
      JSON.stringify(Object.fromEntries([...retained, [key, anchor]])),
    );
  } catch {
    /* Storage is an enhancement, never a reading prerequisite. */
  }
}
