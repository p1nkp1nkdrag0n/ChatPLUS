import {
  LetterReplyProposalSchema,
  type LetterGenerationSnapshot,
  type LetterReplyProposal,
} from "@personasim/contracts";
import {
  deriveAllowedLetterReplyReferenceIds,
  letterReplyParticipants,
} from "@personasim/features";

/** An explicitly reversed addressee is evidence about the candidate's entire
 * writing perspective. Replacing just the envelope must not bless its body. */
export function hasReversedLetterCandidatePerspective(
  candidate: Readonly<LetterReplyProposal>,
  snapshot: Readonly<LetterGenerationSnapshot>,
): boolean {
  const { author, recipient } = letterReplyParticipants(snapshot);
  if (author === recipient) return false;
  const addressee = candidate.salutation
    .trim()
    .replace(/^(?:亲爱的|Dear\s+)/iu, "")
    .replace(/[：:,，!！\s]+$/u, "")
    .trim();
  return addressee === author;
}

/** Revalidate the final, server-addressed proposal before encryption/commit.
 * This catches explicit identity reversals; it is not a semantic entailment
 * claim about every sentence merely because one citation is valid. */
export function validateLetterReplyForSnapshot(
  proposal: Readonly<LetterReplyProposal>,
  snapshot: Readonly<LetterGenerationSnapshot>,
):
  | "letter_reply_evidence_out_of_scope"
  | "letter_reply_perspective_conflict"
  | undefined {
  const parsed = LetterReplyProposalSchema.safeParse(proposal);
  if (!parsed.success) return "letter_reply_perspective_conflict";
  const allowedIds = new Set(deriveAllowedLetterReplyReferenceIds(snapshot));
  if (proposal.referencedEvidenceIds.some((id) => !allowedIds.has(id))) {
    return "letter_reply_evidence_out_of_scope";
  }
  const participants = letterReplyParticipants(snapshot);
  if (
    proposal.signature !== participants.author ||
    proposal.salutation !== participants.salutation
  ) {
    return "letter_reply_perspective_conflict";
  }
  const name = escapeRegExp(participants.author);
  const addressingAuthor = new RegExp(
    `^(?:亲爱的|Dear\\s+)?${name}\\s*[：:,，](?:\\s*你|\\s*$)`,
    "iu",
  );
  const authorAsRecipient = new RegExp(
    `^你(?:是|叫|的名字是)\\s*${name}(?:[，。！？.!?,\\s]|$)`,
    "u",
  );
  for (const paragraph of [...proposal.paragraphs, proposal.postscript ?? ""]) {
    // Restrict deterministic rejection to direct unquoted address assertions;
    // a quoted name or a shared event is not evidence of swapped perspective.
    if (
      paragraph
        .split(/\r?\n/u)
        .some(
          (line) =>
            addressingAuthor.test(line.trim()) ||
            authorAsRecipient.test(line.trim()),
        )
    ) {
      return "letter_reply_perspective_conflict";
    }
  }
  return undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
