import { buildApp } from "./app.js";
import { readConfig } from "./config.js";

const config = readConfig();
const app = await buildApp({ config, startScheduler: true });

app.log.info(
  {
    profile: config.profile,
    llmProvider: app.personasim.llm.providerName,
    llmProfile: app.personasim.llm.profileName,
    reasoningEffort: app.personasim.llm.reasoningEffort ?? "not-configured",
    reasoningRequestFormat:
      app.personasim.llm.reasoningRequestFormat ?? "not-configured",
    liveWorldEffects: config.liveWorldEffectsMode,
    selfInitiatedPlanning: config.selfInitiatedPlanningMode,
  },
  "PersonaSim core-loop modes",
);

const close = async (signal: string) => {
  app.log.info({ signal }, "shutting down");
  await app.close();
  process.exit(0);
};

process.once("SIGINT", () => void close("SIGINT"));
process.once("SIGTERM", () => void close("SIGTERM"));

try {
  await app.listen({ port: config.port, host: config.host });
} catch (error) {
  app.log.error(error);
  await app.close();
  process.exit(1);
}
