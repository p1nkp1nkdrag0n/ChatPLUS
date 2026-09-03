import {
  isValidElement,
  type ChangeEventHandler,
  type ReactElement,
  type ReactNode,
} from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CharacterSpec } from "../../api/types";
import { DialogueEditor } from "./DialogueEditor";
import { RelationshipEditor } from "./RelationshipEditor";

type TestElement = ReactElement<Record<string, unknown>>;

function findElement(
  node: ReactNode,
  predicate: (element: TestElement) => boolean,
): TestElement | undefined {
  if (Array.isArray(node)) {
    for (const child of node as ReactNode[]) {
      const match = findElement(child, predicate);
      if (match) return match;
    }
    return undefined;
  }
  if (!isValidElement(node)) return undefined;

  const element = node as TestElement;
  if (predicate(element)) return element;
  return findElement(element.props.children as ReactNode, predicate);
}

function characterSpec(): CharacterSpec {
  return {
    sources: [
      {
        id: "source-canon",
        sourceType: "imported_text",
        label: "原作文本",
      },
    ],
    dialogue: {
      primaryLanguage: "中文",
      understoodLanguages: ["中文"],
      spokenLanguages: ["中文"],
      formality: 0.5,
      directness: 0.5,
      warmth: 0.5,
      verbosity: 0.5,
      humor: 0.5,
      averageMessageLength: 80,
      averageChunksPerTurn: 1,
      frequentPhrases: [],
      avoidedPhrases: [],
      greetingPatterns: [],
      comfortingPatterns: [],
      refusalPatterns: [],
      rules: [
        {
          id: "dialogue-canon",
          kind: "register",
          instruction: "使用原作中的正式语气。",
          enforcement: "soft",
          conditions: ["公开场合"],
          origin: "canon_extract",
          sourceRefs: ["source-canon"],
        },
      ],
    },
    userRelationship: {
      relationshipType: "旧识",
      sharedContext: "曾经共事",
      initialCloseness: 0.4,
      initialTrust: 0.5,
      addressTerms: [],
      tensions: [],
      affectionPatterns: [],
      behaviorModes: [
        {
          id: "relationship-canon",
          conditions: ["意见不一致"],
          behavior: "保持距离",
          origin: "canon_extract",
          sourceRefs: ["source-canon"],
        },
      ],
    },
  } as unknown as CharacterSpec;
}

function changeText(element: TestElement, value: string) {
  const onChange = element.props
    .onChange as ChangeEventHandler<HTMLTextAreaElement>;
  onChange({ target: { value } } as never);
}

afterEach(() => vi.restoreAllMocks());

describe("structured rule provenance", () => {
  it("rebases a canon dialogue rule when its form content is edited", () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue(
      "00000000-0000-4000-8000-000000000001",
    );
    const onChange = vi.fn();
    const tree = DialogueEditor({
      spec: characterSpec(),
      onChange,
      onSelect: vi.fn(),
    });
    const field = findElement(
      tree,
      (element) =>
        element.type === "textarea" &&
        element.props.value === "使用原作中的正式语气。",
    );

    expect(field).toBeDefined();
    changeText(field!, "改用更直接的表达。");

    const edited = onChange.mock.calls[0]?.[0] as CharacterSpec;
    expect(edited.dialogue.rules?.[0]).toMatchObject({
      instruction: "改用更直接的表达。",
      origin: "user_spec",
      sourceRefs: ["00000000-0000-4000-8000-000000000001"],
    });
    expect(edited.sources).toContainEqual(
      expect.objectContaining({
        id: "00000000-0000-4000-8000-000000000001",
        sourceType: "user_spec",
      }),
    );
  });

  it("rebases a canon relationship rule when its form behavior is edited", () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue(
      "00000000-0000-4000-8000-000000000002",
    );
    const onChange = vi.fn();
    const tree = RelationshipEditor({
      spec: characterSpec(),
      onChange,
      onSelect: vi.fn(),
    });
    const field = findElement(
      tree,
      (element) =>
        element.type === "textarea" && element.props.value === "保持距离",
    );

    expect(field).toBeDefined();
    changeText(field!, "先倾听，再回应");

    const edited = onChange.mock.calls[0]?.[0] as CharacterSpec;
    expect(edited.userRelationship.behaviorModes?.[0]).toMatchObject({
      behavior: "先倾听，再回应",
      origin: "user_spec",
      sourceRefs: ["00000000-0000-4000-8000-000000000002"],
    });
    expect(edited.sources).toContainEqual(
      expect.objectContaining({
        id: "00000000-0000-4000-8000-000000000002",
        sourceType: "user_spec",
      }),
    );
  });
});
