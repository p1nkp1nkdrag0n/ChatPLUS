import { useEffect } from "react";

/** Keep the conversation above the software keyboard, including iOS WebKit. */
export function useMobileViewport() {
  useEffect(() => {
    const viewport = window.visualViewport;
    const root = document.documentElement;
    let largestHeight = window.innerHeight;
    let lastWidth = window.innerWidth;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        // Pinch zoom is an accessibility action, not a software keyboard resize.
        if (viewport && viewport.scale !== 1) return;
        if (window.innerWidth !== lastWidth) {
          lastWidth = window.innerWidth;
          largestHeight = window.innerHeight;
        }
        const height = viewport?.height ?? window.innerHeight;
        const editable = document.activeElement?.matches(
          "input, textarea, [contenteditable='true']",
        );
        largestHeight = Math.max(largestHeight, window.innerHeight);
        const keyboard = Boolean(editable && largestHeight - height > 140);
        root.style.setProperty(
          "--app-viewport-height",
          `${Math.round(height)}px`,
        );
        root.dataset.keyboardOpen = String(keyboard);
      });
    };
    const rotate = () => {
      largestHeight = window.innerHeight;
      update();
    };
    update();
    viewport?.addEventListener("resize", update);
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", rotate);
    document.addEventListener("focusin", update);
    document.addEventListener("focusout", update);
    return () => {
      cancelAnimationFrame(frame);
      viewport?.removeEventListener("resize", update);
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", rotate);
      document.removeEventListener("focusin", update);
      document.removeEventListener("focusout", update);
      root.style.removeProperty("--app-viewport-height");
      delete root.dataset.keyboardOpen;
    };
  }, []);
}
