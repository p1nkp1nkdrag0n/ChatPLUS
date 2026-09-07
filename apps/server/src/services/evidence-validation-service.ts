import type { AutobiographyRevisionProposal } from "@personasim/contracts";
import {
  validateAutobiographyRevision,
  type AutobiographyEvidenceCatalogItemLike,
} from "@personasim/features";

import type { VerifiedContinuityEvidence } from "./autobiography-service.js";
import type { ArchivedMessage } from "./continuity-repository.js";
import {
  checkpointLongMessageReceipts,
  MAXIMUM_REPORT_QUOTE_LENGTH,
} from "./checkpoint-report-excerpts.js";

/** Deterministic, bounded validation. No model or database calls occur here;
 * uncertain abstractions become source reports, not asserted facts. */
export function continuitySemanticCatalog(input: {
  messages: readonly ArchivedMessage[];
  evidence: readonly VerifiedContinuityEvidence[];
}): AutobiographyEvidenceCatalogItemLike[] {
  const messages = new Map(
    input.messages.map((message) => [message.id, message]),
  );
  const receipts = new Map(
    checkpointLongMessageReceipts(input).map((receipt) => [
      receipt.evidenceId,
      receipt.content,
    ]),
  );
  return input.evidence.map((evidence) => {
    const message =
      evidence.sourceType === "message_archive"
        ? messages.get(evidence.sourceId)
        : undefined;
    const text = evidence.text.trim();
    const sourceReport =
      message !== undefined &&
      message.content === evidence.text &&
      text.length <= MAXIMUM_REPORT_QUOTE_LENGTH
        ? `${message.role === "user" ? "对方" : "我"}在对话中说过：「${text}」`
        : evidence.sourceType !== "message_archive" &&
            text.length <= MAXIMUM_REPORT_QUOTE_LENGTH
          ? `来源记录原文：「${text}」`
          : undefined;
    return {
      id: evidence.id,
      sourceType: evidence.sourceType,
      sourceId: evidence.sourceId,
      text: evidence.text,
      reliability: evidence.reliability,
      ...(evidence.temporalStatus === undefined
        ? {}
        : { temporalStatus: evidence.temporalStatus }),
      ...(sourceReport === undefined ? {} : { sourceReport }),
      ...(receipts.has(evidence.id)
        ? { sourceReceipt: receipts.get(evidence.id)! }
        : {}),
    };
  });
}

export function preserveUnverifiedAutobiographySources(input: {
  proposal: AutobiographyRevisionProposal;
  catalog: readonly AutobiographyEvidenceCatalogItemLike[];
}): AutobiographyRevisionProposal {
  const validation = validateAutobiographyRevision({
    proposal: input.proposal,
    evidenceCatalog: input.catalog,
  });
  if (validation.accepted) return input.proposal;
  // A missing source or a fabricated occurrence is an integrity failure. It
  // must still reach the checkpoint repair/failure path rather than be hidden.
  if (
    validation.issues.some(
      (issue) =>
        issue.code !== "entry_not_grounded" &&
        issue.code !== "summary_not_grounded",
    )
  )
    return input.proposal;
  const catalog = new Map(
    input.catalog.map((evidence) => [evidence.id, evidence]),
  );
  const ungrounded = new Set(
    validation.issues
      .filter((issue) => issue.code === "entry_not_grounded")
      .map((issue) => issue.entryIndex),
  );
  const entries = input.proposal.entries.flatMap((entry, index) => {
    if (!ungrounded.has(index)) return [entry];
    // Expand independently so a correction to one fact never invalidates a
    // different fact merely because the model put them in the same paragraph.
    return entry.evidence.map((reference) => {
      const evidence = catalog.get(reference.id)!;
      const content = evidence.sourceReport ?? evidence.sourceReceipt;
      if (content === undefined) return entry; // validation will reject it
      return {
        entryKind: "unresolved_thread" as const,
        content,
        temporalStatus: "unknown" as const,
        evidence: [reference],
      };
    });
  });
  if (entries.length > 40) return input.proposal;
  const summaryParts: string[] = [];
  for (const entry of [...entries].reverse()) {
    if (summaryParts.join("\n").length + entry.content.length + 1 <= 2_000)
      summaryParts.unshift(entry.content);
  }
  return { entries, summaryFirstPerson: summaryParts.join("\n") };
}
