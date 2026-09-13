import { DateTime } from "luxon";
import { z } from "zod";
import {
  DiaryDateSchema,
  DiaryDraftSchema,
  DiaryMonthSchema,
  DiaryVolumesQuerySchema,
  GenerateDiaryInputSchema,
  type DiaryDraft,
  type CharacterSpec,
  type DiaryEntry,
  type DiaryVolumesQuery,
  type GenerateDiaryInput,
} from "@personasim/contracts";
import type { DatabaseStore } from "../db/store.js";
import { ApiError, notFound } from "../domain/errors.js";
import type { Clock } from "../runtime/clock.js";
import {
  DiaryRepository,
  diaryHash,
  type DiaryMaterial,
  type DiaryStoredRevision,
} from "./diary-repository.js";
import { DIARY_SYSTEM, diaryPrompt, fixtureDiary } from "./diary-prompt.js";
import { InteractionAppraisalService } from "./interaction-appraisal-service.js";
import type { LlmService } from "./llm-service.js";
import { DiaryReviewService } from "./diary-review-service.js";

export interface DiaryServiceOptions {
  appraisals?: Pick<InteractionAppraisalService, "listForDiary">;
}

export class DiaryService {
  private readonly repository: DiaryRepository;
  private readonly appraisals: Pick<
    InteractionAppraisalService,
    "listForDiary"
  >;
  private readonly pending = new Map<
    string,
    { requestHash: string; work: Promise<DiaryEntry> }
  >();

  constructor(
    private readonly store: DatabaseStore,
    private readonly clock: Clock,
    private readonly llm: Pick<LlmService, "generateObject">,
    options: DiaryServiceOptions = {},
  ) {
    this.repository = new DiaryRepository(store);
    this.appraisals =
      options.appraisals ?? new InteractionAppraisalService(store);
  }

  volumes(query: DiaryVolumesQuery = {}) {
    const parsed = DiaryVolumesQuerySchema.parse(query);
    if (parsed.agentId && !this.store.getCharacterSummary(parsed.agentId))
      throw notFound("Character");
    return this.repository.volumes(parsed);
  }

  list(agentId: string, month?: string): DiaryEntry[] {
    if (!this.store.getCharacterSummary(agentId)) throw notFound("Character");
    if (month !== undefined) DiaryMonthSchema.parse(month);
    return this.repository
      .list(agentId, month)
      .map((entry) => this.present(entry));
  }

  sources(agentId: string, entryDate: string) {
    DiaryDateSchema.parse(entryDate);
    const head = this.repository.head(agentId, entryDate);
    if (!head || !head.currentRevision) throw notFound("Diary");
    const entry = this.repository.revision(head, head.currentRevision)!;
    const current = this.material(agentId, entryDate, head.timezone);
    const oldKeys = new Set(
      entry.sourceSnapshot.dependencies.map((source) => source.key),
    );
    return {
      entryId: head.id,
      revision: head.currentRevision,
      ...materialValidity(entry.sourceSnapshot, current),
      // Read current sources, so deleted or edited messages cannot reappear through a frozen snapshot.
      sources: current.sourceMessages
        .filter((message) => oldKeys.has(`message:${message.id}`))
        .map((message) => ({
          id: message.id,
          role: message.role,
          content: message.content,
          createdAtUtc: message.createdAtUtc,
          includedAsDaySource: message.includedAsDaySource,
        })),
    };
  }

  generate(agentId: string, raw: GenerateDiaryInput): Promise<DiaryEntry> {
    const input = GenerateDiaryInputSchema.parse(raw);
    const requestHash = diaryHash({ agentId, ...input });
    const key = `${agentId}:${input.clientRequestId}`;
    const inFlight = this.pending.get(key);
    if (inFlight) {
      if (inFlight.requestHash !== requestHash)
        return Promise.reject(
          new ApiError(
            409,
            "diary_request_conflict",
            "同一请求编号不能用于不同日期或版本。",
          ),
        );
      return inFlight.work;
    }
    const work = this.generateOnce(agentId, input, requestHash).finally(() => {
      this.pending.delete(key);
    });
    this.pending.set(key, { requestHash, work });
    return work;
  }

  private async generateOnce(
    agentId: string,
    input: GenerateDiaryInput,
    requestHash: string,
  ): Promise<DiaryEntry> {
    const character = this.store.getCharacterSpec(agentId);
    if (!character) throw notFound("Character");
    const existingRun = this.repository.run(agentId, input.clientRequestId);
    if (existingRun) {
      if (existingRun.requestHash !== requestHash)
        throw new ApiError(
          409,
          "diary_request_conflict",
          "同一请求编号不能用于不同日期或版本。",
        );
      if (
        existingRun.status === "succeeded" &&
        existingRun.resultRevision !== null
      ) {
        const head = this.repository.head(agentId, input.entryDate)!;
        return this.present(
          this.repository.revision(head, existingRun.resultRevision)!,
        );
      }
      if (existingRun.status === "pending")
        throw new ApiError(
          409,
          "diary_generation_in_progress",
          "这次日记生成尚未完成，请稍后查看或重新发起。",
        );
      throw new ApiError(
        existingRun.errorCode === "diary_source_changed" ? 409 : 502,
        existingRun.errorCode ?? "diary_generation_failed",
        "上次生成没有完成。已有日记保留；请使用新的请求重试。",
      );
    }
    const head = this.repository.head(agentId, input.entryDate);
    if (head && head.timezone !== input.timezone)
      throw new ApiError(
        409,
        "diary_timezone_conflict",
        "这一天的日记已按原时区归档，请沿用该时区。",
      );
    if (
      input.entryDate >
      DateTime.fromISO(this.clock.nowUtc(), {
        zone: input.timezone,
      }).toISODate()!
    )
      throw new ApiError(
        400,
        "diary_future_date",
        "未来的日期还没有可写的日记。",
      );
    const expectedRevision = input.expectedRevision ?? 0;
    if ((head?.currentRevision ?? 0) !== expectedRevision)
      throw new ApiError(
        409,
        "diary_revision_conflict",
        "这一天已有日记，请打开后选择更新。",
      );
    const material = this.material(agentId, input.entryDate, input.timezone);
    if (!material.sourceMessageIds.length)
      throw new ApiError(
        422,
        "diary_no_material",
        "这一天还没有和这位角色分享的对话。",
      );
    if (
      material.sourceMessages.length > 400 ||
      JSON.stringify(material).length > 120_000
    )
      throw new ApiError(
        422,
        "diary_too_much_material",
        "这一天的完整材料较多，暂时无法一次生成；已有日记保留。",
      );
    const run = this.repository.begin({
      agentId,
      ...input,
      expectedRevision,
      requestHash,
      sourceHash: material.sourceHash,
      nowUtc: this.clock.nowUtc(),
    });
    try {
      const liveModel = this.llm as Partial<LlmService>;
      const generationLlm =
        liveModel.captureDefault?.({
          purpose: "diary_generation",
          operationId: run.id,
          agentId,
        }) ?? this.llm;
      const prompt = diaryPrompt({
        entryDate: input.entryDate,
        timezone: input.timezone,
        character,
        material,
      });
      const draft = await this.generateDraft(
        agentId,
        run.id,
        prompt,
        material,
        input.entryDate,
        character,
        generationLlm,
      );
      this.store.transaction(() => {
        // Fence exact content, deletion, newly arrived replies and changing appraisal receipts.
        const current = this.material(agentId, input.entryDate, input.timezone);
        if (
          current.sourceHash !== material.sourceHash ||
          this.store.getCharacterSpec(agentId)?.version !== character.version
        )
          throw new ApiError(
            409,
            "diary_source_changed",
            "生成期间对话或角色资料发生变化，请重新生成。",
          );
        const model = generationLlm as Partial<LlmService>;
        this.repository.commit(run, draft, material, this.clock.nowUtc(), {
          promptVersion: "character_private_diary_v1",
          semanticReview: "diary_semantic_review_v1",
          characterVersion: character.version,
          characterSpecHash: diaryHash(character),
          modelName: model.modelName ?? "custom",
          providerName: model.providerName ?? "custom",
          profileName: model.profileName ?? "custom",
        });
      });
      const saved = this.repository.head(agentId, input.entryDate)!;
      return this.present(
        this.repository.revision(saved, saved.currentRevision)!,
      );
    } catch (error) {
      const apiError =
        error instanceof ApiError
          ? error
          : new ApiError(
              502,
              "diary_generation_failed",
              "日记暂时没有写成，已有版本已保留，请稍后重试。",
            );
      this.repository.fail(run.id, apiError.code, this.clock.nowUtc());
      throw apiError;
    }
  }

  private async generateDraft(
    agentId: string,
    runId: string,
    prompt: string,
    material: DiaryMaterial,
    entryDate: string,
    character: CharacterSpec,
    llm: Pick<LlmService, "generateObject">,
  ): Promise<DiaryDraft> {
    let issues: string[] = [];
    let draftToRepair: DiaryDraft | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      let candidate: DiaryDraft | undefined;
      try {
        const generated = await llm.generateObject({
          purpose: "diary_generation",
          agentId,
          system: DIARY_SYSTEM,
          prompt:
            attempt === 0
              ? prompt
              : JSON.stringify({
                  originalInput: JSON.parse(prompt) as unknown,
                  repair: {
                    issues,
                    ...(draftToRepair === undefined ? {} : { draftToRepair }),
                    instruction:
                      "仅修复列出的问题，保留未受影响的段落与角色观点，并返回完整合法JSON。若提供draftToRepair，必须以该原稿为基础修复；不可新增来源、虚构行为或捏造当时的内心。",
                  },
                }),
          schema: DiaryDraftSchema,
          maxRetries: 0,
          maxOutputTokens: 4_000,
          operationId: `${runId}:${attempt}`,
          fixture: fixtureDiary(material),
        });
        const parsed = DiaryDraftSchema.safeParse(generated);
        if (parsed.success) draftToRepair = parsed.data;
        issues = parsed.success
          ? validateDiaryDraft(parsed.data, material)
          : parsed.error.issues.map((issue) => issue.message);
        if (parsed.success && issues.length === 0) candidate = parsed.data;
      } catch (error) {
        if (error instanceof z.ZodError)
          issues = error.issues.map((issue) => issue.message);
        else if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "INVALID_STRUCTURED_OUTPUT"
        )
          issues = [
            "生成结果不是有效的日记JSON，请严格遵守title与paragraphs格式。",
          ];
        else throw error;
      }
      if (candidate) {
        // Semantic review has its own failure boundary. A broken reviewer must never
        // become an implicit approval or trigger blind re-generation.
        let review;
        try {
          review = await new DiaryReviewService(llm).review({
            agentId,
            operationId: `${runId}:review:${attempt}`,
            entryDate,
            character,
            material,
            draft: candidate,
          });
        } catch {
          throw new ApiError(
            502,
            "diary_review_failed",
            "日记审阅暂时没有完成，已有版本已保留，请稍后重试。",
          );
        }
        if (review.valid) return candidate;
        issues = review.issues.length
          ? review.issues
          : ["日记未通过事实与角色主观视角校验，请依据原始来源重写。"];
      }
    }
    throw new ApiError(
      422,
      "diary_generation_invalid",
      "生成的日记未通过格式或来源校验，已有版本已保留。",
      issues.slice(0, 8),
    );
  }

  private material(
    agentId: string,
    entryDate: string,
    timezone: string,
  ): DiaryMaterial {
    const day = DateTime.fromISO(entryDate, { zone: timezone }).startOf("day");
    if (!day.isValid || day.toISODate() !== entryDate)
      throw new ApiError(
        400,
        "diary_invalid_date",
        "该时区不存在这个本地日期。",
      );
    const fromUtc = day.toUTC().toISO()!;
    const toUtc = day.plus({ days: 1 }).toUTC().toISO()!;
    return this.repository.material(
      agentId,
      fromUtc,
      toUtc,
      this.appraisals.listForDiary({ agentId, fromUtc, toUtc }),
    );
  }

  private present(entry: DiaryStoredRevision): DiaryEntry {
    const current = this.material(
      entry.agentId,
      entry.entryDate,
      entry.timezone,
    );
    return {
      id: entry.id,
      agentId: entry.agentId,
      entryDate: entry.entryDate,
      timezone: entry.timezone,
      title: entry.title,
      body: entry.body,
      revision: entry.revision,
      createdAtUtc: entry.createdAtUtc,
      updatedAtUtc: entry.revisionCreatedAtUtc,
      sourceMessageIds: entry.sourceSnapshot.sourceMessageIds,
      ...materialValidity(entry.sourceSnapshot, current),
    };
  }
}

function materialValidity(
  previous: DiaryMaterial,
  current: DiaryMaterial,
): Pick<DiaryEntry, "validity" | "hasNewMaterial"> {
  const keys = new Map(
    current.dependencies.map((source) => [source.key, source.hash]),
  );
  const previousKeys = new Set(
    previous.dependencies.map((source) => source.key),
  );
  return {
    validity: previous.dependencies.every(
      (source) => keys.get(source.key) === source.hash,
    )
      ? "current"
      : "source_changed",
    hasNewMaterial: current.dependencies.some(
      (source) => !previousKeys.has(source.key),
    ),
  };
}

function validateDiaryDraft(
  draft: DiaryDraft,
  material: DiaryMaterial,
): string[] {
  const allowed = new Set(material.sourceMessageIds);
  const issues: string[] = [];
  draft.paragraphs.forEach((paragraph, index) => {
    if (paragraph.sourceMessageIds.some((id) => !allowed.has(id)))
      issues.push(`paragraphs[${index}]包含不在当天用户分享中的来源ID。`);
    if (
      new Set(paragraph.sourceMessageIds).size !==
      paragraph.sourceMessageIds.length
    )
      issues.push(`paragraphs[${index}]来源ID重复。`);
  });
  return issues;
}
