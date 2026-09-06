import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { ServerConfig } from "../config.js";
import { canonicalJson } from "./companion-long-run-v2-baseline.js";
import {
  readGitFingerprint,
  redactLongRunArtifact,
  sha256Text,
  type GitFingerprint,
} from "./companion-long-run-v2-artifacts.js";

export const CONTINUITY_IDENTITY_VERSION = "continuity-run-identity-v1";
export const CONTINUITY_WORKSPACE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

export function continuityHash(value: unknown): string {
  return sha256Text(canonicalJson(value));
}

/** Hash code and all effective settings, including settings unknown to this runner.
 * Secrets are excluded: credential rotation is not a change of model policy.
 * Operational paths remain frozen so resume cannot silently select another DB.
 */
export function continuityRunIdentity(input: {
  config: ServerConfig;
  git: GitFingerprint;
  lockSha256: string;
  experiment: unknown;
}): Record<string, unknown> {
  const actualConfig = redactLongRunArtifact(input.config, [
    input.config.instanceSecret ?? "",
    input.config.llm.apiKey ?? "",
  ]);
  return JSON.parse(
    JSON.stringify({
      schemaVersion: CONTINUITY_IDENTITY_VERSION,
      git: input.git,
      lockSha256: input.lockSha256,
      actualConfig,
      // Git + dirty content fingerprint freezes every participating policy,
      // including policies that do not yet export an explicit version constant.
      participatingPolicySource: input.git,
      experiment: input.experiment,
    }),
  ) as Record<string, unknown>;
}

export async function captureContinuityRunIdentity(input: {
  config: ServerConfig;
  experiment: unknown;
  workspaceRoot?: string;
}): Promise<Record<string, unknown>> {
  const root = input.workspaceRoot ?? CONTINUITY_WORKSPACE_ROOT;
  const [git, lock] = await Promise.all([
    readGitFingerprint(root),
    readFile(resolve(root, "pnpm-lock.yaml"), "utf8"),
  ]);
  return continuityRunIdentity({ ...input, git, lockSha256: sha256Text(lock) });
}

export async function freezeContinuityManifest(
  path: string,
  manifest: unknown,
  resume: boolean,
): Promise<void> {
  if (resume) {
    const saved: unknown = JSON.parse(await readFile(path, "utf8"));
    if (continuityHash(saved) !== continuityHash(manifest)) {
      throw new Error(
        "continuity_resume_identity_mismatch: create a new run for changed code, config, scenario or budget",
      );
    }
    return;
  }
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, {
    flag: "wx",
  });
}
