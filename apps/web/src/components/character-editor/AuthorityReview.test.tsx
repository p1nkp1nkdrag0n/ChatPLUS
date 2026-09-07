import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CharacterSpec } from "../../api/types";
import { AuthorityReview } from "./AuthorityReview";

describe("character authority review", () => {
  it("shows the exact candidate, original provider value, effective value and strength before confirmation", () => {
    const spec = {
      authorityAudit: {
        policyVersion: "character_authority_v1",
        contentSha256: "a".repeat(64),
        originalCandidateSha256: "b".repeat(64),
        candidates: [
          {
            candidateId: "candidate-1",
            candidateSha256: "c".repeat(64),
            target: "persona.boundaries",
            strength: "hard",
            status: "pending",
            reason: "来源待确认",
            originalValue: '{"hard":true}',
            providerValue: '{"hard":true,"origin":"user_spec"}',
            effectiveValue: "[]",
          },
        ],
      },
    } as CharacterSpec;
    const html = renderToStaticMarkup(
      <AuthorityReview spec={spec} busy={true} onDecide={() => {}} />,
    );
    expect(html).toContain("待复核 1 项");
    expect(html).toContain("硬约束");
    expect(html).toContain("模型最初返回内容");
    expect(html).toContain("当前采用内容");
    expect(html).toContain("确认此内容与强度");
    expect(html.match(/disabled=""/g)).toHaveLength(2);
    expect(html).not.toContain("一键确认全部");
  });
  it("does not invent provenance or destructive cleanup for historical specs", () => {
    const html = renderToStaticMarkup(
      <AuthorityReview
        spec={{} as CharacterSpec}
        busy={false}
        onDecide={() => {}}
      />,
    );
    expect(html).toContain("尚未记录约束来源");
    expect(html).toContain("原发布版本会保留");
  });
});
