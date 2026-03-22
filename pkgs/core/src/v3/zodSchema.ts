import type { infer as ZodInfer, ZodObject, ZodRawShape, ZodType } from "zod"
import { toJSONSchema } from "zod"
import type { ZodStandardJSONSchemaPayload } from "zod/v4/core"

export type StagehandZodSchema = ZodType
export type StagehandZodObject = ZodObject<ZodRawShape>
export type InferStagehandSchema<T extends StagehandZodSchema> = ZodInfer<T>

export type JsonSchemaDocument = ZodStandardJSONSchemaPayload<ZodType>

export function toJsonSchema<T extends StagehandZodSchema>(
	schema: T,
): ZodStandardJSONSchemaPayload<T> {
	return toJSONSchema(schema)
}
