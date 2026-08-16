import { DateTime } from "luxon";

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
      activeAgents.map((agentId) =>
        this.actors.runExclusive(agentId, async () => {
          try {
            await this.settlements.settleAndExtend(agentId, {
              toUtc: nowUtc,
              hourlyBucket: bucket,
            });
            this.settlements.deliverOneProactive(agentId);
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
      ),
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
