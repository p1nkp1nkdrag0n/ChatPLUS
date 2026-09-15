const PURPOSE_LABELS: Record<string, string> = {
  chat_turn: "聊天回复",
  letter_reply: "书信回复",
  compile_character: "角色创建",
  character_interview: "角色访谈",
  character_portrait: "人物小传",
  character_refinement: "人物设定修订",
  review_reply_goal: "回复复核",
  rewrite_reply_goal: "回复改写",
  rewrite_reply_affinity: "回复润色",
  import_character: "角色导入",
  plan_schedule: "安排规划",
  compose_proactive_message: "主动消息",
  checkpoint_autobiography: "长期记忆",
  repair_chat_turn: "回复修复",
  enrich_activity: "活动细节",
  image_generation: "图片生成",
  achievement_image: "成就图片",
};
export function purposeLabel(value: string): string {
  return PURPOSE_LABELS[value] ?? "模型调用";
}
export function displayDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? "—"
    : date.toLocaleString("zh-CN", { hour12: false });
}
export function formatTokens(value: number | undefined | null): string {
  return value === undefined || value === null
    ? "未知"
    : value.toLocaleString("zh-CN");
}
export function formatStorage(value: number | undefined | null): string {
  if (value === undefined || value === null) return "未知";
  const gibibyte = 1024 ** 3;
  return value >= gibibyte
    ? `${(value / gibibyte).toFixed(2)} GiB`
    : `${(value / 1024 ** 2).toFixed(2)} MiB`;
}
