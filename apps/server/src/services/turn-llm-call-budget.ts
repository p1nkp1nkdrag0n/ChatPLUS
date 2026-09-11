import { ApiError } from "../domain/errors.js";
import type { GenerateObjectInput, LlmService } from "./llm-service.js";

/** Logical generation calls, not provider HTTP attempts or token billing. */
export class TurnLlmCallBudget {
  readonly purposes: string[] = [];

  constructor(readonly maximumLogicalCalls = 12) {
    if (!Number.isInteger(maximumLogicalCalls) || maximumLogicalCalls < 1)
      throw new TypeError("Turn logical call limit must be a positive integer");
  }

  get used(): number {
    return this.purposes.length;
  }

  canSpend(calls = 1, reservedAfter = 0): boolean {
    return this.used + calls + reservedAfter <= this.maximumLogicalCalls;
  }

  bind(llm: LlmService): LlmService {
    return new Proxy(llm, {
      get: (target, key) => {
        if (key === "generateObject") {
          return <T>(input: GenerateObjectInput<T>): Promise<T> => {
            if (!this.canSpend()) {
              throw new ApiError(
                502,
                "turn_llm_call_budget_exhausted",
                "本轮模型调用已达到上限，本次回复尚未发送，请重试。",
              );
            }
            this.purposes.push(input.purpose);
            return target.generateObject(input);
          };
        }
        // Methods/getters keep the captured service as their private-field receiver.
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === "function"
          ? (value as (...args: unknown[]) => unknown).bind(target)
          : value;
      },
    });
  }
}
