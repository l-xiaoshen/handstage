import type { z } from "zod"
import { LocalBrowserLaunchOptionsSchema } from "./api"
import type { LogLevel, LogLine } from "./logs"

export const localBrowserLaunchOptionsSchema = LocalBrowserLaunchOptionsSchema

export type LocalBrowserLaunchOptions = z.infer<
	typeof LocalBrowserLaunchOptionsSchema
>

/** Shared constructor options for all Handstages connection modes. */
export interface HandstagesSharedOptions {
	/**
	 * Optional external session identifier.
	 * When omitted, Handstages falls back to its internal instance id.
	 */
	sessionId?: string
	/**
	 * When true, the browser process is not killed on `close()` and SIGINT
	 * handling is relaxed so the process can exit while Chrome keeps running.
	 */
	keepAlive?: boolean

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

export interface HandstagesConnectOptions extends HandstagesSharedOptions {
	viewport?: { width: number; height: number }
	deviceScaleFactor?: number
	downloadsPath?: string
	acceptDownloads?: boolean
}

export interface HandstagesLocalOptions extends HandstagesSharedOptions {
	localBrowserLaunchOptions?: LocalBrowserLaunchOptions
}
