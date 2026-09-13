import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { BookActionGate } from "./motion";

export function useBookMotion() {
  const gate = useRef(new BookActionGate());
  const animations = useRef(new Set<Animation>());
  const [busy, setBusy] = useState(false);
  useLayoutEffect(
    () => () => {
      gate.current.cancel();
      animations.current.forEach((animation) => animation.cancel());
      animations.current.clear();
    },
    [],
  );
  const animate = useCallback(
    async (
      element: HTMLElement | null,
      frames: Keyframe[],
      duration: number,
      easing = "cubic-bezier(.25,.8,.2,1)",
    ) => {
      if (
        !element ||
        typeof element.animate !== "function" ||
        window.matchMedia("(prefers-reduced-motion: reduce)").matches
      )
        return;
      const animation = element.animate(frames, {
        duration,
        easing,
        fill: "both",
      });
      animations.current.add(animation);
      try {
        await animation.finished;
      } catch {
        /* Cancellation is settled by the action gate. */
      } finally {
        animation.cancel();
        animations.current.delete(animation);
      }
    },
    [],
  );
  const run = useCallback(
    async (work: (current: () => boolean) => Promise<void>) => {
      const ticket = gate.current.begin();
      if (ticket === undefined) return;
      setBusy(true);
      try {
        await work(() => gate.current.current(ticket));
      } finally {
        if (gate.current.finish(ticket)) setBusy(false);
      }
    },
    [],
  );
  return { busy, run, animate };
}
