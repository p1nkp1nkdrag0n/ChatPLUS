import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { KeepsakeAssetStore } from "./keepsake-asset-store.js";

describe("KeepsakeAssetStore", () => {
  let directory: string | undefined;

  afterEach(() => {
    vi.restoreAllMocks();
    if (directory !== undefined)
      rmSync(directory, { recursive: true, force: true });
  });

  it("removes only newly created files when post-rename integrity validation fails", async () => {
    directory = mkdtempSync(join(tmpdir(), "chatplus-keepsake-assets-"));
    const assets = new KeepsakeAssetStore(directory);
    const read = vi
      .spyOn(assets, "read")
      .mockResolvedValue(Buffer.from("corrupt"));
    const svg = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="640" height="480" fill="#eee"/></svg>',
    );

    await expect(
      assets.persist({ agentId: "agent-1", bytes: svg }),
    ).rejects.toThrow(/integrity validation/u);
    expect(read).toHaveBeenCalled();
    expect(
      readdirSync(directory, { recursive: true })
        .map(String)
        .filter((entry) => entry.endsWith(".webp")),
    ).toEqual([]);
  });
});
