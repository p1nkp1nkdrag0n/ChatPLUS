import { z, type ZodType } from "zod";
import type { LlmProtocol } from "@personasim/contracts";
import { LlmProviderError } from "./openai-compatible-llm.js";

type Schema = Record<string, unknown>;

function object(value: unknown): Schema | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Schema)
    : undefined;
}

/** Provider grammars are a subset of JSON Schema; the original Zod schema remains authoritative. */
export function prepareManagedSchema(
  schema: ZodType,
  protocol: LlmProtocol,
): {
  jsonSchema: Schema;
  normalize: (value: unknown) => unknown;
} {
  let source: Schema;
  try {
    source = z.toJSONSchema(schema);
  } catch {
    throw new LlmProviderError(
      "The response schema cannot be converted to JSON Schema",
      "UNSUPPORTED_RESPONSE_SCHEMA",
    );
  }
  function compile(input: Schema): Schema {
    const output: Schema = { ...input };
    delete output["$schema"];
    const unsupported =
      protocol === "anthropic"
        ? [
            "minimum",
            "maximum",
            "exclusiveMinimum",
            "exclusiveMaximum",
            "multipleOf",
            "minLength",
            "maxLength",
            "maxItems",
            "pattern",
          ]
        : protocol === "gemini"
          ? ["minLength", "maxLength", "pattern"]
          : [];
    if (
      protocol === "anthropic" &&
      typeof output["minItems"] === "number" &&
      output["minItems"] > 1
    )
      unsupported.push("minItems");
    const constraints = unsupported
      .filter((key) => output[key] !== undefined)
      .map((key) => `${key}=${JSON.stringify(output[key])}`);
    for (const key of unsupported) delete output[key];
    if (constraints.length)
      output["description"] = [
        input["description"],
        `Validation constraints: ${constraints.join(", ")}`,
      ]
        .filter(Boolean)
        .join(". ");
    for (const key of ["$defs", "definitions"]) {
      const entries = object(input[key]);
      if (entries)
        output[key] = Object.fromEntries(
          Object.entries(entries).map(([name, child]) => [
            name,
            object(child) ? compile(child as Schema) : child,
          ]),
        );
    }
    for (const key of ["anyOf", "allOf", "oneOf"]) {
      if (Array.isArray(input[key]))
        output[key] = input[key].map((child: unknown) =>
          object(child) ? compile(child as Schema) : child,
        );
    }
    if (object(input["items"]))
      output["items"] = compile(input["items"] as Schema);
    const properties = object(input["properties"]);
    if (properties) {
      const required = Array.isArray(input["required"])
        ? (input["required"] as unknown[])
        : [];
      output["properties"] = Object.fromEntries(
        Object.entries(properties).map(([name, child]) => {
          const compiled = object(child) ? compile(child as Schema) : child;
          return [
            name,
            protocol === "openai-compatible" && !required.includes(name)
              ? { anyOf: [compiled, { type: "null" }] }
              : compiled,
          ];
        }),
      );
      if (protocol === "openai-compatible")
        output["required"] = Object.keys(properties);
    }
    if (input["type"] === "object" || properties) {
      if (
        object(input["additionalProperties"]) ||
        input["additionalProperties"] === true
      ) {
        throw new LlmProviderError(
          "Native structured output cannot represent this open-ended object schema; choose prompt JSON explicitly",
          "UNSUPPORTED_RESPONSE_SCHEMA",
        );
      }
      output["additionalProperties"] = false;
    }
    return output;
  }
  function resolve(input: Schema): Schema {
    const ref = input["$ref"];
    if (typeof ref !== "string" || !ref.startsWith("#/")) return input;
    let target: unknown = source;
    for (const segment of ref.slice(2).split("/"))
      target =
        object(target)?.[segment.replaceAll("~1", "/").replaceAll("~0", "~")];
    return object(target) ?? input;
  }
  function allowsNull(input: Schema): boolean {
    const shape = resolve(input);
    if (
      shape["type"] === "null" ||
      (Array.isArray(shape["type"]) && shape["type"].includes("null"))
    )
      return true;
    if (Array.isArray(shape["enum"]) && shape["enum"].includes(null))
      return true;
    return ["anyOf", "oneOf"].some(
      (key) =>
        Array.isArray(shape[key]) &&
        shape[key].some((branch: unknown) => {
          const member = object(branch);
          return (
            member !== undefined &&
            (member["type"] === "null" || member["const"] === null)
          );
        }),
    );
  }
  function matchesBranch(value: Schema, branch: Schema): boolean {
    const properties = object(resolve(branch)["properties"]);
    return (
      properties !== undefined &&
      Object.entries(properties).every(([key, child]) => {
        const property = object(child);
        if (!property || value[key] === undefined) return true;
        if ("const" in property) return value[key] === property["const"];
        if (Array.isArray(property["enum"]))
          return property["enum"].includes(value[key]);
        return true;
      })
    );
  }
  function normalize(value: unknown, shape: Schema): unknown {
    const resolved = resolve(shape);
    if (Array.isArray(value) && object(resolved["items"]))
      return value.map((item) => normalize(item, resolved["items"] as Schema));
    const properties = object(resolved["properties"]);
    const record = object(value);
    if (record && properties) {
      const required = Array.isArray(resolved["required"])
        ? (resolved["required"] as unknown[])
        : [];
      return Object.fromEntries(
        Object.entries(record).flatMap(([key, item]) => {
          const child = object(properties[key]);
          if (
            child &&
            item === null &&
            !required.includes(key) &&
            !allowsNull(child)
          )
            return [];
          return [[key, child ? normalize(item, child) : item]];
        }),
      );
    }
    for (const key of ["anyOf", "oneOf", "allOf"]) {
      const branches = resolved[key];
      if (Array.isArray(branches)) {
        for (const branch of branches) {
          const candidate = object(branch);
          if (
            candidate &&
            ((record && matchesBranch(record, candidate)) ||
              (Array.isArray(value) && object(resolve(candidate)["items"])))
          )
            return normalize(value, candidate);
        }
      }
    }
    return value;
  }
  return {
    jsonSchema: compile(source),
    normalize: (value) =>
      protocol === "openai-compatible" ? normalize(value, source) : value,
  };
}
