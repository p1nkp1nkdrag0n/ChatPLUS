import type { HostedModel } from "../api/hosted";

type Pricing = Pick<
  HostedModel,
  | "kind"
  | "inputMicrosPerMillion"
  | "outputMicrosPerMillion"
  | "cacheReadMicrosPerMillion"
  | "cacheWriteMicrosPerMillion"
  | "imagePointsMicros"
>;
export function hostedModelPricingReady(model: Pricing): boolean {
  const valid = (value: number | undefined): value is number =>
    Number.isSafeInteger(value) && (value ?? -1) >= 0;
  if (model.kind === "image")
    return valid(model.imagePointsMicros) && model.imagePointsMicros > 0;
  return (
    valid(model.inputMicrosPerMillion) &&
    model.inputMicrosPerMillion > 0 &&
    valid(model.outputMicrosPerMillion) &&
    model.outputMicrosPerMillion > 0 &&
    valid(model.cacheReadMicrosPerMillion) &&
    (model.cacheWriteMicrosPerMillion === undefined ||
      valid(model.cacheWriteMicrosPerMillion))
  );
}
