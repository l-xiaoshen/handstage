import type { z } from "zod"
import type { LocalBrowserLaunchOptionsSchema } from "./api"
import type { LogLevel, LogLine } from "./logs"

export type LocalBrowserLaunchOptions = z.infer<
	typeof LocalBrowserLaunchOptionsSchema
>

/** Shared constructor options for all Handstage connection modes. */
export interface HandstageSharedOptions {
	/**
	 * Minimum log level to emit: {@link LogLevel.Error} is quietest (errors only),
	 * {@link LogLevel.Info} includes informational messages,
	 * {@link LogLevel.Debug} includes everything.
	 * @default LogLevel.Info
	 */
	verbose?: LogLevel
	/** When omitted, `createConsoleLogger()` from `./consoleLogger` is used. */
	logger?: (line: LogLine) => void
}

export interface HandstageConnectOptions extends HandstageSharedOptions {
	viewport?: { width: number; height: number }
	deviceScaleFactor?: number
	downloadsPath?: string
	acceptDownloads?: boolean
}

export interface HandstageLocalOptions extends HandstageSharedOptions {
	localBrowserLaunchOptions?: LocalBrowserLaunchOptions
}
