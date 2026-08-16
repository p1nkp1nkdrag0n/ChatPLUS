export {
  FakeClock,
  SystemClock,
  createClock,
  type Clock,
  type MutableClock,
} from "@personasim/providers";

import type { Clock, MutableClock } from "@personasim/providers";

export function isMutableClock(clock: Clock): clock is MutableClock {
  return "setUtc" in clock && "advance" in clock;
}
