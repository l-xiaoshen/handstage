import type { z } from "zod";
import type { LLMClient } from "../../llm/LLMClient";
import type { ModelConfiguration } from "./model";
import type { LogLine } from "./logs";
import { LocalBrowserLaunchOptionsSchema } from "./api";

export type V3Env = "LOCAL";

// Re-export for backwards compatibility (camelCase alias)
export const localBrowserLaunchOptionsSchema = LocalBrowserLaunchOptionsSchema;

export type LocalBrowserLaunchOptions = z.infer<
  typeof LocalBrowserLaunchOptionsSchema
>;

/** Constructor options for V3 */
export interface V3Options {
  /**
   * Browser environment. Only local Chrome / CDP is supported in this fork.
   * @default "LOCAL"
   */
  env?: V3Env;
  /**
   * Optional external session identifier to use for flow logging/event storage.
   * When omitted, Stagehand falls back to its internal instance id.
   */
  sessionId?: string;
  /**
   * When true, the browser process is not killed on `close()` and SIGINT
   * handling is relaxed so the process can exit while Chrome keeps running.
   */
  keepAlive?: boolean;

  // Local Chromium (optional)
  localBrowserLaunchOptions?: LocalBrowserLaunchOptions;

  model?: ModelConfiguration;
  llmClient?: LLMClient; // allow user to pass their own
  systemPrompt?: string;
  logInferenceToFile?: boolean;
  experimental?: boolean;
  verbose?: 0 | 1 | 2;
  selfHeal?: boolean;
  // V2 compatibility fields
  waitForCaptchaSolves?: boolean;
  actTimeoutMs?: number;
  /** Disable pino logging backend (useful for tests or minimal environments). */
  disablePino?: boolean;
  /** Optional external logger hook for integrating with host apps. */
  logger?: (line: LogLine) => void;
  /** Directory used to persist cached actions for act(). */
  cacheDir?: string;
  domSettleTimeout?: number;
}
