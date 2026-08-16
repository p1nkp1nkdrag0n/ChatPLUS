export type SimulationTier = "lightweight" | "daily" | "high_fidelity";

export type CharacterStatus = "draft" | "published" | "archived";

export interface CharacterSummary {
  id: string;
  name: string;
  workOrRole: string;
  tier: SimulationTier;
  status: CharacterStatus;
  sourceType: "original" | "imported_character";
  version: number;
  updatedAtUtc: string;
  currentActivity?: string | null;
  nextActivityAtUtc?: string | null;
}

export interface ProvenanceRule {
  origin:
    | "user_spec"
    | "canon_extract"
    | "model_inference"
    | "synthetic_extension"
    | "runtime_simulation";
  sourceRefs: string[];
  confidence?: number;
  canonicality?: string;
}

export interface TraitRule extends ProvenanceRule {
  id: string;
  name: string;
  description: string;
  strength: number;
  triggers: string[];
  exceptions: string[];
}

export interface ValueRule extends ProvenanceRule {
  id: string;
  name: string;
  priority: number;
  description: string;
  exceptions: string[];
}

export interface CharacterSpec {
  id: string;
  version: number;
  status: CharacterStatus;
  tier: SimulationTier;
  sourceType: "original" | "imported_character";
  identity: {
    name: string;
    workOrRole: string;
    worldSetting: string;
    selfDescription: string;
    timezone: string;
  };
  persona: {
    traits: TraitRule[];
    values: ValueRule[];
    contradictions: Array<{
      id: string;
      sideA: string;
      sideB: string;
      triggerConditions: string[];
      resolutionPattern: string;
      origin: ProvenanceRule["origin"];
      sourceRefs?: string[];
    }>;
    goals: Array<{
      id: string;
      title: string;
      description: string;
      priority: number;
    }>;
    preferences: Array<Record<string, unknown>>;
    boundaries: Array<Record<string, unknown>>;
  };
  dialogue: Record<string, unknown>;
  userRelationship: Record<string, unknown>;
  routines: Array<Record<string, unknown>>;
  schedulePolicy: Record<string, unknown> & { enabled?: boolean };
  proactivePolicy: Record<string, unknown> & { enabled?: boolean };
  knowledge: Record<string, unknown>;
  sources: Array<Record<string, unknown>>;
  lockedPaths: string[];
  createdAtUtc: string;
  updatedAtUtc: string;
}

export interface CharacterDetail {
  character: CharacterSpec;
  draft?: CharacterSpec;
  spec?: CharacterSpec;
  summary?: Record<string, unknown>;
  sources?: Array<Record<string, unknown>>;
}

export interface RuntimeState {
  agentId: string;
  asOfUtc: string;
  moodValence: number;
  moodArousal: number;
  energy: number;
  stress: number;
  socialBattery: number;
  focus: number;
  currentActivityId?: string | null;
  locationContext?: string | null;
  relationship: {
    closeness: number;
    trust: number;
    familiarity: number;
    recentInteractionValence: number;
  };
  revision: number;
}

export type ScheduleStatus =
  "planned" | "in_progress" | "completed" | "partial" | "skipped" | "cancelled";

export interface ScheduleItem {
  id: string;
  agentId: string;
  title: string;
  description: string;
  category: string;
  startAtUtc: string;
  endAtUtc: string;
  timezone: string;
  status: ScheduleStatus;
  rigidity: "fixed" | "committed" | "flexible" | "filler";
  priority: number;
  source: string;
  adherenceProbability: number;
  narrativeImportance: number;
  shareable: boolean;
  revision: number;
}

export interface ChatSession {
  id: string;
  agentId: string;
  createdAtUtc: string;
  updatedAtUtc: string;
}

export interface ChatMessage {
  id: string;
  sessionId: string;
  agentId: string;
  role: "user" | "assistant" | "system";
  text: string;
  chunks?: string[];
  deliveryMode?: "single_block" | "sequential";
  kind?: "normal" | "proactive" | "fallback";
  triggerEventId?: string | null;
  createdAtUtc: string;
}

export interface TimelineEvent {
  id: string;
  type: string;
  title: string;
  summary: string;
  occurredAtUtc: string;
  metadata?: Record<string, unknown>;
}

export interface AppSettings {
  llmProvider: "fixture" | "openai-compatible";
  model: string;
  baseUrl: string;
  hasApiKey: boolean;
  clockMode: "system" | "fake";
  locale: string;
  defaultTimezone: string;
}

export interface ApiIssue {
  path: string;
  message: string;
}

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly issues: ApiIssue[];
  readonly requestId: string | undefined;

  constructor(input: {
    code: string;
    message: string;
    status: number;
    issues?: ApiIssue[];
    requestId?: string;
  }) {
    super(input.message);
    this.name = "ApiError";
    this.code = input.code;
    this.status = input.status;
    this.issues = input.issues ?? [];
    this.requestId = input.requestId;
  }
}
