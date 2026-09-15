import type {
  LlmProviderView,
  LlmPurpose,
  LlmSelection,
  LlmProbeResult,
} from "@personasim/contracts";
import { LlmPurposeSchema } from "@personasim/contracts";
import { ApiError } from "../api/types";

export const PLATFORM_PROVIDER_ID = "hosted";
export const DEFAULT_USER_CONTEXT_TOKENS = 64_000;
export const IMAGE_PLATFORM_NOTICE =
  "文本功能将使用你配置的 API；图片生成暂时使用平台模型，并消耗平台额度。你可以稍后单独修改。";
const PURPOSE_LABELS = {
  compile_character: "角色创建",
  character_interview: "角色访谈",
  character_portrait: "人物小传",
  character_refinement: "人物设定修订",
  import_character: "角色导入",
  plan_schedule: "生活规划",
  chat_turn: "日常聊天",
  repair_chat_turn: "聊天回复修复",
  review_reply_goal: "回复目标复核",
  rewrite_reply_goal: "回复目标改写",
  rewrite_reply_affinity: "关系表达调整",
  enrich_activity: "活动细节补全",
  compose_proactive_message: "主动消息",
  checkpoint_autobiography: "记忆整理与自传",
  letter_reply: "书信回复",
  diary_generation: "日记生成",
  diary_review: "日记审核",
};
export const purposeLabels: Record<LlmPurpose, string> = PURPOSE_LABELS;

export function allTextBindings(
  selection: LlmSelection,
): Record<LlmPurpose, LlmSelection> {
  return Object.fromEntries(
    LlmPurposeSchema.options.map((purpose) => [purpose, selection]),
  ) as Record<LlmPurpose, LlmSelection>;
}

export function modelFundingLabel(
  selection: LlmSelection | null | undefined,
): string {
  return !selection || selection.providerId === PLATFORM_PROVIDER_ID
    ? "平台额度"
    : "自己的 API · 不扣平台模型积分";
}

export function isUserProvider(provider: LlmProviderView): boolean {
  return provider.id !== PLATFORM_PROVIDER_ID && provider.source === "managed";
}

export function redactModelText(
  value: string,
  secret: string | undefined,
): string {
  const key = secret?.trim();
  if (!key) return value;
  return [key, encodeURIComponent(key)].reduce(
    (text, token) => text.replaceAll(token, "••••••••"),
    value,
  );
}

export function safeModelSetupError(
  error: unknown,
  secret: string | undefined,
): Error {
  if (error instanceof ApiError)
    return new ApiError({
      code: error.code,
      status: error.status,
      message: redactModelText(error.message, secret),
      issues: error.issues.map((issue) => ({
        path: redactModelText(issue.path, secret),
        message: redactModelText(issue.message, secret),
      })),
    });
  return new Error(
    redactModelText(
      error instanceof Error ? error.message : "请求未完成，请检查网络后重试。",
      secret,
    ),
  );
}

export function redactModelProbe(
  probe: LlmProbeResult,
  secret: string | undefined,
): LlmProbeResult {
  const stage = (value: LlmProbeResult["text"]) => ({
    ...value,
    ...(value.reply === undefined
      ? {}
      : { reply: redactModelText(value.reply, secret) }),
    ...(value.error === undefined
      ? {}
      : { error: redactModelText(value.error, secret) }),
  });
  return {
    ...probe,
    modelId: redactModelText(probe.modelId, secret),
    text: stage(probe.text),
    structured: stage(probe.structured),
  };
}
