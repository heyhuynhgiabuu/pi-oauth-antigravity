import type { Tool } from "@earendil-works/pi-ai";

/**
 * Local copies of pi-ai helper functions the provider needs at runtime:
 *
 * - `getJsonSchemaToolParameters` / `resolveJsonSchemaStrictSampling` / `makeStrictJsonSchema`
 *   (pi-ai/api/constrained-sampling)
 * - `requiresToolCallId` (pi-ai/api/google-shared)
 *
 * These live in pi-ai subpath exports that Pi's extension loader cannot resolve:
 * its module alias table only maps the bare `@earendil-works/pi-ai` specifier, so
 * subpath imports fail with "Cannot find module .../compat.js/api/..." unless a
 * hoisted copy of pi-ai happens to sit in node_modules. Keeping the logic local
 * follows the same pattern as `transcript.ts`: only rely on the package root at
 * runtime, so loading the provider never depends on a newer pi-ai subpath.
 *
 * Behavior mirrors pi-ai 0.99.x:
 * - `resolveJsonSchemaStrictSampling` honors the tool's `constrainedSampling`
 *   config: "prefer" resolves to strict only when the host supports it, and the
 *   strict walk validates the schema before committing.
 * - `requiresToolCallId`: Claude and GPT-OSS always require ids, Gemini only
 *   from major version 3 on.
 */

type JsonSchemaNode = Record<string, unknown> & {
  type?: unknown;
  anyOf?: unknown;
  items?: unknown;
  additionalProperties?: unknown;
  properties?: unknown;
  required?: unknown;
};

type ConstrainedSamplingConfig =
  | { type: "json_schema"; strict?: "prefer" | "require" }
  | { type: "grammar"; strict?: "prefer" | "require"; variants?: Record<string, unknown> };

type ToolWithParameters = Tool & {
  parameters?: unknown;
  constrainedSampling?: ConstrainedSamplingConfig;
};

class UnsupportedStrictJsonSchemaError extends Error {}

const UNSUPPORTED_STRICT_SCHEMA_KEYS = [
  "$ref",
  "$defs",
  "definitions",
  "allOf",
  "oneOf",
  "patternProperties",
  "dependentSchemas",
  "dependencies",
  "unevaluatedProperties",
  "propertyNames",
  "contains",
  "prefixItems",
  "not",
  "if",
  "then",
  "else",
] as const;

function isSchemaObject(value: unknown): value is JsonSchemaNode {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStructuredSchema(schema: unknown): boolean {
  if (!isSchemaObject(schema)) return false;
  const types = typeof schema.type === "string" ? [schema.type] : Array.isArray(schema.type) ? schema.type : [];
  return (
    types.includes("object") ||
    types.includes("array") ||
    schema.properties !== undefined ||
    schema.items !== undefined
  );
}

function schemaAllowsNull(schema: unknown): boolean {
  if (!isSchemaObject(schema)) return false;
  if (schema.type === "null" || (Array.isArray(schema.type) && schema.type.includes("null"))) return true;
  return Array.isArray(schema.anyOf) && schema.anyOf.some((variant) => schemaAllowsNull(variant));
}

function makeJsonSchemaNodeStrict(
  schema: JsonSchemaNode,
): void {
  for (const key of UNSUPPORTED_STRICT_SCHEMA_KEYS) {
    if (schema[key] !== undefined) {
      throw new UnsupportedStrictJsonSchemaError(`${key} schemas are unsupported`);
    }
  }
  if (schema.anyOf !== undefined) {
    if (!Array.isArray(schema.anyOf) || schema.anyOf.length === 0) {
      throw new UnsupportedStrictJsonSchemaError("anyOf must contain at least one schema");
    }
    for (const variant of schema.anyOf) {
      if (isStructuredSchema(variant)) {
        throw new UnsupportedStrictJsonSchemaError("object and array unions are unsupported");
      }
      if (isSchemaObject(variant)) makeJsonSchemaNodeStrict(variant);
    }
  }
  if (schema.items !== undefined) {
    if (Array.isArray(schema.items)) {
      for (const item of schema.items) {
        if (isSchemaObject(item)) makeJsonSchemaNodeStrict(item);
      }
    } else if (isSchemaObject(schema.items)) {
      makeJsonSchemaNodeStrict(schema.items);
    }
  }
  const isObjectSchema = schema.type === "object";
  if (schema.properties !== undefined && !isObjectSchema) {
    throw new UnsupportedStrictJsonSchemaError("properties require type object");
  }
  if (!isObjectSchema) return;
  if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) {
    throw new UnsupportedStrictJsonSchemaError("schema-valued or true additionalProperties is unsupported");
  }
  if (schema.properties !== undefined && !isSchemaObject(schema.properties)) {
    throw new UnsupportedStrictJsonSchemaError("object properties must be a schema map");
  }
  if (
    schema.required !== undefined &&
    (!Array.isArray(schema.required) || schema.required.some((key) => typeof key !== "string"))
  ) {
    throw new UnsupportedStrictJsonSchemaError("required must be a string array");
  }
  const properties = (schema.properties ?? {}) as Record<string, unknown>;
  const propertyNames = Object.keys(properties);
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  if ([...required].some((key) => !propertyNames.includes(key))) {
    throw new UnsupportedStrictJsonSchemaError("required contains an unknown property");
  }
  for (const [key, property] of Object.entries(properties)) {
    if (isSchemaObject(property)) makeJsonSchemaNodeStrict(property);
    if (!required.has(key) && !schemaAllowsNull(property)) {
      properties[key] = { anyOf: [property, { type: "null" }] };
    }
  }
  schema.required = propertyNames;
  schema.additionalProperties = false;
}

/** Local copy of pi-ai's makeStrictJsonSchema. */
export function makeStrictJsonSchema(schema: unknown): Record<string, unknown> {
  const cloned = structuredClone(schema);
  if (!isSchemaObject(cloned)) {
    throw new UnsupportedStrictJsonSchemaError("root schema must have type object");
  }
  makeJsonSchemaNodeStrict(cloned);
  if (cloned.type !== "object") {
    throw new UnsupportedStrictJsonSchemaError("root schema must have type object");
  }
  return cloned;
}

/** Local copy of pi-ai's getJsonSchemaToolParameters. */
export function getJsonSchemaToolParameters(tool: Tool, strict: boolean | undefined): unknown {
  if (strict !== true) return (tool as ToolWithParameters).parameters;
  return makeStrictJsonSchema((tool as ToolWithParameters).parameters);
}

/** Local copy of pi-ai's resolveJsonSchemaStrictSampling (json_schema branch). */
export function resolveJsonSchemaStrictSampling(
  tool: Tool,
  supportsStrictMode: boolean,
): boolean | undefined {
  const config = (tool as ToolWithParameters).constrainedSampling;
  if (!config || config.type !== "json_schema") return undefined;
  if (supportsStrictMode) {
    try {
      makeStrictJsonSchema((tool as ToolWithParameters).parameters);
      return true;
    } catch (error) {
      if (!(error instanceof UnsupportedStrictJsonSchemaError)) throw error;
      if (config.strict !== "require") return undefined;
      throw new Error(
        `Tool "${tool.name}" requires JSON-schema constrained sampling, but ${error.message}.`,
      );
    }
  }
  if (config.strict === "require") {
    throw new Error(
      `Tool "${tool.name}" requires JSON-schema constrained sampling, but strict tools are unsupported.`,
    );
  }
  return undefined;
}

/** Local copy of pi-ai's requiresToolCallId (google-shared rule). */
export function requiresToolCallId(modelId: string): boolean {
  if (modelId.startsWith("claude-") || modelId.startsWith("gpt-oss-")) return true;
  const match = modelId.toLowerCase().match(/^gemini(?:-live)?-(\d+)/);
  if (!match) return false;
  return Number.parseInt(match[1], 10) >= 3;
}
