import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { extractHostedResearchImages } from "./research-export.js";

const bytes = Buffer.from("fake-collected-image-for-extraction-test");
const sha256 = createHash("sha256").update(bytes).digest("hex");
const record = {
  id: "research1",
  kind: "image",
  userId: "participant1",
  operationId: "operation1",
  sessionId: "session1",
  attemptId: "attempt1",
  purpose: "achievement_image",
  displayName: "测试绘图",
  modelId: "real-model",
  payload: {
    fileName: `images/${sha256}.png`,
    sha256,
    mimeType: "image/png",
    width: 1024,
    height: 1024,
    byteLength: bytes.length,
    encoding: "base64",
    data: bytes.toString("base64"),
  },
};

it("extracts original images once and retains every participant/session/attempt association", async () => {
  const root = mkdtempSync(join(tmpdir(), "dearvale-extract-"));
  try {
    const source = join(root, "research.jsonl"),
      destination = join(root, "images");
    writeFileSync(
      source,
      [
        {
          kind: "input",
          payload: "conversation-content-not-in-image-manifest",
        },
        record,
        {
          ...record,
          id: "research2",
          sessionId: "session2",
          attemptId: "attempt2",
        },
      ]
        .map((value) => JSON.stringify(value))
        .join("\n"),
    );
    const result = await extractHostedResearchImages({ source, destination });
    expect(result).toMatchObject({ fileCount: 1, recordCount: 2 });
    expect(readFileSync(join(destination, record.payload.fileName))).toEqual(
      bytes,
    );
    const manifestText = readFileSync(result.manifestPath, "utf8");
    const manifest = JSON.parse(manifestText) as { records: unknown[] };
    expect(manifest.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          researchId: "research1",
          participantId: "participant1",
          sessionId: "session1",
          attemptId: "attempt1",
          operationId: "operation1",
          sha256,
        }),
        expect.objectContaining({
          researchId: "research2",
          sessionId: "session2",
          attemptId: "attempt2",
        }),
      ]),
    );
    expect(manifestText).not.toContain(
      "conversation-content-not-in-image-manifest",
    );
    expect(manifestText).not.toContain(record.payload.data);
    await expect(
      extractHostedResearchImages({ source, destination }),
    ).rejects.toMatchObject({ code: "research_destination_not_empty" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("rejects escaped filenames and corrupted bytes without publishing partial extractions", async () => {
  const root = mkdtempSync(join(tmpdir(), "dearvale-extract-invalid-"));
  try {
    const source = join(root, "research.jsonl"),
      destination = join(root, "images");
    for (const [payload, code] of [
      [
        { ...record.payload, fileName: "../escaped.png" },
        "unsafe_research_path",
      ],
      [
        {
          ...record.payload,
          data: Buffer.from("corrupted-image").toString("base64"),
        },
        "research_checksum_mismatch",
      ],
    ] as const) {
      writeFileSync(
        source,
        [record, { ...record, id: "corrupt", payload }]
          .map((value) => JSON.stringify(value))
          .join("\n"),
      );
      await expect(
        extractHostedResearchImages({ source, destination }),
      ).rejects.toMatchObject({ code });
      expect(existsSync(destination)).toBe(false);
      expect(existsSync(join(root, "escaped.png"))).toBe(false);
      expect(
        readdirSync(root).some((name) =>
          name.startsWith(".dearvale-research-"),
        ),
      ).toBe(false);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
