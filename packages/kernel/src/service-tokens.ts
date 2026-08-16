import {
  CORE_SERVICE_IDS,
  type ClockService,
  type LLMService,
  type StructuredLogger,
} from "@personasim/contracts";

import { createServiceToken } from "./service-registry.js";

export const CLOCK_SERVICE_TOKEN = createServiceToken<ClockService>(
  CORE_SERVICE_IDS.clock,
  "Current time provider",
);
export const LLM_SERVICE_TOKEN = createServiceToken<LLMService>(
  CORE_SERVICE_IDS.llm,
  "Validated language-model provider",
);
export const LOGGER_SERVICE_TOKEN = createServiceToken<StructuredLogger>(
  CORE_SERVICE_IDS.logger,
  "Structured application logger",
);
