import { LlmProviderError, StructuredOutputError } from "@personasim/providers";

export interface PublicLlmProviderError {
  statusCode: number;
  code: string;
  message: string;
}

const knownErrors: Readonly<Record<string, PublicLlmProviderError>> = {
  OUTPUT_TRUNCATED: {
    statusCode: 502,
    code: "llm_output_truncated",
    message:
      "模型回复达到输出长度上限，生成未能完成。请在模型设置的高级设置中提高“输出 token 上限”，或降低思考预算；也可以精简输入或更换模型后重试。",
  },
  TIMEOUT: {
    statusCode: 504,
    code: "llm_timeout",
    message:
      "等待模型回复超时。请稍后重试，或在模型设置中调整请求超时、更换响应更快的模型。",
  },
  NETWORK_ERROR: {
    statusCode: 502,
    code: "llm_network_error",
    message: "无法连接模型供应商。请检查 API 地址、网络及代理设置后重试。",
  },
  CANCELLED: {
    statusCode: 409,
    code: "llm_cancelled",
    message: "本次模型请求已取消，可以重新尝试。",
  },
  INVALID_CONFIGURATION: {
    statusCode: 422,
    code: "llm_invalid_configuration",
    message:
      "当前模型参数不兼容。请检查模型设置中的协议类型、模型 ID、输出上限及思考参数，并通过测试后重试。",
  },
  EMPTY_RESPONSE: {
    statusCode: 502,
    code: "llm_empty_response",
    message: "模型没有返回可用正文。请重试，或在模型设置中测试并更换模型。",
  },
  EMPTY_FINAL_AFTER_REASONING: {
    statusCode: 502,
    code: "llm_empty_final_after_reasoning",
    message:
      "模型只返回了思考内容，没有最终回复。请提高输出 token 上限或降低思考预算后重试。",
  },
  INVALID_RESPONSE_ENVELOPE: {
    statusCode: 502,
    code: "llm_invalid_response",
    message:
      "供应商返回的格式与当前协议不匹配。请检查 API 地址和协议类型，并在模型设置中测试后重试。",
  },
  INVALID_STRUCTURED_OUTPUT: {
    statusCode: 502,
    code: "llm_invalid_structured_output",
    message:
      "模型回复未通过所需的格式校验，生成未能完成。请重试；如果持续出现，请检查结构化输出设置或更换模型。",
  },
  UNSUPPORTED_RESPONSE_SCHEMA: {
    statusCode: 422,
    code: "llm_unsupported_response_schema",
    message:
      "当前模型的原生结构化输出模式不支持本次请求。请调整结构化输出方式或更换模型后重试。",
  },
  MISSING_RESPONSE_SCHEMA: {
    statusCode: 502,
    code: "llm_missing_response_schema",
    message:
      "模型请求缺少所需的输出格式定义。请重试；如果持续出现，请反馈此问题。",
  },
  MODEL_REFUSAL: {
    statusCode: 422,
    code: "llm_model_refusal",
    message:
      "模型拒绝了本次请求，没有返回可用回复。请检查输入内容是否符合供应商的使用要求后重试。",
  },
  CONTENT_FILTERED: {
    statusCode: 422,
    code: "llm_content_filtered",
    message:
      "供应商拦截了本次请求或回复。请检查输入内容是否符合供应商的使用要求后重试。",
  },
  INCOMPLETE_RESPONSE: {
    statusCode: 502,
    code: "llm_incomplete_response",
    message:
      "模型没有完成回复，生成未能完成。请重试，或检查当前模型是否支持文本及结构化输出。",
  },
  MODEL_LIST_TOO_LARGE: {
    statusCode: 502,
    code: "llm_model_list_too_large",
    message:
      "供应商返回的模型列表过大或分页未正常结束。请缩小模型范围或手动填写模型 ID。",
  },
};

const httpErrors: Readonly<Record<number, PublicLlmProviderError>> = {
  400: knownErrors.INVALID_CONFIGURATION!,
  401: {
    statusCode: 502,
    code: "llm_authentication_failed",
    message:
      "模型供应商未通过身份验证。请在模型设置中检查并重新保存 API Key 后重试。",
  },
  403: {
    statusCode: 502,
    code: "llm_access_denied",
    message:
      "当前 API Key 无权访问所选接口或模型。请检查供应商的模型权限及服务限制。",
  },
  404: {
    statusCode: 502,
    code: "llm_endpoint_not_found",
    message:
      "未找到模型接口或模型。请检查 API 地址、协议类型和模型 ID 后重试。",
  },
  405: {
    statusCode: 502,
    code: "llm_endpoint_not_supported",
    message: "当前 API 地址不支持所选接口。请检查 API 根地址和协议类型后重试。",
  },
  408: knownErrors.TIMEOUT!,
  413: {
    statusCode: 422,
    code: "llm_request_too_large",
    message:
      "本次请求超过供应商允许的大小。请精简输入，或选择支持更长上下文的模型后重试。",
  },
  422: knownErrors.INVALID_CONFIGURATION!,
  429: {
    statusCode: 429,
    code: "llm_rate_limited",
    message: "模型供应商限流或可用额度不足。请检查供应商配额，稍后重试。",
  },
};

/** Provider messages, bodies, causes, and schema issues are untrusted and may
 * contain prompts or credentials. Only these fixed messages reach HTTP clients. */
export function publicLlmProviderError(
  error: unknown,
): PublicLlmProviderError | undefined {
  if (error instanceof StructuredOutputError) {
    return knownErrors.INVALID_STRUCTURED_OUTPUT!;
  }
  if (!(error instanceof LlmProviderError)) return undefined;
  if (Object.hasOwn(knownErrors, error.code)) return knownErrors[error.code]!;
  const status =
    error.code === "HTTP_ERROR"
      ? error.status
      : /^HTTP_[1-5]\d{2}$/u.test(error.code)
        ? Number(error.code.slice(5))
        : undefined;
  if (status !== undefined && Object.hasOwn(httpErrors, status)) {
    return httpErrors[status]!;
  }
  if (status !== undefined && status >= 500 && status <= 599) {
    return {
      statusCode: 502,
      code: "llm_service_unavailable",
      message: "模型供应商服务暂时不可用。请稍后重试或更换供应商。",
    };
  }
  return {
    statusCode: 502,
    code: "llm_provider_error",
    message: "模型服务未能完成本次请求。请在模型设置中检查连接和配置后重试。",
  };
}
