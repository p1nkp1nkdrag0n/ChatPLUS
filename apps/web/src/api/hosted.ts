import { request } from "./client";
import { ApiError } from "./types";
import {
  hostedRequestHeaders,
  notifyHostedSessionExpired,
} from "../lib/hostedSession";

export interface HostedInfo {
  hosted: boolean;
  surface?: "user" | "admin";
  csrfToken?: string;
  consentVersion?: string;
  registrationEnabled?: boolean;
  bootstrapRequired?: boolean;
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
export interface HostedMe {
  user: HostedUser;
  wallet: HostedWallet;
  csrfToken: string;
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
export interface HostedModel {
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
  keyConfigured: boolean;
}
export type HostedModelInput = Omit<
  HostedModel,
  "revision" | "keyConfigured"
> & { apiKey?: string };
export interface HostedUsage {
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
}
export interface HostedAttempt {
  id: string;
  userId?: string;
  operationId: string;
  purpose: string;
  status: "reserved" | "sent" | "settled" | "released" | "unknown";
  costMicros: number | null;
  maximumCostMicros?: number;
  usage: HostedUsage | null;
  displayName?: string;
  modelSnapshot?: HostedModel;
  reason?: string | null;
  createdAtUtc: string;
}
export interface HostedLedgerEntry {
  id: string;
  userId?: string;
  kind: string;
  deltaMicros: number;
  balanceAfterMicros?: number;
  reason?: string | null;
  note?: string | null;
  createdAtUtc: string;
}
export interface HostedBilling {
  wallet?: HostedWallet;
  attempts: HostedAttempt[];
  entries: HostedLedgerEntry[];
}
export interface HostedSessionBilling {
  turns: Record<string, HostedAttempt[]>;
}
export interface HostedResearchRecord {
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
export interface HostedOverview {
  users: number;
  activeUsers: number;
  bannedUsers: number;
  totalBalanceMicros: number;
  totalHeldMicros: number;
  chargedMicros: number;
  requestCount: number;
  pendingReconciliations: number;
  calls?: { active: number; queued: number; activeImages: number };
}
export interface HostedAuditEntry {
  id: string;
  actorId: string;
  action: string;
  targetId: string | null;
  createdAtUtc: string;
}
export interface HostedStorage {
  controlBytes: number;
  controlWalBytes: number;
  researchBytes: number;
  researchWalBytes: number;
  diskAvailableBytes: number | null;
}
export interface ResearchFilters {
  userId?: string;
  operationId?: string;
  sessionId?: string;
  from?: string;
  to?: string;
  kind?: string;
  modelId?: string;
  purpose?: string;
  offset?: string;
}
export type PublicHostedModel = Pick<
  HostedModel,
  | "displayName"
  | "kind"
  | "inputMicrosPerMillion"
  | "outputMicrosPerMillion"
  | "cacheReadMicrosPerMillion"
  | "cacheWriteMicrosPerMillion"
  | "imagePointsMicros"
> & { publicModelId: string };
export interface AdminUser extends HostedUser {
  wallet: HostedWallet;
}

const prefix = "/api/hosted";
const admin = `${prefix}/admin`;
const json = (value: unknown) => JSON.stringify(value);
const query = (values: Record<string, string | undefined>) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values))
    if (value) params.set(key, value);
  return params.size ? `?${params}` : "";
};

export const hostedApi = {
  info: async (): Promise<HostedInfo> => {
    try {
      return await request<HostedInfo>(`${prefix}/info`);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404)
        return { hosted: false };
      throw error;
    }
  },
  me: () => request<HostedMe>(`${prefix}/me`),
  login: (input: { username: string; password: string }) =>
    request<HostedMe>(`${prefix}/auth/login`, {
      method: "POST",
      body: json(input),
    }),
  bootstrap: (input: { username: string; password: string }) =>
    request<HostedMe>(`${prefix}/auth/bootstrap`, {
      method: "POST",
      body: json(input),
    }),
  register: (input: {
    username: string;
    password: string;
    inviteCode: string;
  }) =>
    request<HostedMe>(`${prefix}/auth/register`, {
      method: "POST",
      body: json(input),
    }),
  logout: () =>
    request<void>(`${prefix}/auth/logout`, { method: "POST", body: "{}" }),
  password: (input: { currentPassword: string; newPassword: string }) =>
    request<HostedMe>(`${prefix}/auth/password`, {
      method: "POST",
      body: json(input),
    }),
  billing: (filters: { clientMessageId?: string; userId?: string } = {}) =>
    request<HostedBilling>(`${prefix}/billing${query(filters)}`),
  sessionBilling: (sessionId: string) =>
    request<HostedSessionBilling>(
      `${prefix}/billing/sessions/${encodeURIComponent(sessionId)}`,
    ),
  publicModels: () =>
    request<{ models: PublicHostedModel[] }>(`${prefix}/models`),
  overview: () => request<HostedOverview>(`${admin}/overview`),
  users: (search: string, status: string) =>
    request<{ users: AdminUser[] }>(
      `${admin}/users${query({ q: search, status })}`,
    ),
  updateUser: (
    id: string,
    input: {
      status?: HostedUser["status"];
      balanceMicros?: number;
      reason: string;
    },
  ) =>
    request<AdminUser>(`${admin}/users/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: json(input),
    }),
  resetPassword: (id: string, password: string) =>
    request<void>(`${admin}/users/${encodeURIComponent(id)}/reset-password`, {
      method: "POST",
      body: json({ password }),
    }),
  invitations: () =>
    request<{ invitations: HostedInvite[] }>(`${admin}/invitations`),
  createInvitation: (input: {
    label: string;
    initialBalanceMicros: number;
    maxUses: number;
    expiresAtUtc?: string;
  }) =>
    request<{ invitation: HostedInvite; code: string }>(
      `${admin}/invitations`,
      { method: "POST", body: json(input) },
    ),
  revokeInvitation: (id: string) =>
    request<void>(`${admin}/invitations/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: json({ disabled: true }),
    }),
  models: () => request<{ models: HostedModel[] }>(`${admin}/models`),
  saveModel: (input: HostedModelInput, existing: boolean) =>
    request<HostedModel>(
      `${admin}/models${existing ? `/${encodeURIComponent(input.routeId)}` : ""}`,
      { method: existing ? "PATCH" : "POST", body: json(input) },
    ),
  mappings: () =>
    request<{ mappings: Record<string, string> }>(`${admin}/purpose-mappings`),
  saveMappings: (mappings: Record<string, string>) =>
    request<{ mappings: Record<string, string> }>(`${admin}/purpose-mappings`, {
      method: "PATCH",
      body: json({ mappings }),
    }),
  adminBilling: (userId: string, status: string) =>
    request<HostedBilling>(`${admin}/billing${query({ userId, status })}`),
  reconcile: (
    id: string,
    input: {
      action: "charge" | "release";
      amountMicros?: number;
      reason: string;
    },
  ) =>
    request<void>(`${admin}/billing/${encodeURIComponent(id)}/reconcile`, {
      method: "POST",
      body: json(input),
    }),
  research: (filters: ResearchFilters) =>
    request<{ records: HostedResearchRecord[] }>(
      `${admin}/research${query({ ...filters })}`,
    ),
  researchDetail: (id: string) =>
    request<{ record: HostedResearchRecord; payload: unknown }>(
      `${admin}/research/${encodeURIComponent(id)}`,
    ),
  researchExport: async (filters: ResearchFilters): Promise<Blob> => {
    const path = `${admin}/research/export`;
    const response = await fetch(path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/x-ndjson",
        ...hostedRequestHeaders("POST", filters),
      },
      body: json(filters),
    });
    if (!response.ok) {
      notifyHostedSessionExpired(path, response.status);
      const payload = (await response.json().catch(() => ({}))) as {
        error?: { message?: string; code?: string };
      };
      throw new ApiError({
        code: payload.error?.code ?? "EXPORT_FAILED",
        message: payload.error?.message ?? "研究数据导出失败。",
        status: response.status,
        issues: [],
      });
    }
    return response.blob();
  },
  researchDelete: (id: string) =>
    request<void>(`${admin}/research/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  maintenance: () =>
    request<{
      limits: HostedLimits;
      audit?: HostedAuditEntry[];
      storage?: HostedStorage;
    }>(`${admin}/maintenance`),
  saveLimits: (limits: HostedLimits) =>
    request<{ limits: HostedLimits }>(`${admin}/maintenance`, {
      method: "PATCH",
      body: json({ limits }),
    }),
  backup: (passphrase: string) =>
    request<{ path: string; keyPath?: string; createdAtUtc: string }>(
      `${admin}/maintenance/backup`,
      { method: "POST", body: json({ passphrase }) },
    ),
};

export const hostedInfoKey = ["hosted", "info"] as const;
export const hostedMeKey = ["hosted", "me"] as const;
export function formatPoints(micros: number | undefined | null): string {
  return micros === undefined || micros === null
    ? "待确认"
    : (micros / 1_000_000).toLocaleString("zh-CN", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 6,
      });
}
export function pointsToMicros(value: string): number {
  if (!/^\d+(?:\.\d{1,6})?$/.test(value.trim()))
    throw new Error("请输入非负积分，最多保留 6 位小数。");
  const micros = Math.round(Number(value) * 1_000_000);
  if (!Number.isSafeInteger(micros)) throw new Error("积分数值过大。");
  return micros;
}
