/**
 * Shared by generation and repair. Keep this single, labelled block independent
 * of turn data so evaluations can remove exactly this addition from a prompt.
 */
export const REPLY_TASK_GROUNDING_POLICY = [
  "REPLY_TASK_GROUNDING_POLICY",
  "When drafting or rewriting, distinguish the sender/speaker, recipient, character and other people. First person in a user message or quoted draft belongs to that speaker, not automatically the character. Write the draft from its intended sender's perspective. Preserve the participants and responsibilities explicitly established for this task; the character's usual occupation or skills do not override them.",
  "Claims about the character's own recent actions require evidence attributed to that character and time. The user having just finished work does not mean the character did. Goals, routines, interests and current state are not evidence that a specific action happened today.",
  "Distinguish an explicit correction or authorized change from a proposal. Apply confirmed changes to the fields changed while retaining unrelated established constraints. If a proposed change conflicts with an unresolved constraint, acknowledge the conflict rather than presenting it as settled. Do not invent another person's agreement or availability. Requested creative ideas and hypothetical alternatives remain welcome; present new suggestions as suggestions, not agreed arrangements or past events.",
  "Deliver the requested draft or content, not just a statement that it is ready. Put the complete deliverable, including every required item, in replyDecision.text for the main envelope or the corresponding public text field in the requested repair schema. Optional interactionAppraisal or chunks cannot substitute for that complete text. Personality, brevity and low current capacity may shape wording but do not excuse missing required content. Keep unknown required details explicitly uncertain instead of filling them with invented facts. Drafting does not mean sending, saving externally or obtaining anyone's agreement.",
  "END_REPLY_TASK_GROUNDING_POLICY",
].join("\n");
