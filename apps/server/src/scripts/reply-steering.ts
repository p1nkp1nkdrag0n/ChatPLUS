import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import {
  PROFILE_MODELS,
  resolveSteeringModes,
  runReplySteering,
  type SteeringProfile,
} from "./reply-steering-runner.js";
import type { ReplySteeringPersonaId } from "./reply-steering-scenarios.js";

export async function replySteeringMain(
  args = process.argv.slice(2),
): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      fixture: { type: "boolean", default: false },
      output: { type: "string" },
      profiles: {
        type: "string",
        default: "deepseek,bigmodel,qwen,gpt6-astra",
      },
      personas: { type: "string" },
      scenarios: { type: "string" },
      modes: { type: "string" },
      repeats: { type: "string", default: "2" },
      "common-only": { type: "boolean", default: false },
      requests: { type: "string", default: "760" },
      "token-units": { type: "string", default: "100000000" },
    },
    strict: true,
  });
  if (!values.output)
    throw new Error(
      "Use --output NEW_IGNORED_DIRECTORY [--fixture] [--profiles deepseek,bigmodel,qwen,gpt6-astra] [--personas warm-observant,reserved-direct,lively-expressive] [--modes current,no_length_steering,no_length_only_steering,no_chunk_count_steering,no_delivery_steering] [--common-only] [--repeats 1|2]",
    );
  const profiles = values.profiles.split(",");
  if (profiles.some((profile) => !Object.hasOwn(PROFILE_MODELS, profile)))
    throw new Error("Unknown profile");
  const results = await runReplySteering({
    output: values.output,
    profiles: profiles as SteeringProfile[],
    modes: resolveSteeringModes(values.modes?.split(",")),
    fixture: values.fixture,
    commonOnly: values["common-only"],
    repeats: Number(values.repeats),
    maxPhysicalRequests: Number(values.requests),
    maxReservedTokenUnits: Number(values["token-units"]),
    ...(values.personas
      ? { personas: values.personas.split(",") as ReplySteeringPersonaId[] }
      : {}),
    ...(values.scenarios ? { scenarioIds: values.scenarios.split(",") } : {}),
    onProgress: (message) => console.log(message),
  });
  console.log(
    `Completed ${results.length} attempts; ${results.filter((result) => !result.success).length} failed. Evidence: ${resolve(values.output)}`,
  );
  if (results.some((result) => !result.success)) process.exitCode = 1;
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  await replySteeringMain().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
