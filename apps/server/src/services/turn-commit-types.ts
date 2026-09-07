import type { MemoryRecallRuntimeDiagnostic } from "@personasim/contracts";
import type { EffectivePersonaSnapshot } from "@personasim/contracts";

import type { StoredMessage } from "../db/store.js";
import type { SimulationCapabilities } from "../domain/capabilities.js";
import type {
  CharacterSpec,
  RuntimeState,
  ScheduleItem,
} from "../domain/schemas.js";
import type { CreateRetrievalRunInput } from "../repositories/retrieval-run-repository.js";
import type { PreparedConversationContext } from "./conversation-context-service.js";
import type { ResolvedTurn } from "./turn-decision-service.js";
import type { PreparedWorldEffectTurn } from "./world-effect-service.js";

export interface TurnCommitServiceOptions {
  scheduleNegotiationMode?: "off" | "legacy" | "shadow" | "enforced";
  lifePlanningMode?: "fuzzy" | "legacy_exact";
  personaRuntimeMode?: "off" | "shadow" | "enforced";
}

export interface ChatTurnCommand {
  agentId: string;
  clientMessageId: string;
  text: string;
}

export interface TurnCommitInput {
  sessionId: string;
  command: ChatTurnCommand;
  spec: CharacterSpec;
  effectivePersona?: EffectivePersonaSnapshot;
  memoryRevision?: number;
  personaRuntimeDiagnostic?: unknown;
  nowUtc: string;
  userMessageId: string;
  retrievalRun?: CreateRetrievalRunInput;
  assistantMessageId: string;
  capabilities: SimulationCapabilities;
  recallDiagnostic?: MemoryRecallRuntimeDiagnostic;
  promptSegmentTrace: unknown;
  companionContextDiagnostic?: unknown;
  preparedContext?: PreparedConversationContext;
  turn: ResolvedTurn;
  world: PreparedWorldEffectTurn;
}

export type ChatTurnResult = {
  idempotentReplay: boolean;
  userMessage: StoredMessage;
  assistantMessage: StoredMessage;
  scheduleChanges: ScheduleItem[];
  state: RuntimeState;
  memoryRecall?: MemoryRecallRuntimeDiagnostic;
  decision: {
    reasonCode: string;
    reasonSummary: string;
    toneTags: string[];
    deliveryMode: "single_block" | "sequential";
    chunks: string[];
  };
};
