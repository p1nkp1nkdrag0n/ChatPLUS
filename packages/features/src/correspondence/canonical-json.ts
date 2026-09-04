import {
  JsonValueSchema,
  LetterReplyProposalSchema,
  type JsonValue,
  type LetterReplyProposal,
} from "@personasim/contracts";

/**
 * Serializes correspondence evidence deterministically for hashing and AAD.
 * Object keys are recursively sorted, array order is preserved, and values
 * outside the JSON domain (including undefined and non-finite numbers) fail
 * before serialization. Callers hash the returned UTF-8 string.
 */
export function canonicalCorrespondenceJson(value: unknown): string {
  return serializeCanonicalJson(JsonValueSchema.parse(value));
}

export function canonicalLetterContent(input: {
  readonly subject?: string;
  readonly body: JsonValue;
}): string {
  return canonicalCorrespondenceJson({
    subject: input.subject ?? null,
    body: input.body,
  });
}

export function canonicalLetterGenerationSnapshot(input: {
  readonly contextJson: JsonValue;
  readonly evidenceIds: readonly string[];
}): string {
  return canonicalCorrespondenceJson({
    contextJson: input.contextJson,
    evidenceIds: [...input.evidenceIds],
  });
}

/** Excludes model-control evidence IDs while binding all visible reply text. */
export function canonicalLetterReplyContent(
  value: Readonly<LetterReplyProposal>,
): string {
  const proposal = LetterReplyProposalSchema.parse(value);
  return canonicalLetterContent({
    subject: proposal.subject,
    body: {
      salutation: proposal.salutation,
      paragraphs: proposal.paragraphs,
      closing: proposal.closing,
      signature: proposal.signature,
      postscript: proposal.postscript ?? null,
    },
  });
}

function serializeCanonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) {
      throw new TypeError("Correspondence canonical JSON contains undefined");
    }
    return encoded;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => serializeCanonicalJson(item)).join(",")}]`;
  }
  return `{${Object.entries(value)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(
      ([key, item]) => `${JSON.stringify(key)}:${serializeCanonicalJson(item)}`,
    )
    .join(",")}}`;
}
