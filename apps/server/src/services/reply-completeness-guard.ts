export type RequestedReplyDeliverable = "draft" | "body" | "list";

export interface ReplyCompletenessIssue {
  code: "REPLY_DELIVERABLE_BODY_MISSING";
  severity: "error";
  requestedDeliverable: RequestedReplyDeliverable;
  requestEvidence: string;
  observedSurfaces: Array<{ surface: "text" | "chunks"; text: string }>;
  detail: string;
}

export interface ReplyCompletenessInput {
  userMessage: string;
  text: string;
  chunks?: readonly string[];
}

const DELIVERABLES: ReadonlyArray<
  readonly [RequestedReplyDeliverable, RegExp]
> = [
  ["body", /正文|成稿|完整(?:内容|文本)|\bbody\b/iu],
  ["list", /清单|列表|提纲|要点|注意事项|\b(?:checklist|list|outline)\b/iu],
  [
    "draft",
    /草稿|初稿|通知|文案|邮件|短信|回信|(?:一|这)(?:段|条).{0,20}(?:话|消息)|\b(?:draft|message|email|letter)\b/iu,
  ],
];

/** Quotes and code in the request are data, not new instructions to produce an
 * artifact. This deliberately abstains on requests expressed only in quotes. */
function unquotedRequest(text: string): string {
  return text.replace(
    /```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`|“[^”]*”|「[^」]*」|『[^』]*』|"[^"\n]*"|'[^'\n]*'/gu,
    " ",
  );
}

function requestedDeliverable(
  userMessage: string,
): { kind: RequestedReplyDeliverable; evidence: string } | undefined {
  // A later "don't write it yet" cancels an earlier draft request. Literal
  // reproduction may validly ask for the exact words of a handoff phrase.
  if (
    /原样|逐字|照抄|只输出|只回复|只写|作为正文|当作正文|(?:复述|引用).{0,12}[“「『"`]/u.test(
      userMessage,
    )
  )
    return undefined;
  const request = unquotedRequest(userMessage);
  if (
    /(?:不要|不用|不需要|无需|不必|先别|暂时别|别再|没让你)[^，,。！？!?；;\n]{0,8}(?:写|拟|起草|整理|列出|生成|给出)/u.test(
      request,
    )
  )
    return undefined;
  for (const clause of request.split(/[，,。！？!?；;\n]/u)) {
    const text = clause.trim();
    // Quoted/metalinguistic, reported and negated requests are intentionally
    // outside this small guard's authority. No inference of arbitrary intent.
    if (/(?:不要|不用|不需要|无需|不必|先别|暂时别|别再|没让你)/u.test(text))
      continue;
    const production = /写|拟|起草|整理|列出|列一|生成|给出/u.exec(text);
    const directChinese =
      production !== null &&
      /^(?:请|麻烦(?:你)?|帮我|替我|为我|给我|能不能|能否|可以(?:帮|替|为)我|写|拟|起草|整理|列出|列一|生成|给出)/u.test(
        text,
      ) &&
      !/(?:解释|分析|讨论|教我|教教|怎么|如何|为什么|是否|检查|评价|看看)/u.test(
        text.slice(0, production.index),
      );
    const directEnglish =
      /^(?:(?:please|can you|could you|would you)\s+)?(?:write|draft|compose|prepare|create|make|give me|list)\b/iu.test(
        text,
      ) &&
      !/\b(?:not|don't|do not|explain|discuss|how to|whether)\b/iu.test(text);
    if (!directChinese && !directEnglish) continue;
    const found = DELIVERABLES.find(([, pattern]) => pattern.test(text));
    if (found !== undefined) return { kind: found[0], evidence: text };
  }
  return undefined;
}

const ACKNOWLEDGMENT =
  /^(?:好(?:的|嘞|啊|呀|啦)?|行|可以|没问题|收到|当然可以|okay|ok|sure)$/iu;
const PREPARED =
  /^(?:我)?(?:(?:已经|已|先|给你|帮你|为你|替你|都|这就)){0,3}(?:整理|写|拟|准备|列|起草|草拟|改写)(?:好|完|出来|好了|完了|出来了|完毕)(?:了)?$/u;
const ARTIFACT_INTRO =
  /^(?:(?:以下|下面|这是|这里是|给你|先给你|附上|送上)(?:是|给你|的)?)?(?:一(?:份|版|条|段))?(?:草稿|正文|清单|通知|文案|邮件|短信|回信|列表|提纲)(?:来(?:了|啦)|如下|给你|在(?:这里|下面))?$/u;
const EDIT_INVITATION =
  /^(?:你)?(?:(?:可以|可|能)(?:直接|先|再|照着|自行|按需|按这(?:版|段|份|个))?|(?:直接|照着|按需|按这(?:版|段|份|个)))(?:改|修改|编辑|复制|复制粘贴|使用|发|发送|转发|过目|看看|参考)(?:一下|看看|就行|即可|了)?$/u;
const HANDOFF = /^(?:给你|先给你)(?:一(?:份|版|条|段))$/u;
const NOT_SENT = /^(?:我)?(?:先|暂时)?(?:不|不会)(?:替你|帮你)?(?:发|发送)$/u;
const ENGLISH_INTRO =
  /^(?:here(?:'s| is) (?:the|your|a) (?:draft|body|list|checklist|message|email)|(?:the|your) (?:draft|list|checklist|message|email) is ready|you can (?:edit|copy|use|send) (?:it|this)(?: directly)?)$/iu;

function onlyEmptyHandoff(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 320) return false;
  // A quote or code fragment can itself be the requested deliverable. Also
  // preserve every nonempty colon body, even a one-word answer like "正文：好。".
  if (/[`“”「」『』"<>]/u.test(trimmed) || /^\s*>/mu.test(trimmed))
    return false;
  const unformatted = trimmed.replace(/[*_~]/gu, "").replace(/[—–]+$/u, "");
  if (/[:：][\s\S]*[^\s:：。.!！；;]/u.test(unformatted)) return false;
  const parts = unformatted
    .split(/[，,。.!！：:；;\n]/u)
    .map((part) => part.trim())
    .filter(Boolean);
  let handoff = false;
  for (const part of parts) {
    const artifactIntro =
      ARTIFACT_INTRO.test(part) &&
      (/[:：]\s*$/u.test(unformatted) ||
        /^(?:以下|下面|这是|这里是|给你|先给你|附上|送上)|(?:来了|来啦|如下|给你|在这里|在下面)$/u.test(
          part,
        ));
    if (
      PREPARED.test(part) ||
      artifactIntro ||
      EDIT_INVITATION.test(part) ||
      HANDOFF.test(part) ||
      ENGLISH_INTRO.test(part)
    ) {
      handoff = true;
      continue;
    }
    if (!ACKNOWLEDGMENT.test(part) && !NOT_SENT.test(part)) return false;
  }
  return handoff;
}

/** Detect only a known empty handoff after an explicit artifact request. This
 * does not grade semantic completeness, infer missing checklist items, reject
 * short answers, or repair content. A body on either surface makes us abstain;
 * the separate surface-coherence guard owns text/chunks disagreement.
 *
 * Integration: use the existing shared one-shot repair allowance, then inspect
 * the repaired reply again. If still empty, record delivery failure rather than
 * removing this lead-in or inventing a substitute artifact. */
export function inspectReplyCompleteness(
  input: ReplyCompletenessInput,
): ReplyCompletenessIssue[] {
  const request = requestedDeliverable(input.userMessage);
  if (request === undefined) return [];
  const observedSurfaces: ReplyCompletenessIssue["observedSurfaces"] = [];
  if (input.text.trim())
    observedSurfaces.push({ surface: "text", text: input.text });
  const chunksText = (input.chunks ?? [])
    .filter((chunk) => chunk.trim())
    .join("\n");
  if (chunksText.trim())
    observedSurfaces.push({ surface: "chunks", text: chunksText });
  // Truly blank output is already handled by schema/persona EMPTY_REPLY checks.
  if (
    !observedSurfaces.length ||
    observedSurfaces.some(({ text }) => !onlyEmptyHandoff(text))
  )
    return [];
  return [
    {
      code: "REPLY_DELIVERABLE_BODY_MISSING",
      severity: "error",
      requestedDeliverable: request.kind,
      requestEvidence: request.evidence,
      observedSurfaces,
      detail:
        "The user explicitly requested a deliverable, but the visible reply contains only a preparation or handoff phrase and no body. Return the actual requested draft, body or list using only supplied facts. Do not merely repeat that it is ready, invent missing details, or claim it was sent. If required information is unavailable, ask a concrete clarification instead of claiming completion.",
    },
  ];
}
