import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureUserEditSource } from "../components/character-editor/source";
import { newInterviewDraft } from "./characterInterview";
import { prepareChatSend } from "./chatSend";
import { createUuid } from "./uuid";

const browserCrypto = globalThis.crypto;
const uuidV4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function useLanCrypto() {
  vi.stubGlobal("crypto", {
    getRandomValues: browserCrypto.getRandomValues.bind(browserCrypto),
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("UUIDs on HTTPS and private HTTP LAN connections", () => {
  it("uses the native UUID implementation with its Crypto receiver", () => {
    const expected = "bea1c678-297b-4a36-9769-9d923eb4a0aa";
    const nativeCrypto = {
      randomUUID: vi.fn(function (this: unknown) {
        expect(this).toBe(nativeCrypto);
        return expected;
      }),
      getRandomValues: vi.fn(),
    };
    vi.stubGlobal("crypto", nativeCrypto);

    expect(createUuid()).toBe(expected);
    expect(nativeCrypto.randomUUID).toHaveBeenCalledOnce();
    expect(nativeCrypto.getRandomValues).not.toHaveBeenCalled();
  });

  it("generates distinct UUIDs with version 4 and RFC variant bits without randomUUID", () => {
    useLanCrypto();
    const ids = Array.from({ length: 128 }, () => createUuid());

    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(uuidV4);
  });

  it("creates interview drafts, editor sources and retryable chat sends on HTTP LAN", () => {
    useLanCrypto();
    const draft = newInterviewDraft();
    const source = ensureUserEditSource({ sources: [] });
    const selection = {
      providerId: "provider-1",
      modelId: "model-1",
      revision: 1,
    };
    const first = prepareChatSend(undefined, "你好", selection, []);
    const retry = prepareChatSend(
      { text: first.text, retryInput: first },
      first.text,
      selection,
      [],
    );

    for (const id of [draft.requestId, source.id, first.clientMessageId]) {
      expect(id).toMatch(uuidV4);
    }
    expect(
      new Set([draft.requestId, source.id, first.clientMessageId]).size,
    ).toBe(3);
    expect(source.sources[0]?.id).toBe(source.id);
    expect(retry.clientMessageId).toBe(first.clientMessageId);
  });
});
