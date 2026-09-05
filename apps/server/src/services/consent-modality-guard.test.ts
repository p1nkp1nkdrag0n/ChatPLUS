import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  applyConsentModalityGuard,
  buildConsentModalityGuardContract,
  consentModalityClaimsFromAudit,
  consentModalityFollowUpClaimsFromAudit,
  consentModalityEffectContext,
  consentModalityPromptSegment,
  finalizeConsentModalityWorld,
} from "./consent-modality-guard.js";
import {
  isConsentClaimEvidenceExcerpt,
  isConsentControlledActivity,
} from "./consent-modality.js";
import type { ResolvedTurn } from "./turn-decision-service.js";
import { analyzeSupportSpeechAct } from "./fuzzy-life-language.js";

const USER_TEXT = "姨妈也许愿意让我单独看修复稿。";
const UNSAFE_REPLY =
  "姨妈愿意让你单独看修复稿，这是她新开的口子：只限你一人，不公开。";

describe("third-party consent modality guard", () => {
  it.each([
    ["姨妈也许愿意让我单独看修复稿。", "possible"],
    ["姨妈可能会允许我查看修复稿。", "possible"],
    ["如果姨妈愿意让我看修复稿，我再告诉你。", "possible"],
    ["姨妈还在考虑是否让我单独看修复稿。", "pending"],
    ["姨妈还没确认是否允许我查看修复稿。", "pending"],
    ["姨妈尚未同意我看修复稿。", "pending"],
    ["姨妈已经明确同意让我单独看修复稿。", "granted"],
    ["姨妈明确说不允许公开修复稿。", "denied"],
    ["姨妈撤回了允许我转发修复稿的授权。", "revoked"],
  ] as const)("recognizes %s as non-granted %s consent", (text, status) => {
    expect(buildConsentModalityGuardContract({ userText: text })).toMatchObject(
      {
        policyVersion: "third_party_consent_modality_v1",
        subject: "姨妈",
        status,
      },
    );
  });

  it.each([
    "我也许愿意让你看看我的修复稿。",
    "公司也许会同意我的申请。",
    "也许周末会下雨。",
    "你愿意一起去看展吗？",
    "我同意你的观点。",
    "我本人已经同意让你看修复稿。",
    "请翻译“姨妈愿意让我看修复稿”。",
    "姨妈没有公开修复稿。",
    "姨妈可以看修复稿。",
    "姨妈能查看修复稿。",
    "爸爸可以下载文件。",
    "朋友可以公开作品。",
    "姨妈不能看修复稿。",
    "姨妈不能公开修复稿。",
    "姨妈不可以下载文件。",
    "姨妈获准查看修复稿。",
    "姨妈已经有公开权限。",
    "姨妈默认查看修复稿。",
    "别当成姨妈同意我看修复稿。",
  ])("does not claim containment ownership for %s", (text) => {
    expect(
      buildConsentModalityGuardContract({ userText: text }),
    ).toBeUndefined();
  });

  it.each([
    "姨妈愿意让我看修复稿吗？",
    "姨妈同意我公开修复稿了吗？",
    "你觉得姨妈会同意我看修复稿吗？",
    "怎样让姨妈同意我看修复稿？",
    "姨妈有没有同意我看修复稿？",
    "姨妈同意我看修复稿？",
    "姨妈同意让我看修复稿没？",
    "姨妈愿意让我看修复稿不？",
    "姨妈答应让我看修复稿了没有？",
  ])("contains a consent query without treating it as evidence: %s", (text) => {
    const contract = buildConsentModalityGuardContract({ userText: text });
    expect(contract).toMatchObject({
      sourceKind: "query",
      status: "pending",
      consentOnly: true,
    });
    if (contract === undefined) throw new Error("Expected query contract");
    const guarded = applyConsentModalityGuard({
      turn: unsafeTurn("是的，姨妈已经同意了，你现在可以看。"),
      contract,
      inspectDecision: () => ({
        validation: { accepted: [], rejections: [] },
        issues: [],
      }),
    });
    expect(guarded.decision.reply.text).toBe(contract.safeReplyText);
    expect(guarded.decision.reply.text).toContain("问题本身不能证明");
    expect(guarded.consentModalityGuardAudit).toMatchObject({
      sourceKind: "query",
    });
  });

  it.each([
    ["姨妈没说过同意我看修复稿。", "pending"],
    ["姨妈未必愿意让我看修复稿。", "possible"],
    ["听说姨妈同意我看修复稿。", "possible"],
    ["朋友说姨妈同意我看修复稿。", "possible"],
    ["姨妈同意以后让我看修复稿。", "possible"],
    ["姨妈说我可以看修复稿。", "granted"],
    ["姨妈默许我查看修复稿。", "granted"],
    ["姨妈要求我不能公开修复稿。", "denied"],
  ] as const)(
    "keeps indirect, future, and explicit boundary wording calibrated: %s",
    (text, status) => {
      expect(
        buildConsentModalityGuardContract({ userText: text }),
      ).toMatchObject({
        subject: "姨妈",
        status,
      });
    },
  );

  it.each([
    "姨妈没答应让我看修复稿。",
    "姨妈没有说她愿意让我看修复稿。",
    "姨妈否认同意我看修复稿。",
    "姨妈不承认同意我看修复稿。",
    "姨妈不曾同意我看修复稿。",
    "姨妈尚不能同意我看修复稿。",
    "姨妈不便同意我看修复稿。",
  ])("never upgrades a negated grant context: %s", (text) => {
    const contract = buildConsentModalityGuardContract({ userText: text });
    expect(contract).toBeDefined();
    expect(contract?.subject).toBe("姨妈");
    expect(contract?.status).not.toBe("granted");
  });

  it("selects the actual grantor nearest the permission predicate", () => {
    expect(
      buildConsentModalityGuardContract({
        userText: "妈妈说爸爸同意我看修复稿。",
      }),
    ).toMatchObject({ subject: "爸爸", status: "possible" });
    expect(
      buildConsentModalityGuardContract({
        userText: "姨妈的儿子说可以给我看修复稿。",
      }),
    ).toMatchObject({ subject: "姨妈的儿子", status: "granted" });
  });

  it("binds each scope to its nearest resource and keeps the latest state", () => {
    const splitResources = buildConsentModalityGuardContract({
      userText: "姨妈允许我查看修复稿和下载原件。",
    });
    expect(splitResources?.scopes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "view", resource: "修复稿" }),
        expect.objectContaining({ kind: "download", resource: "原件" }),
      ]),
    );
    expect(
      buildConsentModalityGuardContract({
        userText: "姨妈同意公开修复稿，后来姨妈撤回了公开授权。",
      }),
    ).toMatchObject({ status: "revoked" });

    const mixedStatus = buildConsentModalityGuardContract({
      userText: "姨妈同意让我单独看修复稿，但不允许公开修复稿。",
    });
    expect(mixedStatus?.safeReplyText).toContain("已同意单独看修复稿");
    expect(mixedStatus?.safeReplyText).toContain("明确不允许公开修复稿");
    expect(mixedStatus?.safeReplyText).not.toContain(
      "已同意单独看修复稿、公开修复稿",
    );

    const linkedBoundaries = buildConsentModalityGuardContract({
      userText:
        "姨妈允许我看修复稿，但不能公开，不过目前不能转发，而且不允许下载。",
    });
    expect(linkedBoundaries?.claims).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          subject: "姨妈",
          scopeKind: "view",
          status: "granted",
        }),
        expect.objectContaining({
          subject: "姨妈",
          scopeKind: "publish",
          status: "denied",
        }),
        expect.objectContaining({
          subject: "姨妈",
          scopeKind: "forward",
          status: "denied",
        }),
        expect.objectContaining({
          subject: "姨妈",
          scopeKind: "download",
          status: "denied",
        }),
      ]),
    );
  });

  it("keeps claim ownership explicit for multiple grantors", () => {
    const contract = buildConsentModalityGuardContract({
      userText: "姨妈同意看修复稿，姐姐同意看照片。",
    });
    if (contract === undefined) throw new Error("Expected consent contract");

    expect(contract.safeReplyText).toContain("姨妈已同意看修复稿");
    expect(contract.safeReplyText).toContain("姐姐已同意看照片");
    expect(contract.safeReplyText).not.toContain("姨妈已同意看修复稿、看照片");

    const guarded = applyConsentModalityGuard({
      turn: unsafeTurn(contract.safeReplyText),
      contract,
      inspectDecision: () => ({
        validation: { accepted: [], rejections: [] },
        issues: [],
      }),
    });
    expect(guarded.consentModalityGuardAudit?.claims).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          subject: "姨妈",
          status: "granted",
          scopeKind: "view",
          resource: "修复稿",
        }),
        expect.objectContaining({
          subject: "姐姐",
          status: "granted",
          scopeKind: "view",
          resource: "照片",
        }),
      ]),
    );
  });

  it.each([
    "姨妈会同意我看修复稿。",
    "姨妈将同意我看修复稿。",
    "姨妈将会允许我看修复稿。",
    "姨妈准备同意我看修复稿。",
    "姨妈打算允许我看修复稿。",
    "姨妈很快会批准我看修复稿。",
    "姨妈周末会同意我看修复稿。",
    "姨妈过会儿会同意我看修复稿。",
  ])("keeps a future consent event non-granted: %s", (text) => {
    expect(buildConsentModalityGuardContract({ userText: text })).toMatchObject(
      { subject: "姨妈", status: "possible" },
    );
  });

  it("distinguishes a present grant for later use from a future grant event", () => {
    expect(
      buildConsentModalityGuardContract({
        userText: "姨妈同意我明天看修复稿。",
      }),
    ).toMatchObject({
      status: "granted",
      claims: [expect.objectContaining({ beneficiaryKey: "user" })],
    });
  });

  it.each([
    "姨妈同意我反对公开照片。",
    "姨妈同意我查看照片的次数太多。",
    "姨妈同意我公开照片是不对的。",
    "姨妈同意我不该查看照片。",
    "姨妈允许我说公开照片是不对的。",
    "姨妈同意关于查看修复稿的规定。",
    "姨妈同意了我提出的看修复稿很重要的看法。",
    "姨妈同意我撤销公开申请。",
    "姨妈批准我撤回查看申请。",
    "姨妈撤销了不许我查看照片的规定。",
  ])("never turns agreement with a proposition into permission: %s", (text) => {
    const contract = buildConsentModalityGuardContract({ userText: text });
    expect(contract).toBeDefined();
    expect(contract?.claims.every((claim) => claim.status !== "granted")).toBe(
      true,
    );
    expect(
      contract?.claims.every(
        (claim) =>
          claim.beneficiary === undefined ||
          !/^(?:关于|对于|针对|把|将|我提出的|我不该|我说)/u.test(
            claim.beneficiary,
          ),
      ),
    ).toBe(true);
  });

  it("applies the latest correction and keeps double negation non-granted", () => {
    const corrected = buildConsentModalityGuardContract({
      userText: "姨妈先说同意我看照片，后来更正为没有同意。",
    });
    expect(corrected).toMatchObject({
      status: "pending",
      consentOnly: true,
      independentText: "",
    });
    expect(corrected?.claims).toHaveLength(1);
    expect(corrected?.claims[0]?.evidenceText).toContain("更正为没有同意");

    expect(
      buildConsentModalityGuardContract({
        userText: "姨妈没有明确表示不允许，也没有表示允许我看照片。",
      }),
    ).toMatchObject({ status: "pending", consentOnly: true });
    expect(
      buildConsentModalityGuardContract({
        userText: "姨妈并非拒绝我看照片。",
      }),
    ).toMatchObject({ status: "pending" });
  });

  it.each([
    "妈妈说，姨妈同意我看修复稿。",
    "妈妈表示，姨妈同意我看修复稿。",
    "妈妈转述，姨妈同意我看修复稿。",
    "妈妈称，姨妈同意我看修复稿。",
    "根据妈妈的转述，姨妈同意我看修复稿。",
    "姐姐说她听姨妈说可以公开修复稿。",
  ])("keeps indirect consent reports possible: %s", (text) => {
    expect(buildConsentModalityGuardContract({ userText: text })).toMatchObject(
      { subject: "姨妈", status: "possible" },
    );
  });

  it.each([
    ["姨妈的照片可否寄给记者？", "share", "姨妈", "记者"],
    ["姨妈的照片，记者能看吗？", "view", "姨妈", "记者"],
    ["我是否有权复制姨妈的底片？", "copy", "姨妈", undefined],
    ["姨妈同意把她的照片发给记者吗？", "share", "姨妈", "记者"],
    ["要把姨妈的照片发给记者，她同意了吗？", "share", "姨妈", "记者"],
    ["把姨妈的底片交给修复师，姨妈本人许可了吗？", "share", "姨妈", "修复师"],
  ] as const)(
    "binds query scope, owner, and recipient for %s",
    (text, scopeKind, subject, beneficiary) => {
      const contract = buildConsentModalityGuardContract({ userText: text });
      expect(contract).toMatchObject({
        sourceKind: "query",
        status: "pending",
        subject,
      });
      expect(contract?.claims[0]).toMatchObject({
        scopeKind,
        ...(beneficiary === undefined ? {} : { beneficiary }),
      });
    },
  );

  it.each([
    ["姨妈准我和姐姐查看照片。", "姨妈", "user_plus:姐姐"],
    ["姨妈只准姐姐查看照片。", "姨妈", "姐姐"],
    ["姨妈同意把照片给姐姐看。", "姨妈", "姐姐"],
  ] as const)(
    "does not let a beneficiary replace the grantor: %s",
    (text, subject, beneficiaryKey) => {
      expect(
        buildConsentModalityGuardContract({ userText: text })?.claims[0],
      ).toMatchObject({ subject, beneficiaryKey, status: "granted" });
    },
  );

  it("does not fold schedule time into the consent beneficiary", () => {
    expect(
      buildConsentModalityGuardContract({
        userText: "姨妈也许愿意让我下周六下午三点看修复稿。",
      })?.claims[0],
    ).toMatchObject({
      subject: "姨妈",
      beneficiary: "我",
      beneficiaryKey: "user",
      status: "possible",
    });
  });

  it("keeps each polarity in a mixed multi-scope statement", () => {
    const contract = buildConsentModalityGuardContract({
      userText: "姨妈同意我查看照片，不过拒绝我保存副本，也不允许公开照片。",
    });
    expect(contract?.claims).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scopeKind: "view", status: "granted" }),
        expect.objectContaining({ scopeKind: "copy", status: "denied" }),
        expect.objectContaining({ scopeKind: "publish", status: "denied" }),
      ]),
    );
    expect(contract).toMatchObject({ consentOnly: true, independentText: "" });
  });

  it.each([
    ["姨妈也许愿意让我看修复稿并谢谢你一直陪我。", "并谢谢你一直陪我"],
    ["姨妈还没同意我公开照片同时我下周二要复诊。", "同时我下周二要复诊"],
    ["姨妈不允许我转发照片而且我已经搬到杭州。", "而且我已经搬到杭州"],
    ["姨妈同意我看照片另外我今晚要加班。", "另外我今晚要加班"],
  ] as const)(
    "preserves exact mixed independent text: %s",
    (text, expected) => {
      expect(
        buildConsentModalityGuardContract({ userText: text }),
      ).toMatchObject({ consentOnly: false, independentText: expected });
    },
  );

  it.each([
    "她给出了肯定答复。",
    "这件事她拍板了。",
    "你现在拥有查看权。",
    "姨妈对此予以认可。",
    "她爽快地应承下来。",
    "你的申请已经通过。",
    "审批已经完成，结论是准予。",
    "姨妈已确认可以。",
    "姨妈的答复是可以。",
    "你已取得查看权。",
    "查看资格已经核发。",
    "她盖章确认了。",
    "她作出了准予决定。",
    "她已经核准。",
    "审批通过了。",
    "她亮了绿灯。",
    "权限都有了，还不能看吗？",
  ])("blocks completed-state paraphrase upgrades: %s", (text) => {
    const contract = buildConsentModalityGuardContract({
      userText: "姨妈还在考虑是否允许我查看照片。",
    });
    if (contract === undefined) throw new Error("Expected consent contract");
    const guarded = applyConsentModalityGuard({
      turn: unsafeTurn(text),
      contract,
      inspectDecision: () => ({
        validation: { accepted: [], rejections: [] },
        issues: [],
      }),
    });
    expect(guarded.decision.reply.text).toBe(contract.safeReplyText);
  });

  it("inherits only an unambiguous adjacent typed consent follow-up", () => {
    const prior = buildConsentModalityGuardContract({
      userText: "姨妈还没确认是否允许我查看照片。",
    });
    if (prior === undefined) throw new Error("Expected prior contract");
    for (const text of ["她回复可以。", "她明确同意了。", "后来她说可以。"]) {
      expect(
        buildConsentModalityGuardContract({
          userText: text,
          priorClaims: prior.claims,
        }),
      ).toMatchObject({ status: "granted", subject: "姨妈" });
    }

    const ambiguous = buildConsentModalityGuardContract({
      userText: "姨妈还没确认是否允许我查看照片，也没确认是否允许我公开照片。",
    });
    if (ambiguous === undefined) throw new Error("Expected ambiguous contract");
    const followUp = buildConsentModalityGuardContract({
      userText: "她回复可以。",
      priorClaims: ambiguous.claims,
    });
    expect(followUp?.claims).toHaveLength(2);
    expect(followUp?.claims.every((claim) => claim.status === "pending")).toBe(
      true,
    );
  });

  it.each([
    "她确认收到邮件了。",
    "她确认明天去医院。",
    "她确认收到邮件了吗？",
    "她同意明天去医院。",
    "她回复可以明天去医院。",
    "她取消了医院预约。",
  ])(
    "preserves a new proposition instead of inheriting consent: %s",
    (text) => {
      const prior = buildConsentModalityGuardContract({
        userText: "姨妈还没确认是否允许我查看照片。",
      })!;
      expect(
        buildConsentModalityGuardContract({
          userText: text,
          priorClaims: prior.claims,
        }),
      ).toBeUndefined();
    },
  );

  it("keeps an unspecified confirmation pending and retains a subsequent independent fact", () => {
    const prior = buildConsentModalityGuardContract({
      userText: "姨妈还没确认是否允许我查看照片。",
    })!;
    expect(
      buildConsentModalityGuardContract({
        userText: "她确认了。",
        priorClaims: prior.claims,
      }),
    ).toMatchObject({ status: "pending" });
    expect(
      buildConsentModalityGuardContract({
        userText: "她回复可以。她确认明天去医院。",
        priorClaims: prior.claims,
      }),
    ).toMatchObject({
      status: "granted",
      consentOnly: false,
      independentText: "她确认明天去医院",
    });
  });

  it("inherits restrictions from a pure audit but not an ambiguous mixed topic", () => {
    const contract = buildConsentModalityGuardContract({
      userText: "姨妈还没同意我私下查看照片。",
    })!;
    const audit = { consentOnly: true, claims: contract.claims };
    const priorClaims = consentModalityFollowUpClaimsFromAudit(audit);
    expect(priorClaims).toEqual(contract.claims);
    expect(
      buildConsentModalityGuardContract({
        userText: "她回复可以。",
        priorClaims,
      })?.claims[0]?.restrictions,
    ).toEqual(contract.claims[0]?.restrictions);
    expect(
      consentModalityFollowUpClaimsFromAudit({ ...audit, consentOnly: false }),
    ).toEqual([]);
  });

  it.each([
    "另外我现在明确授权你在接受影像平台副主编岗位和启动独立影像项目之间替我作一次决定",
    "现在我明确授权你，只在接受影像平台副主编岗位和启动独立影像项目之间替我作一次决定",
  ])(
    "preserves the user's independent delegation and its punctuation: %s",
    (delegation) => {
      const contract = buildConsentModalityGuardContract({
        userText: `姨妈还没同意公开照片；${delegation}。`,
      })!;
      expect(contract.consentOnly).toBe(false);
      expect(contract.claims).toHaveLength(1);
      expect(contract.independentText).toBe(delegation.normalize("NFKC"));
      expect(analyzeSupportSpeechAct(contract.independentText)).toEqual(
        analyzeSupportSpeechAct(delegation.normalize("NFKC")),
      );
      if (delegation.includes("，")) {
        expect(
          analyzeSupportSpeechAct(contract.independentText).delegated,
        ).toBe(true);
      }
    },
  );

  it("replaces a grant overclaim and strips every model-owned semantic effect", () => {
    const contract = buildConsentModalityGuardContract({
      userText: USER_TEXT,
    });
    if (contract === undefined) throw new Error("Expected consent contract");
    const guarded = applyConsentModalityGuard({
      turn: unsafeTurn(),
      contract,
      inspectDecision: () => ({
        validation: { accepted: [], rejections: [] },
        issues: [],
      }),
    });

    expect(guarded.decision.reply).toMatchObject({
      text: contract.safeReplyText,
      chunks: [contract.safeReplyText],
    });
    expect(contract.safeReplyText).toContain("不能当作已经授权");
    expect(contract.safeReplyText).toContain("姨妈本人明确确认");
    expect(guarded.decision.scheduleEffects).toEqual([]);
    expect(guarded.decision.stateDelta).toBeUndefined();
    expect(guarded.decision.relationshipDelta).toBeUndefined();
    expect(guarded.decision.memoryCandidates).toEqual([]);
    expect(guarded.decision.personalIntentCandidates).toEqual([]);
    expect(guarded.decision.continuityEffects).toBeUndefined();
    expect(guarded.scheduleAction).toEqual({ kind: "none" });
    expect(guarded.continuityEffects).toBeUndefined();
    expect(guarded.worldEffectsAudit?.validation.effects).toEqual({
      memoryCandidates: [],
      personalIntentCandidates: [],
    });
    expect(guarded.consentModalityGuardAudit).toEqual(
      expect.objectContaining({
        policyVersion: "third_party_consent_modality_v1",
        subject: "姨妈",
        status: "possible",
        modelReplyContentChanged: true,
        modelSideEffectsBlocked: true,
        contentDerivedSemanticsSkipped: true,
        finalTextSha256: createHash("sha256")
          .update(contract.safeReplyText, "utf8")
          .digest("hex"),
      }),
    );
  });

  it("keeps a safe calibrated reply while still blocking model-owned effects", () => {
    const contract = buildConsentModalityGuardContract({
      userText: USER_TEXT,
    });
    if (contract === undefined) throw new Error("Expected consent contract");
    const safeText =
      "这只是姨妈可能愿意，还不是已经授权；要等姨妈本人明确确认。";
    const guarded = applyConsentModalityGuard({
      turn: unsafeTurn(safeText),
      contract,
      inspectDecision: () => ({
        validation: { accepted: [], rejections: [] },
        issues: [],
      }),
    });

    expect(guarded.decision.reply.text).toBe(safeText);
    expect(guarded.consentModalityGuardAudit).toMatchObject({
      modelReplyContentChanged: false,
      modelSideEffectsBlocked: true,
    });
    expect(guarded.decision.memoryCandidates).toEqual([]);
  });

  it.each([
    "所以你现在能看了。",
    "姨妈已经同意了。",
    "这就是她点头了。",
    "她给你开绿灯了。",
    "放心看吧。",
    "那你就看吧。",
    "这说明你能看。",
    "姨妈愿意。",
    "已经点头。",
    "她开了绿灯。",
    "她点了头。",
    "她默认了。",
    "她默许了。",
    "你获准了。",
    "权限已经有了。",
    "也就是说，你有权限了。",
    "你已经有查看权限了。",
    "她准了。",
    "她应允了。",
    "她允诺了。",
    "她说好了。",
    "她说没问题。",
  ])("blocks a grant upgrade even when the reply omits context: %s", (text) => {
    const contract = buildConsentModalityGuardContract({
      userText: USER_TEXT,
    });
    if (contract === undefined) throw new Error("Expected consent contract");
    const guarded = applyConsentModalityGuard({
      turn: unsafeTurn(text),
      contract,
      inspectDecision: () => ({
        validation: { accepted: [], rejections: [] },
        issues: [],
      }),
    });

    expect(guarded.decision.reply.text).toBe(contract.safeReplyText);
    expect(guarded.consentModalityGuardAudit).toMatchObject({
      modelReplyContentChanged: true,
    });
  });

  it.each([
    "这只是可能，还不能当成授权。",
    "现在还不能算同意。",
    "不能确定她已经授权。",
    "这个问题本身不能证明她已经同意。",
  ])("preserves a contextual non-grant disclaimer: %s", (text) => {
    const contract = buildConsentModalityGuardContract({
      userText: USER_TEXT,
    });
    if (contract === undefined) throw new Error("Expected consent contract");
    const guarded = applyConsentModalityGuard({
      turn: unsafeTurn(text),
      contract,
      inspectDecision: () => ({
        validation: { accepted: [], rejections: [] },
        issues: [],
      }),
    });

    expect(guarded.decision.reply.text).toBe(text);
    expect(guarded.consentModalityGuardAudit).toMatchObject({
      modelReplyContentChanged: false,
    });
  });

  it.each([
    ["姨妈也许愿意让我看修复稿。", "所以目前不能看。", false],
    ["姨妈已经明确同意让我看修复稿。", "但不能公开。", false],
    ["姨妈已经明确同意让我看修复稿。", "这不代表可以公开或转发。", false],
    ["姨妈已经明确同意让我看修复稿。", "这不代表她已经同意。", true],
    ["姨妈已经明确同意让我看修复稿。", "所以目前不能看。", true],
    ["姨妈也许愿意让我看修复稿。", "姨妈已经明确拒绝让我看。", true],
  ] as const)(
    "distinguishes an operational boundary from a consent fact: %s / %s",
    (userText, replyText, changed) => {
      const contract = buildConsentModalityGuardContract({ userText });
      if (contract === undefined) throw new Error("Expected consent contract");
      const guarded = applyConsentModalityGuard({
        turn: unsafeTurn(replyText),
        contract,
        inspectDecision: () => ({
          validation: { accepted: [], rejections: [] },
          issues: [],
        }),
      });

      expect(guarded.consentModalityGuardAudit).toMatchObject({
        modelReplyContentChanged: changed,
      });
      expect(guarded.decision.reply.text).toBe(
        changed ? contract.safeReplyText : replyText,
      );
    },
  );

  it.each([
    "姨妈也许愿意让我看修复稿但这不代表她已经授权。",
    "姨妈也许愿意让我看修复稿所以不能说她已经同意。",
    "姨妈可能允许我看修复稿不过这还不能算授权。",
  ])(
    "keeps an unpunctuated disclaimer attached to a possible claim: %s",
    (text) => {
      expect(
        buildConsentModalityGuardContract({ userText: text }),
      ).toMatchObject({
        status: "possible",
        consentOnly: true,
      });
    },
  );

  it("blocks a model from broadening an explicit view grant into publication or forwarding", () => {
    const contract = buildConsentModalityGuardContract({
      userText: "姨妈已经明确同意让我单独看修复稿。",
    });
    if (contract === undefined) throw new Error("Expected consent contract");
    const broadened = unsafeTurn(
      "姨妈已经同意你单独看修复稿，所以现在也可以公开和转发修复稿。",
    );
    const guarded = applyConsentModalityGuard({
      turn: broadened,
      contract,
      inspectDecision: () => ({
        validation: { accepted: [], rejections: [] },
        issues: [],
      }),
    });

    expect(guarded.decision.reply.text).toBe(contract.safeReplyText);
    expect(guarded.decision.reply.text).toContain("仅能确认");
    expect(guarded.decision.reply.text).toContain("单独看修复稿");
    expect(guarded.consentModalityGuardAudit).toMatchObject({
      status: "granted",
      modelReplyContentChanged: true,
    });
  });

  it.each([
    "你现在也可以公开了。",
    "可以转发了。",
    "可以下载了。",
    "现在可以披露了。",
    "现在可以公示了。",
    "现在可以展出了。",
    "现在可以参展了。",
    "现在可以共享了。",
    "现在可以转送了。",
    "现在可以拷贝了。",
    "现在可以复印了。",
    "现在可以用于展览了。",
    "现在可以剪辑了。",
    "所以公开也没问题。",
    "那就发出去吧。",
    "现在能拿给别人看了。",
    "可以发给大家了。",
    "可以放到网上了。",
    "可以发朋友圈了。",
    "可以保存一份了。",
    "可以留个副本了。",
    "可以截图了。",
    "可以打印了。",
    "你有公开权限了。",
  ])("blocks an omitted-resource scope expansion: %s", (text) => {
    const contract = buildConsentModalityGuardContract({
      userText: "姨妈已经明确同意让我单独看修复稿。",
    });
    if (contract === undefined) throw new Error("Expected consent contract");
    const guarded = applyConsentModalityGuard({
      turn: unsafeTurn(text),
      contract,
      inspectDecision: () => ({
        validation: { accepted: [], rejections: [] },
        issues: [],
      }),
    });

    expect(guarded.decision.reply.text).toBe(contract.safeReplyText);
  });

  it("fails closed when a new scope omits an ambiguous resource", () => {
    const contract = buildConsentModalityGuardContract({
      userText: "姨妈允许我查看修复稿和下载原件。",
    });
    if (contract === undefined) throw new Error("Expected consent contract");

    for (const text of ["现在可以公开了。", "所以可以转发了。"]) {
      const guarded = applyConsentModalityGuard({
        turn: unsafeTurn(text),
        contract,
        inspectDecision: () => ({
          validation: { accepted: [], rejections: [] },
          issues: [],
        }),
      });
      expect(guarded.decision.reply.text).toBe(contract.safeReplyText);
    }
  });

  it("keeps an omitted-resource denial on its new scope", () => {
    const contract = buildConsentModalityGuardContract({
      userText: "姨妈允许我查看修复稿，但不允许公开，也不允许转发。",
    });
    expect(contract?.claims).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scopeKind: "view", status: "granted" }),
        expect.objectContaining({ scopeKind: "publish", status: "denied" }),
        expect.objectContaining({ scopeKind: "forward", status: "denied" }),
      ]),
    );
  });

  it("preserves unrelated validated effects on a mixed consent and scheduling turn", () => {
    const contract = buildConsentModalityGuardContract({
      userText:
        "姨妈也许愿意让我单独看修复稿；另外请明早八点提醒我联系修复师。",
    });
    if (contract === undefined) throw new Error("Expected consent contract");
    expect(contract.consentOnly).toBe(false);
    const safeText =
      "这还只是可能，要等姨妈本人明确确认。明早提醒你的安排我会按约定处理。";
    const guarded = applyConsentModalityGuard({
      turn: unsafeTurn(safeText),
      contract,
      inspectDecision: () => ({
        validation: { accepted: [], rejections: [] },
        issues: [],
      }),
    });

    expect(guarded.decision.reply.text).toBe(safeText);
    expect(guarded.decision.scheduleEffects).toHaveLength(1);
    expect(guarded.decision.stateDelta).toEqual({ stress: -0.1 });
    expect(guarded.decision.relationshipDelta).toEqual({ trust: 0.1 });
    expect(guarded.scheduleAction).toEqual({ kind: "request_details" });
    expect(guarded.decision.memoryCandidates).toEqual([]);
    expect(guarded.consentModalityGuardAudit).toMatchObject({
      consentOnly: false,
      contentDerivedSemanticsSkipped: false,
    });
  });

  it("keeps an unrelated reply sentence when replacing an unsafe consent sentence", () => {
    const contract = buildConsentModalityGuardContract({
      userText:
        "姨妈也许愿意让我单独看修复稿；另外请明早八点提醒我联系修复师。",
    });
    if (contract === undefined) throw new Error("Expected consent contract");
    const scheduleReply = "明早提醒你的安排我会按约定处理。";
    const guarded = applyConsentModalityGuard({
      turn: unsafeTurn(`姨妈已经同意你看修复稿。那你就看吧。${scheduleReply}`),
      contract,
      inspectDecision: () => ({
        validation: { accepted: [], rejections: [] },
        issues: [],
      }),
    });

    expect(guarded.decision.reply.text).toContain(contract.safeReplyText);
    expect(guarded.decision.reply.text).toContain(scheduleReply);
    expect(guarded.decision.reply.text).not.toContain("那你就看吧");
    expect(guarded.decision.scheduleEffects).toHaveLength(1);
    expect(guarded.scheduleAction).toEqual({ kind: "request_details" });
  });

  it("treats an unpunctuated reminder as mixed rather than consent-only", () => {
    expect(
      buildConsentModalityGuardContract({
        userText: "姨妈也许愿意让我看修复稿并请明早提醒我联系修复师。",
      }),
    ).toMatchObject({ consentOnly: false });
  });

  it.each([
    "姨妈也许愿意让我看修复稿并且我最好的朋友叫阿宁。",
    "姨妈也许愿意让我看修复稿并记住我喜欢乌龙茶。",
    "姨妈也许愿意让我看修复稿并谢谢你一直陪我。",
  ])("preserves an unpunctuated independent mixed intent: %s", (text) => {
    expect(buildConsentModalityGuardContract({ userText: text })).toMatchObject(
      {
        consentOnly: false,
      },
    );
  });

  it("filters mixed continuity effects per candidate without treating evidence as semantic ownership", () => {
    const mixedText = "姨妈也许愿意让我单独看修复稿；我下周要交论文。";
    const contract = buildConsentModalityGuardContract({ userText: mixedText });
    if (contract === undefined) throw new Error("Expected consent contract");
    expect(contract.consentOnly).toBe(false);
    const poison = { contextSummary: "姨妈已经授权查看修复稿。" };
    const unrelated = {
      contextSummary: "用户下周要交论文。",
      evidenceQuotes: [mixedText],
    };
    const turn = unsafeTurn(
      "姨妈是否授权仍需本人确认。你下周要交论文这件事我记住了。",
    );
    turn.decision.continuityEffects = {
      followUpCandidates: [poison, unrelated],
      followUpTransitions: [
        { contextSummary: "基于姨妈已经授权而推进。" },
        { contextSummary: "论文跟进保持待处理。" },
      ],
      careCueCandidates: [poison, unrelated],
    } as never;
    turn.continuityEffects = {
      followUpCandidates: [poison, unrelated],
      followUpTransitions: [],
      careCueCandidates: [poison, unrelated],
    };

    const guarded = applyConsentModalityGuard({
      turn,
      contract,
      inspectDecision: () => ({
        validation: { accepted: [], rejections: [] },
        issues: [],
      }),
    });

    expect(guarded.decision.continuityEffects).toEqual({
      followUpCandidates: [unrelated],
      followUpTransitions: [{ contextSummary: "论文跟进保持待处理。" }],
      careCueCandidates: [unrelated],
    });
    expect(guarded.continuityEffects).toEqual({
      followUpCandidates: [unrelated],
      followUpTransitions: [],
      careCueCandidates: [unrelated],
    });
    expect(guarded.consentModalityGuardAudit).toMatchObject({
      modelSideEffectsBlocked: true,
      contentDerivedSemanticsSkipped: false,
    });
  });

  it("blocks a consent-controlled schedule effect and negotiation while retaining an unrelated schedule", () => {
    const contract = buildConsentModalityGuardContract({
      userText: "姨妈也许愿意让我下周六下午三点看修复稿；另外请安排周末喝茶。",
    });
    if (contract === undefined) throw new Error("Expected consent contract");
    const protectedEffect = scheduleEffect(
      "查看修复稿",
      "下周六下午三点查看修复稿",
    );
    const unrelatedEffect = scheduleEffect("周末喝茶", "和朋友周末喝茶");
    const turn = cleanTurn(
      `${contract.safeReplyText}\n周末喝茶的安排可以继续确认。`,
    );
    turn.decision.scheduleEffects = [protectedEffect, unrelatedEffect] as never;
    turn.scheduleAction = {
      kind: "accept_user_offer",
      offer: {
        activity: "查看修复稿",
        category: "other",
        startAt: "下周六下午三点",
        evidenceQuotes: ["姨妈也许愿意让我下周六下午三点看修复稿"],
      },
    };
    turn.modelScheduleActionAudit = {
      origin: "model_explicit_valid",
      kind: "accept_user_offer",
    };

    const guarded = applyConsentModalityGuard({
      turn,
      contract,
      inspectDecision: () => ({
        validation: { accepted: [], rejections: [] },
        issues: [],
      }),
    });

    expect(guarded.decision.scheduleEffects).toEqual([unrelatedEffect]);
    expect(guarded.scheduleAction).toEqual({ kind: "none" });
    expect(guarded.modelScheduleActionAudit).toEqual({
      origin: "model_invalid",
      kind: "none",
    });
    expect(guarded.consentModalityGuardAudit).toMatchObject({
      consentOnly: false,
      modelSideEffectsBlocked: true,
    });
  });

  it.each([
    "阅读修复稿",
    "公开修复稿",
    "展示修复稿",
    "分享修复稿",
    "转发修复稿",
    "下载修复稿",
    "复制修复稿",
    "使用修复稿",
    "改编修复稿",
  ])(
    "treats same-resource cross-scope activity as protected: %s",
    (activity) => {
      const contract = buildConsentModalityGuardContract({
        userText: "姨妈也许愿意让我看修复稿。",
      });
      if (contract === undefined) throw new Error("Expected consent contract");

      expect(
        isConsentControlledActivity({
          claims: contract.claims,
          candidateText: activity,
        }),
      ).toBe(true);
    },
  );

  it("recognizes a grounded consent excerpt without requiring it to repeat modality", () => {
    const contract = buildConsentModalityGuardContract({
      userText:
        "姨妈也许愿意让我下周六下午三点看修复稿；另外我们安排明天下午四点喝茶。",
    });
    if (contract === undefined) throw new Error("Expected consent contract");

    expect(
      isConsentClaimEvidenceExcerpt({
        claims: contract.claims,
        candidateText: "看修复稿",
      }),
    ).toBe(true);
    expect(
      isConsentClaimEvidenceExcerpt({
        claims: contract.claims,
        candidateText: "另外我们安排明天下午四点喝茶",
      }),
    ).toBe(false);
  });

  it("does not duplicate a precise pre-normalization consent rejection", () => {
    const contract = buildConsentModalityGuardContract({
      userText: "姨妈也许愿意让我看修复稿；另外我们安排明天下午四点喝茶。",
    });
    if (contract === undefined) throw new Error("Expected consent contract");
    const turn = cleanTurn(contract.safeReplyText);
    turn.modelRejections = [
      {
        raw: { operation: "cancel", itemTitle: "查看修复稿" },
        reasonCode: "consent_modality_effect_blocked",
        reasonSummary: "precise raw rejection",
      },
    ];

    const guarded = applyConsentModalityGuard({
      turn,
      contract,
      inspectDecision: () => ({
        validation: { accepted: [], rejections: [] },
        issues: [],
      }),
    });

    expect(
      guarded.modelRejections.filter(
        (rejection) =>
          rejection.reasonCode === "consent_modality_effect_blocked",
      ),
    ).toHaveLength(1);
    expect(guarded.consentModalityGuardAudit).toMatchObject({
      modelSideEffectsBlocked: true,
    });
  });

  it("removes a post-world protected effect, its cloned negotiation, and presentation atomically", () => {
    const contract = buildConsentModalityGuardContract({
      userText: "姨妈也许愿意让我下周六下午三点看修复稿；另外请安排周末喝茶。",
    });
    if (contract === undefined) throw new Error("Expected consent contract");
    const protectedEffect = scheduleEffect(
      "查看修复稿",
      "下周六下午三点查看修复稿",
    );
    const protectedClone = structuredClone(protectedEffect);
    const unrelatedEffect = scheduleEffect("周末喝茶", "和朋友周末喝茶");
    const guarded = applyConsentModalityGuard({
      turn: cleanTurn(contract.safeReplyText),
      contract,
      inspectDecision: () => ({
        validation: { accepted: [], rejections: [] },
        issues: [],
      }),
    });
    const presentation =
      "【待确认日程】2026-09-12 15:00，查看修复稿，60 分钟。";
    const finalized = finalizeConsentModalityWorld({
      turn: guarded,
      contract,
      world: {
        decision: {
          ...guarded.decision,
          reply: {
            ...guarded.decision.reply,
            text: `${contract.safeReplyText}\n\n${presentation}`,
            chunks: [`${contract.safeReplyText}\n\n${presentation}`],
          },
          scheduleEffects: [protectedEffect, unrelatedEffect],
        },
        validation: {
          accepted: [protectedEffect, unrelatedEffect],
          rejections: [],
        },
        negotiationPlan: {
          actionKind: "accept_user_offer",
          updates: [],
          effect: protectedClone,
          presentationText: presentation,
          rejections: [],
        },
        proposalRejections: [],
        decisionPath: "full",
        effectTrace: { rejectionCodes: [] },
      } as never,
    });

    expect(finalized.world.validation.accepted).toEqual([unrelatedEffect]);
    expect(finalized.world.decision.scheduleEffects).toEqual([unrelatedEffect]);
    expect(finalized.world.negotiationPlan).toBeUndefined();
    expect(finalized.world.decision.reply.text).not.toContain(presentation);
    expect(finalized.world.proposalRejections).toHaveLength(1);
    expect(finalized.world.decisionPath).toBe("partial");
    expect(finalized.world.effectTrace.rejectionCodes).toContain(
      "consent_modality_effect_blocked",
    );
    expect(finalized.turn.consentModalityGuardAudit).toMatchObject({
      modelSideEffectsBlocked: true,
      finalTextSha256: createHash("sha256")
        .update(finalized.world.decision.reply.text, "utf8")
        .digest("hex"),
    });
  });

  it("removes a protected plan before it can persist even when it has no effect yet", () => {
    const contract = buildConsentModalityGuardContract({
      userText: "姨妈也许愿意让我下周六下午三点看修复稿；另外今天心情不错。",
    });
    if (contract === undefined) throw new Error("Expected consent contract");
    const guarded = applyConsentModalityGuard({
      turn: cleanTurn(contract.safeReplyText),
      contract,
      inspectDecision: () => ({
        validation: { accepted: [], rejections: [] },
        issues: [],
      }),
    });
    const presentation =
      "【待确认日程】2026-09-12 15:00，查看修复稿，60 分钟。";
    const finalized = finalizeConsentModalityWorld({
      turn: guarded,
      contract,
      world: {
        decision: {
          ...guarded.decision,
          reply: {
            ...guarded.decision.reply,
            text: `${contract.safeReplyText}\n\n${presentation}`,
            chunks: [`${contract.safeReplyText}\n\n${presentation}`],
          },
        },
        validation: { accepted: [], rejections: [] },
        negotiationPlan: {
          actionKind: "accept_user_offer",
          updates: [{ offer: { activity: "查看修复稿" } }],
          presentationText: presentation,
          rejections: [],
        },
        proposalRejections: [],
        decisionPath: "full",
        effectTrace: { rejectionCodes: [] },
      } as never,
    });

    expect(finalized.world.negotiationPlan).toBeUndefined();
    expect(finalized.world.decision.reply.text).not.toContain(presentation);
    expect(finalized.world.decisionPath).toBe("effects_rejected");
    expect(finalized.world.proposalRejections).toHaveLength(1);
  });

  it("removes consent-only memory tags and records the candidate-level rejection", () => {
    const contract = buildConsentModalityGuardContract({
      userText: "姨妈也许愿意让我看修复稿；另外我最喜欢的饮料是乌龙茶。",
    });
    if (contract === undefined) throw new Error("Expected consent contract");
    const turn = cleanTurn("授权仍待确认。我记住你喜欢乌龙茶了。");
    const candidate = {
      content: "用户最喜欢的饮料是乌龙茶。",
      tags: ["user_fact", "姨妈已经授权查看修复稿"],
    };
    turn.decision.memoryCandidates = [candidate] as never;
    turn.worldEffectsAudit = {
      mode: "enforced",
      validation: {
        proposed: {},
        effects: {
          memoryCandidates: [candidate],
          personalIntentCandidates: [],
        },
        rejections: [],
        limitsApplied: [],
      } as never,
    };

    const guarded = applyConsentModalityGuard({
      turn,
      contract,
      inspectDecision: () => ({
        validation: { accepted: [], rejections: [] },
        issues: [],
      }),
    });

    expect(guarded.decision.memoryCandidates).toEqual([
      { content: candidate.content, tags: ["user_fact"] },
    ]);
    expect(
      guarded.worldEffectsAudit?.validation.effects.memoryCandidates,
    ).toEqual([{ content: candidate.content, tags: ["user_fact"] }]);
    expect(guarded.worldEffectsAudit?.validation.rejections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          effect: "memory_candidate",
          reasonCode: "consent_modality_effect_blocked",
        }),
      ]),
    );
  });

  it("round-trips typed claims, beneficiaries, and restrictions from audit", () => {
    const contract = buildConsentModalityGuardContract({
      userText:
        "姨妈同意我今天私下查看照片一次，必须她本人陪同，而且不得商用。",
    });
    if (contract === undefined) throw new Error("Expected consent contract");
    const guarded = applyConsentModalityGuard({
      turn: cleanTurn(contract.safeReplyText),
      contract,
      inspectDecision: () => ({
        validation: { accepted: [], rejections: [] },
        issues: [],
      }),
    });
    expect(
      consentModalityClaimsFromAudit(guarded.consentModalityGuardAudit),
    ).toEqual(contract.claims);
  });

  it("disables negotiation only for a consent-only turn", () => {
    const current = {
      effectsEligible: true,
      scheduleNegotiationEligible: true,
      negotiationEnforced: true,
    };
    const pure = buildConsentModalityGuardContract({ userText: USER_TEXT });
    const mixed = buildConsentModalityGuardContract({
      userText:
        "姨妈也许愿意让我单独看修复稿；另外请明早八点提醒我联系修复师。",
    });
    if (pure === undefined || mixed === undefined) {
      throw new Error("Expected consent contracts");
    }

    expect(consentModalityEffectContext(current, pure)).toEqual({
      effectsEligible: false,
      scheduleNegotiationEligible: false,
      negotiationEnforced: false,
    });
    expect(consentModalityEffectContext(current, mixed)).toMatchObject({
      ...current,
      consentModality: {
        evidenceText: mixed.evidenceText,
        claims: mixed.claims,
      },
    });
  });

  it("renders a required prompt segment that denies model ownership of consent state", () => {
    const contract = buildConsentModalityGuardContract({
      userText: USER_TEXT,
    });
    if (contract === undefined) throw new Error("Expected consent contract");
    const segment = consentModalityPromptSegment(contract);

    expect(segment).toMatchObject({
      id: "14a_consent_modality_guard",
      placement: "prompt",
      required: true,
    });
    const rendered = segment.render({});
    expect(rendered).toContain("CONSENT_MODALITY_GUARD_JSON");
    expect(rendered).toContain("possible/pending is never granted");
    expect(rendered).toContain(USER_TEXT.slice(0, -1));
  });
});

function unsafeTurn(replyText = UNSAFE_REPLY): ResolvedTurn {
  return {
    decision: {
      reply: {
        text: replyText,
        chunks: [replyText],
        toneTags: ["武断"],
      },
      scheduleEffects: [{ operation: "create" }],
      stateDelta: { stress: -0.1 },
      relationshipDelta: { trust: 0.1 },
      memoryCandidates: [{ content: "姨妈已经授权查看修复稿。" }],
      personalIntentCandidates: [{ activity: "公开修复稿" }],
      continuityEffects: { careCueCandidates: [{}] },
      reasonCode: "persona_chat_decision",
      reasonSummary: "unsafe consent overclaim",
    } as never,
    inspection: {
      validation: { accepted: [{ operation: "create" }], rejections: [] },
      issues: [],
    } as never,
    repairAttempted: false,
    usedFallback: false,
    modelRejections: [],
    scheduleAction: { kind: "request_details" },
    modelScheduleActionAudit: {
      origin: "model_explicit_valid",
      kind: "request_details",
    },
    continuityEffects: { followUpCandidates: [{}] },
    worldEffectsAudit: {
      mode: "enforced",
      validation: {
        proposed: {
          stateDelta: { stress: -0.1 },
          relationshipDelta: { trust: 0.1 },
        },
        effects: {
          stateDelta: { stress: -0.1 },
          relationshipDelta: { trust: 0.1 },
          memoryCandidates: [{ content: "姨妈已经授权查看修复稿。" }],
          personalIntentCandidates: [{ activity: "公开修复稿" }],
        },
        rejections: [],
        limitsApplied: [],
      } as never,
    },
  };
}

function cleanTurn(replyText: string): ResolvedTurn {
  return {
    decision: {
      reply: {
        text: replyText,
        chunks: [replyText],
        toneTags: ["谨慎"],
      },
      scheduleEffects: [],
      memoryCandidates: [],
      personalIntentCandidates: [],
      reasonCode: "persona_chat_decision",
      reasonSummary: "safe test decision",
    },
    inspection: {
      validation: { accepted: [], rejections: [] },
      issues: [],
    },
    repairAttempted: false,
    usedFallback: false,
    modelRejections: [],
    scheduleAction: { kind: "none" },
    modelScheduleActionAudit: {
      origin: "model_explicit_valid",
      kind: "none",
    },
  };
}

function scheduleEffect(title: string, description: string) {
  return {
    operation: "create" as const,
    item: {
      title,
      description,
      category: "other" as const,
      startAtUtc: "2026-09-12T07:00:00.000Z",
      endAtUtc: "2026-09-12T08:00:00.000Z",
      timezone: "Asia/Shanghai",
      rigidity: "committed" as const,
      priority: 0.8,
      source: "user_request" as const,
      adherenceProbability: 0.9,
      narrativeImportance: 0.5,
      shareable: true,
      stateEffects: {},
    },
    reasonCode: "test_schedule",
    reasonSummary: description,
  };
}
