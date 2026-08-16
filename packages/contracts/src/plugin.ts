import { z } from "zod";

import type { LLMRequest, LLMResponse } from "./llm.js";

export const PLUGIN_API_VERSION = 1 as const;
export const PluginIdSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/, "Invalid plugin id");
export const ServiceIdSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-z][a-z0-9]*(?:[.:/-][a-z0-9]+)*$/, "Invalid service id");

const UniquePluginIdsSchema = z
  .array(PluginIdSchema)
  .max(50)
  .refine(
    (values) => new Set(values).size === values.length,
    "Plugin ids must be unique",
  );
const UniqueServiceIdsSchema = z
  .array(ServiceIdSchema)
  .max(100)
  .refine(
    (values) => new Set(values).size === values.length,
    "Service ids must be unique",
  );

export const PluginManifestSchema = z
  .object({
    id: PluginIdSchema,
    displayName: z.string().trim().min(1).max(120),
    description: z.string().trim().max(500).optional(),
    version: z
      .string()
      .regex(
        /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/,
      ),
    apiVersion: z.literal(PLUGIN_API_VERSION),
    requires: UniquePluginIdsSchema,
    provides: UniqueServiceIdsSchema,
  })
  .strict()
  .refine((manifest) => !manifest.requires.includes(manifest.id), {
    message: "A plugin cannot require itself",
    path: ["requires"],
  });
export type PluginManifest = z.infer<typeof PluginManifestSchema>;

export interface ClockService {
  now(): Date;
  nowUtc(): string;
}

export interface LLMService {
  generate(request: LLMRequest): Promise<LLMResponse>;
}

export interface StructuredLogger {
  debug(message: string, context?: Readonly<Record<string, unknown>>): void;
  info(message: string, context?: Readonly<Record<string, unknown>>): void;
  warn(message: string, context?: Readonly<Record<string, unknown>>): void;
  error(message: string, context?: Readonly<Record<string, unknown>>): void;
}

export const CORE_SERVICE_IDS = {
  clock: "core.clock",
  llm: "core.llm",
  logger: "core.logger",
  storage: "core.storage",
} as const;
