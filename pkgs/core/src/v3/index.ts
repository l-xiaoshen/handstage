import * as PublicApi from "./types/public/index";
import { V3 } from "./v3";
import {
  validateZodSchema,
  isRunningInBun,
  getZodType,
  trimTrailingTextNode,
  jsonSchemaToZod,
} from "../utils";
import { toJsonSchema } from "./zodSchema";
import { maybeRunShutdownSupervisorFromArgv } from "./shutdown/supervisor";

export { V3 } from "./v3";
export { V3 as Stagehand } from "./v3";

export * from "./types/public/index";
export {
  validateZodSchema,
  isRunningInBun,
  getZodType,
  trimTrailingTextNode,
  jsonSchemaToZod,
} from "../utils";
export { toJsonSchema } from "./zodSchema";

export { maybeRunShutdownSupervisorFromArgv as __internalMaybeRunShutdownSupervisorFromArgv } from "./shutdown/supervisor";

export type {
  StagehandZodSchema,
  StagehandZodObject,
  InferStagehandSchema,
  JsonSchemaDocument,
} from "./zodSchema";

export type { JsonSchema, JsonSchemaProperty } from "../utils";

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
  __internalMaybeRunShutdownSupervisorFromArgv: maybeRunShutdownSupervisorFromArgv,
};

export default StagehandDefault;
