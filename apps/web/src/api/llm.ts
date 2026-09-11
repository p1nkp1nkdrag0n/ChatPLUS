import type {
  LlmCatalog,
  LlmDiscoveryResult,
  LlmProbeResult,
  LlmProviderInput,
  LlmProviderView,
  LlmSelection,
  LlmSessionModel,
  LlmTarget,
} from "@personasim/contracts";
import { ApiError } from "./types";

async function request<T>(
  path: string,
  method = "GET",
  input?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: {
      accept: "application/json",
      ...(input === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as {
      error?: {
        code?: string;
        message?: string;
        issues?: { path?: string; message?: string }[];
      };
    };
    throw new ApiError({
      code: payload.error?.code ?? "HTTP_ERROR",
      message: payload.error?.message ?? `请求失败（${response.status}）`,
      status: response.status,
      issues: (payload.error?.issues ?? []).map((issue) => ({
        path: issue.path ?? "",
        message: issue.message ?? "输入无效",
      })),
    });
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

const prefix = "/api/llm";
export const llmApi = {
  catalog: () => request<LlmCatalog>(`${prefix}/providers`),
  resetCredentials: () =>
    request<LlmCatalog>(`${prefix}/credentials/reset`, "POST", {
      confirm: "reset-provider-credentials",
    }),
  create: (input: LlmProviderInput) =>
    request<LlmProviderView>(`${prefix}/providers`, "POST", input),
  update: (id: string, input: LlmProviderInput) =>
    request<LlmProviderView>(
      `${prefix}/providers/${encodeURIComponent(id)}`,
      "PATCH",
      input,
    ),
  remove: (id: string) =>
    request<void>(`${prefix}/providers/${encodeURIComponent(id)}`, "DELETE"),
  importEnvironment: (providerId: string) =>
    request<LlmProviderView>(`${prefix}/providers/import-env`, "POST", {
      providerId,
    }),
  discover: (target: LlmTarget, signal?: AbortSignal) =>
    request<LlmDiscoveryResult>(
      `${prefix}/models/discover`,
      "POST",
      target,
      signal,
    ),
  test: (target: LlmTarget, signal?: AbortSignal) =>
    request<LlmProbeResult>(`${prefix}/test`, "POST", target, signal),
  latestTest: (providerId: string, modelId: string, signal?: AbortSignal) =>
    request<{ result: LlmProbeResult | null }>(
      `${prefix}/tests?${new URLSearchParams({ providerId, modelId })}`,
      "GET",
      undefined,
      signal,
    ),
  setDefault: (selection: LlmSelection, expectedRevision?: number) =>
    request<LlmCatalog>(`${prefix}/default`, "PATCH", {
      selection,
      ...(expectedRevision === undefined ? {} : { expectedRevision }),
    }),
  session: (id: string) =>
    request<LlmSessionModel>(`/api/sessions/${encodeURIComponent(id)}/model`),
  setSession: (id: string, selection: LlmSelection | null) =>
    request<LlmSessionModel>(
      `/api/sessions/${encodeURIComponent(id)}/model`,
      "PATCH",
      { selection },
    ),
};

export const llmCatalogKey = ["llm", "catalog"] as const;
export const sessionModelKey = (id: string) => ["llm", "session", id] as const;
