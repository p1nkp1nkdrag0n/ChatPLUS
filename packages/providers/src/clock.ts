export interface Clock {
  now(): Date;
  nowUtc(): string;
}

export interface MutableClock extends Clock {
  setUtc(value: string | Date): void;
  advance(input: { hours?: number; minutes?: number; days?: number }): void;
}

function parseDate(value: string | Date): Date {
  const parsed =
    value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new TypeError("Clock value must be a valid ISO-8601 instant");
  }
  return parsed;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }

  nowUtc(): string {
    return this.now().toISOString();
  }
}

export class FakeClock implements MutableClock {
  #current: Date;

  constructor(initialUtc: string | Date = "2026-01-01T00:00:00.000Z") {
    this.#current = parseDate(initialUtc);
  }

  now(): Date {
    return new Date(this.#current.getTime());
  }

  nowUtc(): string {
    return this.#current.toISOString();
  }

  setUtc(value: string | Date): void {
    this.#current = parseDate(value);
  }

  advance(input: { hours?: number; minutes?: number; days?: number }): void {
    const { hours = 0, minutes = 0, days = 0 } = input;
    if (![hours, minutes, days].every(Number.isFinite)) {
      throw new TypeError("Clock increments must be finite numbers");
    }
    const delta = ((days * 24 + hours) * 60 + minutes) * 60 * 1_000;
    this.#current = new Date(this.#current.getTime() + delta);
  }
}

export type ClockMode = "system" | "fake";

export function createClock(
  input: ClockMode | { mode: ClockMode; initialUtc?: string | Date } = "system",
): SystemClock | FakeClock {
  const config = typeof input === "string" ? { mode: input } : input;
  if (config.mode === "fake") {
    return new FakeClock(
      "initialUtc" in config ? config.initialUtc : undefined,
    );
  }
  return new SystemClock();
}
