import { useCallback, useEffect, useRef, useState } from "react";
import { SETUP_STEPS, type SetupStep } from "../components/setup/setupSteps";
import { useReducedMotion } from "./useReducedMotion";

export interface BookMotion {
  step: SetupStep;
  target: SetupStep;
  phase: "idle" | "turning" | "revealing";
  direction: "forward" | "backward";
}

/** A target is committed only after the physical leaf has landed. */
export function useBookTurn() {
  const reduced = useReducedMotion();
  const [motion, setMotion] = useState<BookMotion>({
    step: "service",
    target: "service",
    phase: "idle",
    direction: "forward",
  });
  const live = useRef(motion);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const commit = useCallback((next: BookMotion) => {
    live.current = next;
    setMotion(next);
  }, []);
  const finishReveal = useCallback(() => {
    if (live.current.phase !== "revealing") return;
    clearTimeout(timer.current);
    commit({ ...live.current, phase: "idle" });
  }, [commit]);
  const finishTurn = useCallback(() => {
    if (live.current.phase !== "turning") return;
    clearTimeout(timer.current);
    commit({ ...live.current, step: live.current.target, phase: "revealing" });
    timer.current = setTimeout(finishReveal, 260);
  }, [commit, finishReveal]);
  const turnTo = useCallback(
    (target: SetupStep) => {
      const current = live.current;
      if (current.phase !== "idle" || target === current.step) return;
      if (document.activeElement instanceof HTMLElement)
        document.activeElement.blur();
      const next: BookMotion = {
        step: reduced ? target : current.step,
        target,
        phase: reduced ? "idle" : "turning",
        direction:
          SETUP_STEPS.indexOf(target) > SETUP_STEPS.indexOf(current.step)
            ? "forward"
            : "backward",
      };
      commit(next);
      if (!reduced) timer.current = setTimeout(finishTurn, 1040);
    },
    [commit, finishTurn, reduced],
  );
  useEffect(() => {
    if (reduced && live.current.phase !== "idle") {
      clearTimeout(timer.current);
      commit({ ...live.current, step: live.current.target, phase: "idle" });
    }
  }, [reduced, commit]);
  useEffect(() => () => clearTimeout(timer.current), []);
  return { motion, turnTo, finishTurn, finishReveal, reduced };
}
