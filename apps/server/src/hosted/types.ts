export class HostedError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HostedError";
  }
}

export interface HostedUser {
  id: string;
  username: string;
  role: "admin" | "user";
  status: "active" | "banned";
  mustChangePassword: boolean;
  createdAtUtc: string;
  updatedAtUtc: string;
  consentVersion: string | null;
  consentAtUtc: string | null;
}
export interface HostedWallet {
  userId: string;
  balanceMicros: number;
  reservedMicros: number;
  availableMicros: number;
}
export interface HostedInvite {
  id: string;
  label: string;
  maxUses: number;
  uses: number;
  initialBalanceMicros: number;
  expiresAtUtc: string | null;
  revokedAtUtc: string | null;
  createdAtUtc: string;
}
export interface HostedSession {
  id: string;
  userId: string;
  expiresAtUtc: string;
  createdAtUtc: string;
  lastSeenAtUtc: string;
}
export interface HostedModelSnapshot {
  routeId: string;
  revision: number;
  displayName: string;
  kind: "text" | "image";
  protocol: "openai-compatible" | "anthropic" | "gemini";
  baseUrl: string;
  modelId: string;
  inputMicrosPerMillion: number;
  outputMicrosPerMillion: number;
  cacheReadMicrosPerMillion: number;
  cacheWriteMicrosPerMillion?: number;
  maxOutputTokens: number;
  maxContextTokens?: number;
  imagePointsMicros?: number;
  imageSpecification?: string;
  enabled: boolean;
}
export type HostedModelInput = Omit<HostedModelSnapshot, "revision"> & {
  apiKey?: string;
};
/** Private server-only resolution; never send this object to a client. */
export interface HostedResolvedModel extends HostedModelSnapshot {
  apiKey: string;
}
export interface HostedUsage {
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  [key: string]: unknown;
}
export type HostedAttemptStatus =
  "reserved" | "sent" | "settled" | "released" | "unknown";
export interface HostedAttempt {
  id: string;
  userId: string;
  operationId: string;
  parentOperationId: string | null;
  sessionId: string | null;
  purpose: string;
  status: HostedAttemptStatus;
  maximumCostMicros: number;
  costMicros: number | null;
  modelSnapshot: HostedModelSnapshot;
  usage: HostedUsage | null;
  providerRequestId: string | null;
  reason: string | null;
  createdAtUtc: string;
  updatedAtUtc: string;
}
export interface HostedReservationInput {
  id: string;
  userId: string;
  operationId?: string;
  parentOperationId?: string;
  sessionId?: string;
  purpose: string;
  maximumCostMicros: number;
  modelSnapshot: HostedModelSnapshot;
}
export interface HostedAttemptResponse {
  status: number;
  body: string;
  providerRequestId?: string;
  headers?: Record<string, string>;
}
export interface HostedResearchInput {
  attemptId: string;
  kind: "request" | "response" | "image";
  payload: unknown;
}
export interface HostedAttemptImage {
  bytes: Uint8Array;
  mimeType: string;
  width: number;
  height: number;
  sha256: string;
}
export interface HostedResearchMetadata {
  id: string;
  attemptId: string | null;
  operationId: string;
  sessionId: string | null;
  userId: string;
  kind: "request" | "response" | "input" | "output" | "image";
  purpose: string;
  displayName: string;
  modelId: string;
  createdAtUtc: string;
  deletedAtUtc: string | null;
}
export interface HostedOperation {
  id: string;
  userId: string;
  method: string;
  path: string;
  inputHash: string;
  sessionId: string | null;
  clientMessageId: string | null;
  status: "running" | "completed" | "failed";
  statusCode: number | null;
  response?: unknown;
  createdAtUtc: string;
  updatedAtUtc: string;
}
export interface HostedLimits {
  registrationEnabled: boolean;
  callsEnabled: boolean;
  globalConcurrency: number;
  perUserConcurrency: number;
  maxQueuedCalls: number;
  maxRequestBytes: number;
  perUserDailyMicros: number;
  globalDailyMicros: number;
  researchRetentionDays: number;
  sessionDays: number;
}
export interface HostedAuditEntry {
  id: string;
  actorId: string;
  action: string;
  targetId: string | null;
  details: unknown;
  createdAtUtc: string;
}
