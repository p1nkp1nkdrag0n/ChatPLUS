import { useEffect, useState, useSyncExternalStore } from "react";
import type { LlmCatalog } from "@personasim/contracts";
import { llmApi } from "../api/llm";
import { createApiSetupController } from "../lib/apiSetup";

export function useApiSetup(initialCatalog: LlmCatalog) {
  const [controller] = useState(() =>
    createApiSetupController(initialCatalog, llmApi),
  );
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  useEffect(() => () => controller.dispose(), [controller]);
  return { ...state, ...controller };
}
