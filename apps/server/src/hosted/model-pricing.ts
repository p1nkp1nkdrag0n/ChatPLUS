import { HostedError, type HostedModelSnapshot } from "./types.js";

type Pricing = Pick<
  HostedModelSnapshot,
  | "kind"
  | "inputMicrosPerMillion"
  | "outputMicrosPerMillion"
  | "cacheReadMicrosPerMillion"
  | "cacheWriteMicrosPerMillion"
  | "imagePointsMicros"
>;

const nonnegative = (value: number | undefined): value is number =>
  Number.isSafeInteger(value) && (value ?? -1) >= 0;

/** Zero cache rates are valid; zero base prices must never authorize spending. */
export function hostedModelPricingReady(model: Pricing): boolean {
  if (model.kind === "image")
    return nonnegative(model.imagePointsMicros) && model.imagePointsMicros > 0;
  return (
    nonnegative(model.inputMicrosPerMillion) &&
    model.inputMicrosPerMillion > 0 &&
    nonnegative(model.outputMicrosPerMillion) &&
    model.outputMicrosPerMillion > 0 &&
    nonnegative(model.cacheReadMicrosPerMillion) &&
    (model.cacheWriteMicrosPerMillion === undefined ||
      nonnegative(model.cacheWriteMicrosPerMillion))
  );
}

export function assertHostedModelPricing(model: Pricing): void {
  if (!hostedModelPricingReady(model))
    throw new HostedError(
      409,
      "model_pricing_required",
      model.kind === "image"
        ? "图片模型尚未完成计费配置：每张图片积分必须大于 0，配置完成前不会发送新的生成请求。"
        : "文本模型尚未完成计费配置：输入和输出价格必须大于 0；缓存命中价格可以为 0，缓存写入价格可留空。配置完成前不会发送新的模型请求。",
    );
}
