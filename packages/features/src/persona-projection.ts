import {
  EffectivePersonaSnapshotSchema,
  PERSONA_RUNTIME_POLICY_VERSION,
  PersonaPracticeProposalSchema,
  type CharacterSpec,
  type EffectivePersonaSnapshot,
  type PersonaAdaptation,
  type PersonaPracticeProposal,
} from "@personasim/contracts";

import { matchesConversationTopic } from "./conversation-topic.js";
import { withoutQuotedConversationText } from "./conversation-requests.js";

export interface EffectivePersonaInput {
  baseSpec: CharacterSpec;
  revision: number;
  memoryRevision: number;
  adaptations: readonly PersonaAdaptation[];
  validAdaptationIds: readonly string[];
  userId: string;
  nowUtc: string;
  topicText?: string;
}

/** A scope-filtered view; published persona values and authoring history stay immutable. */
export function buildEffectivePersona(
  input: EffectivePersonaInput,
): EffectivePersonaSnapshot {
  const valid = new Set(input.validAdaptationIds);
  const selected: PersonaAdaptation[] = [];
  const excludedAdaptationIds: string[] = [];
  const suppressedMemoryIds = new Set<string>();
  for (const adaptation of input.adaptations) {
    const topic = adaptation.proposal.scope.topic;
    const relevant =
      topic === undefined ||
      matchesConversationTopic(topic, input.topicText ?? "");
    const memoryIds = adaptation.sources
      .filter((source) => source.sourceType === "memory")
      .map((source) => source.sourceId);
    if (adaptation.status !== "accepted" || !valid.has(adaptation.id))
      memoryIds.forEach((id) => suppressedMemoryIds.add(id));
    if (
      adaptation.agentId !== input.baseSpec.id ||
      adaptation.status !== "accepted" ||
      adaptation.baseCharacterVersion !== input.baseSpec.version ||
      adaptation.revision > input.revision ||
      adaptation.proposal.scope.userId !== input.userId ||
      !valid.has(adaptation.id) ||
      !relevant ||
      adaptation.effectiveFromUtc > input.nowUtc ||
      (adaptation.effectiveToUtc !== undefined &&
        adaptation.effectiveToUtc <= input.nowUtc)
    ) {
      excludedAdaptationIds.push(adaptation.id);
      continue;
    }
    selected.push(adaptation);
  }
  return EffectivePersonaSnapshotSchema.parse({
    policyVersion: PERSONA_RUNTIME_POLICY_VERSION,
    agentId: input.baseSpec.id,
    baseCharacterVersion: input.baseSpec.version,
    revision: input.revision,
    memoryRevision: input.memoryRevision,
    persona: input.baseSpec.persona,
    dialogue: input.baseSpec.dialogue,
    relationshipPractices: selected,
    excludedAdaptationIds,
    suppressedMemoryIds: [...suppressedMemoryIds],
  });
}

/** Only enduring, explicitly requested practices are eligible for automatic capture. */
export function deriveExplicitPersonaPractices(input: {
  text: string;
  userId: string;
}): PersonaPracticeProposal[] {
  const text = input.text.trim();
  if (
    text.length === 0 ||
    text.length > 2_000 ||
    withoutQuotedConversationText(text) !== text ||
    /(?:他说|她说|朋友说|同事说|家人说|引用|假如|如果|假设|要是|[“”"「」‘’『』]|\b(?:if|suppose|said|says|quote)\b)/iu.test(
      text,
    ) ||
    /(?:不要不|不能不|不是不|并非不|不喜欢不)/u.test(text)
  )
    return [];
  const proposals: PersonaPracticeProposal[] = [];
  for (const clause of enduringPracticeClauses(text, input.userId)) {
    const scope = clause.scope;
    const requested = clause.text;
    if (isSelfDirectedPractice(requested)) continue;
    if (
      !/(?:不要|不用|别).{0,3}先听/u.test(requested) &&
      /(?:先听我说|不(?:要|用|急着).{0,4}(?:给|提)?建议|别.{0,3}(?:给|提)建议|just listen|(?:don't|do not).{0,10}(?:advise|advice))/iu.test(
        requested,
      )
    ) {
      proposals.push(
        PersonaPracticeProposalSchema.parse({
          kind: "relationship_practice",
          facet: "advice_timing",
          practice: "listen_first",
          scope,
          content: text,
        }),
      );
    }
    if (
      !/(?:不要|不用|别|不喜欢|不希望|不想).{0,4}(?:少问|少追问|不追问)/u.test(
        requested,
      ) &&
      /(?:少.{0,3}(?:追问|问我)|少问|不(?:喜欢|要|用).{0,5}追问|别.{0,3}追问|fewer questions|(?:don't|do not).{0,5}ask)/iu.test(
        requested,
      )
    ) {
      proposals.push(
        PersonaPracticeProposalSchema.parse({
          kind: "relationship_practice",
          facet: "follow_up_questions",
          practice: "fewer_questions",
          scope,
          content: text,
        }),
      );
    }
    if (
      !/(?:不要|不用|不必|别|不可以|不喜欢|不希望|不想).{0,8}(?:主动|多问|提问|问一点|带.{0,3}话题)/u.test(
        requested,
      ) &&
      /(?:主动.{0,4}(?:问|提问|带.{0,3}话题)|(?:适当|自然).{0,3}(?:问|提问)|多.{0,3}(?:问我|带.{0,3}话题)|(?:you can|please).{0,8}ask)/iu.test(
        requested,
      )
    )
      proposals.push(
        PersonaPracticeProposalSchema.parse({
          kind: "relationship_practice",
          facet: "follow_up_questions",
          practice: "natural_questions",
          scope,
          content: text,
        }),
      );
    if (
      !/(?:不要|不用|不必|别|不喜欢|不希望|不想).{0,6}(?:少.{0,3}(?:比喻|比方|修辞)|平实|直接说)/u.test(
        requested,
      ) &&
      /(?:少.{0,4}(?:比喻|比方|修辞)|(?:不要|不用|别).{0,4}(?:比喻|打比方|修辞|升华|心理分析)|(?:直接|平实|具体).{0,3}说|plain language)/iu.test(
        requested,
      )
    )
      proposals.push(
        PersonaPracticeProposalSchema.parse({
          kind: "relationship_practice",
          facet: "expression_style",
          practice: "plain_expression",
          scope,
          content: text,
        }),
      );
  }
  // Preserve one unambiguous direction for each scoped facet. Contradictory
  // requests stay unresolved instead of silently picking their last keyword.
  return proposals.filter(
    (proposal, index) =>
      !proposals.some(
        (other) =>
          other.facet === proposal.facet &&
          other.scope.topic === proposal.scope.topic &&
          other.practice !== proposal.practice,
      ) &&
      proposals.findIndex(
        (other) =>
          other.facet === proposal.facet &&
          other.scope.topic === proposal.scope.topic,
      ) === index,
  );
}

function practiceScopeMatch(text: string): RegExpExecArray | null {
  return (
    /(?:当|在)?我(?:谈|聊|说起|提到)([^，。；,.;]{1,30}?)(?:时|的时候)/u.exec(
      text,
    ) ??
    /(?:以后|今后|每次)(?:我)?(?:谈|聊|说起|提到)([^，。；,.;]{1,30}?)(?:不(?:要|用|必)|别|请|就|时|，|,)/u.exec(
      text,
    )
  );
}

function isSelfDirectedPractice(text: string): boolean {
  return /(?:我(?:会|要|打算|自己)|希望自己|让(?:他|她|朋友)).{0,12}(?:主动|提问|问一点|比喻|比方|直接说)|我(?:主动|多(?:追)?问|少(?:追)?问|少.{0,3}(?:比喻|比方)|直接说|平实)|我(?:不用|不要|不必|不再|不想|不愿意)[^你，。]{0,5}(?:主动|问|比喻|比方)/u.test(
    text,
  );
}

export function deriveExplicitPersonaPracticeRetractions(input: {
  text: string;
  userId: string;
}): Array<Pick<PersonaPracticeProposal, "facet" | "scope" | "content">> {
  const text = input.text.trim();
  if (
    text.length === 0 ||
    text.length > 2_000 ||
    withoutQuotedConversationText(text) !== text ||
    /(?:他说|她说|朋友说|同事说|家人说|引用|假如|如果|假设|要是|[“”"「」‘’『』]|\b(?:if|suppose|said|says|quote)\b)/iu.test(
      text,
    ) ||
    /(?:不要不|不用不|不能不|不是不|并非不|不喜欢不)/u.test(text)
  )
    return [];
  const clauses = enduringPracticeClauses(text, input.userId);
  const result: Array<
    Pick<PersonaPracticeProposal, "facet" | "scope" | "content">
  > = [];
  for (const clause of clauses) {
    if (isSelfDirectedPractice(clause.text)) continue;
    const negativeListen = /(?:不(?:用|要|必)|别).{0,5}先听/u;
    const keepsListenFirst = clauses.some(
      (other) =>
        other.scope.topic === clause.scope.topic &&
        /先听/u.test(other.text) &&
        !negativeListen.test(other.text),
    );
    if (
      negativeListen.test(clause.text) ||
      (!keepsListenFirst &&
        !/(?:不(?:用|要|必|可以)|别).{0,8}(?:建议|advice)/iu.test(
          clause.text,
        ) &&
        /(?:直接.{0,5}(?:给|提).{0,3}建议|(?:以后|今后|每次|每当|往后|现在起)(?:请|可以|你|都|就)*给我?建议|(?:you can|please).{0,8}give.{0,4}advice)/iu.test(
          clause.text,
        ))
    )
      result.push({
        facet: "advice_timing",
        scope: clause.scope,
        content: text,
      });
    if (
      /(?:不(?:用|要|必)|别).{0,6}主动.{0,4}(?:问|提问|带.{0,3}话题)/u.test(
        clause.text,
      )
    )
      result.push({
        facet: "follow_up_questions",
        scope: clause.scope,
        content: text,
      });
    if (
      /(?:不(?:用|要|必)|别).{0,6}(?:少.{0,3}(?:比喻|比方|修辞)|保持平实|直接说)|(?:可以|允许).{0,5}(?:多用比喻|多打比方)/u.test(
        clause.text,
      )
    )
      result.push({
        facet: "expression_style",
        scope: clause.scope,
        content: text,
      });
    if (
      !/(?:不(?:用|要|必|可以)|别).{0,6}(?:追问|多问|问我|ask)/iu.test(
        clause.text,
      ) &&
      /(?:可以.{0,4}(?:追问|多问)|多.{0,3}问我|(?:you can|please).{0,8}ask)/iu.test(
        clause.text,
      )
    )
      result.push({
        facet: "follow_up_questions",
        scope: clause.scope,
        content: text,
      });
  }
  return result.filter(
    (request, index) =>
      result.findIndex(
        (other) =>
          request.facet === other.facet &&
          request.scope.topic === other.scope.topic,
      ) === index,
  );
}

/** The request time is separate from its effective interval; comma clauses can inherit both. */
function enduringPracticeClauses(
  text: string,
  userId: string,
): Array<{ text: string; scope: PersonaPracticeProposal["scope"] }> {
  const result: Array<{
    text: string;
    scope: PersonaPracticeProposal["scope"];
  }> = [];
  for (const sentence of text.split(/[。；;！？!?]/u)) {
    let scope: PersonaPracticeProposal["scope"] = { userId };
    let enduring = false;
    let unresolvedScope = false;
    for (const clause of sentence.split(
      /(?:[，,]|但是|不过|可是|但|\bbut\b)/iu,
    )) {
      const scopeMatch = practiceScopeMatch(clause);
      if (scopeMatch?.[1] !== undefined) {
        scope = { userId, topic: scopeMatch[1].trim() };
        enduring = true;
        unresolvedScope = false;
      } else if (/(?:时候|当我|谈|聊|关于|\b(?:when|about)\b)/iu.test(clause)) {
        // Do not inherit a previous topic across a new, unparsed condition.
        scope = { userId };
        enduring = false;
        unresolvedScope = true;
        continue;
      }
      for (const marker of clause.matchAll(
        /(?<enduring>以后|今后|每次|每当|往后|(?:从)?现在(?:起|开始)|我(?:不喜欢|希望|更想)|\b(?:I prefer|in future|going forward|from now on)\b)|(?:今天|今晚|这次|现在|这会儿|这一轮|\b(?:today|tonight|this time|right now)\b)/giu,
      ))
        enduring = marker.groups?.enduring !== undefined;
      if (enduring && !unresolvedScope)
        result.push({ text: clause.trim(), scope });
    }
  }
  return result;
}

/** Explicit author changes to dialogue or boundaries require practice review. */
export function personaPracticeBaseSignature(spec: CharacterSpec): string {
  return JSON.stringify({
    dialogue: spec.dialogue,
    boundaries: spec.persona.boundaries,
    userRelationship: spec.userRelationship,
  });
}
