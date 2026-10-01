import type { Tool } from "@earendil-works/pi-ai";

/**
 * Provider-local copies of the pi-ai 0.86 helpers used at runtime. Pi's extension
 * loader aliases only selected pi-ai specifiers, so deep api/* imports do not work
 * consistently across packaged and bundled extension runtimes.
 */

type JsonSchemaObject = Record<string, unknown> & {
  type?: unknown;
  anyOf?: unknown;
  items?: unknown;
  additionalProperties?: unknown;
  properties?: unknown;
  required?: unknown;
  const?: unknown;
  enum?: unknown;
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

function isJsonSchemaObject(value: unknown): value is JsonSchemaObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStructuredSchema(schema: unknown): boolean {
  if (!isJsonSchemaObject(schema)) return false;
  const types =
    typeof schema.type === "string" ? [schema.type] : Array.isArray(schema.type) ? schema.type : [];
  return (
    types.includes("object") ||
    types.includes("array") ||
    schema.properties !== undefined ||
    schema.items !== undefined
  );
}

function schemaAllowsNull(schema: unknown): boolean {
  if (!isJsonSchemaObject(schema)) return false;
  if (schema.type === "null" || (Array.isArray(schema.type) && schema.type.includes("null"))) {
    return true;
  }
  if (schema.const === null || (Array.isArray(schema.enum) && schema.enum.includes(null))) {
    return true;
  }
  return Array.isArray(schema.anyOf) && schema.anyOf.some((variant) => schemaAllowsNull(variant));
}

function makeJsonSchemaNodeStrict(schema: unknown): void {
  if (!isJsonSchemaObject(schema)) {
    throw new UnsupportedStrictJsonSchemaError("boolean schemas are unsupported");
  }
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
      makeJsonSchemaNodeStrict(variant);
    }
  }
  if (schema.items !== undefined) {
    if (Array.isArray(schema.items)) {
      throw new UnsupportedStrictJsonSchemaError("tuple schemas are unsupported");
    }
    makeJsonSchemaNodeStrict(schema.items);
  }
  const isObjectSchema = schema.type === "object";
  if (schema.properties !== undefined && !isObjectSchema) {
    throw new UnsupportedStrictJsonSchemaError("properties require type object");
  }
  if (!isObjectSchema) return;
  if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) {
    throw new UnsupportedStrictJsonSchemaError("schema-valued or true additionalProperties is unsupported");
  }
  if (schema.properties !== undefined && !isJsonSchemaObject(schema.properties)) {
    throw new UnsupportedStrictJsonSchemaError("object properties must be a schema map");
  }
  if (
    schema.required !== undefined &&
    (!Array.isArray(schema.required) || schema.required.some((key) => typeof key !== "string"))
  ) {
    throw new UnsupportedStrictJsonSchemaError("object required must be a string array");
  }
  const properties = (schema.properties ?? {}) as Record<string, unknown>;
  const propertyNames = Object.keys(properties);
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  if ([...required].some((key) => !propertyNames.includes(key))) {
    throw new UnsupportedStrictJsonSchemaError("required contains an unknown property");
  }
  for (const [key, property] of Object.entries(properties)) {
    makeJsonSchemaNodeStrict(property);
    if (!required.has(key) && !schemaAllowsNull(property)) {
      properties[key] = { anyOf: [property, { type: "null" }] };
    }
  }
  schema.required = propertyNames;
  schema.additionalProperties = false;
}

/** Convert a tool schema to the strict subset expected by pi-ai 0.86.0. */
function makeStrictJsonSchema(schema: unknown): Record<string, unknown> {
  const cloned: unknown = structuredClone(schema);
  if (!isJsonSchemaObject(cloned)) {
    throw new UnsupportedStrictJsonSchemaError("root schema must have type object");
  }
  makeJsonSchemaNodeStrict(cloned);
  if (cloned.type !== "object") {
    throw new UnsupportedStrictJsonSchemaError("root schema must have type object");
  }
  return cloned;
}

export function getJsonSchemaToolParameters(tool: Tool, strict: boolean | undefined): unknown {
  const parameters = (tool as ToolWithParameters).parameters;
  if (strict !== true) return parameters;
  return makeStrictJsonSchema(parameters);
}

export function resolveJsonSchemaStrictSampling(
  tool: Tool,
  supportsStrictMode: boolean,
): boolean | undefined {
  const samplingTool = tool as ToolWithParameters;
  const config = samplingTool.constrainedSampling;
  if (!config || config.type !== "json_schema") return undefined;
  if (supportsStrictMode) {
    try {
      makeStrictJsonSchema(samplingTool.parameters);
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

export function requiresToolCallId(modelId: string): boolean {
  if (modelId.startsWith("claude-") || modelId.startsWith("gpt-oss-")) return true;
  const match = modelId.toLowerCase().match(/^gemini(?:-live)?-(\d+)/);
  if (!match) return false;
  return Number.parseInt(match[1], 10) >= 3;
}
