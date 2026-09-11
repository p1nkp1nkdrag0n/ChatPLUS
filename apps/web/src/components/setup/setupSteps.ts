export const SETUP_STEPS = [
  "service",
  "key",
  "model",
  "test",
  "success",
] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];
export const SETUP_LABELS = ["连接服务", "填写密钥", "选择模型", "点亮法杖"];
