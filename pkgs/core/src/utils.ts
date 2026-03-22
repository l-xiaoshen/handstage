import { ZodSchemaValidationError } from "./v3/types/public/sdkErrors";
import { formatError, z, type ZodType } from "zod";
import type { StagehandZodSchema } from "./v3/zodSchema";

const TYPE_NAME_MAP: Record<string, string> = {
  ZodString: "string",
  string: "string",
  ZodNumber: "number",
  number: "number",
  int: "number",
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

export function validateZodSchema(schema: StagehandZodSchema, data: unknown) {
  const result = schema.safeParse(data);

  if (result.success) {
    return true;
  }
  throw new ZodSchemaValidationError(data, formatError(result.error));
}

export function isRunningInBun(): boolean {
  return (
    typeof process !== "undefined" &&
    typeof process.versions !== "undefined" &&
    "bun" in process.versions
  );
}

export function getZodType(schema: StagehandZodSchema): string {
  const rawType = schema.type;
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

export interface JsonSchemaProperty {
  type: string;
  enum?: unknown[];
  items?: JsonSchemaProperty;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  minimum?: number;
  maximum?: number;
  description?: string;
  format?: string;
}
export interface JsonSchema extends JsonSchemaProperty {
  type: string;
}

export function jsonSchemaToZod(schema: JsonSchemaProperty): ZodType {
  switch (schema.type) {
    case "object":
      if (schema.properties) {
        const shape: Record<string, ZodType> = {};
        for (const key in schema.properties) {
          const prop = schema.properties[key];
          if (prop) {
            shape[key] = jsonSchemaToZod(prop);
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

      if (schema.format === "uri" || schema.format === "url") {
        zodString = zodString.url();
      } else if (schema.format === "email") {
        zodString = zodString.email();
      } else if (schema.format === "uuid") {
        zodString = zodString.uuid();
      }

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
