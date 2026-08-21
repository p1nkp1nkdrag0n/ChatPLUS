import type {
  LlmCapabilityProfile,
  LLMRequest,
  LLMResponse,
} from "@personasim/contracts";
import type { ZodType } from "zod";

export interface GenerateObjectInput<T> {
  purpose: string;
  system: string;
  prompt: string;
  schema: ZodType<T>;
  maxRetries?: number;
  temperature?: number;
  maxOutputTokens?: number;
}

export interface CompletionInput {
  purpose: string;
  system: string;
  prompt: string;
  temperature?: number;
  maxOutputTokens?: number;
}

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  readonly capabilities: LlmCapabilityProfile;
  generate(request: LLMRequest): Promise<LLMResponse>;
  generateObject<T>(input: GenerateObjectInput<T>): Promise<T>;
  completeStructured<T>(input: GenerateObjectInput<T>): Promise<T>;
  complete(input: CompletionInput): Promise<string>;
}

export interface LlmCallMetric {
  provider: string;
  model: string;
  purpose: string;
  attempt: number;
  latencyMs: number;
  success: boolean;
  status?: number;
  inputTokens?: number;
  outputTokens?: number;
  errorCode?: string;
}

export type LlmMetricSink = (metric: LlmCallMetric) => void;
