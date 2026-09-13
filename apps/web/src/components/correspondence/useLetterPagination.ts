import { useLayoutEffect, useRef, useState, type DependencyList } from "react";

// A final column has no trailing gap. Account for the browser rounding scrollWidth
// to whole pixels so a fractional column does not produce an empty final page.
export function countLetterPages(
  scrollWidth: number,
  columnWidth: number,
  columnGap: number,
) {
  if (columnWidth <= 0) return 1;
  return Math.max(
    1,
    Math.ceil((scrollWidth + columnGap - 1) / (columnWidth + columnGap)),
  );
}

export function useLetterPagination(contentDependencies: DependencyList) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [metrics, setMetrics] = useState({ pageCount: 1, pageStep: 0 });
  const [requestedPage, setRequestedPage] = useState(0);
  const page = Math.min(requestedPage, metrics.pageCount - 1);

  useLayoutEffect(() => {
    const content = contentRef.current;
    const viewport = viewportRef.current;
    if (!content || !viewport) return;
    let active = true;
    let frame = 0;

    const measure = () => {
      if (!active) return;
      const style = window.getComputedStyle(content);
      // Computed width, unlike getBoundingClientRect, is unaffected by the
      // envelope-opening animation's scale and keeps every page aligned.
      const width = Number.parseFloat(style.width);
      if (!Number.isFinite(width) || width <= 0) return;
      const gap = Number.parseFloat(style.columnGap) || 0;
      const pageCount = countLetterPages(content.scrollWidth, width, gap);
      const pageStep = width + gap;
      setMetrics((previous) =>
        previous.pageCount === pageCount && previous.pageStep === pageStep
          ? previous
          : { pageCount, pageStep },
      );
      setRequestedPage((previous) => Math.min(previous, pageCount - 1));
    };
    const scheduleMeasure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };

    measure();
    const observer = new ResizeObserver(scheduleMeasure);
    observer.observe(viewport);
    // A font swap can change wrapping without changing the paper dimensions.
    document.fonts?.addEventListener("loadingdone", scheduleMeasure);
    void document.fonts?.ready.then(() => {
      if (active) scheduleMeasure();
    });
    return () => {
      active = false;
      cancelAnimationFrame(frame);
      observer.disconnect();
      document.fonts?.removeEventListener("loadingdone", scheduleMeasure);
    };
    // The caller supplies the fixed list of text and paper inputs which affect
    // layout. Page changes do not reconnect observers or remeasure the text.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, contentDependencies);

  function turnPage(direction: -1 | 1) {
    setRequestedPage((previous) =>
      Math.max(0, Math.min(previous + direction, metrics.pageCount - 1)),
    );
  }

  return { viewportRef, contentRef, page, ...metrics, turnPage };
}
