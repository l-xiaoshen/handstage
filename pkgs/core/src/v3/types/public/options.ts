import type { z } from "zod";
import type { LogLine, LogLevel } from "./logs";
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
   * Optional external session identifier.
   * When omitted, Stagehand falls back to its internal instance id.
   */
  sessionId?: string;
  /**
   * When true, the browser process is not killed on `close()` and SIGINT
   * handling is relaxed so the process can exit while Chrome keeps running.
   */
  keepAlive?: boolean;

  localBrowserLaunchOptions?: LocalBrowserLaunchOptions;

  /**
   * Minimum log level to emit: {@link LogLevel.Error} is quietest (errors only),
   * {@link LogLevel.Info} includes informational messages,
   * {@link LogLevel.Debug} includes everything.
   * @default LogLevel.Info
   */
  verbose?: LogLevel;
  /** When omitted, `createConsoleLogger()` from `./consoleLogger` is used. */
  logger?: (line: LogLine) => void;
}
