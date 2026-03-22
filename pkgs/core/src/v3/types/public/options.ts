import type { z } from "zod";
import type { LogLine } from "./logs";
import { LocalBrowserLaunchOptionsSchema } from "./api";

export type V3Env = "LOCAL";

export const localBrowserLaunchOptionsSchema = LocalBrowserLaunchOptionsSchema;

export type LocalBrowserLaunchOptions = z.infer<
  typeof LocalBrowserLaunchOptionsSchema
>;

/** Constructor options for V3 (browser / CDP only). */
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

  localBrowserLaunchOptions?: LocalBrowserLaunchOptions;

  verbose?: 0 | 1 | 2;
  /** Disable pino logging backend (useful for tests or minimal environments). */
  disablePino?: boolean;
  /** Optional external logger hook for integrating with host apps. */
  logger?: (line: LogLine) => void;
}
