import { useLayoutEffect, useRef, useState } from "react";
import type { DiaryEntry } from "../../api/diaries";
import { paginateDiaryEntries, type DiaryPageData } from "./pagination";

export function useDiaryPagination(
  entries: readonly DiaryEntry[],
  characterName: string,
) {
  const probeRef = useRef<HTMLDivElement>(null);
  const [pages, setPages] = useState<Array<DiaryPageData | null>>([]);
  useLayoutEffect(() => {
    const probe = probeRef.current;
    if (!probe) return;
    let active = true;
    let frame = 0;
    const measure = () => {
      if (!active || probe.clientWidth === 0 || probe.clientHeight === 0)
        return;
      const next = paginateDiaryEntries(entries, (page) => {
        const header = document.createElement("div");
        header.className = page.first ? "ml-page-date" : "ml-running-head";
        header.textContent = page.first
          ? page.entryDate.replaceAll("-", " · ")
          : `${characterName}的手记 · 续`;
        const title = document.createElement("h3");
        title.className = "ml-page-title";
        title.textContent = page.title;
        const body = document.createElement("div");
        body.className = "ml-page-body";
        body.textContent = page.body;
        probe.replaceChildren(header, ...(page.first ? [title] : []), body);
        return probe.scrollHeight <= probe.clientHeight + 1;
      });
      probe.replaceChildren();
      if (active) setPages(next);
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    measure();
    const observer = new ResizeObserver(schedule);
    observer.observe(probe);
    document.fonts?.addEventListener("loadingdone", schedule);
    void document.fonts?.ready.then(() => {
      if (active) schedule();
    });
    return () => {
      active = false;
      cancelAnimationFrame(frame);
      observer.disconnect();
      document.fonts?.removeEventListener("loadingdone", schedule);
    };
  }, [entries, characterName]);
  return { probeRef, pages };
}
