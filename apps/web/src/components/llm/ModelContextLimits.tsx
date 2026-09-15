import type { LlmModelSettings } from "@personasim/contracts";

export function ModelContextLimits({ model }: { model: LlmModelSettings }) {
  const budget = model.capabilities.maxContextTokens ?? 64_000;
  const effective = Math.min(
    budget,
    model.providerLimits?.maxContextTokens ?? Number.POSITIVE_INFINITY,
    258_000,
  );
  const format = (value: number) => value.toLocaleString("zh-CN");
  return (
    <p className="provider-footer-note model-context-limits">
      上下文实际预算上限：{format(effective)} token。
      {model.providerLimits?.maxContextTokens
        ? ` 供应商声明总上下文上限：${format(model.providerLimits.maxContextTokens)}。`
        : null}
      {model.providerLimits?.maxInputTokens
        ? ` 供应商声明输入上限：${format(model.providerLimits.maxInputTokens)}。`
        : null}
      {effective < budget ? " 已按供应商或应用限制缩小预算。" : null}
      请求还会为模型输出保留空间。
    </p>
  );
}
