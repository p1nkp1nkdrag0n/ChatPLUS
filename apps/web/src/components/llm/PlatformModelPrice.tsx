import type { PublicHostedModel } from "../../api/hosted";

export function PlatformModelPrice({
  model,
}: {
  model: PublicHostedModel | undefined;
}) {
  if (!model) return <p className="model-cost">使用平台模型会消耗平台额度。</p>;
  const points = (micros: number) =>
    (micros / 1_000_000).toLocaleString("zh-CN", { maximumFractionDigits: 6 });
  return (
    <p className="model-cost">
      {model.kind === "image"
        ? model.imagePointsMicros === undefined
          ? "平台图片价格暂未提供。"
          : `平台额度 · ${points(model.imagePointsMicros)} 积分 / 张`
        : `平台额度 · 每百万 token 输入 ${points(model.inputMicrosPerMillion)} 积分，输出 ${points(model.outputMicrosPerMillion)} 积分`}
    </p>
  );
}
