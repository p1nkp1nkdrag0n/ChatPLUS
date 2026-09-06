import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type {
  KeepsakeSummaryResponse,
  RelationshipArchiveEntry,
} from "@personasim/contracts";
import { ShareComposer } from "./ShareComposer";

function letter(
  id: string,
  status: "delivered_unread" | "read",
  title: string,
): RelationshipArchiveEntry {
  return {
    id,
    agentId: "agent-1",
    entryType: "letter",
    title,
    summary: "安全摘要",
    effectiveAtUtc: "2026-09-13T00:00:00.000Z",
    recordedAtUtc: "2026-09-15T00:00:00.000Z",
    href: `/letters/${id}`,
    sourceIds: [id],
    letterId: id,
    threadId: "thread-1",
    direction: "agent_to_user",
    status,
    postmark: "2026-09-08 · Asia/Shanghai",
    waitingDays: 5,
  };
}

const keepsake: KeepsakeSummaryResponse = {
  id: "keepsake-1",
  agentId: "agent-1",
  title: "雨夜电影票",
  kind: "ticket_stub",
  description: "来自一次已经确认发生的共同观影。",
  status: "ready",
  primaryAssetId: "asset-1",
  createdEffectiveAtUtc: "2026-09-08T00:00:00.000Z",
  thumbnailUrl: "/api/keepsakes/keepsake-1/thumbnail",
};

describe("ShareComposer privacy defaults", () => {
  it("allows unopened envelope metadata but disables excerpt sharing", () => {
    const markup = renderToStaticMarkup(
      <ShareComposer
        agentId="agent-1"
        archiveEntries={[
          letter("hidden-reply", "delivered_unread", "SENTINEL_UNOPENED_REPLY"),
          letter("opened-reply", "read", "已经启封的回信"),
        ]}
        keepsakes={[keepsake]}
        initialKeepsakeId={keepsake.id}
      />,
    );

    expect(markup).toContain("正文摘录已关闭");
    expect(markup).toContain('type="checkbox"');
    expect(markup).toMatch(/正文摘录（默认关闭）/);
    expect(markup).toContain("SENTINEL_UNOPENED_REPLY");
    expect(markup).not.toContain("SENTINEL_UNOPENED_BODY");
    expect(markup).not.toContain("/api/keepsakes/keepsake-1/thumbnail");
    expect(markup).toMatch(
      /<input(?=[^>]*type="checkbox")(?=[^>]*disabled="")[^>]*\/?>\s*<span>正文摘录（默认关闭）<\/span>/,
    );
    expect(markup).toContain("不会上传，也不会创建公开链接");
  });

  it("does not replace missing deep-link ids with the first available source", () => {
    const markup = renderToStaticMarkup(
      <ShareComposer
        agentId="agent-1"
        archiveEntries={[letter("first-letter", "read", "列表中的第一封信")]}
        keepsakes={[keepsake]}
        initialLetterId="missing-letter"
        initialKeepsakeId="missing-keepsake"
      />,
    );

    expect(markup).toContain("指定信件不存在或不可分享");
    expect(markup).toContain("指定纪念物不存在或不可分享");
    expect(markup).toMatch(
      /<option value="" selected="">指定信件不存在或不可分享<\/option>/,
    );
    expect(markup).toMatch(
      /<option value="" selected="">指定纪念物不存在或不可分享<\/option>/,
    );
    expect(markup).not.toMatch(/<option value="first-letter" selected="">/);
    expect(markup).not.toMatch(/<option value="keepsake-1" selected="">/);
  });
});
