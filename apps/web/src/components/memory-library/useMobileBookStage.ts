import { useLayoutEffect, useSyncExternalStore, type RefObject } from "react";

const PHONE_QUERY = "(max-width: 700px)";

function subscribePhoneViewport(onChange: () => void) {
  const query = window.matchMedia(PHONE_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function phoneViewport() {
  return window.matchMedia(PHONE_QUERY).matches;
}

export function useMobileBookStage(
  active: boolean,
  rootRef: RefObject<HTMLDivElement | null>,
) {
  const phoneMode = useSyncExternalStore(
    subscribePhoneViewport,
    phoneViewport,
    () => false,
  );

  useLayoutEffect(() => {
    if (!active || !phoneMode) return;
    const library = rootRef.current;
    const stage = library?.querySelector<HTMLElement>(".ml-book-stage");
    const scroller = library?.closest<HTMLElement>(".app-main");
    const navigation = library
      ?.closest(".app-shell")
      ?.querySelector<HTMLElement>(".app-nav--adaptive");
    if (!stage || !scroller) return;

    const scrollTop = scroller.scrollTop;
    const overflowY = scroller.style.overflowY;
    const overscrollBehavior = scroller.style.overscrollBehavior;
    const navigationWasInert = navigation?.inert ?? false;
    scroller.style.overflowY = "hidden";
    scroller.style.overscrollBehavior = "none";
    if (navigation) navigation.inert = true;

    const trapTab = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || event.altKey || event.ctrlKey || event.metaKey)
        return;
      const targets = [
        ...stage.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ].filter(
        (element) =>
          !element.closest('[inert], [aria-hidden="true"]') &&
          element.getClientRects().length > 0 &&
          getComputedStyle(element).visibility !== "hidden",
      );
      const first = targets[0];
      const last = targets.at(-1);
      const current = document.activeElement;
      if (!first || !last) {
        event.preventDefault();
        stage.focus({ preventScroll: true });
      } else if (
        event.shiftKey &&
        (current === first || !targets.includes(current as HTMLElement))
      ) {
        event.preventDefault();
        last.focus({ preventScroll: true });
      } else if (
        !event.shiftKey &&
        (current === last || !targets.includes(current as HTMLElement))
      ) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    };
    document.addEventListener("keydown", trapTab);
    if (!stage.contains(document.activeElement))
      stage.focus({ preventScroll: true });

    return () => {
      document.removeEventListener("keydown", trapTab);
      scroller.style.overflowY = overflowY;
      scroller.style.overscrollBehavior = overscrollBehavior;
      scroller.scrollTop = scrollTop;
      if (navigation) navigation.inert = navigationWasInert;
    };
  }, [active, phoneMode, rootRef]);

  return phoneMode;
}
