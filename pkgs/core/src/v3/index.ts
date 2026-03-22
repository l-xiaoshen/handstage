import {
	getZodType,
	isRunningInBun,
	jsonSchemaToZod,
	trimTrailingTextNode,
	validateZodSchema,
} from "../utils"
import { maybeRunShutdownSupervisorFromArgv } from "./shutdown/supervisor"
import * as PublicApi from "./types/public/index"
import { V3 } from "./v3"
import { toJsonSchema } from "./zodSchema"

export type { JsonSchema, JsonSchemaProperty } from "../utils"
export {
	getZodType,
	isRunningInBun,
	jsonSchemaToZod,
	trimTrailingTextNode,
	validateZodSchema,
} from "../utils"
export { maybeRunShutdownSupervisorFromArgv as __internalMaybeRunShutdownSupervisorFromArgv } from "./shutdown/supervisor"
export * from "./types/public/index"
export { V3, V3 as Stagehand } from "./v3"

export type {
	InferStagehandSchema,
	JsonSchemaDocument,
	StagehandZodObject,
	StagehandZodSchema,
} from "./zodSchema"
export { toJsonSchema } from "./zodSchema"

const StagehandDefault = {
	...PublicApi,
	V3,
	Stagehand: V3,
	validateZodSchema,
	isRunningInBun,
	getZodType,
	trimTrailingTextNode,
	jsonSchemaToZod,
	toJsonSchema,
	__internalMaybeRunShutdownSupervisorFromArgv:
		maybeRunShutdownSupervisorFromArgv,
}

export default StagehandDefault
