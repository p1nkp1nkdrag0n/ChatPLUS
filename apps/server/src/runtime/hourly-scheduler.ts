import { DateTime } from "luxon";

import type { PersonalLifeService } from "../services/personal-life-service.js";
import type { FuzzyLifeService } from "../services/fuzzy-life-service.js";
import type { MemoryLifecycleService } from "../services/memory-lifecycle-service.js";
import type { SettlementService } from "../services/settlement-service.js";
import type { SseHub } from "../sse/hub.js";
import type { ActorQueue } from "./actor-queue.js";
import type { Clock } from "./clock.js";

type SchedulerLogger = {
  error(bindings: Record<string, unknown>, message: string): void;
};

export class HourlyScheduler {
  private timer: NodeJS.Timeout | undefined;
  private stopped = true;
  private readonly running = new Set<Promise<void>>();

  constructor(
    private readonly clock: Clock,
    private readonly sse: SseHub,
    private readonly actors: ActorQueue,
    private readonly settlements: SettlementService | undefined,
    private readonly logger: SchedulerLogger,
    private readonly personalLife:
      Pick<PersonalLifeService, "ensureSelfInitiatedPlans"> | undefined,
    private readonly memoryLifecycle?: Pick<
      MemoryLifecycleService,
      "maintainAgent"
    >,
    private readonly life?: Pick<FuzzyLifeService, "advance">,
    private readonly lifePlanningMode:
      "fuzzy" | "legacy_exact" = "legacy_exact",
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.scheduleNextBoundary();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  async dispose(): Promise<void> {
    this.stop();
    await Promise.allSettled([...this.running]);
  }

  tick(): Promise<void> {
    const pass = this.runTick();
    this.running.add(pass);
    const completed = () => {
      this.running.delete(pass);
    };
    void pass.then(completed, completed);
    return pass;
  }

  private async runTick(): Promise<void> {
    const nowUtc = this.clock.nowUtc();
    const bucket = DateTime.fromISO(nowUtc).toUTC().startOf("hour").toISO()!;
    const activeAgents = this.sse.getActiveAgentIds();
    await Promise.allSettled(
      activeAgents.map(async (agentId) => {
        try {
          await this.actors.runExclusive(agentId, async () => {
            if (this.lifePlanningMode === "fuzzy") {
              if (this.life === undefined) {
                throw new Error(
                  "Fuzzy life mode requires a composed FuzzyLifeService.",
                );
              }
              this.life.advance(agentId, nowUtc);
            } else {
              if (
                this.settlements === undefined ||
                this.personalLife === undefined
              ) {
                throw new Error(
                  "Legacy hourly work requires legacy_exact services",
                );
              }
              await this.settlements.settleAndExtend(agentId, {
                toUtc: nowUtc,
                hourlyBucket: bucket,
              });
              this.personalLife?.ensureSelfInitiatedPlans(agentId);
            }
            this.memoryLifecycle?.maintainAgent(agentId);
          });
        } catch (error) {
          this.logger.error(
            {
              agentId,
              error: error instanceof Error ? error.message : String(error),
            },
            "hourly settlement failed",
          );
        }
      }),
    );
  }

  private scheduleNextBoundary(): void {
    if (this.stopped) return;
    const now = DateTime.fromISO(this.clock.nowUtc(), {
      setZone: true,
    }).toUTC();
    const next = now.plus({ hours: 1 }).startOf("hour");
    const delay = Math.max(100, next.toMillis() - now.toMillis());
    this.timer = setTimeout(() => {
      void this.tick().finally(() => this.scheduleNextBoundary());
    }, delay);
    this.timer.unref();
  }
}
