import * as PublicApi from "./types/public/index";
import { V3 } from "./v3";
import { AnnotatedScreenshotText, LLMClient } from "./llm/LLMClient";
import {
  AgentProvider,
  modelToAgentProviderMap,
} from "./agent/AgentProvider";
import {
  validateZodSchema,
  isRunningInBun,
  toGeminiSchema,
  getZodType,
  transformSchema,
  injectUrls,
  providerEnvVarMap,
  loadApiKeyFromEnv,
  trimTrailingTextNode,
  jsonSchemaToZod,
} from "../utils";
import { isZod4Schema, isZod3Schema, toJsonSchema } from "./zodCompat";
import { connectToMCPServer } from "./mcp/connection";
import { V3Evaluator } from "../v3Evaluator";
import { tool } from "ai";
import { getAISDKLanguageModel } from "./llm/LLMProvider";
import { __internalCreateInMemoryAgentCacheHandle } from "./cache/serverAgentCache";
import { maybeRunShutdownSupervisorFromArgv } from "./shutdown/supervisor";

export { V3 } from "./v3";
export { V3 as Stagehand } from "./v3";

export * from "./types/public/index";
export { AnnotatedScreenshotText, LLMClient } from "./llm/LLMClient";

export {
  AgentProvider,
  modelToAgentProviderMap,
} from "./agent/AgentProvider";
export type {
  AgentTools,
  AgentToolTypesMap,
  AgentUITools,
  AgentToolCall,
  AgentToolResult,
} from "./agent/tools/index";

export {
  validateZodSchema,
  isRunningInBun,
  toGeminiSchema,
  getZodType,
  transformSchema,
  injectUrls,
  providerEnvVarMap,
  loadApiKeyFromEnv,
  trimTrailingTextNode,
  jsonSchemaToZod,
} from "../utils";
export { isZod4Schema, isZod3Schema, toJsonSchema } from "./zodCompat";

export { connectToMCPServer } from "./mcp/connection";
export { V3Evaluator } from "../v3Evaluator";
export { tool } from "ai";
export { getAISDKLanguageModel } from "./llm/LLMProvider";
export { __internalCreateInMemoryAgentCacheHandle } from "./cache/serverAgentCache";
export { maybeRunShutdownSupervisorFromArgv as __internalMaybeRunShutdownSupervisorFromArgv } from "./shutdown/supervisor";
export type { ServerAgentCacheHandle } from "./cache/serverAgentCache";

export type {
  ChatMessage,
  ChatMessageContent,
  ChatMessageImageContent,
  ChatMessageTextContent,
  ChatCompletionOptions,
  LLMResponse,
  CreateChatCompletionOptions,
  LLMUsage,
  LLMParsedResponse,
} from "./llm/LLMClient";

export type {
  StagehandZodSchema,
  StagehandZodObject,
  InferStagehandSchema,
  JsonSchemaDocument,
} from "./zodCompat";

export type { JsonSchema, JsonSchemaProperty } from "../utils";

const StagehandDefault = {
  ...PublicApi,
  V3,
  Stagehand: V3,
  AnnotatedScreenshotText,
  LLMClient,
  AgentProvider,
  modelToAgentProviderMap,
  validateZodSchema,
  isRunningInBun,
  toGeminiSchema,
  getZodType,
  transformSchema,
  injectUrls,
  providerEnvVarMap,
  loadApiKeyFromEnv,
  trimTrailingTextNode,
  jsonSchemaToZod,
  isZod4Schema,
  isZod3Schema,
  toJsonSchema,
  connectToMCPServer,
  V3Evaluator,
  tool,
  getAISDKLanguageModel,
  __internalCreateInMemoryAgentCacheHandle,
  __internalMaybeRunShutdownSupervisorFromArgv:
    maybeRunShutdownSupervisorFromArgv,
};

export default StagehandDefault;
