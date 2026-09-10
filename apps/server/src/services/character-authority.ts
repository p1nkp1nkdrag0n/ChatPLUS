import { createHash } from "node:crypto";
import { z } from "zod";
import {
  CharacterAuthorityDecisionSchema,
  type CharacterAuthorityAudit,
  type CharacterAuthoring,
} from "@personasim/contracts";
import { ApiError } from "../domain/errors.js";
import {
  applyStrangerRelationship,
  INITIAL_RELATIONSHIP_FIELDS,
  STRANGER_RELATIONSHIP_POLICY,
} from "../domain/stranger-relationship.js";
import {
  characterDraftSchema,
  type CharacterDraft,
  type OriginalCharacterInput,
  type ImportedCharacterInput,
} from "../domain/schemas.js";

type Entry = CharacterAuthorityAudit["candidates"][number];
type Source = NonNullable<Entry["source"]>;
const POLICY = "character_authority_v1";
const COLLECTIONS = [
  "persona.boundaries",
  "dialogue.rules",
  "dialogue.frequentPhrases",
  "knowledge.knownFacts",
  "knowledge.forbiddenMetaKnowledge",
  "lockedPaths",
] as const;
// These fields are rendered as dialogue instructions too. Soft wording may be
// edited normally, but moving an absolute rule here cannot evade review/hash.
const DIALOGUE_TEXT = [
  "dialogue.avoidedPhrases",
  "dialogue.greetingPatterns",
  "dialogue.refusalPatterns",
  "dialogue.comfortingPatterns",
  "dialogue.primaryLanguage",
  "dialogue.understoodLanguages",
  "dialogue.spokenLanguages",
  "dialogue.authorGuidance",
];
const CONTROLLED = [
  ...COLLECTIONS,
  ...DIALOGUE_TEXT,
  "userRelationship.sharedContext",
  "identity.selfDescription",
  "persona.traits",
  "persona.values",
  "persona.preferences",
  "userRelationship.behaviorModes",
];
const ABSOLUTE =
  /永不|永远|绝不|一律|必须|只能|禁止|不得|无论.{0,20}都|\b(?:always|never|must|forbid)\b/i;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
function hash(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
function get(draft: CharacterDraft, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (value, key) =>
        value !== null && typeof value === "object"
          ? (value as Record<string, unknown>)[key]
          : undefined,
      draft,
    );
}
function set(draft: CharacterDraft, path: string, value: unknown): void {
  const keys = path.split(".");
  let node = draft as unknown as Record<string, unknown>;
  for (const key of keys.slice(0, -1))
    node = node[key] as Record<string, unknown>;
  node[keys.at(-1)!] = value;
}
function contentHash(draft: CharacterDraft): string {
  return hash(
    Object.fromEntries(
      [...CONTROLLED, "dialogue.frequentPhrasesOrigin"].map((path) => [
        path,
        get(draft, path),
      ]),
    ),
  );
}
function source(
  kind: Source["kind"],
  field: string,
  text: string,
  quote = text.slice(0, 100_000),
): Source {
  const start = Math.max(0, text.indexOf(quote));
  return {
    kind,
    field,
    sourceSha256: createHash("sha256").update(text).digest("hex"),
    quote,
    start,
    end: start + quote.length,
  };
}
function entry(
  target: string,
  value: unknown,
  status: Entry["status"],
  reason: string,
  evidence?: Source,
  effective?: unknown,
): Entry {
  const serialized = canonical(value);
  const fingerprint = hash({ target, value });
  const record =
    value !== null && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  return {
    candidateId: `authority_${fingerprint.slice(0, 24)}`,
    candidateSha256: fingerprint,
    target,
    ...(typeof record.id === "string" ? { ruleId: record.id } : {}),
    originalValue: serialized,
    ...(effective === undefined
      ? {}
      : { effectiveValue: canonical(effective) }),
    strength:
      target === "lockedPaths"
        ? "lock"
        : target === "dialogue.frequentPhrases"
          ? "phrase"
          : record.hard === true ||
              record.enforcement === "hard" ||
              ABSOLUTE.test(serialized)
            ? "hard"
            : target.includes("knownFacts") || target.endsWith("sharedContext")
              ? "fact"
              : "soft",
    status,
    reason,
    ...(evidence === undefined ? {} : { source: evidence }),
  };
}
function seal(
  draft: CharacterDraft,
  candidates: Entry[],
  original: unknown,
): CharacterDraft {
  const normalized = applyStrangerRelationship(draft);
  for (const field of INITIAL_RELATIONSHIP_FIELDS) {
    const target = `userRelationship.${field}`;
    const value = normalized.userRelationship[field];
    for (const candidate of candidates) {
      if (
        candidate.target === target &&
        candidate.originalValue !== canonical(value)
      ) {
        candidate.status = "rejected";
        candidate.effectiveValue = canonical(value);
        candidate.reason =
          "The application starts every user relationship as strangers without a shared past.";
      }
    }
    if (draft.userRelationship[field] !== value) {
      candidates.push(
        entry(
          target,
          draft.userRelationship[field],
          "rejected",
          "Initial relationship fields are owned by the application.",
          undefined,
          value,
        ),
      );
    }
    candidates.push(
      entry(
        target,
        value,
        "accepted",
        "The application starts every user relationship as strangers without a shared past.",
        source(
          "application_rule",
          STRANGER_RELATIONSHIP_POLICY,
          canonical(value),
        ),
        value,
      ),
    );
  }
  draft = normalized;
  const unique = new Map(
    candidates.map((candidate) => [candidate.candidateId, candidate]),
  );
  draft.authorityAudit = {
    policyVersion: POLICY,
    contentSha256: contentHash(draft),
    originalCandidateSha256: hash(original),
    candidates: [...unique.values()],
  };
  return characterDraftSchema.parse(draft);
}
function safeLock(path: string): boolean {
  return (
    /^(?:identity|persona|dialogue|userRelationship|routines|knowledge|schedulePolicy|proactivePolicy)(?:\.|$)/.test(
      path,
    ) &&
    !/(?:^|\.)(?:__proto__|constructor|prototype)(?:\.|$)/.test(path) &&
    !path.includes("frequentPhrasesOrigin") &&
    path !== "userRelationship" &&
    !INITIAL_RELATIONSHIP_FIELDS.some(
      (field) => path === `userRelationship.${field}`,
    )
  );
}
function stripClaims(
  value: unknown,
  target: string,
  sourceId: string,
): unknown {
  if (target === "persona.boundaries" || target === "dialogue.rules") {
    const clean = structuredClone(value) as Record<string, unknown>;
    clean.origin = "user_spec";
    clean.sourceRefs = [sourceId];
    return clean;
  }
  return structuredClone(value);
}

/** No provider-owned origin/sourceRefs/audit fields are authorization inputs. */
export function authorizeGeneratedCharacter(
  candidate: CharacterDraft,
  input: OriginalCharacterInput | ImportedCharacterInput,
  fallback: CharacterDraft,
  originalCandidate: CharacterDraft = candidate,
): CharacterDraft {
  const draft = structuredClone(candidate);
  delete draft.authorityAudit;
  const entries: Entry[] = [];
  const authoring: CharacterAuthoring = input.authoring ?? {};
  const original = "initialRelationship" in input;
  const fields = Object.entries(input).flatMap(([field, value]) =>
    typeof value === "string"
      ? [{ field, text: value }]
      : Array.isArray(value)
        ? value
            .filter((x): x is string => typeof x === "string")
            .map((text, index) => ({ field: `${field}.${index}`, text }))
        : [],
  );
  const quoted = (text: string): Source | undefined => {
    const found = fields.find((field) => field.text.includes(text));
    return found === undefined
      ? undefined
      : source("source_quote", found.field, found.text, text);
  };
  const supportedQuote = (text: string, target: string): Source | undefined => {
    if (!text.trim()) return undefined;
    for (const field of fields) {
      const appropriateField = original
        ? target.startsWith("dialogue.")
          ? field.field === "dialogueStyle"
          : field.field === "characterBrief" ||
            field.field.startsWith("coreTraits.")
        : field.field === "sourceText";
      if (!appropriateField) continue;
      for (
        let start = field.text.indexOf(text);
        start >= 0;
        start = field.text.indexOf(text, start + 1)
      ) {
        if (
          !sourceSupportsAssertion(
            field.text,
            start,
            text.length,
            original ? input.name : input.characterName,
            original,
          )
        )
          continue;
        const evidence = source("source_quote", field.field, field.text, text);
        evidence.start = start;
        evidence.end = start + text.length;
        return evidence;
      }
    }
    return undefined;
  };
  // A source label supplied by the provider is a claim, never a credential.
  for (const rule of [
    ...draft.persona.traits,
    ...draft.persona.values,
    ...draft.persona.goals,
    ...draft.persona.preferences,
    ...(draft.persona.biography ?? []),
    ...(draft.dialogue.rules ?? []),
    ...(draft.userRelationship.behaviorModes ?? []),
  ]) {
    const record = rule as unknown as Record<string, unknown>;
    const authorBound =
      original &&
      ((draft.persona.traits.includes(rule as never) &&
        input.coreTraits.includes(String(record.name))) ||
        (draft.persona.biography?.includes(rule as never) &&
          input.importantExperience !== undefined &&
          record.event === input.importantExperience) ||
        (draft.persona.goals.includes(rule as never) &&
          record.title === input.mainGoal));
    const direct = [
      record.description,
      record.instruction,
      record.behavior,
    ].find(
      (value) =>
        typeof value === "string" &&
        (ABSOLUTE.test(value)
          ? supportedQuote(value, "persona")
          : quoted(value)),
    );
    if (
      (rule.origin === "user_spec" || rule.origin === "canon_extract") &&
      !authorBound
    )
      rule.origin = !original && direct ? "canon_extract" : "model_inference";
    if (rule.origin === "model_inference" || rule.origin === "canon_extract")
      rule.sourceRefs = [draft.sources[0]!.id];
  }
  const declared: Record<string, unknown[]> = {
    "persona.boundaries": authoring.boundaries ?? [],
    "dialogue.rules": authoring.dialogueRules ?? [],
    "dialogue.frequentPhrases": authoring.frequentPhrases ?? [],
    "knowledge.knownFacts": authoring.knownFacts ?? [],
    "knowledge.forbiddenMetaKnowledge": [],
    lockedPaths: authoring.lockedPaths ?? [],
  };
  // This recognizes explicit quoted catchphrases, not arbitrary quoted speech.
  const phraseSources = new Map<string, Source>();
  if (authoring.frequentPhrases === undefined) {
    for (const field of fields)
      for (const match of field.text.matchAll(
        /(?:口头禅|常用语|常说|catchphrase)\s*(?:是|为|:|：)?\s*[“「"‘']([^”」"’']{1,120})[”」"’']/gi,
      )) {
        const name = original ? input.name : input.characterName;
        if (
          !(original && field.field === "dialogueStyle") &&
          !(
            ["sourceText", "characterBrief"].includes(field.field) &&
            sourceOwnsPhrase(field.text, match.index, name)
          )
        )
          continue;
        const phrase = match[1]!;
        if (!declared["dialogue.frequentPhrases"]!.includes(phrase))
          declared["dialogue.frequentPhrases"]!.push(phrase);
        const evidence = source(
          "source_quote",
          field.field,
          field.text,
          phrase,
        );
        evidence.start = match.index + match[0].indexOf(phrase);
        evidence.end = evidence.start + phrase.length;
        phraseSources.set(phrase, evidence);
      }
  }
  for (const target of COLLECTIONS) {
    const accepted: unknown[] = [];
    const provided = declared[target] ?? [];
    for (const value of (get(draft, target) as unknown[] | undefined) ?? []) {
      // Explicit declarations replace rather than bless the model's interpretation.
      const hasDeclaration = provided.some(
        (item) => canonical(item) === canonical(value),
      );
      let evidence: Source | undefined;
      if (target === "knowledge.knownFacts" && typeof value === "string") {
        const exact = ABSOLUTE.test(value)
          ? supportedQuote(value, target)
          : quoted(value);
        const originalField = fields.find(
          (field) => field.field === exact?.field,
        );
        if (
          exact &&
          originalField &&
          (exact.start === 0 ||
            /[。！？.!?\n；;]/.test(originalField.text[exact.start - 1]!)) &&
          (exact.end === originalField.text.length ||
            /[。！？.!?\n；;]/.test(value.at(-1)!) ||
            /[。！？.!?\n；;]/.test(originalField.text[exact.end]!))
        )
          evidence = exact;
      }
      if (
        target === "knowledge.forbiddenMetaKnowledge" &&
        fallback.knowledge.forbiddenMetaKnowledge.includes(value as string)
      )
        evidence = source(
          "application_rule",
          "application.factual_constraints",
          String(value),
        );
      if (target === "dialogue.rules") {
        const rule = value as Record<string, unknown>;
        const instruction = String(rule.instruction);
        const exact = supportedQuote(instruction, target);
        const isHard = rule.enforcement === "hard";
        const conditions = rule.conditions as unknown[];
        // A direct authored instruction supports only the same target and scope.
        const dialogueSource =
          exact?.field === "dialogueStyle" ||
          (!original &&
            exact?.field === "sourceText" &&
            ["language", "format"].includes(String(rule.kind)) &&
            /中文|英文|英语|语言|翻译|引号|后附|language|translate/i.test(
              instruction,
            ));
        if (
          exact &&
          dialogueSource &&
          conditions.length === 0 &&
          (!isHard ||
            (ABSOLUTE.test(instruction) &&
              !/(?:不必|不需要|无需|并非|不是|不要求).{0,6}(?:永远|必须|只能|禁止|不得|一律|绝不)/.test(
                instruction,
              )))
        )
          evidence = exact;
      }
      if (hasDeclaration) continue;
      if (evidence) {
        accepted.push(value);
        entries.push(
          entry(
            target,
            value,
            "accepted",
            "Exact supplied content; target and strength are supported.",
            evidence,
            value,
          ),
        );
      } else
        entries.push(
          entry(
            target,
            value,
            "pending",
            "Content, target or constraint strength was not independently authorized.",
          ),
        );
    }
    for (const value of provided) {
      if (target === "lockedPaths" && !safeLock(value as string))
        throw new ApiError(
          422,
          "invalid_authority_target",
          "Metadata cannot be locked or authorized as character content.",
        );
      const normalized = stripClaims(value, target, draft.sources[0]!.id);
      accepted.push(normalized);
      const field = `authoring.${target === "persona.boundaries" ? "boundaries" : target === "dialogue.rules" ? "dialogueRules" : target.split(".").at(-1)}`;
      const explicitQuote =
        target === "dialogue.frequentPhrases" &&
        authoring.frequentPhrases === undefined
          ? phraseSources.get(value as string)
          : undefined;
      entries.push(
        entry(
          target,
          normalized,
          "accepted",
          "Explicit author declaration of this exact content and strength.",
          explicitQuote ?? source("author_field", field, canonical(value)),
          normalized,
        ),
      );
    }
    // Known author facts have a deterministic server representation even if the
    // model omits them; the model cannot add claims by pointing at this source.
    if (target === "knowledge.knownFacts")
      for (const fact of fallback.knowledge.knownFacts) {
        if (!accepted.includes(fact)) {
          accepted.push(fact);
          entries.push(
            entry(
              target,
              fact,
              "accepted",
              "Server projection of supplied author fields.",
              source("author_field", "input", canonical(input)),
              fact,
            ),
          );
        }
      }
    set(
      draft,
      target,
      target === "knowledge.knownFacts"
        ? [...new Set([...fallback.knowledge.knownFacts, ...accepted])].slice(
            0,
            200,
          )
        : accepted,
    );
  }
  const relation =
    authoring.sharedContext ??
    (original
      ? input.initialRelationship
      : fallback.userRelationship.relationshipType);
  const oldRelation = draft.userRelationship.sharedContext;
  if (oldRelation !== relation)
    entries.push(
      entry(
        "userRelationship.sharedContext",
        oldRelation,
        "pending",
        "Relationship category does not establish shared history or knowledge.",
        undefined,
        relation,
      ),
    );
  draft.userRelationship.sharedContext = relation;
  entries.push(
    entry(
      "userRelationship.sharedContext",
      relation,
      "accepted",
      "Initial relationship is limited to the explicit author input.",
      source(
        "author_field",
        authoring.sharedContext === undefined
          ? "initialRelationship"
          : "authoring.sharedContext",
        relation,
      ),
      relation,
    ),
  );
  draft.dialogue.frequentPhrasesOrigin = draft.dialogue.frequentPhrases.length
    ? original || authoring.frequentPhrases !== undefined
      ? "user_spec"
      : "canon_extract"
    : "model_inference";
  quarantineAbsoluteCarriers(draft, fallback, entries, supportedQuote);
  for (const item of entries) {
    const raw = get(originalCandidate, item.target);
    const providerValue: unknown = Array.isArray(raw)
      ? raw.find((value) =>
          item.ruleId !== undefined &&
          value !== null &&
          typeof value === "object"
            ? (value as Record<string, unknown>).id === item.ruleId
            : canonical(value) === item.originalValue,
        )
      : raw;
    if (providerValue !== undefined)
      item.providerValue = canonical(providerValue);
  }
  const initial = applyStrangerRelationship(draft).userRelationship;
  for (const field of INITIAL_RELATIONSHIP_FIELDS) {
    const proposed = originalCandidate.userRelationship[field];
    if (proposed !== initial[field]) {
      entries.push(
        entry(
          `userRelationship.${field}`,
          proposed,
          "rejected",
          "Provider-authored relationship baselines cannot establish a shared past with the application user.",
          undefined,
          initial[field],
        ),
      );
    }
  }
  return seal(draft, entries, originalCandidate);
}

function sourceSupportsAssertion(
  text: string,
  start: number,
  length: number,
  name: string,
  implicitSubject: boolean,
): boolean {
  // A newline is not an attribution boundary: reported speech often spans lines.
  const before = text.slice(0, start).split(/[。！？.!?；;]/);
  const prefix = before.at(-1)!.trim();
  const after = text.slice(start + length).split(/[。！？.!?；;]/);
  const statement = prefix + text.slice(start, start + length) + after[0]!;
  const denied =
    /不(?:必|需要|要求|认同|同意|赞同|认可|承认)|无需|无须|否认|否定|不属实|并非|不是|编造|杜撰|谣言|传言|听说|据说|转述/;
  if (denied.test(statement)) return false;
  // Keep adjacent report/denial framing when an apparent assertion is isolated
  // on its own line or sentence. Ambiguous evidence remains reviewable.
  if (/(?:编造|杜撰|谣言|传言|转述|听说|据说)/.test(before.at(-2) ?? ""))
    return false;
  if (denied.test(after[1] ?? "")) return false;
  const ownedPrefixes = [
    name,
    ...[
      "的语言规则是",
      "的说话规则是",
      "说话时",
      "始终",
      "本人",
      "：",
      ":",
    ].map((suffix) => name + suffix),
    ...(implicitSubject
      ? ["", "她", "他", "她本人", "他本人", "该角色", "角色", "说话时"]
      : []),
  ];
  // A bare quoted string or a sentence assigned to a friend is not an authored
  // rule. Only a direct subject/prefix can authorize the extracted instruction.
  const assertion = text.slice(start, start + length).trim();
  if (
    !ownedPrefixes.includes(prefix) &&
    !(prefix === "" && assertion.startsWith(name))
  )
    return false;
  if (
    /^[“「"‘']|(?:朋友|别人|他人)(?:说|要求|认为)|(?:听|转述).{0,12}(?:说|认为)/.test(
      assertion,
    )
  )
    return false;
  // Checking only the text before the extraction misses whole-sentence inputs
  // whose subject is the user or another person. Confirm the subject of each
  // absolute clause as well; ambiguous paraphrases can use explicit review.
  for (const match of assertion.matchAll(new RegExp(ABSOLUTE.source, "gi"))) {
    const subject = assertion
      .slice(0, match.index)
      .split(/[，,。！？.!?；;]/)
      .at(-1)!
      .replace(new RegExp(ABSOLUTE.source, "gi"), "")
      .trim();
    const ownSubjects = [
      "",
      name,
      "她",
      "他",
      "我",
      "该角色",
      "角色",
      "说话时",
      "交流时",
    ];
    if (
      !ownSubjects.includes(subject) &&
      ![name, "她", "他", "我", "该角色", "角色"].some((owner) =>
        ["本人", "说话时", "的语言规则是", "的说话规则是", "的价值观是"].some(
          (suffix) => subject === owner + suffix,
        ),
      )
    )
      return false;
  }
  if (!implicitSubject && prefix === "" && !assertion.startsWith(name))
    return false;
  return true;
}

function sourceOwnsPhrase(text: string, start: number, name: string): boolean {
  const clauses = text.slice(0, start).split(/[。！？.!?\n]/);
  const prefix = clauses.at(-1)!.trim();
  if (prefix === name || prefix === `${name}的`) return true;
  return (
    /^(?:她|他|其)的$/.test(prefix) &&
    (clauses.at(-2)?.trim().startsWith(name) ?? false)
  );
}

/** Prevent moving an unsupported absolute instruction into another prompt field. */
function quarantineAbsoluteCarriers(
  draft: CharacterDraft,
  fallback: CharacterDraft,
  entries: Entry[],
  supportedQuote: (text: string, target: string) => Source | undefined,
): void {
  const target = "identity.selfDescription";
  const description = draft.identity.selfDescription;
  if (ABSOLUTE.test(description) && !supportedQuote(description, target)) {
    entries.push(
      entry(
        target,
        description,
        "pending",
        "Absolute instruction outside its authorized target.",
        undefined,
        fallback.identity.selfDescription,
      ),
    );
    draft.identity.selfDescription = fallback.identity.selfDescription;
  }
  for (const path of [
    "persona.traits",
    "persona.values",
    "persona.preferences",
    "userRelationship.behaviorModes",
  ]) {
    const rules =
      (get(draft, path) as Array<Record<string, unknown>> | undefined) ?? [];
    const fallbackRules =
      (get(fallback, path) as Array<Record<string, unknown>> | undefined) ?? [];
    const safe = rules.flatMap((rule) => {
      const text = Object.entries(rule)
        .filter(([key]) => !["id", "origin", "sourceRefs"].includes(key))
        .map(([, value]) =>
          typeof value === "string"
            ? value
            : Array.isArray(value)
              ? value.join("；")
              : "",
        )
        .join("；");
      if (!ABSOLUTE.test(text)) return [rule];
      const statements = text.split("；").filter((part) => ABSOLUTE.test(part));
      if (statements.every((statement) => supportedQuote(statement, path)))
        return [rule];
      const replacement = fallbackRules.find((item) => item.id === rule.id);
      entries.push(
        entry(
          path,
          rule,
          "pending",
          "Absolute content needs exact author confirmation in this target.",
          undefined,
          replacement,
        ),
      );
      return replacement ? [replacement] : [];
    });
    set(
      draft,
      path,
      safe.length || !["persona.traits", "persona.values"].includes(path)
        ? safe
        : fallbackRules,
    );
  }
  for (const path of DIALOGUE_TEXT) {
    const value = get(draft, path);
    const fallbackValue = get(fallback, path);
    const collection = Array.isArray(value);
    const safe = (collection ? (value as unknown[]) : [value]).filter(
      (item) => {
        if (typeof item !== "string" || !ABSOLUTE.test(item)) return true;
        // Original author guidance is kept with its complete context, never a
        // provider-selected substring that discards a quote's attribution.
        if (path === "dialogue.authorGuidance" && item === fallbackValue)
          return true;
        const evidence = supportedQuote(item, path);
        entries.push(
          entry(
            path,
            item,
            evidence ? "accepted" : "pending",
            evidence
              ? "Exact dialogue content, subject and strength are supported."
              : "Absolute dialogue wording needs exact author confirmation in this target.",
            evidence,
            evidence ? item : collection ? undefined : fallbackValue,
          ),
        );
        return evidence !== undefined;
      },
    );
    set(draft, path, collection ? safe : (safe[0] ?? fallbackValue));
  }
}

export function assertCharacterAuthority(draft: CharacterDraft): void {
  if (
    !draft.authorityAudit ||
    draft.authorityAudit.contentSha256 !== contentHash(draft)
  )
    throw new ApiError(
      422,
      "character_authority_review_required",
      "Character constraints require server review before publication. Save a new draft and review its exact candidates.",
    );
  const unresolved = draft.authorityAudit.candidates.find(
    (item) =>
      item.status === "pending" &&
      ["hard", "lock"].includes(item.strength) &&
      containsCandidate(draft, item),
  );
  if (unresolved)
    throw new ApiError(
      422,
      "character_authority_review_required",
      "An active historical constraint still needs an exact author decision.",
      { candidateId: unresolved.candidateId, target: unresolved.target },
    );
}

function containsCandidate(draft: CharacterDraft, candidate: Entry): boolean {
  const current = get(draft, candidate.target);
  return (Array.isArray(current) ? current : [current]).some(
    (value) => canonical(value) === candidate.originalValue,
  );
}

/** Keep historical specs readable, but never mistake missing provenance for consent. */
export function characterAuthorityReview(
  draft: CharacterDraft,
): CharacterAuthorityAudit | undefined {
  if (draft.authorityAudit) return structuredClone(draft.authorityAudit);
  const candidates = CONTROLLED.flatMap((target) => {
    const value = get(draft, target);
    return (
      COLLECTIONS.includes(target as (typeof COLLECTIONS)[number]) ||
      Array.isArray(value)
        ? ((value as unknown[] | undefined) ?? [])
        : value === undefined
          ? []
          : [value]
    )
      .filter(
        (item) =>
          COLLECTIONS.includes(target as (typeof COLLECTIONS)[number]) ||
          (target === "userRelationship.sharedContext"
            ? item !== draft.userRelationship.relationshipType
            : ABSOLUTE.test(canonical(item))),
      )
      .map((item) =>
        entry(
          target,
          item,
          "pending",
          "Historical content has no server-verifiable author authority.",
          source("legacy_unverified", target, canonical(item)),
        ),
      );
  });
  return {
    policyVersion: POLICY,
    contentSha256: contentHash(draft),
    originalCandidateSha256: hash(draft),
    candidates,
  };
}

/** Editing metadata cannot grant authority; only confirming stored candidate hashes can. */
export function authorizeEditedCharacter(
  candidate: CharacterDraft,
  current: CharacterDraft,
  decisions: unknown,
  expectedVersion: number | undefined,
): CharacterDraft {
  const draft = structuredClone(candidate);
  const previous = current.authorityAudit;
  const entries = structuredClone(
    characterAuthorityReview(current)?.candidates ?? [],
  );
  const baseline = previous ? current : legacySafeBaseline(current);
  for (const target of CONTROLLED) {
    const next = get(draft, target);
    const old = get(baseline, target);
    if (canonical(next) === canonical(old)) continue;
    const collection =
      COLLECTIONS.includes(target as (typeof COLLECTIONS)[number]) ||
      Array.isArray(next);
    const incoming = collection
      ? ((next as unknown[] | undefined) ?? [])
      : [next];
    const prior = collection ? ((old as unknown[] | undefined) ?? []) : [old];
    const retained: unknown[] = [];
    for (const value of incoming) {
      if (
        prior.some((existing) => canonical(existing) === canonical(value)) ||
        (DIALOGUE_TEXT.includes(target) && !ABSOLUTE.test(canonical(value)))
      )
        retained.push(value);
      else
        entries.push(
          entry(
            target,
            value,
            "pending",
            "Edited content requires confirmation of this exact target and strength.",
          ),
        );
    }
    set(
      draft,
      target,
      collection
        ? retained.length === 0 &&
          ["persona.traits", "persona.values"].includes(target)
          ? prior
          : retained
        : (retained[0] ?? old),
    );
  }
  draft.dialogue.frequentPhrasesOrigin =
    baseline.dialogue.frequentPhrasesOrigin ?? "legacy_unverified";
  if (decisions !== undefined) {
    if (expectedVersion === undefined)
      throw new ApiError(
        409,
        "authority_version_required",
        "Confirming constraints requires the reviewed character version.",
      );
    const parsed = z
      .array(CharacterAuthorityDecisionSchema)
      .min(1)
      .max(200)
      .parse(decisions);
    const seen = new Set<string>();
    for (const decision of parsed) {
      // Newly submitted content cannot be confirmed in the same unreviewed edit.
      const reviewed = characterAuthorityReview(current)?.candidates.find(
        (item) =>
          item.candidateId === decision.candidateId &&
          item.status === "pending",
      );
      if (
        !reviewed ||
        reviewed.candidateSha256 !== decision.candidateSha256 ||
        seen.has(decision.candidateId)
      )
        throw new ApiError(
          409,
          "authority_candidate_conflict",
          "The exact reviewed candidate is missing, changed or already decided.",
        );
      seen.add(decision.candidateId);
      const found = entries.find(
        (item) => item.candidateId === decision.candidateId,
      )!;
      found.status = decision.decision === "accept" ? "accepted" : "rejected";
      if (decision.decision === "reject") {
        if (containsCandidate(draft, found)) {
          const active = get(draft, found.target);
          const remaining = Array.isArray(active)
            ? active.filter((item) => canonical(item) !== found.originalValue)
            : undefined;
          if (
            remaining === undefined ||
            (remaining.length === 0 &&
              ["persona.traits", "persona.values"].includes(found.target))
          )
            throw new ApiError(
              422,
              "authority_replacement_required",
              "This active field needs a replacement before its last value can be rejected.",
              { target: found.target },
            );
          set(draft, found.target, remaining);
        }
        continue;
      }
      const value: unknown = JSON.parse(found.originalValue);
      if (found.target === "lockedPaths" && !safeLock(value as string))
        throw new ApiError(
          422,
          "invalid_authority_target",
          "Metadata cannot be locked as character content.",
        );
      const currentValue = get(draft, found.target);
      const list =
        COLLECTIONS.includes(found.target as (typeof COLLECTIONS)[number]) ||
        Array.isArray(currentValue);
      const authorized = stripClaims(value, found.target, draft.sources[0]!.id);
      if (list) {
        const items = [...((currentValue as unknown[] | undefined) ?? [])];
        const id =
          typeof authorized === "object" && authorized !== null
            ? (authorized as Record<string, unknown>).id
            : undefined;
        const remaining =
          id === undefined
            ? items
            : items.filter(
                (item) =>
                  typeof item !== "object" ||
                  item === null ||
                  (item as Record<string, unknown>).id !== id,
              );
        set(draft, found.target, [...remaining, authorized]);
      } else set(draft, found.target, authorized);
      found.effectiveValue = canonical(authorized);
      found.source = source(
        "author_confirmation",
        `version:${expectedVersion}`,
        canonical({
          target: found.target,
          value: authorized,
          strength: found.strength,
        }),
      );
      found.reason =
        "Author confirmed the exact stored candidate, target and strength.";
      if (found.target === "dialogue.frequentPhrases")
        draft.dialogue.frequentPhrasesOrigin = "user_spec";
    }
  }
  return seal(draft, entries, candidate);
}

function legacySafeBaseline(current: CharacterDraft): CharacterDraft {
  const baseline = structuredClone(current);
  baseline.persona.boundaries = [];
  baseline.dialogue.rules = [];
  baseline.dialogue.frequentPhrases = [];
  baseline.dialogue.frequentPhrasesOrigin = "legacy_unverified";
  baseline.knowledge.knownFacts = [];
  baseline.lockedPaths = [];
  baseline.userRelationship.sharedContext =
    baseline.userRelationship.relationshipType;
  return baseline;
}
