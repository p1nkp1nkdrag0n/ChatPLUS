import { createHash } from "node:crypto";

import {
  CorrespondenceMailboxResponseSchema,
  CreateLetterDraftRequestSchema,
  KeepsakeDetailResponseSchema,
  KeepsakePageResponseSchema,
  LetterDetailResponseSchema,
  OpenLetterResponseSchema,
  RelationshipArchivePageResponseSchema,
  RelationshipRecapSchema,
  RelationshipShareProjectionSchema,
  type JsonValue,
} from "@personasim/contracts";
import type { ZodType } from "zod";
import { calculateFixedTransitArrivalUtc } from "@personasim/features";

import type { PersonaSimApp } from "../app.js";

export interface ProductLifeFeatureCheck {
  id: string;
  passed: boolean | null;
  detail: string;
}

export interface ProductLifePublicMessage {
  sourceId: string;
  authoredDisplayDate: string;
  role: "user" | "assistant";
  channel: "letter" | "product_status";
  content: string;
}

export interface ProductLifeFeatureResult {
  status: "completed" | "failed";
  letterId?: string;
  replyLetterId?: string;
  evidence: JsonValue;
  checks: ProductLifeFeatureCheck[];
  /** Only these messages may enter the simulated user's public history. */
  publicMessages: ProductLifePublicMessage[];
}

interface HttpEvidence {
  method: string;
  path: string;
  statusCode: number;
  body: unknown;
}

/** Sends model-authored text through the product draft/update/seal contracts. */
export async function dispatchProductLifeLetter(
  app: PersonaSimApp,
  agentId: string,
  input: { requestId: string; subject: string; body: string },
): Promise<ProductLifeFeatureResult> {
  const draftInput = CreateLetterDraftRequestSchema.parse({
    clientRequestId: `${input.requestId}-draft`,
    subject: input.subject,
    body: input.body,
  });
  const action = recorder(app, "dispatch_letter");
  let letterId: string | undefined;
  try {
    const draft = await action.json(
      "POST",
      `/api/agents/${agentId}/letters`,
      LetterDetailResponseSchema,
      draftInput,
    );
    letterId = draft.letter.id;
    action.check(
      "draft_created",
      draft.letter.status === "draft",
      "The real create API returns an editable user draft.",
    );
    const updated = await action.json(
      "PATCH",
      `/api/letters/${letterId}`,
      LetterDetailResponseSchema,
      { subject: input.subject, body: input.body },
    );
    action.check(
      "draft_content_preserved",
      updated.subject === input.subject && updated.body === input.body,
      "The product update API preserves the model-authored subject and body.",
    );
    const sealed = await action.json(
      "POST",
      `/api/letters/${letterId}/seal`,
      LetterDetailResponseSchema,
      { clientRequestId: `${input.requestId}-seal` },
    );
    action.check(
      "letter_in_transit",
      sealed.letter.status === "in_transit" && !sealed.letter.canEdit,
      "The product seal API places the immutable user letter in transit.",
    );
    const timezone =
      app.personasim.store.getCharacterSpec(agentId)?.identity.timezone;
    action.check(
      "five_day_outbound_transit",
      timezone !== undefined &&
        sealed.letter.dispatchedAtUtc !== undefined &&
        sealed.letter.arrivalDueAtUtc ===
          calculateFixedTransitArrivalUtc(
            sealed.letter.dispatchedAtUtc,
            timezone,
            "outbound",
          ),
      "The current fixed_5d_v1 policy requires five local calendar days for the outbound leg.",
    );
    action.publicMessages.push({
      sourceId: updated.letter.id,
      authoredDisplayDate: sealed.letter.authoredDisplayDate,
      role: "user",
      channel: "letter",
      content: `【我已寄出的信】\n${updated.subject ?? ""}\n${updated.body ?? ""}`,
    });
  } catch (error) {
    action.fail(error);
  }
  return action.finish({ ...(letterId === undefined ? {} : { letterId }) });
}

/** Clock advancement remains the caller's responsibility. Reads trigger normal lazy catch-up. */
export async function inspectProductLifeCorrespondence(
  app: PersonaSimApp,
  agentId: string,
  input: {
    incomingLetterId: string;
    probeEarlyOpen?: boolean;
    openReply?: boolean;
  },
): Promise<ProductLifeFeatureResult> {
  const action = recorder(app, "inspect_correspondence");
  let replyLetterId: string | undefined;
  try {
    const mailbox = await action.json(
      "GET",
      `/api/agents/${agentId}/correspondence`,
      CorrespondenceMailboxResponseSchema,
    );
    const incoming = await action.json(
      "GET",
      `/api/letters/${input.incomingLetterId}`,
      LetterDetailResponseSchema,
    );
    action.check(
      "incoming_owned_by_agent",
      mailbox.letters.some((letter) => letter.id === input.incomingLetterId),
      "The selected incoming letter is present in this agent's mailbox.",
    );
    const repository = app.personasim.correspondenceRepository;
    const snapshot = repository.getSnapshotForIncomingLetter(
      input.incomingLetterId,
    );
    const generation = repository.findCommittedRun(input.incomingLetterId);
    const task = repository.findLatestGenerationTask(input.incomingLetterId);
    const reply = repository.findReplyToLetter(input.incomingLetterId);
    action.internalEvidence.snapshot = snapshot ?? null;
    action.internalEvidence.generation =
      generation === undefined
        ? null
        : {
            id: generation.id,
            status: generation.status,
            snapshotId: generation.snapshotId,
            model: generation.model,
            provider: generation.provider,
          };
    action.internalEvidence.generationTask =
      task === undefined
        ? null
        : {
            id: task.id,
            kind: task.kind,
            status: task.status,
            dueAtUtc: task.dueAtUtc,
          };
    const arrived =
      incoming.letter.arrivalDueAtUtc !== undefined &&
      Date.parse(mailbox.serverTimeUtc) >=
        Date.parse(incoming.letter.arrivalDueAtUtc);
    if (!arrived) {
      action.check(
        "outbound_wait_preserved",
        incoming.letter.status === "in_transit" &&
          snapshot === undefined &&
          reply === undefined &&
          generation === undefined,
        "Before outbound arrival, no frozen authoring snapshot or reply may exist.",
      );
    } else {
      action.check(
        "incoming_delivered_and_snapshotted",
        incoming.letter.status === "read" && snapshot !== undefined,
        "Lazy catch-up must read the arrived incoming letter and freeze its context.",
      );
      action.check(
        "snapshot_effective_time",
        snapshot?.effectiveAtUtc === incoming.letter.arrivalDueAtUtc,
        "The frozen snapshot is effective at the historical arrival time, even after a late catch-up.",
      );
      action.check(
        "reply_generation_committed",
        generation !== undefined && reply !== undefined,
        "An arrived incoming letter produces a committed reply through the real generation service.",
      );
    }
    if (reply !== undefined) {
      replyLetterId = reply.id;
      const detail = await action.json(
        "GET",
        `/api/letters/${reply.id}`,
        LetterDetailResponseSchema,
      );
      action.internalEvidence.replyStorage = {
        letterId: reply.id,
        encryptedEnvelopePresent: reply.encryptedBody !== undefined,
        plaintextBodyPresent: reply.body !== undefined,
        contentHash: reply.contentHash,
        effectiveAuthorTimeUtc: reply.effectiveAuthorTimeUtc,
        arrivalDueAtUtc: reply.arrivalDueAtUtc,
      };
      action.check(
        "reply_encrypted_at_rest",
        reply.encryptedBody !== undefined && reply.body === undefined,
        "The repository exposes an encrypted envelope and no persisted reply plaintext; ciphertext itself is omitted from artifacts.",
      );
      if (detail.letter.status !== "read") {
        action.check(
          "unopened_reply_plaintext_hidden",
          detail.body === undefined &&
            detail.subject === undefined &&
            detail.salutation === undefined &&
            detail.letter.previewText === undefined,
          "An unopened reply's ordinary detail and mailbox projection disclose no letter text.",
        );
      }
      if (input.probeEarlyOpen === true && !detail.letter.canOpen) {
        const early = await action.request(
          "POST",
          `/api/letters/${reply.id}/open`,
          {},
        );
        action.check(
          "early_reply_open_rejected",
          early.statusCode === 409 && !hasProperty(early.body, "body"),
          "The real open API rejects the in-transit reply and returns no plaintext.",
        );
      }
      if (input.openReply === true) {
        if (!detail.letter.canOpen) {
          action.check(
            "reply_ready_to_open",
            false,
            "The requested reply has not reached its return arrival time; no open was attempted.",
          );
        } else {
          const opened = await action.json(
            "POST",
            `/api/letters/${reply.id}/open`,
            OpenLetterResponseSchema,
            {},
          );
          action.check(
            "reply_opened",
            opened.letter.status === "read" && opened.body.length > 0,
            "Only the successful product open operation decrypts and exposes the reply.",
          );
          action.publicMessages.push({
            sourceId: opened.letter.id,
            authoredDisplayDate: opened.letter.authoredDisplayDate,
            role: "assistant",
            channel: "letter",
            content: [
              "【我已收到并打开的回信】",
              opened.subject,
              opened.salutation,
              opened.body,
              opened.closing,
              opened.signature,
              ...(opened.postscript === undefined ? [] : [opened.postscript]),
            ].join("\n"),
          });
        }
      }
    } else if (input.openReply === true) {
      action.check(
        "reply_available_to_open",
        false,
        "No reply was produced; no public reply text is invented.",
      );
    }
  } catch (error) {
    action.fail(error);
  }
  return action.finish({
    letterId: input.incomingLetterId,
    ...(replyLetterId === undefined ? {} : { replyLetterId }),
  });
}

/** Reads the real cabinet/archive/assets; never manufactures an eligible source. */
export async function inspectProductLifeArtifacts(
  app: PersonaSimApp,
  agentId: string,
  input: { letterId?: string; recapFromUtc?: string } = {},
): Promise<ProductLifeFeatureResult> {
  const action = recorder(app, "inspect_product_artifacts");
  try {
    const cabinet = await action.json(
      "GET",
      `/api/agents/${agentId}/keepsakes?limit=100`,
      KeepsakePageResponseSchema,
    );
    const archive = await action.json(
      "GET",
      `/api/agents/${agentId}/relationship-archive?limit=100`,
      RelationshipArchivePageResponseSchema,
    );
    action.internalEvidence.keepsakeOutcome =
      cabinet.items.length === 0
        ? {
            kind: "none_generated",
            explanation:
              "No keepsake is currently exposed by the normal cabinet API. Eligibility is not asserted; no source, significance or generation task was injected.",
          }
        : { kind: "generated", count: cabinet.items.length };
    action.check(
      "keepsake_observed",
      cabinet.items.length === 0 ? null : true,
      cabinet.items.length === 0
        ? "No qualifying ready keepsake was observed through normal product flow; this is not a failure or a claimed eligibility pass."
        : `The normal cabinet exposes ${cabinet.items.length} keepsake(s).`,
    );
    action.check(
      "archive_product_contract",
      true,
      `The product archive returns ${archive.items.length} evidence-linked entries.`,
    );
    for (const item of cabinet.items) {
      if (item.status !== "ready") continue;
      const detail = await action.json(
        "GET",
        `/api/keepsakes/${item.id}`,
        KeepsakeDetailResponseSchema,
      );
      for (const suffix of ["thumbnail", "asset"] as const) {
        const response = await app.inject({
          method: "GET",
          url: `/api/keepsakes/${item.id}/${suffix}`,
        });
        const bytes = response.rawPayload;
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        const primary = detail.assets.find(
          (asset) => asset.id === detail.keepsake.primaryAssetId,
        );
        const expectedHash =
          suffix === "thumbnail" ? primary?.thumbnailSha256 : primary?.sha256;
        action.http.push({
          method: "GET",
          path: `/api/keepsakes/${item.id}/${suffix}`,
          statusCode: response.statusCode,
          body: {
            contentType: response.headers["content-type"],
            bytes: bytes.length,
            sha256,
            etag: response.headers.etag,
          },
        });
        action.check(
          `keepsake_${suffix}_${item.id}`,
          response.statusCode === 200 &&
            String(response.headers["content-type"]).includes("image/webp") &&
            bytes.length > 0 &&
            sha256 === expectedHash,
          "The normal asset endpoint serves nonempty WebP bytes matching persisted SHA-256 metadata.",
        );
      }
    }
    if (input.recapFromUtc !== undefined) {
      const query = new URLSearchParams({
        fromUtc: input.recapFromUtc,
        toUtc: app.personasim.clock.nowUtc(),
        limit: "20",
      });
      const response = await action.request(
        "GET",
        `/api/agents/${agentId}/relationship-recap?${query}`,
      );
      if (response.statusCode === 200) {
        action.check(
          "relationship_recap_contract",
          RelationshipRecapSchema.safeParse(response.body).success,
          "The deterministic recap follows the product contract and cites durable sources.",
        );
      } else {
        action.check(
          "relationship_recap_available",
          response.statusCode === 404 ? null : false,
          `The recap API returned ${response.statusCode}; an empty recap is not synthesized.`,
        );
      }
    }
    const selectedLetterId =
      input.letterId ??
      archive.items.find((item) => item.entryType === "letter")?.letterId;
    const selectedKeepsake = cabinet.items.find(
      (item) => item.status === "ready",
    );
    if (selectedLetterId !== undefined || selectedKeepsake !== undefined) {
      const preview = await action.json(
        "POST",
        `/api/agents/${agentId}/relationship-share/preview`,
        RelationshipShareProjectionSchema,
        {
          templateVersion: "relationship-share-v1",
          ...(selectedLetterId === undefined
            ? {}
            : { letterId: selectedLetterId }),
          ...(selectedKeepsake === undefined
            ? {}
            : { keepsakeId: selectedKeepsake.id }),
          includeEnvelope: true,
          includePostmark: true,
          includeWaitingDays: true,
          includeKeepsake: selectedKeepsake !== undefined,
          includeExcerpt: false,
        },
      );
      action.check(
        "local_share_preview_without_letter_body",
        preview.exportMode === "local_png" &&
          preview.redactedExcerpt === undefined,
        "The local-only share preview includes explicitly selected public artifacts and no letter excerpt; nothing is uploaded or published.",
      );
    } else {
      action.check(
        "share_preview_has_source",
        null,
        "There is no real letter or keepsake to select; no source is fabricated.",
      );
    }
  } catch (error) {
    action.fail(error);
  }
  return action.finish();
}

function recorder(app: PersonaSimApp, kind: string) {
  const http: HttpEvidence[] = [];
  const checks: ProductLifeFeatureCheck[] = [];
  const publicMessages: ProductLifePublicMessage[] = [];
  const internalEvidence: Record<string, unknown> = {};
  const request = async (
    method: "GET" | "POST" | "PATCH",
    path: string,
    payload?: Record<string, unknown>,
  ): Promise<HttpEvidence> => {
    const response = await app.inject({
      method,
      url: path,
      ...(payload === undefined ? {} : { payload }),
    });
    let body: unknown;
    try {
      body = response.json();
    } catch {
      body = { invalidJsonResponse: true };
    }
    const item = { method, path, statusCode: response.statusCode, body };
    http.push(item);
    return item;
  };
  return {
    http,
    publicMessages,
    internalEvidence,
    request,
    async json<T>(
      method: "GET" | "POST" | "PATCH",
      path: string,
      schema: ZodType<T>,
      payload?: Record<string, unknown>,
    ): Promise<T> {
      const response = await request(method, path, payload);
      if (response.statusCode < 200 || response.statusCode >= 300)
        throw new Error(`${method} ${path}: HTTP ${response.statusCode}`);
      return schema.parse(response.body);
    },
    check(id: string, passed: boolean | null, detail: string): void {
      checks.push({ id, passed, detail });
    },
    fail(error: unknown): void {
      checks.push({
        id: "feature_action_failed",
        passed: false,
        detail:
          error instanceof Error
            ? error.message
            : "Unknown feature action failure",
      });
    },
    finish(
      ids: { letterId?: string; replyLetterId?: string } = {},
    ): ProductLifeFeatureResult {
      return {
        status: checks.some((check) => check.passed === false)
          ? "failed"
          : "completed",
        ...ids,
        evidence: JSON.parse(
          JSON.stringify({
            kind,
            observedAtUtc: app.personasim.clock.nowUtc(),
            http,
            internalEvidence,
          }),
        ) as JsonValue,
        checks,
        publicMessages,
      };
    },
  };
}

function hasProperty(value: unknown, key: string): boolean {
  return typeof value === "object" && value !== null && key in value;
}
