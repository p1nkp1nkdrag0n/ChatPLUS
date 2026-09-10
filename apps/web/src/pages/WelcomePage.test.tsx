import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CharacterSummary } from "../api/types";
import WelcomePage from "./WelcomePage";

const state = vi.hoisted(() => ({
  characters: [] as CharacterSummary[],
  error: null as Error | null,
  pending: false,
  paused: false,
  resumeError: null as Error | null,
  draft: false,
}));

vi.mock("../lib/characterInterview", () => ({
  readInterviewDraft: () => (state.draft ? { phase: "main" } : undefined),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: unknown[] }) =>
    queryKey[0] === "characters"
      ? {
          data:
            state.error || state.pending || state.paused
              ? undefined
              : { characters: state.characters },
          isFetching: state.pending,
          isPending: state.pending || state.paused,
          isSuccess: !state.error && !state.pending && !state.paused,
          isError: Boolean(state.error),
          error: state.error,
        }
      : {
          data: null,
          isFetching: false,
          isPending: false,
          error: state.resumeError,
        },
}));

describe("WelcomePage character-dependent invitation", () => {
  beforeEach(() => {
    state.characters = [];
    state.error = null;
    state.pending = false;
    state.paused = false;
    state.resumeError = null;
    state.draft = false;
  });
  afterEach(() => vi.unstubAllGlobals());

  it("shows the invitation and import for a first visit without a chat or demo action", () => {
    const markup = render();
    expect(markup).toContain("描述你梦中的他/她");
    expect(markup).toContain('href="/import"');
    expect(markup).not.toContain("继续聊天");
    expect(markup).not.toContain("示例角色");
    expect(markup).not.toContain("创建新角色");
  });

  it("keeps an unpublished local draft on the same invitation with a recovery hint", () => {
    state.draft = true;
    state.characters = [character({ status: "draft" })];
    const markup = render();
    expect(markup).toContain("描述你梦中的他/她");
    expect(markup).toContain("未完成的描绘");
    expect(markup).not.toContain("继续聊天");
  });

  it.each(["original", "imported_character"] as const)(
    "offers continue and a secondary invitation after a %s character is published",
    (sourceType) => {
      state.characters = [character({ sourceType })];
      const markup = render();
      expect(markup).toContain("继续聊天");
      expect(markup).toContain('href="/create"');
      expect(markup).toContain('href="/import"');
    },
  );

  it("does not let a system demo or archived character enable chat", () => {
    state.characters = [
      character({ creationOrigin: "demo" }),
      character({ id: "archived", status: "archived" }),
    ];
    expect(render()).not.toContain("继续聊天");
  });

  it("shows a connection failure as retry rather than an empty library", () => {
    state.error = new Error("offline");
    const markup = render();
    expect(markup).toContain("重新连接");
    expect(markup).toContain("暂时没能读到角色");
    expect(markup).not.toContain("从一个名字开始");
  });

  it("waits for server state before deciding which primary action to offer", () => {
    state.pending = true;
    const markup = render();
    expect(markup).toContain("正在寻找熟悉的身影");
    expect(markup).toContain('disabled=""');
    expect(markup).not.toContain("描述你梦中的他/她");
  });

  it("does not present an unverified empty library when the first request is paused offline", () => {
    state.paused = true;
    const markup = render();
    expect(markup).toContain("正在寻找熟悉的身影");
    expect(markup).toContain('disabled=""');
    expect(markup).not.toContain("描述你梦中的他/她");
  });

  it("shows retry if a published character's conversation cannot be read", () => {
    state.characters = [character()];
    state.resumeError = new Error("session request failed");
    const markup = render();
    expect(markup).toContain("重新连接");
    expect(markup).not.toContain("继续聊天");
    expect(markup).not.toContain("从一个名字开始");
  });
});

function render() {
  return renderToStaticMarkup(
    <MemoryRouter>
      <WelcomePage />
    </MemoryRouter>,
  );
}
function character(
  overrides: Partial<CharacterSummary> = {},
): CharacterSummary {
  return {
    id: "user",
    name: "林夏",
    status: "published",
    creationOrigin: "user",
    sourceType: "original",
    version: 1,
    tier: "high_fidelity",
    workOrRole: "插画师",
    updatedAtUtc: "2026-09-08",
    ...overrides,
  };
}
