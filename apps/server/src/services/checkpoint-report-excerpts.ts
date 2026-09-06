import { stableId } from "@personasim/features";
import type { AutobiographyEntry } from "@personasim/contracts";

import type { CheckpointAutobiographyModelInput } from "./checkpoint-service.js";

export const MAXIMUM_REPORT_QUOTE_LENGTH = 1_800;
// Each snapshot category is limited to 40 entries. Reserve space for automatic
// long-message receipts before asking the model to select other reports.
export const MAXIMUM_CHECKPOINT_REPORT_ENTRIES = 40;

export function checkpointEntryCardTitle(
  entry: Pick<AutobiographyEntry, "content" | "evidence">,
): string {
  if (
    entry.evidence.length === 1 &&
    entry.evidence[0]?.sourceType === "message_archive"
  ) {
    if (entry.content.startsWith("【长消息来源索引，内容尚未提炼】"))
      return "长消息来源索引（内容尚未提炼）";
    if (
      entry.content.startsWith("对方在对话中说过：「") ||
      entry.content.startsWith("我在对话中说过：「")
    )
      return "对话中的原文报告";
  }
  return entry.content.slice(0, 240);
}

export interface CheckpointReportExcerpt {
  id: string;
  evidenceId: string;
  speaker: "user" | "character";
  text: string;
  recordedAtUtc: string;
}

/** Whole utterances preserve negation, conditions and third-party quotation
 * frames, including those separated by paragraph breaks. No partial sentence
 * or oversized utterance is offered as a freestanding claim. */
export function checkpointReportExcerpts(
  input: CheckpointAutobiographyModelInput,
): CheckpointReportExcerpt[] {
  const messages = new Map(
    input.messages.map((message) => [message.id, message]),
  );
  return input.evidence.flatMap((evidence) => {
    if (evidence.sourceType !== "message_archive") return [];
    const message = messages.get(evidence.sourceId);
    if (message === undefined || message.content !== evidence.text) return [];
    const text = message.content.trim();
    if (text.length === 0 || text.length > MAXIMUM_REPORT_QUOTE_LENGTH)
      return [];
    return [
      {
        id: stableId("autobio_excerpt", `${evidence.id}:${text}`),
        evidenceId: evidence.id,
        speaker:
          message.role === "user" ? ("user" as const) : ("character" as const),
        text,
        recordedAtUtc: evidence.recordedAtUtc,
      },
    ];
  });
}

export function checkpointLongMessageReceipts(
  input: Pick<CheckpointAutobiographyModelInput, "messages" | "evidence">,
): Array<{ evidenceId: string; content: string }> {
  const messages = new Map(
    input.messages.map((message) => [message.id, message]),
  );
  return input.evidence.flatMap((evidence) => {
    if (
      evidence.sourceType !== "message_archive" ||
      evidence.reliability !== "reported" ||
      evidence.temporalStatus !== "unknown"
    )
      return [];
    const message = messages.get(evidence.sourceId);
    if (
      message === undefined ||
      message.content !== evidence.text ||
      message.content.trim().length <= MAXIMUM_REPORT_QUOTE_LENGTH
    )
      return [];
    return [
      {
        evidenceId: evidence.id,
        // Recording time stays in typed evidence metadata so anchored-story
        // prompts can project it. Embedding host UTC in prose bypasses that
        // clock projection and can invent a date in the character's world.
        content: `【长消息来源索引，内容尚未提炼】${message.role === "user" ? "对方" : "我"}曾发来一则长消息。完整原文保存在消息 ${message.id}；此条只记录发言存在，不概括其中的经历、计划或关系变化。`,
      },
    ];
  });
}
