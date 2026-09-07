import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const directory = path.dirname(fileURLToPath(import.meta.url));
const read = (name) =>
  JSON.parse(fs.readFileSync(path.join(directory, name), "utf8"));
const manifest = read("package-manifest.json");
for (const item of manifest.files) {
  assert.equal(
    path.basename(item.name),
    item.name,
    "manifest path must stay in package",
  );
  const bytes = fs.readFileSync(path.join(directory, item.name));
  assert.equal(bytes.length, item.bytes, `size ${item.name}`);
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    item.sha256,
    `hash ${item.name}`,
  );
}
assert.deepEqual(
  fs
    .readdirSync(directory)
    .filter((name) => name !== "package-manifest.json")
    .sort(),
  manifest.files.map((item) => item.name).sort(),
  "manifest must cover the whole package",
);
const primary = fs
  .readFileSync(path.join(directory, "primary-reviews.jsonl"), "utf8")
  .trim()
  .split(/\r?\n/)
  .map(JSON.parse);
const secondary = read("secondary-reviews.json").rows;
const key = (row) => `${row.runSlot}/${row.turn}`;
const primaryKeys = new Set(primary.map(key));
const secondaryKeys = new Set(secondary.map(key));
assert.equal(primary.length, 360);
assert.equal(primaryKeys.size, 360);
assert.equal(secondary.length, 63);
assert.equal(secondaryKeys.size, 63);
const fixed = [1, 4, 8, 13, 14, 16, 25, 32, 48, 65, 73, 88, 101, 120];
for (const run of ["R1", "R2", "R3"]) {
  for (let turn = 1; turn <= 120; turn++)
    assert.ok(primaryKeys.has(`${run}/${turn}`));
  for (const turn of fixed) assert.ok(secondaryKeys.has(`${run}/${turn}`));
}
for (const row of primary) {
  assert.equal(typeof row.initialParsedChatText, "string");
  assert.equal(typeof row.finalText, "string");
  assert.ok(Array.isArray(row.finalChunks));
  for (const stage of ["raw", "final"]) {
    assert.equal(row.review[stage].status, "reviewed");
    assert.ok(
      row.review[stage].naturalnessScore >= 1 &&
        row.review[stage].naturalnessScore <= 5,
    );
    if (
      (row.review[stage].issues ?? []).some(
        (issue) => issue.severity === "major",
      )
    ) {
      assert.ok(
        secondaryKeys.has(key(row)),
        `major candidate requires secondary: ${key(row)}/${stage}`,
      );
    }
  }
}
const runs = read("run-summary.json");
assert.equal(runs.totals.dialogueTurns, 360);
assert.equal(runs.totals.physicalRequests, 372);
assert.equal(runs.totals.reservedTokenUnits, 19437795);
assert.equal(runs.totals.usage.total_tokens, 2633634);
assert.equal(runs.totals.usage.unknownUsageResponses, 0);
assert.deepEqual(
  runs.runs.map((run) => run.completedTurns),
  [120, 120, 120],
);
assert.deepEqual(
  runs.runs.map((run) => run.physicalRequests),
  [124, 123, 125],
);
for (const run of runs.runs) {
  assert.equal(run.finalMessagesMatch, true);
  assert.equal(run.duplicateClientIds.length, 0);
  assert.equal(run.duplicateReplyIds.length, 0);
}
console.log(
  JSON.stringify(
    {
      status: "verified",
      files: manifest.files.length,
      primaryReviews: 360,
      secondaryReviews: 63,
      fixedCrossReviews: 42,
      physicalRequests: 372,
      actualTokens: 2633634,
      apiCalls: 0,
      productQualityPassed: false,
    },
    null,
    2,
  ),
);
