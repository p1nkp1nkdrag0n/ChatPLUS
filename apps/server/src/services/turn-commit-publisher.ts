import type { StoredMessage } from "../db/store.js";
import type { ScheduleItem } from "../domain/schemas.js";
import type { SseHub } from "../sse/hub.js";
import type { PreparedWorldEffectTurn } from "./world-effect-service.js";
import type { ChatTurnCommand } from "./turn-commit-types.js";

export class TurnCommitPublisher {
  constructor(private readonly sse: SseHub) {}

  publish(input: {
    command: ChatTurnCommand;
    nowUtc: string;
    assistantMessage: StoredMessage;
    scheduleChanges: ScheduleItem[];
    world: PreparedWorldEffectTurn;
  }): void {
    this.sse.publish({
      type: "message.created",
      agentId: input.command.agentId,
      occurredAtUtc: input.nowUtc,
      data: input.assistantMessage,
    });
    if (input.scheduleChanges.length > 0) {
      this.sse.publish({
        type: "schedule.updated",
        agentId: input.command.agentId,
        occurredAtUtc: input.nowUtc,
        data: input.scheduleChanges,
      });
    }
    if (input.world.stateChanged) {
      this.sse.publish({
        type: "state.updated",
        agentId: input.command.agentId,
        occurredAtUtc: input.nowUtc,
        data: input.world.nextState,
      });
    }
  }
}
