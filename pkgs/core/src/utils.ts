import { ZodSchemaValidationError } from "./v3/types/public/sdkErrors";
import { z, type ZodTypeAny } from "zod";
import type { StagehandZodSchema } from "./v3/zodCompat";

const TYPE_NAME_MAP: Record<string, string> = {
  ZodString: "string",
  string: "string",
  ZodNumber: "number",
  number: "number",
  ZodBoolean: "boolean",
  boolean: "boolean",
  ZodObject: "object",
  object: "object",
  ZodArray: "array",
  array: "array",
  ZodUnion: "union",
  union: "union",
  ZodIntersection: "intersection",
  intersection: "intersection",
  ZodOptional: "optional",
  optional: "optional",
  ZodNullable: "nullable",
  nullable: "nullable",
  ZodLiteral: "literal",
  literal: "literal",
  ZodEnum: "enum",
  enum: "enum",
  ZodDefault: "default",
  default: "default",
  ZodEffects: "effects",
  effects: "effects",
  pipe: "pipe",
};

type SchemaInternals = {
  _zod?: { def?: Record<string, unknown>; bag?: Record<string, unknown> };
  _def?: Record<string, unknown>;
};

export function validateZodSchema(schema: StagehandZodSchema, data: unknown) {
  const result = schema.safeParse(data);

  if (result.success) {
    return true;
  }
  throw new ZodSchemaValidationError(data, result.error.format());
}

/**
 * Detects if the code is running in the Bun runtime environment.
 * @returns {boolean} True if running in Bun, false otherwise.
 */
export function isRunningInBun(): boolean {
  return (
    typeof process !== "undefined" &&
    typeof process.versions !== "undefined" &&
    "bun" in process.versions
  );
}

// Helper function to check the type of Zod schema
export function getZodType(schema: StagehandZodSchema): string {
  const schemaWithDef = schema as SchemaInternals & {
    _zod?: { def?: { type?: string } };
  };
  const rawType =
    (schemaWithDef._zod?.def?.type as string | undefined) ??
    (schemaWithDef._def?.typeName as string | undefined) ??
    (schemaWithDef._def?.type as string | undefined);

  if (!rawType) {
    return "unknown";
  }

  return TYPE_NAME_MAP[rawType] ?? rawType;
}

export function trimTrailingTextNode(
  path: string | undefined,
): string | undefined {
  return path?.replace(/\/text\(\)(\[\d+\])?$/iu, "");
}

export function toTitleCase(str: string): string {
  return str.replace(
    /\w\S*/g,
    (text) => text.charAt(0).toUpperCase() + text.substring(1),
  );
}

// TODO: move to separate types file
export interface JsonSchemaProperty {
  type: string;
  enum?: unknown[];
  items?: JsonSchemaProperty;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  minimum?: number;
  maximum?: number;
  description?: string;
  format?: string; // JSON Schema format field (e.g., "uri", "url", "email", etc.)
}
export interface JsonSchema extends JsonSchemaProperty {
  type: string;
}

/**
 * Converts a JSON Schema object to a Zod schema
 * @param schema The JSON Schema object to convert
 * @returns A Zod schema equivalent to the input JSON Schema
 */
export function jsonSchemaToZod(schema: JsonSchema): ZodTypeAny {
  switch (schema.type) {
    case "object":
      if (schema.properties) {
        const shape: Record<string, ZodTypeAny> = {};
        for (const key in schema.properties) {
          const prop = schema.properties[key];
          if (prop) {
            shape[key] = jsonSchemaToZod(prop as JsonSchema);
          }
        }
        let zodObject = z.object(shape);
        if (schema.required && Array.isArray(schema.required)) {
          const requiredFields = schema.required.reduce<Record<string, true>>(
            (acc, field) => ({ ...acc, [field]: true }),
            {},
          );
          zodObject = zodObject.partial().required(requiredFields);
        }
        if (schema.description) {
          zodObject = zodObject.describe(schema.description);
        }
        return zodObject;
      } else {
        return z.object({});
      }
    case "array":
      if (schema.items) {
        let zodArray = z.array(jsonSchemaToZod(schema.items));
        if (schema.description) {
          zodArray = zodArray.describe(schema.description);
        }
        return zodArray;
      } else {
        return z.array(z.any());
      }
    case "string": {
      if (schema.enum) {
        return z.string().refine((val) => schema.enum!.includes(val));
      }
      let zodString = z.string();

      // Handle JSON Schema format field
      if (schema.format === "uri" || schema.format === "url") {
        zodString = zodString.url();
      } else if (schema.format === "email") {
        zodString = zodString.email();
      } else if (schema.format === "uuid") {
        zodString = zodString.uuid();
      }
      // Add more format handlers as needed

      if (schema.description) {
        zodString = zodString.describe(schema.description);
      }
      return zodString;
    }
    case "number": {
      let zodNumber = z.number();
      if (schema.minimum !== undefined) {
        zodNumber = zodNumber.min(schema.minimum);
      }
      if (schema.maximum !== undefined) {
        zodNumber = zodNumber.max(schema.maximum);
      }
      if (schema.description) {
        zodNumber = zodNumber.describe(schema.description);
      }
      return zodNumber;
    }
    case "boolean": {
      let zodBoolean = z.boolean();
      if (schema.description) {
        zodBoolean = zodBoolean.describe(schema.description);
      }
      return zodBoolean;
    }
    default:
      return z.any();
  }
}
