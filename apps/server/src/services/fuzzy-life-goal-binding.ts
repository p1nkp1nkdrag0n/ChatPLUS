import { createHash } from "node:crypto";

import type { CharacterGoal, LifeThread } from "@personasim/contracts";

import { analyzeLifeEvidence } from "./fuzzy-life-evidence.js";

const normalized = (text: string) =>
  text.normalize("NFKC").replace(/\s+/gu, " ").trim();

/** Reusing an authoring ID does not prove that two different wishes are the same life thread. */
export function matchesGoalBinding(
  thread: LifeThread,
  goal: CharacterGoal,
): boolean {
  return (
    thread.sourceGoalId === goal.id &&
    normalized(thread.title) === normalized(goal.title) &&
    normalized(thread.summary) === normalized(goal.description)
  );
}

export function goalThreadBindingKey(
  agentId: string,
  goal: CharacterGoal,
): string {
  const descriptor = JSON.stringify([
    normalized(goal.title),
    normalized(goal.description),
  ]);
  const fingerprint = createHash("sha256")
    .update(descriptor)
    .digest("hex")
    .slice(0, 24);
  return `life-thread:${agentId}:goal:${goal.id}:${fingerprint}`;
}

/** A request is only one half of a control agreement; it does not itself change the character's goal. */
export function explicitCharacterGoalControl(
  text: string,
  title: string,
): "pause" | "resume" | undefined {
  const classified = analyzeLifeEvidence(text).classifyText;
  if (
    /(?:如果|假如|假设|要是|可能|打算|计划要|明天|以后|下周|不要|不用|不必|不能|别|他说|她说|朋友说|引用|翻译|[?？])/u.test(
      classified,
    )
  )
    return undefined;
  const escaped = normalized(title).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const goal = `你的${escaped}(?:这个|这项)?(?:目标|计划|这件事)?`;
  const matches = (verb: string) => {
    const command = new RegExp(
      `^(?:请你?|麻烦你|你)?(?:先|暂时|现在|重新)?(?:(?:${verb})(?:一下)?${goal}|${goal}[，,]?(?:请|先|暂时|现在|再|重新|就|也)*?(?:${verb}))(?:一下|吧)?$`,
      "u",
    );
    return classified
      .split(/[。.!！\n]+/u)
      .some((sentence) => command.test(sentence.trim()));
  };
  const pause = matches("暂停|暂缓");
  const resume = matches("恢复|继续");
  return pause === resume ? undefined : pause ? "pause" : "resume";
}

/** Require an explicit first-person acceptance of the same goal and control. */
export function acceptsCharacterGoalControl(
  text: string,
  title: string,
  control: "pause" | "resume",
): boolean {
  const classified = analyzeLifeEvidence(text).classifyText;
  if (
    /(?:如果|假如|假设|要是|除非|可能|也许|打算|希望|明天|以后|下周|不(?:会|同意|接受|决定)|暂不|拒绝|不要|不能|引用|翻译|[?？]|(?:等|待).{0,40}(?:再|才))/u.test(
      classified,
    )
  )
    return false;
  const escaped = normalized(title).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const verb = control === "pause" ? "暂停|暂缓" : "恢复|继续";
  const acceptance = new RegExp(
    `^我(?:同意|决定|接受)(?:先|暂时|现在|重新)?(?:${verb})(?:一下)?我的${escaped}(?:这个|这项)?(?:目标|计划|这件事)?$`,
    "u",
  );
  return classified
    .split(/[，,。.!！\n]+/u)
    .some((clause) => acceptance.test(clause.trim()));
}
