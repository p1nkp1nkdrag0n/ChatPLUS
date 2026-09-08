export const STORY_SCENES = [
  { name: "山湖", image: "mountain", state: 0 },
  { name: "林间", image: "forest", state: 2 },
  { name: "书信", image: "desk", state: 3 },
  { name: "海岸", image: "coast", state: 4 },
  { name: "星夜", image: "night", state: 5 },
] as const;

export const STORY_DIALOGUES = [
  ["今天过得怎么样？", "上午去了旧书店，还碰见一只打盹的小狗。"],
  ["我终于订好去云南的车票了。", "那就能去看你一直惦记的苍山了。"],
  ["我把那天没说完的话，写信寄给你了。", "我会等它抵达，再认真给你写回信。"],
  ["还记得那次，我们聊到天都黑了吗？", "记得，你舍不得那片粉色的晚霞。"],
  ["今天有点累，陪我看一会儿星星吧。", "好，今晚就不急着说什么了。"],
] as const;

export function storyFrame(progress: number, reducedMotion = false) {
  const position = Math.max(
    0,
    Math.min(5, Number.isFinite(progress) ? progress : 0),
  );
  const current = Math.floor(position);
  const next = Math.min(5, current + 1);
  const linear = Math.max(0, Math.min(1, (position - current - 0.65) / 0.35));
  const mix = reducedMotion
    ? linear >= 0.5
      ? 1
      : 0
    : linear * linear * (3 - 2 * linear);
  return {
    current,
    next,
    currentScene: Math.max(0, current - 1),
    nextScene: Math.max(0, next - 1),
    mix,
    visibleState: mix >= 0.5 ? next : current,
  };
}
