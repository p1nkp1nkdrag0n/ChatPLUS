import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ACCEPTANCE_STORY_MARKERS: readonly [string, RegExp][] = [
  ["山鸣影像", /山鸣影像/u],
  ["栖岸科技", /栖岸科技/u],
  ["许宁", /许宁/u],
  ["林舟", /林舟/u],
  ["顾澜", /顾澜/u],
  ["M-417", /M-417/iu],
  ["藏青色帆布包", /藏青色.{0,4}帆布包/u],
  ["成都/重庆迁居更正", /(?:成都.{0,48}重庆|重庆.{0,48}成都)/u],
  ["八个月生活储备", /八个?月.{0,4}生活储备/u],
  ["长期失去创作能力", /长期失去创作能力/u],
  [
    "9月14日至16日更正",
    /(?:9\s*月\s*14\s*日.{0,64}(?:更正|改|延|不是).{0,32}9\s*月\s*16\s*日|9\s*月\s*16\s*日.{0,64}(?:更正|改|延|不是).{0,32}9\s*月\s*14\s*日)/u,
  ],
  ["9月14/16日场景选择器", /9(?:\\s\*|\s)*月(?:\\s\*|\s)*(?:\(\?:)?14\|16/u],
  ["验收母亲意见", /母亲.{0,8}觉得.{0,16}上海/u],
] as const;

const WORKSPACE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

describe("acceptance scenario isolation", () => {
  it("recognizes both prose and regex-shaped reviewed date leakage", () => {
    const dateMarkers = ACCEPTANCE_STORY_MARKERS.filter(([label]) =>
      label.startsWith("9月"),
    );
    expect(
      dateMarkers.some(([, pattern]) =>
        pattern.test("9 月 14 日后来更正为 9 月 16 日"),
      ),
    ).toBe(true);
    expect(
      dateMarkers.some(([, pattern]) =>
        pattern.test(String.raw`/9\s*月\s*(?:14|16)\s*日/u`),
      ),
    ).toBe(true);
  });

  it("keeps reviewed story vocabulary out of production services and features", async () => {
    const roots = [
      join(WORKSPACE_ROOT, "apps", "server", "src"),
      join(WORKSPACE_ROOT, "packages", "features", "src"),
    ];
    const violations: string[] = [];
    for (const root of roots) {
      for (const path of await productionTypeScriptFiles(root)) {
        const source = await readFile(path, "utf8");
        for (const [label, pattern] of ACCEPTANCE_STORY_MARKERS) {
          if (pattern.test(source)) {
            violations.push(`${relative(WORKSPACE_ROOT, path)}: ${label}`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

async function productionTypeScriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (
        entry.isDirectory() &&
        (entry.name === "scenarios" || entry.name === "scripts")
      ) {
        return [];
      }
      if (entry.isDirectory()) return productionTypeScriptFiles(path);
      return entry.isFile() &&
        entry.name.endsWith(".ts") &&
        !entry.name.endsWith(".test.ts")
        ? [path]
        : [];
    }),
  );
  return files.flat();
}
