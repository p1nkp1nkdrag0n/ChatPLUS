import { DateTime } from "luxon";

import type { PersonalLifeService } from "../services/personal-life-service.js";
import type { MemoryLifecycleService } from "../services/memory-lifecycle-service.js";
import type { ProactiveDeliveryService } from "../services/proactive-delivery-service.js";
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

  constructor(
    private readonly clock: Clock,
    private readonly sse: SseHub,
    private readonly actors: ActorQueue,
    private readonly settlements: SettlementService,
    private readonly logger: SchedulerLogger,
    private readonly personalLife?: Pick<
      PersonalLifeService,
      "ensureSelfInitiatedPlans"
    >,
    private readonly proactiveDelivery?: Pick<
      ProactiveDeliveryService,
      "deliverNext"
    >,
    private readonly memoryLifecycle?: Pick<
      MemoryLifecycleService,
      "maintainAgent"
    >,
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

  async tick(): Promise<void> {
    const nowUtc = this.clock.nowUtc();
    const bucket = DateTime.fromISO(nowUtc).toUTC().startOf("hour").toISO()!;
    const activeAgents = this.sse.getActiveAgentIds();
    await Promise.allSettled(
      activeAgents.map(async (agentId) => {
        try {
          await this.actors.runExclusive(agentId, async () => {
            await this.settlements.settleAndExtend(agentId, {
              toUtc: nowUtc,
              hourlyBucket: bucket,
            });
            this.personalLife?.ensureSelfInitiatedPlans(agentId);
            this.memoryLifecycle?.maintainAgent(agentId);
          });
          if (this.proactiveDelivery === undefined) {
            await this.actors.runExclusive(agentId, () =>
              this.settlements.deliverOneProactive(agentId),
            );
          } else {
            // ProactiveDeliveryService owns its own preflight/postflight actor
            // phases. Its optional model compose must run between them.
            await this.proactiveDelivery.deliverNext(agentId);
          }
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
