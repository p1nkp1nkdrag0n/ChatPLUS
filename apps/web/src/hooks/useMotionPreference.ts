import { useEffect, useState } from "react";

export type MotionPreference = "auto" | "reduced" | "still";
export type MotionMode = "normal" | "reduced" | "still";
export const MOTION_STORAGE_KEY = "chatplus.motion.v1";
const CHANGE_EVENT = "chatplus-motion-change";
let memoryPreference: MotionPreference = "auto";

function readPreference(): MotionPreference {
  try {
    const value = localStorage.getItem(MOTION_STORAGE_KEY);
    if (value === "auto" || value === "reduced" || value === "still")
      return value;
  } catch {
    /* Storage may be unavailable; the setting still works for this visit. */
  }
  return memoryPreference;
}

export function useMotionPreference() {
  const [preference, setPreference] =
    useState<MotionPreference>(readPreference);
  const [systemReduced, setSystemReduced] = useState(
    () =>
      typeof matchMedia === "function" &&
      matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const mode: MotionMode =
    preference === "still"
      ? "still"
      : preference === "reduced" || systemReduced
        ? "reduced"
        : "normal";

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const syncPreference = () => setPreference(readPreference());
    const syncSystem = () => setSystemReduced(media.matches);
    media.addEventListener("change", syncSystem);
    window.addEventListener("storage", syncPreference);
    window.addEventListener(CHANGE_EVENT, syncPreference);
    return () => {
      media.removeEventListener("change", syncSystem);
      window.removeEventListener("storage", syncPreference);
      window.removeEventListener(CHANGE_EVENT, syncPreference);
    };
  }, []);

  useEffect(() => {
    document.documentElement.dataset["motion"] = mode;
  }, [mode]);

  const updatePreference = (next: MotionPreference) => {
    memoryPreference = next;
    try {
      localStorage.setItem(MOTION_STORAGE_KEY, next);
    } catch {
      /* in-memory fallback */
    }
    window.dispatchEvent(new Event(CHANGE_EVENT));
    setPreference(next);
  };
  return { preference, mode, updatePreference };
}
