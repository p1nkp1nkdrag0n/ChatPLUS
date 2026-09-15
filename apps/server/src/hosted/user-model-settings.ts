import {
  LlmPurposeSchema,
  UserModelSettingsSchema,
  UserModelSetupInputSchema,
  UserModelSettingsUpdateInputSchema,
  type LlmPurpose,
  type LlmSelection,
  type UserModelSettings,
  type UserModelSetupInput,
  type UserModelSettingsUpdateInput,
} from "@personasim/contracts";
import type { DatabaseStore } from "../db/store.js";
import { ApiError } from "../domain/errors.js";
import type {
  LlmSettingsService,
  ResolvedLlmConfiguration,
} from "../services/llm-settings-service.js";

export class UserModelSettingsService {
  constructor(
    private readonly store: DatabaseStore,
    private readonly settings: LlmSettingsService,
    private readonly options: {
      initialOnboardingCompleted: boolean;
      validateImageSelection?: (selection: LlmSelection) => void;
    },
  ) {
    store.database
      .prepare(
        "INSERT OR IGNORE INTO user_model_settings(id,onboarding_completed,updated_at_utc) VALUES(1,?,?)",
      )
      .run(
        options.initialOnboardingCompleted ? 1 : 0,
        new Date().toISOString(),
      );
  }

  get(): UserModelSettings {
    const row = this.store.database
      .prepare(
        "SELECT revision,onboarding_completed,bindings_json,image_selection_json FROM user_model_settings WHERE id=1",
      )
      .get() as {
      revision: number;
      onboarding_completed: number;
      bindings_json: string;
      image_selection_json: string | null;
    };
    return UserModelSettingsSchema.parse({
      revision: row.revision,
      onboardingCompleted: row.onboarding_completed === 1,
      bindings: JSON.parse(row.bindings_json) as unknown,
      imageSelection: row.image_selection_json
        ? (JSON.parse(row.image_selection_json) as unknown)
        : null,
    });
  }

  completeSetup(raw: UserModelSetupInput): UserModelSettings {
    const input = UserModelSetupInputSchema.parse(raw);
    return this.store.database
      .transaction(() => {
        const current = this.get();
        this.assertRevision(current.revision, input.expectedRevision);
        if (current.onboardingCompleted)
          throw new ApiError(
            409,
            "model_setup_completed",
            "首次设置已完成，请在模型设置中修改。",
          );
        if (
          (input.mode === "platform") !==
          (input.selection.providerId === "hosted")
        )
          throw new ApiError(
            400,
            "invalid_model_source",
            "模型来源与选择不一致。",
          );
        this.validateTextSelection(input.selection);
        const bindings = Object.fromEntries(
          LlmPurposeSchema.options.map((purpose) => [purpose, input.selection]),
        );
        return this.save({ ...current, onboardingCompleted: true, bindings });
      })
      .immediate();
  }

  update(raw: UserModelSettingsUpdateInput): UserModelSettings {
    const input = UserModelSettingsUpdateInputSchema.parse(raw);
    return this.store.database
      .transaction(() => {
        const current = this.get();
        this.assertRevision(current.revision, input.expectedRevision);
        for (const purpose of LlmPurposeSchema.options) {
          const selection = input.bindings[purpose];
          if (selection === undefined) continue;
          if (selection === null) delete current.bindings[purpose];
          else {
            this.validateTextSelection(selection);
            current.bindings[purpose] = selection;
          }
        }
        if (input.imageSelection !== undefined) {
          if (input.imageSelection) {
            if (input.imageSelection.providerId !== "hosted")
              throw new ApiError(
                400,
                "platform_image_required",
                "图片生成暂时仅支持平台模型。",
              );
            if (!this.options.validateImageSelection)
              throw new ApiError(
                409,
                "image_model_unavailable",
                "图片模型暂不可用。",
              );
            this.options.validateImageSelection(input.imageSelection);
          }
          current.imageSelection = input.imageSelection;
        }
        return this.save(current);
      })
      .immediate();
  }

  resolve(
    purpose: LlmPurpose,
    selection?: LlmSelection,
  ): ResolvedLlmConfiguration | undefined {
    const effective =
      (purpose === "chat_turn" ? selection : undefined) ??
      this.get().bindings[purpose];
    return effective ? this.validateTextSelection(effective) : undefined;
  }

  validateTextSelection(selection: LlmSelection): ResolvedLlmConfiguration {
    this.assertProvider(selection.providerId, true);
    const resolved = this.settings.resolve({
      providerId: selection.providerId,
      modelId: selection.modelId,
    });
    if (selection.providerId !== "hosted" && !resolved.apiKey.trim())
      throw new ApiError(
        409,
        "model_credential_missing",
        "此供应商的 API Key 尚未配置，请在模型设置中更新。",
      );
    return resolved;
  }

  assertProvider(id: string, allowPlatform = false): void {
    if (id === "hosted") {
      if (allowPlatform) return;
      throw new ApiError(
        403,
        "platform_provider_read_only",
        "平台供应商由服务器管理。",
      );
    }
    const row = this.store.database
      .prepare("SELECT id FROM llm_providers WHERE id=?")
      .get(id);
    if (!row)
      throw new ApiError(404, "provider_not_found", "未找到此账号的供应商。");
  }

  assertProviderMutationAllowed(
    id: string,
    nextModels?: ReadonlyArray<{ id: string }>,
  ): void {
    this.assertProvider(id);
    const bound = Object.values(this.get().bindings).find(
      (selection) =>
        selection?.providerId === id &&
        (nextModels === undefined ||
          !nextModels.some((model) => model.id === selection.modelId)),
    );
    if (bound)
      throw new ApiError(
        409,
        "provider_model_in_use",
        "此供应商或模型仍被功能使用，请先在模型设置中更换对应功能的模型。",
      );
  }

  private save(value: UserModelSettings): UserModelSettings {
    this.store.database
      .prepare(
        "UPDATE user_model_settings SET revision=revision+1,onboarding_completed=?,bindings_json=?,image_selection_json=?,updated_at_utc=? WHERE id=1",
      )
      .run(
        value.onboardingCompleted ? 1 : 0,
        JSON.stringify(value.bindings),
        value.imageSelection ? JSON.stringify(value.imageSelection) : null,
        new Date().toISOString(),
      );
    // Keep older session/catalog readers aligned with the per-purpose chat default.
    this.store.database
      .prepare("UPDATE llm_settings SET default_selection_json=? WHERE id=1")
      .run(
        value.bindings.chat_turn
          ? JSON.stringify(value.bindings.chat_turn)
          : null,
      );
    return this.get();
  }

  private assertRevision(actual: number, expected: number): void {
    if (actual !== expected)
      throw new ApiError(
        409,
        "model_settings_changed",
        "模型设置已在其他设备更新，请刷新后重试。",
      );
  }
}
