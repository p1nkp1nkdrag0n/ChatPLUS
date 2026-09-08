import { useMotionPreference } from "./useMotionPreference";

export function usePrefersReducedMotion(): boolean {
  const { mode } = useMotionPreference();
  return mode !== "normal";
}
